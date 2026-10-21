import {
  ApplicationCommandType,
  ChannelType,
  ContextMenuCommandBuilder,
  type Message,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { channelSession } from "#/agent/index.ts";
import { logger, preview } from "#/core/log.ts";
import { client, owner, poster, responder, whileTyping, where } from "./client.ts";
import type { Command } from "./commands.ts";

const log = logger("discord");

function attachments(message: Message) {
  return message.attachments.map((a) => `\n[Attachment: ${a.name} ${a.url}]`).join("");
}

async function describe(message: Message) {
  const where =
    message.channel.type === ChannelType.DM
      ? "DM"
      : `#${"name" in message.channel ? message.channel.name : message.channelId}`;
  let text = message.content.replaceAll(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  text += attachments(message);
  const ref = message.reference?.messageId && (await message.fetchReference().catch(() => null));
  if (ref) text = `[Replying to ${ref.author.username}: ${ref.content}]\n\n${text}`;
  return `[Discord message from owner in ${where}, a channel Pukeko can read]\n${text}`;
}

/** DMs and @mentions */
export async function handleMessage(message: Message) {
  if (message.author.id !== owner.id) return;
  if (message.channel.type !== ChannelType.DM && !message.mentions.users.has(client.user!.id))
    return;
  const channel = message.channel;
  if (!channel.isSendable()) return;
  const files = message.attachments.size ? ` with ${message.attachments.size} attachments` : "";
  log.info(
    `Message in ${"name" in channel ? `#${channel.name}` : "DM"}${files}: ${preview(message.content)}`,
  );
  const post = poster(
    (c) => message.reply(c),
    (c) => channel.send(c),
  );
  const reply = await whileTyping(channel, async () =>
    (await channelSession(message.channelId)).ask(await describe(message), post),
  );
  await post(reply);
}

async function answer(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  prompt: string,
  quote: string,
) {
  await interaction.deferReply();
  const post = responder(interaction, `${quote}\n\n`, (c) => interaction.editReply(c));
  const reply = await (await channelSession(interaction.channelId!)).ask(prompt, post);
  await post(reply);
}

function handleAsk(interaction: ChatInputCommandInteraction) {
  const prompt = interaction.options.getString("prompt", true);
  const header = `[Discord /ask from owner in ${where(interaction)}]`;
  return answer(interaction, `${header}\n${prompt}`, `> ${prompt}`);
}

// As a user app the bot can't read channels, so the message comes in through the command
async function handleAskAbout(interaction: MessageContextMenuCommandInteraction) {
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
  let content = target.content + attachments(target);
  for (const e of target.embeds)
    content += `\n[Embed: ${[e.title, e.description, e.url].filter(Boolean).join(" ")}]`;
  const header = `[Message from ${target.author.username} at ${target.createdAt.toISOString()}]`;
  return answer(
    submit,
    `[Discord "Ask Pukeko" on a message, from owner in ${where(interaction)}]\n${header}\n${content.trim()}\n\n${prompt || "(no prompt, respond to the message)"}`,
    `-# Re: ${target.url}${prompt ? `\n> ${prompt}` : ""}`,
  );
}

export const commands: Command[] = [
  {
    data: new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask Pukeko something")
      .addStringOption((o) => o.setName("prompt").setDescription("What to ask").setRequired(true))
      .toJSON(),
    run: handleAsk,
  },
  {
    data: new ContextMenuCommandBuilder()
      .setName("Ask Pukeko")
      .setType(ApplicationCommandType.Message)
      .toJSON(),
    run: handleAskAbout,
  },
];
