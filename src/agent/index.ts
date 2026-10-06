import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EffortLevel, type Options, type Query, query } from "@anthropic-ai/claude-agent-sdk";
import { config, secrets, workspace } from "../config.ts";
import harnessPrompt from "./prompt.md" with { type: "text" };

type Session = ReturnType<typeof createSession>;

// Picked with /new and fixed for the life of a conversation, since switching
// partway through loses the prompt cache
export type Setup = { model: string; effort: EffortLevel | "" };

const stateDir = join(workspace, ".pukeko");
mkdirSync(stateDir, { recursive: true });

// The server's own `claude` rather than the SDK's bundled one, so the binary
// stays small and Claude Code updates itself
const claudePath = Bun.which("claude");
if (!claudePath) throw new Error("`claude` not found on PATH, install Claude Code first");

// Everything except the conversation, the same for every turn
const baseOptions: Options = {
  cwd: workspace,
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

// A prompt that never sends, so control requests can run against a
// conversation without starting a turn
async function* idle(): AsyncGenerator<never> {
  await new Promise(() => {});
}

// One Claude Code conversation. Turns queue up and run one at a time. With a
// `name` it's saved in .pukeko/ so it resumes across restarts
function createSession(name?: string) {
  const file = name && join(stateDir, `${name}.json`);
  let state: Setup & { id: string } = {
    model: config.agent.model,
    effort: config.agent.effort,
    id: "",
    ...(file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}),
  };
  let current: AbortController | undefined;
  let queue = Promise.resolve();
  // Bumped by restart() so a turn already in flight can't save its ID afterwards
  let generation = 0;

  function save() {
    if (file) writeFileSync(file, JSON.stringify(state));
  }

  function options(): Options {
    return {
      ...baseOptions,
      model: state.model || undefined,
      effort: state.effort || undefined,
      resume: state.id || undefined,
      mcpServers: mcpServers(),
    };
  }

  function restart(setup: Partial<Setup> = {}) {
    generation++;
    state = { ...state, ...setup, id: "" };
    save();
  }

  async function runTurn(prompt: string): Promise<string> {
    const abort = (current = new AbortController());
    const turnGeneration = generation;
    const resuming = Boolean(state.id);
    let started = false;
    let reply = "";
    try {
      for await (const message of query({
        prompt,
        options: { ...options(), abortController: abort },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          if (turnGeneration !== generation) continue;
          state.id = message.session_id;
          save();
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
        console.warn(`Couldn't resume session ${state.id}, starting a new one`);
        restart();
        return runTurn(prompt);
      }
      return `⚠️ ${error instanceof Error ? error.message : error}`;
    } finally {
      current = undefined;
    }
  }

  function enqueue(prompt: string) {
    const turn = queue.then(() => runTurn(prompt));
    queue = turn.then(() => {});
    return turn;
  }

  return {
    get setup(): Setup {
      return { model: state.model, effort: state.effort };
    },
    ask(text: string) {
      return enqueue(`${text}\n\n[Current time: ${now()}]`);
    },
    // Claude Code's own /compact, summarising the conversation so far
    async compact() {
      if (!state.id) return "Nothing to compact yet";
      const reply = await enqueue("/compact");
      return reply.startsWith("⚠️") || reply.startsWith("⏹️") ? reply : "🗜️ Conversation compacted";
    },
    // Runs `fn` against this conversation without sending anything to Claude
    async inspect<T>(fn: (query: Query) => Promise<T>) {
      const q = query({ prompt: idle(), options: options() });
      try {
        return await fn(q);
      } finally {
        q.close();
      }
    },
    // Whether there was a turn to stop
    stop() {
      current?.abort();
      return current !== undefined;
    },
    // Ends the conversation. Fields in `setup` change the next one's model or
    // effort, the rest carry over
    reset(setup: Partial<Setup> = {}) {
      current?.abort();
      restart(setup);
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
