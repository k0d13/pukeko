import { InteractionContextType, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import * as ask from "./ask.ts";
import { client } from "./client.ts";
import * as conversation from "./conversation.ts";

type CommandData = RESTPostAPIApplicationCommandsJSONBody;

// Everywhere the app is installed, unless a command says otherwise
const contexts = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
];

const builtIn = [...ask.commands, ...conversation.commands].map((command) =>
  command.setContexts(...contexts).toJSON(),
);

export const builtInNames = new Set(builtIn.map((command) => command.name));

let registered = "";

/** Registers the built-in commands plus the workspace's, skipping the call when nothing changed */
export async function registerCommands(custom: CommandData[] = []) {
  const all = [...builtIn, ...custom.map((command) => ({ contexts, ...command }))];
  const json = JSON.stringify(all);
  if (json === registered) return;
  await client.application!.commands.set(all);
  registered = json;
}
