import { join } from "node:path";
import { paths } from "#/core/paths.ts";

/** What a button, text input or select does, kept so it still works after restarts */
export type Entry = {
  kind: "button" | "input" | "select";
  label: string;
  /** Sent as a new turn in that channel's conversation when used */
  prompt: string;
  placeholder?: string;
  /** Select option labels, by index */
  options?: string[];
  /** Stays usable after a click instead of greying out */
  repeat: boolean;
  /** Using one greys out every control on the message with the same group */
  group?: string;
  created: number;
};

// Long enough for anything still worth clicking
const maxAge = 90 * 24 * 60 * 60_000;

let entries: Record<string, Entry> = {};
let saving = Promise.resolve();

function file() {
  return join(paths.state, "buttons.json");
}

function save() {
  const json = JSON.stringify(entries);
  saving = saving.then(() => Bun.write(file(), json)).then(() => {}, console.error);
}

export async function loadButtons() {
  const saved: Record<string, Entry> = await Bun.file(file())
    .json()
    .catch(() => ({}));
  const cutoff = Date.now() - maxAge;
  entries = Object.fromEntries(Object.entries(saved).filter(([, e]) => e.created > cutoff));
}

/** Stores what a component does, returning the ID for its custom ID */
export function register(entry: Omit<Entry, "created">) {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  entries[id] = { ...entry, created: Date.now() };
  save();
  return id;
}

export function lookup(id: string): Entry | undefined {
  return entries[id];
}

export function forget(id: string) {
  delete entries[id];
  save();
}
