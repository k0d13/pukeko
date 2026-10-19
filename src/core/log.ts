import { write } from "./files.ts";
import { paths } from "./paths.ts";

// Enough to see what just went wrong without the file growing forever
const keep = 200;
const entries: string[] = [];

/** Logs to the console and to logs/pukeko.log, where the agent can read it */
export function report(line: string, error?: unknown) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : error && String(error);
  if (error === undefined) console.log(line);
  else console.warn(line, detail);
  entries.push(`${new Date().toISOString()} ${line}${detail ? `\n${detail}` : ""}`);
  entries.splice(0, entries.length - keep);
  void write(paths.log, `${entries.join("\n\n")}\n`);
}
