import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { channelSession, jobs } from "./agent.ts";
import { config, workspace } from "./config.ts";
import { resolveChannel, send } from "./discord.ts";

const jobsDir = join(workspace, "jobs");
const running = new Map<string, { cron: Cron; snapshot: string }>();

// jobs/<id>/job.md: "---\nkey: value\n---\nprompt"
function readJob(id: string) {
  const path = join(jobsDir, id, "job.md");
  if (!existsSync(path)) return;
  const match = readFileSync(path, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    console.warn(`jobs/${id}: no frontmatter`);
    return;
  }
  const meta: Record<string, string> = Object.fromEntries(
    match[1]!
      .split(/\r?\n/)
      .filter((line) => line.indexOf(":") > 0 && !line.trimStart().startsWith("#"))
      .map((line) => {
        const i = line.indexOf(":");
        return [
          line.slice(0, i).trim(),
          line
            .slice(i + 1)
            .trim()
            .replace(/^["']|["']$/g, ""),
        ];
      }),
  );
  if (meta.enabled === "false" || !meta.schedule) return;
  return { id, meta, prompt: match[2]!.trim() };
}

function schedule(job: Exclude<ReturnType<typeof readJob>, undefined>) {
  const { id, meta, prompt } = job;
  // One-offs are ISO datetimes; everything else is cron (including MON-FRI, @daily).
  const oneOff = /^\d{4}-\d{2}-\d{2}T/.test(meta.schedule!);
  const cron = new Cron(meta.schedule!, { timezone: config.timezone, protect: true }, async () => {
    try {
      console.log(`Running job ${id}`);
      const session =
        meta.session === "channel" ? channelSession((await resolveChannel(meta.channel)).id) : jobs;
      const reply = await session.ask(`[Scheduled job: ${id}]\n\n${prompt}`);
      if (reply.trim() !== "NOTHING") await send(meta.channel, reply);
      // Only delete once delivered, so a failed reminder retries on next start.
      if (oneOff) rmSync(join(jobsDir, id), { recursive: true, force: true });
    } catch (error) {
      console.error(`jobs/${id} failed`, error);
    }
  });
  // A one-off whose time has already passed: run it now, late beats never.
  if (oneOff && !cron.nextRun()) cron.trigger();
  return cron;
}

// Only (re)create jobs whose files changed, so unchanged ones keep running.
function load() {
  const found = existsSync(jobsDir)
    ? readdirSync(jobsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => readJob(d.name))
        .filter((job) => job !== undefined)
    : [];
  const seen = new Set<string>();
  for (const job of found) {
    seen.add(job.id);
    const snapshot = JSON.stringify(job);
    if (running.get(job.id)?.snapshot === snapshot) continue;
    running.get(job.id)?.cron.stop();
    running.delete(job.id);
    try {
      running.set(job.id, { cron: schedule(job), snapshot });
      console.log(`Scheduled job ${job.id}`);
    } catch (error) {
      console.warn(`jobs/${job.id}: bad schedule "${job.meta.schedule}"`, error);
    }
  }
  for (const [id, { cron }] of running)
    if (!seen.has(id)) {
      cron.stop();
      running.delete(id);
    }
}

export function startJobs() {
  load();
  setInterval(load, 60_000);
}
