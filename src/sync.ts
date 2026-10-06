import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "#/core/paths.ts";

let lastError = "";

// Fast-forward only, so it never merges over or stashes the agent's own uncommitted work
// If the agent has unpushed commits this fails until it pulls and pushes them itself
async function pull() {
  const proc = Bun.spawn(["git", "pull", "--ff-only", "--quiet"], {
    cwd: paths.workspace,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const error = (await new Response(proc.stderr).text()).trim();
  if ((await proc.exited) === 0) return void (lastError = "");
  // Logged once per distinct failure, not every minute
  if (error !== lastError) console.warn(`Workspace pull failed: ${error}`);
  lastError = error;
}

/** Keeps a git workspace in step with its remote, so pushed edits reach the agent within a minute */
export async function startSync() {
  if (!existsSync(join(paths.workspace, ".git"))) return;
  await pull();
  setInterval(() => pull().catch(console.error), 60_000);
}
