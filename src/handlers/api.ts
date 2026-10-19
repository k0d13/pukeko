import { join } from "node:path";
import { backgroundSession, channelSession } from "#/agent/index.ts";
import { readJson, write } from "#/core/files.ts";
import { paths } from "#/core/paths.ts";

// What handlers get from `import ... from "pukeko"`
export { config } from "#/core/config.ts";
export { paths } from "#/core/paths.ts";
export { client, owner, send } from "#/discord/client.ts";
export { deliver, render } from "#/discord/render.ts";

/** An agent turn in that channel's conversation, or the one jobs and handlers share */
export async function ask(prompt: string, options: { channel?: string } = {}) {
  const session = options.channel ? await channelSession(options.channel) : backgroundSession();
  return session.ask(prompt);
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
