import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { channelSession } from "./agent.ts";
import { config, secrets } from "./config.ts";

export const client = new Client({
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
    .setDescription("Start a fresh conversation in this channel"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop the current turn in this channel"),
].map((c) => c.setDMPermission(true).toJSON());

// Split on newlines where possible to stay under Discord's 2000 char limit.
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

// A channel by ID, or the owner's DMs when none is given.
export async function resolveChannel(channelId?: string) {
  const channel = channelId
    ? await client.channels.fetch(channelId)
    : await (await client.users.fetch(config.ownerId)).createDM();
  if (!channel?.isSendable()) throw new Error(`Can't send to ${channelId}`);
  return channel;
}

export async function send(channelId: string | undefined, text: string) {
  const channel = await resolveChannel(channelId);
  for (const chunk of chunks(text)) await channel.send(chunk);
}

async function describe(message: Message) {
  const where =
    message.channel.type === ChannelType.DM
      ? "DM"
      : `#${"name" in message.channel ? message.channel.name : message.channelId}`;
  let text = message.content.replaceAll(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  for (const a of message.attachments.values()) text += `\n[Attachment: ${a.name} ${a.url}]`;
  if (message.reference?.messageId) {
    const ref = await message.fetchReference().catch(() => undefined);
    if (ref) text = `[Replying to ${ref.author.username}: ${ref.content}]\n\n${text}`;
  }
  return `[Discord message from owner in ${where}]\n${text}`;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.id !== config.ownerId) return;
  const isDM = message.channel.type === ChannelType.DM;
  if (!isDM && !message.mentions.users.has(client.user!.id)) return;

  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  message.channel.sendTyping().catch(() => {});
  try {
    const reply = await channelSession(message.channelId).ask(await describe(message));
    const [first, ...rest] = chunks(reply);
    await message.reply(first!);
    for (const chunk of rest) await message.channel.send(chunk);
  } catch (error) {
    console.error(error);
  } finally {
    clearInterval(typing);
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch(console.error);
});

async function handleInteraction(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.user.id !== config.ownerId)
    return interaction.reply({ content: "Not yours 🐦", ephemeral: true });

  if (interaction.commandName === "new") {
    channelSession(interaction.channelId).reset();
    return interaction.reply("🆕 Fresh session started.");
  }
  if (interaction.commandName === "stop")
    return interaction.reply(
      channelSession(interaction.channelId).stop() ? "⏹️ Stopping." : "Nothing running.",
    );

  await interaction.deferReply();
  const prompt = interaction.options.getString("prompt", true);
  const reply = await channelSession(interaction.channelId).ask(
    `[Discord /ask from owner]\n${prompt}`,
  );
  const text = `> ${prompt}\n\n${reply}`;
  try {
    const [first, ...rest] = chunks(text);
    await interaction.editReply(first!);
    for (const chunk of rest) await interaction.followUp(chunk);
  } catch {
    // Interaction tokens expire after 15 minutes; post to the channel instead.
    await send(interaction.channelId, text);
  }
}

export async function startDiscord() {
  await new REST()
    .setToken(secrets.DISCORD_TOKEN!)
    .put(Routes.applicationCommands(config.discordAppId), { body: commands });
  await client.login(secrets.DISCORD_TOKEN);
  await new Promise((r) => client.once(Events.ClientReady, r));
  console.log(`Logged in as ${client.user!.tag}`);
}
