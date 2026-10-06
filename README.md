# Pukeko

A small personal assistant harness: Discord in, Claude Code (via the Agent SDK, on your Claude subscription) out.
It ships as a single `pukeko` binary. Everything that makes the bot _yours_ (personality, memory, jobs, skills,
integrations, config and secrets) lives in a separate workspace repo.

## How it works

- `src/config.ts`: finds the workspace (`--workspace DIR`, `$PUKEKO_WORKSPACE`, or `~/.pukeko/workspace`),
  reads `pukeko.toml` and `.env`. Secrets are never put in the agent's environment.
- `src/agent.ts`: sessions. One per Discord channel, resumed across restarts and run in parallel (`--new` wipes them); `jobs` is separate and lasts until restart.
  Uses the server's `claude`, loads the workspace's `CLAUDE.md`, `.claude/`, and `.mcp.json` (`${VAR}` filled from `.env`).
  Blocks reading `.env` through settings the workspace can't override, plus an OS sandbox for Bash.
- `src/discord.ts`: replies to the owner in DMs, on @mention, and via `/ask`, `/new`, `/stop`.
- `src/jobs.ts`: runs `jobs/<id>/job.md` on cron or one-off schedules; rescans every minute.
- `src/prompt.md`: the harness rules appended to Claude Code's system prompt.

## Build

```bash
bun install
bun run build:linux-arm64   # dist/pukeko-linux-arm64, for the Pi
```

## Server setup (Raspberry Pi 4/5, 64-bit Pi OS)

```bash
sudo apt install bubblewrap socat git
curl -fsSL https://claude.ai/install.sh | bash
claude setup-token                                   # for CLAUDE_CODE_OAUTH_TOKEN
git clone <workspace repo> ~/.pukeko/workspace
cp ~/.pukeko/workspace/.env.example ~/.pukeko/workspace/.env && nano ~/.pukeko/workspace/.env
nano ~/.pukeko/workspace/pukeko.toml                 # owner_id, discord_app_id
install -m 755 pukeko-linux-arm64 ~/.local/bin/pukeko
pukeko                                               # test in the foreground
pukeko service install                               # then follow the printed steps
```

Discord: create an app at discord.com/developers, add a bot, enable **Message Content Intent**,
and invite it with the `bot` + `applications.commands` scopes.
