import { rm } from "node:fs/promises";
import { join } from "node:path";
import { channelSession, type OnUpdate } from "#/agent/index.ts";
import { readJson } from "#/core/files.ts";
import { logger } from "#/core/log.ts";
import { paths } from "#/core/paths.ts";
import { version } from "#/core/release.ts";
import { client, poster, send, whileTyping } from "./client.ts";

type Note = { channel: string; version: string; cutOff: boolean };

const log = logger("discord");
// A restart this soon after a chat turn was most likely asked for there
const recent = 10 * 60_000;
const running = new Map<string, number>();
// Channels finishing a cut-off turn, so a turn that keeps restarting Pukeko only gets one more go
const retrying = new Set<string>();
let last: { channel: string; at: number } | undefined;

function file() {
  return join(paths.state, "restart.json");
}

/** A chat turn in that channel's conversation, noted so a restart can report back there */
export async function chatTurn(channel: string, prompt: string, onUpdate?: OnUpdate) {
  running.set(channel, (running.get(channel) ?? 0) + 1);
  try {
    return await (await channelSession(channel)).ask(prompt, onUpdate);
  } finally {
    running.set(channel, running.get(channel)! - 1);
    if (!running.get(channel)) running.delete(channel);
    last = { channel, at: Date.now() };
  }
}

// Turns cut off by the shutdown, or else the channel that just talked to Pukeko
async function shutdown(signal: string) {
  const notes: Note[] = [...running.keys()].map((channel) => ({
    channel,
    version,
    cutOff: !retrying.has(channel),
  }));
  if (!notes.length && last && Date.now() - last.at < recent)
    notes.push({ channel: last.channel, version, cutOff: false });
  if (notes.length) await Bun.write(file(), JSON.stringify(notes));
  log.info(
    `Stopping on ${signal}${notes.length ? `, will report back in ${notes.map((n) => n.channel).join(", ")}` : ""}`,
  );
  process.exit(0);
}

export function noteRestarts() {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => void shutdown(signal));
}

/** Says Pukeko's back where it was last talked to, and finishes any turn the restart cut off */
export async function backOnline() {
  const notes = await readJson<Note[]>(file(), []);
  await rm(file(), { force: true });
  for (const note of notes) {
    const change = note.version === version ? `on ${version}` : `${note.version} → ${version}`;
    if (!note.cutOff) {
      await send(note.channel, `-# 🔁 Back up, ${change}`).catch((error) =>
        log.warn(`Couldn't say I'm back in ${note.channel}`, error),
      );
      continue;
    }
    log.info(`Finishing the turn a restart cut off in ${note.channel}`);
    const channel = await client.channels.fetch(note.channel).catch(() => null);
    if (!channel?.isSendable()) {
      log.warn(`Can't post in ${note.channel} to finish the turn there`);
      continue;
    }
    const post = poster((c) => channel.send(c));
    retrying.add(note.channel);
    void (async () => {
      await post(`-# 🔁 Back up, ${change}, picking up where I left off`);
      const reply = await whileTyping(channel, () =>
        chatTurn(
          note.channel,
          `[Pukeko restarted (${change}) partway through your last turn here, which was cut off. Check what got done, finish it if it still makes sense, and report back]`,
          post,
        ),
      );
      await post(reply);
    })()
      .catch((error) => log.error(`Couldn't finish the cut-off turn in ${note.channel}`, error))
      .finally(() => retrying.delete(note.channel));
  }
}
