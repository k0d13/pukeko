import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import { backgroundSession } from "#/agent/index.ts";
import { config } from "#/core/config.ts";
import { report } from "#/core/log.ts";
import { paths } from "#/core/paths.ts";
import { watchFolder } from "#/core/watch.ts";
import { send } from "#/discord/client.ts";

const running = new Map<string, Cron>();

function stop(id: string) {
  running.get(id)?.stop();
  running.delete(id);
}

// jobs/<id>/job.md is YAML frontmatter, then the prompt
async function add(id: string, path: string) {
  const match = (await Bun.file(path).text()).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("No frontmatter");
  const meta = (Bun.YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  if (meta.enabled === false || !meta.schedule) return stop(id);
  const schedule = String(meta.schedule);
  const channel = meta.channel ? String(meta.channel) : undefined;
  const prompt = match[2]!.trim();
  // One-offs are ISO datetimes, everything else is cron (MON-FRI, @daily and so on)
  const oneOff = /^\d{4}-\d{2}-\d{2}T/.test(schedule);
  const cron = new Cron(schedule, { timezone: config.timezone, protect: true }, async () => {
    try {
      console.log(`Running job ${id}`);
      const reply = await backgroundSession().ask(`[Scheduled job: ${id}]\n\n${prompt}`);
      if (reply.trim() !== "NOTHING") await send(channel, reply);
      // Deleted only once delivered, so a failed reminder retries on the next start
      if (oneOff) await rm(join(paths.jobs, id), { recursive: true, force: true });
    } catch (error) {
      report(`jobs/${id} failed`, error);
    }
  });
  stop(id);
  running.set(id, cron);
  // A one-off whose time already passed runs now, late beats never
  if (oneOff && !cron.nextRun()) cron.trigger();
}

export function startJobs() {
  return watchFolder({ dir: paths.jobs, pattern: "*/job.md", add, remove: stop });
}
