// The agent's replies are Discord markdown plus generic directives (the CommonMark proposal
// remark-directive implements), each on its own line:
//   ![alt](path)                          an image, consecutive ones share a gallery
//   ::name[label]{key="value" flag}       a leaf: button, link, question, image, file, separator
//   :::name[label]{...} ... :::           a container: box, select, form
// Anything that doesn't parse stays as text, so a reply is never lost. Directives say what
// to ask, not how, so they aren't tied to Discord's components

export type Style = "primary" | "secondary" | "success" | "danger";

type Control = {
  label: string;
  prompt: string;
  style?: Style;
  emoji?: string;
  repeat: boolean;
  /** Using one control in a group greys out the rest of it on that message */
  group?: string;
};

/** A question in a form */
export type Question = {
  kind: "input" | "choice" | "checkbox";
  label: string;
  description?: string;
  required: boolean;
  /** An input's hint */
  placeholder?: string;
  /** A multi-line input */
  paragraph?: boolean;
  /** A choice's options */
  options?: string[];
  /** Lets a choice take several */
  multiple?: boolean;
};

/** What a form shows: its questions, and any text around them */
export type Field = Question | { kind: "text"; text: string };

export type Action =
  | ({ kind: "button" } & Control)
  | ({ kind: "form"; title: string; fields: Field[] } & Control)
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

function control(label: string, attrs: Record<string, string>) {
  return {
    label,
    prompt: attrs.prompt!,
    style: style(attrs.style),
    emoji: attrs.emoji,
    repeat: flag(attrs.repeat),
    group: attrs.group,
  };
}

/** A leaf directive as a block or action, or why it can't be one */
function leafBlock({ name, label, attrs }: Directive, problems: string[]): Block | Action | string {
  if (name === "button" || questionKinds.has(name)) {
    if (!label) return `::${name} needs a [label]`;
    if (!attrs.prompt) return `::${name}[${label}] needs a prompt`;
    const common = control(label, attrs);
    if (name === "button") return { kind: "button", ...common };
    // A question on its own is a form asking just that, and needs an answer
    const field = fieldOf(
      { name, label: attrs.question ?? label, attrs: { required: "true", ...attrs } },
      problems,
    );
    if (typeof field === "string") return field;
    return { kind: "form", ...common, title: attrs.title ?? label, fields: [field] };
  }
  switch (name) {
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

const questionKinds = new Set<string>(["input", "choice", "checkbox"] satisfies Question["kind"][]);

// The most questions and texts a form can show, Discord's limit on a modal's components
const maxFields = 5;
// The most options a choice can offer, Discord's limit on a select's
const maxOptions = 25;

/** A question leaf, or why it can't be one */
function fieldOf({ name, label, attrs }: Directive, problems: string[]): Question | string {
  if (!questionKinds.has(name)) return `::${name} isn't a question`;
  if (!label) return `::${name} needs a [label]`;
  const field: Question = {
    kind: name as Question["kind"],
    label,
    description: attrs.description,
    required: flag(attrs.required),
  };
  if (name === "input") {
    field.paragraph = flag(attrs.paragraph);
    field.placeholder = attrs.placeholder;
  }
  if (name === "choice") {
    field.options = (attrs.options ?? "")
      .split("|")
      .map((o) => o.trim())
      .filter(Boolean);
    if (field.options.length < 2) return `::choice[${label}] needs options="A|B", at least two`;
    if (field.options.length > maxOptions) {
      problems.push(`::choice[${label}] has over ${maxOptions} options, the rest were left out`);
      field.options = field.options.slice(0, maxOptions);
    }
    field.multiple = flag(attrs.multiple);
  }
  return field;
}

function hexColor(value: string | undefined) {
  const hex = value?.replace(/^#/, "");
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : undefined;
}

export function parse(reply: string) {
  const problems: string[] = [];
  const root: Block[] = [];
  // The box being filled, and the select or form inside it or at the top level
  let box: Extract<Block, { type: "box" }> | undefined;
  let select: Extract<Block, { type: "select" }> | undefined;
  let form: Extract<Action, { kind: "form" }> | undefined;
  // The open form's lines as written, its text since the last question, the index of the last
  // line it's sure to own (its opener, then each question), and how many problems there were then
  let formLines: string[] = [];
  let note: string[] = [];
  let formEnd = 0;
  let formProblems = 0;
  // A container that couldn't open, kept as text up to and including its :::
  let dud = false;
  let text: string[] = [];
  let fenced = "";
  let rich = false;

  const target = () => box?.blocks ?? root;

  function flush() {
    const value = text.join("\n").replace(/^\n+|\s+$/g, "");
    text = [];
    if (value) target().push({ type: "text", text: value });
  }

  // Ends the text so far, saying whether there was any
  function settle() {
    const blank = !text.some((line) => line.trim());
    if (blank) text = [];
    else flush();
    return blank;
  }

  // Images and actions join the block before them when only blank lines are between
  function push(block: Block | Action) {
    const blank = settle();
    const blocks = target();
    const last = blocks.at(-1);
    if ("kind" in block) {
      if (blank && last?.type === "actions") last.actions.push(block);
      else blocks.push({ type: "actions", actions: [block] });
    } else if (blank && block.type === "images" && last?.type === "images")
      last.items.push(...block.items);
    else blocks.push(block);
  }

  // A line of the open form's text, or of the reply's
  function keep(line: string) {
    if (form) note.push(line);
    else text.push(line);
  }

  // The form's text since its last question, shown in it as written
  function noted() {
    const value = note.join("\n").replace(/^\n+|\s+$/g, "");
    note = [];
    if (value) form!.fields.push({ kind: "text", text: value });
  }

  // Ends the open form; one without questions stays as the text it was written as
  function endForm() {
    const done = form!;
    form = undefined;
    if (!done.fields.some((field) => field.kind !== "text")) {
      problems.push(`form "${done.label}" has no questions`);
      text.push(...formLines);
      return;
    }
    if (done.fields.length > maxFields) {
      problems.push(
        `form "${done.label}" has over ${maxFields} questions and texts, the rest were left out`,
      );
      done.fields = done.fields.slice(0, maxFields);
    }
    push(done);
  }

  const lines = reply.split(/\r?\n/);
  for (let i = 0; ; i++) {
    if (i === lines.length) {
      if (!form) break;
      // A form never closed ends at its last question, and what follows is read as usual
      problems.length = formProblems;
      problems.push(`form "${form.label}" was never closed with :::`);
      formLines = formLines.slice(0, formEnd + 1 - (i - formLines.length));
      note = [];
      fenced = "";
      endForm();
      i = formEnd;
      continue;
    }
    const line = lines[i]!;
    if (form) formLines.push(line);

    const fenceMatch = line.match(fence);
    if (fenced) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fenced)) fenced = "";
      keep(line);
      continue;
    }
    if (fenceMatch) {
      fenced = fenceMatch[1]!;
      keep(line);
      continue;
    }

    if (dud) {
      text.push(line);
      if (close.test(line)) dud = false;
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

    if (form) {
      const fieldLeaf = line.match(leaf);
      const field = fieldLeaf && fieldOf(directive(fieldLeaf), problems);
      if (close.test(line)) {
        noted();
        endForm();
      } else if (field && typeof field !== "string") {
        noted();
        form.fields.push(field);
        formEnd = i;
        formProblems = problems.length;
      } else {
        if (field) problems.push(field);
        note.push(line);
      }
      continue;
    }

    const opening = line.match(open);
    if (opening) {
      const { name, label, attrs } = directive(opening);
      const broken =
        name === "select"
          ? !attrs.prompt && `:::select needs a prompt`
          : name === "form"
            ? (!label || !attrs.prompt) && `:::form needs a [label] and prompt`
            : name === "box"
              ? !!box && "boxes can't be nested"
              : `unknown container :::${name}`;
      if (broken) {
        problems.push(broken);
        text.push(line);
        dud = true;
      } else if (name === "select") {
        rich = true;
        settle();
        const { prompt, repeat, group } = control(label, attrs);
        select = {
          type: "select",
          placeholder: label || "Choose",
          prompt,
          options: [],
          multiple: flag(attrs.multiple),
          repeat,
          group,
        };
      } else if (name === "form") {
        rich = true;
        form = { kind: "form", ...control(label, attrs), title: attrs.title ?? label, fields: [] };
        formLines = [line];
        formEnd = i;
        formProblems = problems.length;
      } else {
        rich = true;
        flush();
        box = { type: "box", color: hexColor(attrs.color), blocks: [] };
        root.push(box);
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
      const block = leafBlock(directive(leafMatch), problems);
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
