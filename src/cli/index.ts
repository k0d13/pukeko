#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { setWorkspace } from "#/core/paths.ts";
import { version } from "#/core/release.ts";
import check from "./check.ts";
import init from "./init.ts";
import jobs from "./jobs.ts";
import service from "./service.ts";
import start from "./start.ts";
import upgrade from "./upgrade.ts";

const main = defineCommand({
  meta: { name: "pukeko", version, description: "A personal Claude assistant on Discord" },
  args: {
    workspace: {
      type: "string",
      description: "Workspace folder, default $PUKEKO_WORKSPACE or ~/.pukeko/workspace",
    },
  },
  setup: ({ args }) => setWorkspace(args.workspace),
  default: "start",
  subCommands: { start, init, check, jobs, service, upgrade },
});

await runMain(main);
