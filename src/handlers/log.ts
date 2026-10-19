import { paths } from "#/core/paths.ts";

// Enough to see what just went wrong without the file growing forever
const keep = 200;
const entries: string[] = [];
let writing = Promise.resolve();

/** Logs to the console and to logs/handlers.log, where the agent can read it */
export function report(line: string, error?: unknown) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : error && String(error);
  if (error === undefined) console.log(line);
  else console.warn(line, detail);
  entries.push(`${new Date().toISOString()} ${line}${detail ? `\n${detail}` : ""}`);
  entries.splice(0, entries.length - keep);
  const text = `${entries.join("\n\n")}\n`;
  writing = writing.then(() => Bun.write(paths.handlerLog, text)).then(() => {}, console.error);
}

/** Runs a handler, logging what it throws instead of crashing the harness */
export function guard(name: string, fn: () => unknown) {
  return Promise.resolve()
    .then(fn)
    .catch((error) => report(`${name} threw`, error));
}
