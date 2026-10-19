import * as discord from "discord.js";
import * as api from "./api.ts";
import { startCommands } from "./commands.ts";
import { startTriggers } from "./triggers.ts";

export { handleCustom } from "./commands.ts";

/** Loads the agent-written triggers/ and commands/, keeping them in step with the files */
export async function startHandlers() {
  // The workspace has no node_modules, so these resolve to the harness's own copies
  Bun.plugin({
    name: "pukeko",
    setup(build) {
      build.module("discord.js", () => ({ exports: discord, loader: "object" }));
      build.module("pukeko", () => ({ exports: api, loader: "object" }));
    },
  });
  await Promise.all([startTriggers(), startCommands()]);
}
