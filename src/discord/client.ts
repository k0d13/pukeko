import {
  ApplicationIntegrationType,
  type BaseInteraction,
  Client,
  GatewayIntentBits,
  InteractionContextType,
  Partials,
  type SendableChannels,
} from "discord.js";
import { deliver } from "./render.ts";

/** Filled in once logged in */
export const owner = { id: "" };

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    // For triggers. Members and presences are privileged, so they'd need enabling in the portal
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildScheduledEvents,
  ],
  // Without these, events on messages from before startup never fire
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

// Installed only as a user app, the bot isn't in the channel and sees nothing but the interaction
export function where(interaction: BaseInteraction) {
  const channel = interaction.channel;
  const name =
    interaction.context === InteractionContextType.BotDM
      ? "DM"
      : interaction.context === InteractionContextType.PrivateChannel
        ? "a DM or group DM"
        : `#${channel && "name" in channel ? channel.name : interaction.channelId}`;
  const readable =
    interaction.context === InteractionContextType.BotDM ||
    ApplicationIntegrationType.GuildInstall in interaction.authorizingIntegrationOwners;
  return `${name}, ${readable ? "a channel Pukeko can read" : "a channel Pukeko can't read or post in outside this reply"}`;
}

/** Shows Pukeko typing until the returned function is called */
export function keepTyping(channel: SendableChannels) {
  const typing = () => channel.sendTyping().catch(() => {});
  typing();
  const interval = setInterval(typing, 8000);
  return () => clearInterval(interval);
}

/** Posts to a channel, or to the owner's DMs without one */
export async function send(channelId: string | undefined, text: string) {
  const channel = channelId
    ? await client.channels.fetch(channelId)
    : await (await client.users.fetch(owner.id)).createDM();
  if (!channel?.isSendable()) throw new Error(`Can't send to channel ${channelId}`);
  await deliver(
    text,
    (c) => channel.send(c),
    (c) => channel.send(c),
  );
}
