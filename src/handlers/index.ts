import * as discord from "discord.js";
import { paths } from "#/core/paths.ts";
import { watchFolder } from "#/core/watch.ts";
import * as api from "./api.ts";
import { addCommand, removeCommand, syncCommands } from "./commands.ts";
import { addTrigger, removeTrigger } from "./triggers.ts";

// Subfolders are left alone, so helpers can live there
const modules = "*.{ts,js,mts,mjs}";

// A new query string is a new module to Bun, which is what makes edits reload
function fresh(path: string) {
  return import(`${path}?v=${Date.now()}`);
}

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
  await Promise.all([
    watchFolder({
      dir: paths.triggers,
      pattern: modules,
      add: async (id, path) => addTrigger(id, await fresh(path)),
      remove: removeTrigger,
    }),
    watchFolder({
      dir: paths.commands,
      pattern: modules,
      add: async (id, path) => addCommand(id, await fresh(path)),
      remove: removeCommand,
      changed: syncCommands,
    }),
  ]);
  // The first scan only calls `changed` if it found something, but the built-ins need registering
  await syncCommands();
}
