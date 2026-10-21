import { join } from "node:path";
import { backgroundSession, type Image, type OnUpdate } from "#/agent/index.ts";
import { readJson, write } from "#/core/files.ts";
import { paths } from "#/core/paths.ts";
import { backgroundTurn, chatTurn } from "#/discord/restart.ts";

// What handlers get from `import ... from "pukeko"`
export { config } from "#/core/config.ts";
export { paths } from "#/core/paths.ts";
export { client, owner, send } from "#/discord/client.ts";
export { attachments } from "#/discord/ask.ts";
export { deliver, render } from "#/discord/render.ts";

type AskOptions = { channel?: string; onUpdate?: OnUpdate; images?: Image[]; fold?: boolean };

/**
 * An agent turn in that channel's conversation, or the one jobs and handlers share. `onUpdate` gets
 * the progress notes as the turn goes. `fold` (needs `channel`) feeds the prompt into a turn
 * already running there, like a mention does; this ask then gets the reply and the earlier ones ""
 */
export async function ask(prompt: string, { channel, onUpdate, images, fold }: AskOptions = {}) {
  if (channel) return chatTurn(channel, prompt, onUpdate, { fold, images });
  if (fold) throw new Error("ask: fold needs a channel");
  return backgroundTurn(() => backgroundSession().ask(prompt, onUpdate, undefined, images));
}

function storeFile(name: string) {
  if (!/^[\w-]+$/.test(name))
    throw new Error(`Store names are letters, digits, - and _, not "${name}"`);
  return join(paths.state, "store", `${name}.json`);
}

/** State a handler keeps across reloads and restarts, or `fallback` when there's none yet */
export function load<T>(name: string, fallback: T) {
  return readJson(storeFile(name), fallback);
}

export function save(name: string, value: unknown) {
  return write(storeFile(name), JSON.stringify(value));
}
