import { planLimits, planLimitsSeen, type Session } from "#/agent/index.ts";

type Window = { percent: number; resetsAt: number };

const labels: Record<string, string> = {
  five_hour: "Session limit",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};

// ▰▰▰▱▱▱▱▱▱▱ 30%
function bar(percent: number) {
  const filled = Math.round(Math.min(Math.max(percent, 0), 100) / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${Math.round(percent)}%`;
}

// Discord renders <t:…:R> as a live "in 2 hours" in the viewer's own timezone
function relative(ms: number) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function limit(label: string, { percent, resetsAt }: Window) {
  return [`**${label}**`, `${bar(percent)}${resetsAt ? ` · resets ${relative(resetsAt)}` : ""}`];
}

/** The fun parts of Claude Code's /usage: plan limits, then this conversation */
export async function usageReport(session: Session) {
  const { usage, context } = await session.inspect(async (query) => ({
    usage: await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    }),
    context: await query.getContextUsage({ detail: "summary" }),
  }));

  // The usage endpoint needs a full login; a `claude setup-token` token only
  // gets what the last turn's rate limit headers said
  const windows = new Map<string, Window>();
  const limits = usage.rate_limits;
  const scoped = (limits?.model_scoped ?? []).map(
    (w) => [`Weekly · ${w.display_name}`, w] as const,
  );
  for (const [label, window] of [
    ...Object.keys(labels).map((type) => [labels[type]!, limits?.[type as "five_hour"]] as const),
    ...scoped,
  ])
    if (window?.utilization != null)
      windows.set(label, {
        percent: window.utilization,
        resetsAt: window.resets_at ? Date.parse(window.resets_at) : 0,
      });
  const fromHeaders = !windows.size;
  if (fromHeaders)
    for (const [type, window] of planLimits) if (labels[type]) windows.set(labels[type], window);

  const lines = [...windows].flatMap(([label, window]) => limit(label, window));
  if (!lines.length) lines.push("Plan limits show up after the first reply");
  else if (fromHeaders && planLimitsSeen)
    lines.push(`-# as of ${relative(planLimitsSeen.getTime())}`);

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
