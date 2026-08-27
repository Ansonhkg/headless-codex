#!/usr/bin/env bun
import { spawn as spawnDetached } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { commandSpecs, publicCommandSpecs } from "./command-spec";
import { ensureDataDirectories, loadConfig, type HostConfig } from "./config";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./contracts";
import { findCommandSpec, helpDocument, renderHelp } from "./help";
import { openApiDocument } from "./openapi";
import { HostRuntime } from "./runtime/host-runtime";
import { startServer } from "./server";

type ParsedArgs = {
  raw: string[];
  command: string;
  rest: string[];
  json: boolean;
  jsonl: boolean;
};

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

function has(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function value(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[], valueFlags: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const name = arg.split("=", 1)[0] ?? arg;
      if (!arg.includes("=") && valueFlags.includes(name)) index += 1;
      continue;
    }
    output.push(arg);
  }
  return output;
}

function parse(argv: string[]): ParsedArgs {
  const raw = [...argv];
  const words = positional(raw, ["--server", "--timeout"]);
  const first = words[0] ?? "help";
  const nestedRoots = new Set(["thread", "browser", "auth", "api", "trace", "session"]);
  const command = nestedRoots.has(first) && words[1] ? `${first} ${words[1]}` : first;
  const commandWords = command.split(" ").length;
  const located: string[] = [];
  let seenWords = 0;
  for (const arg of raw) {
    if (seenWords < commandWords && !arg.startsWith("--")) {
      seenWords += 1;
      continue;
    }
    located.push(arg);
  }
  return { raw, command, rest: located, json: has(raw, "--json"), jsonl: has(raw, "--jsonl") };
}

function configFromArgs(args: string[]): HostConfig {
  const overrides: Partial<HostConfig> = {};
  const host = value(args, "--host");
  const port = value(args, "--port");
  const dataDir = value(args, "--data-dir");
  const workspaceRoot = value(args, "--workspace-root");
  if (host) overrides.host = host;
  if (port) overrides.port = Number(port);
  if (dataDir) overrides.dataDir = dataDir;
  if (workspaceRoot) overrides.workspaceRoot = workspaceRoot;
  if (has(args, "--no-desktop")) overrides.desktopEnabled = false;
  return loadConfig(overrides);
}

function print(data: unknown, jsonMode = false): void {
  if (jsonMode || typeof data !== "string") console.log(JSON.stringify(data, null, 2));
  else console.log(data);
}

function baseUrl(config: HostConfig, args: string[]): string {
  return value(args, "--server") ?? `http://${config.host}:${config.port}`;
}

async function request(config: HostConfig, args: string[], path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(config, args)}${path}`);
  } catch {
    throw new CliError(`The ${PRODUCT_NAME} service is offline at ${baseUrl(config, args)}. Start it with: headless-codex serve`, 3);
  }
  if (!response.ok) throw new CliError(`Host returned HTTP ${response.status}: ${await response.text()}`, 3);
  return response.json();
}

async function requestResponse(config: HostConfig, args: string[], path: string, init: RequestInit = {}): Promise<Response> {
  try {
    const response = await fetch(`${baseUrl(config, args)}${path}`, init);
    if (!response.ok) throw new CliError(`Host returned HTTP ${response.status}: ${await response.text()}`, 3);
    return response;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`The ${PRODUCT_NAME} service is offline at ${baseUrl(config, args)}. Start it with: headless-codex serve`, 3);
  }
}

async function runInherited(command: string[], env: Record<string, string | undefined> = {}): Promise<number> {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  return child.exited;
}

function addModelOptions(command: string[], args: string[]): void {
  const model = value(args, "--model") ?? process.env.HEADLESS_CODEX_MODEL ?? "gpt-5.6-luna";
  const reasoning = value(args, "--reasoning") ?? process.env.HEADLESS_CODEX_REASONING ?? "xhigh";
  command.push("--model", model);
  command.push("-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`);
}

async function runDesktopBrowserTurn(config: HostConfig, args: string[], prompt: string, newChat = true, onEvent: DesktopEventHandler = undefined, sessionId?: string): Promise<{ answer: string; [key: string]: unknown }> {
  const timeoutMs = Number(value(args, "--timeout") ?? "600000");
  const response = await requestResponse(config, args, "/v1/desktop/turns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: [
        "Use the Codex Desktop built-in Browser for this request.",
        "Invoke the Browser plugin before answering and do not use curl, wget, Web Search, or a custom browser MCP as a substitute.",
        "If the built-in Browser is unavailable, say that browser mode failed.",
        "",
        prompt,
      ].join("\n"),
      browser: true,
      newChat,
      sessionId,
      stream: true,
      timeoutMs,
      model: value(args, "--model") ?? process.env.HEADLESS_CODEX_MODEL ?? "gpt-5.6-luna",
      reasoning: value(args, "--reasoning") ?? process.env.HEADLESS_CODEX_REASONING ?? "xhigh",
    }),
  });
  if (!response.body) throw new CliError("Desktop turn returned no event stream", 3);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: { answer: string; [key: string]: unknown } | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type?: unknown; text?: unknown; error?: unknown; answer?: unknown; [key: string]: unknown };
    if (event.type === "turn.failed") {
      onEvent?.(event);
      throw new CliError(String(event.error ?? "Desktop turn failed"), 3);
    }
    if (event.type === "turn.completed") {
      const { type: _type, text: _desktopAccessibilityTranscript, ...result } = event;
      completed = result as { answer: string; [key: string]: unknown };
      onEvent?.({ type: "turn.completed", ...result });
      return;
    }
    onEvent?.(event);
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (chunk.done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!completed) throw new CliError("Desktop event stream ended before turn completion", 3);
  return completed;
}

type DesktopEventHandler = ((event: { type?: unknown; [key: string]: unknown }) => void) | undefined;

function outputDesktopEvents(jsonl: boolean): { handler: NonNullable<DesktopEventHandler>; finish: (result: { answer: string; [key: string]: unknown }) => void } {
  let streamed = "";
  return {
    handler(event) {
      if (jsonl) {
        console.log(JSON.stringify(event));
        return;
      }
      if (event.type === "response.delta" && typeof event.delta === "string") {
        process.stdout.write(event.delta);
        streamed += event.delta;
      } else if (event.type === "response.snapshot" && typeof event.text === "string" && !streamed) {
        process.stdout.write(event.text);
        streamed = event.text;
      }
    },
    finish(result) {
      if (jsonl) return;
      if (!streamed) process.stdout.write(result.answer);
      else if (result.answer.startsWith(streamed)) process.stdout.write(result.answer.slice(streamed.length));
      else if (result.answer !== streamed) process.stdout.write(`\n${result.answer}`);
      process.stdout.write("\n");
    },
  };
}

function pidFile(config: HostConfig): string {
  return join(config.dataDir, "headless-codex.pid");
}

function readPid(config: HostConfig): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile(config), "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function execute(parsed: ParsedArgs): Promise<number> {
  if (parsed.command === "help" || has(parsed.raw, "--help")) {
    const requested = parsed.command === "help"
      ? positional(parsed.rest, ["--server", "--timeout"]).join(" ") || undefined
      : parsed.command;
    if (requested && !findCommandSpec(requested)) throw new CliError(`Unknown command: ${requested}`, 2);
    print(parsed.json ? helpDocument(requested) : renderHelp(requested), parsed.json);
    return 0;
  }

  if (!findCommandSpec(parsed.command)) throw new CliError(`Unknown command: ${parsed.command}\n\n${renderHelp()}`, 2);
  if (["thread", "browser", "auth", "api"].includes(parsed.command)) {
    print(parsed.json ? helpDocument(parsed.command) : renderHelp(parsed.command), parsed.json);
    return 0;
  }

  // Discovery commands remain usable before runtime dependencies are available.
  if (parsed.command === "version") {
    print(parsed.json ? { name: PRODUCT_NAME, version: PRODUCT_VERSION } : `${PRODUCT_NAME} ${PRODUCT_VERSION}`, parsed.json);
    return 0;
  }
  if (parsed.command === "api schema") {
    const schemaBaseUrl = value(parsed.raw, "--server")
      ?? `http://${process.env.HEADLESS_CODEX_HOST ?? "127.0.0.1"}:${process.env.HEADLESS_CODEX_PORT ?? "4580"}`;
    print(openApiDocument(schemaBaseUrl), true);
    return 0;
  }
  if (parsed.command === "completion") {
    const shell = positional(parsed.rest, ["--server", "--timeout"])[0];
    const commands = commandSpecs.map((command) => command.path.split(" ")[0]).filter((name, index, all) => all.indexOf(name) === index).join(" ");
    if (shell === "zsh") console.log(`#compdef headless-codex\n_arguments '1:command:(${commands})'`);
    else if (shell === "bash") console.log(`complete -W '${commands}' headless-codex`);
    else if (shell === "fish") console.log(commands.split(" ").map((name) => `complete -c headless-codex -f -a '${name}'`).join("\n"));
    else throw new CliError("Choose a shell: bash, zsh, or fish", 2);
    return 0;
  }
  const config = configFromArgs(parsed.raw);

  switch (parsed.command) {
    case "config": {
      print(config, parsed.json);
      return 0;
    }
    case "setup": {
      ensureDataDirectories(config);
      const runtime = new HostRuntime(config);
      const result = { dataDir: config.dataDir, checks: runtime.doctor() };
      if (parsed.json) print(result, true);
      else {
        console.log(`Prepared ${config.dataDir}\n`);
        for (const check of result.checks) console.log(`${check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗"} ${check.label}: ${check.detail}`);
      }
      return result.checks.some((check) => check.status === "fail") ? 3 : 0;
    }
    case "doctor": {
      ensureDataDirectories(config);
      const checks = new HostRuntime(config).doctor();
      if (parsed.json) print({ checks }, true);
      else for (const check of checks) console.log(`${check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗"} ${check.label}: ${check.detail}`);
      return checks.some((check) => check.status === "fail") ? 3 : 0;
    }
    case "serve": {
      const running = await startServer(config);
      ensureDataDirectories(config);
      writeFileSync(pidFile(config), `${process.pid}\n`, { mode: 0o600 });
      console.log(`${PRODUCT_NAME} listening on http://${config.host}:${config.port}`);
      console.log(`Desktop Browser host: ${config.desktopEnabled ? config.desktopBinary : "disabled"}`);
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        await running.stop();
        if (readPid(config) === process.pid && existsSync(pidFile(config))) unlinkSync(pidFile(config));
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
      return 0;
    }
    case "start": {
      ensureDataDirectories(config);
      const previousPid = readPid(config);
      if (previousPid && processExists(previousPid)) throw new CliError(`${PRODUCT_NAME} is already running with PID ${previousPid}`);
      const logPath = join(config.dataDir, "logs", "host.log");
      const log = openSync(logPath, "a", 0o600);
      const child = spawnDetached(process.execPath, [import.meta.path, "serve", ...parsed.rest], {
        detached: true,
        stdio: ["ignore", log, log],
        env: process.env,
      });
      child.unref();
      closeSync(log);
      if (!child.pid) throw new CliError("Failed to start background service");
      writeFileSync(pidFile(config), `${child.pid}\n`, { mode: 0o600 });
      await Bun.sleep(350);
      print(parsed.json ? { started: true, pid: child.pid, logPath } : `Started ${PRODUCT_NAME} (PID ${child.pid})\nLogs: ${logPath}`, parsed.json);
      return 0;
    }
    case "stop": {
      const pid = readPid(config);
      if (!pid || !processExists(pid)) throw new CliError(`${PRODUCT_NAME} is not running`, 3);
      process.kill(pid, "SIGTERM");
      print(parsed.json ? { stopped: true, pid } : `Stopping ${PRODUCT_NAME} (PID ${pid})`, parsed.json);
      return 0;
    }
    case "status":
      print(await request(config, parsed.raw, "/v1/health"), parsed.json);
      return 0;
    case "capabilities":
      print(await request(config, parsed.raw, "/v1/capabilities"), parsed.json);
      return 0;
    case "browser list":
      print(await request(config, parsed.raw, "/v1/browser/sessions"), parsed.json);
      return 0;
    case "thread list":
      print(await request(config, parsed.raw, "/v1/threads"), parsed.json);
      return 0;
    case "thread clear-finished":
      print(await requestResponse(config, parsed.raw, "/v1/threads/cleanup", { method: "POST" }).then((response) => response.json()), parsed.json);
      return 0;
    case "thread show": {
      const threadId = positional(parsed.rest, ["--server", "--timeout"])[0];
      if (!threadId) throw new CliError("Usage: headless-codex thread show THREAD_ID", 2);
      print(await request(config, parsed.raw, `/v1/threads/${encodeURIComponent(threadId)}`), parsed.json);
      return 0;
    }
    case "trace inspect":
    case "trace events": {
      const runId = positional(parsed.rest, ["--server", "--timeout"])[0];
      if (!runId) throw new CliError(`Usage: headless-codex ${parsed.command} RUN_ID`, 2);
      const suffix = parsed.command === "trace events" ? "/events" : "";
      print(await request(config, parsed.raw, `/v1/runs/${encodeURIComponent(runId)}${suffix}`), parsed.json);
      return 0;
    }
    case "session inspect": {
      const sessionId = positional(parsed.rest, ["--server", "--timeout"])[0];
      if (!sessionId) throw new CliError("Usage: headless-codex session inspect SESSION_ID", 2);
      print(await request(config, parsed.raw, `/v1/sessions/${encodeURIComponent(sessionId)}`), parsed.json);
      return 0;
    }
    case "browser view": {
      const sessions = await request(config, parsed.raw, "/v1/browser/sessions") as { sessions: Array<{ id: string; title?: string }> };
      const requestedId = positional(parsed.rest, ["--server", "--timeout"])[0];
      const session = requestedId ? sessions.sessions.find((candidate) => candidate.id === requestedId) : sessions.sessions[0];
      if (!session) throw new CliError("No browser session is currently available.", 3);
      const viewerUrl = `${baseUrl(config, parsed.raw)}/viewer/${encodeURIComponent(session.id)}`;
      print(parsed.json ? { sessionId: session.id, title: session.title, viewerUrl } : viewerUrl, parsed.json);
      return 0;
    }
    case "browser screenshot": {
      const sessionId = positional(parsed.rest, ["--output", "--server", "--timeout"])[0];
      const output = value(parsed.raw, "--output");
      if (!sessionId || !output) throw new CliError("Usage: headless-codex browser screenshot SESSION_ID --output FILE", 2);
      const response = await requestResponse(config, parsed.raw, `/v1/browser/sessions/${encodeURIComponent(sessionId)}/screenshot`);
      await Bun.write(output, await response.arrayBuffer());
      print(parsed.json ? { sessionId, output } : `Saved ${output}`, parsed.json);
      return 0;
    }
    case "chat": {
      if (has(parsed.raw, "--browser")) {
        const report = await request(config, parsed.raw, "/v1/capabilities") as { browser?: { state?: string } };
        if (report.browser?.state !== "ready") throw new CliError("The native desktop browser is not ready.", 3);
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        console.log("Codex Desktop browser chat · Ctrl-D to exit");
        let newChat = true;
        let sessionId: string | undefined;
        try {
          while (true) {
            const prompt = (await terminal.question("> ")).trim();
            if (!prompt) continue;
            const output = outputDesktopEvents(false);
            const result = await runDesktopBrowserTurn(config, parsed.raw, prompt, newChat, output.handler, sessionId);
            newChat = false;
            if (typeof result.sessionId === "string") sessionId = result.sessionId;
            output.finish(result);
            console.log();
          }
        } catch {
          return 0;
        } finally {
          terminal.close();
        }
      }
      throw new CliError("Interactive chat requires --browser.", 2);
    }
    case "run": {
      const prompt = positional(parsed.rest, ["--cwd", "--server", "--timeout", "--model", "--reasoning"])[0];
      if (!prompt) throw new CliError("A prompt is required. Run `headless-codex help run` for examples.", 2);
      if (has(parsed.raw, "--browser")) {
        const report = await request(config, parsed.raw, "/v1/capabilities") as { browser?: { state?: string } };
        if (report.browser?.state !== "ready") {
          throw new CliError("The native browser renderer is not connected to the control bridge yet. Check `headless-codex capabilities --json`.", 3);
        }
        const output = outputDesktopEvents(parsed.jsonl);
        const result = await runDesktopBrowserTurn(config, parsed.raw, prompt, true, parsed.json ? undefined : output.handler);
        if (parsed.json) console.log(JSON.stringify(result));
        else output.finish(result);
        return 0;
      }
      const command = [config.codexBinary, "exec", "-C", value(parsed.raw, "--cwd") ?? config.workspaceRoot];
      addModelOptions(command, parsed.raw);
      if (parsed.jsonl) command.push("--json");
      command.push(prompt);
      return runInherited(command);
    }
    case "auth login":
      if (has(parsed.raw, "--desktop")) {
        if (!config.viewerEnabled) throw new CliError("Enable HEADLESS_CODEX_INTERACTIVE_VIEWER=1, restart the host, then retry desktop login.", 3);
        const viewerHost = config.viewerHost === "0.0.0.0" || config.viewerHost === "::" ? "127.0.0.1" : config.viewerHost;
        const url = `http://${viewerHost}:${config.viewerPort}/vnc.html?autoconnect=true&resize=scale`;
        print(parsed.json ? { loginUrl: url } : url, parsed.json);
        return 0;
      }
      return runInherited([config.codexBinary, "login"]);
    case "auth status":
      return runInherited([config.codexBinary, "login", "status"]);
    case "logs": {
      const data = await request(config, parsed.raw, "/v1/logs");
      print(data, parsed.json);
      return 0;
    }
    case "thread list":
    case "thread clear-finished":
      throw new CliError(`${parsed.command} is reserved in the v1 contract but requires the desktop browser bridge.`, 3);
    default:
      throw new CliError(`${parsed.command} is not implemented`, 3);
  }
}

const parsed = parse(process.argv.slice(2));
try {
  process.exitCode = await execute(parsed);
} catch (error) {
  const cliError = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error));
  if (parsed.json || parsed.jsonl) console.error(JSON.stringify({ error: cliError.message, exitCode: cliError.exitCode }));
  else console.error(`Error: ${cliError.message}`);
  process.exitCode = cliError.exitCode;
}

export { execute, parse, publicCommandSpecs };
