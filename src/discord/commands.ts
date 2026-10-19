import {
  ApplicationCommandType,
  type Interaction,
  InteractionContextType,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { logger, seconds } from "#/core/log.ts";
import * as ask from "./ask.ts";
import { client, owner, tell } from "./client.ts";
import * as conversation from "./conversation.ts";

type Handler = (interaction: never) => unknown;

export type Command = {
  data: RESTPostAPIApplicationCommandsJSONBody;
  run: Handler;
  autocomplete?: Handler;
  /** Buttons, selects and modals it sent, with custom IDs cmd:<name>:... */
  component?: Handler;
  /** Usable by anyone, not just the owner */
  everyone?: boolean;
  /** The workspace file it came from, whose failures go to the log the agent reads */
  file?: string;
};

const log = logger("commands");

// Everywhere the app is installed, unless a command says otherwise
const contexts = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
];

/** By name, Pukeko's own and then the workspace's */
export const commands = new Map<string, Command>(
  [...ask.commands, ...conversation.commands].map((command) => [command.data.name, command]),
);

let registered = "";

/** Registers every command, skipping the call when nothing changed */
export async function registerCommands() {
  const all = [...commands.values()].map(({ data }) => ({ contexts, ...data }));
  const json = JSON.stringify(all);
  if (json === registered) return;
  await client.application!.commands.set(all);
  registered = json;
  log.info(`Registered ${all.length} commands: ${[...commands.values()].map(label).join(", ")}`);
}

/** How a command shows in the logs, like /ask or Ask Pukeko */
export function label({ data, file }: Pick<Command, "data" | "file">) {
  const slash = data.type === undefined || data.type === ApplicationCommandType.ChatInput;
  return `${slash ? "/" : ""}${data.name}${file ? ` (${file})` : ""}`;
}

/** Runs a command, its autocomplete or one of its components, leaving anything else alone */
export async function runCommand(interaction: Interaction) {
  const name =
    interaction.isMessageComponent() || interaction.isModalSubmit()
      ? interaction.customId.match(/^cmd:([^:]+):/)?.[1]
      : interaction.isCommand() || interaction.isAutocomplete()
        ? interaction.commandName
        : undefined;
  const command = name && commands.get(name);
  if (!command) return;
  if (!command.everyone && interaction.user.id !== owner.id) {
    log.info(`Turned away ${interaction.user.username} from ${label(command)}, not the owner`);
    return interaction.isRepliable() && tell(interaction, "Not yours 🐦");
  }
  const handler = interaction.isAutocomplete()
    ? command.autocomplete
    : interaction.isCommand()
      ? command.run
      : command.component;
  const what = `${label(command)}${interaction.isCommand() ? "" : interaction.isAutocomplete() ? " autocomplete" : ` component ${interaction.customId}`}`;
  // Autocomplete fires on every keystroke, too often to be worth a line
  if (!interaction.isAutocomplete()) log.info(`${what} used by ${interaction.user.username}`);
  const started = Date.now();
  try {
    if (handler) await handler(interaction as never);
    else if (interaction.isAutocomplete()) await interaction.respond([]);
    else if (interaction.isRepliable()) await tell(interaction, "This has expired");
    if (!interaction.isAutocomplete()) log.info(`${what} done in ${seconds(Date.now() - started)}`);
  } catch (error) {
    // So the user sees it failed rather than Discord's vague "interaction failed"
    if (interaction.isRepliable())
      await tell(interaction, `⚠️ ${error instanceof Error ? error.message : error}`).catch(
        () => {},
      );
    // A workspace command's failures go where the agent can read them
    if (command.file) log.report(`${what} threw`, error);
    else log.error(`${what} threw`, error);
  }
}
