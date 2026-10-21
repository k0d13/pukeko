import {
  ApplicationIntegrationType,
  type BaseInteraction,
  type Channel,
  Client,
  type CommandInteraction,
  GatewayIntentBits,
  InteractionContextType,
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  Partials,
} from "discord.js";
import { deliver, type Payload } from "./render.ts";

type Answerable = CommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

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

/** Shows Pukeko typing in the channel while `work` runs */
export async function whileTyping<T>(channel: Channel | null, work: () => Promise<T>) {
  const typing = () => channel?.isSendable() && channel.sendTyping().catch(() => {});
  typing();
  const interval = setInterval(typing, 8000);
  try {
    return await work();
  } finally {
    clearInterval(interval);
  }
}

/** A reply only the user sees, after whatever's already been said */
export function tell(interaction: Answerable, content: string) {
  const reply = { content: content.slice(0, 2000), flags: MessageFlags.Ephemeral as const };
  return interaction.replied || interaction.deferred
    ? interaction.followUp(reply)
    : interaction.reply(reply);
}

/** Posts to a channel, or to the owner's DMs without one */
export async function send(channelId: string | undefined, text: string) {
  const channel = channelId
    ? await client.channels.fetch(channelId)
    : await (await client.users.fetch(owner.id)).createDM();
  if (!channel?.isSendable()) throw new Error(`Can't send to channel ${channelId}`);
  await deliver(text, (c) => channel.send(c));
}

/** Answers through the interaction, or in its channel once its 15 minute token has expired */
export async function respond(
  interaction: Answerable,
  text: string,
  first: (c: Payload) => Promise<unknown> = (c) => interaction.followUp(c),
) {
  try {
    await deliver(text, first, (c) => interaction.followUp(c));
  } catch {
    await send(interaction.channelId ?? undefined, text);
  }
}

/** Posts a turn's updates and then its reply, the first through `first` and the rest via `rest` */
export function poster(first: (c: Payload) => Promise<unknown>, rest = first) {
  let opened = false;
  return (text: string) => {
    const via = opened ? rest : first;
    opened = true;
    return deliver(text, via, rest);
  };
}

/** Like poster, but through an interaction, with `prefix` on the first post only */
export function responder(
  interaction: Answerable,
  prefix = "",
  first?: (c: Payload) => Promise<unknown>,
) {
  let opened = false;
  return (text: string) => {
    const [head, via] = opened ? [text, undefined] : [`${prefix}${text}`, first];
    opened = true;
    return respond(interaction, head, via);
  };
}
