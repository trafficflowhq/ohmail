import sanitizeHtml from "sanitize-html";
import { Parser } from "htmlparser2";

/**
 * OUTBOUND HTML — the allowlist composed messages pass through, plus the text/plain alternative
 * derived from what survives. DOMPurify in `MessageBody.tsx` solves the opposite problem (a
 * stranger's markup in the reader's browser); this runs on the server because `POST /drafts`
 * accepts a string from any client — reduce input to the small grammar the editor may speak, drop
 * the rest. The grammar: bold, italic, strike, links, lists, block quotes, inline/block code. No
 * `img`, so no inline `data:` payloads; small enough that `htmlToPlainText` renders all of it,
 * keeping the `multipart/alternative` promise. Every `sanitize-html` option is stated, defaults
 * included; the list changes only with the editor's grammar, in the same commit.
 */

/**
 * Ceiling on one stored/sent html body, in bytes. 262144 = 256 KiB — `message_bodies`' number,
 * argued in `0022_message_body_html_cap.sql`, not repeated here. This constant and
 * `drafts_html_cap` in `0037_draft_html.sql` are one ceiling expressed twice (a migration freezes
 * when applied; code does not); a test reconciles them, as with `STORED_HTML_CAP_BYTES`. Measured
 * in BYTES: `octet_length` is what the constraint counts, so emoji and accented text must be
 * measured the same way.
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
 * The policy, whole, in one object. `disallowedTagsMode: "discard"` drops a disallowed TAG and
 * keeps its text — pasted `<h1>Hello</h1>` becomes `Hello`. `nonTextTags` is the exception that
 * makes that safe: `script`, `style`, `textarea` and `option` lose their content WITH the tag,
 * else a `<script>`'s source would paste into the body as prose. `allowProtocolRelative: false`
 * closes `//evil.example/x`, which passes a scheme allowlist by having no scheme and resolves to
 * `https:` in a browser.
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
 * Render sanitized html as the text/plain alternative. Runs on the OUTPUT of
 * `sanitizeOutboundHtml`, over exactly the tags `ALLOWED_TAGS` names — not a general converter,
 * not a hand-written parser: tags come from `htmlparser2`, the same parser `sanitize-html` used.
 * Structure and links survive; emphasis does not. `<a href>` becomes `text (href)`, bare `href`
 * when equal. `<li>` becomes `- ` in `<ul>`, `1. `, `2. ` … in `<ol>`, per-list, nested lists
 * indent. `<blockquote>` prefixes `> `. Emphasis, strike and inline code render as plain text —
 * no invented `**` or backticks. `<pre>` renders VERBATIM — the one place whitespace is meaning,
 * and the only construct exempt from the blank-run collapse.
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
   * Per-OPEN-ITEM state, innermost last: the pending marker that stood before the item opened.
   * The rule: a marker is consumable only by a flush inside its own item — the item's close
   * RESTORES whatever marker stood when it opened, unconditionally. `flush()` consumes the marker
   * it emits, so an item whose content flushed restores ""; content that DEFERRED into a
   * block-wrapping anchor's buffer never flushed, and its unconsumed marker is put back (a
   * parent's pending `1. ` an empty child must hand back). Every cheaper reading tried to PREDICT
   * what a wrapping anchor's close would contribute, and the prediction kept being wrong — so
   * nothing predicts: deferred content earns no marker, and the anchor's line ships unnumbered.
   */
  const liState: Array<{ savedLead: string }> = [];
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
    // NBSP-only is EMPTY: `<p>&nbsp;</p>` is the common empty-paragraph placeholder, and a
    // body of preserved-width characters with nothing beside them is a gap, not a line — the
    // paragraph-close check reads it as blank, and this must agree or the output carries a
    // space-only line AND the blank line.
    const kept = line.replace(/[ \t]+/g, " ").replace(/^[ \t]+|[ \t]+$/g, "");
    const body = kept.replace(/\u00a0/g, "").trim() === "" ? "" : kept;
    line = "";
    // AN EMPTY FLUSH DOES NOT CONSUME `lead`. `<li><p>…</p></li>` — TipTap's
    // own markup, not a hypothetical — opens the LI (sets `lead`) and then the `<p>` fires an
    // empty flush on its way in (nothing has been written to `line` yet), and the marker used
    // to be cleared right there, before the paragraph's own content had a chance to use it. A
    // marker only leaves once something actually flushes with it.
    if (body === "") return;
    const marker = lead;
    lead = "";
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
   * A hard break — what a `<br>` means. A `<br>` after content flushes it, exactly as `flush`
   * does; a `<br>` on an otherwise-EMPTY line is a deliberate blank line (Enter on an empty line)
   * and emits the gap rather than being swallowed. This is the text side of the editor's
   * line-break model: one Enter is one `<br>`, a blank line is `<br><br>`, in ONE paragraph — so
   * the text half says what the html half shows, the promise of a `multipart/alternative`. A
   * LEADING empty break is dropped (a gap before the first word); a trailing run is capped by the
   * final collapse, so `<br><br><br>` is one gap, not three.
   */
  const hardBreak = (): void => {
    // An NBSP-only SEGMENT between hard breaks is KEPT, unlike the paragraph flush's
    // placeholder collapse one function up: `<li>&nbsp;<br>visible</li>` opens with the
    // author's explicit break structure, and reading the placeholder as empty here cleared
    // the pending list marker with it — the visible text then shipped without its number and
    // renumbered every item after it. A space-width line inside a break run
    // is what the html half shows; the text half says the same.
    const body = line.replace(/[ \t]+/g, " ").replace(/^[ \t]+|[ \t]+$/g, "");
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
   * A finished code block, written line by line with the quote prefix and nothing else. Three
   * normalisations, each what a renderer of the html half already does: `\r\n`/`\r` become `\n`;
   * ONE leading newline is dropped (html's own rule after `<pre>`); trailing blank lines go.
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
          // `lead` here is "" in ordinary flow (the flush consumed or cleared it) and an
          // ANCESTOR's unconsumed marker under a block-wrapping anchor, where nothing has
          // flushed yet — saved so an item that earns nothing can hand it back at its close.
          liState.push({ savedLead: lead });
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
        // The collapse deliberately steps around U+00A0: a no-break space is CONTENT — it is
        // the one character an author (or the compose surface's signature serializer, which
        // encodes indentation with it precisely because ordinary spaces collapse) uses to say
        // "this width is meant". `\s` includes it, so the class is spelled out.
        emit(text.replace(/[^\S\u00a0]+/g, " "));
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
        if (name === "li") {
          flush();
          // An EMPTY item's marker must be cleared HERE, at the item's own close — the list
          // closing later is too late (the marker escapes onto prose after the list), and the
          // NEXT item must not inherit it (`<ol><li><p></p></li></ol><p>after</p>` read "1.
          // after"). The close RESTORES the marker it found — see `liState`'s header. The
          // `flush()` above is the item's last chance to consume its own marker; content that
          // deferred into a wrapping anchor's buffer never flushed, and the marker goes back to
          // whoever held it. O(1) per item.
          lead = (liState.pop() ?? { savedLead: "" }).savedLead;
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
   * One trailing newline at most and no run of blank lines anywhere — EXCEPT inside a code block.
   * Two blank lines between top-level definitions is how Python is written; a whole-output
   * collapse would silently reflow a pasted snippet, the text half saying something the html half
   * does not. So the collapse runs over the prose BETWEEN the recorded code spans and leaves
   * their bytes alone; the spans are in written order and cannot overlap, so one pass covers it.
   */
  // The no-break spaces carried this far exist to SURVIVE the whitespace collapse, not to
  // reach a recipient: prose ships the same width in ordinary spaces. INSIDE a recorded code
  // span the bytes are the author's verbatim — an NBSP in pasted source stays an NBSP.
  const collapse = (s: string): string =>
    s.replace(/\n{3,}/g, "\n\n").replace(/\u00a0/g, " ");
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
