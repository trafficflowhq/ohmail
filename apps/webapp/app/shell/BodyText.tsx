"use client";

/**
 * The message body as prose — paragraphs, quoted reply chains, and real links. The one expression
 * `<p className="msg-body">{body.text}</p>` rendered mail as a wall of raw text. {@link classifyLine}
 * reads the quote depth per line, {@link toBlocks} groups by depth, {@link toTree} folds contiguous
 * quoted material into one `.msg-quote` per level (per-block wrappers drew a picket fence — one bar
 * per paragraph); the sender's own line breaks inside a block survive under `white-space: pre-line`.
 * The nesting is real DOM nesting, which is why {@link MAX_QUOTE_DEPTH} exists: a pathological
 * `">".repeat(50000)` line must clamp to a handful of wrappers. Render-time, not ingest: the stored
 * text is the search corpus and the dedup key's input — rewriting it would force a backfill.
 */

/**
 * React elements only — no `dangerouslySetInnerHTML`, no HTML string anywhere in this file, not as
 * an intermediate value: `security-headers.ts` states the invariant this file is half of — no
 * untrusted markup string reaches a DOM sink; sender bytes enter the document only as React text
 * nodes and constructed attributes (an `href` built from a parsed `URL`). The rich path renders
 * structure without markup: `MessageBody`'s walker re-reads the SANITIZED document through a second,
 * narrower allow-list and emits the {@link BodyNode} superset — no sender `style`, `class`, `width`
 * or `id` survives. A plain `<a>` and never `next/link`: `next/link` prefetches, and a body that
 * fetches anything on render is the tracker-pixel behaviour the product exists to stop.
 */

/**
 * The quoted history is folded, because the reader has read it: the shared detector
 * (`quotedHistoryOfText`, or `MessageBody`'s html reading handed down as {@link RichFold}) says
 * where it starts and ends, and it sits behind one quiet toggle. Never on a body that is nothing
 * but history, never over inline answers; collapsed means NOT IN THE DOM, not hidden by style — a
 * folded tracking URL must not become an anchor until asked for.
 */
import { Fragment, memo, useId, useMemo, useState, type ReactNode } from "react";
import { BODY_PAGE_CHARS, pageEnd, pageEnds } from "@ohmail/ui";
import { QUOTED_HISTORY_LIMITS, quotedHistoryOfText, type QuotedAt, type QuotedVerdict } from "@ohmail/client-engine";
import { liveCopy } from "./locale";
import { RenderedLinks } from "./rendered-links";

/**
 * Leading email quote markers — up to a little indent, then one or more `>` each optionally
 * followed by a space. The number of `>` is the quote DEPTH; the rest of the line is its content.
 * `> `, `>>`, `> > ` all parse to the depth the reader means.
 */
const QUOTE_PREFIX = /^[ \t]{0,3}((?:>[ \t]?)+)/;

/**
 * Attribution lines — the sentence saying who wrote the block below, in the forms real mail uses:
 * "On <date>, Alice <a@x> wrote:", "Am <date> schrieb Alice:", "Le <date>, Alice a écrit :", the
 * forwarded-header block (Von/From, Gesendet/Sent, An/To, Betreff/Subject) and the
 * "-----Original Message-----" / "Ursprüngliche Nachricht" separator. Rendered as a quiet
 * separator rather than prose, so each quoted block's author stays legible. Anchored and bounded: a
 * match needs the whole short line to be the attribution shape, so an ordinary sentence that merely
 * contains "wrote" or a colon is left as prose.
 */
const ATTRIBUTION: RegExp[] = [
  /^on\b.*\bwrote:$/i,
  /^am\b.*\bschrieb.*:$/i,
  /^le\b.*\ba\s+écrit\s*:$/i,
  /^el\b.*\bescribió\s*:$/i,
  /^[-_]{2,}.*(original message|original-nachricht|urspr[üu]ngliche nachricht|weitergeleitete nachricht|forwarded message).*$/i,
  /^(von|from|gesendet|sent|an|to|betreff|subject|datum|date|cc|bcc|reply-to|antwort an|de|para|asunto|enviado|répondre à)\s*:\s?\S/i,
];

export function isAttribution(content: string): boolean {
  const s = content.trim();
  if (s.length === 0 || s.length > 400) return false;
  return ATTRIBUTION.some((re) => re.test(s));
}

interface ClassifiedLine {
  depth: number;
  /** The line with its quote markers stripped — what the reader is meant to read. */
  content: string;
  blank: boolean;
  attribution: boolean;
}

/** Strip the quote markers off one line and read its depth + role. */
function classifyLine(raw: string): ClassifiedLine {
  const m = QUOTE_PREFIX.exec(raw);
  const depth = m ? (m[1]!.match(/>/g) ?? []).length : 0;
  const content = m ? raw.slice(m[0].length) : raw;
  const blank = content.trim().length === 0;
  return { depth, content, blank, attribution: !blank && isAttribution(content) };
}

/**
 * A rendered block — a maximal run of consecutive non-blank lines that share a quote depth and a
 * role. A blank line, a depth change or a role change ends the block. Lines are joined with `\n`
 * and rendered under `white-space: pre-line`, so the sender's own line breaks survive INSIDE a
 * block while quote depth and attribution give the block its shape.
 */
interface Block {
  depth: number;
  attribution: boolean;
  text: string;
}

function toBlocks(lines: ClassifiedLine[]): Block[] {
  const blocks: Block[] = [];
  let run: ClassifiedLine[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const head = run[0]!;
    blocks.push({
      depth: head.depth,
      attribution: head.attribution,
      text: run.map((l) => l.content).join("\n"),
    });
    run = [];
  };
  for (const ln of lines) {
    if (ln.blank) { flush(); continue; }
    const head = run[0];
    if (head && (head.depth !== ln.depth || head.attribution !== ln.attribution)) flush();
    run.push(ln);
  }
  flush();
  return blocks;
}

/**
 * How deep the RENDERED nesting may go. Content deeper than this renders inside the deepest
 * container — the words always survive; only the count of wrappers is clamped. Real mail
 * rarely quotes past three or four levels, so the clamp is invisible on anything a person
 * wrote and load-bearing on `">".repeat(50000)`, which would otherwise become fifty thousand
 * nested elements built synchronously on the thread that paints the app.
 */
export const MAX_QUOTE_DEPTH = 6;

/**
 * A block whose lines are columns is preformatted, not prose. Plain-text receipts line values up
 * with space runs and the alignment IS the content — "Pro plan      15.00" and "Pro plan 15.00"
 * are different documents; `white-space: pre-line` collapses intra-line runs, so a column-shaped
 * block becomes the same {@link PreNode} a code block arrives as (`test/message-body-code.test.ts`
 * holds that construction; `test/body-text-columns.test.ts` this classification). A column gap is
 * three-plus spaces or a tab, interior — two spaces after a period is a typing habit, and `\S` on
 * both sides keeps invisible trailing whitespace from voting. The BLOCK decides, not the line: two
 * gap-carrying lines and half the block, leaning conservative; no cross-line alignment detection.
 */
const COLUMN_GAP = /\S(?: {3,}|\t)(?=\S)/;

function isColumnar(block: Block): boolean {
  if (block.attribution) return false;
  const lines = block.text.split("\n");
  if (lines.length < 2) return false;
  let gaps = 0;
  for (const line of lines) if (COLUMN_GAP.test(line)) gaps += 1;
  return gaps >= 2 && gaps * 2 >= lines.length;
}

/** One paragraph (or attribution line) of the rendered body. */
export interface ParagraphNode { kind: "para"; block: Block }
/** One quote container: everything quoted at `depth` within one contiguous quoted run. */
export interface QuoteNode { kind: "quote"; depth: number; children: BodyNode[] }

/**
 * ── THE RICH NODES — what `MessageBody`'s walker emits for a prose-classified html part ────
 *
 * Every kind below is a STRUCTURE, never a string of markup: the walker reads the sanitized
 * document and this file constructs each element itself, so a sender's byte can only ever be
 * the `text` of a {@link TextRun} — a React text node — and every attribute on the rendered
 * elements ({@link LinkRun.href}, the bounded spans on {@link TableCellNode}) is a value this
 * code computed, not one it copied. That property is the whole reason the model exists; a
 * field that carried sender markup or a sender attribute would dissolve it.
 */
export interface TextRun { kind: "text"; text: string }
export interface LineBreak { kind: "break" }
/**
 * Inline emphasis — `strong`/`b`, `em`/`i`, `u` — and `code`, folded to one kind per meaning.
 *
 * `code` sits with the emphasis kinds because it has their shape and their job: it marks a run
 * of the sentence as literal characters — a path, a header name, a flag — rather than words.
 * The BLOCK form is {@link PreNode}, which is a different thing and is not built out of these.
 */
export interface StyledRun { kind: "strong" | "em" | "underline" | "code"; children: InlineNode[] }
/**
 * A link that passed {@link anchorFor} — the same single gate the plain-text path uses; a
 * rejected href never becomes a node at all, its label stays in the surrounding run as text.
 * An html anchor breaks the plain path's label≡href property (the sender writes the label),
 * so the anti-phishing disclosure travels with the node: `elsewhere` is
 * `textDisagreesWithHref`'s answer, and the renderer prints `host` beside the label when it
 * is true — the framed path's marker, natively.
 */
export interface LinkRun {
  kind: "link";
  /** Constructed from a parsed `URL` by {@link anchorFor} — never the sender's raw bytes. */
  href: string;
  /** The real destination's host, for the title and the disagreement disclosure. */
  host: string;
  /** The visible label names a DIFFERENT host — say the real one out loud. */
  elsewhere: boolean;
  children: InlineNode[];
}
/**
 * A picture that is part of the message itself — a `cid:` part the sanitize pass resolved, or the
 * sender's own embedded `data:` image. `src` is a value the walker COPIED off the sanitized,
 * post-passed document, where the only srcs that pass {@link inlineImageAdmitted} are ones the
 * resolve step wrote (gated) or the sender's own small-raster bytes; the renderer below re-tests the
 * SAME gate before constructing the element, so a node built by anything else still cannot put a
 * `javascript:` or `data:text/html` into the app document. `alt` renders only as a React text node.
 */
export interface ImageRun { kind: "image"; src: string; alt: string }
export type InlineNode = TextRun | LineBreak | StyledRun | LinkRun | ImageRun;

/**
 * The `data:` shape an embedded image's `src` may take — the sender's own pictures, and the ones
 * the phone mints: a base64 `data:` URI of one of the four raster types. ONE VALUE, ENFORCED AT
 * BOTH SINKS through {@link inlineImageAdmitted} — `MessageBody`'s post-pass before the attribute
 * write into the frame document, {@link renderInline} again before constructing the app-document
 * element: widen it to `/./` and both open at once, which is what the mutation in
 * `test/message-body-cid-images.test.tsx` proves it against. It lives HERE because this file is
 * the prose sink; `MessageBody` imports it rather than keeping a second spelling that could drift.
 */
export const INLINE_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const INLINE_OBJECT_URL = /^blob:/;

/** No embedded picture of the message's own: what a body with no map, or the text part, admits. */
export const NO_OWN_IMAGES: ReadonlySet<string> = new Set();

/**
 * AN EMBEDDED PICTURE'S SRC, AT EVERY SINK: an {@link INLINE_IMAGE_SRC} `data:` URI, or a `blob:`
 * URL that is one of THIS message's own map values (`own`: what its engine minted on a browser
 * door). Membership, never the scheme alone — a `blob:` that is not this message's is refused like
 * a missing picture, so another message's picture never draws here.
 */
export function inlineImageAdmitted(src: string, own: ReadonlySet<string>): boolean {
  return INLINE_IMAGE_SRC.test(src) || (INLINE_OBJECT_URL.test(src) && own.has(src));
}

/**
 * A run of rich inline content, and WHAT CONTAINED IT decides its spacing.
 *
 * `"paragraph"` is a real `<p>` (and a list item, spaced by the list's own rule): a block the
 * sender meant as a paragraph. `"line"` is everything else, and `<div>` is the case that matters —
 * mail clients compose one `<div>` per LINE, with `<div><br></div>` for a double return. Spacing
 * those as paragraphs put a blank line between every line while the writer's own blank lines
 * vanished. A line has no spacing of its own; the blank lines are the ones the sender wrote.
 * `attribution` re-uses the plain path's role and style and outranks both.
 */
export interface RichParagraphNode {
  kind: "rich";
  attribution: boolean;
  spacing: "paragraph" | "line";
  children: InlineNode[];
}
/** `h1`–`h6`, rendered at the app's own scale — a mail heading is not a page heading. */
export interface HeadingNode { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
export interface RuleNode { kind: "rule" }
/**
 * A preformatted block — `pre`, how a code block, header dump or stack trace arrives (usually
 * `pre > code`). TEXT, not children, and that carries the kind's whole meaning: a `pre`'s content is
 * its literal characters — the indentation is the structure — so the walker flattens the subtree to
 * the string the reader is meant to see, rendered as one React text node. Inline emphasis inside a
 * code block is dropped: it costs a reader of source nothing, and keeping it would mean deciding how
 * a bold run interacts with preserved whitespace.
 */
export interface PreNode { kind: "pre"; text: string }
/** `ul`/`ol`; each item is its own block list, so nested lists nest. */
export interface ListNode { kind: "list"; ordered: boolean; items: BodyNode[][] }
/** Spans are PARSED, BOUNDED INTS — see `MessageBody`'s `boundedSpan` — never sender strings. */
export interface TableCellNode { header: boolean; colSpan: number; rowSpan: number; children: BodyNode[] }
export interface TableRowNode { cells: TableCellNode[] }
export interface TableNode { kind: "table"; rows: TableRowNode[] }

export type BodyNode =
  | ParagraphNode
  | QuoteNode
  | RichParagraphNode
  | HeadingNode
  | RuleNode
  | ListNode
  | PreNode
  | TableNode;
/**
 * Fold the flat block list into the tree the reader means. A stack of open containers tracks the
 * current quote depth; each block continues the container at its depth (the merge that ends
 * one-bar-per-paragraph fragmentation), opens deeper containers, or closes them (depth dropped, or
 * depth-0 prose ended the quoted run). Blank lines never reach this function: they end BLOCKS in
 * `toBlocks`, deliberately not containers — a blank quoted line separates a quoted message's
 * paragraphs, not the message.
 */
function toTree(blocks: Block[]): BodyNode[] {
  const top: BodyNode[] = [];
  const stack: QuoteNode[] = [];
  for (const block of blocks) {
    const depth = Math.min(block.depth, MAX_QUOTE_DEPTH);
    while (stack.length > depth) stack.pop();
    while (stack.length < depth) {
      const quote: QuoteNode = { kind: "quote", depth: stack.length + 1, children: [] };
      (stack.length === 0 ? top : stack[stack.length - 1]!.children).push(quote);
      stack.push(quote);
    }
    // Column-shaped blocks take the preformatted kind at ANY depth — a quoted receipt has
    // the same alignment to lose as an unquoted one. See {@link isColumnar}.
    (depth === 0 ? top : stack[stack.length - 1]!.children).push(
      isColumnar(block) ? { kind: "pre", text: block.text } : { kind: "para", block },
    );
  }
  return top;
}

/**
 * The toggle's two labels and a link's hover title. `liveCopy`, not `useTranslations`, for the same
 * reason as `MessageBody.COPY`: this component renders bare — no intl provider — in a dozen unit
 * tests, and the hook throws without one. `test/locale-shim-parity.test.ts` holds this table and the
 * `bodyText` catalogue namespace to the same key set and English sentences. `linkTitle` is the hover
 * sentence for a link whose text is not its destination — the one place the body says where a press
 * will take you; it was a template literal, so it spoke English wherever the reader was.
 */
const EN = {
  show: "Show history",
  hide: "Hide history",
  linkTitle: (host: string) => `Goes to ${host}`,
  more: (percent: string) => `Show more (${percent}% shown)`,
};
export const COPY: typeof EN = liveCopy("bodyText", EN, { linkTitle: ["host"], more: ["percent"] });

/**
 * A CANDIDATE, NOT A DECISION. This matches anything shaped like `scheme:rest`, INCLUDING `javascript:` and `data:`.
 * That is on purpose and it is the whole design: if the pattern itself only ever matched `https?://`, the scheme rule
 * would be an invisible property of a regex nobody can watch fail, and `test/body-text.test.ts` case 1 would pass
 * vacuously. The rejection happens in one named place ({@link anchorFor}), where it can be deleted and watched go
 * red. The body charset excludes whitespace and the quote/angle characters. Brackets and parens ARE allowed inside —
 * `http://[::1]:8080/x` is a real URL — and are stripped only from the END, which is what unwraps the `text [url]`
 * pairs `htmlToText` emits.
 */
const URL_CANDIDATE = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>"'`]+/g;

/** Sentence and bracket punctuation that ended up glued to a URL, never part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>"'`]+$/;

/**
 * THE ALLOW-LIST, AND IT IS THE ONLY GATE.
 *
 * There is deliberately no second check (a non-empty host, say) that would also happen to
 * reject `javascript:`. Two overlapping guards read as belt-and-braces and behave as neither:
 * deleting one leaves the test green, so neither one is ever proven to do anything. For
 * `http:`/`https:` the WHATWG parser already guarantees a host — `new URL("https://")` throws
 * — so this line is sufficient on its own, and it is therefore the line the mutation removes.
 */
const SAFE_PROTOCOLS = ["https:", "http:"];

/** How much of the path/query survives in the visible label before the ellipsis. */
const MAX_TAIL = 32;

/**
 * The visible text of a link, DERIVED FROM THE HREF AND NOTHING ELSE — host first, always.
 *
 * `htmlToText` has already flattened every anchor to `text [url]`, and this file linkifies only
 * the URL substring, so a label can never come from sender-controlled anchor text: label and
 * href are the same string by construction. Host-first is what survives the remaining trick,
 * userinfo — `https://bank.example@evil.example/pay` labels as `evil.example/pay`, because
 * `url.host` is the host and `bank.example` is a username.
 */
function labelOf(url: URL): string {
  const tail = `${url.pathname}${url.search}${url.hash}`;
  const rest = tail === "/" ? "" : tail;
  return url.host + (rest.length > MAX_TAIL ? `${rest.slice(0, MAX_TAIL)}…` : rest);
}

/**
 * An anchor for this candidate, or `null` for "leave it as text".
 *
 * THE SAFE BRANCH IS THE DEFAULT BRANCH: every path out of here that is not an explicit
 * `https:`/`http:` returns `null`, including the parse failure. A `catch` that renders the
 * substring as a link anyway is the untested branch that ships `javascript:`.
 */
export function anchorFor(candidate: string): { href: string; label: string } | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.includes(url.protocol)) return null;
  return { href: url.href, label: labelOf(url) };
}

/**
 * One paragraph's worth of text, with its safe URLs turned into anchors. Every href drawn goes into
 * `links`, which the body reports as on screen (`rendered-links.ts`).
 */
function linkify(block: string, keyBase: string, links: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let n = 0;

  for (const match of block.matchAll(URL_CANDIDATE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const candidate = raw.replace(TRAILING_PUNCTUATION, "");
    if (!candidate) continue;
    const anchor = anchorFor(candidate);
    // Rejected: `cursor` is not advanced, so the substring stays inside the surrounding text
    // run and reaches the DOM as a text node — visible, inert, exactly as the sender wrote it.
    if (!anchor) continue;

    if (start > cursor) out.push(block.slice(cursor, start));
    links.push(anchor.href);
    out.push(
      <a
        key={`l${keyBase}-${n++}`}
        className="msg-link"
        href={anchor.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {anchor.label}
      </a>,
    );
    cursor = start + candidate.length;
  }

  if (cursor < block.length) out.push(block.slice(cursor));
  return out;
}

/**
 * The shared body renderer — the focused message in `MessagePane` AND the conversation siblings in `Conversation`.
 * ONE COMPONENT, BOTH SURFACES, on purpose. "Built, tested, unreachable" — the fix landing on the pane while the
 * thread below it keeps dumping raw text — is a shape this repo has shipped five times, and a second copy of this
 * logic is how it happens a sixth. Returns a fragment of `<p>` rather than its own wrapper: the caller owns the
 * container and its class (`.msg-body`, `.hm-body`), which are what the existing pane and screener assertions select
 * on, and what carries the surface's own type scale.
 */
/**
 * Rich inline content, as React elements. A `text` run renders as a bare string — a React
 * TEXT NODE, which is the sink invariant made concrete — and every element here is one this
 * function created with attributes it computed. The anchor mirrors the plain path's
 * (`target`/`rel`/class) with one addition: when the sender's label names a different host
 * than the destination ({@link LinkRun.elsewhere}), the real host is printed beside it — the
 * framed path's anti-phishing marker, carried natively.
 */
function renderInline(nodes: InlineNode[], keyBase: string, own: ReadonlySet<string>, links: string[]): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyBase}i${i}`;
    switch (node.kind) {
      case "text": return node.text;
      case "break": return <br key={key} />;
      case "strong": return <strong key={key}>{renderInline(node.children, key, own, links)}</strong>;
      case "em": return <em key={key}>{renderInline(node.children, key, own, links)}</em>;
      case "underline": return <u key={key}>{renderInline(node.children, key, own, links)}</u>;
      // Literal characters inside a sentence. Faint tint, no border, no highlighting — this is
      // received mail, and the app is not pretending to be an editor for somebody else's source.
      case "code": return <code className="msg-code" key={key}>{renderInline(node.children, key, own, links)}</code>;
      case "link":
        links.push(node.href);
        return (
          <a
            key={key}
            className="msg-link"
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            title={COPY.linkTitle(node.host)}
          >
            {renderInline(node.children, key, own, links)}
            {node.elsewhere ? <span className="msg-link-host"> ({node.host})</span> : null}
          </a>
        );
      case "image":
        // THE GATE AT THE SINK — see {@link inlineImageAdmitted}. A node whose src fails it draws
        // nothing (the strip still lists the part); the alt text is the sender's and enters the
        // document only as a React attribute value. `.msg-img` caps the width at the column
        // (message-body.css) — the stored size otherwise, which is what a signature logo wants.
        return inlineImageAdmitted(node.src, own)
          ? <img key={key} className="msg-img" src={node.src} alt={node.alt} loading="lazy" decoding="async" />
          : null;
    }
  });
}

/** `links` collects every href the nodes draw, for the body to report as on screen. */
function renderNodes(nodes: BodyNode[], keyPrefix: string, own: ReadonlySet<string>, links: string[]): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    switch (node.kind) {
      case "quote":
        // One container per quoted run per level, so the left rule runs unbroken down the whole
        // quoted message instead of restarting at every paragraph. `data-quote-depth` still
        // carries the level for styling hooks and tests; the recursion is bounded by
        // MAX_QUOTE_DEPTH, enforced where the tree is built.
        return (
          <div className="msg-quote" data-quote-depth={node.depth} key={key}>
            {renderNodes(node.children, `${key}-`, own, links)}
          </div>
        );
      case "para":
        /* `msg-plain` is the ONE rule that keeps a plain-text letter's own line breaks, and it sits
           on the element holding the `\n`, never on a container: a sibling panel's `.pm-body`, the
           Screener's `.hm-body`, the Trash read and `.mb`'s `white-space: normal` all render this
           same paragraph, and a container copy is how a sibling panel ran a signature together.
           Plain path only — a `rich` run's text nodes are markup whitespace and must collapse. */
        return (
          <p className={node.block.attribution ? "msg-attribution msg-plain" : "msg-p msg-plain"} key={key}>
            {linkify(node.block.text, key, links)}
          </p>
        );
      case "rich":
        /* A `p` element for both spellings — this is a run of prose either way, and the CLASS
           carries the only difference there is: `.msg-p` has paragraph spacing, `.msg-line` has
           none. An empty one is a `<p class="msg-line"><br></p>`, which is one line box and so
           exactly one blank line: the shape `<div><br></div>` means everywhere it is written. */
        return (
          <p
            className={
              node.attribution ? "msg-attribution" : node.spacing === "line" ? "msg-line" : "msg-p"
            }
            key={key}
          >
            {renderInline(node.children, key, own, links)}
          </p>
        );
      case "heading": {
        // The app's scale, not the sender's: `.msg-h` caps the size (message-body.css), so a
        // newsletter-sized h1 reads as a letter's heading rather than a shout.
        const H = `h${node.level}` as "h1";
        return <H className="msg-h" key={key}>{renderInline(node.children, key, own, links)}</H>;
      }
      case "rule":
        return <hr className="msg-hr" key={key} />;
      case "pre":
        // TWO ELEMENTS, AND THE OUTER ONE IS THE LOAD-BEARING HALF. A code block preserves its
        // whitespace, so it is exactly as wide as its longest line — and a line in received mail
        // can be four thousand characters of base64. `.msg-pre-wrap` is the element that scrolls
        // (message-body.css); the `pre` inside it is free to be as wide as the sender made it,
        // and the pane never grows a horizontal bar. Same construction, same reason, as
        // `.msg-table-wrap` below. The text is ONE React text node — the sink invariant, again.
        return (
          <div className="msg-pre-wrap" key={key}>
            <pre className="msg-pre">{node.text}</pre>
          </div>
        );
      case "list": {
        const items = node.items.map((item, j) => (
          <li key={`${key}-${j}`}>{renderNodes(item, `${key}-${j}-`, own, links)}</li>
        ));
        return node.ordered
          ? <ol className="msg-list" key={key}>{items}</ol>
          : <ul className="msg-list" key={key}>{items}</ul>;
      }
      case "table":
        // The wrap scrolls a genuinely wide table INSIDE the letter instead of letting it push
        // the pane — the same rule the frame's column obeys. Spans are the bounded ints the
        // walker parsed; a span of 1 is simply omitted.
        return (
          <div className="msg-table-wrap" key={key}>
            <table className="msg-table">
              <tbody>
                {node.rows.map((row, r) => (
                  <tr key={`${key}-${r}`}>
                    {row.cells.map((cell, c) => {
                      const Cell = cell.header ? "th" : "td";
                      return (
                        <Cell
                          key={`${key}-${r}-${c}`}
                          colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                          rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        >
                          {renderNodes(cell.children, `${key}-${r}-${c}-`, own, links)}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** The plain-text parse of one stretch of a body: lines, blocks, the quote tree. */
function parsePlain(text: string): BodyNode[] {
  return toTree(toBlocks(text.replace(/\r\n?/g, "\n").split("\n").map(classifyLine)));
}

/**
 * One page of a long body. Memoised on its own text, so a further page parses and lays out alone;
 * it reports its own links, as a surface of its own, once it is drawn.
 */
const BodyPage = memo(function BodyPage({ text, index }: { text: string; index: number }) {
  const links: string[] = [];
  const drawn = renderNodes(parsePlain(text), `p${index}-`, NO_OWN_IMAGES, links);
  return <div className="msg-page">{drawn}<RenderedLinks hrefs={links} /></div>;
});

/**
 * A plain stretch past one page ({@link BODY_PAGE_CHARS}, or its lines), drawn a page at a time with
 * a press for the next. The history fold runs BEFORE paging: what is paged is one part of it. The
 * shown count keys on the text, like the fold, so it never carries over to the next message.
 * `ownEnd`: this stretch ends the message's own words (exactly one end marker per body).
 */
function PagedBody({ text, ownEnd = true }: { text: string; ownEnd?: boolean }) {
  const [shown, setShown] = useState<{ text: string; pages: number }>({ text, pages: 1 });
  const pages = shown.text === text ? shown.pages : 1;
  const ends = pageEnds(text, pages);
  const end = ends[ends.length - 1] ?? 0;
  return (
    <>
      {ends.map((e, i) => <BodyPage key={i} index={i} text={text.slice(i === 0 ? 0 : ends[i - 1]!, e)} />)}
      {ownEnd ? <OwnEnd /> : null}
      {end < text.length ? (
        <button type="button" className="msg-page-more" onClick={() => setShown({ text, pages: pages + 1 })}>
          {COPY.more(String(Math.floor((end / text.length) * 100)))}
        </button>
      ) : null}
    </>
  );
}

/**
 * WHERE THE MESSAGE'S OWN WORDS END — a zero-size mark the reader's read rule takes as the body's
 * end (`reader-seen.ts`: a body shorter than its first three lines is its own top): above the
 * toggle where history is folded, after the last shown page of a long body, else at the end.
 */
export function OwnEnd() {
  return <span data-own-end="" aria-hidden="true" className="own-end" />;
}

/**
 * THE ONE CONTROL OVER A FOLDED HISTORY, on every surface that renders one (this file and the
 * framed body in `MessageBody`). A real button: Enter and Space come with the element, and it keeps
 * its place in the tree when the history mounts after it, so focus stays on it. `aria-controls`
 * names the region that exists only while open.
 */
export function HistoryToggle({ open, controls, onToggle }: { open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className="msg-history-toggle" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      {open ? COPY.hide : COPY.show}
    </button>
  );
}

/** `MessageBody`'s reading of a prose html part's history: the walk of each side of the cut. */
export interface RichFold {
  at: QuotedAt;
  before: BodyNode[];
  history: BodyNode[];
  after: BodyNode[];
}

/** One stretch of the text part: its nodes, or its pages when it is longer than one. */
function plainPart(text: string, key: string, links: string[], ownEnd: boolean): ReactNode {
  if (pageEnd(text, 0) < text.length) return <PagedBody key={key} text={text} ownEnd={ownEnd} />;
  return (
    <Fragment key={key}>
      {renderNodes(parsePlain(text), key, NO_OWN_IMAGES, links)}
      {ownEnd ? <OwnEnd /> : null}
    </Fragment>
  );
}

/**
 * `rich` is the walker's output for a prose-classified html part — `MessageBody` is the only caller
 * that passes it, and `richHistory` with it when its html reading found a history. `rich` alone
 * renders whole: the html said there is no history. Neither: the text part renders, folded by
 * {@link quotedHistoryOfText}. `ownImages`: the message's own embedded-picture URLs, the only
 * `blob:` srcs {@link inlineImageAdmitted} draws. `foldKey` names the message for the open state
 * (the text otherwise). `htmlFold`: the message's html part's own reading of its history — the
 * text part folds only where it folds; absent when there is no html part.
 */
export function BodyText({ text, rich, richHistory, ownImages = NO_OWN_IMAGES, foldKey, htmlFold }: {
  text: string;
  rich?: BodyNode[] | null;
  richHistory?: RichFold | null;
  ownImages?: ReadonlySet<string>;
  foldKey?: string;
  htmlFold?: QuotedVerdict;
}) {
  /**
   * The fold's state keys on the MESSAGE, not on the component instance: `open` is only true while
   * the message it was opened for is the one on screen. The pane reuses one mounted `BodyText` as
   * the reader moves between messages, and a plain `useState(false)` would carry one mail's
   * expansion onto the next — history the reader never asked for, on a message they have not read.
   */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const region = useId();
  const body = text ?? "";
  const key = foldKey ?? body;
  const useRich = rich != null && rich.length > 0;
  // CRLF is what an IMAP body actually carries; the detector and the parts read the same lines.
  const lines = useMemo(() => body.replace(/\r\n?/g, "\n").split("\n"), [body]);
  const range = useMemo(
    () => (useRich || body.length > QUOTED_HISTORY_LIMITS.chars ? null : quotedHistoryOfText(lines, { html: htmlFold })),
    [useRich, body, lines, htmlFold],
  );
  const open = openedFor === key;
  // Every href drawn below, reported as on screen (`rendered-links.ts`): a folded history draws
  // nothing, so it reports nothing until it is open.
  const links: string[] = [];
  const toggle = (
    <HistoryToggle key="t" open={open} controls={region} onToggle={() => setOpenedFor(open ? null : key)} />
  );
  const shown = (children: ReactNode): ReactNode =>
    open ? <div key="h" id={region} className="msg-history">{children}</div> : null;

  if (useRich && richHistory) {
    const before = renderNodes(richHistory.before, "b", ownImages, links);
    const history = open ? renderNodes(richHistory.history, "h", ownImages, links) : null;
    const after = renderNodes(richHistory.after, "a", ownImages, links);
    return richHistory.at === "leading" ? (
      <>{before}{toggle}{shown(history)}{after}<OwnEnd /><RenderedLinks hrefs={links} /></>
    ) : (
      <>{before}<OwnEnd />{toggle}{shown(history)}{after}<RenderedLinks hrefs={links} /></>
    );
  }
  if (useRich) {
    return <>{renderNodes(rich, "b", ownImages, links)}<OwnEnd /><RenderedLinks hrefs={links} /></>;
  }
  if (range === null) {
    if (pageEnd(body, 0) < body.length) return <PagedBody text={body} />;
    return <>{renderNodes(parsePlain(body), "b", NO_OWN_IMAGES, links)}<OwnEnd /><RenderedLinks hrefs={links} /></>;
  }
  const part = (from: number, to: number): string => lines.slice(from, to).join("\n");
  const leading = range.at === "leading";
  const before = part(0, range.start);
  const after = part(range.end, lines.length);
  const history = open ? plainPart(part(range.start, range.end), "h", links, false) : null;
  return leading ? (
    <>
      {before.trim() ? plainPart(before, "b", links, false) : null}
      {toggle}
      {shown(history)}
      {plainPart(after, "a", links, true)}
      <RenderedLinks hrefs={links} />
    </>
  ) : (
    <>
      {plainPart(before, "b", links, true)}
      {toggle}
      {shown(history)}
      {after.trim() ? plainPart(after, "a", links, false) : null}
      <RenderedLinks hrefs={links} />
    </>
  );
}
