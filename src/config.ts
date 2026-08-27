import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostConfig = {
  host: string;
  port: number;
  dataDir: string;
  workspaceRoot: string;
  codexBinary: string;
  desktopEnabled: boolean;
  desktopBinary: string;
  desktopBridgePort: number;
  display: string;
  xvfbBinary: string;
  viewport: string;
  viewerEnabled: boolean;
  viewerPort: number;
  viewerHost: string;
  vncPort: number;
  x11vncBinary: string;
  websockifyBinary: string;
  noVncWebRoot: string;
};

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function defaultDataDir(): string {
  if (process.env.HEADLESS_CODEX_DATA_DIR) return process.env.HEADLESS_CODEX_DATA_DIR;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "headless-codex");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "headless-codex");
}

export function loadConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  const config: HostConfig = {
    host: process.env.HEADLESS_CODEX_HOST ?? "127.0.0.1",
    port: Number(process.env.HEADLESS_CODEX_PORT ?? "4580"),
    dataDir,
    workspaceRoot: process.env.HEADLESS_CODEX_WORKSPACE_ROOT ?? process.cwd(),
    codexBinary: process.env.HEADLESS_CODEX_CODEX_BINARY ?? "codex",
    desktopEnabled: envBoolean("HEADLESS_CODEX_DESKTOP", process.platform === "linux"),
    desktopBinary: process.env.HEADLESS_CODEX_DESKTOP_BINARY ?? "/usr/bin/chatgpt",
    desktopBridgePort: Number(process.env.HEADLESS_CODEX_DESKTOP_BRIDGE_PORT ?? "9222"),
    display: process.env.HEADLESS_CODEX_DISPLAY ?? ":99",
    xvfbBinary: process.env.HEADLESS_CODEX_XVFB_BINARY ?? "Xvfb",
    viewport: process.env.HEADLESS_CODEX_VIEWPORT ?? "1440x900x24",
    viewerEnabled: envBoolean("HEADLESS_CODEX_INTERACTIVE_VIEWER", false),
    viewerPort: Number(process.env.HEADLESS_CODEX_VIEWER_PORT ?? "6080"),
    viewerHost: process.env.HEADLESS_CODEX_VIEWER_HOST ?? "127.0.0.1",
    vncPort: Number(process.env.HEADLESS_CODEX_VNC_PORT ?? "5900"),
    x11vncBinary: process.env.HEADLESS_CODEX_X11VNC_BINARY ?? "x11vnc",
    websockifyBinary: process.env.HEADLESS_CODEX_WEBSOCKIFY_BINARY ?? "websockify",
    noVncWebRoot: process.env.HEADLESS_CODEX_NOVNC_WEB_ROOT ?? "/usr/share/novnc",
    ...overrides,
  };

  for (const [name, port] of [
    ["control", config.port],
    ["desktop bridge", config.desktopBridgePort],
    ["viewer", config.viewerPort],
    ["VNC", config.vncPort],
  ] as const) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid ${name} port: ${port}`);
    }
  }
  return config;
}

export function ensureDataDirectories(config: HostConfig): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(config.dataDir, "browser"), { recursive: true, mode: 0o700 });
  mkdirSync(join(config.dataDir, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(config.dataDir, "artifacts"), { recursive: true, mode: 0o700 });
}
