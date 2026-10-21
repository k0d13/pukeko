import { defineCommand } from "citty";
import { consola } from "consola";
import { searchHistory } from "#/core/history.ts";
import { fail } from "./fail.ts";

// So a broad search can't flood the agent's context
const maxCharacters = 8000;

const search = defineCommand({
  meta: {
    name: "search",
    description: "Search past conversations' messages (not tool output), newest first",
  },
  args: {
    query: { type: "positional", description: "Words that must all appear", required: true },
    limit: { type: "string", description: "Most matches to show", default: "10" },
  },
  async run({ args }) {
    const limit = Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive whole number");
    const matches = await searchHistory(args.query, Math.min(limit, 50));
    if (!matches.length) return consola.info("No matches");
    let used = 0;
    for (const { at, where, role, snippet } of matches) {
      const entry = `${at} | ${where} | ${role}\n${snippet}\n`;
      if ((used += entry.length) > maxCharacters) return console.log("(more matches cut off)");
      console.log(entry);
    }
  },
});

export default defineCommand({
  meta: { name: "history", description: "Look back through past conversations" },
  subCommands: { search },
});
