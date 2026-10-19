const writes = new Map<string, Promise<unknown>>();

/** Writes in the order called, so an older write to a file never lands after a newer one */
export function write(path: string, text: string) {
  const done = (writes.get(path) ?? Promise.resolve())
    .then(() => Bun.write(path, text))
    .then(() => {}, console.error);
  writes.set(path, done);
  return done;
}

/** A JSON file's contents, or `fallback` when it's missing or unreadable */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return await Bun.file(path).json();
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT")
      console.warn(`Couldn't read ${path}, starting fresh`, error);
    return fallback;
  }
}
