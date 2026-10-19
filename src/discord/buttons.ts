import { join } from "node:path";
import { readJson, write } from "#/core/files.ts";
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

/** By custom ID */
let entries: Record<string, Entry> = {};

function file() {
  return join(paths.state, "buttons.json");
}

function save() {
  void write(file(), JSON.stringify(entries));
}

export async function loadButtons() {
  const saved = await readJson<Record<string, Entry>>(file(), {});
  const cutoff = Date.now() - maxAge;
  entries = Object.fromEntries(
    Object.entries(saved)
      .filter(([, e]) => e.created > cutoff)
      // Saved before entries were keyed by the whole custom ID
      .map(([id, e]) => [id.startsWith("pk:") ? id : `pk:${id}`, e]),
  );
}

/** Stores what a component does, returning its custom ID, pk:<id> */
export function register(entry: Omit<Entry, "created">) {
  const id = `pk:${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
