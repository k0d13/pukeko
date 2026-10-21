import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  type EffortLevel,
  type Options,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { config, idleLimit, secrets } from "#/core/config.ts";
import { readJson, write } from "#/core/files.ts";
import { logger, preview, seconds } from "#/core/log.ts";
import { paths } from "#/core/paths.ts";
import harnessPrompt from "./prompt.md" with { type: "text" };

export type Session = ReturnType<typeof createSession>;

/** Picked with /new and fixed for a conversation, since switching partway loses the prompt cache */
export type Setup = { model: string; effort: EffortLevel | "" };
// `last` is when its last turn finished, for the idle timeout
type State = Setup & { id: string; last?: number };
/** Gets the text written before each tool call, as it happens */
export type OnUpdate = (text: string) => Promise<unknown>;

const log = logger("agent");
const warned = new Set<string>();

// ${VAR} is filled from .env here, so tokens reach MCP servers but never the agent's
// environment. Read every turn so edits apply. The result goes to a private file whose
// path is passed to claude, since the SDK's mcpServers option puts the JSON, tokens and
// all, on claude's command line where anything that can list processes can read it
async function mcpConfig(): Promise<Record<string, string>> {
  const file = Bun.file(paths.mcp);
  if (!(await file.exists())) return {};
  const raw = (await file.text()).replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!(name in secrets) && !warned.has(name)) {
      warned.add(name);
      log.warn(`.mcp.json uses \${${name}} but .env doesn't define it`);
    }
    return secrets[name] ?? "";
  });
  const mcpServers = JSON.parse(raw).mcpServers ?? {};
  if (!Object.keys(mcpServers).length) return {};
  const path = join(paths.state, "mcp.json");
  // Written aside then renamed, so a turn starting in another conversation never reads half a file
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await mkdir(paths.state, { recursive: true });
  await Bun.write(temp, JSON.stringify({ mcpServers }));
  await chmod(temp, 0o600);
  await rename(temp, path);
  return { "mcp-config": path };
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
      // No Claude co-author trailer or link on the agent's commits and PRs
      attribution: { commit: "", pr: "" },
      // Compacting sooner keeps every turn from resending a huge context
      autoCompactWindow: config.conversations.context,
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
    extraArgs: await mcpConfig(),
  };
}

function now() {
  return new Date().toLocaleString(undefined, {
    timeZone: config.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

// What a tool was pointed at, for the log
function target(input: Record<string, unknown>) {
  const value =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.description;
  return typeof value === "string" ? ` ${preview(value, 100)}` : "";
}

function tokens(count = 0) {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/** A base64 image passed straight into the prompt */
export type Image = {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
};

// A message waiting on the turn that answers it
type Waiting = { uuid: string; prompt: string; images?: Image[]; done: (reply: string) => void };
type Live = { chat?: string; onUpdate?: OnUpdate; add: (message: Waiting) => void };

/** A prompt stream for one query, so messages can be added while it runs */
function inbox() {
  const queued: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push({ uuid, prompt, images = [] }: Waiting) {
      const content = images.length
        ? [
            ...images.map(({ mediaType, data }) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: mediaType, data },
            })),
            { type: "text" as const, text: prompt },
          ]
        : prompt;
      queued.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        uuid: uuid as SDKUserMessage["uuid"],
      });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *messages() {
      while (true) {
        while (queued.length) yield queued.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/** One conversation, running turns one at a time. With a `file` it resumes across restarts */
export function createSession(name: string, file?: string, saved?: Partial<State>) {
  let state: State = { model: config.agent.model, effort: config.agent.effort, id: "", ...saved };
  let current: AbortController | undefined;
  // The turn running now, which messages from its chat can join
  let live: Live | undefined;
  let queue = Promise.resolve();
  // Bumped by restart() so a turn already in flight can't save its ID afterwards
  let generation = 0;

  function save() {
    if (file) void write(file, JSON.stringify(state));
  }

  function restart(setup: Partial<Setup> = {}) {
    if (state.id) log.info(`${name}: conversation ${state.id.slice(0, 8)} ended`);
    generation++;
    state = { ...state, ...setup, id: "" };
    save();
  }

  async function runTurn(waiting: Waiting[], onUpdate?: OnUpdate, chat?: string): Promise<void> {
    const abort = (current = new AbortController());
    const turnGeneration = generation;
    const resuming = Boolean(state.id);
    const input = inbox();
    const turn: Live = {
      chat,
      onUpdate,
      add(message) {
        waiting.push(message);
        input.push(message);
      },
    };
    live = turn;
    for (const message of waiting) input.push(message);
    let started = false;
    // Text waits until a tool call shows it isn't the final reply, which the result carries
    let pending = "";
    let updates = Promise.resolve();
    const flush = () => {
      const text = pending.trim();
      const post = turn.onUpdate;
      pending = "";
      if (!text || !post || !config.agent.updates) return;
      updates = updates.then(() =>
        post(text).then(
          () => {},
          (error) => log.warn(`${name}: couldn't post an update`, error),
        ),
      );
    };
    // The latest message a result answered gets the reply, which covers the ones before it.
    // Once nothing's waiting, no more can join and the query ends
    const settle = (uuids: string[], reply: string) => {
      const answered = waiting.filter((message) => uuids.includes(message.uuid));
      waiting = waiting.filter((message) => !uuids.includes(message.uuid));
      updates = updates.then(() =>
        answered.forEach((message, i) => message.done(i === answered.length - 1 ? reply : "")),
      );
      if (waiting.length) return;
      input.close();
      if (live === turn) live = undefined;
    };
    const all = () => waiting.map((message) => message.uuid);
    const begun = Date.now();
    log.info(
      `${name}: turn started, ${resuming ? `resuming ${state.id.slice(0, 8)}` : "new conversation"}, ${state.model || "default model"}${state.effort ? `, ${state.effort} effort` : ""}: ${preview(waiting[0]!.prompt)}`,
    );
    try {
      for await (const message of query({
        prompt: input.messages(),
        options: { ...(await options(state)), abortController: abort },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          started = true;
          if (turnGeneration !== generation) continue;
          state.id = message.session_id;
          save();
        } else if (message.type === "assistant") {
          for (const block of message.message.content)
            if (block.type === "text") pending += `\n\n${block.text}`;
            else if (block.type === "tool_use") {
              flush();
              log.info(`${name}: ${block.name}${target(block.input as Record<string, unknown>)}`);
            }
        } else if (message.type === "result") {
          pending = "";
          const reply =
            message.subtype === "success"
              ? message.result
              : `⚠️ Turn ended early (${message.subtype})`;
          const { input_tokens, output_tokens, cache_read_input_tokens } = message.usage;
          const line = `${name}: turn ${message.subtype === "success" ? "done" : `ended early (${message.subtype})`} in ${seconds(message.duration_ms)}, ${message.num_turns} steps, ${tokens(input_tokens + (cache_read_input_tokens ?? 0))} tokens in (${tokens(cache_read_input_tokens ?? 0)} cached), ${tokens(output_tokens)} out, ${reply.length} characters back`;
          if (message.subtype === "success") log.info(line);
          else log.warn(line);
          if (turnGeneration === generation) {
            state.last = Date.now();
            save();
          }
          // Older CLIs don't say which messages a result answered
          settle(message.user_message_uuids ?? all(), reply);
        }
      }
      if (waiting.length) settle(all(), "⚠️ Turn ended without a reply");
    } catch (error) {
      if (abort.signal.aborted) {
        log.info(`${name}: turn stopped after ${seconds(Date.now() - begun)}`);
        settle(all(), "⏹️ Stopped");
        return;
      }
      log.error(`${name}: turn failed after ${seconds(Date.now() - begun)}`, error);
      // A saved session that can't be resumed fails before init, so start fresh
      if (resuming && !started) {
        log.warn(`${name}: couldn't resume ${state.id}, starting a new conversation`);
        input.close();
        restart();
        return runTurn(waiting, turn.onUpdate, chat);
      }
      settle(all(), `⚠️ ${error instanceof Error ? error.message : error}`);
    } finally {
      if (current === abort) current = undefined;
      if (live === turn) live = undefined;
      input.close();
      // So the reply never lands before an update
      await updates;
    }
  }

  // A conversation left quiet past conversations.idle starts over: its prompt cache is long
  // gone, so resuming would resend all of it at full price
  function freshIfIdle(prompt: string) {
    const limit = idleLimit();
    if (!state.id || !state.last || !limit || Date.now() - state.last < limit) return prompt;
    log.info(`${name}: idle since ${new Date(state.last).toISOString()}, starting fresh`);
    restart();
    return `[New conversation: the last one here went quiet for over ${config.conversations.idle}]\n\n${prompt}`;
  }

  function enqueue(prompt: string, onUpdate?: OnUpdate, chat?: string, images?: Image[]) {
    return new Promise<string>((done) => {
      const message = { uuid: crypto.randomUUID(), prompt, images, done };
      if (chat && live?.chat === chat) {
        log.info(`${name}: fed into the running turn: ${preview(prompt)}`);
        if (onUpdate) live.onUpdate = onUpdate;
        live.add(message);
        return;
      }
      queue = queue.then(() =>
        runTurn([{ ...message, prompt: freshIfIdle(prompt) }], onUpdate, chat),
      );
    });
  }

  return {
    get setup(): Setup {
      return { model: state.model, effort: state.effort };
    },
    /**
     * `onUpdate` posts progress as the turn goes; without it only the reply comes back. Asks from
     * the same `chat` while a turn runs are fed into it, and it posts from then on through the
     * latest one's `onUpdate`. The latest gets the reply; the others get "". `images` go in ahead
     * of the text
     */
    ask(text: string, onUpdate?: OnUpdate, chat?: string, images?: Image[]) {
      return enqueue(`${text}\n\n[Current time: ${now()}]`, onUpdate, chat, images);
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
    session = readJson<Partial<State>>(file, {}).then((saved) => createSession(name, file, saved));
    sessions.set(name, session);
  }
  return session;
}

const background = new Map<string, Session>();

/**
 * Shared by jobs and handlers, kept out of the chats and forgotten on restart. A model or effort
 * other than the configured one gets a conversation of its own, since switching partway loses the
 * prompt cache
 */
export function backgroundSession({ model, effort }: Partial<Setup> = {}) {
  const setup: Setup = {
    model: model || config.agent.model,
    effort: effort || config.agent.effort,
  };
  const custom = setup.model !== config.agent.model || setup.effort !== config.agent.effort;
  const name = custom
    ? `background ${setup.model || "default"} ${setup.effort}`.trim()
    : "background";
  let session = background.get(name);
  if (!session) {
    session = createSession(name, undefined, setup);
    background.set(name, session);
  }
  return session;
}
