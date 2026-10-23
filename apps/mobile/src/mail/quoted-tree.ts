/**
 * The phone's parse as the shared history detector reads it (`QuotedTree`, `@ohmail/client-engine`):
 * the tree the way the sanitizer sees it — a refused tag's content is dropped where the sanitizer
 * drops it, and an attribute exists only if the sanitizer keeps it — so the detector reads the same
 * document on the phone as on the web.
 */
import { parseDocument } from "htmlparser2";
import { Element, Text, type AnyNode } from "domhandler";
import {
  MAIL_ALLOWED_ATTR,
  MAIL_MAX_HTML_CHARS,
  QUOTED_HISTORY_LIMITS,
  quotedHistoryVerdictOfHtml,
  type QuotedTree,
  type QuotedVerdict,
} from "@ohmail/client-engine";

/** The text half, for the body renderer (`BodyPages`). */
export { QUOTED_HISTORY_LIMITS, quotedHistoryOfText, type QuotedVerdict } from "@ohmail/client-engine";

/**
 * Tags whose CONTENT goes with them when the tag is refused — DOMPurify's `FORBID_CONTENTS`
 * default, which the web executes implicitly. Every other refused tag keeps its children
 * (a `<picture>` is dropped, the `<img>` inside it survives).
 */
export const DROP_CONTENT = new Set([
  "annotation-xml", "audio", "desc", "foreignobject", "head", "iframe", "math", "mi", "mn",
  "mo", "ms", "mtext", "noembed", "noframes", "noscript", "optgroup", "option", "plaintext",
  "script", "svg", "template", "title", "video", "xmp",
]);

const KEPT_ATTR = new Set(MAIL_ALLOWED_ATTR);

export const phoneQuotedTree: QuotedTree<AnyNode> = {
  kind: (n) => (n instanceof Element ? (DROP_CONTENT.has(n.tagName) ? null : "element") : n instanceof Text ? "text" : null),
  tag: (n) => (n instanceof Element ? n.tagName : ""),
  attr: (n, name) => (n instanceof Element && KEPT_ATTR.has(name) ? n.attribs[name] ?? null : null),
  children: (n) => ("children" in n ? (n.children as AnyNode[]) : []),
  text: (n) => (n instanceof Text ? n.data : ""),
};

/** A `<style>` element's sheet, as the detector reads a head's sheets for a declared canvas. */
export const sheetText = (s: Element): string => s.children.map((c) => (c instanceof Text ? c.data : "")).join("");

const verdicts = new Map<string, QuotedVerdict>();

/**
 * The html part's own reading of its quoted history, for its text part (`quotedHistoryOfText`'s
 * `html`): the same parse and tree the frame's fold reads (`sanitize.ts`), so a member's text folds
 * only where its opened frame would. Kept for the last few parts read.
 */
export function htmlHistoryVerdict(html: string): QuotedVerdict {
  const known = verdicts.get(html);
  if (known !== undefined) return known;
  let v: QuotedVerdict = "unread";
  if (html.length <= MAIL_MAX_HTML_CHARS && html.length <= QUOTED_HISTORY_LIMITS.chars) {
    const doc = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true });
    const htmlEl = doc.children.find((n): n is Element => n instanceof Element && n.tagName === "html");
    const body = (htmlEl ?? doc).children.find((n): n is Element => n instanceof Element && n.tagName === "body");
    const head = (htmlEl ?? doc).children.find((n): n is Element => n instanceof Element && n.tagName === "head");
    const sheets = (head?.children ?? []).filter((n): n is Element => n instanceof Element && n.tagName === "style").map(sheetText);
    v = quotedHistoryVerdictOfHtml<AnyNode>(body ?? doc, phoneQuotedTree, { sheets });
  }
  if (verdicts.size >= 64) verdicts.delete(verdicts.keys().next().value!);
  verdicts.set(html, v);
  return v;
}
