import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  ActionRowBuilder,
  type AttachmentPayload,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  DiscordAPIError,
  FileBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { paths } from "#/core/paths.ts";
import { register } from "./buttons.ts";
import { type Action, type Block, parse, type Style } from "./markup.ts";

export type Payload = BaseMessageOptions & { flags?: MessageFlags.IsComponentsV2 };

// Per Components v2 message
const limits = { chars: 4000, components: 40, files: 10 };

const buttonStyles: Record<Style, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
type Built = TextDisplayBuilder | MediaGalleryBuilder | FileBuilder | SeparatorBuilder | Row;
type Attach = (file: string) => string;

/** One indivisible part of a message, costed against the limits */
type Piece = {
  chars: number;
  components: number;
  /** Local files it uploads */
  files: string[];
  build: (attach: Attach) => Built | ContainerBuilder;
};

// Under `max` characters, split on newlines where possible
export function chunks(text: string, max = 1900) {
  const out: string[] = [];
  let rest = text.trim() || "(no reply)";
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

function isUrl(src: string) {
  return /^https?:\/\//i.test(src);
}

function piece(build: Piece["build"], files: string[] = [], components = 1): Piece {
  return { chars: 0, components, files, build };
}

function textPieces(text: string): Piece[] {
  return chunks(text, 3500).map((content) => ({
    ...piece(() => new TextDisplayBuilder().setContent(content)),
    chars: content.length,
  }));
}

function button(action: Action) {
  const out = new ButtonBuilder().setLabel(action.label.slice(0, 80));
  if (action.emoji) out.setEmoji(action.emoji);
  if (action.kind === "link") return out.setStyle(ButtonStyle.Link).setURL(action.url);
  const id = register({
    kind: action.kind,
    label: action.label,
    prompt: action.prompt,
    repeat: action.repeat,
    ...(action.group && { group: action.group }),
    ...(action.kind === "input" && action.placeholder && { placeholder: action.placeholder }),
  });
  return out.setCustomId(id).setStyle(buttonStyles[action.style ?? "secondary"]);
}

/** Pieces for a block, with any files it names that don't exist */
function pieces(block: Block, missing: string[]): Piece[] {
  function local(src: string) {
    if (isUrl(src)) return true;
    if (existsSync(resolve(paths.workspace, src))) return true;
    missing.push(src);
    return false;
  }

  switch (block.type) {
    case "text":
      return textPieces(block.text);
    case "images": {
      const items = block.items.filter((item) => local(item.src));
      const out: Piece[] = [];
      for (let i = 0; i < items.length; i += 10) {
        const group = items.slice(i, i + 10);
        out.push(
          piece(
            (attach) =>
              new MediaGalleryBuilder().addItems(
                group.map((item) => (g) => {
                  g.setURL(isUrl(item.src) ? item.src : attach(item.src)).setSpoiler(item.spoiler);
                  return item.alt ? g.setDescription(item.alt.slice(0, 1024)) : g;
                }),
              ),
            group.map((item) => item.src).filter((src) => !isUrl(src)),
          ),
        );
      }
      return out;
    }
    case "file":
      // File components only take uploads, not URLs
      if (isUrl(block.src)) return textPieces(block.src);
      if (!local(block.src)) return [];
      return [
        piece(
          (attach) => new FileBuilder().setURL(attach(block.src)).setSpoiler(block.spoiler),
          [block.src],
        ),
      ];
    case "separator":
      return [
        piece(() =>
          new SeparatorBuilder()
            .setDivider(block.divider)
            .setSpacing(block.large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small),
        ),
      ];
    case "actions": {
      const out: Piece[] = [];
      for (let i = 0; i < block.actions.length; i += 5) {
        // Registered now, so a button keeps one ID however the reply is split
        const buttons = block.actions.slice(i, i + 5).map(button);
        out.push(
          piece(
            () => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons),
            [],
            1 + buttons.length,
          ),
        );
      }
      return out;
    }
    case "select": {
      const options = block.options.slice(0, 25);
      const id = register({
        kind: "select",
        label: block.placeholder,
        prompt: block.prompt,
        options: options.map((o) => o.label),
        repeat: block.repeat,
        ...(block.group && { group: block.group }),
      });
      const menu = new StringSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(block.placeholder.slice(0, 150))
        .setMaxValues(block.multiple ? options.length : 1)
        .addOptions(
          options.map((o, i) => ({
            label: o.label.slice(0, 100),
            value: String(i),
            ...(o.description && { description: o.description.slice(0, 100) }),
            ...(o.emoji && { emoji: o.emoji }),
          })),
        );
      return [
        piece(() => new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), [], 2),
      ];
    }
    case "box":
      return boxes(
        block.blocks.flatMap((b) => pieces(b, missing)),
        block.color,
      );
  }
}

function fits(pieces: Piece[], extra = 0) {
  const files = new Set(pieces.flatMap((p) => p.files));
  return (
    pieces.reduce((n, p) => n + p.chars, 0) <= limits.chars &&
    pieces.reduce((n, p) => n + p.components, extra) <= limits.components &&
    files.size <= limits.files
  );
}

// Greedily fills groups that each fit in a message, `extra` components spare for a wrapper
function pack(pieces: Piece[], extra = 0) {
  const groups: Piece[][] = [];
  for (const piece of pieces) {
    const last = groups.at(-1);
    if (last && fits([...last, piece], extra)) last.push(piece);
    else groups.push([piece]);
  }
  return groups;
}

function addTo(box: ContainerBuilder, built: Built) {
  if (built instanceof TextDisplayBuilder) box.addTextDisplayComponents(built);
  else if (built instanceof MediaGalleryBuilder) box.addMediaGalleryComponents(built);
  else if (built instanceof FileBuilder) box.addFileComponents(built);
  else if (built instanceof SeparatorBuilder) box.addSeparatorComponents(built);
  else box.addActionRowComponents(built.toJSON());
}

// A box too big for one message becomes several, one after another
function boxes(children: Piece[], color?: number): Piece[] {
  return pack(children, 1).map((group) => ({
    chars: group.reduce((n, p) => n + p.chars, 0),
    components: 1 + group.reduce((n, p) => n + p.components, 0),
    files: group.flatMap((p) => p.files),
    build: (attach) => {
      const box = new ContainerBuilder();
      if (color !== undefined) box.setAccentColor(color);
      for (const piece of group) addTo(box, piece.build(attach) as Built);
      return box;
    },
  }));
}

function message(group: Piece[]): Payload {
  const files: AttachmentPayload[] = [];
  const names = new Map<string, string>();
  function attach(src: string) {
    const file = resolve(paths.workspace, src);
    let name = names.get(file);
    if (!name) {
      // Numbered so two files with the same name don't collide
      name = `${files.length}-${basename(file).replace(/[^\w.-]/g, "_")}`;
      names.set(file, name);
      files.push({ attachment: file, name });
    }
    return `attachment://${name}`;
  }
  return {
    components: group.map((piece) => piece.build(attach)),
    files,
    flags: MessageFlags.IsComponentsV2,
  };
}

/** The agent's reply as messages: plain text, or Components v2 once it uses any markup */
export function render(reply: string): Payload[] {
  const { blocks, rich, problems } = parse(reply);
  const missing: string[] = [];
  const all = rich ? blocks.flatMap((block) => pieces(block, missing)) : [];
  const notes = [
    missing.length && `Couldn't find ${missing.join(", ")}`,
    problems.length && `Couldn't render ${problems.join("; ")}`,
  ].filter(Boolean);
  const note = notes.length ? `-# ${notes.join(". ")}` : "";
  if (!rich) return chunks(note ? `${reply}\n${note}` : reply).map((content) => ({ content }));
  if (note) all.push(...textPieces(note));
  if (!all.length) all.push(...textPieces(""));
  return pack(all).map(message);
}

export async function deliver(
  reply: string,
  first: (payload: Payload) => Promise<unknown>,
  rest = first,
) {
  let post = first;
  async function next(payload: Payload) {
    const current = post;
    post = rest;
    await current(payload).catch((error) => {
      post = current;
      throw error;
    });
  }
  const parts = render(reply);
  try {
    for (const part of parts) await next(part);
  } catch (error) {
    // A layout Discord rejects still gets through, as the raw markup
    if (!(error instanceof DiscordAPIError) || error.code !== 50035 || !parts[0]?.flags)
      throw error;
    console.warn("Discord rejected a rich reply", error.message);
    const note = `-# Couldn't render this reply: ${error.message.split("\n").slice(0, 3).join(" ")}`;
    for (const content of chunks(`${reply}\n${note}`)) await next({ content });
  }
}
