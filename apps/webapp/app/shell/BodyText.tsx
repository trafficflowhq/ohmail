"use client";

/**
 * THE MESSAGE BODY AS PROSE — paragraphs, quoted reply chains, and real links.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Reading a message looked like reading a plain-text code editor: URLs rendered as a wall of
 * raw query string, the text overflowed the panel, and there was no paragraph rhythm. All three
 * symptoms came out of ONE expression, `<p className="msg-body">{body.text}</p>`: mailparser's
 * `htmlToText` output, dropped into a single `<p>` with no break rule and no block structure.
 *
 * ── AND A REPLY CHAIN WAS AN UNDIFFERENTIATED WALL ──────────────────────────────────────
 *
 * The paragraph fix was not enough for a thread. A native-rendered plain-text reply chain — the
 * `>`-quoted history under a fresh reply, the "On <date>, X wrote:" and "Von: … Betreff: …"
 * lines that say who wrote what — arrived with its `>` markers rendered as literal characters and
 * every level of quoting flattened into the same tone, so it was impossible to tell the writer's
 * new words from the four replies underneath them. {@link classifyLine} reads the quote depth off
 * each line, {@link toBlocks} groups the lines a depth at a time, {@link toTree} folds the blocks
 * into one container per quoted run with deeper runs nested inside, and each level is drawn with
 * a single quiet left rule and a more muted tone, with the attribution lines set apart as
 * separators. The sender's own line breaks INSIDE a block still survive, under
 * `white-space: pre-line` — the same paragraph-rhythm rule as before, unchanged.
 *
 * ── AND THEN THE BARS FRAGMENTED THE THREAD THEY WERE DRAWN TO JOIN ─────────────────────
 *
 * The first cut of the quote rendering wrapped EVERY BLOCK in its own `.msg-quote`. A quoted
 * message is many blocks — a `>`-blank line between two quoted paragraphs ends one block and
 * starts the next — so a coherent quoted mail rendered as a picket fence: one short bar per
 * paragraph with a gap between each, and a depth change opened yet another sibling bar at
 * another indent. An Exchange reply chain three hops deep read as dozens of disconnected
 * bar-marked chunks — the reported defect, verbatim.
 *
 * So blocks are folded into a TREE before they are rendered: contiguous quoted material shares
 * one `.msg-quote` per level, a deeper run nests inside the shallower one, and only depth-0
 * prose — an inline reply — closes the containers. One rule per level, running unbroken down
 * everything quoted at that level, is how every native mail client draws a chain. The nesting
 * is real DOM nesting now, which is why {@link MAX_QUOTE_DEPTH} exists: a pathological
 * `">".repeat(50000)` line must clamp to a handful of wrappers, not build fifty thousand.
 *
 * ── WHY THIS IS A RENDER-TIME COMPONENT AND NOT AN INGEST STEP ────────────────────────────
 *
 * The stored `text` of a message body is the sensitivity-redacted source for the server's
 * full-text search column, and the dedup key is a hash of that same text. Rewriting the text on
 * the way in would change dedup keys and the search corpus and force a backfill, to buy
 * presentation. The stored shape does not move;
 * the DTO already ships `text`, and turning text into a reading surface is the client's job.
 *
 * ── REACT ELEMENTS ONLY ───────────────────────────────────────────────────────────────────
 *
 * No `dangerouslySetInnerHTML`, no HTML string anywhere in this file — not as an intermediate
 * value, not "just for the links". `security-headers.ts` states the invariant this file is half
 * of: no untrusted markup STRING reaches a DOM sink; sender bytes enter the app document only
 * as React text nodes and as attributes this code constructed. The CSP rationale is written on
 * top of that sentence; claims are contracts here, so the sentence constrains this file rather
 * than the other way round. On the plain-text path the constructed attribute is an `href` built
 * from a parsed `URL`; on the rich path (below) it is that plus the handful of numbers and
 * class names the renderer stamps on elements IT created.
 *
 * ── AND THE RICH PATH, WHICH RENDERS STRUCTURE WITHOUT EVER RENDERING MARKUP ──────────────
 *
 * A prose-classified html mail (see `MessageBody`'s `isRigidLayout`) no longer flattens to its
 * `text/plain` part. `MessageBody`'s walker re-reads the SANITIZED document through a second,
 * narrower allow-list and emits the {@link BodyNode} superset below — paragraphs, headings,
 * lists, tables, inline emphasis, gated links, and `blockquote` as the same {@link QuoteNode}
 * the plain-text path builds, so the trailing-history fold applies to both. This file renders
 * those nodes the only way it renders anything: `createElement`, text nodes, constructed
 * attributes. There is no serialized form anywhere between the sanitized DOM and the screen,
 * which is what keeps the sink invariant true while tables and lists render natively. No
 * sender `style`, `class`, `width` or `id` survives — the viewer's own type is the point.
 *
 * Deliberately a plain `<a>` and never `next/link`: `next/link` prefetches, and a message body
 * that fetches anything on render is the tracker-pixel behaviour the product exists to stop.
 *
 * ── AND THE TRAILING HISTORY IS FOLDED, BECAUSE THE READER HAS READ IT ────────────────────
 *
 * A reply carries the whole chain under it, and the chain is usually what the reader just came
 * from. So the TRAILING top-level quote run — plus the attribution paragraph(s) that introduce
 * it — is collapsed behind a quiet chip and rendered only when asked for
 * ({@link splitTrailingHistory} decides; the component holds the state). Three deliberate limits:
 *
 *   · ONLY the trailing run. A quote the writer answered inline — prose after it — is part of
 *     the letter, and folding it would hide the words the reply is about.
 *   · NEVER on a body that is nothing but quote (a fully-quoted forward): collapsing the only
 *     content would empty the pane behind a chip.
 *   · Collapsed means NOT IN THE DOM, not hidden by style — a folded tracking URL must not
 *     become an anchor until the reader asks for the history it sits in.
 *
 * This is the NATIVE path only. The framed HTML path (`MessageBody`'s iframe) shows the sender's
 * own markup, where the quoted history is the sender's document and stays as sent.
 */
import { useState, type ReactNode } from "react";
import { liveCopy } from "./locale";

/**
 * Leading email quote markers — up to a little indent, then one or more `>` each optionally
 * followed by a space. The number of `>` is the quote DEPTH; the rest of the line is its content.
 * `> `, `>>`, `> > ` all parse to the depth the reader means.
 */
const QUOTE_PREFIX = /^[ \t]{0,3}((?:>[ \t]?)+)/;

/**
 * ATTRIBUTION LINES — the sentence that says who wrote the block below, in the forms real mail
 * actually uses. Rendered as a quiet separator rather than as prose, so each quoted block's author
 * stays legible instead of dissolving into the wall.
 *
 *   · "On <date>, Alice <a@x> wrote:"          (en)   · "Am <date> schrieb Alice:"     (de)
 *   · "Le <date>, Alice a écrit :"             (fr)   · "El <date>, Alice escribió:"    (es)
 *   · the forwarded-header block — Von/From, Gesendet/Sent, An/To, Betreff/Subject, Datum/Date…
 *   · a "-----Original Message-----" / "Ursprüngliche Nachricht" separator line.
 *
 * Deliberately anchored and bounded: a match needs the whole short line to be the attribution
 * shape, so an ordinary sentence that merely contains "wrote" or a colon is left as prose.
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
/** Inline emphasis — `strong`/`b`, `em`/`i`, `u`, folded to one kind per meaning. */
export interface StyledRun { kind: "strong" | "em" | "underline"; children: InlineNode[] }
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
export type InlineNode = TextRun | LineBreak | StyledRun | LinkRun;

/** A paragraph of rich inline content. `attribution` re-uses the plain path's role and style. */
export interface RichParagraphNode { kind: "rich"; attribution: boolean; children: InlineNode[] }
/** `h1`–`h6`, rendered at the app's own scale — a mail heading is not a page heading. */
export interface HeadingNode { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
export interface RuleNode { kind: "rule" }
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
  | TableNode;
/**
 * Fold the flat block list into the tree the reader actually means.
 *
 * A stack of open containers tracks the current quote depth. Each block either continues the
 * container at its depth (a second quoted paragraph joins the FIRST one's container — this is
 * the merge that ends the one-bar-per-paragraph fragmentation), opens deeper containers (a
 * reply hop nests inside the history it quotes), or closes containers (the depth dropped, or
 * depth-0 prose — an inline reply — ended the quoted run altogether). Blank lines never reach
 * this function; they end BLOCKS in `toBlocks`, and deliberately not containers, because a
 * blank quoted line separates a quoted message's paragraphs, not the message.
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
    (depth === 0 ? top : stack[stack.length - 1]!.children).push({ kind: "para", block });
  }
  return top;
}

/**
 * The toggle's two labels. `liveCopy` and not `useTranslations`, for the same reason as
 * `MessageBody.COPY`: this component renders bare — no intl provider — in a dozen unit tests,
 * and the hook throws without one. `test/locale-shim-parity.test.ts` holds this table and the
 * `bodyText` catalogue namespace to the same key set and the same English sentences.
 */
const EN = {
  show: "Show history",
  hide: "Hide history",
};
export const COPY: typeof EN = liveCopy("bodyText", EN);

/**
 * The fold's one decision: which top-level nodes are "the trailing quoted history"?
 *
 * The LAST top-level node must be a quote run (`toTree` has already merged contiguous quoted
 * material, so a trailing history is exactly one node), and every attribution paragraph sitting
 * immediately above it — "On … wrote:", a Von/Gesendet/Betreff header block — introduces that
 * history and folds with it. `null` means "do not fold", and it is the answer whenever the lead
 * would hold no fresh words: a fully-quoted forward, a bare attribution over a quote, an empty
 * body. Collapsing those would put the whole message behind a chip.
 *
 * Mid-message quotes are lead BY CONSTRUCTION: a quote run with depth-0 prose after it is not
 * the last node, so it never reaches the fold. That is the inline-reply case, and it stays on
 * screen with the words that answer it.
 */
/** Is this node an attribution line, in either of the two paragraph spellings? */
function isAttributionNode(n: BodyNode): boolean {
  return (n.kind === "para" && n.block.attribution) || (n.kind === "rich" && n.attribution);
}

/**
 * Does this node hold fresh words — content the fold must leave on screen? Quotes are what the
 * fold hides, attributions introduce them, and a bare rule holds no words; everything else —
 * a paragraph of either spelling, a heading, a list, a table — is the letter.
 */
function carriesProse(n: BodyNode): boolean {
  switch (n.kind) {
    case "para": return !n.block.attribution;
    case "rich": return !n.attribution;
    case "heading": case "list": case "table": return true;
    case "quote": case "rule": return false;
  }
}

function splitTrailingHistory(
  nodes: BodyNode[],
): { lead: BodyNode[]; history: BodyNode[] } | null {
  const last = nodes[nodes.length - 1];
  if (!last || last.kind !== "quote") return null;
  let start = nodes.length - 1;
  while (start > 0) {
    const prev = nodes[start - 1]!;
    if (isAttributionNode(prev)) start -= 1;
    else break;
  }
  const lead = nodes.slice(0, start);
  if (!lead.some(carriesProse)) return null;
  return { lead, history: nodes.slice(start) };
}

/**
 * A CANDIDATE, NOT A DECISION.
 *
 * This matches anything shaped like `scheme:rest`, INCLUDING `javascript:` and `data:`. That is
 * on purpose and it is the whole design: if the pattern itself only ever matched `https?://`,
 * the scheme rule would be an invisible property of a regex nobody can watch fail, and
 * `body-text.test.ts` case 1 would pass vacuously. The rejection happens in one named place
 * ({@link anchorFor}), where it can be deleted and watched go red.
 *
 * The body charset excludes whitespace and the quote/angle characters. Brackets and parens ARE
 * allowed inside — `http://[::1]:8080/x` is a real URL — and are stripped only from the END,
 * which is what unwraps the `text [url]` pairs `htmlToText` emits.
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

/** One paragraph's worth of text, with its safe URLs turned into anchors. */
function linkify(block: string, keyBase: string): ReactNode[] {
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
 * The shared body renderer — the focused message in `MessagePane` AND the conversation
 * siblings in `Conversation`.
 *
 * ONE COMPONENT, BOTH SURFACES, on purpose. "Built, tested, unreachable" — the fix landing on
 * the pane while the thread below it keeps dumping raw text — is a shape this repo has shipped
 * five times, and a second copy of this logic is how it happens a sixth.
 *
 * Returns a fragment of `<p>` rather than its own wrapper: the caller owns the container and
 * its class (`.msg-body`, `.hm-body`), which are what the existing pane and screener
 * assertions select on, and what carries the surface's own type scale.
 */
/**
 * Rich inline content, as React elements. A `text` run renders as a bare string — a React
 * TEXT NODE, which is the sink invariant made concrete — and every element here is one this
 * function created with attributes it computed. The anchor mirrors the plain path's
 * (`target`/`rel`/class) with one addition: when the sender's label names a different host
 * than the destination ({@link LinkRun.elsewhere}), the real host is printed beside it — the
 * framed path's anti-phishing marker, carried natively.
 */
function renderInline(nodes: InlineNode[], keyBase: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyBase}i${i}`;
    switch (node.kind) {
      case "text": return node.text;
      case "break": return <br key={key} />;
      case "strong": return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "em": return <em key={key}>{renderInline(node.children, key)}</em>;
      case "underline": return <u key={key}>{renderInline(node.children, key)}</u>;
      case "link":
        return (
          <a
            key={key}
            className="msg-link"
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            title={`Goes to ${node.host}`}
          >
            {renderInline(node.children, key)}
            {node.elsewhere ? <span className="msg-link-host"> ({node.host})</span> : null}
          </a>
        );
    }
  });
}

function renderNodes(nodes: BodyNode[], keyPrefix: string): ReactNode[] {
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
            {renderNodes(node.children, `${key}-`)}
          </div>
        );
      case "para":
        return (
          <p className={node.block.attribution ? "msg-attribution" : "msg-p"} key={key}>
            {linkify(node.block.text, key)}
          </p>
        );
      case "rich":
        return (
          <p className={node.attribution ? "msg-attribution" : "msg-p"} key={key}>
            {renderInline(node.children, key)}
          </p>
        );
      case "heading": {
        // The app's scale, not the sender's: `.msg-h` caps the size (message-body.css), so a
        // newsletter-sized h1 reads as a letter's heading rather than a shout.
        const H = `h${node.level}` as "h1";
        return <H className="msg-h" key={key}>{renderInline(node.children, key)}</H>;
      }
      case "rule":
        return <hr className="msg-hr" key={key} />;
      case "list": {
        const items = node.items.map((item, j) => (
          <li key={`${key}-${j}`}>{renderNodes(item, `${key}-${j}-`)}</li>
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
                          {renderNodes(cell.children, `${key}-${r}-${c}-`)}
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

/**
 * `rich` is the walker's output for a prose-classified html part — `MessageBody` is the only
 * caller that passes it. Present and non-empty, it replaces the text-parsing entirely (the
 * message renders with its own structure — lists, tables, real anchors); absent, `null` (the
 * walker hit its node cap, or the mail had no usable structure) or empty, the text part
 * renders exactly as it always has. The fold below applies identically to both, because the
 * walker emits the same {@link QuoteNode} the text parser builds.
 */
export function BodyText({ text, rich }: { text: string; rich?: BodyNode[] | null }) {
  /**
   * The fold's state keys on the MESSAGE TEXT, not on the component instance: `open` is only
   * true while the text it was opened for is the text on screen. The pane reuses one mounted
   * `BodyText` as the reader moves between messages, and a plain `useState(false)` would carry
   * one mail's expansion onto the next — history the reader never asked for, on a message they
   * have not read. Comparing against the same string the mirror handed down is an identity
   * check in practice and correct even when it is not. The rich path keys on the same string:
   * `text` is the same message's text part, handed down beside the nodes.
   */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // CRLF is what an IMAP body actually carries; normalise before splitting on lines, or a
  // blank line is `\r\n\r\n` and every paragraph boundary is missed.
  const nodes = rich && rich.length > 0
    ? rich
    : toTree(toBlocks((text ?? "").replace(/\r\n?/g, "\n").split("\n").map(classifyLine)));
  const split = splitTrailingHistory(nodes);
  if (split === null) return <>{renderNodes(nodes, "b")}</>;
  const open = openedFor === text;
  return (
    <>
      {renderNodes(split.lead, "b")}
      {/* A real <button> — Enter and Space come with the element; `aria-expanded` reports the
          fold. Collapsed history is NOT RENDERED rather than hidden: nothing in it (including
          its anchors) exists until the reader asks. */}
      <button
        type="button"
        className="msg-history-toggle"
        aria-expanded={open}
        onClick={() => setOpenedFor(open ? null : text)}
      >
        {open ? COPY.hide : COPY.show}
      </button>
      {open ? renderNodes(split.history, "h") : null}
    </>
  );
}
