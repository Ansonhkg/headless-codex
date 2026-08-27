import type { ProcessState } from "../contracts";

type ManagedProcessOptions = {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  enabled?: boolean;
};

export class ManagedProcess {
  readonly name: string;
  readonly command: string[];
  readonly enabled: boolean;
  #cwd?: string;
  #env?: Record<string, string | undefined>;
  #child?: Bun.Subprocess;
  #state: ProcessState["state"];
  #error?: string;
  #logs: string[] = [];

  constructor(options: ManagedProcessOptions) {
    this.name = options.name;
    this.command = options.command;
    this.enabled = options.enabled ?? true;
    this.#cwd = options.cwd;
    this.#env = options.env;
    this.#state = this.enabled ? "stopped" : "disabled";
  }

  async start(): Promise<void> {
    if (!this.enabled || this.#state === "running" || this.#state === "starting") return;
    this.#state = "starting";
    this.#error = undefined;
    try {
      const child = Bun.spawn(this.command, {
        cwd: this.#cwd,
        detached: true,
        env: { ...process.env, ...this.#env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.#child = child;
      this.#state = "running";
      this.#drain(child.stdout, "stdout");
      this.#drain(child.stderr, "stderr");
      void child.exited.then((exitCode) => {
        if (this.#child !== child) return;
        if (this.#state !== "stopped") {
          this.#state = exitCode === 0 ? "stopped" : "failed";
          if (exitCode !== 0) this.#error = `${this.name} exited with code ${exitCode}`;
        }
      });
    } catch (error) {
      this.#state = "failed";
      this.#error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      if (this.enabled) this.#state = "stopped";
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const completed = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!completed && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    this.#state = "stopped";
  }

  status(): ProcessState {
    return {
      name: this.name,
      state: this.#state,
      pid: this.#child?.pid,
      command: this.command,
      error: this.#error,
    };
  }

  logs(): string[] {
    return [...this.#logs];
  }

  #drain(stream: ReadableStream<Uint8Array> | number | null | undefined, channel: string): void {
    if (!stream || typeof stream === "number") return;
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n").filter(Boolean)) {
          this.#logs.push(`[${channel}] ${line}`);
          if (this.#logs.length > 500) this.#logs.shift();
        }
      }
    })();
  }
}
