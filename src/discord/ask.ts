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
import type { Image } from "#/agent/index.ts";
import { logger, preview } from "#/core/log.ts";
import { client, owner, poster, responder, whileTyping, where } from "./client.ts";
import type { Command } from "./commands.ts";
import { chatTurn } from "./restart.ts";

const log = logger("discord");

// The API's image types, and its 5 MB per-image limit once base64 grows it by a third;
// anything else stays a link to download
const imageTypes = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxImage = 3.75 * 1024 * 1024;

/** The message's images, base64 for the prompt, and lines listing every attachment */
async function attachments(message: Message) {
  const images: Image[] = [];
  let text = "";
  for (const a of message.attachments.values()) {
    let inline = false;
    if (a.contentType && imageTypes.has(a.contentType.split(";")[0]!) && a.size <= maxImage)
      try {
        const response = await fetch(a.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer()).toString("base64");
        images.push({ mediaType: a.contentType.split(";")[0] as Image["mediaType"], data });
        inline = true;
      } catch (error) {
        log.warn(`Couldn't fetch ${a.name}, passing its link instead`, error);
      }
    text += `\n[Attachment: ${a.name} ${a.url}${inline ? " (image, already in your context)" : ""}]`;
  }
  return { images, text };
}

async function describe(message: Message) {
  const where =
    message.channel.type === ChannelType.DM
      ? "DM"
      : `#${"name" in message.channel ? message.channel.name : message.channelId}`;
  const files = await attachments(message);
  let text = message.content.replaceAll(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  text += files.text;
  const ref = message.reference?.messageId && (await message.fetchReference().catch(() => null));
  if (ref) text = `[Replying to ${ref.author.username}: ${ref.content}]\n\n${text}`;
  return {
    prompt: `[Discord message from owner in ${where}, a channel Pukeko can read]\n${text}`,
    images: files.images,
  };
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
  const reply = await whileTyping(channel, async () => {
    const { prompt, images } = await describe(message);
    return chatTurn(message.channelId, prompt, post, { fold: true, images });
  });
  // Empty when it joined a turn already running, whose reply goes with a later message
  if (reply) await post(reply);
}

async function answer(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  prompt: string,
  quote: string,
  images?: Image[],
) {
  if (!interaction.deferred) await interaction.deferReply();
  const post = responder(interaction, `${quote}\n\n`, (c) => interaction.editReply(c));
  const reply = await chatTurn(interaction.channelId!, prompt, post, { images });
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
  // Downloading images can outlast the 3 seconds Discord gives to acknowledge
  await submit.deferReply();
  const files = await attachments(target);
  let content = target.content + files.text;
  for (const e of target.embeds)
    content += `\n[Embed: ${[e.title, e.description, e.url].filter(Boolean).join(" ")}]`;
  const header = `[Message from ${target.author.username} at ${target.createdAt.toISOString()}]`;
  return answer(
    submit,
    `[Discord "Ask Pukeko" on a message, from owner in ${where(interaction)}]\n${header}\n${content.trim()}\n\n${prompt || "(no prompt, respond to the message)"}`,
    `-# Re: ${target.url}${prompt ? `\n> ${prompt}` : ""}`,
    files.images,
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
