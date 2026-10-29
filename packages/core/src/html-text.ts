import { Parser } from "htmlparser2";

/**
 * HTML AS PLAIN TEXT — {@link htmlToPlainText}, the text/plain alternative of a composed message,
 * and {@link htmlWords}, the words of an inbound letter that has no text part. Tags come from
 * `htmlparser2`, the parser `sanitize-html` uses.
 */

/** Elements whose content is never text a reader sees. */
const NON_TEXT = new Set(["style", "script", "head", "title", "noscript", "template"]);

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

  // Elements whose text is never prose — a stylesheet, a script, the document head. The outbound
  // grammar holds none of them (the sanitizer drops them with their content), so this changes
  // nothing there; an inbound HTML-only message carries all of them.
  let skipDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (NON_TEXT.has(name)) { skipDepth += 1; return; }
        if (skipDepth > 0) return;
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
        if (skipDepth > 0) return;
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
        if (NON_TEXT.has(name)) { skipDepth = Math.max(0, skipDepth - 1); return; }
        if (skipDepth > 0) return;
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

/** Elements whose content the reader never draws: the sanitizer's drop set, and the stylesheet. */
const UNDRAWN = new Set([
  "annotation-xml", "audio", "desc", "foreignobject", "head", "iframe", "math", "mi", "mn", "mo", "ms", "mtext",
  "noembed", "noframes", "noscript", "optgroup", "option", "plaintext", "script", "style", "svg", "template",
  "title", "video", "xmp",
]);
/** Blocks that leave a blank line before and after them. */
const PARAGRAPH = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "table", "pre", "hr", "blockquote"]);
/** Blocks that start a new line. */
const LINE = new Set([
  "div", "li", "tr", "dt", "dd", "address", "article", "aside", "center", "caption", "figure", "figcaption",
  "footer", "form", "header", "main", "nav", "section", "tbody", "thead", "tfoot",
]);
/** Elements with no close tag of their own; the parser closes them at once. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** The html {@link htmlWords} reads, in characters: the stored html's own cap. */
export const HTML_WORDS_READ_MAX = 262_144;
/** The words {@link htmlWords} returns, in characters. */
export const HTML_WORDS_MAX = 65_536;
const HIDDEN_STYLE = /(?:^|;)\s*display\s*:\s*none\s*(?:!important\s*)?(?:;|$)/i;
/** A token of preheader filler: only U+034F and format characters (ZWNJ, ZWSP, soft hyphen…). */
const FILLER = /^[\u034f\p{Cf}]+$/u;
const BLANK = /^>*$/;
/** The deepest quote a line's `> ` prefix shows, so a line costs a bounded prefix. */
const QUOTE_MAX = 32;

/** Cut to at most `max` UTF-16 units without leaving half a surrogate pair. */
function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Without its trailing spaces and tabs, in one pass: `/[ \t]+$/` backtracks quadratically on a long inner run. */
function trimSpacesEnd(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * The words of an inbound html part, as the reader draws them: blocks break lines (paragraphs
 * leave a blank one), cells are spaced, `pre` is verbatim, a quote keeps `> `. A link gives its
 * text and never its href, an image nothing. Skips what the reader never draws, `display:none`
 * included (the `hidden` attribute is stripped by the render rules, so its text is drawn), and
 * preheader filler. `""` when nothing visible is left. Bounded on both ends; never throws on input.
 */
export function htmlWords(html: string): string {
  const lines: string[] = [];
  let line = "";
  let lineQuote = 0;
  let quote = 0;
  let pre = 0;
  /** What the next words wait for: 1 a new line, 2 a blank line before it. */
  let gap = 0;
  let skip = 0;
  let size = 0;
  /** Whether `line` ends in a space, kept apart: `line.endsWith` would flatten the whole line per text event. */
  let spaced = false;
  // Past the output bound nothing more is built, and a line keeps only what is left of it: the work stays O(bound).
  const push = (l: string): void => {
    if (size > HTML_WORDS_MAX) return;
    const kept = cutAt(l, HTML_WORDS_MAX - size);
    lines.push(kept);
    size += kept.length + 1;
  };
  const end = (): void => {
    push(`${"> ".repeat(Math.min(lineQuote, QUOTE_MAX))}${line}`);
    line = "";
    spaced = false;
  };
  const open = (): void => {
    if (gap > 0 && (line !== "" || lines.length > 0)) {
      if (line !== "") end();
      if (gap === 2) push(">".repeat(Math.min(quote, lineQuote, QUOTE_MAX)));
    }
    gap = 0;
    if (line === "") lineQuote = quote;
  };
  const write = (t: string): void => {
    if (size > HTML_WORDS_MAX) return;
    if (pre > 0) {
      const parts = t.replace(/\r\n?/g, "\n").split("\n");
      for (let i = 0; i < parts.length && size <= HTML_WORDS_MAX; i++) {
        if (i > 0) { open(); end(); }
        if (parts[i] !== "") { open(); line += parts[i]; spaced = parts[i].endsWith(" "); }
      }
      return;
    }
    let s = t.replace(/\s+/g, " ");
    if (line === "" || gap > 0 || spaced) s = s.trimStart();
    if (s === "") return;
    open();
    line += s;
    spaced = s.endsWith(" ");
  };
  const parser = new Parser({
    onopentag(name, attribs) {
      if (skip > 0) { if (!VOID.has(name)) skip += 1; return; }
      if (UNDRAWN.has(name) || HIDDEN_STYLE.test(attribs.style ?? "")) { if (!VOID.has(name)) skip = 1; return; }
      if (name === "br") {
        if (size > HTML_WORDS_MAX) return;
        if (line === "" && gap === 0) push(">".repeat(Math.min(quote, QUOTE_MAX)));
        else { open(); end(); }
        return;
      }
      gap = Math.max(gap, PARAGRAPH.has(name) ? 2 : LINE.has(name) ? 1 : 0);
      if (name === "blockquote") quote += 1;
      if (name === "pre") pre += 1;
    },
    ontext(t) {
      if (skip === 0) write(t);
    },
    onclosetag(name) {
      if (skip > 0) { if (!VOID.has(name)) skip -= 1; return; }
      if (name === "blockquote") quote = Math.max(0, quote - 1);
      if (name === "pre") pre = Math.max(0, pre - 1);
      if (name === "td" || name === "th") write(" ");
      gap = Math.max(gap, PARAGRAPH.has(name) ? 2 : LINE.has(name) ? 1 : 0);
    },
  }, { decodeEntities: true });
  parser.write(cutAt(html, HTML_WORDS_READ_MAX));
  parser.end();
  if (line !== "") end();
  const out: string[] = [];
  for (const raw of lines) {
    const l = trimSpacesEnd(raw.split(" ").filter((tok) => !FILLER.test(tok)).join(" "));
    if (BLANK.test(l) && (out.length === 0 || BLANK.test(out[out.length - 1]!))) continue;
    out.push(l);
  }
  while (out.length > 0 && BLANK.test(out[out.length - 1]!)) out.pop();
  const text = cutAt(out.join("\n"), HTML_WORDS_MAX).trimEnd();
  return text.replace(/[\s\u034f\p{Cf}]/gu, "") === "" ? "" : text;
}
