import {
  type Interaction,
  MessageFlags,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { paths } from "#/core/paths.ts";
import { owner } from "#/discord/client.ts";
import { builtInNames, registerCommands } from "#/discord/commands.ts";
import { watchFolder, type Module } from "./folder.ts";
import { guard, report } from "./log.ts";

type Handler = (interaction: never) => unknown;

type Command = {
  id: string;
  data: RESTPostAPIApplicationCommandsJSONBody;
  /** Usable by anyone, not just the owner */
  everyone: boolean;
  run: Handler;
  autocomplete?: Handler;
  /** Buttons, selects and modals it sent, with custom IDs cmd:<name>:... */
  component?: Handler;
};

/** By command name */
const commands = new Map<string, Command>();

function optional(module: Module, key: string) {
  const value = module[key];
  if (value !== undefined && typeof value !== "function")
    throw new Error(`\`${key}\` should be a function`);
  return value as Handler | undefined;
}

// commands/<id>.ts: `data` (a builder or command JSON), `run`, and optionally the rest of Command
function add(id: string, module: Module) {
  const raw = module.data as { toJSON?: () => unknown } | undefined;
  const data = (typeof raw?.toJSON === "function" ? raw.toJSON() : raw) as
    | RESTPostAPIApplicationCommandsJSONBody
    | undefined;
  if (!data?.name)
    throw new Error("Needs `export const data`, a SlashCommandBuilder or command JSON");
  const run = optional(module, "run");
  if (!run) throw new Error("Needs `export async function run(interaction)`");
  if (builtInNames.has(data.name)) throw new Error(`/${data.name} is one of Pukeko's own commands`);
  const other = commands.get(data.name);
  if (other && other.id !== id) throw new Error(`/${data.name} is already commands/${other.id}`);
  remove(id);
  commands.set(data.name, {
    id,
    data,
    everyone: module.everyone === true,
    run,
    autocomplete: optional(module, "autocomplete"),
    component: optional(module, "component"),
  });
}

function remove(id: string) {
  for (const [name, command] of commands) if (command.id === id) commands.delete(name);
}

async function sync() {
  try {
    await registerCommands([...commands.values()].map((command) => command.data));
  } catch (error) {
    // Discord takes all or nothing, so the last set that worked stays registered
    report("Discord rejected the commands, the previous set stays registered", error);
  }
}

/** Runs a workspace command, or its autocomplete or components. False if it isn't one */
export async function handleCustom(interaction: Interaction) {
  const name =
    interaction.isMessageComponent() || interaction.isModalSubmit()
      ? interaction.customId.match(/^cmd:([^:]+):/)?.[1]
      : interaction.isCommand() || interaction.isAutocomplete()
        ? interaction.commandName
        : undefined;
  const command = name && commands.get(name);
  if (!command) return false;
  if (!command.everyone && interaction.user.id !== owner.id) {
    if (interaction.isRepliable())
      await interaction.reply({ content: "Not yours 🐦", flags: MessageFlags.Ephemeral });
    return true;
  }
  const handler = interaction.isAutocomplete()
    ? command.autocomplete
    : interaction.isCommand()
      ? command.run
      : command.component;
  if (!handler) {
    if (interaction.isAutocomplete()) await interaction.respond([]);
    else if (interaction.isRepliable())
      await interaction.reply({ content: "This has expired", flags: MessageFlags.Ephemeral });
    return true;
  }
  await guard(`commands/${command.id}`, async () => {
    try {
      await handler(interaction as never);
    } catch (error) {
      // So the user sees it failed rather than Discord's vague "interaction failed"
      if (interaction.isRepliable()) {
        const message = error instanceof Error ? error.message : String(error);
        const reply = {
          content: `⚠️ ${message}`.slice(0, 2000),
          flags: MessageFlags.Ephemeral as const,
        };
        await (
          interaction.replied || interaction.deferred
            ? interaction.followUp(reply)
            : interaction.reply(reply)
        ).catch(() => {});
      }
      throw error;
    }
  });
  return true;
}

export async function startCommands() {
  await watchFolder({ dir: paths.commands, add, remove, changed: sync });
  // The first scan only calls `changed` if it found something, but the built-ins need registering
  await sync();
}
