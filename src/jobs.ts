import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { backgroundSession } from "#/agent/index.ts";
import { config, effortLevels } from "#/core/config.ts";
import { logger, preview, seconds } from "#/core/log.ts";
import { paths } from "#/core/paths.ts";
import { watchFolder } from "#/core/watch.ts";
import { send } from "#/discord/client.ts";

const log = logger("jobs");
const running = new Map<string, { stop(): void }>();
// Jobs that failed and haven't worked since, so a job failing on every run alerts only once
const failing = new Set<string>();
// setTimeout fires straight away past 2^31 - 1 ms (about 24 days), so longer waits go in hops
const longestTimeout = 2 ** 31 - 1;

function stop(id: string) {
  running.get(id)?.stop();
  running.delete(id);
  failing.delete(id);
}

// The owner's DMs whatever the job's channel, as the one who has to fix it. Terse: the log has the detail
async function alert(id: string, reason: string) {
  if (failing.has(id)) return;
  failing.add(id);
  await send(
    undefined,
    `⚠️ Job \`${id}\` failed: ${preview(reason.replace(/\s+/g, " "), 200)}`,
  ).catch((error) => log.warn(`jobs/${id}: couldn't send the failure alert`, error));
}

// jobs/<id>/job.md is YAML frontmatter, then the prompt. Without a schedule it's off. A bad
// value throws, so the job doesn't load rather than quietly running on the wrong model
export function parseJob(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("No frontmatter");
  const meta = (Bun.YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  const schedule = meta.enabled === false || !meta.schedule ? undefined : String(meta.schedule);
  const effort = meta.effort ? String(meta.effort) : "";
  if (effort && !effortLevels.includes(effort as EffortLevel))
    throw new Error(`"effort" should be one of ${effortLevels.join(", ")}, not "${effort}"`);
  return {
    schedule,
    channel: meta.channel ? String(meta.channel) : undefined,
    // Both fall back to pukeko.toml
    model: meta.model ? String(meta.model) : "",
    effort: effort as EffortLevel | "",
    prompt: match[2]!.trim(),
    // One-offs are ISO datetimes, everything else is cron (MON-FRI, @daily and so on)
    oneOff: Boolean(schedule && /^\d{4}-\d{2}-\d{2}T/.test(schedule)),
  };
}

// One-offs are read in the configured timezone unless they carry their own offset
function oneOffTime(schedule: string) {
  const local = schedule.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::([0-5]\d(?:\.\d+)?))?$/,
  );
  if (!local) {
    const at = Date.parse(schedule);
    if (Number.isNaN(at)) throw new Error(`"${schedule}" isn't a valid datetime`);
    return at;
  }
  const [year, month, day, hour, minute] = local.slice(1, 6).map(Number) as [number, ...number[]];
  // Bun.cron.parse does the timezone maths: the first match from just before that day is it
  const around = Date.UTC(year, month! - 1, day);
  let at: Date | null = null;
  try {
    at = Bun.cron.parse(`${minute} ${hour} ${day} ${month} *`, around - 2 * 86_400_000, {
      tz: config.timezone,
    });
  } catch {}
  if (!at || at.getTime() > around + 2 * 86_400_000)
    throw new Error(`"${schedule}" isn't a real date`);
  return at.getTime() + Number(local[6] ?? 0) * 1000;
}

/** When a job next runs, or null for a one-off whose time has passed */
export function nextTime({ schedule, oneOff }: { schedule: string; oneOff: boolean }) {
  if (oneOff) {
    const at = oneOffTime(schedule);
    return at > Date.now() ? new Date(at) : null;
  }
  const at = Bun.cron.parse(schedule, Date.now(), { tz: config.timezone });
  if (!at) throw new Error(`"${schedule}" never runs`);
  return at;
}

/** When a job next runs, in the configured timezone */
export function nextRun(at: Date | null) {
  return at
    ? `next run ${at.toLocaleString(undefined, { timeZone: config.timezone })}`
    : "overdue, runs on start";
}

async function add(id: string, path: string) {
  try {
    return await load(id, path);
  } catch (error) {
    await alert(id, `couldn't load, ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

async function load(id: string, path: string) {
  const { schedule, channel, model, effort, prompt, oneOff } = parseJob(
    await Bun.file(path).text(),
  );
  if (!schedule) {
    stop(id);
    return "off, it has no schedule or enabled: false";
  }
  const job = { schedule, oneOff };
  const run = async () => {
    const started = Date.now();
    log.info(`Running jobs/${id}`);
    try {
      const { reply, error } = await backgroundSession({ model, effort }).run(
        `[Scheduled job: ${id}]\n\n${prompt}`,
      );
      if (error !== undefined) {
        log.report(`jobs/${id} failed after ${seconds(Date.now() - started)}`, error);
        return await alert(id, error);
      }
      const quiet = reply.trim() === "NOTHING";
      if (!quiet) await send(channel, reply);
      failing.delete(id);
      const outcome = quiet ? "nothing to say" : `sent to ${channel ?? "the owner's DMs"}`;
      log.info(
        `jobs/${id} done in ${seconds(Date.now() - started)}, ${outcome}${oneOff ? "" : `, ${nextRun(nextTime(job))}`}`,
      );
      // Deleted only once delivered, so a failed reminder retries on the next start
      if (oneOff) await rm(join(paths.jobs, id), { recursive: true, force: true });
    } catch (error) {
      log.report(`jobs/${id} failed after ${seconds(Date.now() - started)}`, error);
      await alert(id, error instanceof Error ? error.message : String(error));
    }
  };
  const next = nextTime(job);
  stop(id);
  // Bun.cron only takes cron expressions, so one-offs get a timer. It waits for each run to
  // finish before scheduling the next, so a slow job never overlaps itself
  running.set(id, oneOff ? runAt(next, run) : Bun.cron(schedule, run, { tz: config.timezone }));
  return `${schedule}, ${nextRun(next)}`;
}

// A one-off whose time already passed (null) runs now, late beats never
function runAt(time: Date | null, run: () => unknown) {
  let timer: Timer;
  const wait = () => {
    const left = (time?.getTime() ?? 0) - Date.now();
    timer = left > longestTimeout ? setTimeout(wait, longestTimeout) : setTimeout(run, left);
  };
  wait();
  return { stop: () => clearTimeout(timer) };
}

export function startJobs() {
  return watchFolder({ dir: paths.jobs, pattern: "*/job.md", add, remove: stop });
}
