import { join } from "node:path";
import {
  type EffortLevel,
  type Options,
  type Query,
  query,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { config, secrets } from "#/core/config.ts";
import { paths } from "#/core/paths.ts";
import harnessPrompt from "./prompt.md" with { type: "text" };

export type Session = ReturnType<typeof createSession>;

/** Picked with /new and fixed for a conversation, since switching partway loses the prompt cache */
export type Setup = { model: string; effort: EffortLevel | "" };
type State = Setup & { id: string };

const warned = new Set<string>();

// ${VAR} is filled from .env here, so tokens reach MCP servers but never the agent's
// environment. Read every turn so edits apply
async function mcpServers() {
  const file = Bun.file(paths.mcp);
  if (!(await file.exists())) return {};
  const raw = (await file.text()).replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!(name in secrets) && !warned.has(name)) {
      warned.add(name);
      console.warn(`.mcp.json uses \${${name}} but .env doesn't define it`);
    }
    return secrets[name] ?? "";
  });
  return JSON.parse(raw).mcpServers ?? {};
}

async function options(state: State): Promise<Options> {
  return {
    cwd: paths.workspace,
    // The server's own `claude`, so the binary stays small and Claude Code updates itself
    pathToClaudeCodeExecutable: Bun.which("claude")!,
    env: {
      // Drop anything also in .env, in case Bun auto-loaded it from the cwd
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !(key in secrets))),
      TZ: config.timezone,
      CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN,
    },
    systemPrompt: { type: "preset", preset: "claude_code", append: harnessPrompt },
    settingSources: ["project"],
    // Flag settings outrank the workspace's own, so the agent can't edit its way into harness state
    settings: {
      permissions: {
        deny: ["./.pukeko/**"].flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
      },
    },
    // The OS sandbox applies the deny rules to Bash too
    sandbox: config.agent.sandbox
      ? { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }
      : undefined,
    // Single user, so no approval prompts. Deny rules still apply
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    model: state.model || undefined,
    effort: state.effort || undefined,
    resume: state.id || undefined,
    mcpServers: await mcpServers(),
  };
}

function now() {
  return new Date().toLocaleString(undefined, {
    timeZone: config.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

/** Plan usage from the last turn's rate limit headers, which `claude setup-token` logins also get */
export const planLimits = new Map<string, { percent: number; resetsAt: number }>();
export let planLimitsSeen: Date | undefined;

function recordLimits(info: SDKRateLimitInfo) {
  // unifiedWindows isn't in the SDK's types yet, but carries every window at once
  type Windows = Record<string, { utilization?: number; resetsAt?: number }>;
  const windows = (info as { unifiedWindows?: Windows }).unifiedWindows ?? {
    [info.rateLimitType ?? ""]: info,
  };
  for (const [type, { utilization, resetsAt }] of Object.entries(windows))
    if (type && utilization !== undefined)
      planLimits.set(type, { percent: utilization * 100, resetsAt: (resetsAt ?? 0) * 1000 });
  planLimitsSeen = new Date();
}

// Never sends, so control requests can run without starting a turn
async function* idle(): AsyncGenerator<never> {
  await new Promise(() => {});
}

/** One conversation, running turns one at a time. With a `file` it resumes across restarts */
export function createSession(file?: string, saved?: Partial<State>) {
  let state: State = { model: config.agent.model, effort: config.agent.effort, id: "", ...saved };
  let current: AbortController | undefined;
  let queue = Promise.resolve();
  // Bumped by restart() so a turn already in flight can't save its ID afterwards
  let generation = 0;
  // Chained so an older state never lands after a newer one
  let saving = Promise.resolve();

  function save() {
    if (!file) return;
    const json = JSON.stringify(state);
    saving = saving.then(() => Bun.write(file, json)).then(() => {}, console.error);
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
        options: { ...(await options(state)), abortController: abort },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          if (turnGeneration !== generation) continue;
          state.id = message.session_id;
          save();
        } else if (message.type === "rate_limit_event") {
          recordLimits(message.rate_limit_info);
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
    async compact() {
      if (!state.id) return "Nothing to compact yet";
      const reply = await enqueue("/compact");
      return reply.startsWith("⚠️") || reply.startsWith("⏹️") ? reply : "🗜️ Conversation compacted";
    },
    /** Runs `fn` against this conversation without sending anything to Claude */
    async inspect<T>(fn: (query: Query) => Promise<T>) {
      const q = query({ prompt: idle(), options: await options(state) });
      try {
        return await fn(q);
      } finally {
        q.close();
      }
    },
    /** Whether there was a turn to stop */
    stop() {
      current?.abort();
      return current !== undefined;
    },
    /** Ends the conversation. `setup` changes the next one's model or effort */
    reset(setup: Partial<Setup> = {}) {
      current?.abort();
      restart(setup);
    },
  };
}

const sessions = new Map<string, Promise<Session>>();

/** Per channel, run in parallel, or one shared, per `conversations.scope` */
export function channelSession(channelId: string) {
  const name = config.conversations.scope === "shared" ? "shared" : `channel-${channelId}`;
  let session = sessions.get(name);
  if (!session) {
    const file = join(paths.state, `${name}.json`);
    session = Bun.file(file)
      .json()
      .catch((error) => {
        if (error?.code !== "ENOENT") console.warn(`Couldn't read ${file}, starting fresh`, error);
      })
      .then((saved: Partial<State> | undefined) => createSession(file, saved));
    sessions.set(name, session);
  }
  return session;
}
