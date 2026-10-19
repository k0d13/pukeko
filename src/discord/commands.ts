import {
  type Interaction,
  InteractionContextType,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { report } from "#/core/log.ts";
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
  if (!command.everyone && interaction.user.id !== owner.id)
    return interaction.isRepliable() && tell(interaction, "Not yours 🐦");
  const handler = interaction.isAutocomplete()
    ? command.autocomplete
    : interaction.isCommand()
      ? command.run
      : command.component;
  try {
    if (handler) await handler(interaction as never);
    else if (interaction.isAutocomplete()) await interaction.respond([]);
    else if (interaction.isRepliable()) await tell(interaction, "This has expired");
  } catch (error) {
    // So the user sees it failed rather than Discord's vague "interaction failed"
    if (interaction.isRepliable())
      await tell(interaction, `⚠️ ${error instanceof Error ? error.message : error}`).catch(
        () => {},
      );
    if (command.file) report(`${command.file} threw`, error);
    else console.error(error);
  }
}
