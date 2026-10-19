import {
  type APIMessageTopLevelComponent,
  ButtonStyle,
  ComponentType,
  type Message,
  MessageFlags,
  ModalBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { channelSession } from "#/agent/index.ts";
import { type Entry, forget, lookup } from "./buttons.ts";
import { keepTyping, send, where } from "./client.ts";
import { deliver } from "./render.ts";

const kinds = { button: "button", input: "text input", select: "select menu" };

// Every custom ID among a message's components
function customIds(message: Message) {
  const ids: string[] = [];
  function walk(node: unknown) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.custom_id === "string") ids.push(record.custom_id);
    walk(record.components);
    walk(record.accessory);
  }
  walk(message.components.map((c) => c.toJSON()));
  return ids;
}

// The message's components with some greyed out, ready to send back. Of those, only the one
// used keeps its colour, so a set shows what was picked. Uploads come back as CDN URLs, which
// files reject on edit, so they point at the message's own attachments again
function disable(message: Message, used: Set<string>, picked: string) {
  const names = new Map(message.attachments.map((a) => [a.id, a.name]));
  function media(item: { url?: string; attachment_id?: string }) {
    if (!item.url) return item;
    // Uploads are the only CDN attachment URLs, and their last path segment is the file name
    const url = new URL(item.url);
    const upload =
      /(^|\.)discord(app)?\.(com|net)$/.test(url.hostname) && /attachments\//.test(url.pathname);
    const name =
      (item.attachment_id && names.get(item.attachment_id)) ||
      (upload && decodeURIComponent(url.pathname.split("/").at(-1)!));
    return { url: name ? `attachment://${name}` : item.url };
  }
  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node))
      out[key] =
        (key === "media" || key === "file") && value && typeof value === "object"
          ? media(value)
          : walk(value);
    if (typeof out.custom_id === "string" && used.has(out.custom_id)) {
      out.disabled = true;
      if (out.custom_id !== picked && out.type === ComponentType.Button)
        out.style = ButtonStyle.Secondary;
    }
    return out;
  }
  return walk(message.components.map((c) => c.toJSON())) as APIMessageTopLevelComponent[];
}

// The message's text, so a click on an old message (or a job's) carries its context
function excerpt(message: Message) {
  const texts: string[] = message.content ? [message.content] : [];
  function walk(node: unknown) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string")
      texts.push(record.content);
    walk(record.components);
  }
  walk(message.components.map((c) => c.toJSON()));
  const text = texts.join("\n").trim();
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

function inputModal(customId: string, entry: Entry) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(entry.label.slice(0, 45))
    .addLabelComponents((label) =>
      label.setLabel(entry.label.slice(0, 45)).setTextInputComponent((input) => {
        input.setCustomId("text").setStyle(TextInputStyle.Paragraph).setMaxLength(4000);
        return entry.placeholder ? input.setPlaceholder(entry.placeholder.slice(0, 100)) : input;
      }),
    );
}

/** Buttons, selects and text inputs from the agent's replies, all with custom IDs pk:<id> */
export async function handleComponent(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
) {
  const id = interaction.customId.slice("pk:".length);
  const entry = lookup(id);
  if (!entry)
    return interaction.reply({ content: "This has expired", flags: MessageFlags.Ephemeral });
  if (entry.kind === "input" && interaction.isButton())
    return interaction.showModal(inputModal(interaction.customId, entry));

  // What was picked or typed, beyond the label itself
  let detail = "";
  if (interaction.isStringSelectMenu())
    detail = interaction.values.map((v) => entry.options?.[Number(v)] ?? v).join(", ");
  else if (interaction.isModalSubmit())
    detail = interaction.fields.getTextInputValue("text").trim();

  // Acknowledged within 3 seconds, greying out a one-time control or its whole group
  const message = interaction.isMessageComponent()
    ? interaction.message
    : interaction.isFromMessage()
      ? interaction.message
      : undefined;
  if (message && (entry.group || !entry.repeat)) {
    const used = new Set(
      entry.group
        ? customIds(message).filter((c) => lookup(c.slice("pk:".length))?.group === entry.group)
        : [interaction.customId],
    );
    used.add(interaction.customId);
    for (const c of used) forget(c.slice("pk:".length));
    const components = disable(message, used, interaction.customId);
    // A rejected edit leaves the click unanswered, so the turn still runs without it
    try {
      if (interaction.isMessageComponent()) await interaction.update({ components });
      else if (interaction.isFromMessage()) await interaction.update({ components });
    } catch (error) {
      // What Discord gave back for the files, to see why they didn't map
      const files: unknown[] = [];
      function find(node: unknown) {
        if (Array.isArray(node)) return node.forEach(find);
        if (!node || typeof node !== "object") return;
        const record = node as Record<string, unknown>;
        if (record.type === ComponentType.File) files.push(record.file);
        find(record.components);
      }
      find(message.components.map((c) => c.toJSON()));
      console.warn(
        "Couldn't grey out a used component:",
        error instanceof Error ? error.message : error,
        JSON.stringify({ files, attachments: message.attachments.map((a) => a.name) }),
      );
    }
  }
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const used = `[Discord ${kinds[entry.kind]} "${entry.label}" used by owner in ${where(interaction)}`;
  const context = message && excerpt(message);
  const prompt = [
    context
      ? `${used}, on a Pukeko message that said:]\n${context.replace(/^/gm, "> ")}`
      : `${used}]`,
    entry.prompt,
    detail && `${entry.kind === "select" ? "Picked" : "Typed"}: ${detail}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const channel = interaction.channel;
  const stopTyping = channel?.isSendable() ? keepTyping(channel) : () => {};
  try {
    const session = await channelSession(interaction.channelId!);
    const reply = await session.ask(prompt);
    const picked = entry.kind === "select" ? `: ${detail}` : "";
    const text = `-# ↪ ${entry.label}${picked}\n\n${reply}`;
    try {
      await deliver(
        text,
        (c) => interaction.followUp(c),
        (c) => interaction.followUp(c),
      );
    } catch {
      // Interaction tokens expire after 15 minutes, so long turns post to the channel
      await send(interaction.channelId ?? undefined, text);
    }
  } finally {
    stopTyping();
  }
}
