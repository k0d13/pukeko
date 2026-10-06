import type { channelSession } from "../agent/index.ts";

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

// ▰▰▰▱▱▱▱▱▱▱ 30%
function bar(percent: number) {
  const filled = Math.round(Math.min(Math.max(percent, 0), 100) / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${Math.round(percent)}%`;
}

function limit(label: string, window: Window) {
  if (window?.utilization == null) return [];
  // Discord renders <t:…:R> as a live "in 2 hours" in the viewer's own timezone
  const resets = window.resets_at
    ? ` · resets <t:${Math.floor(Date.parse(window.resets_at) / 1000)}:R>`
    : "";
  return [`**${label}**`, `${bar(window.utilization)}${resets}`];
}

// The fun parts of Claude Code's /usage: plan limits, then this conversation
export async function usageReport(session: ReturnType<typeof channelSession>) {
  const { usage, context } = await session.inspect(async (query) => ({
    usage: await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    }),
    context: await query.getContextUsage({ detail: "summary" }),
  }));

  const limits = usage.rate_limits;
  const lines = [
    ...limit("Session limit", limits?.five_hour),
    ...limit("Weekly · all models", limits?.seven_day),
    ...(limits?.model_scoped ?? []).flatMap((window) =>
      limit(`Weekly · ${window.display_name}`, window),
    ),
  ];
  if (!lines.length) lines.push("Plan limits aren't available for this login");

  const { effort } = session.setup;
  const cost = usage.session.total_cost_usd;
  lines.push(
    "",
    "**This conversation**",
    `Model ${context.model}${effort ? ` · ${effort} effort` : ""}`,
    `Context ${bar(context.percentage)}`,
    `Cost $${cost.toFixed(2)} if it were on the API`,
  );
  return lines.join("\n");
}
