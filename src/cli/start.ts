import { defineCommand } from "citty";
import { loadConfig } from "#/core/config.ts";
import { paths } from "#/core/paths.ts";
import { version } from "#/core/release.ts";
import { startDiscord } from "#/discord/index.ts";
import { startJobs } from "#/jobs.ts";

export default defineCommand({
  meta: { name: "start", description: "Run Pukeko in the foreground (the default)" },
  async run() {
    await loadConfig();
    console.log(`Pukeko ${version} starting with workspace ${paths.workspace}`);
    await startDiscord();
    await startJobs();
  },
});
