import { defineCommand } from "citty";
import { consola } from "consola";
import { loadConfig } from "#/core/config.ts";
import { paths } from "#/core/paths.ts";

export default defineCommand({
  meta: { name: "check", description: "Check the workspace's config and secrets without starting" },
  async run() {
    await loadConfig();
    consola.success(`${paths.workspace} is ready to run`);
  },
});
