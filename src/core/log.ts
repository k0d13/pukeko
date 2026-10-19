import { write } from "./files.ts";
import { paths } from "./paths.ts";

// Enough to see what just went wrong without the file growing forever
const keep = 200;
const entries: string[] = [];

// systemd stamps every line itself, so only the foreground needs a time
const stamped = !process.env.INVOCATION_ID;

function detail(error: unknown) {
  return error instanceof Error ? (error.stack ?? error.message) : error && String(error);
}

/** Console lines tagged with the part of Pukeko they came from */
export function logger(scope: string) {
  const line = (text: string) =>
    `${stamped ? `${new Date().toLocaleTimeString()} ` : ""}[${scope}] ${text}`;
  const log = {
    info: (text: string) => console.log(line(text)),
    warn: (text: string, error?: unknown) =>
      error === undefined ? console.warn(line(text)) : console.warn(line(text), detail(error)),
    error: (text: string, error?: unknown) => console.error(line(text), detail(error) ?? ""),
    /** Also kept in logs/pukeko.log, where the agent can read it */
    report(text: string, error?: unknown) {
      if (error === undefined) log.info(text);
      else log.warn(text, error);
      const more = detail(error);
      entries.push(`${new Date().toISOString()} [${scope}] ${text}${more ? `\n${more}` : ""}`);
      entries.splice(0, entries.length - keep);
      void write(paths.log, `${entries.join("\n\n")}\n`);
    },
  };
  return log;
}

export function preview(text: string, max = 80) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}
