import { join } from "node:path";
import { channelSession, createSession, type Session } from "#/agent/index.ts";
import { paths } from "#/core/paths.ts";

// What handlers get from `import ... from "pukeko"`
export { config } from "#/core/config.ts";
export { paths } from "#/core/paths.ts";
export { client, owner, send } from "#/discord/client.ts";
export { deliver, render } from "#/discord/render.ts";

// Shared by handlers that don't name a channel, forgotten on restart like the jobs'
let session: Session | undefined;

/** An agent turn in that channel's conversation, or a conversation of the handlers' own */
export async function ask(prompt: string, options: { channel?: string } = {}) {
  const target = options.channel
    ? await channelSession(options.channel)
    : (session ??= createSession());
  return target.ask(prompt);
}

function storeFile(name: string) {
  if (!/^[\w-]+$/.test(name))
    throw new Error(`Store names are letters, digits, - and _, not "${name}"`);
  return join(paths.state, "store", `${name}.json`);
}

/** State a handler keeps across reloads and restarts, or `fallback` when there's none yet */
export async function load<T>(name: string, fallback: T): Promise<T> {
  return Bun.file(storeFile(name))
    .json()
    .catch(() => fallback);
}

export async function save(name: string, value: unknown) {
  await Bun.write(storeFile(name), JSON.stringify(value));
}
