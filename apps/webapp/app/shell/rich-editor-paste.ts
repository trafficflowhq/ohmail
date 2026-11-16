"use client";

import { Extension, createDocument, type CommandProps } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Fragment, Slice, type Mark, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";

/**
 * PASTED TEXT KEEPS ITS LINES, Slack's composer the reference. Enter here is a hard break
 * (`EnterAsHardBreak`), so typed text is one block with breaks; the library's own paste made a
 * paragraph per line and dropped the empty lines, and a person cannot type a paragraph. So:
 * plain text becomes lines (every line break one hard break), with Slack's two list shapes;
 * markup from a page or another program becomes lines with its marks, lists, quotes and code
 * kept; and a run of paragraphs, pasted or loaded from a draft, is read as lines by one rule,
 * {@link paragraphsAsLines}.
 * A plain-text paste is put in by this extension's `handlePaste`, so TipTap's own paste plugin
 * never sees it and `editor.on("paste")` is not emitted for it (nothing listens to it today).
 */

/** Where Enter itself makes a paragraph: a quote's paragraphs are typed, and stay. */
const KEEPS_PARAGRAPHS = "blockquote";

/**
 * Every run of paragraphs side by side becomes ONE paragraph, each boundary two hard breaks (the
 * paragraphs stood apart, so one empty line stands between them). Nothing else moves: every text
 * node keeps its characters and marks, every list item stays an item, and the editor's own plain
 * text (a block boundary reads `\n\n`, a break `\n`) is the same before and after. Answers the
 * same fragment when nothing changed.
 */
export function paragraphsAsLines(content: Fragment, schema: Schema, keep = false): Fragment {
  const { paragraph, hardBreak } = schema.nodes;
  const out: ProseMirrorNode[] = [];
  let run: ProseMirrorNode[] = [];
  let changed = false;
  const close = (): void => {
    if (run.length > 1) {
      const inline: ProseMirrorNode[] = [];
      run.forEach((p, i) => {
        if (i > 0) inline.push(hardBreak.create(), hardBreak.create());
        p.content.forEach((n) => { inline.push(n); });
      });
      out.push(paragraph.create(run[0].attrs, inline));
      changed = true;
    } else out.push(...run);
    run = [];
  };
  content.forEach((node) => {
    let own = node;
    if (!node.isTextblock && !node.isLeaf) {
      const inner = paragraphsAsLines(node.content, schema, node.type.name === KEEPS_PARAGRAPHS);
      if (inner !== node.content) {
        own = node.copy(inner);
        changed = true;
      }
    }
    if (!keep && own.type === paragraph) run.push(own);
    else {
      close();
      out.push(own);
    }
  });
  close();
  return changed ? Fragment.from(out) : content;
}

/**
 * The command a draft set into an open editor runs in its `setContent` chain: the document's
 * paragraphs read as lines, in the same transaction.
 */
export function readParagraphsAsLines({ tr, dispatch }: CommandProps): boolean {
  const content = paragraphsAsLines(tr.doc.content, tr.doc.type.schema);
  if (dispatch && content !== tr.doc.content) tr.replaceWith(0, tr.doc.content.size, content);
  return true;
}

/** A document with its paragraphs read as lines; the same document when there were none. */
export function docAsLines(doc: ProseMirrorNode): ProseMirrorNode {
  const content = paragraphsAsLines(doc.content, doc.type.schema);
  return content === doc.content ? doc : doc.copy(content);
}

/* ── plain text ───────────────────────────────────────────────────────────────────────────── */

const BULLET = /^\s*[-*•] (\S.*)$/;
const NUMBERED = /^\s*(\d+)[.)] (\S.*)$/;
/** Indented two spaces or a tab, under an item: the item's own wrapped line. */
const CONTINUES = /^(?: {2,}|\t)\s*\S/;

export type TextBlock =
  | { kind: "lines"; lines: string[] }
  | { kind: "bullet" | "ordered"; items: string[] };

/**
 * Plain text read as Slack reads a paste: lines, and runs of `- `, `* ` or `• ` lines (a bullet
 * list) or `1. ` / `1) ` lines (a numbered list). A numbered line starts a list only at 1 and
 * continues one only at the next number; any other (a date, a year) stays a line, since the
 * letter numbers every list from 1. A line indented two spaces or more right under an item
 * continues it, joined with one space; an empty line or any other line ends the list. One line
 * with no break is never a list. Where nothing follows the caret in its line (`atEnd`), the
 * breaks after the last words are no lines of their own (a paste leaves no empty last line);
 * before words they stay. A text of breaks only stays as it is.
 */
export function textBlocks(text: string, atEnd = true): TextBlock[] {
  let read = text.replace(/\r\n?/g, "\n");
  if (atEnd) read = read.replace(/([^\n])\n+$/, "$1");
  const lines = read.split("\n");
  if (lines.length === 1) return [{ kind: "lines", lines }];
  const blocks: TextBlock[] = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBERED.exec(line);
    const n = number ? Number(number[1]) : 0;
    const next = last && last.kind === "ordered" && n === last.items.length + 1;
    const numbered = number && (n === 1 || next) ? number : null;
    if (bullet || numbered) {
      const kind = bullet ? "bullet" : "ordered";
      const item = bullet ? bullet[1] : numbered![2];
      if (last && last.kind === kind && (bullet || next)) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (last && last.kind !== "lines" && CONTINUES.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trimStart()}`;
    } else if (last && last.kind === "lines") last.lines.push(line);
    else blocks.push({ kind: "lines", lines: [line] });
  }
  return blocks;
}

/**
 * Plain text as the slice a paste inserts: each run of lines one paragraph with a hard break per
 * line break (an empty line two breaks in a row), each list a list. Open at a paragraph edge, so
 * the first and last lines join the line the caret stands in.
 */
export function textAsLines(text: string, schema: Schema, marks: readonly Mark[] = [], atEnd = true): Slice {
  const { paragraph, hardBreak, bulletList, orderedList, listItem } = schema.nodes;
  const words = (s: string): ProseMirrorNode[] => (s ? [schema.text(s, marks)] : []);
  const nodes = textBlocks(text, atEnd).map((b) => {
    if (b.kind === "lines") {
      return paragraph.create(null, b.lines.flatMap((l, i) => (i > 0 ? [hardBreak.create(), ...words(l)] : words(l))));
    }
    const items = b.items.map((it) => listItem.create(null, paragraph.create(null, words(it))));
    return (b.kind === "bullet" ? bulletList : orderedList).create(null, items);
  });
  const open = (n: ProseMirrorNode): number => (n.type === paragraph ? 1 : 0);
  return new Slice(Fragment.from(nodes), open(nodes[0]), open(nodes[nodes.length - 1]));
}

/* ── markup ───────────────────────────────────────────────────────────────────────────────── */

/** Block elements other than the two that hold lines; the schema decides what they become. */
const BLOCKS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD",
  "TFOOT", "TH", "THEAD", "TR", "UL",
]);
/** Markup that starts inside a table: the browser's parser would drop its tags, so it is left as is. */
const TABLE_PART = /^\s*(?:<meta[^>]*>\s*)*<(?:tr|td|th|thead|tbody|tfoot|col|colgroup|caption)\b/i;

/** Do these declarations set both vertical margins to zero? `null` when they do not say. */
function zeroMargins(declarations: string): boolean | null {
  let top: string | undefined;
  let bottom: string | undefined;
  for (const d of declarations.split(";")) {
    const at = d.indexOf(":");
    if (at < 0) continue;
    const name = d.slice(0, at).trim().toLowerCase();
    const v = d.slice(at + 1).replace(/!important/i, "").trim().split(/\s+/);
    if (name === "margin") [top, bottom] = [v[0], v[2] ?? v[0]];
    else if (name === "margin-top") top = v[0];
    else if (name === "margin-bottom") bottom = v[0];
  }
  const zero = (x: string): boolean => parseFloat(x) === 0;
  if ((top !== undefined && !zero(top)) || (bottom !== undefined && !zero(bottom))) return false;
  return top !== undefined && bottom !== undefined ? true : null;
}

/** The classes a style sheet in the markup gives no vertical margin (`p.MsoNormal{margin:0}`). */
function lineClasses(doc: Document): Set<string> {
  const found = new Set<string>();
  for (const sheet of Array.from(doc.querySelectorAll("style"))) {
    const css = (sheet.textContent ?? "").replace(/\/\*[\s\S]*?\*\/|<!--|-->/g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const zero = zeroMargins(rule[2]);
      for (const selector of rule[1].split(",")) {
        const cls = /^\s*(?:p)?\.([\w-]+)\s*$/i.exec(selector)?.[1];
        if (cls && zero === true) found.add(cls);
        else if (cls && zero === false) found.delete(cls);
      }
    }
  }
  return found;
}

type Item = { kind: "line" | "para" | "empty"; content: Node[] };

const blank = (n: Node): boolean => (n.textContent ?? "").replace(/[\s ]/g, "") === "";
const isBr = (n: Node): boolean => n.nodeName === "BR";
const hasBlock = (el: Element): boolean => Array.from(el.querySelectorAll("*")).some((e) => BLOCKS.has(e.nodeName));

/** The nodes without their last `<br>`, which a browser never draws as a line of its own. */
function withoutTrailingBreak(nodes: Node[]): Node[] {
  let end = nodes.length;
  while (end > 0 && nodes[end - 1].nodeType === 3 && blank(nodes[end - 1])) end -= 1;
  return end > 0 && isBr(nodes[end - 1]) ? nodes.slice(0, end - 1) : nodes;
}

/** Loose inline nodes between blocks: one line, or as many empty lines as they hold `<br>`s. */
function inlineItems(nodes: Node[]): Item[] {
  const words = nodes.some((n) => !isBr(n) && n.nodeType !== 8 && !blank(n));
  if (words) return [{ kind: "line", content: withoutTrailingBreak(nodes) }];
  return nodes.filter(isBr).map(() => ({ kind: "empty", content: [] }));
}

/** A `<div>` or `<p>` holding only inline content, as an item. */
function blockItem(el: Element, lines: ReadonlySet<string>): Item {
  if (blank(el)) return { kind: "empty", content: [] };
  let content = withoutTrailingBreak(Array.from(el.childNodes));
  const style = el.getAttribute("style");
  if (style) {
    // The block's own bold or italic is a style on it; a span keeps it on the words.
    const span = el.ownerDocument.createElement("span");
    span.setAttribute("style", style);
    span.append(...content);
    content = [span];
  }
  if (el.nodeName === "DIV") return { kind: "line", content };
  const own = zeroMargins(style ?? "");
  const line = own ?? Array.from(el.classList).some((c) => lines.has(c));
  return { kind: line ? "line" : "para", content };
}

/**
 * A run of line items and paragraphs as ONE `<p>`: one break between two lines, an empty line
 * where a paragraph stood apart or an empty block stood between; empty lines at the run's edges
 * are the neighbouring blocks' own spacing and go.
 */
function joinRun(doc: Document, items: Item[]): HTMLElement | null {
  const first = items.findIndex((i) => i.kind !== "empty");
  if (first < 0) return null;
  const p = doc.createElement("p");
  let prev: Item | null = null;
  let empties = 0;
  for (const item of items.slice(first)) {
    if (item.kind === "empty") {
      empties += 1;
      continue;
    }
    if (prev) {
      const apart = prev.kind === "para" || item.kind === "para" ? 2 : 1;
      for (let i = Math.max(empties + 1, apart); i > 0; i -= 1) p.append(doc.createElement("br"));
    }
    p.append(...item.content);
    prev = item;
    empties = 0;
  }
  return p;
}

/** Rewrites `el`'s runs of lines and paragraphs, innermost first; code blocks are left whole. */
function readBlocks(el: Element, lines: ReadonlySet<string>): void {
  for (const child of Array.from(el.children)) if (child.nodeName !== "PRE") readBlocks(child, lines);
  const doc = el.ownerDocument;
  let items: Item[] = [];
  let loose: Node[] = [];
  let sources: Node[] = [];
  const endLoose = (): void => {
    items.push(...inlineItems(loose));
    loose = [];
  };
  // Only where blocks stand: the inline content of a line is never taken apart.
  const holdsBlocks = Array.from(el.children).some((c) => BLOCKS.has(c.nodeName) || hasBlock(c));
  const endRun = (before: Node | null): void => {
    endLoose();
    const rewrite = holdsBlocks && (items.length > 1 || (items.length === 1 && items[0].kind === "empty"));
    if (rewrite) {
      const p = joinRun(doc, items);
      if (p) el.insertBefore(p, before);
      for (const n of sources) if (n.parentNode === el) el.removeChild(n);
    }
    items = [];
    sources = [];
  };
  for (const node of Array.from(el.childNodes)) {
    const elem = node.nodeType === 1 ? (node as Element) : null;
    const textHolder = elem && (elem.nodeName === "DIV" || elem.nodeName === "P") && !hasBlock(elem);
    if (elem && !textHolder && (BLOCKS.has(elem.nodeName) || hasBlock(elem))) {
      endRun(node);
      continue;
    }
    sources.push(node);
    if (elem && textHolder) {
      endLoose();
      items.push(blockItem(elem, lines));
    } else loose.push(node);
  }
  endRun(null);
}

/**
 * Markup from a page or another program, its lines as lines: a `<div>` per line (Gmail, Apple
 * Mail) or a `<p>` with no vertical margin (Google Docs, Outlook, Apple's text programs) is a
 * line; any other `<p>` is a paragraph, set apart by one empty line. ProseMirror's own copies
 * (`data-pm-slice`) are the editor's structure already and pass untouched.
 */
export function htmlAsLines(html: string): string {
  if (html.includes("data-pm-slice") || TABLE_PART.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  readBlocks(doc.body, lineClasses(doc));
  return doc.body.innerHTML;
}

/* ── the extension ────────────────────────────────────────────────────────────────────────── */

/**
 * The paste rule, and the reading a draft gets when it is put back. ProseMirror asks the text
 * parser for plain text (and for paste-as-plain-text), the html hook before it parses markup,
 * and `transformPasted` for every paste and drop; a code block's paste is ProseMirror's own,
 * verbatim. The draft's first content is read before the document exists (`onBeforeCreate`),
 * so it costs no transaction and no undo step; a draft set into an open editor reads it with
 * {@link readParagraphsAsLines} in the same transaction as its `setContent`.
 */
export const PasteAsLines = Extension.create({
  name: "pasteAsLines",
  // Before the lists' own paste handler (see `handlePaste`).
  priority: 101,

  onBeforeCreate() {
    const { content, parseOptions } = this.editor.options;
    if (content == null || content === "") return;
    const doc = createDocument(content, this.editor.schema, parseOptions);
    const lines = docAsLines(doc);
    if (lines !== doc) this.editor.setOptions({ content: lines.toJSON() });
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("pasteAsLines"),
        props: {
          clipboardTextParser: (text, $context, _plain, view) => {
            const { $to } = view.state.selection;
            const atEnd = $to.parentOffset === $to.parent.content.size;
            return textAsLines(text, view.state.schema, $context.marks(), atEnd);
          },
          transformPastedHTML: (html) => htmlAsLines(html),
          transformPasted: (slice, view) => {
            const content = paragraphsAsLines(slice.content, view.state.schema);
            return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
          },
          // The library's numbered list takes a plain paste of numbered lines alone, from any first
          // number (the letter then sends other numbers). Plain text goes in as ProseMirror puts a
          // paste, from the slice read above; a link pasted over words is the link's, which runs first.
          handlePaste: (view, event, slice) => {
            const data = event.clipboardData;
            if (!data || !slice.size || data.getData("text/html").trim() || data.getData("vscode-editor-data")) return false;
            const { content, openStart, openEnd } = slice;
            const node = openStart === 0 && openEnd === 0 && content.childCount === 1 ? content.firstChild : null;
            // ProseMirror's own `plain`: Shift held, Shift+Insert being an ordinary paste.
            const input = (view as unknown as { input?: { shiftKey?: boolean; lastKeyCode?: number } }).input;
            const plain = (input?.shiftKey ?? false) && input?.lastKeyCode !== 45;
            const tr = node ? view.state.tr.replaceSelectionWith(node, plain) : view.state.tr.replaceSelection(slice);
            view.dispatch(tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
            return true;
          },
        },
      }),
    ];
  },
});
