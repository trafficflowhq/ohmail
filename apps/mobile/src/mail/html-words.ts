/**
 * AN HTML PART'S WORDS, as a conversation member draws them. A member is drawn as text, and mail
 * whose html is not the message's root (html inside multipart/related or multipart/mixed, with no
 * text part) is stored with no text at all: drawn from its text it was a blank card. Read from the
 * same parse the sanitizer and the history fold use, so a member says what its frame would. Walked
 * with a stack, not recursion: the nesting is the sender's.
 */
import { parseDocument } from "htmlparser2";
import { Element, Text, type AnyNode } from "domhandler";
import { DROP_CONTENT, MAIL_MAX_HTML_CHARS } from "./quoted-tree";

/** Content nobody reads: the sanitizer's dropped tags, and the sheets. */
const UNREAD = new Set([...DROP_CONTENT, "style", "script", "head", "title"]);
/** A blank line around these. */
const PARAGRAPH = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "table", "pre", "hr", "blockquote"]);
/** A line of their own. */
const LINE = new Set([
  "div", "li", "tr", "dt", "dd", "address", "article", "aside", "center", "caption", "figure", "figcaption",
  "footer", "form", "header", "main", "nav", "section", "tbody", "thead", "tfoot",
]);

/** Hidden by its own style, as core's htmlWords reads it: a preheader is not drawn. */
const HIDDEN_STYLE = /(?:^|;)\s*display\s*:\s*none\s*(?:!important\s*)?(?:;|$)/i;
/** A token of preheader filler: only U+034F and format characters (ZWNJ, ZWSP, soft hyphen…). */
const FILLER = /^[\u034f\p{Cf}]+$/u;

const known = new Map<string, string>();

/** Its words as drawn; past the bound the phone reads no html at all, so none. */
export function htmlWords(html: string): string {
  if (html.length > MAIL_MAX_HTML_CHARS) return "";
  const hit = known.get(html);
  if (hit !== undefined) return hit;
  const words = wordsOf(parseDocument(html, { lowerCaseTags: true }).children);
  if (known.size >= 64) known.delete(known.keys().next().value!);
  known.set(html, words);
  return words;
}

/** The text a member draws: its stored text, or where that is blank, its html part's words. */
export function drawnText(text: string, html: string | null | undefined): string {
  return text.trim() === "" && html ? htmlWords(html) : text;
}

function wordsOf(top: readonly AnyNode[]): string {
  const lines: string[] = [];
  let line = "";
  let lineQuote = 0;
  let quote = 0;
  let pre = 0;
  /** What the next words wait for: 1 a new line, 2 a blank line before it. */
  let gap = 0;
  const end = (): void => {
    lines.push(`${"> ".repeat(lineQuote)}${line}`);
    line = "";
  };
  const open = (): void => {
    if (gap > 0 && (line !== "" || lines.length > 0)) {
      if (line !== "") end();
      if (gap === 2) lines.push(">".repeat(Math.min(quote, lineQuote)));
    }
    gap = 0;
    if (line === "") lineQuote = quote;
  };
  const write = (t: string): void => {
    if (pre > 0) {
      t.split("\n").forEach((part, i) => {
        if (i > 0) { open(); end(); }
        if (part !== "") { open(); line += part; }
      });
      return;
    }
    let s = t.replace(/\s+/g, " ");
    if (line === "" || gap > 0 || line.endsWith(" ")) s = s.trimStart();
    if (s === "") return;
    open();
    line += s;
  };
  const stack: (AnyNode | { close: string })[] = [...top].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (!(n instanceof Element) && !(n instanceof Text)) {
      if ("close" in n) {
        if (n.close === "blockquote") quote -= 1;
        if (n.close === "pre") pre -= 1;
        if (n.close === "td" || n.close === "th") write(" ");
        gap = Math.max(gap, PARAGRAPH.has(n.close) ? 2 : LINE.has(n.close) ? 1 : 0);
      }
      continue;
    }
    if (n instanceof Text) { write(n.data); continue; }
    const tag = n.tagName;
    if (UNREAD.has(tag) || HIDDEN_STYLE.test(n.attribs.style ?? "")) continue;
    if (tag === "br") {
      if (line === "" && gap === 0) lines.push(">".repeat(quote));
      else { open(); end(); }
      continue;
    }
    gap = Math.max(gap, PARAGRAPH.has(tag) ? 2 : LINE.has(tag) ? 1 : 0);
    if (tag === "blockquote") quote += 1;
    if (tag === "pre") pre += 1;
    stack.push({ close: tag });
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  if (line !== "") end();
  const out: string[] = [];
  for (const l of lines.map((x) => x.split(" ").filter((tok) => !FILLER.test(tok)).join(" ").replace(/[ \t]+$/, ""))) {
    const blank = /^>*$/.test(l);
    if (blank && (out.length === 0 || /^>*$/.test(out[out.length - 1]!))) continue;
    out.push(l);
  }
  while (out.length > 0 && /^>*$/.test(out[out.length - 1]!)) out.pop();
  const text = out.join("\n");
  return text.replace(/[\s\u034f\p{Cf}]/gu, "") === "" ? "" : text;
}
