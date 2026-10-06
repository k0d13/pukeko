import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { config, secrets, workspace } from "./config.ts";
import harnessPrompt from "./prompt.md" with { type: "text" };

type Session = ReturnType<typeof createSession>;

const stateDir = join(workspace, ".pukeko");
mkdirSync(stateDir, { recursive: true });

// The server's own `claude` rather than the SDK's bundled one, so the binary
// stays small and Claude Code updates itself
const claudePath = Bun.which("claude");
if (!claudePath) throw new Error("`claude` not found on PATH, install Claude Code first");

// Everything except the conversation, the same for every turn
const baseOptions: Options = {
  cwd: workspace,
  model: config.agent.model || undefined,
  pathToClaudeCodeExecutable: claudePath,
  env: {
    // Drop anything also in .env, in case Bun auto-loaded it from the cwd
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !(key in secrets))),
    TZ: config.timezone,
    CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN,
  },
  systemPrompt: { type: "preset", preset: "claude_code", append: harnessPrompt },
  settingSources: ["project"],
  // Flag settings outrank the workspace's .claude/settings.json, so the agent
  // can't edit its way out of these
  settings: {
    permissions: {
      deny: ["./.env", "./.env.*", "./.pukeko/**"].flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
    },
  },
  // The OS sandbox applies the deny rules to Bash too, so `cat .env` fails as well
  sandbox: config.agent.sandbox
    ? { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }
    : undefined,
  // Single user, so no approval prompts. Deny rules still apply
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
};

// ${VAR} in .mcp.json is filled from .env here, so tokens reach MCP servers
// without ever being in the agent's environment. Read every turn so edits apply
const warned = new Set<string>();
function mcpServers() {
  const path = join(workspace, ".mcp.json");
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!(name in secrets) && !warned.has(name)) {
      warned.add(name);
      console.warn(`.mcp.json uses \${${name}} but .env doesn't define it`);
    }
    return secrets[name] ?? "";
  });
  return JSON.parse(raw).mcpServers ?? {};
}

function now() {
  return new Date().toLocaleString(undefined, {
    timeZone: config.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

// One Claude Code conversation. Turns queue up and run one at a time. With a
// `name` the session ID is saved in .pukeko/ so it resumes across restarts
function createSession(name?: string) {
  const file = name && join(stateDir, `${name}.session`);
  let sessionId = file && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  let current: AbortController | undefined;
  let queue = Promise.resolve();
  // Bumped by forget() so a turn already in flight can't save its ID afterwards
  let generation = 0;

  function forget() {
    generation++;
    sessionId = "";
    if (file) rmSync(file, { force: true });
  }

  async function runTurn(text: string): Promise<string> {
    const abort = (current = new AbortController());
    const turnGeneration = generation;
    const resuming = Boolean(sessionId);
    let started = false;
    let reply = "";
    try {
      const turn = query({
        prompt: `${text}\n\n[Current time: ${now()}]`,
        options: {
          ...baseOptions,
          resume: sessionId || undefined,
          mcpServers: mcpServers(),
          abortController: abort,
        },
      });
      for await (const message of turn) {
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          if (turnGeneration !== generation) continue;
          sessionId = message.session_id;
          if (file) writeFileSync(file, sessionId);
        } else if (message.type === "result") {
          reply =
            message.subtype === "success"
              ? message.result
              : `⚠️ Turn ended early (${message.subtype})`;
        }
      }
      return reply;
    } catch (error) {
      if (abort.signal.aborted) return "⏹️ Stopped";
      console.error(error);
      // A saved session that can't be resumed fails before init, so start fresh
      if (resuming && !started) {
        console.warn(`Couldn't resume session ${sessionId}, starting a new one`);
        forget();
        return runTurn(text);
      }
      return `⚠️ ${error instanceof Error ? error.message : error}`;
    } finally {
      current = undefined;
    }
  }

  return {
    ask(text: string) {
      const turn = queue.then(() => runTurn(text));
      queue = turn.then(() => {});
      return turn;
    },
    // Whether there was a turn to stop
    stop() {
      current?.abort();
      return current !== undefined;
    },
    reset() {
      current?.abort();
      forget();
    },
  };
}

// conversations.scope "channel" gives each channel its own conversation, run in
// parallel; "shared" uses one everywhere
const sessions = new Map<string, Session>();
export function channelSession(channelId: string) {
  const name = config.conversations.scope === "shared" ? "shared" : `channel-${channelId}`;
  let session = sessions.get(name);
  if (!session) sessions.set(name, (session = createSession(name)));
  return session;
}

// Scheduled jobs share one conversation, kept out of the chat ones and
// forgotten on restart
export const jobSession = createSession();
