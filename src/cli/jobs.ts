import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { consola } from "consola";
import { loadConfig } from "#/core/config.ts";
import { paths } from "#/core/paths.ts";
import { nextRun, nextTime, parseJob } from "#/jobs.ts";

// When it runs next, or why it won't
async function describe(path: string) {
  try {
    const { schedule, oneOff, model, effort } = parseJob(await Bun.file(path).text());
    if (!schedule) return "off";
    const setup = [model, effort && `${effort} effort`].filter(Boolean);
    return `${schedule}, ${nextRun(nextTime({ schedule, oneOff }))}${setup.length ? `, ${setup.join(", ")}` : ""}`;
  } catch (error) {
    return `won't load: ${error instanceof Error ? error.message : error}`;
  }
}

export default defineCommand({
  meta: { name: "jobs", description: "List the workspace's jobs and when they next run" },
  async run() {
    await loadConfig();
    const files = await Array.fromAsync(new Bun.Glob("*/job.md").scan({ cwd: paths.jobs })).catch(
      () => [],
    );
    if (!files.length) return consola.info(`No jobs in ${paths.jobs}`);
    for (const file of files.sort())
      console.log(`${dirname(file)}: ${await describe(join(paths.jobs, file))}`);
  },
});
