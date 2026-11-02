import {
  type APIComponentInLabel,
  type APIMessageTopLevelComponent,
  type APIModalInteractionResponseCallbackData,
  ButtonStyle,
  ComponentType,
  type Message,
  ModalBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
  type ModalData,
  type ModalSubmitInteraction,
} from "discord.js";
import { logger, preview } from "#/core/log.ts";
import { type Entry, forget, lookup } from "./buttons.ts";
import { responder, tell, whileTyping, where } from "./client.ts";
import type { Field } from "./markup.ts";
import { chatTurn } from "./restart.ts";

const log = logger("discord");
const kinds = { button: "button", input: "text input", modal: "form", select: "select menu" };

type Node = Record<string, unknown>;

// Every component on a message, nested ones included
function nodes(message: Message) {
  const out: Node[] = [];
  function walk(node: unknown) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    out.push(node as Node);
    walk((node as Node).components);
    walk((node as Node).accessory);
  }
  walk(message.components.map((c) => c.toJSON()));
  return out;
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
    const out: Node = {};
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
  const texts = nodes(message)
    .filter((node) => node.type === ComponentType.TextDisplay)
    .map((node) => node.content);
  const text = [message.content, ...texts].join("\n").trim();
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

const pickers = {
  user: ComponentType.UserSelect,
  role: ComponentType.RoleSelect,
  channel: ComponentType.ChannelSelect,
} as const;

// The component asking a form's question, its custom ID the question's index
function question(field: Field, index: number): APIComponentInLabel {
  const custom_id = String(index);
  const { required } = field;
  const min_values = required ? 1 : 0;
  switch (field.kind) {
    case "text":
      return {
        type: ComponentType.TextInput,
        custom_id,
        style: field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
        required,
        max_length: 4000,
        ...(field.placeholder && { placeholder: field.placeholder.slice(0, 100) }),
      };
    case "checkbox":
      return { type: ComponentType.Checkbox, custom_id };
    case "choice": {
      const options = (field.options ?? [])
        .slice(0, 25)
        .map((label, i) => ({ label: label.slice(0, 100), value: String(i) }));
      // Radio and checkbox groups take up to 10 options, selects 25
      if (options.length > 10)
        return {
          type: ComponentType.StringSelect,
          custom_id,
          required,
          options,
          min_values,
          max_values: field.multiple ? options.length : 1,
        };
      return field.multiple
        ? {
            type: ComponentType.CheckboxGroup,
            custom_id,
            required,
            options,
            min_values,
            max_values: options.length,
          }
        : { type: ComponentType.RadioGroup, custom_id, required, options };
    }
    default:
      return {
        type: pickers[field.kind],
        custom_id,
        required,
        min_values,
        max_values: field.multiple ? 25 : 1,
      };
  }
}

function formModal(customId: string, entry: Entry): APIModalInteractionResponseCallbackData {
  return {
    custom_id: customId,
    title: (entry.title ?? entry.label).slice(0, 45),
    components: (entry.fields ?? []).map((field, i) => ({
      type: ComponentType.Label,
      label: field.label.slice(0, 45),
      ...(field.description && { description: field.description.slice(0, 100) }),
      component: question(field, i),
    })),
  };
}

function answer(field: Field, data: ModalData | undefined) {
  if (!data) return "(skipped)";
  if (data.type === ComponentType.Checkbox) return data.value ? "yes" : "no";
  if (data.type === ComponentType.TextInput) {
    const text = data.value.trim();
    return text.includes("\n") ? `\n${text.replace(/^/gm, "> ")}` : text || "(skipped)";
  }
  const values =
    data.type === ComponentType.RadioGroup
      ? data.value === null
        ? []
        : [data.value]
      : "values" in data
        ? data.values
        : [];
  const names = values.map((value) => {
    if (field.kind === "choice") return field.options?.[Number(value)] ?? value;
    if (
      data.type !== ComponentType.UserSelect &&
      data.type !== ComponentType.RoleSelect &&
      data.type !== ComponentType.ChannelSelect
    )
      return value;
    const user = data.users?.get(value)?.username;
    const role = data.roles?.get(value)?.name;
    const channel = data.channels?.get(value)?.name;
    const name = user ? `@${user}` : role ? `@${role}` : channel ? `#${channel}` : undefined;
    return name ? `${name} (${value})` : value;
  });
  return names.join(", ") || "(skipped)";
}

// A form's answers, one line per question
function answers(interaction: ModalSubmitInteraction, fields: Field[]) {
  return fields
    .map((field, i) => `${field.label}: ${answer(field, interaction.fields.fields.get(String(i)))}`)
    .join("\n");
}

/** Buttons, selects, text inputs and forms from the agent's replies, all with custom IDs pk:<id> */
export async function handleComponent(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
) {
  const entry = lookup(interaction.customId);
  if (!entry) {
    log.info(`An expired component was used, ${interaction.customId}`);
    return tell(interaction, "This has expired");
  }
  if (entry.kind === "input" && interaction.isButton())
    return interaction.showModal(inputModal(interaction.customId, entry));
  if (entry.kind === "modal" && interaction.isButton())
    return interaction.showModal(formModal(interaction.customId, entry));

  // What was picked or typed, beyond the label itself
  let detail = "";
  if (interaction.isStringSelectMenu())
    detail = interaction.values.map((v) => entry.options?.[Number(v)] ?? v).join(", ");
  else if (interaction.isModalSubmit())
    detail =
      entry.kind === "modal"
        ? answers(interaction, entry.fields ?? [])
        : interaction.fields.getTextInputValue("text").trim();

  // Acknowledged within 3 seconds, greying out a one-time control or its whole group
  const onMessage =
    interaction.isMessageComponent() || interaction.isFromMessage() ? interaction : undefined;
  const message = onMessage?.message;
  if (onMessage && message && (entry.group || !entry.repeat)) {
    const used = new Set([interaction.customId]);
    if (entry.group)
      for (const { custom_id } of nodes(message))
        if (typeof custom_id === "string" && lookup(custom_id)?.group === entry.group)
          used.add(custom_id);
    used.forEach(forget);
    // A rejected edit leaves the click unanswered, so the turn still runs without it
    await onMessage
      .update({ components: disable(message, used, interaction.customId) })
      .catch((error: Error) => log.warn(`Couldn't grey out a used component: ${error.message}`));
  }
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  log.info(`${kinds[entry.kind]} "${entry.label}" used${detail ? `: ${preview(detail)}` : ""}`);

  const used = `[Discord ${kinds[entry.kind]} "${entry.label}" used by owner in ${where(interaction)}`;
  const context = message && excerpt(message);
  const prompt = [
    context
      ? `${used}, on a Pukeko message that said:]\n${context.replace(/^/gm, "> ")}`
      : `${used}]`,
    entry.prompt,
    detail &&
      (entry.kind === "modal"
        ? `Answers:\n${detail}`
        : `${entry.kind === "select" ? "Picked" : "Typed"}: ${detail}`),
  ]
    .filter(Boolean)
    .join("\n\n");

  const picked = entry.kind === "select" ? `: ${detail}` : "";
  const post = responder(interaction, `-# ↪ ${entry.label}${picked}\n\n`);
  const reply = await whileTyping(interaction.channel, () =>
    chatTurn(interaction.channelId!, prompt, post),
  );
  await post(reply);
}
