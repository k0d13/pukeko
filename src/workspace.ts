import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// pukeko [init | service] [--workspace DIR]
const { values, positionals } = parseArgs({
  options: { workspace: { type: "string" } },
  allowPositionals: true,
});

export const command = positionals[0];

export const workspace = resolve(
  values.workspace || process.env.PUKEKO_WORKSPACE || join(homedir(), ".pukeko", "workspace"),
);
