import { createSession, type Session } from "#/agent/index.ts";
import { config, secrets } from "#/core/config.ts";
import { saveReply } from "#/core/replies.ts";

type Notification = {
  id: string;
  reason: string;
  updated_at: string;
  last_read_at: string | null;
  subject: { title: string; type: string; url: string; latest_comment_url: string | null };
  repository: { full_name: string };
};
// What issues, PRs, comments and reviews have in common
type Item = { html_url: string; body?: string | null; user?: { login: string } | null };

const api = "https://api.github.com";

// Shared by every mention, kept out of the chats and forgotten on restart
let session: Session;
let lastModified: string | undefined;
// Comments already answered, in case GitHub lists a thread again
const answered = new Set<string>();

function github(path: string, init: RequestInit = {}) {
  return fetch(path.startsWith("http") ? path : api + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${secrets.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
}

async function json<T>(path: string): Promise<T | undefined> {
  const response = await github(path);
  if (response.ok) return response.json() as Promise<T>;
  console.warn(`GitHub ${path} returned ${response.status}`);
}

/**
 * Everything in a notification's thread that could be the mention: its latest comment, and any
 * comments since it was last read
 */
async function candidates(n: Notification) {
  const { url, latest_comment_url: latest, type } = n.subject;
  const since = n.last_read_at ?? n.updated_at;
  const found = [await json<Item>(latest ?? url)];
  if (type === "Issue" || type === "PullRequest")
    found.push(
      ...((await json<Item[]>(`${url.replace("/pulls/", "/issues/")}/comments?since=${since}`)) ??
        []),
    );
  if (type === "PullRequest")
    found.push(...((await json<Item[]>(`${url}/comments?since=${since}`)) ?? []));
  return found.filter((item) => item !== undefined);
}

async function handle(n: Notification, login: string) {
  const owner = config.github.owner.toLowerCase();
  const mention = new RegExp(`(?<![\\w/])@${login}(?![\\w-])`, "i");
  // Marked read first so a turn that fails can't come back round every minute
  await github(`/notifications/threads/${n.id}`, { method: "PATCH" });

  for (const item of await candidates(n)) {
    if (!item.body || answered.has(item.html_url) || !mention.test(item.body)) continue;
    answered.add(item.html_url);
    // Anyone can mention an account on a public repo, but only the owner gets to give orders
    const sender = item.user?.login ?? "";
    if (sender.toLowerCase() !== owner)
      return void console.warn(`Ignoring a GitHub mention from ${sender} at ${item.html_url}`);

    console.log(`GitHub mention from ${sender} at ${item.html_url}`);
    const where = `${n.repository.full_name} ${n.subject.type}: ${n.subject.title}`;
    const reply = await session.ask(
      `[GitHub mention from ${sender} in ${where}]\n${item.html_url}\n\n${item.body}`,
    );
    // The agent answers on GitHub itself, so this is only kept in case the owner wants to look
    await saveReply("github", reply);
  }
}

async function poll(login: string) {
  let wait = 60;
  try {
    const response = await github("/notifications?participating=true", {
      headers: lastModified ? { "If-Modified-Since": lastModified } : {},
    });
    wait = Number(response.headers.get("x-poll-interval")) || wait;
    if (response.status === 200) {
      lastModified = response.headers.get("last-modified") ?? undefined;
      for (const n of (await response.json()) as Notification[])
        if (n.reason === "mention") await handle(n, login).catch(console.error);
    } else if (response.status !== 304) {
      console.warn(`GitHub notifications returned ${response.status}`);
    }
  } catch (error) {
    console.error("GitHub notifications poll failed", error);
  }
  setTimeout(() => poll(login), wait * 1000);
}

/**
 * Mentions of the token's account anywhere on GitHub show up in its notifications, which cost
 * nothing to check until there's one
 */
export async function startGithub() {
  const user = await json<{ login: string }>("/user");
  if (!user) throw new Error("GITHUB_TOKEN doesn't work, GitHub rejected it");
  session = createSession();
  console.log(`Watching GitHub for @${user.login} mentions from ${config.github.owner}`);
  await poll(user.login);
}
