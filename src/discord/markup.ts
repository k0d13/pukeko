// The agent's replies are Discord markdown plus generic directives (the CommonMark proposal
// remark-directive implements), each on its own line:
//   ![alt](path)                          an image, consecutive ones share a gallery
//   ::name[label]{key="value" flag}       a leaf: button, link, input, image, file, separator
//   :::name[label]{...} ... :::           a container: box, select
// Anything that doesn't parse stays as text, so a reply is never lost

export type Style = "primary" | "secondary" | "success" | "danger";

export type Action =
  | {
      kind: "button";
      label: string;
      prompt: string;
      style?: Style;
      emoji?: string;
      repeat: boolean;
      /** Using one control in a group greys out the rest of it on that message */
      group?: string;
    }
  | {
      kind: "input";
      label: string;
      prompt: string;
      placeholder?: string;
      style?: Style;
      emoji?: string;
      repeat: boolean;
      group?: string;
    }
  | { kind: "link"; label: string; url: string; emoji?: string };

export type Option = { label: string; description?: string; emoji?: string };

export type Block =
  | { type: "text"; text: string }
  | { type: "images"; items: { src: string; alt: string; spoiler: boolean }[] }
  | { type: "file"; src: string; spoiler: boolean }
  | { type: "separator"; large: boolean; divider: boolean }
  | { type: "actions"; actions: Action[] }
  | {
      type: "select";
      placeholder: string;
      prompt: string;
      options: Option[];
      multiple: boolean;
      repeat: boolean;
      group?: string;
    }
  | { type: "box"; color?: number; blocks: Block[] };

type Directive = { name: string; label: string; attrs: Record<string, string> };

const leaf = /^::(\w+)(?:\[([^\]]*)\])?(?:\{(.*)\})?\s*$/;
const open = /^:::(\w+)(?:\[([^\]]*)\])?(?:\{(.*)\})?\s*$/;
const close = /^:::\s*$/;
const image = /^!\[([^\]]*)\]\(\s*<?([^\s>)]+)>?(?:\s+"[^"]*")?\s*\)\s*$/;
const rule = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const fence = /^ {0,3}(`{3,}|~{3,})/;
const styles = new Set(["primary", "secondary", "success", "danger"]);

// key="value", key='value', key=value, or a bare flag
function attributes(text = "") {
  const attrs: Record<string, string> = {};
  for (const [, key, double, single, bare] of text.matchAll(
    /([\w-]+)(?:=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+)))?/g,
  ))
    attrs[key!] = double?.replace(/\\(.)/g, "$1") ?? single ?? bare ?? "true";
  return attrs;
}

function directive(match: RegExpMatchArray): Directive {
  return {
    name: match[1]!.toLowerCase(),
    label: match[2]?.trim() ?? "",
    attrs: attributes(match[3]),
  };
}

function flag(value: string | undefined) {
  return value !== undefined && value !== "false";
}

function style(value: string | undefined) {
  return value && styles.has(value) ? (value as Style) : undefined;
}

/** A leaf directive as a block or action, or why it can't be one */
function leafBlock({ name, label, attrs }: Directive): Block | Action | string {
  switch (name) {
    case "button":
    case "input": {
      if (!label) return `::${name} needs a [label]`;
      if (!attrs.prompt) return `::${name}[${label}] needs a prompt`;
      const common = {
        label,
        prompt: attrs.prompt,
        style: style(attrs.style),
        emoji: attrs.emoji,
        repeat: flag(attrs.repeat),
        group: attrs.group,
      };
      return name === "button"
        ? { kind: "button", ...common }
        : { kind: "input", ...common, placeholder: attrs.placeholder };
    }
    case "link":
      if (!label || !/^https?:\/\//i.test(attrs.url ?? "")) return `::link needs a [label] and url`;
      return { kind: "link", label, url: attrs.url!, emoji: attrs.emoji };
    case "image": {
      const src = attrs.src ?? label;
      if (!src) return "::image needs a src";
      return {
        type: "images",
        items: [{ src, alt: attrs.alt ?? "", spoiler: flag(attrs.spoiler) }],
      };
    }
    case "file": {
      const src = attrs.src ?? label;
      if (!src) return "::file needs a src";
      return { type: "file", src, spoiler: flag(attrs.spoiler) };
    }
    case "separator":
      return { type: "separator", large: flag(attrs.large), divider: attrs.divider !== "false" };
    default:
      return `unknown directive ::${name}`;
  }
}

function hexColor(value: string | undefined) {
  const hex = value?.replace(/^#/, "");
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : undefined;
}

export function parse(reply: string) {
  const problems: string[] = [];
  const root: Block[] = [];
  // The box being filled, and the select inside it or at the top level
  let box: Extract<Block, { type: "box" }> | undefined;
  let select: Extract<Block, { type: "select" }> | undefined;
  let text: string[] = [];
  let fenced = "";
  let rich = false;

  const target = () => box?.blocks ?? root;

  function flush() {
    const value = text.join("\n").replace(/^\n+|\s+$/g, "");
    text = [];
    if (value) target().push({ type: "text", text: value });
  }

  // Images and actions join the block before them when only blank lines are between
  function push(block: Block | Action) {
    const blank = !text.some((line) => line.trim());
    if (blank) text = [];
    else flush();
    const blocks = target();
    const last = blocks.at(-1);
    if ("kind" in block) {
      if (blank && last?.type === "actions") last.actions.push(block);
      else blocks.push({ type: "actions", actions: [block] });
    } else if (blank && block.type === "images" && last?.type === "images")
      last.items.push(...block.items);
    else blocks.push(block);
  }

  for (const line of reply.split(/\r?\n/)) {
    const fenceMatch = line.match(fence);
    if (fenced) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fenced)) fenced = "";
      text.push(line);
      continue;
    }
    if (fenceMatch) {
      fenced = fenceMatch[1]!;
      text.push(line);
      continue;
    }

    if (select) {
      const option = line.match(/^\s*[-*]\s+(.+?)\s*$/);
      const optionLeaf = line.match(leaf);
      if (close.test(line)) {
        if (!select.options.length) problems.push(`select "${select.placeholder}" has no options`);
        else target().push(select);
        select = undefined;
      } else if (optionLeaf && optionLeaf[1] === "option" && optionLeaf[2]) {
        const { label, attrs } = directive(optionLeaf);
        select.options.push({ label, description: attrs.description, emoji: attrs.emoji });
      } else if (option) select.options.push({ label: option[1]! });
      else if (line.trim()) problems.push(`"${line.trim()}" isn't an option in a select`);
      continue;
    }

    const opening = line.match(open);
    if (opening) {
      const { name, label, attrs } = directive(opening);
      if (name === "select") {
        if (!attrs.prompt) {
          problems.push(`:::select needs a prompt`);
          text.push(line);
          continue;
        }
        rich = true;
        const blank = !text.some((l) => l.trim());
        if (blank) text = [];
        else flush();
        select = {
          type: "select",
          placeholder: label || "Choose",
          prompt: attrs.prompt,
          options: [],
          multiple: flag(attrs.multiple),
          repeat: flag(attrs.repeat),
          group: attrs.group,
        };
      } else if (name === "box" && !box) {
        rich = true;
        flush();
        box = { type: "box", color: hexColor(attrs.color), blocks: [] };
        root.push(box);
      } else {
        problems.push(name === "box" ? "boxes can't be nested" : `unknown container :::${name}`);
        text.push(line);
      }
      continue;
    }
    if (close.test(line) && box) {
      flush();
      box = undefined;
      continue;
    }

    const leafMatch = line.match(leaf);
    if (leafMatch) {
      const block = leafBlock(directive(leafMatch));
      if (typeof block === "string") {
        problems.push(block);
        text.push(line);
      } else {
        rich = true;
        push(block);
      }
      continue;
    }

    const imageMatch = line.match(image);
    if (imageMatch) {
      rich = true;
      push({
        type: "images",
        items: [{ src: imageMatch[2]!, alt: imageMatch[1]!, spoiler: false }],
      });
      continue;
    }

    if (rule.test(line)) {
      flush();
      target().push({ type: "separator", large: false, divider: true });
      continue;
    }

    text.push(line);
  }

  if (select) {
    problems.push(`select "${select.placeholder}" was never closed with :::`);
    if (select.options.length) target().push(select);
  }
  flush();
  return { blocks: root, rich, problems };
}
