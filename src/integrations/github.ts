import { createHmac, timingSafeEqual } from "node:crypto";
import { createSession, type Session } from "#/agent/index.ts";
import { config, secrets } from "#/core/config.ts";
import { saveReply } from "#/core/replies.ts";

type Payload = Record<string, any>;
type Mention = { where: string; url: string; text: string };

// Shared by every webhook, kept out of the chats and forgotten on restart
let session: Session;

function validSignature(body: string, header: string | null) {
  const expected = `sha256=${createHmac("sha256", secrets.GITHUB_WEBHOOK_SECRET!).update(body).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pulls the text and location out of the events that can carry a mention, or undefined for the rest */
function extract(event: string, p: Payload): Mention | undefined {
  const repo = p.repository?.full_name;
  switch (`${event}.${p.action}`) {
    case "issue_comment.created": {
      const kind = p.issue.pull_request ? "PR" : "issue";
      return {
        where: `${repo} ${kind} #${p.issue.number}: ${p.issue.title}`,
        url: p.comment.html_url,
        text: p.comment.body,
      };
    }
    case "pull_request_review_comment.created":
      return {
        where: `${repo} PR #${p.pull_request.number}: ${p.pull_request.title} (${p.comment.path})`,
        url: p.comment.html_url,
        text: p.comment.body,
      };
    case "pull_request_review.submitted":
      return {
        where: `${repo} PR #${p.pull_request.number}: ${p.pull_request.title}`,
        url: p.review.html_url,
        text: p.review.body,
      };
    case "issues.opened":
      return {
        where: `${repo} issue #${p.issue.number}: ${p.issue.title}`,
        url: p.issue.html_url,
        text: p.issue.body,
      };
    case "pull_request.opened":
      return {
        where: `${repo} PR #${p.pull_request.number}: ${p.pull_request.title}`,
        url: p.pull_request.html_url,
        text: p.pull_request.body,
      };
  }
}

async function handle(event: string, payload: Payload) {
  const mention = extract(event, payload);
  const bot = config.github.bot;
  const sender: string = payload.sender?.login ?? "";
  if (!mention?.text) return;
  // Logins are letters, digits and hyphens (checked at startup), so "@bot-two" is somebody else
  if (!new RegExp(`(?<![\\w/])@${bot}(?![\\w-])`, "i").test(mention.text)) return;
  // Anyone can comment on a public repo, but only the owner gets to give orders
  if (sender.toLowerCase() !== config.github.owner.toLowerCase())
    return void console.warn(`Ignoring a GitHub mention from ${sender} at ${mention.url}`);

  console.log(`GitHub mention from ${sender} at ${mention.url}`);
  const reply = await session.ask(
    `[GitHub mention from ${sender} in ${mention.where}]\n${mention.url}\n\n${mention.text}`,
  );
  // The agent answers on GitHub itself, so this is only kept in case the owner wants to look
  await saveReply("github", reply);
}

export function startGithub() {
  const { port } = config.github;
  session = createSession();
  Bun.serve({
    port,
    async fetch(request) {
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      const body = await request.text();
      if (!validSignature(body, request.headers.get("x-hub-signature-256")))
        return new Response("Bad signature", { status: 401 });
      const event = request.headers.get("x-github-event") ?? "";
      // Answer GitHub straight away, it gives up on slow hooks. The session queues the turns
      if (event !== "ping")
        handle(event, JSON.parse(body)).catch((error) =>
          console.error(`GitHub ${event} webhook failed`, error),
        );
      return new Response("ok");
    },
  });
  console.log(`Listening for GitHub webhooks on port ${port}`);
}
