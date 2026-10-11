import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { paths } from "#/core/paths.ts";

/** Filled in once logged in */
export const owner = { id: "" };

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Under Discord's 2000 character limit, split on newlines where possible
function chunks(text: string) {
  const out: string[] = [];
  let rest = text.trim() || "(no reply)";
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf("\n", 1900);
    if (cut < 1000) cut = 1900;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

type Payload = { content: string; files?: string[] };

// The agent attaches files with a line of `[attach: path]`, relative to the workspace
// Discord takes up to 10 per message
function attachments(text: string) {
  const files: string[] = [];
  const missing: string[] = [];
  const rest = text.replace(/^[ \t]*\[attach:\s*(.+?)\s*\][ \t]*$\n?/gim, (_, path: string) => {
    const file = resolve(paths.workspace, path);
    if (existsSync(file) && files.length < 10) files.push(file);
    else missing.push(path);
    return "";
  });
  const note = missing.length ? `\n-# Couldn't attach ${missing.join(", ")}` : "";
  return { text: rest + note, files };
}

export async function deliver(
  reply: string,
  first: (payload: Payload) => Promise<unknown>,
  rest: (payload: Payload) => Promise<unknown>,
) {
  const { text, files } = attachments(reply);
  // An image on its own needs no "(no reply)" above it
  const parts =
    files.length && !text.trim()
      ? [{ content: "" } as Payload]
      : chunks(text).map((content): Payload => ({ content }));
  // Files go with the last chunk, so they land under the whole reply
  if (files.length) parts.at(-1)!.files = files;
  const [head, ...tail] = parts;
  await first(head!);
  for (const part of tail) await rest(part);
}

/** Posts to a channel, or to the owner's DMs without one */
export async function send(channelId: string | undefined, text: string) {
  const channel = channelId
    ? await client.channels.fetch(channelId)
    : await (await client.users.fetch(owner.id)).createDM();
  if (!channel?.isSendable()) throw new Error(`Can't send to channel ${channelId}`);
  await deliver(
    text,
    (c) => channel.send(c),
    (c) => channel.send(c),
  );
}
