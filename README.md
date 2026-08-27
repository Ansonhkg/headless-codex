# Headless Codex

`headless-codex` runs the official Linux Codex Desktop app on a virtual display and exposes it as a deployable headless agent. Browser turns go through Codex mode in Desktop so the agent can use the same built-in Browser and Computer Use capabilities as the visible app.

This distinction is intentional: the Codex CLI does not provide the Desktop built-in Browser. Non-browser turns may use `codex exec`, while `run --browser` and `chat --browser` submit turns to Codex Desktop.

## API discovery

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/llms.txt` | Agent-readable bootstrap guide |
| `GET` | `/v1` | API resource index |
| `GET` | `/v1/help` | Machine-readable command help |
| `GET` | `/v1/health` | Worker and managed-process health |
| `GET` | `/v1/capabilities` | Available runtime capabilities |
| `GET` | `/v1/openapi.json` | Live OpenAPI 3.1 contract |
| `GET` | `/v1/browser/sessions` | Active browser sessions |
| `GET` | `/v1/browser/sessions/{id}/screenshot` | Browser-session screenshot |
| `GET` | `/v1/browser/sessions/{id}/snapshot` | Visible browser elements |
| `POST` | `/v1/desktop/turns` | Start a Codex Desktop turn |
| `GET` | `/v1/desktop/turns/{id}/state` | Inspect a Desktop turn |
| `GET` | `/v1/threads` | List durable threads |
| `GET` | `/v1/threads/{threadId}` | Inspect a durable thread |
| `GET` | `/v1/threads/{threadId}/turns` | List turns in a thread |
| `GET` | `/v1/runs` | List execution runs |
| `GET` | `/v1/runs/{runId}` | Inspect an execution run |
| `GET` | `/v1/runs/{runId}/events` | Read ordered run events |
| `GET` | `/v1/sessions/{sessionId}` | Inspect a runtime session |
| `GET` | `/v1/logs` | Read managed-process logs |

The interactive API console is served at `/`, and the complete live contract is always available from `/v1/openapi.json`.

## Use other inference providers with Shimex

Pair Headless Codex with [Shimex](https://github.com/Ansonhkg/shimex) to use hosted APIs, local model servers, OpenAI-compatible endpoints, and supported authenticated CLI providers inside Codex Desktop. Shimex creates a managed Codex copy pointed at its local gateway while leaving the original app untouched.

## Current milestone

The repository currently contains a working Linux vertical slice:

- self-describing human and JSON CLI help
- foreground and background service lifecycle
- Linux Xvfb and `/usr/bin/chatgpt` supervision
- health, capability, logs, discovery, and OpenAPI endpoints
- a split API console and live Desktop viewer
- a loopback-only control bridge to the Codex Desktop renderer
- browser screenshots, visible-element snapshots, and a live screenshot viewer
- Desktop model/effort selection with fail-closed verification
- built-in Browser turns through `run --browser`
- interactive Desktop Browser sessions through `chat --browser`
- Docker image assembly from an official Linux `.deb`

The Linux E2E test selected **5.6 Luna / Extra High** in Codex Desktop, invoked Computer Use and the built-in Browser, opened `https://example.com`, and returned `Example Domain`. The result metadata identified `codex-desktop-built-in`; no raw `/json/new` page creation or custom browser MCP was involved.

## Requirements

- Bun 1.3 or newer
- Codex CLI
- Linux for native desktop hosting
- The official `chatgpt` Debian package installed at `/usr/bin/chatgpt`
- Xvfb on Linux

The official package can be installed with your system package manager. Its executable is `/usr/bin/chatgpt`, with application resources under `/usr/lib/chatgpt`.

## Install

```bash
make install
make verify
make build
```

## Discover the CLI

Human-readable help:

```bash
make help
bun run src/cli.ts help browser
bun run src/cli.ts help run
```

Machine-readable help for an agent:

```bash
bun run src/cli.ts help --json
bun run src/cli.ts api schema
```

## Run locally

On macOS, run the API without the Linux desktop host:

```bash
bun run src/cli.ts serve --no-desktop
```

On a Linux host with ChatGPT Desktop and Xvfb installed:

```bash
bun run src/cli.ts setup
bun run src/cli.ts serve
```

Then inspect it:

```bash
bun run src/cli.ts status --json
bun run src/cli.ts capabilities --json
curl -fsS http://127.0.0.1:4580/v1
```

The split API console and live Codex Desktop viewer are available at [http://127.0.0.1:4580](http://127.0.0.1:4580).

Give an agent the public, host-aware bootstrap guide:

```bash
curl -fsS http://127.0.0.1:4580/llms.txt
```

It explains authentication, the first browser-enabled request, streaming,
session continuation, durable trace lookup, and links to the live
OpenAPI and help documents.

Run one Codex turn with the headless browser:

```bash
bun run src/cli.ts run --browser \
  "Open https://example.com and report its page title."
```

The default execution profile is **Luna Extra High**: model `gpt-5.6-luna` with
reasoning effort `xhigh`.

Or open an interactive terminal chat backed by Codex Desktop:

```bash
bun run src/cli.ts chat --browser
```

`run --browser` streams the assistant text as Codex Desktop generates it. Add `--jsonl` to stream machine-readable events such as `turn.started`, `turn.progress`, `browser.opened`, `response.delta`, and `turn.completed`. Desktop displays reasoning `xhigh` as **Extra High**.

Override the Codex model and reasoning effort when needed:

```bash
bun run src/cli.ts run --browser \
  --model gpt-5.6-sol \
  --reasoning light \
  "Open https://example.com and inspect it."
```

## Container deployment

Build from the official `.deb` you downloaded:

```bash
make image \
  CHATGPT_DEB="$HOME/Downloads/chatgpt-codex-desktop-linux-amd64-26.803.81509.deb"
```

The builder detects `amd64` or `arm64`, compiles the matching standalone binary, and builds the matching Docker platform.

Run it with persistent authentication/browser state and loopback-only host ports:

```bash
docker volume create headless-codex-data

docker run --rm --name headless-codex \
  --shm-size=1g \
  -p 127.0.0.1:4580:4580 \
  -p 127.0.0.1:6080:6080 \
  -v headless-codex-data:/data \
  -v "$PWD:/workspace" \
  headless-codex:local
```

The 1 GB shared-memory allocation is required for Electron browser renderer
processes. Docker's 64 MB default can make media-heavy sites crash even when
the container has plenty of ordinary RAM available.

The worker is designed for one machine and does not require API authentication. Keep both published ports bound to `127.0.0.1` as shown above.

The official package does not include Electron's `chrome-sandbox` helper, and Docker normally blocks its unprivileged-user-namespace fallback. The container launch wrapper therefore uses `--no-sandbox`; the app still runs as the dedicated non-root `codex` user, so treat the container itself as the security boundary and do not add broad host mounts.

`codex login status` may say `Logged in using ChatGPT`. That describes the account authentication method. Browser runs verify that Desktop is in **Codex** mode and verify the requested model before sending the prompt. The Desktop accessibility transcript may internally use the generic phrase `ChatGPT said`; `headless-codex` does not expose that shell label in CLI results.

For the first sign-in, prefer the authenticated device-login API: `POST /v1/auth/device` returns the OpenAI verification URL and a short-lived code. Complete that code in your own browser; Codex writes the resulting credential directly into the container's persistent `/data/codex-home` store, and the API never returns the credential. When sign-in completes, the managed Codex Desktop restarts automatically and reloads that same credential. Use `GET /v1/auth/device` to check completion. noVNC remains available only as a desktop troubleshooting fallback at `http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale`; keep that viewer port loopback-only or behind an authenticated reverse proxy.

## Background service

```bash
bun run src/cli.ts start
bun run src/cli.ts status
bun run src/cli.ts logs
bun run src/cli.ts stop
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HEADLESS_CODEX_HOST` | `127.0.0.1` | Control API bind host |
| `HEADLESS_CODEX_PORT` | `4580` | Control API port |
| `HEADLESS_CODEX_DATA_DIR` | platform data directory | Persistent state |
| `CODEX_HOME` | platform default | Codex authentication and configuration; the container sets `/data/codex-home` |
| `HEADLESS_CODEX_CODEX_BINARY` | `codex` | Codex CLI executable; the container uses the binary bundled with Desktop |
| `HEADLESS_CODEX_MODEL` | `gpt-5.6-luna` | Default Codex model |
| `HEADLESS_CODEX_REASONING` | `xhigh` | Default reasoning effort |
| `HEADLESS_CODEX_WORKSPACE_ROOT` | current directory | Default workspace root |
| `HEADLESS_CODEX_DESKTOP` | `true` on Linux | Supervise Xvfb and Desktop |
| `HEADLESS_CODEX_DESKTOP_BINARY` | `/usr/bin/chatgpt` | Desktop executable |
| `HEADLESS_CODEX_DESKTOP_BRIDGE_PORT` | `9222` | Loopback-only mediated desktop bridge |
| `HEADLESS_CODEX_DISPLAY` | `:99` | Virtual X display |
| `HEADLESS_CODEX_VIEWPORT` | `1440x900x24` | Virtual screen |
| `HEADLESS_CODEX_INTERACTIVE_VIEWER` | `false` | Start loopback-only noVNC for login and human takeover |
| `HEADLESS_CODEX_VIEWER_PORT` | `6080` | noVNC viewer port |
| `HEADLESS_CODEX_VIEWER_HOST` | `127.0.0.1` | noVNC bind host; the container uses `0.0.0.0` behind loopback port publishing |

The control API has no authentication layer and should remain loopback-only. The X server is always started with `-nolisten tcp`.

The container entrypoint enforces these user-level settings in
`/data/codex-home/config.toml` on every start:

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
default_permissions = ":danger-full-access"
```

This disables command and tool approval prompts and removes Codex's local command sandbox.
Only mount directories the agent is intentionally allowed to access.

### Durable traces

Every Desktop request receives five stable identifiers and is persisted in
`/data/traces.sqlite`:

```json
{
  "requestId": "req_...",
  "runId": "run_...",
  "sessionId": "ses_...",
  "threadId": "thr_...",
  "turnId": "turn_..."
}
```

Use `runId` for one execution trace, `sessionId` for a resumable runtime
session, and `threadId` for the durable conversation. Continue a session by
posting `{"newChat":false,"sessionId":"ses_..."}` with the next prompt.
Continuation is accepted only while that session's Desktop renderer is still
attached. After a worker restart the durable trace remains readable, but the
API returns `409` rather than silently attaching the request to another chat.
These CLI commands inspect the same store:

```bash
headless-codex thread list --json
headless-codex thread show THREAD_ID --json
headless-codex trace inspect RUN_ID --json
headless-codex trace events RUN_ID --json
headless-codex session inspect SESSION_ID --json
```

Prompts, responses, model selection, status, timestamps, and ordered events
are stored as sensitive operational data. Keep the `/data` volume private and
apply an appropriate retention policy before exposing the service broadly.

The same command registry generates terminal help and `/v1/help`, preventing agent documentation from drifting away from the actual CLI.

Commands whose contract is defined but whose runtime bridge is not connected are marked `status: "contract"` in JSON help and `[bridge pending]` in terminal help. Agents can discover the intended surface without mistaking it for an available capability.

## Architecture

```text
Human / Agent / Web client
           │
    headless-codex
      ├── Non-browser turns → Codex CLI (`codex exec` / TUI)
      ├── Browser turns → Codex Desktop composer
      │                       └── built-in Browser / Computer Use
      ├── Control API
      └── Linux supervisor → Xvfb + Codex Desktop
```

The raw Desktop debugging endpoint stays on container loopback and is used only to operate and inspect the Desktop UI. Agent browsing is initiated by Codex Desktop itself. The project does not expose raw CDP page creation and does not inject a custom browser MCP into Codex.
