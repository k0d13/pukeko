import { command, workspace } from "./workspace.ts";

// Subcommands only need the workspace path, not a valid config
if (command === "init") {
  const { createWorkspace } = await import("./init.ts");
  createWorkspace(workspace);
} else if (command === "service") {
  const { installService } = await import("./service.ts");
  installService(workspace);
} else if (command) {
  console.error(`Unknown command "${command}". Usage: pukeko [init | service] [--workspace DIR]`);
  process.exit(1);
} else {
  const { startDiscord } = await import("./discord.ts");
  const { startJobs } = await import("./jobs.ts");
  console.log(`Pukeko starting with workspace ${workspace}`);
  await startDiscord();
  startJobs();
}
