import { Events } from "discord.js";
import { paths } from "#/core/paths.ts";
import { client } from "#/discord/client.ts";
import { watchFolder, type Module } from "./folder.ts";
import { guard } from "./log.ts";

type Listener = (...args: unknown[]) => void;

const events = new Set<string>(Object.values(Events));
const attached = new Map<string, { event: string; listener: Listener }>();

// triggers/<id>.ts: `export default` gets the event's arguments, `export const event` picks which
function add(id: string, module: Module) {
  const run = module.default;
  const event = module.event ?? Events.MessageCreate;
  if (typeof run !== "function") throw new Error("Needs `export default function (...)`");
  if (typeof event !== "string" || !events.has(event))
    throw new Error(
      `"${event}" isn't a discord.js client event, use one of Events from discord.js`,
    );
  remove(id);
  const listener: Listener = (...args) => void guard(`triggers/${id}`, () => run(...args));
  client.on(event, listener);
  attached.set(id, { event, listener });
}

function remove(id: string) {
  const old = attached.get(id);
  if (old) client.off(old.event, old.listener);
  attached.delete(id);
}

export function startTriggers() {
  return watchFolder({ dir: paths.triggers, add, remove });
}
