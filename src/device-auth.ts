import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { HostConfig } from "./config";

const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
const DEVICE_LOGIN_START_TIMEOUT_MS = 10_000;

export type CodexAuthenticationStatus = {
  readonly state: "authenticated" | "sign_in_required" | "unavailable";
  readonly refresh: "available" | "unavailable" | "unknown";
  readonly checkedAt: string;
  readonly detail: string;
};

export type CodexDeviceLoginStatus = {
  readonly state: "idle" | "pending" | "completed" | "failed" | "expired";
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly expiresAt?: string;
  readonly detail: string;
};

export interface CodexDeviceAuth {
  authentication(): Promise<CodexAuthenticationStatus>;
  start(): Promise<CodexDeviceLoginStatus>;
  status(): CodexDeviceLoginStatus;
  stop(): Promise<void>;
}

type PendingDeviceLogin = {
  readonly child: Bun.Subprocess;
  readonly expiresAt: string;
  readonly timeout: ReturnType<typeof setTimeout>;
};

type CodexDeviceAuthOptions = {
  readonly onAuthenticated?: () => Promise<void>;
};

function authHome(config: HostConfig): string {
  return process.env.CODEX_HOME?.trim() || join(config.dataDir, "codex-home");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function deviceLoginDetails(output: string): { readonly userCode: string; readonly verificationUri: string } | undefined {
  const plain = stripAnsi(output);
  const verificationUri = plain.match(/https:\/\/auth\.openai\.com\/codex\/device/)?.[0];
  const code = plain.match(/Enter this one-time code[\s\S]{0,200}?\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/)?.[1];
  return verificationUri && code ? { userCode: code, verificationUri } : undefined;
}

function authenticationStatus(home: string): CodexAuthenticationStatus {
  const checkedAt = new Date().toISOString();
  const file = join(home, "auth.json");
  try {
    if (!existsSync(file)) {
      return {
        state: "sign_in_required",
        refresh: "unavailable",
        checkedAt,
        detail: "Codex is not signed in on this Worker Node.",
      };
    }
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const tokens = root.tokens && typeof root.tokens === "object"
      ? root.tokens as Record<string, unknown>
      : root;
    const accessToken = typeof tokens.access_token === "string" && tokens.access_token.trim().length > 0;
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token.trim().length > 0;
    return {
      state: accessToken ? "authenticated" : "sign_in_required",
      refresh: refreshToken ? "available" : "unavailable",
      checkedAt,
      detail: accessToken
        ? "Codex is signed in on this Worker Node."
        : "Codex needs a device sign-in on this Worker Node.",
    };
  } catch {
    return {
      state: "unavailable",
      refresh: "unknown",
      checkedAt,
      detail: "Codex authentication status could not be inspected on this Worker Node.",
    };
  }
}

/**
 * Runs the Codex CLI's supported device authorization command on this worker.
 * The CLI writes its credential directly into CODEX_HOME; API clients only see
 * the short-lived user code and never receive OAuth tokens.
 */
export class CodexDeviceAuthService implements CodexDeviceAuth {
  readonly #config: HostConfig;
  readonly #home: string;
  readonly #onAuthenticated?: () => Promise<void>;
  #current: CodexDeviceLoginStatus = {
    state: "idle",
    detail: "No device sign-in is in progress.",
  };
  #pending?: PendingDeviceLogin;

  constructor(config: HostConfig, options: CodexDeviceAuthOptions = {}) {
    this.#config = config;
    this.#home = authHome(config);
    this.#onAuthenticated = options.onAuthenticated;
  }

  async authentication(): Promise<CodexAuthenticationStatus> {
    return authenticationStatus(this.#home);
  }

  status(): CodexDeviceLoginStatus {
    return this.#current;
  }

  async start(): Promise<CodexDeviceLoginStatus> {
    if (this.#current.state === "pending") return this.#current;
    mkdirSync(this.#home, { recursive: true, mode: 0o700 });
    const child = Bun.spawn([this.#config.codexBinary, "login", "--device-auth"], {
      env: { ...process.env, CODEX_HOME: this.#home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const expiresAt = new Date(Date.now() + DEVICE_LOGIN_TIMEOUT_MS).toISOString();
    const timeout = setTimeout(() => {
      if (this.#current.state !== "pending") return;
      this.#current = {
        state: "expired",
        expiresAt,
        detail: "The OpenAI device code expired. Start a new sign-in to try again.",
      };
      child.kill("SIGTERM");
    }, DEVICE_LOGIN_TIMEOUT_MS);
    timeout.unref();
    this.#pending = { child, expiresAt, timeout };
    this.#current = {
      state: "pending",
      expiresAt,
      detail: "Preparing the OpenAI device sign-in.",
    };

    let output = "";
    let settled = false;
    let resolveDetails!: (status: CodexDeviceLoginStatus) => void;
    let rejectDetails!: (error: Error) => void;
    const details = new Promise<CodexDeviceLoginStatus>((resolve, reject) => {
      resolveDetails = resolve;
      rejectDetails = reject;
    });
    const fail = (detail: string) => {
      if (settled) return;
      settled = true;
      this.#current = { state: "failed", detail };
      rejectDetails(new Error(detail));
    };
    const startTimeout = setTimeout(() => {
      if (this.#current.state !== "pending") return;
      child.kill("SIGTERM");
      fail("Codex did not provide a device code. Check that the Codex CLI is available on the Worker Node.");
    }, DEVICE_LOGIN_START_TIMEOUT_MS);
    startTimeout.unref();
    const readOutput = async (stream: ReadableStream<Uint8Array> | number | null) => {
      if (!stream || typeof stream === "number") return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        output += decoder.decode(value, { stream: true });
        const parsed = deviceLoginDetails(output);
        if (!parsed || this.#current.state !== "pending") continue;
        clearTimeout(startTimeout);
        this.#current = {
          state: "pending",
          ...parsed,
          expiresAt,
          detail: "Open the OpenAI link and enter this code to sign in to this Worker Node.",
        };
        if (!settled) {
          settled = true;
          resolveDetails(this.#current);
        }
        return;
      }
    };
    void Promise.all([readOutput(child.stdout), readOutput(child.stderr)]).catch((error) => {
      clearTimeout(startTimeout);
      fail(error instanceof Error ? error.message : String(error));
    });

    void child.exited.then(async (exitCode) => {
      const pending = this.#pending;
      if (!pending || pending.child !== child) return;
      clearTimeout(pending.timeout);
      this.#pending = undefined;
      clearTimeout(startTimeout);
      if (this.#current.state !== "pending") return;
      if (!settled) {
        fail("Codex device sign-in stopped before it provided a device code.");
        return;
      }
      if (exitCode !== 0) {
        this.#current = {
            state: "failed",
            detail: "Codex device sign-in stopped before it was completed.",
        };
        return;
      }
      this.#current = {
        state: "pending",
        detail: "Codex is signed in. Restarting Codex Desktop to load the new credential.",
      };
      try {
        await this.#onAuthenticated?.();
        this.#current = {
          state: "completed",
          detail: this.#onAuthenticated
            ? "Codex is signed in and Codex Desktop has restarted with the new credential."
            : "Codex is signed in on this Worker Node.",
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.#current = {
          state: "completed",
          detail: `Codex is signed in, but Codex Desktop could not restart automatically: ${detail}`,
        };
      }
    });
    return details;
  }

  async stop(): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending = undefined;
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
    this.#current = {
      state: "idle",
      detail: "No device sign-in is in progress.",
    };
  }
}
