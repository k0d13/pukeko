import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { jobSession } from "./agent.ts";
import { config, workspace } from "./config.ts";
import { send } from "./discord.ts";

type Job = { id: string; schedule: string; channel?: string; prompt: string };

const jobsDir = join(workspace, "jobs");
const running = new Map<string, { cron: Cron; snapshot: string }>();

// jobs/<id>/job.md is YAML frontmatter, then the prompt
function readJob(id: string): Job | undefined {
  const path = join(jobsDir, id, "job.md");
  if (!existsSync(path)) return;
  const match = readFileSync(path, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
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
      const reply = await jobSession.ask(`[Scheduled job: ${id}]\n\n${prompt}`);
      if (reply.trim() !== "NOTHING") await send(channel, reply);
      // Deleted only once delivered, so a failed reminder retries on the next start
      if (oneOff) rmSync(join(jobsDir, id), { recursive: true, force: true });
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
function load() {
  const dirs = existsSync(jobsDir) ? readdirSync(jobsDir, { withFileTypes: true }) : [];
  const jobs = dirs.filter((d) => d.isDirectory()).map((d) => readJob(d.name));
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

export function startJobs() {
  load();
  setInterval(load, 60_000);
}
