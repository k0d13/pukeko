import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./workspace.ts";

export { workspace };

type Table = Record<string, unknown>;

const tomlPath = join(workspace, "pukeko.toml");
if (!existsSync(tomlPath)) {
  console.error(`No pukeko.toml in ${workspace}`);
  console.error("Run `pukeko init` to create a workspace, or point --workspace at an existing one");
  process.exit(1);
}

// Every key in pukeko.toml is optional; these defaults double as its schema
const defaults = {
  owner: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  agent: { model: "", sandbox: true },
  conversations: { scope: "channel" as "channel" | "shared" },
};

const errors: string[] = [];

// Overlays `input` on `base`, reporting unknown keys and wrong types instead of
// letting them fail somewhere later
function merge<T extends Table>(base: T, input: Table, prefix = ""): T {
  const out: Table = { ...base };
  for (const [key, value] of Object.entries(input)) {
    const name = prefix + key;
    const fallback = base[key];
    if (fallback === undefined) errors.push(`unknown key "${name}"`);
    else if (typeof fallback === "object")
      if (value && typeof value === "object" && !Array.isArray(value))
        out[key] = merge(fallback as Table, value as Table, `${name}.`);
      else errors.push(`"${name}" should be a [${name}] table`);
    else if (typeof value !== typeof fallback)
      errors.push(`"${name}" should be a ${typeof fallback}`);
    else out[key] = value;
  }
  return out as T;
}

// KEY=value lines, optionally quoted. Kept out of process.env so the agent's
// shell never inherits them
function parseEnv(path: string) {
  if (!existsSync(path)) return {};
  const entries = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i))
    .filter((match) => match !== null)
    .map(([, key, value]) => [key!, value!.replace(/^(["'])(.*)\1$/, "$2")]);
  return Object.fromEntries(entries) as Record<string, string>;
}

export const config = merge(defaults, Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Table);
export const secrets = parseEnv(join(workspace, ".env"));

if (config.owner && !/^\d{17,20}$/.test(config.owner))
  errors.push(`"owner" should be a Discord user ID (17-20 digits), not "${config.owner}"`);
if (!["channel", "shared"].includes(config.conversations.scope))
  errors.push(`"conversations.scope" should be "channel" or "shared"`);
try {
  new Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
} catch {
  errors.push(`"timezone" "${config.timezone}" isn't a known timezone`);
}
for (const name of ["DISCORD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
  if (!secrets[name]) errors.push(`${name} is missing from .env`);

if (errors.length) {
  console.error(`Config problems in ${workspace}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
