export const PRODUCT_NAME = "headless-codex";
export const PRODUCT_VERSION = "0.1.0";
export const CONTROL_API_VERSION = "v1";

export type TraceRunStatus = "accepted" | "running" | "completed" | "failed";

export type TraceIdentifiers = {
  requestId: string;
  runId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
};

export type TraceRun = {
  id: string;
  requestId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  status: TraceRunStatus;
  prompt: string;
  model: string;
  reasoning: string;
  browser: boolean;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  response?: string;
  error?: string;
  codexThreadId?: string;
  lastEventAt?: string;
  lastEventSequence?: number;
};

export type TraceEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  createdAt: string;
  data: unknown;
};

export type TraceSession = {
  id: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
};

export type TraceThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastStatus?: TraceRunStatus;
};

/** A persisted trace that is eligible for terminal-history cleanup. */
export type TerminalTraceThread = TraceThread & {
  desktopThreadIds: string[];
};

export type DesktopThreadCleanupCandidate = {
  traceThreadId: string;
  title: string;
  desktopThreadIds: string[];
};

export type DesktopThreadCleanupResult = {
  traceThreadId: string;
  desktopThreadId?: string;
  outcome: "archived" | "active" | "unmatched" | "ambiguous" | "failed";
  detail?: string;
};

export type TerminalThreadCleanupReport = {
  clearedTraceThreads: number;
  archivedDesktopThreads: number;
  deletedSessionFiles: number;
  reclaimedBytes: number;
  protectedActiveThreads: number;
  unmatchedDesktopThreads: number;
  ambiguousDesktopThreads: number;
  failedDesktopThreads: number;
  results: DesktopThreadCleanupResult[];
};

export type ProcessState = {
  name: string;
  state: "disabled" | "stopped" | "starting" | "running" | "failed";
  pid?: number;
  command?: string[];
  error?: string;
};

export type CapabilityReport = {
  healthy: boolean;
  service: "online" | "offline";
  capabilities: {
    codex: boolean;
    browser: boolean;
    browserLiveView: boolean;
    screenshots: boolean;
    persistentProfiles: boolean;
  };
  browser: {
    integration: "desktop-native";
    state: "disabled" | "unavailable" | "hosted" | "ready";
    reason?: string;
  };
  protocols: { controlApi: string };
};

export type HealthReport = {
  status: "ok" | "degraded" | "failed";
  version: string;
  uptimeSeconds: number;
  startedAt: string;
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
    display?: string;
  };
  machine: {
    hostname: string;
    operatingSystem: string;
    kernel: string;
    arch: string;
    logicalCpus: number;
    memory: { totalBytes: number; freeBytes: number };
    storage?: { path: string; totalBytes: number; freeBytes: number };
    uptimeSeconds: number;
    container: { detected: boolean; runtime?: "docker" | "podman" | "container"; id?: string };
  };
  processes: ProcessState[];
};

export type BrowserSession = {
  id: string;
  state: "starting" | "ready" | "closed";
  threadId?: string;
  turnId?: string;
  url?: string;
  title?: string;
  createdAt: string;
  targetType?: string;
};

export type DoctorCheck = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};
