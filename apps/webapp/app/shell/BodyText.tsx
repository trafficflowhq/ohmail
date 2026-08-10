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
 * each line, {@link toBlocks} groups the lines a depth at a time, and each quoted block is drawn
 * with a quiet left rule, a step of indent and a more muted tone per level, with the attribution
 * lines set apart as separators. The sender's own line breaks INSIDE a block still survive, under
 * `white-space: pre-line` — the same paragraph-rhythm rule as before, unchanged.
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
 */
import type { ReactNode } from "react";

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
function linkify(block: string, keyBase: number): ReactNode[] {
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
export function BodyText({ text }: { text: string }) {
  // CRLF is what an IMAP body actually carries; normalise before splitting on lines, or a
  // blank line is `\r\n\r\n` and every paragraph boundary is missed.
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n").map(classifyLine);
  const blocks = toBlocks(lines);

  return (
    <>
      {blocks.map((block, i) => {
        const cls = block.attribution ? "msg-attribution" : "msg-p";
        const para = (
          <p className={cls} key={block.depth === 0 ? i : undefined}>
            {linkify(block.text, i)}
          </p>
        );
        if (block.depth === 0) return para;
        // A quoted block: a quiet left rule, a step of indent and a more muted tone, keyed by
        // depth. NOT nested wrappers — sibling blocks with depth-scaled indent read as nesting
        // and stay flat in the DOM, which is what keeps a pathological ">>>>>" chain cheap.
        return (
          <div className="msg-quote" data-quote-depth={block.depth} key={i}>
            {para}
          </div>
        );
      })}
    </>
  );
}
