# Pukeko

A small personal assistant harness: Discord in, Claude Code (via the Agent SDK, on your Claude subscription) out.
It ships as a single `pukeko` binary. Everything that makes the bot _yours_ (personality, memory, jobs, skills,
integrations, config and secrets) lives in a workspace folder. `pukeko init` creates one with just
the basics from `templates/`; personality, integrations and jobs are yours to add.

## How it works

- `src/cli/`: the `pukeko` command (`index.ts`), one file per subcommand: `start` (the default), `init`, `check` (config and secrets), `jobs` (when each runs next), `service` (`install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`) and `upgrade` (`--check` to only look).
- `src/core/`: workspace paths (`--workspace DIR`, `$PUKEKO_WORKSPACE`, or `~/.pukeko/workspace`), config from `pukeko.toml` and `.env`, release info, scoped console logging (`log.ts`: each turn's tools, timing and tokens, messages, clicks, commands and job runs), and the folder watcher jobs, triggers and commands share (`watch.ts`), which logs loads and failures to `logs/pukeko.log` for the agent to read. Secrets are kept out of the agent's environment; it sources `.env` when a command needs them.
- `src/agent/`: conversations, resumed across restarts until they go quiet past `[conversations] idle` (`/new` starts a fresh one sooner), compacting as they near `[conversations] context` tokens. One per channel or one shared, per `[conversations] scope`; jobs and handlers share one that lasts until restart.
  Uses the server's `claude`, loads the workspace's `CLAUDE.md`, `.claude/`, and `.mcp.json` (`${VAR}` filled from `.env`).
  Blocks reading `.pukeko/` through settings the workspace can't override, plus an OS sandbox for Bash.
- `src/discord/`: replies to the owner (from `pukeko.toml`, or the Discord application owner) in DMs, on @mention, and via `/ask`, `/new` (optionally switching model or effort), and `/stop`, all in one registry with the workspace's commands (`commands.ts`).
  When stopped within 10 minutes of a chat, it says it's back up (and the version) there on restart, and gives a turn the restart cut off another go (`restart.ts`).
  Messages sent in a chat while a turn is running there are fed into it rather than waiting their turn, and the reply goes to the latest.
  Image attachments (PNG, JPEG, GIF, WebP up to 3.75 MB) go straight into the prompt; other files come through as links.
  Replies are markdown plus directives (`markup.ts`, documented for the agent in `prompt.md`), rendered as Components v2 messages (`render.ts`) with inline images, files, boxes, buttons, text inputs and selects.
  Each button carries a prompt the agent wrote; a click (`clicks.ts`) sends it as a new turn in that channel's conversation. They're kept in `.pukeko/buttons.json` (`buttons.ts`) for 90 days.
- `src/jobs.ts`: runs `jobs/<id>/job.md` on cron or one-off schedules, rescheduling them as the files change.
- `src/handlers/`: agent-written `triggers/*.ts` (discord.js event listeners) and `commands/*.ts` (slash and context menu commands), imported into the harness and reloaded as the files change.
  They import `discord.js` and a `pukeko` module (`api.ts`: `ask`, `send`, `render`, `load`/`save` state) as Bun virtual modules, so the workspace needs no `node_modules`.
  This code runs unsandboxed in the harness process, so it can reach `.env` and `.pukeko/`.
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
(anything skipped goes in `~/.pukeko/workspace/.env`). Then run `pukeko check` and `pukeko` to try it, and `pukeko service install` to keep it running. Later, `pukeko upgrade` updates it, `pukeko service logs` follows along and `pukeko service status`, `stop`, `start` and `restart` control it.

Discord: create an app at discord.com/developers, add a bot, enable **Message Content Intent**,
and invite it with the `bot` + `applications.commands` scopes.

Releases: push a `v*` tag, or run the Release workflow from the Actions tab with the version, and `.github/workflows/release.yml` builds the binaries the installer downloads.

## Configuring

- `pukeko.toml`: Pukeko itself. Every key is optional and documented in the generated file;
  unknown keys and wrong types are reported at startup.
- `.env`: secrets. Kept out of the agent's environment, but it can `source .env` when a command needs them. Extra entries can be used in `.mcp.json` as `${NAME}`.
- `triggers/`, `commands/`: the bot's own behaviour, as code the agent writes (see `src/handlers/`).
- `CLAUDE.md`, `.mcp.json`, `.claude/skills/`: personality, integrations and skills, as in any Claude Code project.
- `.claude/settings.json`: normal Claude Code settings (hooks, permission rules, env, statusline...).
  Pukeko layers its own rules on top: `.pukeko/` is always denied and commits get no Claude co-author, whatever this file says.
