import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const LOGO_FILE = "headless-codex-logo.png";

export async function logoAsset(): Promise<Uint8Array | undefined> {
  const directory = [
    process.env.HEADLESS_CODEX_ASSET_DIR,
    "/usr/local/share/headless-codex/assets",
    join(import.meta.dir, "..", "assets"),
    join(process.cwd(), "assets"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(join(candidate, LOGO_FILE))));
  if (!directory) throw new Error("Headless Codex logo is not installed");
  return new Uint8Array(await readFile(join(directory, LOGO_FILE)));
}
