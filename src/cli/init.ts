import { join } from "node:path";
import { defineCommand } from "citty";
import { consola } from "consola";
import { parseEnv } from "#/core/config.ts";
import { paths } from "#/core/paths.ts";
import env from "../../templates/.env.example" with { type: "text" };
import gitignore from "../../templates/.gitignore" with { type: "text" };
import memoryIndex from "../../templates/memory/README.md" with { type: "text" };
import pukekoToml from "../../templates/pukeko.toml" with { type: "text" };

// Only what the harness needs. Personality, integrations and jobs are the owner's to add
const templates = {
  ".env": env,
  ".gitignore": gitignore,
  "memory/README.md": memoryIndex,
  "pukeko.toml": pukekoToml,
};

async function ask(name: string, label: string, canRun: boolean) {
  const choice = await consola.prompt(label, {
    type: "select",
    options: [...(canRun ? ["Run claude setup-token"] : []), "Paste it", "Skip"],
  });
  if (choice === "Skip") return;
  if (choice.startsWith("Run")) {
    const setup = Bun.spawn(["claude", "setup-token"], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (await setup.exited) return;
  }
  const token = (await consola.prompt(`Paste ${name}`, { type: "text" })).trim();
  if (!token) return;
  const text = await Bun.file(paths.env).text();
  const line = new RegExp(`^${name}=.*$`, "m");
  const entry = `${name}=${token}`;
  await Bun.write(paths.env, line.test(text) ? text.replace(line, entry) : `${text}\n${entry}\n`);
}

export default defineCommand({
  meta: { name: "init", description: "Create a workspace, never overwriting what's there" },
  async run() {
    for (const [path, content] of Object.entries(templates)) {
      const target = join(paths.workspace, path);
      if (await Bun.file(target).exists()) continue;
      await Bun.write(target, content);
      consola.info(`Created ${target}`);
    }

    if (process.stdin.isTTY) {
      const secrets = await parseEnv(paths.env);
      if (!secrets.CLAUDE_CODE_OAUTH_TOKEN)
        await ask("CLAUDE_CODE_OAUTH_TOKEN", "Claude Code token", Boolean(Bun.which("claude")));
      if (!secrets.DISCORD_TOKEN) await ask("DISCORD_TOKEN", "Discord bot token", false);
    }
    consola.success(`Workspace ready at ${paths.workspace}`);
  },
});
