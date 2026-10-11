import { defineCommand } from "citty";
import { integrations, loadConfig } from "#/core/config.ts";
import { paths } from "#/core/paths.ts";
import { version } from "#/core/release.ts";
import { startDiscord } from "#/integrations/discord/index.ts";
import { startGithub } from "#/integrations/github.ts";
import { startJobs } from "#/jobs.ts";

export default defineCommand({
  meta: { name: "start", description: "Run Pukeko in the foreground (the default)" },
  async run() {
    await loadConfig();
    console.log(`Pukeko ${version} starting with workspace ${paths.workspace}`);
    if (integrations.discord) await startDiscord();
    await startJobs();
    if (integrations.github) await startGithub();
  },
});
