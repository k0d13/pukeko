import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  type Message,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { channelSession, type Session } from "#/agent/index.ts";
import { client, deliver, owner, send } from "./client.ts";

export const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Pukeko something")
    .addStringOption((o) => o.setName("prompt").setDescription("What to ask").setRequired(true)),
  new ContextMenuCommandBuilder().setName("Ask Pukeko").setType(ApplicationCommandType.Message),
];

async function describe(message: Message) {
  const where =
    message.channel.type === ChannelType.DM
      ? "DM"
      : `#${"name" in message.channel ? message.channel.name : message.channelId}`;
  let text = message.content.replaceAll(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  for (const a of message.attachments.values()) text += `\n[Attachment: ${a.name} ${a.url}]`;
  const ref = message.reference?.messageId && (await message.fetchReference().catch(() => null));
  if (ref) text = `[Replying to ${ref.author.username}: ${ref.content}]\n\n${text}`;
  return `[Discord message from owner in ${where}, a channel Pukeko can read]\n${text}`;
}

/** DMs and @mentions */
export async function handleMessage(message: Message) {
  if (message.author.id !== owner.id) return;
  if (message.channel.type !== ChannelType.DM && !message.mentions.users.has(client.user!.id))
    return;
  if (!message.channel.isSendable()) return;

  const channel = message.channel;
  const typing = () => channel.sendTyping().catch(() => {});
  typing();
  const interval = setInterval(typing, 8000);
  try {
    const session = await channelSession(message.channelId);
    const reply = await session.ask(await describe(message));
    await deliver(
      reply,
      (c) => message.reply(c),
      (c) => channel.send(c),
    );
  } finally {
    clearInterval(interval);
  }
}

// Installed only as a user app, the bot isn't in the channel and sees nothing but the command
function where(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction) {
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

async function answer(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  session: Session,
  prompt: string,
  quote: string,
) {
  await interaction.deferReply();
  const reply = await session.ask(prompt);
  const text = `${quote}\n\n${reply}`;
  try {
    await deliver(
      text,
      (c) => interaction.editReply(c),
      (c) => interaction.followUp(c),
    );
  } catch {
    // Interaction tokens expire after 15 minutes, so long turns post to the channel
    await send(interaction.channelId ?? undefined, text);
  }
}

function handleAsk(interaction: ChatInputCommandInteraction, session: Session) {
  const prompt = interaction.options.getString("prompt", true);
  const header = `[Discord /ask from owner in ${where(interaction)}]`;
  return answer(interaction, session, `${header}\n${prompt}`, `> ${prompt}`);
}

// As a user app the bot can't read channels, so the message comes in through the command
async function handleAskAbout(interaction: MessageContextMenuCommandInteraction, session: Session) {
  const target = interaction.targetMessage;
  const id = `ask-about:${interaction.id}`;
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(id)
      .setTitle("Ask Pukeko")
      .addLabelComponents((label) =>
        label
          .setLabel("Prompt")
          .setDescription("Leave empty to just respond to the message")
          .setTextInputComponent((input) =>
            input
              .setCustomId("prompt")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(4000),
          ),
      ),
  );
  const submit = await interaction
    .awaitModalSubmit({ filter: (i) => i.customId === id, time: 15 * 60_000 })
    .catch(() => null);
  if (!submit) return;
  const prompt = submit.fields.getTextInputValue("prompt").trim();
  let content = target.content;
  for (const a of target.attachments.values()) content += `\n[Attachment: ${a.name} ${a.url}]`;
  for (const e of target.embeds)
    content += `\n[Embed: ${[e.title, e.description, e.url].filter(Boolean).join(" ")}]`;
  const header = `[Message from ${target.author.username} at ${target.createdAt.toISOString()}]`;
  return answer(
    submit,
    session,
    `[Discord "Ask Pukeko" on a message, from owner in ${where(interaction)}]\n${header}\n${content.trim()}\n\n${prompt || "(no prompt, respond to the message)"}`,
    `-# Re: ${target.url}${prompt ? `\n> ${prompt}` : ""}`,
  );
}

export function handle(
  interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
  session: Session,
) {
  return interaction.isMessageContextMenuCommand()
    ? handleAskAbout(interaction, session)
    : handleAsk(interaction, session);
}
