import { CONTROL_API_VERSION, PRODUCT_VERSION } from "./contracts";

const objectSchema = { type: "object" } as const;
const errorSchema = { type: "object", required: ["error"], properties: { error: { type: "string" } } } as const;

function jsonResponse(description: string, schema: object = objectSchema): object {
  return { description, content: { "application/json": { schema } } };
}

function binaryResponse(description: string, contentType: string): object {
  return { description, content: { [contentType]: { schema: { type: "string", contentEncoding: "binary" } } } };
}

function textResponse(description: string): object {
  return { description, content: { "text/plain": { schema: { type: "string" } } } };
}

function errorResponse(description: string): object {
  return jsonResponse(description, errorSchema);
}

export function openApiDocument(baseUrl = "http://127.0.0.1:4580"): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "Headless Codex Control API",
      version: PRODUCT_VERSION,
      description: "Control and inspect the single local Headless Codex Desktop worker.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/llms.txt": {
        get: { operationId: "getLlmsText", summary: "Get the public agent bootstrap guide", security: [], responses: { "200": textResponse("Agent-readable Headless Codex usage guide") } },
      },
      [`/${CONTROL_API_VERSION}`]: {
        get: { operationId: "discover", summary: "Discover API resources", responses: { "200": jsonResponse("API discovery document") } },
      },
      [`/${CONTROL_API_VERSION}/health`]: {
        get: { operationId: "getHealth", summary: "Get service health", responses: { "200": jsonResponse("Service health") } },
      },
      [`/${CONTROL_API_VERSION}/capabilities`]: {
        get: { operationId: "getCapabilities", summary: "Get runtime capabilities", responses: { "200": jsonResponse("Capability report") } },
      },
      [`/${CONTROL_API_VERSION}/help`]: {
        get: { operationId: "getHelp", summary: "Get machine-readable CLI help", responses: { "200": jsonResponse("Command tree") } },
      },
      [`/${CONTROL_API_VERSION}/openapi.json`]: {
        get: { operationId: "getOpenApi", summary: "Get the OpenAPI 3.1 schema", responses: { "200": jsonResponse("OpenAPI document") } },
      },
      [`/${CONTROL_API_VERSION}/auth`]: {
        get: { operationId: "getAuthentication", summary: "Get redacted Codex authentication status", responses: { "200": jsonResponse("Authentication status; never includes credentials") } },
      },
      [`/${CONTROL_API_VERSION}/auth/device`]: {
        get: { operationId: "getDeviceLogin", summary: "Get the current Codex device-login state", responses: { "200": jsonResponse("Current device-login state") } },
        post: { operationId: "startDeviceLogin", summary: "Start Codex device authorization without opening the desktop viewer", responses: { "200": jsonResponse("Short-lived OpenAI verification URL and user code"), "503": errorResponse("Device login could not be started") } },
      },
      [`/${CONTROL_API_VERSION}/browser/sessions`]: {
        get: { operationId: "listBrowserSessions", summary: "List browser sessions", responses: { "200": jsonResponse("Browser sessions") } },
      },
      [`/${CONTROL_API_VERSION}/browser/sessions/{sessionId}/screenshot`]: {
        get: {
          operationId: "captureBrowserSession",
          summary: "Capture a mediated browser screenshot",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": binaryResponse("PNG screenshot", "image/png"), "404": errorResponse("Session unavailable") },
        },
      },
      [`/${CONTROL_API_VERSION}/browser/sessions/{sessionId}/snapshot`]: {
        get: {
          operationId: "inspectBrowserSession",
          summary: "Inspect visible interactive elements",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResponse("Visible interactive element snapshot"), "404": errorResponse("Session unavailable") },
        },
      },
      [`/${CONTROL_API_VERSION}/desktop/turns`]: {
        post: {
          operationId: "submitDesktopTurn",
          summary: "Submit a turn to the native Codex Desktop renderer",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["prompt"], properties: {
            prompt: { type: "string" },
            browser: { type: "boolean", description: "Require the Codex Desktop built-in Browser" },
            cleanupBrowser: { type: "boolean", description: "Close browser tabs opened by this turn after completion; defaults to browser" },
            newChat: { type: "boolean", description: "Start a new Desktop conversation before submitting", default: true },
            sessionId: { type: "string", description: "Stable session to continue when newChat is false", pattern: "^ses_[a-f0-9]{32}$" },
            stream: { type: "boolean", description: "Stream NDJSON Desktop turn events" },
            model: { type: "string", default: "gpt-5.6-luna" },
            reasoning: { type: "string", enum: ["light", "medium", "high", "xhigh", "max", "ultra"], default: "xhigh" },
            wait: { type: "boolean", default: true },
            timeoutMs: { type: "integer" },
          } } } } },
          responses: {
            "200": { description: "Completed result or Desktop turn event stream", content: {
              "application/json": { schema: objectSchema },
              "application/x-ndjson": { schema: { type: "string" } },
            } },
            "202": jsonResponse("Turn accepted by the desktop renderer"),
            "400": errorResponse("Desktop, request, or composer unavailable"),
            "409": errorResponse("Persisted session is no longer attached to its Desktop renderer"),
            "404": errorResponse("Requested continuation session was not found"),
            "500": errorResponse("Turn failed while waiting for completion"),
          },
        },
      },
      [`/${CONTROL_API_VERSION}/desktop/turns/{sessionId}/state`]: {
        get: {
          operationId: "getDesktopTurnState",
          summary: "Read current native desktop conversation state",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResponse("Desktop conversation state"), "404": errorResponse("Desktop session unavailable") },
        },
      },
      [`/${CONTROL_API_VERSION}/desktop/threads/{codexThreadId}/show`]: {
        post: {
          operationId: "showDesktopThread",
          summary: "Switch the shared Codex Desktop to a specific Codex task",
          parameters: [{
            name: "codexThreadId",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          responses: {
            "200": { description: "Desktop switched to the requested Codex task", content: { "application/json": { schema: objectSchema } } },
            "404": errorResponse("Codex Desktop task not found"),
          },
        },
      },
      [`/${CONTROL_API_VERSION}/threads`]: {
        get: {
          operationId: "listThreads",
          summary: "List durable Codex conversation threads",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 10000, default: 50 } }, { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } }],
          responses: { "200": jsonResponse("Threads ordered by most recent activity") },
        },
      },
      [`/${CONTROL_API_VERSION}/threads/cleanup`]: {
        post: {
          operationId: "clearTerminalThreadHistory",
          summary: "Archive matched completed or failed Desktop conversations and clear their local history",
          responses: {
            "200": jsonResponse("Cleanup result; active and ambiguous conversations are retained"),
            "409": errorResponse("Desktop cleanup could not be completed safely"),
          },
        },
      },
      [`/${CONTROL_API_VERSION}/threads/{threadId}`]: {
        get: {
          operationId: "getThread",
          summary: "Inspect a durable thread with its sessions and runs",
          parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string", pattern: "^thr_[a-f0-9]{32}$" } }],
          responses: { "200": jsonResponse("Thread trace"), "404": errorResponse("Thread not found") },
        },
      },
      [`/${CONTROL_API_VERSION}/threads/{threadId}/turns`]: {
        get: {
          operationId: "listThreadTurns",
          summary: "List traced turns within a thread",
          parameters: [
            { name: "threadId", in: "path", required: true, schema: { type: "string", pattern: "^thr_[a-f0-9]{32}$" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 10000, default: 50 } },
          ],
          responses: { "200": jsonResponse("Thread turns"), "404": errorResponse("Thread not found") },
        },
      },
      [`/${CONTROL_API_VERSION}/runs`]: {
        get: {
          operationId: "listRuns",
          summary: "List durable agent execution traces",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 10000, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "threadId", in: "query", schema: { type: "string" } },
            { name: "sessionId", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string", enum: ["accepted", "running", "completed", "failed"] } },
          ],
          responses: { "200": jsonResponse("Execution traces ordered by submission time") },
        },
      },
      [`/${CONTROL_API_VERSION}/runs/{runId}`]: {
        get: {
          operationId: "getRun",
          summary: "Inspect one durable agent execution trace",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", pattern: "^run_[a-f0-9]{32}$" } }],
          responses: { "200": jsonResponse("Execution trace"), "404": errorResponse("Run not found") },
        },
      },
      [`/${CONTROL_API_VERSION}/runs/{runId}/events`]: {
        get: {
          operationId: "listRunEvents",
          summary: "Read the ordered event timeline for a run",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", pattern: "^run_[a-f0-9]{32}$" } }],
          responses: { "200": jsonResponse("Ordered run events"), "404": errorResponse("Run not found") },
        },
      },
      [`/${CONTROL_API_VERSION}/runs/{runId}/cancel`]: {
        post: {
          operationId: "cancelRun",
          summary: "Cancel an active durable run and its Codex Desktop task",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", pattern: "^run_[a-f0-9]{32}$" } }],
          responses: {
            "200": jsonResponse("Run cancelled"),
            "404": errorResponse("Run not found"),
            "409": errorResponse("Run is terminal, unattached, or could not be cancelled"),
          },
        },
      },
      [`/${CONTROL_API_VERSION}/sessions/{sessionId}`]: {
        get: {
          operationId: "getSession",
          summary: "Inspect a stable runtime session and its runs",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string", pattern: "^ses_[a-f0-9]{32}$" } }],
          responses: { "200": jsonResponse("Session trace"), "404": errorResponse("Session not found") },
        },
      },
      [`/${CONTROL_API_VERSION}/logs`]: {
        get: { operationId: "getLogs", summary: "Read supervised runtime logs", responses: { "200": jsonResponse("Per-process log tails") } },
      },
      ["/viewer/{sessionId}"]: {
        get: {
          operationId: "getBrowserViewer",
          summary: "Open the mediated browser screenshot viewer",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Browser viewer", content: { "text/html": { schema: { type: "string" } } } } },
        },
      },
    },
  };
}
