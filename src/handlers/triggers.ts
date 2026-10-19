import { Events } from "discord.js";
import { logger } from "#/core/log.ts";
import { client } from "#/discord/client.ts";

type Listener = (...args: unknown[]) => void;

const log = logger("triggers");

const events = new Set<string>(Object.values(Events));
const attached = new Map<string, { event: string; listener: Listener }>();

// triggers/<id>.ts: `export default` gets the event's arguments, `export const event` picks which
export function addTrigger(id: string, module: Record<string, unknown>) {
  const run = module.default;
  const event = module.event ?? Events.MessageCreate;
  if (typeof run !== "function") throw new Error("Needs `export default function (...)`");
  if (typeof event !== "string" || !events.has(event))
    throw new Error(
      `"${event}" isn't a discord.js client event, use one of Events from discord.js`,
    );
  removeTrigger(id);
  const listener: Listener = async (...args) => {
    try {
      await run(...args);
    } catch (error) {
      log.report(`triggers/${id} threw on ${event}`, error);
    }
  };
  client.on(event, listener);
  attached.set(id, { event, listener });
  return `on ${event}`;
}

export function removeTrigger(id: string) {
  const old = attached.get(id);
  if (old) client.off(old.event, old.listener);
  attached.delete(id);
}
