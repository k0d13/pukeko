import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  type Message,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import { channelSession } from "../agent/index.ts";
import { config, effortLevels, secrets } from "../config.ts";
import { usageReport } from "./usage.ts";

// pukeko.toml `owner`, or else whoever owns the Discord application, found at startup
let ownerId = config.owner;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Pukeko something")
    .addStringOption((o) => o.setName("prompt").setDescription("What to ask").setRequired(true)),
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a fresh conversation here, optionally with another model or effort")
    .addStringOption((o) =>
      o
        .setName("model")
        .setDescription("Opus, Sonnet, Haiku or a full model ID, kept until changed")
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("effort")
        .setDescription("How hard the model thinks, kept until changed")
        .addChoices(
          { name: "default", value: "default" },
          ...effortLevels.map((level) => ({ name: level, value: level })),
        ),
    ),
  new SlashCommandBuilder().setName("stop").setDescription("Stop the current turn here"),
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Summarise this conversation to free up context"),
  new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Plan limits and this conversation's usage"),
].map((command) =>
  command
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    )
    .toJSON(),
);

// Splits on newlines where possible to stay under Discord's 2000 character limit
function chunks(text: string) {
  const out: string[] = [];
  let rest = text.trim() || "(no reply)";
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf("\n", 1900);
    if (cut < 1000) cut = 1900;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

// Sends the first chunk one way (a reply) and the rest another (plain messages)
async function deliver(
  text: string,
  first: (chunk: string) => Promise<unknown>,
  rest: (chunk: string) => Promise<unknown>,
) {
  const [head, ...tail] = chunks(text);
  await first(head!);
  for (const chunk of tail) await rest(chunk);
}

// Posts to a channel, or to the owner's DMs without one
export async function send(channelId: string | undefined, text: string) {
  const channel = channelId
    ? await client.channels.fetch(channelId)
    : await (await client.users.fetch(ownerId)).createDM();
  if (!channel?.isSendable()) throw new Error(`Can't send to channel ${channelId}`);
  await deliver(
    text,
    (c) => channel.send(c),
    (c) => channel.send(c),
  );
}

// The prompt for a message: where it came from, what it replies to, and attachments
async function describe(message: Message) {
  const where =
    message.channel.type === ChannelType.DM
      ? "DM"
      : `#${"name" in message.channel ? message.channel.name : message.channelId}`;
  let text = message.content.replaceAll(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  for (const a of message.attachments.values()) text += `\n[Attachment: ${a.name} ${a.url}]`;
  const ref = message.reference?.messageId && (await message.fetchReference().catch(() => null));
  if (ref) text = `[Replying to ${ref.author.username}: ${ref.content}]\n\n${text}`;
  return `[Discord message from owner in ${where}]\n${text}`;
}

async function handleMessage(message: Message) {
  if (message.author.id !== ownerId) return;
  if (message.channel.type !== ChannelType.DM && !message.mentions.users.has(client.user!.id))
    return;
  if (!message.channel.isSendable()) return;

  const channel = message.channel;
  const typing = () => channel.sendTyping().catch(() => {});
  typing();
  const interval = setInterval(typing, 8000);
  try {
    const reply = await channelSession(message.channelId).ask(await describe(message));
    await deliver(
      reply,
      (c) => message.reply(c),
      (c) => channel.send(c),
    );
  } finally {
    clearInterval(interval);
  }
}

async function handleAsk(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const prompt = interaction.options.getString("prompt", true);
  const reply = await channelSession(interaction.channelId).ask(
    `[Discord /ask from owner]\n${prompt}`,
  );
  const text = `> ${prompt}\n\n${reply}`;
  try {
    await deliver(
      text,
      (c) => interaction.editReply(c),
      (c) => interaction.followUp(c),
    );
  } catch {
    // Interaction tokens expire after 15 minutes, so long turns post to the channel
    await send(interaction.channelId, text);
  }
}

async function handleNew(interaction: ChatInputCommandInteraction) {
  const session = channelSession(interaction.channelId);
  const model = interaction.options.getString("model");
  const effort = interaction.options.getString("effort") as
    | (typeof effortLevels)[number]
    | "default"
    | null;
  // "default" goes back to pukeko.toml, unset keeps the current choice
  session.reset({
    ...(model && { model: model === "default" ? config.agent.model : model }),
    ...(effort && { effort: effort === "default" ? config.agent.effort : effort }),
  });
  const setup = session.setup;
  const details = [setup.model, setup.effort && `${setup.effort} effort`].filter(Boolean);
  return interaction.reply(
    `🆕 Fresh conversation started${details.length ? ` (${details.join(", ")})` : ""}`,
  );
}

// Model aliases Claude Code understands, plus whatever's been typed
const modelChoices = ["default", "opus", "sonnet", "haiku"];

async function handleInteraction(interaction: Interaction) {
  if (interaction.isAutocomplete()) {
    const typed = interaction.options.getFocused().trim();
    const choices = modelChoices.filter((name) => name.startsWith(typed.toLowerCase()));
    if (typed && !choices.includes(typed)) choices.push(typed);
    return interaction.respond(choices.map((name) => ({ name, value: name })));
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.user.id !== ownerId)
    return interaction.reply({ content: "Not yours 🐦", flags: MessageFlags.Ephemeral });

  const session = channelSession(interaction.channelId);
  switch (interaction.commandName) {
    case "ask":
      return handleAsk(interaction);
    case "new":
      return handleNew(interaction);
    case "stop":
      return interaction.reply(session.stop() ? "⏹️ Stopping" : "Nothing running");
    case "compact":
      await interaction.deferReply();
      return interaction.editReply(await session.compact());
    case "usage":
      await interaction.deferReply();
      return interaction.editReply(await usageReport(session));
  }
}

client.on(Events.MessageCreate, (message) => {
  handleMessage(message).catch(console.error);
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch(console.error);
});

export async function startDiscord() {
  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(secrets.DISCORD_TOKEN);
  await ready;
  const application = await client.application!.fetch();
  if (!ownerId) {
    // A team-owned application reports the team, whose owner is the one we want
    const owner = application.owner;
    ownerId = (owner && "ownerId" in owner ? owner.ownerId : owner?.id) ?? "";
    if (!ownerId)
      throw new Error("Couldn't find the application's owner, set owner in pukeko.toml");
  }
  await application.commands.set(commands);
  console.log(`Logged in as ${client.user!.tag}, answering to ${ownerId}`);
}
