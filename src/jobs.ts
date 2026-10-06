import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Cron } from "croner";
import { createSession, type Session } from "#/agent/index.ts";
import { config } from "#/core/config.ts";
import { paths } from "#/core/paths.ts";
import { send } from "#/discord/index.ts";

type Job = { id: string; schedule: string; channel?: string; prompt: string };

const running = new Map<string, { cron: Cron; snapshot: string }>();
// Shared by every job, kept out of the chats and forgotten on restart
let session: Session;

// jobs/<id>/job.md is YAML frontmatter, then the prompt
async function readJob(id: string): Promise<Job | undefined> {
  // Gone since the scan when a one-off just ran
  const text = await Bun.file(join(paths.jobs, id, "job.md"))
    .text()
    .catch(() => undefined);
  if (text === undefined) return;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return void console.warn(`jobs/${id}: no frontmatter`);
  try {
    const meta = (Bun.YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
    if (meta.enabled === false || !meta.schedule) return;
    return {
      id,
      schedule: String(meta.schedule),
      channel: meta.channel ? String(meta.channel) : undefined,
      prompt: match[2]!.trim(),
    };
  } catch (error) {
    console.warn(`jobs/${id}: bad frontmatter`, error);
  }
}

function schedule({ id, schedule, channel, prompt }: Job) {
  // One-offs are ISO datetimes, everything else is cron (MON-FRI, @daily and so on)
  const oneOff = /^\d{4}-\d{2}-\d{2}T/.test(schedule);
  const cron = new Cron(schedule, { timezone: config.timezone, protect: true }, async () => {
    try {
      console.log(`Running job ${id}`);
      const reply = await session.ask(`[Scheduled job: ${id}]\n\n${prompt}`);
      if (reply.trim() !== "NOTHING") await send(channel, reply);
      // Deleted only once delivered, so a failed reminder retries on the next start
      if (oneOff) await rm(join(paths.jobs, id), { recursive: true, force: true });
    } catch (error) {
      console.error(`jobs/${id} failed`, error);
    }
  });
  // A one-off whose time already passed runs now, late beats never
  if (oneOff && !cron.nextRun()) cron.trigger();
  return cron;
}

function stop(id: string) {
  running.get(id)?.cron.stop();
  running.delete(id);
}

// Rescans jobs/, (re)scheduling only what changed so unchanged jobs keep their timers
async function load() {
  const glob = new Bun.Glob("*/job.md");
  const ids = await Array.fromAsync(glob.scan({ cwd: paths.jobs }), dirname).catch(() => []);
  const jobs = await Promise.all(ids.map(readJob));
  const found = new Set<string>();
  for (const job of jobs) {
    if (!job) continue;
    found.add(job.id);
    const snapshot = JSON.stringify(job);
    if (running.get(job.id)?.snapshot === snapshot) continue;
    stop(job.id);
    try {
      running.set(job.id, { cron: schedule(job), snapshot });
      console.log(`Scheduled job ${job.id}`);
    } catch (error) {
      console.warn(`jobs/${job.id}: bad schedule "${job.schedule}"`, error);
    }
  }
  for (const id of running.keys()) if (!found.has(id)) stop(id);
}

export async function startJobs() {
  session = createSession();
  await mkdir(paths.jobs, { recursive: true });
  await load();
  setInterval(() => load().catch(console.error), 60_000);
}
