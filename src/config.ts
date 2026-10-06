import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// pukeko [--workspace DIR]   (default: $PUKEKO_WORKSPACE or ~/.pukeko/workspace)
const flag = process.argv.indexOf("--workspace");
export const workspace = resolve(
  (flag !== -1 && process.argv[flag + 1]) ||
    process.env.PUKEKO_WORKSPACE ||
    join(homedir(), ".pukeko", "workspace"),
);

if (!existsSync(join(workspace, "pukeko.toml"))) {
  console.error(`No pukeko.toml in ${workspace}. Point --workspace at your workspace repo.`);
  process.exit(1);
}

// Non-secret config, committed in the workspace.
const toml = Bun.TOML.parse(readFileSync(join(workspace, "pukeko.toml"), "utf8")) as {
  owner_id?: string;
  discord_app_id?: string;
  timezone?: string;
  model?: string;
  sandbox?: boolean;
};

// Secrets, gitignored in the workspace. Kept out of process.env so the agent's
// shell never inherits them.
const envPath = join(workspace, ".env");
export const secrets: Record<string, string> = existsSync(envPath)
  ? Object.fromEntries(
      readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => /^\s*[A-Z_][A-Z0-9_]*\s*=/i.test(line))
        .map((line) => {
          const i = line.indexOf("=");
          return [
            line.slice(0, i).trim(),
            line
              .slice(i + 1)
              .trim()
              .replace(/^["']|["']$/g, ""),
          ];
        }),
    )
  : {};

export const config = {
  ownerId: toml.owner_id ?? "",
  discordAppId: toml.discord_app_id ?? "",
  timezone: toml.timezone ?? "UTC",
  model: toml.model || undefined,
  sandbox: toml.sandbox ?? true,
};

const missing = [
  !config.ownerId && "owner_id (pukeko.toml)",
  !config.discordAppId && "discord_app_id (pukeko.toml)",
  !secrets.DISCORD_TOKEN && "DISCORD_TOKEN (.env)",
  !secrets.CLAUDE_CODE_OAUTH_TOKEN && "CLAUDE_CODE_OAUTH_TOKEN (.env)",
].filter(Boolean);
if (missing.length) {
  console.error(`Missing config: ${missing.join(", ")}`);
  process.exit(1);
}
