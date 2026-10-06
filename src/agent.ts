import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, secrets, workspace } from "./config.ts";
import harnessPrompt from "./prompt.md" with { type: "text" };

const stateDir = join(workspace, ".pukeko");
mkdirSync(stateDir, { recursive: true });

// Use the server's installed `claude` rather than the SDK's bundled one, so the
// compiled binary stays small and Claude Code updates on its own.
const claudePath = Bun.which("claude") ?? undefined;
if (!claudePath) throw new Error("`claude` not found on PATH. Install Claude Code first.");

// Passed as flag settings, which outrank anything in the workspace's own
// .claude/settings.json, so the agent can't edit its way out of them.
const settings = {
  permissions: {
    deny: ["./.env", "./.env.*", "./.pukeko/**"].flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
  },
};

// ${VAR} in .mcp.json is filled from .env here, so tokens reach MCP servers
// without ever being in the agent's environment.
function mcpServers() {
  const path = join(workspace, ".mcp.json");
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").replace(/\$\{(\w+)\}/g, (_, name) => secrets[name] ?? "");
  return JSON.parse(raw).mcpServers ?? {};
}

function now() {
  return new Date().toLocaleString("en-NZ", {
    timeZone: config.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

// A session is one Claude Code conversation with its own queue: turns run one
// at a time, in order. With a `name`, its ID is saved under .pukeko/ and it
// resumes across restarts; without one, it lasts until the process exits.
function createSession(name?: string) {
  const file = name && join(stateDir, `${name}.session`);
  let sessionId =
    file && existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
  let current: AbortController | undefined;
  let queue = Promise.resolve();
  // Bumped by reset() so a turn already in flight can't write its ID back.
  let generation = 0;

  async function runTurn(text: string, retry = true): Promise<string> {
    current = new AbortController();
    const turnGeneration = generation;
    const resumed = sessionId;
    let started = false;
    let reply = "";
    try {
      for await (const message of query({
        prompt: `${text}\n\n[Current time: ${now()}]`,
        options: {
          cwd: workspace,
          resume: sessionId,
          model: config.model,
          pathToClaudeCodeExecutable: claudePath,
          env: {
            // Drop anything also in .env, in case Bun auto-loaded it from the cwd.
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !(key in secrets))),
            TZ: config.timezone,
            CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN,
          },
          systemPrompt: { type: "preset", preset: "claude_code", append: harnessPrompt },
          settingSources: ["project"],
          settings,
          // Bash runs in an OS sandbox (bubblewrap on Linux) that enforces the
          // deny rules above, so `cat .env` is blocked too, not just Read.
          sandbox: config.sandbox
            ? { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }
            : undefined,
          mcpServers: mcpServers(),
          // Single-user box: no approval prompts. Deny rules still apply.
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController: current,
        },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          if (turnGeneration !== generation) continue;
          sessionId = message.session_id;
          if (file) writeFileSync(file, sessionId);
        }
        if (message.type === "result")
          reply =
            message.subtype === "success"
              ? message.result
              : `⚠️ Turn ended early (${message.subtype}).`;
      }
    } catch (error) {
      if (current.signal.aborted) return "⏹️ Stopped.";
      console.error(error);
      // A saved session that can't be resumed fails before init; start fresh once.
      if (resumed && !started && retry) {
        console.warn(`Couldn't resume session ${resumed}; starting a new one`);
        forget();
        return runTurn(text, false);
      }
      return `⚠️ ${error instanceof Error ? error.message : error}`;
    } finally {
      current = undefined;
    }
    return reply;
  }

  function forget() {
    generation++;
    sessionId = undefined;
    if (file) rmSync(file, { force: true });
  }

  return {
    ask(text: string) {
      const turn = queue.then(() => runTurn(text));
      queue = turn.then(() => {});
      return turn;
    },
    stop() {
      current?.abort();
      return Boolean(current);
    },
    reset() {
      current?.abort();
      forget();
    },
  };
}

// One conversation per Discord channel (a DM is a channel too), each resumed
// across restarts. Different channels run in parallel. --new wipes them all.
if (process.argv.includes("--new"))
  for (const file of readdirSync(stateDir))
    if (file.endsWith(".session")) rmSync(join(stateDir, file));
const channels = new Map<string, ReturnType<typeof createSession>>();

export function channelSession(channelId: string) {
  let session = channels.get(channelId);
  if (!session) {
    session = createSession(`channel-${channelId}`);
    channels.set(channelId, session);
  }
  return session;
}

// Scheduled jobs, kept apart so they don't clutter conversations. A job can
// set `session: channel` to run in the conversation of the channel it posts to.
export const jobs = createSession();
