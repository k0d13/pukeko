import { Events, InteractionContextType, MessageFlags, type Interaction } from "discord.js";
import { channelSession } from "#/agent/index.ts";
import { config, secrets } from "#/core/config.ts";
import * as ask from "./ask.ts";
import { client, owner } from "./client.ts";
import * as conversation from "./conversation.ts";

export { send } from "./client.ts";

const commands = [...ask.commands, ...conversation.commands].map((command) =>
  command
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    )
    .toJSON(),
);

const askNames = new Set(ask.commands.map((command) => command.name));

async function handleInteraction(interaction: Interaction) {
  if (interaction.isAutocomplete()) return conversation.autocomplete(interaction);
  if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
  if (interaction.user.id !== owner.id)
    return interaction.reply({ content: "Not yours 🐦", flags: MessageFlags.Ephemeral });

  const session = await channelSession(interaction.channelId);
  if (askNames.has(interaction.commandName)) return ask.handle(interaction, session);
  if (interaction.isChatInputCommand()) return conversation.handle(interaction, session);
}

client.on(Events.MessageCreate, (message) => {
  ask.handleMessage(message).catch(console.error);
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch(console.error);
});

export async function startDiscord() {
  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(secrets.DISCORD_TOKEN);
  await ready;
  const application = await client.application!.fetch();
  // A team-owned application reports the team, whose owner is the one we want
  const appOwner = application.owner;
  owner.id =
    config.owner || ((appOwner && "ownerId" in appOwner ? appOwner.ownerId : appOwner?.id) ?? "");
  if (!owner.id) throw new Error("Couldn't find the application's owner, set owner in pukeko.toml");
  await application.commands.set(commands);
  console.log(`Logged in as ${client.user!.tag}, answering to ${owner.id}`);
}
