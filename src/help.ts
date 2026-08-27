import { commandSpecs, type CommandSpec } from "./command-spec";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./contracts";

const globalOptions = [
  ["--server URL", "Headless host endpoint"],
  ["--json", "Return one JSON result"],
  ["--jsonl", "Stream newline-delimited JSON events where supported"],
  ["--quiet", "Only print final output"],
  ["--timeout DURATION", "Operation timeout"],
  ["--help", "Show command help"],
];

export function findCommandSpec(path: string): CommandSpec | undefined {
  return commandSpecs.find((command) => command.path === path);
}

function section(title: string): string {
  return `\n${title}\n`;
}

function pad(value: string, width = 24): string {
  return value.padEnd(width, " ");
}

export function renderHelp(path?: string): string {
  if (path) {
    const command = findCommandSpec(path);
    if (!command) throw new Error(`Unknown command: ${path}`);
    let output = `${command.usage}\n\n${command.summary}`;
    if (command.status === "contract") output += "\n\nSTATUS\n  Contract defined; runtime bridge not implemented yet.";
    if (command.description) output += `\n\n${command.description}`;
    if (command.options?.length) {
      output += section("OPTIONS");
      for (const option of command.options) {
        const label = `${option.name}${option.value ? ` <${option.value}>` : ""}`;
        output += `  ${pad(label)}${option.description}${option.default ? ` [default: ${option.default}]` : ""}\n`;
      }
    }
    if (command.examples?.length) {
      output += section("EXAMPLES");
      output += command.examples.map((example) => `  ${example}`).join("\n") + "\n";
    }
    const children = commandSpecs.filter((candidate) => candidate.path.startsWith(`${command.path} `) && candidate.path.split(" ").length === command.path.split(" ").length + 1);
    if (children.length) {
      output += section("COMMANDS");
      for (const child of children) output += `  ${pad(child.path.slice(command.path.length + 1))}${child.summary}${child.status === "contract" ? " [bridge pending]" : ""}\n`;
    }
    return output.trimEnd();
  }

  let output = `${PRODUCT_NAME} ${PRODUCT_VERSION}\n\nHeadless Codex agent with native desktop browser hosting.\n`;
  output += section("QUICK START");
  output += "  headless-codex setup\n  headless-codex serve\n  headless-codex chat --cwd ./my-project\n";
  output += section("COMMANDS");
  for (const command of commandSpecs.filter((command) => command.path !== "help")) output += `  ${pad(command.path)}${command.summary}${command.status === "contract" ? " [bridge pending]" : ""}\n`;
  output += section("GLOBAL OPTIONS");
  for (const [name, description] of globalOptions) output += `  ${pad(name ?? "")}${description}\n`;
  output += "\nRun `headless-codex help <command>` for command details.\n";
  output += "Run `headless-codex help --json` for machine-readable discovery.";
  return output;
}

export function helpDocument(path?: string): object {
  const children = path
    ? commandSpecs.filter((candidate) => candidate.path.startsWith(`${path} `) && candidate.path.split(" ").length === path.split(" ").length + 1)
    : commandSpecs;
  return {
    name: PRODUCT_NAME,
    version: PRODUCT_VERSION,
    description: "Headless Codex agent with native desktop browser hosting.",
    command: path ? findCommandSpec(path) : undefined,
    commands: children,
    globalOptions: globalOptions.map(([name, description]) => ({ name, description })),
  };
}
