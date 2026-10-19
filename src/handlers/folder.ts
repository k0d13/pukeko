import { watch } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { report } from "./log.ts";

export type Module = Record<string, unknown>;

type Folder = {
  dir: string;
  /** Takes over a freshly imported module, throwing if it's unusable so the old one stays */
  add(id: string, module: Module): void;
  remove(id: string): void;
  /** After a scan that changed anything */
  changed?(): unknown;
};

/** Imports every top-level .ts or .js file in a folder, re-importing them as they change */
export async function watchFolder(folder: Folder) {
  const name = basename(folder.dir);
  const loaded = new Map<string, number>();
  let scanning = Promise.resolve();

  async function scan() {
    // Subfolders are left alone, so helpers can live there
    const glob = new Bun.Glob("*.{ts,js,mts,mjs}");
    const files = await Array.fromAsync(glob.scan({ cwd: folder.dir })).catch(() => []);
    const found = new Set<string>();
    let changed = false;
    for (const file of files) {
      const id = file.slice(0, -extname(file).length);
      found.add(id);
      const path = join(folder.dir, file);
      const mtime = (await stat(path).catch(() => undefined))?.mtimeMs;
      if (mtime === undefined || loaded.get(id) === mtime) continue;
      const had = loaded.has(id);
      // Marked even if it fails, so a broken file is retried once edited rather than every scan
      loaded.set(id, mtime);
      changed = true;
      try {
        // A new query string is a new module to Bun, which is what makes edits reload
        folder.add(id, await import(`${path}?v=${mtime}`));
        report(`${had ? "Reloaded" : "Loaded"} ${name}/${file}`);
      } catch (error) {
        report(
          `${name}/${file} didn't load${had ? ", the previous version keeps running" : ""}`,
          error,
        );
      }
    }
    for (const id of loaded.keys()) {
      if (found.has(id)) continue;
      loaded.delete(id);
      folder.remove(id);
      changed = true;
      report(`Removed ${name}/${id}`);
    }
    if (changed) await folder.changed?.();
  }

  function rescan() {
    scanning = scanning.then(scan).catch(console.error);
    return scanning;
  }

  await mkdir(folder.dir, { recursive: true });
  await rescan();
  // Saves arrive as bursts of events, so wait for them to settle
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    watch(folder.dir, () => {
      clearTimeout(timer);
      timer = setTimeout(rescan, 300);
    });
  } catch (error) {
    console.warn(`Couldn't watch ${folder.dir}, changes apply within a minute`, error);
  }
  // Catches what the watcher misses, like the folder being replaced by a git checkout
  setInterval(rescan, 60_000);
}
