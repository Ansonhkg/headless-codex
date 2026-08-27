import { CONTROL_API_VERSION, PRODUCT_VERSION } from "./contracts";

export function llmsText(origin: string): string {
  const baseUrl = origin.replace(/\/$/, "");
  return `# Headless Codex

> Headless Codex ${PRODUCT_VERSION} runs Codex Desktop on Linux and exposes its built-in Browser, durable traces, and control surface over HTTP.

Base URL: ${baseUrl}
API version: ${CONTROL_API_VERSION}

## Start here

Set the URL of the single local worker:

\`\`\`sh
export HEADLESS_CODEX_URL="${baseUrl}"
\`\`\`

Confirm the worker is reachable, then discover its live capabilities and API contract:

\`\`\`sh
curl --fail-with-body -sS "$HEADLESS_CODEX_URL/healthz"
curl --fail-with-body -sS "$HEADLESS_CODEX_URL/${CONTROL_API_VERSION}/capabilities"
curl --fail-with-body -sS "$HEADLESS_CODEX_URL/${CONTROL_API_VERSION}/openapi.json"
\`\`\`

## Run one Codex Desktop task

This waits for the final response and enables the Codex Desktop built-in Browser:

\`\`\`sh
curl --fail-with-body -sS \\
  -H "Content-Type: application/json" \\
  -X POST "$HEADLESS_CODEX_URL/${CONTROL_API_VERSION}/desktop/turns" \\
  --data '{"prompt":"Open https://example.com and report its page title.","browser":true,"wait":true}'
\`\`\`

The response contains \`requestId\`, \`runId\`, \`sessionId\`, \`threadId\`, \`turnId\`, and the answer. The default execution profile is \`gpt-5.6-luna\` with reasoning \`xhigh\`. Override it with \`model\` and \`reasoning\` in the JSON body.

For incremental newline-delimited JSON events, replace \`"wait":true\` with \`"stream":true\` and add \`-N\` to curl.

## Continue or inspect

- Continue the attached Desktop conversation: POST \`/${CONTROL_API_VERSION}/desktop/turns\` with \`{"prompt":"...","newChat":false,"sessionId":"ses_...","wait":true}\`.
- Inspect one run: GET \`/${CONTROL_API_VERSION}/runs/{runId}\`.
- Read its ordered events: GET \`/${CONTROL_API_VERSION}/runs/{runId}/events\`.
- List durable threads: GET \`/${CONTROL_API_VERSION}/threads\`.

A session remains traceable after restart, but continuation returns HTTP 409 when its original Desktop renderer is no longer attached; start a new chat in that case. Keep the service bound to the local machine because the control API has no authentication layer.

## Live documentation

- Agent/CLI help: ${baseUrl}/${CONTROL_API_VERSION}/help
- OpenAPI 3.1: ${baseUrl}/${CONTROL_API_VERSION}/openapi.json
- API discovery: ${baseUrl}/${CONTROL_API_VERSION}
- API console and live Desktop: ${baseUrl}/

Prefer the live OpenAPI document over assumptions. Check HTTP status codes, preserve returned trace IDs, and do not silently approve pending actions.
`;
}
