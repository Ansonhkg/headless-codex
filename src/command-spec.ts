export type OptionSpec = {
  name: string;
  value?: string;
  description: string;
  default?: string;
};

export type CommandSpec = {
  path: string;
  summary: string;
  usage: string;
  status?: "available" | "contract";
  description?: string;
  options?: OptionSpec[];
  examples?: string[];
};

export const commandSpecs: CommandSpec[] = [
  {
    path: "setup",
    summary: "Prepare data directories and inspect runtime dependencies",
    usage: "headless-codex setup [--json]",
  },
  {
    path: "serve",
    summary: "Run the headless host in the foreground",
    usage: "headless-codex serve [options]",
    options: [
      { name: "--host", value: "HOST", description: "HTTP bind host", default: "127.0.0.1" },
      { name: "--port", value: "PORT", description: "HTTP bind port", default: "4580" },
      { name: "--data-dir", value: "PATH", description: "Persistent state directory" },
      { name: "--workspace-root", value: "PATH", description: "Allowed workspace root" },
      { name: "--no-desktop", description: "Do not supervise the Linux desktop runtime" },
    ],
    examples: [
      "headless-codex serve",
      "headless-codex serve --host 0.0.0.0 --port 4580",
      "headless-codex serve --no-desktop",
    ],
  },
  { path: "start", summary: "Start the host as a background process", usage: "headless-codex start [options]" },
  { path: "stop", summary: "Stop a background host", usage: "headless-codex stop" },
  { path: "status", summary: "Show service and runtime health", usage: "headless-codex status [--json]" },
  {
    path: "chat",
    summary: "Open an interactive Codex session",
    usage: "headless-codex chat --browser [--model MODEL] [--reasoning EFFORT]",
    options: [
      { name: "--browser", description: "Chat through Codex Desktop with its built-in Browser" },
      { name: "--model", value: "MODEL", description: "Codex model", default: "gpt-5.6-luna" },
      { name: "--reasoning", value: "EFFORT", description: "Reasoning effort: light, medium, high, xhigh, max, or ultra", default: "max" },
    ],
  },
  {
    path: "run",
    summary: "Run one Codex request",
    usage: "headless-codex run [--cwd PATH] [--browser] [--jsonl] [--model MODEL] [--reasoning EFFORT] PROMPT",
    options: [
      { name: "--cwd", value: "PATH", description: "Working directory for non-browser Codex CLI mode" },
      { name: "--browser", description: "Run through Codex Desktop and require its built-in Browser" },
      { name: "--jsonl", description: "Stream machine-readable Desktop turn events" },
      { name: "--model", value: "MODEL", description: "Codex model", default: "gpt-5.6-luna" },
      { name: "--reasoning", value: "EFFORT", description: "Reasoning effort: light, medium, high, xhigh, max, or ultra", default: "max" },
    ],
  },
  { path: "thread", summary: "Navigate stored Codex conversations", usage: "headless-codex thread <command>" },
  { path: "thread list", summary: "List stored Codex threads", usage: "headless-codex thread list [--json]" },
  { path: "thread show", summary: "Inspect a thread, its sessions, and runs", usage: "headless-codex thread show THREAD_ID [--json]" },
  { path: "thread clear-finished", summary: "Remove matched completed or failed chats from the Desktop sidebar", usage: "headless-codex thread clear-finished [--json]" },
  { path: "trace", summary: "Inspect durable agent execution traces", usage: "headless-codex trace <command>" },
  { path: "trace inspect", summary: "Inspect one agent execution trace", usage: "headless-codex trace inspect RUN_ID [--json]" },
  { path: "trace events", summary: "Read the ordered event timeline for a run", usage: "headless-codex trace events RUN_ID [--json]" },
  { path: "session", summary: "Inspect stable runtime sessions", usage: "headless-codex session <command>" },
  { path: "session inspect", summary: "Inspect a stable runtime session", usage: "headless-codex session inspect SESSION_ID [--json]" },
  { path: "browser", summary: "Inspect and operate hosted browser sessions", usage: "headless-codex browser <command>" },
  { path: "browser list", summary: "List hosted browser sessions", usage: "headless-codex browser list [--json]" },
  { path: "browser view", summary: "Print the mediated live browser viewer URL", usage: "headless-codex browser view [SESSION_ID]" },
  { path: "browser screenshot", summary: "Capture a browser session", usage: "headless-codex browser screenshot SESSION_ID --output FILE" },
  { path: "auth", summary: "Manage Codex authentication", usage: "headless-codex auth <command>" },
  { path: "auth login", summary: "Start an interactive OpenAI login", usage: "headless-codex auth login [--desktop]", options: [{ name: "--desktop", description: "Print the temporary interactive desktop viewer login URL" }] },
  { path: "auth status", summary: "Show authentication status", usage: "headless-codex auth status [--json]" },
  { path: "capabilities", summary: "Report dynamically available capabilities", usage: "headless-codex capabilities [--json]" },
  { path: "config", summary: "Show effective host configuration", usage: "headless-codex config [--json]" },
  { path: "logs", summary: "Read or follow host logs", usage: "headless-codex logs [--follow]" },
  { path: "doctor", summary: "Diagnose host, desktop, display, and Codex dependencies", usage: "headless-codex doctor [--json]" },
  { path: "api", summary: "Discover the control API", usage: "headless-codex api <command>" },
  { path: "api schema", summary: "Print the control API schema", usage: "headless-codex api schema [--format openapi|json]" },
  { path: "completion", summary: "Generate shell completion", usage: "headless-codex completion <bash|zsh|fish>" },
  { path: "version", summary: "Print component versions", usage: "headless-codex version [--json]" },
  { path: "help", summary: "Show help for any command", usage: "headless-codex help [COMMAND] [--json]" },
];

export function publicCommandSpecs(): CommandSpec[] {
  return commandSpecs.map((command) => structuredClone(command));
}
