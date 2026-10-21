import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "./paths.ts";

export type Match = { at: string; where: string; role: "user" | "assistant"; snippet: string };

// Claude Code keeps each conversation as <session>.jsonl under a folder named for the cwd, with
// every character that isn't a letter or digit turned into "-"
function folder() {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(config, "projects", paths.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
}

// Only what was said: user and assistant text. Tool calls and results, thinking and subagent
// chatter are dropped, since a tool result can hold anything (the contents of .env, say)
function lines(raw: string) {
  const said: { at: string; role: "user" | "assistant"; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.type;
    if ((role !== "user" && role !== "assistant") || entry.isSidechain || entry.isMeta) continue;
    const content = entry.message?.content;
    const text = (
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block?.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join("\n")
          : ""
    )
      // The harness adds the time to each prompt
      .replace(/\n*\[Current time: [^\]]*\]\s*$/, "")
      .trim();
    if (text && entry.timestamp) said.push({ at: entry.timestamp, role, text });
  }
  return said;
}

// Where a conversation happened, from the header the harness puts on its prompts
function whereFrom(said: { role: string; text: string }[]) {
  const first = said.find((item) => item.role === "user")?.text ?? "";
  const job = first.match(/^\[Scheduled job: ([^\]]+)\]/m);
  if (job) return `job ${job[1]}`;
  const chat = first.match(/^\[Discord [^\]]*? in ([^\],]+)/m);
  return chat ? chat[1]!.trim() : "unknown";
}

function snippet(text: string, term: string) {
  const flat = text.replace(/\s+/g, " ");
  const at = Math.max(0, flat.toLowerCase().indexOf(term));
  const start = Math.max(0, at - 100);
  const end = Math.min(flat.length, at + 200);
  return `${start ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Past messages containing every word of `query`, newest first, across the workspace's
 * conversations
 */
export async function searchHistory(query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matches: Match[] = [];
  const files = await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: folder() })).catch(
    () => [],
  );
  for (const file of files) {
    const said = lines(await Bun.file(join(folder(), file)).text());
    const where = whereFrom(said);
    for (const { at, role, text } of said) {
      const lower = text.toLowerCase();
      if (terms.every((term) => lower.includes(term)))
        matches.push({ at, where, role, snippet: snippet(text, terms[0]!) });
    }
  }
  return matches.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
