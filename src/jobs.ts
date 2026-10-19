import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import { backgroundSession } from "#/agent/index.ts";
import { config } from "#/core/config.ts";
import { logger, seconds } from "#/core/log.ts";
import { paths } from "#/core/paths.ts";
import { watchFolder } from "#/core/watch.ts";
import { send } from "#/discord/client.ts";

const log = logger("jobs");
const running = new Map<string, Cron>();

function stop(id: string) {
  running.get(id)?.stop();
  running.delete(id);
}

// jobs/<id>/job.md is YAML frontmatter, then the prompt. Without a schedule it's off
export function parseJob(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("No frontmatter");
  const meta = (Bun.YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  const schedule = meta.enabled === false || !meta.schedule ? undefined : String(meta.schedule);
  return {
    schedule,
    channel: meta.channel ? String(meta.channel) : undefined,
    prompt: match[2]!.trim(),
    // One-offs are ISO datetimes, everything else is cron (MON-FRI, @daily and so on)
    oneOff: Boolean(schedule && /^\d{4}-\d{2}-\d{2}T/.test(schedule)),
  };
}

/** When a job next runs, in the configured timezone */
export function nextRun(cron: Cron) {
  const at = cron.nextRun();
  return at
    ? `next run ${at.toLocaleString(undefined, { timeZone: config.timezone })}`
    : "overdue, runs on start";
}

async function add(id: string, path: string) {
  const { schedule, channel, prompt, oneOff } = parseJob(await Bun.file(path).text());
  if (!schedule) {
    stop(id);
    return "off, it has no schedule or enabled: false";
  }
  const cron = new Cron(schedule, { timezone: config.timezone, protect: true }, async () => {
    const started = Date.now();
    log.info(`Running jobs/${id}`);
    try {
      const reply = await backgroundSession().ask(`[Scheduled job: ${id}]\n\n${prompt}`);
      const quiet = reply.trim() === "NOTHING";
      if (!quiet) await send(channel, reply);
      const outcome = quiet ? "nothing to say" : `sent to ${channel ?? "the owner's DMs"}`;
      log.info(
        `jobs/${id} done in ${seconds(Date.now() - started)}, ${outcome}${oneOff ? "" : `, ${nextRun(cron)}`}`,
      );
      // Deleted only once delivered, so a failed reminder retries on the next start
      if (oneOff) await rm(join(paths.jobs, id), { recursive: true, force: true });
    } catch (error) {
      log.report(`jobs/${id} failed after ${seconds(Date.now() - started)}`, error);
    }
  });
  stop(id);
  running.set(id, cron);
  const note = `${schedule}, ${nextRun(cron)}`;
  // A one-off whose time already passed runs now, late beats never
  if (oneOff && !cron.nextRun()) cron.trigger();
  return note;
}

export function startJobs() {
  return watchFolder({ dir: paths.jobs, pattern: "*/job.md", add, remove: stop });
}
