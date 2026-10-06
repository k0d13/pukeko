# Pukeko

A small personal assistant harness: Discord in, Claude Code (via the Agent SDK, on your Claude subscription) out.
It ships as a single `pukeko` binary. Everything that makes the bot _yours_ (personality, memory, jobs, skills,
integrations, config and secrets) lives in a workspace folder. `pukeko init` creates one with just
the basics from `templates/`; personality, integrations and jobs are yours to add.

## How it works

- `src/cli/`: the `pukeko` command (`index.ts`), one file per subcommand: `start` (the default), `init`, `service`, `restart`, `logs` and `upgrade`.
- `src/core/`: workspace paths (`--workspace DIR`, `$PUKEKO_WORKSPACE`, or `~/.pukeko/workspace`), config from `pukeko.toml` and `.env` and release info. Secrets are never put in the agent's environment.
- `src/agent/`: conversations, resumed across restarts (`/new` starts a fresh one). One per channel or one shared, per `[conversations] scope`; jobs get their own that lasts until restart.
  Uses the server's `claude`, loads the workspace's `CLAUDE.md`, `.claude/`, and `.mcp.json` (`${VAR}` filled from `.env`).
  Blocks reading `.env` through settings the workspace can't override, plus an OS sandbox for Bash.
- `src/discord/`: replies to the owner (from `pukeko.toml`, or the Discord application owner) in DMs, on @mention, and via `/ask`, `/new` (optionally switching model or effort), `/stop`, `/compact` and `/usage`.
- `src/jobs.ts`: runs `jobs/<id>/job.md` on cron or one-off schedules; rescans every minute.
- `src/agent/prompt.md`: the harness rules appended to Claude Code's system prompt.

## Build

```bash
bun install
bun run build:linux-arm64   # dist/pukeko-linux-arm64
```

## Install (Linux or macOS, x64 or arm64)

```bash
curl -fsSL https://raw.githubusercontent.com/k0d13/pukeko/main/install.sh | sh
```

This installs `pukeko` to `~/.local/bin`, installs Claude Code and the sandbox dependencies if missing,
and runs `pukeko init` to create `~/.pukeko/workspace`, which offers to run `claude setup-token` and asks for your Discord bot token
(anything skipped goes in `~/.pukeko/workspace/.env`). Then run `pukeko` to try it, and `pukeko service` to keep it running. Later, `pukeko upgrade` updates it and `pukeko logs` follows along.

Discord: create an app at discord.com/developers, add a bot, enable **Message Content Intent**,
and invite it with the `bot` + `applications.commands` scopes.

Releases: push a `v*` tag and `.github/workflows/release.yml` builds the binaries the installer downloads.

## Configuring

- `pukeko.toml`: Pukeko itself. Every key is optional and documented in the generated file;
  unknown keys and wrong types are reported at startup.
- `.env`: secrets. Only Pukeko reads it. Extra entries can be used in `.mcp.json` as `${NAME}`.
- `CLAUDE.md`, `.mcp.json`, `.claude/skills/`: personality, integrations and skills, as in any Claude Code project.
- `.claude/settings.json`: normal Claude Code settings (hooks, permission rules, env, statusline...).
  Pukeko layers its own rules on top: `.env` and `.pukeko/` are always denied, whatever this file says.
