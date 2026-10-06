import { workspace } from "./config.ts";

if (process.argv.includes("service")) {
  const { installService } = await import("./service.ts");
  installService();
  process.exit(0);
}

const { startDiscord } = await import("./discord.ts");
const { startJobs } = await import("./jobs.ts");
console.log(`Pukeko starting with workspace ${workspace}`);
await startDiscord();
startJobs();
