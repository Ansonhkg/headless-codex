import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FONT_FILES = new Set(["geist-mono.woff2", "geist-sans.woff2"]);

export async function fontAsset(name: string): Promise<Uint8Array | undefined> {
  if (!FONT_FILES.has(name)) return undefined;
  const directory = [
    process.env.HEADLESS_CODEX_FONT_DIR,
    "/usr/local/share/headless-codex/fonts",
    join(import.meta.dir, "..", "assets", "fonts"),
    join(process.cwd(), "assets", "fonts"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(join(candidate, "geist-sans.woff2"))));
  if (!directory) throw new Error("Dashboard font files are not installed");
  return new Uint8Array(await readFile(join(directory, name)));
}
