import type { HostConfig } from "./config";
import { ensureDataDirectories } from "./config";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  CONTROL_API_VERSION,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  type TerminalThreadCleanupReport,
  type TraceIdentifiers,
  type TraceRun,
} from "./contracts";
import { fontAsset } from "./font-assets";
import { helpDocument } from "./help";
import { logoAsset } from "./logo-assets";
import { llmsText } from "./llms";
import { openApiDocument } from "./openapi";
import { operatorConsoleHtml } from "./operator-console";
import { CodexDeviceAuthService, type CodexDeviceAuth } from "./device-auth";
import { HostRuntime } from "./runtime/host-runtime";
import { TraceNotFoundError, TraceStore } from "./trace-store";

class TraceSessionUnavailableError extends Error {}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function identifiers(run: TraceRun): TraceIdentifiers {
  return { requestId: run.requestId, runId: run.id, sessionId: run.sessionId, threadId: run.threadId, turnId: run.turnId };
}

async function* tracedDesktopTurn(runtime: HostRuntime, traces: TraceStore, run: TraceRun, codexThreadId: string, timeoutMs: number): AsyncGenerator<Record<string, unknown>> {
  const ids = identifiers(run);
  try {
    for await (const event of runtime.streamDesktopTurn(codexThreadId, timeoutMs)) {
      const current = traces.getRun(run.id);
      if (!current || current.status === "completed" || current.status === "failed") return;
      const traced = { ...event, ...ids } as Record<string, unknown>;
      if (event.type === "turn.started") traces.markRunning(run.id);
      traces.appendEvent(run.id, event.type, traced);
      if (event.type === "turn.completed") traces.markCompleted(run.id, event.answer, event.completedAt);
      yield traced;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = { type: "turn.failed", ...ids, error: message, failedAt: new Date().toISOString() };
    traces.appendEvent(run.id, "turn.failed", failed);
    traces.markFailed(run.id, message, failed.failedAt);
    yield failed;
  }
}

function codexThreadIdForRun(traces: TraceStore, runId: string): string | undefined {
  for (const event of traces.getEvents(runId).toReversed()) {
    if (!event.data || typeof event.data !== "object") continue;
    const codexThreadId = (event.data as Record<string, unknown>).codexThreadId;
    if (typeof codexThreadId === "string" && codexThreadId) return codexThreadId;
  }
  return undefined;
}

function codexThreadTitleForRun(traces: TraceStore, runId: string): string | undefined {
  for (const event of traces.getEvents(runId).toReversed()) {
    if (!event.data || typeof event.data !== "object") continue;
    const codexThreadTitle = (event.data as Record<string, unknown>).codexThreadTitle;
    if (typeof codexThreadTitle === "string" && codexThreadTitle) return codexThreadTitle;
  }
  return undefined;
}

function localDesktopThreadKey(desktopThreadId: string): string | undefined {
  const match = desktopThreadId.match(/^local:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  return match?.[1]?.toLowerCase();
}

function deleteDesktopSessionFiles(dataDir: string, desktopThreadIds: readonly string[]): { deletedSessionFiles: number; reclaimedBytes: number } {
  const threadKeys = new Set(desktopThreadIds.map(localDesktopThreadKey).filter((value): value is string => Boolean(value)));
  if (threadKeys.size === 0) return { deletedSessionFiles: 0, reclaimedBytes: 0 };
  const sessionsDir = join(dataDir, "codex-home", "sessions");
  if (!existsSync(sessionsDir)) return { deletedSessionFiles: 0, reclaimedBytes: 0 };
  let deletedSessionFiles = 0;
  let reclaimedBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (![...threadKeys].some((candidate) => entry.name.endsWith(`-${candidate}.jsonl`))) continue;
      const size = statSync(path).size;
      unlinkSync(path);
      deletedSessionFiles += 1;
      reclaimedBytes += size;
    }
  };
  visit(sessionsDir);
  return { deletedSessionFiles, reclaimedBytes };
}

async function clearTerminalThreadHistory(
  config: HostConfig,
  runtime: HostRuntime,
  traces: TraceStore,
): Promise<TerminalThreadCleanupReport> {
  const candidates = traces.terminalThreads();
  const activeRuns = [
    ...traces.listRuns({ status: "accepted", limit: 10_000 }),
    ...traces.listRuns({ status: "running", limit: 10_000 }),
  ];
  if (activeRuns.length > 0) {
    return {
      clearedTraceThreads: 0,
      archivedDesktopThreads: 0,
      deletedSessionFiles: 0,
      reclaimedBytes: 0,
      protectedActiveThreads: activeRuns.length,
      unmatchedDesktopThreads: 0,
      ambiguousDesktopThreads: 0,
      failedDesktopThreads: 0,
      results: [],
    };
  }
  const results = await runtime.archiveFinishedDesktopConversations();
  const archived = results.filter((result) => result.outcome === "archived");
  const sessionFiles = deleteDesktopSessionFiles(
    config.dataDir,
    archived.flatMap((result) => result.desktopThreadId ? [result.desktopThreadId] : []),
  );
  const clearedTraceThreads = traces.deleteTerminalThreads(candidates.map((thread) => thread.id));
  return {
    clearedTraceThreads,
    archivedDesktopThreads: archived.length,
    ...sessionFiles,
    protectedActiveThreads: 0,
    unmatchedDesktopThreads: 0,
    ambiguousDesktopThreads: 0,
    failedDesktopThreads: results.filter((result) => result.outcome === "failed").length,
    results,
  };
}

async function drainTurn(events: AsyncGenerator<Record<string, unknown>>): Promise<void> {
  for await (const _event of events) {
    // Persist the background trace even when the caller does not wait.
  }
}

async function recoverInterruptedDesktopTurn(
  runtime: HostRuntime,
  traces: TraceStore,
  run: TraceRun,
  codexThreadId: string,
  remainingMs: number,
): Promise<void> {
  const reconnectTimeoutMs = Math.min(120_000, remainingMs);
  const reconnectStartedAt = new Date().toISOString();
  traces.appendEvent(run.id, "turn.reconnecting", {
    ...identifiers(run),
    codexThreadId,
    reconnectStartedAt,
    reconnectTimeoutMs,
  }, reconnectStartedAt);
  try {
    await runtime.waitForDesktopReady(reconnectTimeoutMs);
    await runtime.restoreDesktopTurn(codexThreadId, run.prompt, codexThreadTitleForRun(traces, run.id));
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    traces.appendEvent(run.id, "turn.failed", { ...identifiers(run), error: message, failedAt }, failedAt);
    traces.markFailed(run.id, message, failedAt);
    return;
  }
  const reconnectedAt = new Date().toISOString();
  traces.appendEvent(run.id, "turn.reconnected", {
    ...identifiers(run),
    codexThreadId,
    reconnectedAt,
  }, reconnectedAt);
  await drainTurn(tracedDesktopTurn(runtime, traces, run, codexThreadId, remainingMs));
}

async function waitForTurn(events: AsyncGenerator<Record<string, unknown>>): Promise<Record<string, unknown>> {
  for await (const event of events) {
    if (event.type === "turn.completed" || event.type === "turn.failed") return event;
  }
  throw new Error("Desktop turn ended without a terminal trace event");
}

function desktopTurnStream(events: AsyncGenerator<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "turn.failed",
          error: error instanceof Error ? error.message : String(error),
        })}\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export type RunningServer = {
  runtime: HostRuntime;
  traces: TraceStore;
  server: Bun.Server<undefined>;
  stop: () => Promise<void>;
};

export type ServerDependencies = {
  deviceAuth: CodexDeviceAuth;
};

export async function startServer(config: HostConfig, dependencies: Partial<ServerDependencies> = {}): Promise<RunningServer> {
  ensureDataDirectories(config);
  const traces = TraceStore.create(config.dataDir);
  const runtime = new HostRuntime(config);
  const deviceAuth = dependencies.deviceAuth ?? new CodexDeviceAuthService(
    config,
    config.desktopEnabled ? { onAuthenticated: async () => runtime.restartDesktop() } : {},
  );
  await runtime.start();
  const baseUrl = `http://${config.host}:${config.port}`;
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Desktop Browser turns can be quiet while Computer Use is navigating.
    // Keep NDJSON connections alive across those gaps.
    idleTimeout: 255,
    fetch(request) {
      const url = new URL(request.url);
      const fontMatch = request.method === "GET" ? url.pathname.match(/^\/assets\/(geist-(?:sans|mono)\.woff2)$/) : undefined;
      if (fontMatch?.[1]) {
        return fontAsset(fontMatch[1])
          .then((font) => font
            ? new Response(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength) as ArrayBuffer, { headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "font/woff2",
            } })
            : new Response(null, { status: 404 }))
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }));
      }
      if (request.method === "GET" && url.pathname === "/assets/headless-codex-logo.png") {
        return logoAsset()
          .then((logo) => logo
            ? new Response(logo.buffer.slice(logo.byteOffset, logo.byteOffset + logo.byteLength) as ArrayBuffer, { headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "image/png",
            } })
            : new Response(null, { status: 404 }))
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }));
      }
      if (request.method === "POST" && url.pathname === `/${CONTROL_API_VERSION}/auth/device`) {
        return deviceAuth.start()
          .then((login) => json({ login }))
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 }));
      }

      if (request.method === "GET" && url.pathname === `/${CONTROL_API_VERSION}/auth/device`) {
        return json({ login: deviceAuth.status() });
      }

      if (request.method === "POST" && url.pathname === `/${CONTROL_API_VERSION}/desktop/turns`) {
        return request.json()
          .then(async (body) => {
            const params = body as { prompt?: unknown; wait?: unknown; stream?: unknown; timeoutMs?: unknown; model?: unknown; reasoning?: unknown; browser?: unknown; newChat?: unknown; cleanupBrowser?: unknown; sessionId?: unknown };
            const prompt = String(params.prompt ?? "");
            const continueSessionId = params.newChat === false && typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (continueSessionId && !traces.getSession(continueSessionId)) throw new TraceNotFoundError(`Session ${continueSessionId} was not found`);
            if (continueSessionId) {
              const attachedTargetId = traces.desktopSessionId(continueSessionId);
              const attached = attachedTargetId && (await runtime.browserTargets()).some((target) => target.id === attachedTargetId);
              if (!attached) throw new TraceSessionUnavailableError(`Session ${continueSessionId} is persisted but its Desktop renderer is no longer attached; start a new chat`);
            }
            const turn = await runtime.submitDesktopTurn(prompt, {
              model: params.model === undefined ? undefined : String(params.model),
              reasoning: params.reasoning === undefined ? undefined : String(params.reasoning),
              browser: params.browser === true,
              newChat: params.newChat === undefined ? undefined : params.newChat === true,
              ...(params.cleanupBrowser === undefined
                ? {}
                : { cleanupBrowser: params.cleanupBrowser === true }),
            });
            const trace = traces.beginRun({
              prompt,
              model: turn.model.model,
              reasoning: turn.model.reasoning,
              browser: params.browser === true,
              desktopSessionId: turn.sessionId,
              continueSessionId,
              submittedAt: turn.submittedAt,
            });
            if (turn.codexThreadId) {
              traces.appendEvent(trace.id, "turn.attached", {
                ...identifiers(trace),
                codexThreadId: turn.codexThreadId,
                codexThreadTitle: turn.threadTitle,
              }, turn.submittedAt);
            }
            const requestedTimeoutMs = Number(params.timeoutMs ?? 600_000);
            const timeoutMs = Math.min(
              Math.max(Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 600_000, 1_000),
              3_600_000,
            );
            const events = tracedDesktopTurn(runtime, traces, trace, turn.codexThreadId ?? turn.sessionId, timeoutMs);
            if (params.stream === true) return desktopTurnStream(events);
            if (params.wait === true) {
              const terminal = await waitForTurn(events);
              if (terminal.type === "turn.failed") return json({ accepted: true, ...terminal }, { status: 500 });
              const { type: _type, ...result } = terminal;
              return json({ accepted: true, ...result });
            }
            void drainTurn(events);
            return json({ accepted: true, ...identifiers(trace), codexThreadId: turn.codexThreadId, status: "accepted", submittedAt: trace.submittedAt, runtime: turn.runtime, model: turn.model }, { status: 202 });
          })
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof TraceNotFoundError ? 404 : error instanceof TraceSessionUnavailableError ? 409 : 400 }));
      }
      const desktopThreadShowMatch = request.method === "POST"
        ? url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/desktop/threads/([^/]+)/show$`))
        : undefined;
      if (desktopThreadShowMatch?.[1]) {
        const codexThreadId = decodeURIComponent(desktopThreadShowMatch[1]);
        return runtime.showDesktopThread(codexThreadId)
          .then((thread) => json({ ok: true, thread }))
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 }));
      }
      if (request.method === "POST" && url.pathname === `/${CONTROL_API_VERSION}/threads/cleanup`) {
        return clearTerminalThreadHistory(config, runtime, traces)
          .then((report) => json(report))
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }));
      }
      const runCancelMatch = request.method === "POST"
        ? url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/runs/([^/]+)/cancel$`))
        : undefined;
      if (runCancelMatch?.[1]) {
        const runId = decodeURIComponent(runCancelMatch[1]);
        const run = traces.getRun(runId);
        if (!run) return json({ error: `Run ${runId} was not found` }, { status: 404 });
        if (run.status === "completed" || run.status === "failed") {
          return json({ error: `Run ${runId} is already ${run.status}`, run }, { status: 409 });
        }
        const codexThreadId = codexThreadIdForRun(traces, runId);
        if (!codexThreadId) return json({ error: `Run ${runId} has not attached a Codex Desktop task yet` }, { status: 409 });
        return runtime.cancelDesktopTurn(codexThreadId)
          .then((desktop) => {
            const cancelledAt = new Date().toISOString();
            const error = "Run cancelled by the controlling client.";
            traces.appendEvent(runId, "turn.cancelled", { ...identifiers(run), ...desktop, cancelledAt }, cancelledAt);
            traces.markFailed(runId, error, cancelledAt);
            return json({ ok: true, run: traces.getRun(runId), desktop });
          })
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }));
      }
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
      if (url.pathname === "/") return new Response(operatorConsoleHtml(config.viewerPort), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/llms.txt") return new Response(llmsText(url.origin), { headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
      if (url.pathname === "/healthz") return new Response(runtime.health().status === "failed" ? "failed\n" : "ok\n", { status: runtime.health().status === "failed" ? 503 : 200 });
      if (url.pathname === "/readyz") return new Response("ready\n");
      if (url.pathname === `/${CONTROL_API_VERSION}`) {
        return json({
          name: PRODUCT_NAME,
          version: PRODUCT_VERSION,
          resources: {
            llms: "/llms.txt",
            health: `/${CONTROL_API_VERSION}/health`,
            capabilities: `/${CONTROL_API_VERSION}/capabilities`,
            help: `/${CONTROL_API_VERSION}/help`,
            openapi: `/${CONTROL_API_VERSION}/openapi.json`,
            browserSessions: `/${CONTROL_API_VERSION}/browser/sessions`,
            browserSessionScreenshot: `/${CONTROL_API_VERSION}/browser/sessions/{sessionId}/screenshot`,
            browserSessionSnapshot: `/${CONTROL_API_VERSION}/browser/sessions/{sessionId}/snapshot`,
            authentication: `/${CONTROL_API_VERSION}/auth`,
            deviceLogin: `/${CONTROL_API_VERSION}/auth/device`,
            desktopTurns: `/${CONTROL_API_VERSION}/desktop/turns`,
            desktopTurnState: `/${CONTROL_API_VERSION}/desktop/turns/{sessionId}/state`,
            desktopThreadShow: `/${CONTROL_API_VERSION}/desktop/threads/{codexThreadId}/show`,
            threads: `/${CONTROL_API_VERSION}/threads`,
            threadCleanup: `/${CONTROL_API_VERSION}/threads/cleanup`,
            thread: `/${CONTROL_API_VERSION}/threads/{threadId}`,
            threadTurns: `/${CONTROL_API_VERSION}/threads/{threadId}/turns`,
            runs: `/${CONTROL_API_VERSION}/runs`,
            run: `/${CONTROL_API_VERSION}/runs/{runId}`,
            runEvents: `/${CONTROL_API_VERSION}/runs/{runId}/events`,
            runCancel: `/${CONTROL_API_VERSION}/runs/{runId}/cancel`,
            session: `/${CONTROL_API_VERSION}/sessions/{sessionId}`,
            logs: `/${CONTROL_API_VERSION}/logs`,
          },
        });
      }
      if (url.pathname === `/${CONTROL_API_VERSION}/health`) return json(runtime.health());
      if (url.pathname === `/${CONTROL_API_VERSION}/capabilities`) return runtime.capabilities().then(json);
      if (url.pathname === `/${CONTROL_API_VERSION}/help`) return json(helpDocument(url.searchParams.get("command") ?? undefined));
      if (url.pathname === `/${CONTROL_API_VERSION}/openapi.json`) return json(openApiDocument(baseUrl));
      if (url.pathname === `/${CONTROL_API_VERSION}/auth`) return deviceAuth.authentication().then((authentication) => json({ authentication }));
      if (url.pathname === `/${CONTROL_API_VERSION}/browser/sessions`) return runtime.browserSessions().then((sessions) => json({ sessions }));
      if (url.pathname === `/${CONTROL_API_VERSION}/threads`) return json({ threads: traces.listThreads(Number(url.searchParams.get("limit") ?? 50), Number(url.searchParams.get("offset") ?? 0)) });
      const threadTurnsMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/threads/([^/]+)/turns$`));
      if (threadTurnsMatch?.[1]) {
        const threadId = decodeURIComponent(threadTurnsMatch[1]);
        if (!traces.getThread(threadId)) return json({ error: `Thread ${threadId} was not found` }, { status: 404 });
        return json({ threadId, turns: traces.listRuns({ threadId, limit: Number(url.searchParams.get("limit") ?? 50) }) });
      }
      const threadMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/threads/([^/]+)$`));
      if (threadMatch?.[1]) {
        const thread = traces.getThread(decodeURIComponent(threadMatch[1]));
        return thread ? json({ thread }) : json({ error: "Thread not found" }, { status: 404 });
      }
      if (url.pathname === `/${CONTROL_API_VERSION}/runs`) return json({ runs: traces.listRuns({
        limit: Number(url.searchParams.get("limit") ?? 50),
        offset: Number(url.searchParams.get("offset") ?? 0),
        threadId: url.searchParams.get("threadId") ?? undefined,
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
      }) });
      const runEventsMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/runs/([^/]+)/events$`));
      if (runEventsMatch?.[1]) {
        const runId = decodeURIComponent(runEventsMatch[1]);
        if (!traces.getRun(runId)) return json({ error: `Run ${runId} was not found` }, { status: 404 });
        return json({ runId, events: traces.getEvents(runId) });
      }
      const runMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/runs/([^/]+)$`));
      if (runMatch?.[1]) {
        const run = traces.getRun(decodeURIComponent(runMatch[1]));
        return run ? json({ run }) : json({ error: "Run not found" }, { status: 404 });
      }
      const sessionMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/sessions/([^/]+)$`));
      if (sessionMatch?.[1]) {
        const session = traces.getSession(decodeURIComponent(sessionMatch[1]));
        return session ? json({ session }) : json({ error: "Session not found" }, { status: 404 });
      }
      const screenshotMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/browser/sessions/([^/]+)/screenshot$`));
      if (screenshotMatch?.[1]) {
        return runtime.browserScreenshot(decodeURIComponent(screenshotMatch[1]))
          .then((image) => new Response(image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer, { headers: { "content-type": "image/png", "cache-control": "no-store" } }))
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 }));
      }
      const snapshotMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/browser/sessions/([^/]+)/snapshot$`));
      if (snapshotMatch?.[1]) {
        return runtime.browserSnapshot(decodeURIComponent(snapshotMatch[1]))
          .then((snapshot) => json({ sessionId: decodeURIComponent(snapshotMatch[1]!), elements: snapshot }))
          .catch((error) => json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 }));
      }
      const stateMatch = url.pathname.match(new RegExp(`^/${CONTROL_API_VERSION}/desktop/turns/([^/]+)/state$`));
      if (stateMatch?.[1]) {
        const sessionId = decodeURIComponent(stateMatch[1]);
        const desktopSessionId = traces.desktopSessionId(sessionId);
        if (!desktopSessionId) return json({ error: `Session ${sessionId} was not found` }, { status: 404 });
        return runtime.desktopTurnState(desktopSessionId)
          .then((state) => json({ sessionId, live: true, ...state }))
          .catch(() => {
            const session = traces.getSession(sessionId)!;
            const latest = session.runs[0];
            return json({
              sessionId,
              live: false,
              working: latest?.status === "accepted" || latest?.status === "running",
              status: latest?.status,
              text: latest?.response ?? latest?.error ?? "",
              title: "Persisted trace",
              testIds: [],
            });
          });
      }
      const viewerMatch = url.pathname.match(/^\/viewer\/([^/]+)$/);
      if (viewerMatch?.[1]) {
        const id = encodeURIComponent(decodeURIComponent(viewerMatch[1]));
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Codex Browser Viewer</title><style>html,body{height:100%;margin:0;background:#090b0d;color:#e7e9ea;font:14px system-ui,sans-serif}body{display:grid;grid-template-rows:auto 1fr}header{display:flex;justify-content:space-between;padding:12px 16px;background:#13171a;border-bottom:1px solid #2b3237}img{width:100%;height:100%;object-fit:contain;min-height:0}.live{color:#8fe8b8}</style></head><body><header><strong>Codex Browser Viewer</strong><span class="live">Live · 1 fps</span></header><img id="frame" alt="Hosted browser session"><script>const frame=document.getElementById('frame');const refresh=()=>{frame.src='/${CONTROL_API_VERSION}/browser/sessions/${id}/screenshot?t='+Date.now()};frame.addEventListener('load',()=>setTimeout(refresh,1000));frame.addEventListener('error',()=>setTimeout(refresh,2000));refresh()</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (url.pathname === `/${CONTROL_API_VERSION}/logs`) return json(runtime.logs());
      return json({ error: "not_found" }, { status: 404 });
    },
  });

  const interruptedRuns = [
    ...traces.listRuns({ status: "accepted", limit: 10_000 }),
    ...traces.listRuns({ status: "running", limit: 10_000 }),
  ];
  for (const interrupted of interruptedRuns) {
    const codexThreadId = codexThreadIdForRun(traces, interrupted.id);
    if (!codexThreadId) {
      const failedAt = new Date().toISOString();
      const error = "Headless Codex restarted before this run attached a durable Codex Desktop task ID.";
      traces.appendEvent(interrupted.id, "turn.failed", { ...identifiers(interrupted), error, failedAt }, failedAt);
      traces.markFailed(interrupted.id, error, failedAt);
      continue;
    }
    const elapsedMs = Math.max(0, Date.now() - Date.parse(interrupted.submittedAt));
    const remainingMs = Math.max(1_000, 3_600_000 - elapsedMs);
    void recoverInterruptedDesktopTurn(runtime, traces, interrupted, codexThreadId, remainingMs);
  }

  return {
    runtime,
    traces,
    server,
    stop: async () => {
      server.stop(true);
      await deviceAuth.stop();
      await runtime.stop();
      traces.close();
    },
  };
}
