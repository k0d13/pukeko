import { defineCommand } from "citty";
import { config, loadConfig } from "#/core/config.ts";
import { logger } from "#/core/log.ts";
import { paths } from "#/core/paths.ts";
import { version } from "#/core/release.ts";
import { startDiscord } from "#/discord/index.ts";
import { startHandlers } from "#/handlers/index.ts";
import { startJobs } from "#/jobs.ts";

export default defineCommand({
  meta: { name: "start", description: "Run Pukeko in the foreground (the default)" },
  async run() {
    await loadConfig();
    const log = logger("pukeko");
    const { agent, conversations, timezone } = config;
    log.info(`Pukeko ${version} starting with workspace ${paths.workspace}`);
    log.info(
      `${agent.model || "Default model"}${agent.effort ? `, ${agent.effort} effort` : ""}, ${conversations.scope === "shared" ? "one shared conversation" : "a conversation per channel"}, sandbox ${agent.sandbox ? "on" : "off"}, ${timezone}`,
    );
    await startDiscord();
    await startHandlers();
    await startJobs();
    log.info("Ready");
  },
});
