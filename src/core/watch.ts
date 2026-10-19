import { watch } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { logger } from "./log.ts";

type Watched = {
  dir: string;
  /** Relative to `dir`. A file in a subfolder is that subfolder's, so its ID is the subfolder */
  pattern: string;
  // What it returns goes on the log line, like when a job next runs
  /** Takes over a new or edited file, throwing if it's unusable so the old version stays */
  add(id: string, path: string): Promise<string | void> | string | void;
  remove(id: string): void;
  /** After a scan that changed anything */
  changed?(): unknown;
};

/** Keeps a folder's files in step with what's loaded, by modification time */
export async function watchFolder({ dir, pattern, add, remove, changed }: Watched) {
  const name = basename(dir);
  const log = logger(name);
  const loaded = new Map<string, number>();
  let scanning = Promise.resolve();

  async function scan() {
    const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: dir })).catch(() => []);
    const found = new Set<string>();
    let dirty = false;
    for (const file of files) {
      const [first, nested] = file.split(/[\\/]/) as [string, string?];
      const id = nested ? first : first.slice(0, -extname(first).length);
      found.add(id);
      const path = join(dir, file);
      const mtime = (await stat(path).catch(() => undefined))?.mtimeMs;
      if (mtime === undefined || loaded.get(id) === mtime) continue;
      const had = loaded.has(id);
      // Marked even if it fails, so a broken file is retried once edited rather than every scan
      loaded.set(id, mtime);
      dirty = true;
      try {
        const note = await add(id, path);
        log.report(`${had ? "Reloaded" : "Loaded"} ${name}/${file}${note ? `, ${note}` : ""}`);
      } catch (error) {
        log.report(
          `${name}/${file} didn't load${had ? ", the previous version keeps running" : ""}`,
          error,
        );
      }
    }
    for (const id of loaded.keys()) {
      if (found.has(id)) continue;
      loaded.delete(id);
      remove(id);
      dirty = true;
      log.report(`Removed ${name}/${id}`);
    }
    if (dirty) await changed?.();
  }

  function rescan() {
    scanning = scanning.then(scan).catch((error) => log.error("Scan failed", error));
    return scanning;
  }

  await mkdir(dir, { recursive: true });
  await rescan();
  log.info(`Watching ${dir}, ${loaded.size} found`);
  // Saves arrive as bursts of events, so wait for them to settle
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rescan, 300);
    });
  } catch (error) {
    log.warn(`Couldn't watch ${dir}, changes apply within a minute`, error);
  }
  // Catches what the watcher misses, like the folder being replaced by a git checkout
  setInterval(rescan, 60_000);
}
