import sanitizeHtml from "sanitize-html";
import { Parser } from "htmlparser2";

/**
 * OUTBOUND HTML — the allowlist a composed message passes through, and the text/plain
 * alternative derived from what survives it.
 *
 * ── WHY THERE IS A SECOND SANITIZER IN THIS REPOSITORY ───────────────────────────────────
 *
 * The other one is DOMPurify in `apps/webapp/app/components/MessageBody.tsx`, and it solves the
 * opposite problem: markup a STRANGER wrote, rendered into a sandboxed frame in the reader's
 * browser. It is browser-only (it needs a DOM), and its allowlist is wide because inbound mail
 * legitimately contains tables, images and layout.
 *
 * This one runs on the server, on markup OUR OWN editor produced — and that is exactly why it
 * cannot be skipped. "Our editor produced it" is a statement about the client, and the client is
 * a browser somebody else controls. `POST /drafts` accepts a string; nothing about the request
 * proves an editor was involved. So the server's rule is not "clean up what the editor sent", it
 * is "reduce whatever arrived to the small grammar the editor is allowed to speak", and anything
 * outside that grammar is dropped rather than repaired.
 *
 * ── THE GRAMMAR IS DELIBERATELY SMALL, AND SMALLNESS IS THE FEATURE ──────────────────────
 *
 * Bold, italic, strike, links, ordered and bullet lists, block quotes, inline code and code
 * blocks. No images, no tables, no styles, no classes, no fonts and no colours. Two consequences
 * worth stating because they are load-bearing rather than incidental:
 *
 *   · There is no `img`, so there is no way for a composed message to carry an inline `data:`
 *     payload. That is the mechanism behind the 2026-08-01 storage outage, arriving from the
 *     other direction — the migration that caps stored HTML bodies closed the inbound half. The
 *     cap below is a tripwire; this allowlist is why it should never be reached.
 *   · The grammar is small enough that {@link htmlToPlainText} can render ALL of it faithfully.
 *     A `multipart/alternative` is a promise that its two parts say the same thing, and that
 *     promise is only keepable while every construct the html half can express has a text half.
 *
 * ── THE ALLOWLIST IS A FROZEN LITERAL ────────────────────────────────────────────────────
 *
 * `sanitize-html`'s defaults are permissive by design — an options object that arrives partly
 * undefined selects them, silently. Every field this module cares about is therefore stated,
 * including the ones whose value equals the default, so that a reader can see the whole policy
 * in one place and a test can mutate any single line of it and watch a fixture go red.
 *
 * FROZEN IS NOT THE SAME AS FIXED. The list changes when the editor's grammar changes, and only
 * then, and only in the same commit: `pre` is here because `RichEditor.tsx` now offers a code
 * block, and it arrived together with the `<pre>` case in {@link htmlToPlainText} below. An
 * entry added on its own would widen what a hostile client may post for no gain, and an editor
 * node added on its own would be a control whose output this function flattens.
 */

/**
 * The ceiling on one stored/sent html body, in bytes.
 *
 * 262144 = 256 KiB, and it is `message_bodies`' number rather than a second one — the argument
 * for the value is in `0022_message_body_html_cap.sql` and is not repeated here. This constant
 * and `drafts_html_cap` in `0037_draft_html.sql` are the same ceiling expressed twice, because a
 * migration freezes the moment it is applied and code does not. A test reads the migration and
 * reconciles the two, which is the same arrangement `STORED_HTML_CAP_BYTES` has.
 *
 * Measured in BYTES, not characters. `octet_length` is what the constraint counts, so a body of
 * emoji or accented text must be measured the same way here or the two disagree exactly where it
 * matters.
 */
export const DRAFT_HTML_CAP_BYTES = 262144;

/** UTF-8 length, matching Postgres `octet_length`. */
export const htmlByteLength = (html: string): number => Buffer.byteLength(html, "utf8");

/**
 * Tags that survive. Synonyms are allowed alongside the canonical form on purpose: the editor
 * emits `strong`/`em`/`s`, but a paste from another application arrives as `b`/`i`/`strike`, and
 * dropping those would silently unformat text the user can see is formatted. `htmlToPlainText`
 * treats each pair identically, so the two spellings can never render differently.
 */
const ALLOWED_TAGS = [
  "p", "br",
  "strong", "b", "em", "i", "s", "strike", "del",
  "a",
  "ul", "ol", "li",
  "blockquote",
  // `code` is the inline mark; `pre` is the block, and the editor emits the pair as
  // `<pre><code>…</code></pre>`. `pre` alone would still be admitted from a paste, and
  // `htmlToPlainText` renders it the same way either way.
  "code", "pre",
] as const;

/**
 * `href` on a link, and nothing else anywhere.
 *
 * No `target`, no `rel`, no `title`, no `id`, no `class`, no `style`. A mail client decides how
 * to open a link; the two attributes a web page would need for that are meaningless in a message
 * and are one more thing for a policy to be wrong about.
 */
const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
};

/**
 * The schemes a link may use. `javascript:` and `data:` are absent, which is the single most
 * important line in this file — a `javascript:` href in a message body is a live payload in
 * whatever renders it, including our own reader when it displays the Sent copy.
 *
 * `mailto` is here because a composed message that offers a reply address is ordinary and
 * useful. `tel` is not, because nothing in the product produces one and an allowlist should
 * contain what is used rather than what is imaginable.
 */
const ALLOWED_SCHEMES = ["http", "https", "mailto"] as const;

/**
 * The policy, whole, in one object.
 *
 * `disallowedTagsMode: "discard"` drops a disallowed TAG and keeps its text — so a pasted
 * `<h1>Hello</h1>` becomes `Hello` rather than vanishing. `nonTextTags` is the exception that
 * makes that safe: the content of `script`, `style`, `textarea` and `option` is discarded WITH
 * the tag, because keeping the text of a `<script>` would paste executable source into the
 * message body as prose.
 *
 * `allowProtocolRelative: false` closes `//evil.example/x`, which passes a scheme allowlist by
 * having no scheme at all and resolves to `https:` in a browser.
 */
const POLICY: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: Object.fromEntries(
    Object.entries(ALLOWED_ATTRIBUTES).map(([tag, attrs]) => [tag, [...attrs]]),
  ),
  allowedSchemes: [...ALLOWED_SCHEMES],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "style", "textarea", "option"],
  // No iframes and no stylesheets: the two lists that would permit them are stated empty rather
  // than omitted, so `allowedTags` above is the whole answer to "what can appear".
  allowedIframeHostnames: [],
  allowedClasses: {},
  allowedStyles: {},
  // Comments carry no content a reader sees and are a favourite place to hide markup that a
  // second, laxer parser downstream will read as tags.
  allowedScriptDomains: [],
  parser: { decodeEntities: true },
};

/**
 * Reduce composed html to the allowed grammar.
 *
 * IDEMPOTENT, and that property is asserted rather than assumed. The same function runs at two
 * points — when a draft is stored, and again when its bytes are put into an envelope — so that
 * no writer of the `drafts` table can reach SMTP unsanitized (there is a second writer today:
 * the workflow's `draft_reply` step). Two gates are only safe while they cannot
 * disagree, and `sanitize(sanitize(x)) === sanitize(x)` is what makes the second pass a no-op on
 * anything the first pass produced.
 */
export function sanitizeOutboundHtml(html: string): string {
  return sanitizeHtml(html, POLICY);
}

/**
 * Block-level tags: each one starts on a fresh line in the text rendering.
 *
 * `pre` is deliberately NOT here. It is a block, but the generic path flushes a line and then
 * lets {@link htmlToPlainText}'s whitespace collapsing run over the content — which is exactly
 * the one thing a code block may not survive. It gets its own branch, before this set is
 * consulted.
 */
const BLOCKS = new Set(["p", "ul", "ol", "li", "blockquote"]);

/**
 * Render sanitized html as the text/plain alternative.
 *
 * ── WHY THIS IS HAND-WRITTEN AND WHY THAT IS NOT THE USUAL MISTAKE ───────────────────────
 *
 * It runs on the OUTPUT of {@link sanitizeOutboundHtml}, over exactly the tags {@link
 * ALLOWED_TAGS} names. The count is deliberately NOT restated here: this line used to say "a
 * grammar of thirteen tags", and `git log -L` on the literal shows it has one commit in its
 * history — so the list was fifteen entries long on the day that sentence was written, and a
 * restated number is a claim that is wrong the moment it is copied and that nothing can check.
 * It is not a general html-to-text converter and must never be used as one: its
 * input is already known-safe and known-small, and its output is `text/plain`, so its worst
 * possible failure is ugly text rather than injection. What it is NOT is a hand-written PARSER —
 * walking markup with regular expressions is how ugly text becomes wrong text — so the tags come
 * from `htmlparser2`, which is the same parser `sanitize-html` used a moment earlier.
 *
 * ── WHAT IS PRESERVED, AND WHY THAT LIST STOPS WHERE IT DOES ─────────────────────────────
 *
 * Structure and links; not emphasis. A plaintext reader who loses bold loses decoration, and one
 * who loses a list, a quotation boundary or a link TARGET loses meaning:
 *
 *   · `<a href="…">text</a>` becomes `text (href)`, and bare `href` when the two are equal. A
 *     link whose destination is dropped is unfollowable, which makes the two parts of the
 *     alternative say different things — the one failure this whole function exists to prevent.
 *   · `<li>` becomes `- ` inside `<ul>` and `1. `, `2. ` … inside `<ol>`. The counter is per
 *     list and nested lists indent, so an outline survives as an outline.
 *   · `<blockquote>` prefixes `> ` on every line it contains, which is what mail has meant by a
 *     quotation since before html existed.
 *   · Emphasis, strike and inline code render as their text with no markers. Inventing `**` or
 *     backticks would put characters in the message that the sender did not type and that a
 *     reader has no way to tell from literal ones.
 *   · `<pre>` renders VERBATIM — its own line breaks, its own indentation, no fence around it.
 *     Same rule as the line above (no invented characters), and the one place in this function
 *     where whitespace is meaning rather than layout: a code block whose leading spaces were
 *     collapsed is not the same program. It is also the only construct exempt from the blank-run
 *     collapse at the bottom, because two blank lines between two functions is how a great deal
 *     of real code is written and the alternative half of a `multipart/alternative` may not
 *     silently reformat it.
 */
export function htmlToPlainText(html: string): string {
  /** The output, built as lines so block boundaries are decided in one place. */
  let out = "";
  /** Open list contexts, innermost last. `null` marks a bullet list. */
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let quoteDepth = 0;
  /** Text accumulated for the current line, before prefixes are applied. */
  let line = "";
  /**
   * The list marker and its indent, held apart from {@link line} because the line's own leading
   * whitespace is collapsed away — an indent kept inside the text would be trimmed off with it.
   * Consumed by the first flush after it is set, so a wrapped item's continuation lines carry
   * the quote prefix but not a second bullet.
   */
  let lead = "";
  /**
   * The anchor currently open: its href, and the text seen inside it so far.
   *
   * Held on a mutable box rather than in a `let`, which is a TYPE-CHECKING requirement and not a
   * style choice. Every assignment to it happens inside a parser callback, so the compiler's
   * flow analysis still believes the initializer after `parser.end()` returns and narrows the
   * variable to `null` — the unterminated-anchor branch at the bottom of this function then
   * reads a property of `never` and does not compile. A property access is re-widened by any
   * intervening call, which is exactly the truth here: the parser may have written to it.
   */
  const open: { anchor: { href: string; text: string } | null } = { anchor: null };

  /**
   * Open `<pre>` elements, and the raw characters seen inside the outermost one.
   *
   * A DEPTH rather than a boolean because a nested `<pre>` — which the sanitizer permits, since
   * it allowlists tags and not their arrangement — would otherwise close the outer block on the
   * inner one's end tag and spill the rest of the code into the prose path.
   */
  let preDepth = 0;
  let preText = "";
  /**
   * Where each rendered code block sits in {@link out}, so the blank-run collapse at the bottom
   * can be applied to everything EXCEPT these. Recorded as offsets rather than by re-parsing
   * the result: the output is plain text with nothing left in it to distinguish code from prose,
   * which is the point of the rendering and also why the exemption has to be carried along.
   */
  const codeSpans: Array<[number, number]> = [];

  const prefix = (): string => "> ".repeat(quoteDepth);

  /**
   * End the current line.
   *
   * A flush with nothing in it is a NO-OP, and that is the load-bearing half. Every block tag
   * flushes on the way in as well as on the way out — `<p>one</p><p>two</p>` therefore calls
   * this four times for two lines — so an empty flush is the ordinary case and must not put a
   * blank line anywhere. A genuinely empty paragraph is handled where it is known to be one,
   * by {@link blankLine} at the closing tag.
   */
  const flush = (): void => {
    const body = line.replace(/[ \t]+/g, " ").trim();
    const marker = lead;
    line = "";
    lead = "";
    if (body === "") return;
    out += `${prefix()}${marker}${body}\n`;
  };

  /**
   * The blank line a `<p></p>` means.
   *
   * An empty paragraph is how somebody puts space between two paragraphs in a rich editor, so
   * dropping it would silently reflow their message. It is skipped at the very start, where a
   * leading blank line is a gap before the first word rather than a gap between two of them.
   */
  const blankLine = (): void => {
    if (out === "") return;
    out += `${prefix()}\n`;
  };

  /**
   * A hard break — what a `<br>` means, and where the text half stops disagreeing with the html
   * half about vertical space.
   *
   * A `<br>` after content flushes that content, exactly as {@link flush} does. A `<br>` on an
   * otherwise-EMPTY line is the difference: it is a deliberate blank line — the author pressed
   * Enter on an empty line, or twice running — and a second `<br>` renders as that gap in a mail
   * client. So it emits the gap here too, rather than being swallowed as an empty flush is.
   *
   * This is the text side of the editor's line-break model. It emits a single Enter as one `<br>` (a soft line
   * break, single-spaced) and a blank line as `<br><br>`, in ONE paragraph, instead of splitting
   * into paragraphs whose margins the recipient reads as gaps. The html half therefore shows
   * single breaks where the author made single breaks; this keeps the text half saying the same
   * thing, which is the whole promise of a `multipart/alternative`.
   *
   * A LEADING empty break is dropped for the same reason {@link blankLine} drops a leading empty
   * paragraph: it is a gap before the first word, not between two of them. A trailing run is
   * capped by the final collapse, so `<br><br><br>` is one gap and not three.
   */
  const hardBreak = (): void => {
    const body = line.replace(/[ \t]+/g, " ").trim();
    const marker = lead;
    line = "";
    lead = "";
    if (body === "") {
      if (out === "") return;
      out += `${prefix()}\n`;
      return;
    }
    out += `${prefix()}${marker}${body}\n`;
  };

  const emit = (s: string): void => {
    if (open.anchor) open.anchor.text += s;
    else line += s;
  };

  /**
   * A finished code block, written out line by line with the quote prefix and NOTHING else.
   *
   * Three normalisations, and each is what a renderer of the html half already does, so keeping
   * them is what keeps the two parts equal rather than what makes them differ:
   *   · `\r\n`/`\r` become `\n`. A stray carriage return is a byte no reader sees.
   *   · ONE leading newline is dropped — html's own rule for the character immediately after
   *     `<pre>`, which every browser applies and which a paste routinely carries.
   *   · Trailing blank lines go. They are invisible in the html half, and the alternative
   *     ending in six of them reads as a mistake somebody made.
   * Interior whitespace — indentation, alignment, blank lines between blocks — is untouched.
   */
  const flushPre = (raw: string): void => {
    const body = raw.replace(/\r\n?/g, "\n").replace(/^\n/, "").replace(/\n+$/, "");
    if (body === "") return;
    const start = out.length;
    for (const l of body.split("\n")) out += `${prefix()}${l}\n`;
    codeSpans.push([start, out.length]);
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        // PRE FIRST, and everything inside it is text. A `<code>`, a `<br>` or a stray `<p>`
        // that a paste put inside a code block is structure the author cannot see and did not
        // ask for; only the characters are the code.
        if (name === "pre") {
          if (preDepth === 0) {
            flush();
            preText = "";
          }
          preDepth += 1;
          return;
        }
        if (preDepth > 0) {
          if (name === "br") preText += "\n";
          return;
        }
        if (name === "br") {
          hardBreak();
          return;
        }
        if (name === "a") {
          open.anchor = { href: attribs.href ?? "", text: "" };
          return;
        }
        if (name === "ul" || name === "ol") {
          flush();
          lists.push({ ordered: name === "ol", n: 0 });
          return;
        }
        if (name === "li") {
          flush();
          const ctx = lists[lists.length - 1];
          // A stray `<li>` with no list around it still needs a marker; treat it as a bullet
          // rather than dropping it, because the sanitizer permits the tag and the reader will
          // otherwise see two items run together as one sentence.
          const depth = Math.max(0, lists.length - 1);
          if (ctx?.ordered) {
            ctx.n += 1;
            lead = `${"  ".repeat(depth)}${ctx.n}. `;
          } else {
            if (ctx) ctx.n += 1;
            lead = `${"  ".repeat(depth)}- `;
          }
          return;
        }
        if (name === "blockquote") {
          flush();
          quoteDepth += 1;
          return;
        }
        if (BLOCKS.has(name)) flush();
      },

      ontext(text) {
        // Verbatim inside a code block: the collapse below is what turns two spaces into one,
        // and in code the second space is the message.
        if (preDepth > 0) {
          preText += text;
          return;
        }
        emit(text.replace(/\s+/g, " "));
      },

      onclosetag(name) {
        if (preDepth > 0) {
          if (name !== "pre") return;
          preDepth -= 1;
          if (preDepth > 0) return;
          flushPre(preText);
          preText = "";
          return;
        }
        if (name === "a") {
          const a = open.anchor;
          open.anchor = null;
          if (!a) return;
          const text = a.text.trim();
          const href = a.href.trim();
          if (href === "") line += text;
          else if (text === "" || text === href) line += href;
          else line += `${text} (${href})`;
          return;
        }
        if (name === "ul" || name === "ol") {
          flush();
          lists.pop();
          return;
        }
        if (name === "blockquote") {
          flush();
          quoteDepth = Math.max(0, quoteDepth - 1);
          return;
        }
        if (name === "p") {
          const empty = line.trim() === "";
          flush();
          if (empty) blankLine();
          return;
        }
        if (BLOCKS.has(name)) flush();
      },
    },
    { decodeEntities: true },
  );

  parser.write(html);
  parser.end();
  // Anything after the last block boundary, and any anchor left open by malformed input.
  if (open.anchor) line += open.anchor.text.trim();
  // A `<pre>` the input never closed: its characters are still the author's.
  if (preDepth > 0) flushPre(preText);
  flush();

  /**
   * One trailing newline at most, and no run of blank lines anywhere — a mail body that ends in
   * six blank lines reads as a mistake — EXCEPT inside a code block.
   *
   * The exemption is not a nicety. Two blank lines between two top-level definitions is how
   * Python is conventionally written and is ordinary in most other languages, and a collapse
   * applied over the whole output would silently reflow a snippet the author pasted — the text
   * half quietly saying something the html half does not. So the collapse runs over the prose
   * BETWEEN the recorded code spans and leaves their bytes alone. The spans are in the order
   * they were written and cannot overlap, so one pass over them is the whole of it.
   */
  const collapse = (s: string): string => s.replace(/\n{3,}/g, "\n\n");
  let result = "";
  let cursor = 0;
  for (const [start, end] of codeSpans) {
    result += collapse(out.slice(cursor, start)) + out.slice(start, end);
    cursor = end;
  }
  result += collapse(out.slice(cursor));
  return result.replace(/\n+$/, "");
}

/**
 * The two parts of one composed message, derived together.
 *
 * Returning both from one call is the structural form of the promise a `multipart/alternative`
 * makes. A caller cannot store the html from here and the text from somewhere else, and the text
 * is derived from the SANITIZED markup rather than from what arrived — so what a recipient reads
 * as plain text is a rendering of exactly the bytes the other part contains, never of something
 * the sanitizer removed.
 */
export interface OutboundBody {
  html: string;
  text: string;
}

export function prepareOutboundBody(rawHtml: string): OutboundBody {
  const html = sanitizeOutboundHtml(rawHtml);
  return { html, text: htmlToPlainText(html) };
}
