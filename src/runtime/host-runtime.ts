import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism, freemem, hostname, release, totalmem, uptime } from "node:os";
import type { HostConfig } from "../config";
import {
  CONTROL_API_VERSION,
  PRODUCT_VERSION,
  type BrowserSession,
  type CapabilityReport,
  type DesktopThreadCleanupCandidate,
  type DesktopThreadCleanupResult,
  type DoctorCheck,
  type HealthReport,
} from "../contracts";
import { ManagedProcess } from "./managed-process";
import { CdpClient, type CdpTarget } from "./cdp";

type DesktopModelSelection = {
  model: string;
  reasoning: string;
  display: string;
};

const DESKTOP_MODEL_LABELS: Record<string, string> = {
  "gpt-5.6-sol": "5.6 Sol",
  "gpt-5.6-terra": "5.6 Terra",
  "gpt-5.6-luna": "5.6 Luna",
  "5.6-sol": "5.6 Sol",
  "5.6-terra": "5.6 Terra",
  "5.6-luna": "5.6 Luna",
};

const DESKTOP_REASONING_LABELS: Record<string, string> = {
  light: "Light",
  low: "Light",
  standard: "Medium",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  "extra-high": "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const DESKTOP_MODEL_BUTTON_PATTERN = "^5\\.6\\s+(?:Sol|Terra|Luna)\\s+(?:Instant|Light|Medium|High|Extra High|Max|Ultra)$";
const DESKTOP_MODE_BUTTON_PATTERN = "^Switch mode, current mode:";
const DESKTOP_CODEX_MENU_ITEM_PATTERN = "^Codex\\s+Build, debug, and ship$";
const DESKTOP_PERMISSION_BUTTON_PATTERN = "^(?:Ask for approval|Approve for me|Full access)$";
const DESKTOP_FULL_ACCESS_MENU_ITEM_PATTERN = "^Full access\\s+Unrestricted access to the internet and any file on your computer$";

type DesktopSidebarThread = {
  id: string;
  title: string;
  active: boolean;
};

function cleanupTitleTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !["exactly", "nothing", "else", "with", "the", "and", "for", "this", "that", "please"].includes(token));
}

function cleanupTitleMatches(candidate: string, desktopTitle: string): boolean {
  const candidateTokens = cleanupTitleTokens(candidate);
  const desktopTokens = cleanupTitleTokens(desktopTitle);
  if (desktopTokens.length < 3) return false;
  return desktopTokens.every((token) => candidateTokens.includes(token));
}

function operatingSystemName(): string {
  if (process.platform !== "linux" || !existsSync("/etc/os-release")) return process.platform;
  try {
    const prettyName = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/m);
    return prettyName?.[1] ?? prettyName?.[2] ?? "Linux";
  } catch {
    return "Linux";
  }
}

function containerReport(): HealthReport["machine"]["container"] {
  const containerHostname = hostname();
  if (existsSync("/.dockerenv")) return { detected: true, runtime: "docker", id: containerHostname };
  if (existsSync("/run/.containerenv")) return { detected: true, runtime: "podman", id: containerHostname };
  try {
    if (/docker|containerd|kubepods|podman/i.test(readFileSync("/proc/self/cgroup", "utf8"))) {
      return { detected: true, runtime: "container", id: containerHostname };
    }
  } catch {
    // Non-Linux and restricted runtimes may not expose cgroups.
  }
  return { detected: false };
}

const filesystemBlockSizes = new Map<string, number>();

function filesystemBlockSize(path: string, fallback: number): number {
  const cached = filesystemBlockSizes.get(path);
  if (cached) return cached;
  let blockSize = fallback;
  if (process.platform === "linux") {
    try {
      // Bun's compiled Linux statfs currently reports f_bsize on Docker Desktop
      // bind mounts, while f_blocks uses f_frsize. GNU stat exposes f_frsize as %S.
      const result = Bun.spawnSync(["stat", "-f", "-c", "%S", path]);
      const fundamentalSize = Number(Buffer.from(result.stdout).toString("utf8").trim());
      if (result.exitCode === 0 && Number.isFinite(fundamentalSize) && fundamentalSize > 0) blockSize = fundamentalSize;
    } catch {
      // Keep the runtime-reported size when coreutils is unavailable.
    }
  }
  filesystemBlockSizes.set(path, blockSize);
  return blockSize;
}

export function desktopReasoningLabel(reasoning: string): string | undefined {
  return DESKTOP_REASONING_LABELS[reasoning.trim().toLowerCase()];
}

type DesktopTurnBaseline = {
  desktopTargetId: string;
  threadTitle: string;
  prompt: string;
  browserTargets: Array<Pick<CdpTarget, "id" | "url">>;
  model?: DesktopModelSelection;
  cleanupBrowser: boolean;
};

export type DesktopTurnResult = {
  sessionId: string;
  codexThreadId?: string;
  state: "completed";
  answer: string;
  text: string;
  model?: DesktopModelSelection;
  browser: {
    integration: "codex-desktop-built-in";
    observed: boolean;
    targets: Array<Pick<CdpTarget, "id" | "url" | "title" | "type">>;
    closedTargets: Array<Pick<CdpTarget, "id" | "url" | "title" | "type">>;
  };
  completedAt: string;
};

export type DesktopTurnEvent =
  | { type: "turn.started"; sessionId: string; codexThreadId?: string; model?: DesktopModelSelection }
  | { type: "response.delta"; sessionId: string; codexThreadId?: string; delta: string; text: string }
  | { type: "response.snapshot"; sessionId: string; codexThreadId?: string; text: string }
  | { type: "turn.progress"; sessionId: string; codexThreadId?: string; working: boolean; elapsedMs: number; reconnecting?: boolean; detail?: string }
  | { type: "browser.opened"; sessionId: string; codexThreadId?: string; target: Pick<CdpTarget, "id" | "url" | "title" | "type"> }
  | ({ type: "turn.completed" } & DesktopTurnResult);

export class HostRuntime {
  readonly config: HostConfig;
  readonly startedAt = new Date();
  readonly sessions = new Map<string, BrowserSession>();
  readonly virtualDisplay: ManagedProcess;
  readonly desktop: ManagedProcess;
  readonly vnc: ManagedProcess;
  readonly webViewer: ManagedProcess;
  readonly cdp: CdpClient;
  readonly desktopTurnBaselines = new Map<string, DesktopTurnBaseline>();
  private desktopSubmissionTail: Promise<void> = Promise.resolve();

  private async withDesktopSubmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.desktopSubmissionTail;
    let release = () => {};
    this.desktopSubmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  constructor(config: HostConfig) {
    this.config = config;
    const codexHome = process.env.CODEX_HOME?.trim() || join(config.dataDir, "codex-home");
    this.cdp = new CdpClient(`http://127.0.0.1:${config.desktopBridgePort}`);
    this.virtualDisplay = new ManagedProcess({
      name: "xvfb",
      enabled: config.desktopEnabled,
      command: [config.xvfbBinary, config.display, "-screen", "0", config.viewport, "-nolisten", "tcp", "-noreset"],
    });
    this.desktop = new ManagedProcess({
      name: "codex-desktop",
      enabled: config.desktopEnabled,
      command: [
        config.desktopBinary,
        "--ozone-platform=x11",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${config.desktopBridgePort}`,
        `--user-data-dir=${join(config.dataDir, "desktop")}`,
      ],
      env: {
        CODEX_HOME: codexHome,
        DISPLAY: config.display,
        XDG_CURRENT_DESKTOP: "headless-codex",
      },
    });
    this.vnc = new ManagedProcess({
      name: "x11vnc",
      enabled: config.desktopEnabled && config.viewerEnabled,
      command: [config.x11vncBinary, "-display", config.display, "-localhost", "-forever", "-shared", "-rfbport", String(config.vncPort), "-nopw", "-noxdamage"],
    });
    this.webViewer = new ManagedProcess({
      name: "novnc",
      enabled: config.desktopEnabled && config.viewerEnabled,
      command: [config.websockifyBinary, "--web", config.noVncWebRoot, `${config.viewerHost}:${config.viewerPort}`, `127.0.0.1:${config.vncPort}`],
    });
  }

  async start(): Promise<void> {
    if (this.config.desktopEnabled) {
      await this.virtualDisplay.start();
      await Bun.sleep(250);
      await this.vnc.start();
      await this.webViewer.start();
      await this.desktop.start();
      await this.waitForDesktopReady();
      // A fresh Desktop may still be at the sign-in screen, where the mode
      // picker is unavailable. It will be enforced after device auth too.
      await this.ensureDesktopCodexMode({ required: false });
      await this.ensureDesktopFullAccess({ required: false });
      await this.ensureDesktopSidebarHidden({ required: false });
    }
  }

  async stop(): Promise<void> {
    await this.desktop.stop();
    await this.webViewer.stop();
    await this.vnc.stop();
    await this.virtualDisplay.stop();
  }

  /** Reloads the Desktop after a credential-changing operation. */
  async restartDesktop(): Promise<void> {
    if (!this.config.desktopEnabled) return;
    await this.desktop.stop();
    await this.desktop.start();
    await this.waitForDesktopReady();
    await this.ensureDesktopCodexMode();
    await this.ensureDesktopFullAccess();
    await this.ensureDesktopSidebarHidden();
  }

  health(): HealthReport {
    const processes = [this.virtualDisplay.status(), this.vnc.status(), this.webViewer.status(), this.desktop.status()];
    const failed = processes.some((process) => process.state === "failed");
    const enabledNotRunning = processes.some((process) => !["disabled", "running"].includes(process.state));
    let storage: HealthReport["machine"]["storage"];
    try {
      const stats = statfsSync(this.config.workspaceRoot);
      const blockSize = filesystemBlockSize(this.config.workspaceRoot, Number(stats.bsize));
      storage = {
        path: this.config.workspaceRoot,
        totalBytes: Number(stats.blocks) * blockSize,
        freeBytes: Number(stats.bavail) * blockSize,
      };
    } catch {
      // The configured workspace may not be mounted yet during early startup.
    }
    return {
      status: failed ? "failed" : enabledNotRunning ? "degraded" : "ok",
      version: PRODUCT_VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      startedAt: this.startedAt.toISOString(),
      runtime: {
        platform: process.platform,
        arch: process.arch,
        display: this.config.desktopEnabled ? this.config.display : undefined,
      },
      machine: {
        hostname: hostname(),
        operatingSystem: operatingSystemName(),
        kernel: `${process.platform} ${release()}`,
        arch: process.arch,
        logicalCpus: availableParallelism(),
        memory: { totalBytes: totalmem(), freeBytes: freemem() },
        storage,
        uptimeSeconds: Math.floor(uptime()),
        container: containerReport(),
      },
      processes,
    };
  }

  async capabilities(): Promise<CapabilityReport> {
    const codexAvailable = Boolean(Bun.which(this.config.codexBinary) || existsSync(this.config.codexBinary));
    const managedDesktopHosted = this.desktop.status().state === "running" && this.virtualDisplay.status().state === "running";
    const desktopHosted = managedDesktopHosted;
    let bridgeReady = false;
    if (desktopHosted && await this.cdp.ready()) {
      try {
        const target = (await this.cdp.targets()).find((candidate) =>
          candidate.type === "page"
          && candidate.title === "Codex"
          && !candidate.url.includes("initialRoute="),
        );
        bridgeReady = Boolean(target) && await this.cdp.evaluate(target!, `(() => {
          const composerReady = Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'));
          const modelReady = Array.from(document.querySelectorAll('button'))
            .map(candidate => (candidate.innerText || '').trim().replace(/\\s+/g, ' '))
            .some(text => new RegExp(${JSON.stringify(DESKTOP_MODEL_BUTTON_PATTERN)}).test(text));
          return composerReady && modelReady;
        })()`) === true;
      } catch {
        bridgeReady = false;
      }
    }
    return {
      healthy: this.health().status !== "failed",
      service: "online",
      capabilities: {
        codex: codexAvailable,
        browser: bridgeReady,
        browserLiveView: bridgeReady,
        screenshots: bridgeReady,
        persistentProfiles: desktopHosted,
      },
      browser: {
        integration: "desktop-native",
        state: bridgeReady ? "ready" : desktopHosted ? "hosted" : this.config.desktopEnabled ? "unavailable" : "disabled",
        reason: bridgeReady
          ? "Desktop renderer and mediated control bridge are ready."
          : desktopHosted
            ? `Desktop renderer is hosted, but its loopback bridge on port ${this.config.desktopBridgePort} is not ready.`
          : this.config.desktopEnabled
            ? "The Linux desktop renderer is not running."
            : `Native desktop hosting is disabled on this ${process.platform}/${process.arch} host.`,
      },
      protocols: { controlApi: CONTROL_API_VERSION },
    };
  }

  async browserTargets(): Promise<CdpTarget[]> {
    if (!await this.cdp.ready()) return [];
    return this.cdp.targets();
  }

  async waitForDesktopReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let consecutiveReadyChecks = 0;
    do {
      const target = (await this.browserTargets()).find((candidate) =>
        candidate.type === "page" &&
        candidate.title === "Codex" &&
        !candidate.url.includes("initialRoute="),
      );
      consecutiveReadyChecks = target ? consecutiveReadyChecks + 1 : 0;
      if (consecutiveReadyChecks >= 2) return;
      if (Date.now() >= deadline) break;
      await Bun.sleep(500);
    } while (true);
    throw new Error(`Codex Desktop did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds after restart`);
  }

  async restoreDesktopTurn(codexThreadId: string, prompt: string, threadTitle = ""): Promise<void> {
    const target = await this.primaryDesktopTarget();
    this.desktopTurnBaselines.set(codexThreadId, {
      desktopTargetId: target.id,
      threadTitle,
      prompt,
      browserTargets: [],
      cleanupBrowser: false,
    });
  }

  async browserSessions(): Promise<BrowserSession[]> {
    const targets = await this.browserTargets();
    return targets.map((target) => ({
      id: target.id,
      state: "ready",
      url: target.url,
      title: target.title,
      createdAt: this.startedAt.toISOString(),
      targetType: target.type,
    }));
  }

  async cleanupBrowserTabs(preserveTargetIds: ReadonlySet<string> = new Set()): Promise<Array<Pick<CdpTarget, "id" | "url" | "title" | "type">>> {
    const targets = (await this.browserTargets()).filter((target) =>
      target.type === "page"
      && /^https?:\/\//.test(target.url)
      && !preserveTargetIds.has(target.id),
    );
    const closed: Array<Pick<CdpTarget, "id" | "url" | "title" | "type">> = [];
    await Promise.all(targets.map(async (target) => {
      try {
        await this.cdp.closeTarget(target);
        closed.push({ id: target.id, url: target.url, title: target.title, type: target.type });
      } catch {
        // Cleanup is best-effort and must not turn a completed research task into a failure.
      }
    }));
    return closed;
  }

  async browserScreenshot(sessionId: string): Promise<Uint8Array> {
    const target = (await this.browserTargets()).find((candidate) => candidate.id === sessionId);
    if (!target) throw new Error(`Browser session ${sessionId} was not found`);
    return this.cdp.screenshot(target);
  }

  async browserSnapshot(sessionId: string): Promise<unknown> {
    const target = (await this.browserTargets()).find((candidate) => candidate.id === sessionId);
    if (!target) throw new Error(`Browser session ${sessionId} was not found`);
    return this.cdp.evaluate(target, `(() => {
      const selectors = 'textarea,input,button,a,[contenteditable="true"],[role="button"],[role="textbox"],[role="slider"]';
      return Array.from(document.querySelectorAll(selectors)).map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const html = element;
        return {
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          type: html.type || null,
          text: (element.innerText || html.value || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 200),
          ariaLabel: element.getAttribute('aria-label'),
          placeholder: element.getAttribute('placeholder'),
          value: html.value ?? element.getAttribute('aria-valuenow'),
          min: html.min ?? element.getAttribute('aria-valuemin'),
          max: html.max ?? element.getAttribute('aria-valuemax'),
          ariaValueText: element.getAttribute('aria-valuetext'),
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          disabled: Boolean(html.disabled || element.getAttribute('aria-disabled') === 'true'),
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      }).filter(item => item.visible);
    })()`);
  }

  private async primaryDesktopTarget(): Promise<CdpTarget> {
    const target = (await this.browserTargets()).find((candidate) =>
      candidate.type === "page" &&
      candidate.title === "Codex" &&
      !candidate.url.includes("initialRoute="),
    );
    if (!target) throw new Error("The primary Codex Desktop renderer is not available");
    return target;
  }

  private async desktopControlPoint(target: CdpTarget, textPattern: string): Promise<{ x: number; y: number }> {
    const point = await this.cdp.evaluate(target, `(() => {
      const pattern = new RegExp(${JSON.stringify(textPattern)}, 'i');
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (hit && (hit === element || element.contains(hit))) return true;
        // Electron menu portals can report a transparent overlay as the hit
        // target even though their menu items are rendered and actionable.
        return element.getAttribute('role') === 'menuitem' && element.getAttribute('aria-disabled') !== 'true';
      };
      const element = Array.from(document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="radio"]'))
        .find(candidate => {
          const label = (candidate.getAttribute('aria-label') || candidate.innerText || '')
            .trim()
            .replace(/\\s+/g, ' ');
          return visible(candidate) && pattern.test(label);
        });
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point || typeof point !== "object" || !("x" in point) || !("y" in point)) {
      throw new Error(`Codex Desktop control matching ${textPattern} is not available`);
    }
    return point as { x: number; y: number };
  }

  private async clickDesktopControl(target: CdpTarget, textPattern: string): Promise<void> {
    const coordinates = await this.desktopControlPoint(target, textPattern);
    await this.cdp.command(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: coordinates.x, y: coordinates.y });
    await this.cdp.command(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: coordinates.x, y: coordinates.y, button: "left", clickCount: 1 });
    await this.cdp.command(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: coordinates.x, y: coordinates.y, button: "left", clickCount: 1 });
    await Bun.sleep(250);
  }

  private async domClickDesktopControl(target: CdpTarget, textPattern: string): Promise<void> {
    const clicked = await this.cdp.evaluate(target, `(() => {
      const pattern = new RegExp(${JSON.stringify(textPattern)}, 'i');
      const control = Array.from(document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="radio"]'))
        .find(candidate => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          const label = (candidate.getAttribute('aria-label') || candidate.innerText || '').trim().replace(/\\s+/g, ' ');
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && pattern.test(label);
        });
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (clicked !== true) throw new Error(`Codex Desktop control matching ${textPattern} could not be activated`);
    await Bun.sleep(350);
  }

  private async hoverDesktopControl(target: CdpTarget, textPattern: string): Promise<void> {
    const coordinates = await this.desktopControlPoint(target, textPattern);
    await this.cdp.command(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: coordinates.x, y: coordinates.y });
    await Bun.sleep(500);
  }

  private async selectDesktopSubmenuControl(target: CdpTarget, parentPattern: string, childPattern: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.hoverDesktopControl(target, parentPattern);
      await Bun.sleep(attempt * 250);
      try {
        await this.domClickDesktopControl(target, childPattern);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async openDesktopModelMenu(target: CdpTarget): Promise<void> {
    const modelMenuPattern = "^Model\\s+5\\.6\\s+(?:Sol|Terra|Luna)$";
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.dismissDesktopMenus(target);
      try {
        await this.clickDesktopControl(target, DESKTOP_MODEL_BUTTON_PATTERN);
        let advancedClicked = false;
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          try {
            await this.desktopControlPoint(target, modelMenuPattern);
            return;
          } catch (error) {
            lastError = error;
          }
          if (!advancedClicked) {
            try {
              await this.domClickDesktopControl(
                target,
                "^(?:Show advanced options\\s+)?Advanced$",
              );
              advancedClicked = true;
            } catch {
              // The advanced model controls may still be mounting.
            }
          }
          await Bun.sleep(100);
        }
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(250 * (attempt + 1));
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Codex Desktop model controls did not become available");
  }

  private async dismissDesktopMenus(target: CdpTarget): Promise<void> {
    for (let index = 0; index < 3; index += 1) {
      await this.cdp.command(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await this.cdp.command(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    }
    await Bun.sleep(100);
  }

  private async desktopMode(target: CdpTarget): Promise<string> {
    const mode = await this.cdp.evaluate(target, `(() => {
      const control = document.querySelector('button[aria-label^="Switch mode, current mode:"]');
      const label = control?.getAttribute('aria-label') || '';
      const match = label.match(/^Switch mode, current mode:\\s*(.+)$/);
      return match?.[1]?.trim() || '';
    })()`);
    return typeof mode === "string" ? mode : "";
  }

  /**
   * Keeps Desktop on the Codex surface. The selector is a Desktop UI setting,
   * so this deliberately uses the same real CDP input path as other Desktop
   * controls and verifies the setting after the click.
   */
  async ensureDesktopCodexMode(options: { required?: boolean } = {}): Promise<boolean> {
    const target = await this.primaryDesktopTarget();
    const current = await this.desktopMode(target);
    if (current === "Codex") return true;
    if (current !== "ChatGPT") {
      if (options.required) throw new Error(`Codex Desktop mode selector is unavailable (${current || "mode unavailable"})`);
      return false;
    }

    await this.dismissDesktopMenus(target);
    await this.clickDesktopControl(target, DESKTOP_MODE_BUTTON_PATTERN);
    await this.clickDesktopControl(target, DESKTOP_CODEX_MENU_ITEM_PATTERN);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.desktopMode(target) === "Codex") return true;
      await Bun.sleep(100);
    }
    await this.dismissDesktopMenus(target);
    throw new Error("Codex Desktop did not switch to Codex mode");
  }

  private async desktopPermissionMode(target: CdpTarget): Promise<string> {
    const mode = await this.cdp.evaluate(target, `(() => {
      return Array.from(document.querySelectorAll('button'))
        .map(candidate => (candidate.innerText || '').trim().replace(/\\s+/g, ' '))
        .find(text => /^(?:Ask for approval|Approve for me|Full access)$/.test(text)) || '';
    })()`);
    return typeof mode === "string" ? mode : "";
  }

  /** Ensures unattended Desktop turns cannot fall back to interactive approvals. */
  async ensureDesktopFullAccess(options: { required?: boolean } = {}): Promise<boolean> {
    const target = await this.primaryDesktopTarget();
    const current = await this.desktopPermissionMode(target);
    if (current === "Full access") return true;
    if (!current) {
      if (options.required) throw new Error("Codex Desktop permission selector is unavailable");
      return false;
    }

    await this.dismissDesktopMenus(target);
    await this.clickDesktopControl(target, DESKTOP_PERMISSION_BUTTON_PATTERN);
    await this.clickDesktopControl(target, DESKTOP_FULL_ACCESS_MENU_ITEM_PATTERN);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.desktopPermissionMode(target) === "Full access") return true;
      await Bun.sleep(100);
    }
    await this.dismissDesktopMenus(target);
    throw new Error("Codex Desktop did not switch to Full access");
  }

  private async desktopSidebarState(target: CdpTarget): Promise<"shown" | "hidden" | "unavailable"> {
    const state = await this.cdp.evaluate(target, `(() => {
      const labels = Array.from(document.querySelectorAll('button'))
        .map(candidate => candidate.getAttribute('aria-label') || '');
      if (labels.includes('Hide sidebar')) return 'shown';
      if (labels.includes('Show sidebar')) return 'hidden';
      return 'unavailable';
    })()`);
    return state === "shown" || state === "hidden" ? state : "unavailable";
  }

  /** Keeps task navigation mounted because Desktop exposes task IDs on sidebar rows. */
  async ensureDesktopSidebarVisible(options: { required?: boolean } = {}): Promise<boolean> {
    const target = await this.primaryDesktopTarget();
    const current = await this.desktopSidebarState(target);
    if (current === "shown") return true;
    if (current === "unavailable") {
      if (options.required) throw new Error("Codex Desktop sidebar control is unavailable");
      return false;
    }

    await this.dismissDesktopMenus(target);
    await this.clickDesktopControl(target, "^Show sidebar$");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.desktopSidebarState(target) === "shown") return true;
      await Bun.sleep(100);
    }
    throw new Error("Codex Desktop did not reveal its task sidebar");
  }

  /** Keeps the human viewer focused on the active task while the worker is idle. */
  async ensureDesktopSidebarHidden(options: { required?: boolean } = {}): Promise<boolean> {
    const target = await this.primaryDesktopTarget();
    let current = await this.desktopSidebarState(target);
    const controlDeadline = Date.now() + 15_000;
    while (current === "unavailable" && Date.now() < controlDeadline) {
      await Bun.sleep(100);
      current = await this.desktopSidebarState(target);
    }
    if (current === "hidden") return true;
    if (current === "unavailable") {
      if (options.required) throw new Error("Codex Desktop sidebar control is unavailable");
      return false;
    }

    await this.dismissDesktopMenus(target);
    await this.clickDesktopControl(target, "^Hide sidebar$");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.desktopSidebarState(target) === "hidden") return true;
      await Bun.sleep(100);
    }
    throw new Error("Codex Desktop did not hide its task sidebar");
  }

  private async desktopConversationOpen(target: CdpTarget): Promise<boolean> {
    return this.cdp.evaluate(
      target,
      `(document.body.innerText || '').includes('You said:')`,
    ) as Promise<boolean>;
  }

  private async waitForFreshDesktopChat(target: CdpTarget, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.cdp.evaluate(target, `(() => ({
        hasConversation: (document.body.innerText || '').includes('You said:'),
        composerReady: Boolean(document.querySelector('[role="textbox"][contenteditable="true"]')),
      }))()`);
      if (
        state
        && typeof state === "object"
        && "hasConversation" in state
        && "composerReady" in state
        && state.hasConversation === false
        && state.composerReady === true
      ) return true;
      await Bun.sleep(100);
    }
    return false;
  }

  /** Opens a verified blank chat even when Desktop's optional sidebar is hidden. */
  private async startFreshDesktopChat(target: CdpTarget): Promise<void> {
    await this.dismissDesktopMenus(target);
    try {
      await this.clickDesktopControl(target, "^New chat$");
      if (await this.waitForFreshDesktopChat(target, 2_000)) return;
    } catch {
      // The sidebar-only action is absent when Desktop collapses the sidebar.
    }

    await this.dismissDesktopMenus(target);
    await this.clickDesktopControl(target, "^File$");
    await this.clickDesktopControl(target, "^New Chat\\s+Ctrl\\+N$");
    if (await this.waitForFreshDesktopChat(target, 5_000)) return;

    await this.dismissDesktopMenus(target);
    throw new Error("Codex Desktop did not open a fresh chat");
  }

  private async enableDesktopReasoningEfforts(target: CdpTarget): Promise<void> {
    const updated = await this.cdp.evaluate(target, `(() => {
      const send = window.electronBridge?.sendMessageFromView;
      if (!send) return false;
      return send({
        type: "persisted-atom-update",
        key: "enabled-reasoning-efforts",
        value: ["low", "medium", "high", "xhigh", "max", "ultra"],
        deleted: false,
      }).then(() => true);
    })()`);
    if (updated !== true) throw new Error("Codex Desktop reasoning-effort settings bridge is unavailable");
    await Bun.sleep(250);
  }

  private async selectDesktopReasoningEffort(target: CdpTarget, effortLabel: string): Promise<void> {
    await this.openDesktopModelMenu(target);
    await this.selectDesktopSubmenuControl(
      target,
      "^Effort\\s+(?:Instant|Light|Medium|High|Extra High|Max|Ultra)$",
      `^${effortLabel.replaceAll(" ", "\\s+")}$`,
    );
    await Bun.sleep(500);
    await this.dismissDesktopMenus(target);
  }

  private async desktopModelLabel(): Promise<string> {
    const target = await this.primaryDesktopTarget();
    return this.cdp.evaluate(target, `(() => {
      return Array.from(document.querySelectorAll('button'))
        .map(candidate => (candidate.innerText || '').trim().replace(/\\s+/g, ' '))
        .find(text => /5\\.6\\s+(?:Sol|Terra|Luna)/i.test(text)) || '';
    })()`) as Promise<string>;
  }

  async selectDesktopModel(model: string, reasoning: string): Promise<DesktopModelSelection> {
    const target = await this.primaryDesktopTarget();
    await this.dismissDesktopMenus(target);
    const requestedModel = model.trim();
    const modelLabel = DESKTOP_MODEL_LABELS[requestedModel.toLowerCase()] ?? requestedModel;
    if (!/^5\.6 (?:Sol|Terra|Luna)$/.test(modelLabel)) {
      throw new Error(`Desktop browser mode supports 5.6 Sol, 5.6 Terra, or 5.6 Luna; received ${model}`);
    }
    const normalizedReasoning = reasoning.trim().toLowerCase();
    const effortLabel = desktopReasoningLabel(normalizedReasoning);
    if (!effortLabel) throw new Error(`Desktop browser mode supports light, medium, high, xhigh, max, or ultra reasoning; received ${reasoning}`);

    await this.enableDesktopReasoningEfforts(target);

    let current = "";
    const readyDeadline = Date.now() + 15_000;
    while (!current && Date.now() < readyDeadline) {
      current = await this.desktopModelLabel();
      if (!current) await Bun.sleep(100);
    }
    if (!current) throw new Error("Codex Desktop model controls did not become ready");
    const expected = `${modelLabel} ${effortLabel}`;
    if (!current.startsWith(modelLabel)) {
      await this.openDesktopModelMenu(target);
      await this.selectDesktopSubmenuControl(
        target,
        "^Model\\s+5\\.6\\s+(?:Sol|Terra|Luna)$",
        `^${modelLabel.replaceAll(".", "\\.")}$`,
      );
      await Bun.sleep(500);
    }

    const afterModel = await this.desktopModelLabel();
    if (!afterModel.startsWith(modelLabel)) throw new Error(`Codex Desktop selected ${afterModel || "no model"}; expected model ${modelLabel}`);
    if (!afterModel.endsWith(effortLabel)) {
      await this.selectDesktopReasoningEffort(target, effortLabel);
    }

    const selected = await this.desktopModelLabel();
    if (selected !== expected) throw new Error(`Codex Desktop selected ${selected || "no model"}; expected ${expected}`);
    return { model: requestedModel, reasoning: normalizedReasoning, display: selected };
  }

  async submitDesktopTurn(prompt: string, options: { model?: string; reasoning?: string; browser?: boolean; newChat?: boolean; cleanupBrowser?: boolean } = {}): Promise<{ sessionId: string; codexThreadId?: string; threadTitle?: string; submittedAt: string; runtime: "codex-desktop"; model: DesktopModelSelection }> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("Prompt is required");
    if (trimmed.length > 100_000) throw new Error("Prompt exceeds 100,000 characters");
    return this.withDesktopSubmissionLock(async () => {
      const target = await this.primaryDesktopTarget();
      await this.ensureDesktopCodexMode();
      await this.ensureDesktopFullAccess();
      const hasConversation = await this.desktopConversationOpen(target);
      if (hasConversation === true && options.newChat !== false) {
        await this.startFreshDesktopChat(target);
        await Bun.sleep(500);
      }
      const cleanupBrowser = options.cleanupBrowser ?? options.browser === true;
      const model = await this.selectDesktopModel(options.model ?? "gpt-5.6-luna", options.reasoning ?? "xhigh");
      const baseline = (await this.browserTargets())
        .filter((candidate) => /^https?:/.test(candidate.url))
        .map(({ id, url }) => ({ id, url }));

      const composerReady = await this.cdp.evaluate(target, `(() => {
        const composer = document.querySelector('[role="textbox"][contenteditable="true"]');
        if (!composer) return false;
        composer.focus();
        return document.activeElement === composer;
      })()`);
      if (composerReady !== true) throw new Error("The Codex Desktop chat composer is not ready");

      await this.cdp.command(target, "Input.insertText", { text: trimmed });
      await this.cdp.command(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await this.cdp.command(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });

      // Normal API turns track the active renderer directly. Opening Desktop's
      // navigation solely to discover its private row ID causes a distracting
      // sidebar flash in the live viewer.
      const selected = { id: `local:client-new-thread:${crypto.randomUUID()}`, title: "" };
      this.desktopTurnBaselines.set(selected.id, {
        desktopTargetId: target.id,
        threadTitle: selected.title,
        prompt: trimmed,
        browserTargets: baseline,
        model,
        cleanupBrowser,
      });
      return {
        sessionId: target.id,
        codexThreadId: selected.id,
        threadTitle: selected.title,
        submittedAt: new Date().toISOString(),
        runtime: "codex-desktop",
        model,
      };
    });
  }

  async desktopThreadState(codexThreadId: string): Promise<{ codexThreadId: string; selected: boolean; working: boolean; text: string; title: string; testIds: string[]; links: Array<{ text: string; href: string }> }> {
    const baseline = this.desktopTurnBaselines.get(codexThreadId);
    const target = baseline
      ? (await this.browserTargets()).find((candidate) => candidate.id === baseline.desktopTargetId)
      : await this.primaryDesktopTarget();
    if (!target) throw new Error(`Desktop task ${codexThreadId} is no longer attached`);
    const state = await this.cdp.evaluate(target, `(() => {
      const requestedId = ${JSON.stringify(codexThreadId)};
      const requestedTitle = ${JSON.stringify(baseline?.threadTitle ?? "")};
      const requestedPrompt = ${JSON.stringify(baseline?.prompt.slice(0, 240) ?? "")};
      const requestedPromptTail = ${JSON.stringify(baseline?.prompt.slice(-240) ?? "")};
      const rows = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'));
      const selectedRow = rows.find(candidate => candidate.getAttribute('aria-current') === 'page');
      const pageText = (document.body.innerText || '').trim();
      const links = Array.from(document.querySelectorAll('a[href]')).map(anchor => ({
        text: (anchor.innerText || '').trim().replace(/\\s+/g, ' '),
        href: anchor.href || '',
      })).filter(link => link.text && /^https?:/i.test(link.href));
      const selectedText = selectedRow ? pageText : '';
      const provisionalSelectedRow = requestedId.startsWith('local:client-new-thread:')
        && (!requestedPrompt || selectedText.includes(requestedPrompt))
        ? selectedRow
        : undefined;
      const row = rows.find(candidate => candidate.getAttribute('data-app-action-sidebar-thread-id') === requestedId)
        || (requestedTitle ? rows.find(candidate => candidate.getAttribute('data-app-action-sidebar-thread-title') === requestedTitle) : undefined)
        || provisionalSelectedRow;
      if (!row) {
        const matchesDetachedTask = requestedId.startsWith('local:client-new-thread:')
          && Boolean(requestedPromptTail);
        if (!matchesDetachedTask) return undefined;
        const buttons = Array.from(document.querySelectorAll('button'));
        const buttonLabels = buttons.map(button => (button.getAttribute('aria-label') || button.innerText || '').trim());
        return {
          codexThreadId: requestedId,
          selected: true,
          working: buttonLabels.some(label => /^(stop|cancel)/i.test(label)) || /Working for \d+s/.test(pageText),
          text: pageText,
          title: requestedTitle || document.title,
          testIds: Array.from(document.querySelectorAll('[data-testid]')).map(element => element.getAttribute('data-testid')).filter(Boolean),
          links,
        };
      }
      const actualId = row.getAttribute('data-app-action-sidebar-thread-id') || requestedId;
      const selected = row.getAttribute('aria-current') === 'page';
      const bodyText = selected ? (document.body.innerText || '').trim() : '';
      const buttons = selected ? Array.from(document.querySelectorAll('button')) : [];
      const buttonLabels = buttons.map(button => (button.getAttribute('aria-label') || button.innerText || '').trim());
      return {
        codexThreadId: actualId,
        selected,
        working: selected
          ? buttonLabels.some(label => /^(stop|cancel)/i.test(label)) || /Working for \\d+s/.test(bodyText)
          : row.getAttribute('data-app-action-sidebar-thread-active') === 'true',
        text: bodyText,
        title: row.getAttribute('data-app-action-sidebar-thread-title') || document.title,
        testIds: selected
          ? Array.from(document.querySelectorAll('[data-testid]')).map(element => element.getAttribute('data-testid')).filter(Boolean)
          : [],
        links: selected ? links : [],
      };
    })()`);
    if (!state) throw new Error(`Codex Desktop task ${codexThreadId} was not found`);
    return state as { codexThreadId: string; selected: boolean; working: boolean; text: string; title: string; testIds: string[]; links: Array<{ text: string; href: string }> };
  }

  async showDesktopThread(codexThreadId: string): Promise<{ codexThreadId: string; title: string; selected: true }> {
    return this.withDesktopSubmissionLock(async () => {
      const baseline = this.desktopTurnBaselines.get(codexThreadId);
      const target = baseline
        ? (await this.browserTargets()).find((candidate) => candidate.id === baseline.desktopTargetId)
        : await this.primaryDesktopTarget();
      if (!target) throw new Error(`Desktop task ${codexThreadId} is no longer attached`);
      const selected = await this.cdp.evaluate(target, `(() => {
        const requestedId = ${JSON.stringify(codexThreadId)};
        const requestedTitle = ${JSON.stringify(baseline?.threadTitle ?? "")};
        const requestedPrompt = ${JSON.stringify(baseline?.prompt.slice(0, 240) ?? "")};
        const rows = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'));
        const selectedRow = rows.find(candidate => candidate.getAttribute('aria-current') === 'page');
        const selectedText = selectedRow ? (document.body.innerText || '') : '';
        const provisionalSelectedRow = requestedId.startsWith('local:client-new-thread:')
          && (!requestedPrompt || selectedText.includes(requestedPrompt))
          ? selectedRow
          : undefined;
        const row = rows.find(candidate => candidate.getAttribute('data-app-action-sidebar-thread-id') === requestedId)
          || (requestedTitle ? rows.find(candidate => candidate.getAttribute('data-app-action-sidebar-thread-title') === requestedTitle) : undefined)
          || provisionalSelectedRow;
        if (!row) return undefined;
        row.click();
        return {
          id: row.getAttribute('data-app-action-sidebar-thread-id') || requestedId,
          title: row.getAttribute('data-app-action-sidebar-thread-title') || '',
        };
      })()`) as { id: string; title: string } | undefined;
      if (!selected) throw new Error(`Codex Desktop task ${codexThreadId} was not found`);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const current = await this.cdp.evaluate(target, `document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id') || ''`);
        if (current === selected.id) return { codexThreadId: selected.id, title: selected.title, selected: true };
        await Bun.sleep(100);
      }
      throw new Error(`Codex Desktop did not finish switching to task ${codexThreadId}`);
    });
  }

  async archiveTerminalDesktopThreads(
    candidates: readonly DesktopThreadCleanupCandidate[],
  ): Promise<DesktopThreadCleanupResult[]> {
    return this.withDesktopSubmissionLock(async () => {
      const target = await this.primaryDesktopTarget();
      const sidebarThreads = await this.cdp.evaluate(target, `(() => Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]')).map(row => ({
        id: row.getAttribute('data-app-action-sidebar-thread-id') || '',
        title: row.getAttribute('data-app-action-sidebar-thread-title') || '',
        active: row.getAttribute('data-app-action-sidebar-thread-active') === 'true',
      })).filter(row => row.id && row.title))()`) as DesktopSidebarThread[];
      const claimedDesktopIds = new Set<string>();
      const results: DesktopThreadCleanupResult[] = [];

      for (const candidate of candidates) {
        const directMatches = sidebarThreads.filter((thread) => candidate.desktopThreadIds.includes(thread.id));
        const titleMatches = directMatches.length === 0
          ? sidebarThreads.filter((thread) => cleanupTitleMatches(candidate.title, thread.title))
          : directMatches;
        if (titleMatches.some((thread) => thread.active)) {
          results.push({ traceThreadId: candidate.traceThreadId, outcome: "active" });
          continue;
        }
        if (titleMatches.length === 0) {
          results.push({ traceThreadId: candidate.traceThreadId, outcome: "unmatched" });
          continue;
        }
        if (titleMatches.length !== 1 || claimedDesktopIds.has(titleMatches[0]!.id)) {
          results.push({ traceThreadId: candidate.traceThreadId, outcome: "ambiguous" });
          continue;
        }
        const desktopThread = titleMatches[0]!;
        const clicked = await this.cdp.evaluate(target, `(() => {
          const threadId = ${JSON.stringify(desktopThread.id)};
          const row = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
            .find(candidate => candidate.getAttribute('data-app-action-sidebar-thread-id') === threadId);
          if (!row || row.getAttribute('data-app-action-sidebar-thread-active') === 'true') return false;
          const archive = Array.from(row.querySelectorAll('button'))
            .find(button => button.getAttribute('aria-label') === 'Archive chat');
          if (!archive || archive.disabled) return false;
          archive.click();
          return true;
        })()`);
        if (clicked !== true) {
          results.push({
            traceThreadId: candidate.traceThreadId,
            desktopThreadId: desktopThread.id,
            outcome: "failed",
            detail: "Codex Desktop did not expose an archive control for this conversation.",
          });
          continue;
        }
        const deadline = Date.now() + 5_000;
        let removed = false;
        while (Date.now() < deadline) {
          const exists = await this.cdp.evaluate(target, `(() => {
            const threadId = ${JSON.stringify(desktopThread.id)};
            return Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
              .some(row => row.getAttribute('data-app-action-sidebar-thread-id') === threadId);
          })()`);
          if (exists !== true) {
            removed = true;
            break;
          }
          await Bun.sleep(100);
        }
        if (!removed) {
          results.push({
            traceThreadId: candidate.traceThreadId,
            desktopThreadId: desktopThread.id,
            outcome: "failed",
            detail: "Codex Desktop did not confirm that the conversation left the sidebar.",
          });
          continue;
        }
        claimedDesktopIds.add(desktopThread.id);
        results.push({
          traceThreadId: candidate.traceThreadId,
          desktopThreadId: desktopThread.id,
          outcome: "archived",
        });
      }
      return results;
    });
  }

  async archiveFinishedDesktopConversations(): Promise<DesktopThreadCleanupResult[]> {
    return this.withDesktopSubmissionLock(async () => {
      const target = await this.primaryDesktopTarget();
      const sidebarThreads = await this.cdp.evaluate(target, `(() => {
        const text = document.body?.innerText || '';
        const working = Array.from(document.querySelectorAll('button')).some(button => /^(stop|cancel)/i.test((button.getAttribute('aria-label') || button.innerText || '').trim()))
          || /Working for \\d+s/.test(text);
        return {
          working,
          threads: Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]')).map(row => ({
            id: row.getAttribute('data-app-action-sidebar-thread-id') || '',
            title: row.getAttribute('data-app-action-sidebar-thread-title') || '',
          })).filter(row => row.id && row.title),
        };
      })()`) as { working: boolean; threads: Array<Pick<DesktopSidebarThread, "id" | "title">> };
      if (sidebarThreads.working) {
        throw new Error("Codex Desktop reports a conversation is still running; no conversations were cleared.");
      }
      const results: DesktopThreadCleanupResult[] = [];
      for (const desktopThread of sidebarThreads.threads) {
        const clicked = await this.cdp.evaluate(target, `(() => {
          const threadId = ${JSON.stringify(desktopThread.id)};
          const row = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
            .find(candidate => candidate.getAttribute('data-app-action-sidebar-thread-id') === threadId);
          const archive = row && Array.from(row.querySelectorAll('button'))
            .find(button => button.getAttribute('aria-label') === 'Archive chat');
          if (!archive || archive.disabled) return false;
          archive.click();
          return true;
        })()`);
        if (clicked !== true) {
          results.push({
            traceThreadId: desktopThread.id,
            desktopThreadId: desktopThread.id,
            outcome: "failed",
            detail: "Codex Desktop did not expose an archive control for this conversation.",
          });
          continue;
        }
        const deadline = Date.now() + 5_000;
        let removed = false;
        while (Date.now() < deadline) {
          const exists = await this.cdp.evaluate(target, `(() => {
            const threadId = ${JSON.stringify(desktopThread.id)};
            return Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
              .some(row => row.getAttribute('data-app-action-sidebar-thread-id') === threadId);
          })()`);
          if (exists !== true) {
            removed = true;
            break;
          }
          await Bun.sleep(100);
        }
        results.push(removed
          ? { traceThreadId: desktopThread.id, desktopThreadId: desktopThread.id, outcome: "archived" }
          : {
              traceThreadId: desktopThread.id,
              desktopThreadId: desktopThread.id,
              outcome: "failed",
              detail: "Codex Desktop did not confirm that the conversation left the sidebar.",
            });
      }
      return results;
    });
  }

  async cancelDesktopTurn(codexThreadId: string): Promise<{ codexThreadId: string; cancelled: boolean; working: boolean }> {
    await this.showDesktopThread(codexThreadId);
    return this.withDesktopSubmissionLock(async () => {
      const baseline = this.desktopTurnBaselines.get(codexThreadId);
      const target = baseline
        ? (await this.browserTargets()).find((candidate) => candidate.id === baseline.desktopTargetId)
        : await this.primaryDesktopTarget();
      if (!target) throw new Error(`Desktop task ${codexThreadId} is no longer attached`);
      const clicked = await this.cdp.evaluate(target, `(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const control = buttons.find(button => /^(stop|cancel)/i.test((button.getAttribute('aria-label') || button.innerText || '').trim()));
        if (!control) return false;
        control.click();
        return true;
      })()`);
      if (clicked !== true) {
        const state = await this.desktopThreadState(codexThreadId);
        return { codexThreadId: state.codexThreadId, cancelled: false, working: state.working };
      }
      const deadline = Date.now() + 10_000;
      let state = await this.desktopThreadState(codexThreadId);
      while (state.working && Date.now() < deadline) {
        await Bun.sleep(100);
        state = await this.desktopThreadState(codexThreadId);
      }
      return { codexThreadId: state.codexThreadId, cancelled: true, working: state.working };
    });
  }

  async desktopTurnState(sessionId: string): Promise<{ working: boolean; text: string; title: string; testIds: string[] }> {
    const target = (await this.browserTargets()).find((candidate) => candidate.id === sessionId);
    if (!target) throw new Error(`Desktop session ${sessionId} was not found`);
    const state = await this.cdp.evaluate(target, `(() => {
      const root = document.body;
      const buttons = Array.from(document.querySelectorAll('button'));
      const buttonLabels = buttons.map(button => (button.getAttribute('aria-label') || button.innerText || '').trim());
      const text = (root.innerText || '').trim();
      return {
        working: buttonLabels.some(label => /^(stop|cancel)/i.test(label)) || /Working for \\d+s/.test(text),
        text,
        title: document.title,
        testIds: Array.from(document.querySelectorAll('[data-testid]')).map(element => element.getAttribute('data-testid')).filter(Boolean)
      };
    })()`);
    return state as { working: boolean; text: string; title: string; testIds: string[] };
  }

  async *streamDesktopTurn(codexThreadId: string, timeoutMs = 600_000, reconnectGraceMs = 120_000, crashRetryCount = 0): AsyncGenerator<DesktopTurnEvent> {
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    let observedWorking = false;
    let lastText = "";
    let lastAnswer = "";
    let lastProgressAt = 0;
    let stablePolls = 0;
    let restoreThreadId: string | undefined;
    let activeThreadId = codexThreadId;
    let reconnectStartedAt: number | undefined;
    let reconnectError = "";
    let crashRetries = crashRetryCount;
    let baseline = this.desktopTurnBaselines.get(codexThreadId);
    let sessionId = baseline?.desktopTargetId ?? (await this.primaryDesktopTarget()).id;
    const observedBrowserTargets = new Map<string, Pick<CdpTarget, "id" | "url" | "title" | "type">>();
    yield { type: "turn.started", sessionId, codexThreadId: activeThreadId, model: baseline?.model };
    try {
      while (Date.now() < deadline) {
      let state;
      try {
        state = await this.desktopThreadState(activeThreadId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/target crashed/i.test(message) && baseline && crashRetries < 1) {
          crashRetries += 1;
          yield {
            type: "turn.progress",
            sessionId,
            codexThreadId: activeThreadId,
            working: true,
            reconnecting: true,
            detail: "Codex Desktop renderer crashed; restarting and retrying once.",
            elapsedMs: Date.now() - startedAt,
          };
          this.desktopTurnBaselines.delete(activeThreadId);
          await this.restartDesktop();
          const retry = await this.submitDesktopTurn(baseline.prompt, {
            model: baseline.model?.model,
            reasoning: baseline.model?.reasoning,
            cleanupBrowser: baseline.cleanupBrowser,
            newChat: true,
          });
          activeThreadId = retry.codexThreadId ?? retry.sessionId;
          baseline = this.desktopTurnBaselines.get(activeThreadId);
          sessionId = retry.sessionId;
          observedWorking = false;
          lastText = "";
          lastAnswer = "";
          lastProgressAt = Date.now();
          stablePolls = 0;
          reconnectStartedAt = undefined;
          reconnectError = "";
          yield {
            type: "turn.progress",
            sessionId,
            codexThreadId: activeThreadId,
            working: true,
            reconnecting: false,
            detail: "Codex Desktop renderer recovered; retried the turn.",
            elapsedMs: Date.now() - startedAt,
          };
          continue;
        }
        const transient = /renderer is not available|is no longer attached|was not found|bridge/i.test(message);
        if (!transient) throw error;
        reconnectStartedAt ??= Date.now();
        reconnectError = message;
        if (Date.now() - reconnectStartedAt >= reconnectGraceMs) {
          throw new Error(`Codex Desktop task ${activeThreadId} could not be reattached within ${Math.ceil(reconnectGraceMs / 1_000)} seconds: ${reconnectError}`);
        }
        if (Date.now() - lastProgressAt >= 5_000) {
          yield {
            type: "turn.progress",
            sessionId,
            codexThreadId: activeThreadId,
            working: true,
            reconnecting: true,
            detail: message,
            elapsedMs: Date.now() - startedAt,
          };
          lastProgressAt = Date.now();
        }
        await Bun.sleep(500);
        continue;
      }
      if (reconnectStartedAt !== undefined) {
        reconnectStartedAt = undefined;
        reconnectError = "";
        yield { type: "turn.progress", sessionId, codexThreadId: activeThreadId, working: state.working, reconnecting: false, elapsedMs: Date.now() - startedAt };
      }
      if (baseline && state.title) baseline.threadTitle = state.title;
      if (state.codexThreadId !== activeThreadId) {
        this.desktopTurnBaselines.delete(activeThreadId);
        activeThreadId = state.codexThreadId;
        if (baseline) this.desktopTurnBaselines.set(activeThreadId, baseline);
      }
      if (!state.selected && !state.working && (observedWorking || Date.now() - startedAt >= 5_000)) {
        if (!restoreThreadId) {
          const desktopTarget = (await this.browserTargets()).find((candidate) => candidate.id === sessionId);
          restoreThreadId = desktopTarget
            ? String(await this.cdp.evaluate(desktopTarget, `document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id') || ''`)) || undefined
            : undefined;
        }
        await this.showDesktopThread(activeThreadId);
        state = await this.desktopThreadState(activeThreadId);
      }
      for (const target of (await this.browserTargets()).filter((candidate) => /^https?:/.test(candidate.url))) {
        const existed = baseline?.browserTargets.some((candidate) => candidate.id === target.id && candidate.url === target.url);
        const key = `${target.id}:${target.url}`;
        if (!existed && !observedBrowserTargets.has(key)) {
          const observed = { id: target.id, url: target.url, title: target.title, type: target.type };
          observedBrowserTargets.set(key, observed);
          yield { type: "browser.opened", sessionId, codexThreadId: activeThreadId, target: observed };
        }
      }
      const answer = appendDesktopAnswerLinks(extractLatestAssistantAnswer(state.text), state.links ?? []);
      if (answer !== lastAnswer) {
        if (answer.startsWith(lastAnswer)) {
          const delta = answer.slice(lastAnswer.length);
          if (delta) yield { type: "response.delta", sessionId, codexThreadId: activeThreadId, delta, text: answer };
        } else if (answer) {
          yield { type: "response.snapshot", sessionId, codexThreadId: activeThreadId, text: answer };
        }
        lastAnswer = answer;
      }
      if (state.working) observedWorking = true;
      if (Date.now() - lastProgressAt >= 5_000) {
        yield { type: "turn.progress", sessionId, codexThreadId: activeThreadId, working: state.working, elapsedMs: Date.now() - startedAt };
        lastProgressAt = Date.now();
      }
      if (!state.working && state.text === lastText && state.text.length > 0) stablePolls += 1;
      else stablePolls = 0;
      lastText = state.text;
      if ((observedWorking || Date.now() - startedAt >= 5_000) && !state.working && stablePolls >= 4) {
        const preservedTargetIds = new Set(baseline?.browserTargets.map((target) => target.id) ?? []);
        const closedTargets = baseline?.cleanupBrowser
          ? await this.cleanupBrowserTabs(preservedTargetIds)
          : [];
        if (restoreThreadId && restoreThreadId !== activeThreadId) {
          await this.showDesktopThread(restoreThreadId).catch(() => undefined);
        }
        await this.ensureDesktopSidebarHidden({ required: false });
        this.desktopTurnBaselines.delete(activeThreadId);
        if (!answer.trim()) {
          throw new Error("Codex Desktop finished, but its assistant answer could not be extracted from the renderer transcript.");
        }
        yield {
          type: "turn.completed",
          sessionId,
          codexThreadId: activeThreadId,
          state: "completed",
          answer,
          text: state.text,
          model: baseline?.model,
          browser: {
            integration: "codex-desktop-built-in",
            observed: observedBrowserTargets.size > 0 || /\nComputer Use\n[\s\S]*\nBrowser\n/.test(state.text),
            targets: [...observedBrowserTargets.values()],
            closedTargets,
          },
          completedAt: new Date().toISOString(),
        };
        return;
      }
        await Bun.sleep(500);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoverableCrash = /target crashed|desktop bridge timed out|renderer is not available|is no longer attached/i.test(message);
      if (recoverableCrash && baseline && crashRetries < 1) {
        yield {
          type: "turn.progress",
          sessionId,
          codexThreadId: activeThreadId,
          working: true,
          reconnecting: true,
          detail: "Codex Desktop renderer became unavailable; restarting and retrying once.",
          elapsedMs: Date.now() - startedAt,
        };
        this.desktopTurnBaselines.delete(activeThreadId);
        await this.restartDesktop();
        const retry = await this.submitDesktopTurn(baseline.prompt, {
          model: baseline.model?.model,
          reasoning: baseline.model?.reasoning,
          cleanupBrowser: baseline.cleanupBrowser,
          newChat: true,
        });
        const retryThreadId = retry.codexThreadId ?? retry.sessionId;
        yield {
          type: "turn.progress",
          sessionId: retry.sessionId,
          codexThreadId: retryThreadId,
          working: true,
          reconnecting: false,
          detail: "Codex Desktop renderer recovered; retried the turn.",
          elapsedMs: Date.now() - startedAt,
        };
        yield* this.streamDesktopTurn(
          retryThreadId,
          Math.max(1_000, deadline - Date.now()),
          reconnectGraceMs,
          crashRetries + 1,
        );
        return;
      }
      if (baseline?.cleanupBrowser) {
        const preservedTargetIds = new Set(baseline.browserTargets.map((target) => target.id));
        await this.cleanupBrowserTabs(preservedTargetIds);
      }
      this.desktopTurnBaselines.delete(activeThreadId);
      await this.ensureDesktopSidebarHidden({ required: false }).catch(() => false);
      throw error;
    }
    if (baseline?.cleanupBrowser) {
      const preservedTargetIds = new Set(baseline.browserTargets.map((target) => target.id));
      await this.cleanupBrowserTabs(preservedTargetIds);
    }
    this.desktopTurnBaselines.delete(activeThreadId);
    await this.ensureDesktopSidebarHidden({ required: false }).catch(() => false);
    throw new Error(`Desktop turn did not complete within ${Math.round(timeoutMs / 1000)} seconds`);
  }

  async waitForDesktopTurn(codexThreadId: string, timeoutMs = 600_000): Promise<DesktopTurnResult> {
    for await (const event of this.streamDesktopTurn(codexThreadId, timeoutMs)) {
      if (event.type === "turn.completed") {
        const { type: _type, ...result } = event;
        return result;
      }
    }
    throw new Error("Desktop turn ended without a completion event");
  }

  doctor(): DoctorCheck[] {
    const isLinux = process.platform === "linux";
    const codexPath = Bun.which(this.config.codexBinary);
    const xvfbPath = Bun.which(this.config.xvfbBinary);
    const desktopExists = existsSync(this.config.desktopBinary);
    return [
      {
        id: "platform",
        label: "Linux runtime",
        status: isLinux ? "pass" : "warn",
        detail: isLinux ? `${process.platform}/${process.arch}` : `${process.platform}/${process.arch}; desktop hosting is Linux-only`,
      },
      {
        id: "codex",
        label: "Codex CLI",
        status: codexPath ? "pass" : "fail",
        detail: codexPath ?? `${this.config.codexBinary} was not found on PATH`,
      },
      {
        id: "xvfb",
        label: "Virtual display",
        status: xvfbPath ? "pass" : isLinux ? "fail" : "warn",
        detail: xvfbPath ?? `${this.config.xvfbBinary} was not found on PATH`,
      },
      {
        id: "desktop",
        label: "Codex Desktop",
        status: desktopExists ? "pass" : isLinux ? "fail" : "warn",
        detail: desktopExists ? this.config.desktopBinary : `${this.config.desktopBinary} was not found`,
      },
      {
        id: "data",
        label: "Persistent data",
        status: existsSync(this.config.dataDir) ? "pass" : "warn",
        detail: this.config.dataDir,
      },
    ];
  }

  logs(): Record<string, string[]> {
    return {
      virtualDisplay: this.virtualDisplay.logs(),
      vnc: this.vnc.logs(),
      webViewer: this.webViewer.logs(),
      desktop: this.desktop.logs(),
    };
  }
}

export function extractLatestAssistantAnswer(text: string): string {
  const markers = [...text.matchAll(/ChatGPT said:\s*/g)];
  const marker = markers.at(-1);
  if (!marker || marker.index === undefined) return "";
  const remainder = text.slice(marker.index + marker[0].length);
  const boundaries = [
    /\n+\d{1,2}:\d{2}(?:\s?[AP]M)?(?:\n|$)/i,
    /\n+Full access is on(?:\n|$)/i,
    /\n+Outputs(?:\n|$)/i,
    /\n+Computer Use(?:\n|$)/i,
  ];
  const end = boundaries
    .map((pattern) => remainder.search(pattern))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return (end === undefined ? remainder : remainder.slice(0, end)).trim();
}

export function appendDesktopAnswerLinks(
  answer: string,
  links: readonly { readonly text: string; readonly href: string }[],
): string {
  const seen = new Set<string>();
  const relevant = links.filter((link) => {
    if (!link.text || !answer.includes(link.text) || !/^https?:\/\//i.test(link.href) || seen.has(link.href)) return false;
    seen.add(link.href);
    return true;
  });
  if (relevant.length === 0) return answer;
  return [
    answer,
    "Source URLs preserved from the rendered response:",
    ...relevant.map((link) => `- ${link.text}: ${link.href}`),
  ].join("\n\n");
}
