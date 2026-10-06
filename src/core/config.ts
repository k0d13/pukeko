import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "./paths.ts";

type Table = Record<string, unknown>;

export const effortLevels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// Every key in pukeko.toml is optional, so the defaults double as its schema
const defaults = {
  owner: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  agent: { model: "", effort: "" as EffortLevel | "", sandbox: true },
  conversations: { scope: "channel" as "channel" | "shared" },
};

/** Filled by `loadConfig` */
export let config = defaults;
/** From .env, kept out of process.env so the agent's shell never inherits them */
export let secrets: Record<string, string> = {};

function merge<T extends Table>(base: T, input: Table, errors: string[], prefix = ""): T {
  const out: Table = { ...base };
  for (const [key, value] of Object.entries(input)) {
    const name = prefix + key;
    const fallback = base[key];
    if (fallback === undefined) errors.push(`unknown key "${name}"`);
    else if (typeof fallback === "object")
      if (value && typeof value === "object" && !Array.isArray(value))
        out[key] = merge(fallback as Table, value as Table, errors, `${name}.`);
      else errors.push(`"${name}" should be a [${name}] table`);
    else if (typeof value !== typeof fallback)
      errors.push(`"${name}" should be a ${typeof fallback}`);
    else out[key] = value;
  }
  return out as T;
}

export async function parseEnv(path: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const entries = (await file.text())
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i))
    .filter((match) => match !== null)
    .map(([, key, value]) => [key!, value!.replace(/^(["'])(.*)\1$/, "$2")]);
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Reads pukeko.toml and .env, or exits listing every problem with them */
export async function loadConfig() {
  const toml = Bun.file(paths.toml);
  if (!(await toml.exists())) {
    console.error(`No pukeko.toml in ${paths.workspace}`);
    console.error("Run `pukeko init` to create a workspace, or point --workspace at one");
    process.exit(1);
  }

  const errors: string[] = [];
  config = merge(defaults, Bun.TOML.parse(await toml.text()) as Table, errors);
  secrets = await parseEnv(paths.env);

  if (config.owner && !/^\d{17,20}$/.test(config.owner))
    errors.push(`"owner" should be a Discord user ID (17-20 digits), not "${config.owner}"`);
  if (!["channel", "shared"].includes(config.conversations.scope))
    errors.push(`"conversations.scope" should be "channel" or "shared"`);
  if (config.agent.effort && !effortLevels.includes(config.agent.effort))
    errors.push(`"agent.effort" should be one of ${effortLevels.join(", ")}`);
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
  } catch {
    errors.push(`"timezone" "${config.timezone}" isn't a known timezone`);
  }
  for (const name of ["DISCORD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
    if (!secrets[name]) errors.push(`${name} is missing from .env`);
  if (!Bun.which("claude")) errors.push("`claude` isn't on PATH, install Claude Code first");

  if (errors.length) {
    console.error(`Problems in ${paths.workspace}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
}
