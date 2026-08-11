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
 * value, not "just for the links". `security-headers.ts` states that the app "renders no
 * untrusted HTML anywhere" and the CSP rationale is written on top of that sentence; claims are
 * contracts here, so the sentence constrains this file rather than the other way round. The
 * sender's bytes only ever reach the DOM as text nodes and as an `href` this file constructed
 * from a parsed `URL`.
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

function isAttribution(content: string): boolean {
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
const MAX_QUOTE_DEPTH = 6;

/** One paragraph (or attribution line) of the rendered body. */
interface ParagraphNode { kind: "para"; block: Block }
/** One quote container: everything quoted at `depth` within one contiguous quoted run. */
interface QuoteNode { kind: "quote"; depth: number; children: BodyNode[] }
type BodyNode = ParagraphNode | QuoteNode;
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
function splitTrailingHistory(
  nodes: BodyNode[],
): { lead: BodyNode[]; history: BodyNode[] } | null {
  const last = nodes[nodes.length - 1];
  if (!last || last.kind !== "quote") return null;
  let start = nodes.length - 1;
  while (start > 0) {
    const prev = nodes[start - 1]!;
    if (prev.kind === "para" && prev.block.attribution) start -= 1;
    else break;
  }
  const lead = nodes.slice(0, start);
  const hasProse = lead.some((n) => n.kind === "para" && !n.block.attribution);
  if (!hasProse) return null;
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
function anchorFor(candidate: string): { href: string; label: string } | null {
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
function renderNodes(nodes: BodyNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    if (node.kind === "quote") {
      // One container per quoted run per level, so the left rule runs unbroken down the whole
      // quoted message instead of restarting at every paragraph. `data-quote-depth` still
      // carries the level for styling hooks and tests; the recursion is bounded by
      // MAX_QUOTE_DEPTH, enforced where the tree is built.
      return (
        <div className="msg-quote" data-quote-depth={node.depth} key={key}>
          {renderNodes(node.children, `${key}-`)}
        </div>
      );
    }
    const cls = node.block.attribution ? "msg-attribution" : "msg-p";
    return (
      <p className={cls} key={key}>
        {linkify(node.block.text, key)}
      </p>
    );
  });
}

export function BodyText({ text }: { text: string }) {
  /**
   * The fold's state keys on the MESSAGE TEXT, not on the component instance: `open` is only
   * true while the text it was opened for is the text on screen. The pane reuses one mounted
   * `BodyText` as the reader moves between messages, and a plain `useState(false)` would carry
   * one mail's expansion onto the next — history the reader never asked for, on a message they
   * have not read. Comparing against the same string the mirror handed down is an identity
   * check in practice and correct even when it is not.
   */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // CRLF is what an IMAP body actually carries; normalise before splitting on lines, or a
  // blank line is `\r\n\r\n` and every paragraph boundary is missed.
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n").map(classifyLine);
  const nodes = toTree(toBlocks(lines));
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
