/**
 * The mail renderer's RULE SET, shared between the web reader and the phone reader — the tag
 * and attribute allow-lists, the URI gates, the tracking-pixel classification and the CSS
 * neutraliser. The webapp's `MessageBody.tsx` is the reference implementation (DOMPurify
 * executes these rules there); the phone executes the same rules over its own parse
 * (`apps/mobile/src/mail/sanitize.ts`). The web reader's parity suite drives its exported
 * halves and this module against the same fixtures, so the two spellings cannot drift apart
 * silently.
 */

/**
 * The tags a mail may use — an allow-list, so a tag nobody has thought about is absent by
 * default. Everything a mail client's bug reports are made of is absent by omission: `script`,
 * `iframe`, `form`, `object`, `embed`, `base`, `link`, `meta`, `svg`, `math` and the rest.
 * `style` is admitted because its TEXT is rewritten by {@link neutraliseCss} first.
 */
export const MAIL_ALLOWED_TAGS: readonly string[] = [
  "a", "abbr", "acronym", "address", "area", "article", "aside", "b", "bdi", "bdo", "big",
  "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "data", "dd",
  "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd",
  "label", "legend", "li", "main", "map", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u",
  "ul", "var", "wbr",
];

/** The four attributes whose value NAMES A RESOURCE — gated, never kept verbatim. */
export const MAIL_URL_ATTR: readonly string[] = ["href", "src", "srcset", "background"];

/**
 * The presentational vocabulary bulk mail is actually written in. No `on*` in it. Stripping
 * `width`/`align`/`bgcolor` is correct about safety and silently wrong about the product —
 * every fixed-width mail collapses to one unstyled column — so they are named, not derived.
 */
export const MAIL_PRESENTATION_ATTR: readonly string[] = [
  "alt", "title", "width", "height", "align", "valign", "border", "cellpadding",
  "cellspacing", "bgcolor", "style", "class", "id", "colspan", "rowspan", "dir", "lang",
  "type", "start", "value", "size", "color", "face", "abbr", "headers", "scope", "span",
  "role", "aria-label", "aria-hidden", "datetime",
];

export const MAIL_ALLOWED_ATTR: readonly string[] = [...MAIL_URL_ATTR, ...MAIL_PRESENTATION_ATTR];

/**
 * THE URI GATE — one constant, both readers. `cid:` is admitted because it names a part of
 * this very message and cannot leave the machine; `data:` is NOT (a `data:text/html` href
 * navigates to attacker markup; every legitimate `data:` in mail is an image `src`, gated by
 * {@link INLINE_IMAGE_SRC} instead).
 */
export const SAFE_HREF = /^(?:https?:|mailto:|tel:|cid:)/i;

/** A scheme that fetches over the network. What "remote" means in both readers. */
export const REMOTE_URL = /^https?:\/\//i;

/** An `<img src>` naming a part of this very message. Resolved from the message's own bytes. */
export const CID_URL = /^cid:/i;

/**
 * The only url schemes a stylesheet may keep, a POSITIVE list: `data:` carries its own bytes
 * and `cid:` names a part of this message; both fetch nothing. Everything else — relative,
 * protocol-relative, a fragment, an unknown scheme — becomes `none`: a srcdoc/loadData document
 * resolves a relative url against its EMBEDDER, which is a fetch, not an inert reference.
 */
export const INERT_CSS_URL = /^(?:data:|cid:)/i;

/**
 * The only shape a resolved embedded image may take: a base64 `data:` URI of one of the four
 * raster types. Enforced at the WRITE into the document, not only at the mint — the map arrives
 * through a prop, and "the engine is the only caller" is a fact about today's wiring, not a
 * property of the function. Any other value reads as absent and the image stays blanked.
 */
export const INLINE_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The Content-ID an `<img src="cid:…">` names — brackets and the scheme stripped — or null. */
export function cidOfSrc(src: string): string | null {
  const raw = src.slice(4).replace(/^</, "").replace(/>$/, "").trim();
  return raw === "" ? null : raw;
}

/**
 * The ceiling on an html part either reader will render at all — past it the message falls to
 * its text part with the oversize sentence. The webapp's `MAX_HTML_CHARS` is the same literal;
 * the parity test holds the two equal.
 */
export const MAIL_MAX_HTML_CHARS = 512 * 1024;

/** A 1×1 fully-transparent GIF. Stands in for every blocked image, including the beacon. */
export const BLANK_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * A url shaped like an open-tracking beacon. The common bulk-sender form —
 * `tracker.example.com/wf/open?u=…` — matches on `/wf/open`; the rest of the alternation is
 * the other spellings the same beacon is published under.
 */
export const BEACON_PATH =
  /(?:\/(?:wf\/open|open|track|tracking|beacon|pixel|imp|impression)(?:[/?#]|$)|\.(?:gif|png)\?)/i;

/** The host of a url, lowercased, or "" when it will not parse. */
export function mailHostOfUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** A CSS/HTML length that is 1 or 0 — `"1"`, `"1px"`, `"0"`. `null` when it is not a number. */
export function tinyDimension(v: string | null): boolean {
  if (v == null) return false;
  const n = Number(v.replace(/px$/i, "").trim());
  return Number.isFinite(n) && n <= 1;
}

/**
 * True when an `<img>` DECLARES itself invisible — the classic beacon shape. Takes an attribute
 * accessor rather than a DOM `Element`, so the phone's parse (which has no DOM) and the web's
 * post-pass ask the same question of different node shapes.
 */
export function declaresPixelAttrs(attr: (name: string) => string | null): boolean {
  if (tinyDimension(attr("width")) && tinyDimension(attr("height"))) return true;
  const style = attr("style") ?? "";
  const w = /(?:^|;)\s*width\s*:\s*([^;!]+)/i.exec(style);
  const h = /(?:^|;)\s*height\s*:\s*([^;!]+)/i.exec(style);
  return tinyDimension(w?.[1] ?? null) && tinyDimension(h?.[1] ?? null);
}

// ── CSS ────────────────────────────────────────────────────────────────────────────────

/**
 * What replaces a cut rule. Not the empty string: the pass has to be a fixed point, and
 * deleting `@import q;` from `@im@import q;port"https://…";` leaves an `@import` the pass has
 * already walked past (measured: the sheet was requested). `;` makes the arithmetic impossible
 * and is correct CSS in every position. The watched claim is idempotency.
 */
const CUT = ";";

/**
 * A character an identifier may continue with. `@import` is only `@import` when the at-rule
 * NAME ends there — `@imports` and `@import\75 rl` are different rules and must not be cut.
 * Non-ASCII is an ident character in CSS, hence the `\u0080-` range.
 */
function continuesIdent(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x2d || // -
    code === 0x5f || // _
    code === 0x5c || // \  an escape continues the identifier
    code >= 0x80
  );
}

/**
 * The three token starts this file understands, found in one forward scan. A token FINDER, not
 * a matcher: the regexp it replaced was quadratic on input with no `)` (measured 500 KB →
 * 95.3 s on the main thread). Every terminator is found with `indexOf` from a forward-only
 * position, so the pass is linear. An unterminated token ends the scan; the remainder is
 * copied verbatim — a token the browser will not parse either.
 */
const CSS_TOKEN = /@import|(?:-webkit-)?image-set\(|url\(|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n\r\f])/gi;

/**
 * The name of a function can be escaped too: `\75 rl(…)` is `url` to the CSS tokenizer. The
 * scan stops on an ESCAPE and reads the identifier it sits in, bounded by this cap (the
 * longest relevant name, `-webkit-image-set`, fully escaped is 136 chars) — an unbounded
 * identifier walk from every position is the quadratic the tokenizer exists to end.
 */
const ESCAPED_NAME_MAX = 160;

/** Is this the hex of a CSS escape? */
function isHexDigit(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/**
 * The identifier an escape at `at` belongs to, and where it ends. Nothing read here is ever
 * emitted, so a wrong reading can cost a picture and can never manufacture a url. The forward
 * walk consumes ESCAPE SEQUENCES, not merely identifier characters — the space in `\75 rl`
 * terminates the escape and belongs to it. Both directions are capped by
 * {@link ESCAPED_NAME_MAX}, so the walk is O(1) per backslash.
 */
function escapedIdentAt(css: string, at: number): { start: number; name: string; end: number } {
  let start = at;
  const back = Math.max(0, at - ESCAPED_NAME_MAX);
  while (start > back && continuesIdent(css.charCodeAt(start - 1))) start--;

  let i = at;
  const limit = Math.min(css.length, start + ESCAPED_NAME_MAX);
  while (i < limit) {
    const code = css.charCodeAt(i);
    if (code === 0x5c) {
      i++;
      let hex = 0;
      while (i < limit && hex < 6 && isHexDigit(css.charCodeAt(i))) {
        i++;
        hex++;
      }
      if (hex > 0) {
        // ONE optional whitespace terminates a hex escape and is part of it (CSS Syntax §4.3.7).
        const w = css.charCodeAt(i);
        if (w === 0x20 || w === 0x09 || w === 0x0a || w === 0x0d || w === 0x0c) i++;
      } else if (i < limit) {
        i++; // `\X` — one literal character
      }
      continue;
    }
    if (!continuesIdent(code)) break;
    i++;
  }
  return { start, name: css.slice(start, i), end: i };
}

/**
 * `\70` is `p`: `url(htt\70 s://evil.example/x)` is `https://` to the CSS tokenizer and is
 * fetched; it is not `https://` to a regexp reading the raw text. Decoding is used ONLY to
 * decide whether a token is remote — nothing decoded is ever emitted, so a decoding this gets
 * wrong can cost a picture and can never manufacture a url.
 */
function decodeCssEscapes(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g,
    (_m, hex: string | undefined, literal: string | undefined) => {
      if (hex === undefined) return literal ?? "";
      const cp = Number.parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff) return "\uFFFD";
      try {
        return String.fromCodePoint(cp);
      } catch {
        return "\uFFFD";
      }
    },
  );
}

/** A url this file emits into CSS, with the two characters that could leave the string gone. */
function cssString(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, "");
}

/**
 * The `)` that closes the `(` we just consumed, or -1. Quote-aware, single forward pass. A
 * COMMENT IS NOT SYNTAX: CSS strips comments before it parses, so a `)` inside one closes
 * nothing — reading it as the close truncated the token and kept a live, uncounted reference.
 */
function closingParen(css: string, from: number): number {
  let depth = 1;
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      if (close === -1) return -1; // runs to EOF, so the function never closes
      i = close + 1;
    } else if (c === '"' || c === "'") {
      const close = css.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Where an `@import` actually ends — the first `;` CSS would read as one. `indexOf(";")` was
 * not that: a semicolon inside the import's quoted URL is string data, and cutting there
 * MANUFACTURED a working `background:url(/api/x)` that had not existed in the message. Strings
 * and comments are skipped; an at-rule with no terminator runs to EOF (CSS Syntax §5.4.2).
 */
function endOfAtRule(css: string, from: number): number {
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      if (close === -1) return -1;
      i = close + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length) {
        const d = css[j];
        if (d === "\\") { j += 2; continue; }
        if (d === c || d === "\n" || d === "\r" || d === "\f") break;
        j++;
      }
      i = j;
    } else if (c === ";") return i;
  }
  return -1;
}

/** The body of a `url(` token and the index just past its `)`, or null when it never closes. */
function readUrlToken(css: string, from: number): { raw: string; end: number } | null {
  let i = from;
  while (i < css.length && css.charCodeAt(i) <= 0x20) i++;
  const quote = css[i];
  if (quote === '"' || quote === "'") {
    const close = css.indexOf(quote, i + 1);
    if (close === -1) return null;
    const paren = css.indexOf(")", close + 1);
    if (paren === -1) return null;
    return { raw: css.slice(i + 1, close), end: paren + 1 };
  }
  const paren = css.indexOf(")", i);
  if (paren === -1) return null;
  return { raw: css.slice(i, paren), end: paren + 1 };
}

/**
 * Walk a CSS value the way the tokenizer does — strings are strings, escapes are characters,
 * comments are nothing. Every `image-set` defect was a literal pattern asking a question CSS
 * reads differently (`/url\(/` missed `\75 rl(`; decoding the whole body first turned `\22`
 * payload into a delimiter; `/\bvar\(/` matched `var(` inside a quoted SVG payload). A walk
 * answers all of them because the distinctions are structural. Linear, no backtracking.
 */
interface CssValueScan {
  /** Every string literal and every `url()`/escaped-`url()` argument, decoded. */
  candidates: string[];
  /** Decoded names of the functions this value calls, at any depth. */
  functions: string[];
}

function scanCssValue(raw: string): CssValueScan {
  const candidates: string[] = [];
  const functions: string[] = [];
  /** Function names whose ARGUMENT is a MIME hint rather than a resource. */
  const HINT = new Set(["type", "format"]);
  let i = 0;
  let skipDepth = -1;
  let depth = 0;
  while (i < raw.length) {
    const c = raw[i]!;

    if (c === "/" && raw[i + 1] === "*") {
      const close = raw.indexOf("*/", i + 2);
      i = close === -1 ? raw.length : close + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      let body = "";
      while (j < raw.length) {
        const d = raw[j]!;
        if (d === "\\") {
          const nl = raw[j + 1];
          if (nl === "\n" || nl === "\f") { j += 2; continue; }
          if (nl === "\r") { j += raw[j + 2] === "\n" ? 3 : 2; continue; }
          body += raw.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (d === c || d === "\n" || d === "\r" || d === "\f") break;
        body += d;
        j++;
      }
      // Inside a MIME hint the string is a media type, never a resource.
      if (skipDepth === -1) candidates.push(decodeCssEscapes(body).trim());
      i = j < raw.length && raw[j] === c ? j + 1 : j;
      continue;
    }

    // A FUNCTION NAME — possibly written with escapes; an identifier start is the anchor.
    if (continuesIdent(raw.charCodeAt(i))) {
      const ident = escapedIdentAt(raw, i);
      const end = ident.start + ident.name.length;
      if (raw[end] === "(") {
        const name = decodeCssEscapes(ident.name).trim().toLowerCase();
        functions.push(name);
        depth++;
        if (HINT.has(name) && skipDepth === -1) skipDepth = depth;
        if (name === "url" || name === "-webkit-url") {
          // An UNQUOTED url argument runs to the `)`; a quoted one takes the string arm above.
          let j = end + 1;
          while (j < raw.length && raw.charCodeAt(j) <= 0x20) j++;
          if (raw[j] !== '"' && raw[j] !== "'") {
            const close = raw.indexOf(")", j);
            const stop = close === -1 ? raw.length : close;
            if (skipDepth === -1) candidates.push(decodeCssEscapes(raw.slice(j, stop)).trim());
            i = stop;
            continue;
          }
        }
        i = end + 1;
        continue;
      }
      i = Math.max(end, i + 1);
      continue;
    }

    if (c === "(") { depth++; i++; continue; }
    if (c === ")") {
      if (skipDepth !== -1 && depth === skipDepth) skipDepth = -1;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return { candidates: candidates.filter((u) => u.length > 0), functions };
}

/**
 * Every url a token's body names, in any of the spellings that fetch: a `url()`, or a bare
 * string — which is how `image-set("https://…" 1x)` and `@import"https://…";` name one.
 */
function urlsIn(inner: string): string[] {
  return scanCssValue(inner).candidates;
}

/**
 * Does this token body name something not substituted until after we have decided? `var()`
 * resolves at computed-value time, so `image-set(var(--x) 1x)` presents an EMPTY candidate
 * list — `[].every(inert)` is true — and would be kept while `--x: "/api/…"` survives on its
 * own; the pair fetches. A construct this scanner cannot normalise is dropped, not passed.
 */
function defersSubstitution(inner: string): boolean {
  return scanCssValue(inner).functions.includes("var");
}

/** The subset of {@link urlsIn} that names a REMOTE host — what the blocked list counts. */
function remoteUrlsIn(inner: string): string[] {
  return urlsIn(inner).filter((u) => REMOTE_URL.test(u));
}

/**
 * Take everything out of a stylesheet that names a network resource: `@import` outright (via
 * `onSheet` — no consent story exists for a sender's stylesheet), and every remote `url(…)`
 * through `onRemote` (return a substitute source, or null ⇒ `none`). Not the enforcement — the
 * frame's `default-src 'none'` holds for shapes this scanner does not know. This exists so the
 * reader is not shown a broken box, so the bar can COUNT what the mail tried, and so a
 * consented image can point at a substitute. `image-set()` collapses to `none` unless every
 * candidate is inert; a deferred `var()` substitution drops the set too.
 */
export function neutraliseCss(
  css: string,
  onRemote: (url: string) => string | null,
  onSheet: (url: string) => void = () => {},
): string {
  if (css.length === 0) return css;
  let out = "";
  let copied = 0;

  /**
   * Is this position inside a CSS string? — carried forward, never recomputed. Only the escape
   * branch asks: `content:"\\75 rl(/api/x)"` is a STRING whose visible text names no resource.
   * The three LITERAL branches keep their behaviour, quoted or not: they are what the
   * mutation-XSS guards are written against. The cursor only moves forward; the pass is linear.
   */
  let quote: '"' | "'" | null = null;
  let inComment = false;
  let quoteAt = 0;
  const advanceQuote = (to: number): void => {
    for (let i = quoteAt; i < to; i++) {
      const c = css[i];
      if (inComment) {
        if (c === "*" && css[i + 1] === "/") { inComment = false; i++; }
        continue;
      }
      if (quote !== null) {
        // An escape inside a string consumes the next character, so a `\"` does not close it.
        if (c === "\\") { i++; continue; }
        // A raw newline ends an unterminated string (CSS Syntax §4.3.5); the browser does the same.
        if (c === quote || c === "\n" || c === "\r" || c === "\f") quote = null;
      } else if (c === "/" && css[i + 1] === "*") {
        // A COMMENT IS NOT A STRING: `/* " */` read as a string left an unmatched quote open and
        // one character of sender-authored comment disabled the whole rule for the rest of the file.
        inComment = true;
        i++;
      } else if (c === "\\") {
        // An escape OUTSIDE a string consumes its next character too — `\"` in an ordinary
        // declaration is a legal escaped quote, not a string opener.
        i++;
      } else if (c === '"' || c === "'") {
        quote = c;
      }
    }
    quoteAt = Math.max(quoteAt, to);
  };

  CSS_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSS_TOKEN.exec(css)) !== null) {
    let start = m.index;
    let end: number;
    let replacement: string;
    /** What this token IS, once an escaped name has been decoded. */
    let kind: "import" | "image-set" | "url";

    if (m[0][0] === "\\") {
      // AN ESCAPE — almost always inside a string and none of our business; occasionally a
      // character of a FUNCTION NAME written to hide it from the three literal alternatives.
      advanceQuote(start);
      // Inside a string it is TEXT. See {@link advanceQuote}.
      if (quote !== null) continue;
      const ident = escapedIdentAt(css, start);
      const decoded = decodeCssEscapes(ident.name).toLowerCase();
      // A FUNCTION token is the identifier IMMEDIATELY followed by `(` — CSS Syntax §4.3.4
      // admits no whitespace there; `\75 rl (x)` fetches nothing.
      const isFunction = css[ident.end] === "(";
      // An at-rule name is not followed by `(` at all; the `@` before it is what names it.
      const atRule = !isFunction && ident.start > 0 && css[ident.start - 1] === "@";
      if (atRule && decoded === "import") {
        start = ident.start - 1;
        kind = "import";
        CSS_TOKEN.lastIndex = ident.end;
      } else if (isFunction && (decoded === "image-set" || decoded === "-webkit-image-set")) {
        start = ident.start;
        kind = "image-set";
        CSS_TOKEN.lastIndex = ident.end + 1;
      } else if (isFunction && decoded === "url") {
        start = ident.start;
        kind = "url";
        CSS_TOKEN.lastIndex = ident.end + 1;
      } else {
        continue;
      }
    } else if (m[0][0] === "@") {
      kind = "import";
    } else if (m[0].endsWith("image-set(")) {
      kind = "image-set";
    } else {
      kind = "url";
    }

    if (kind === "import") {
      // `@import`, and only when the at-rule NAME ends here. An unterminated prelude runs to
      // the end of the sheet — the same span the browser would have consumed.
      if (continuesIdent(css.charCodeAt(CSS_TOKEN.lastIndex))) continue;
      const semi = endOfAtRule(css, CSS_TOKEN.lastIndex);
      end = semi === -1 ? css.length : semi + 1;
      for (const url of remoteUrlsIn(css.slice(CSS_TOKEN.lastIndex, end))) onSheet(url);
      replacement = CUT;
    } else if (kind === "image-set") {
      // AN UNCLOSED FUNCTION IS STILL A REFERENCE: CSS closes a url token at EOF and returns
      // it, so "copy the remainder verbatim" would leave a live, uncounted remote url behind.
      const close = closingParen(css, CSS_TOKEN.lastIndex);
      end = close === -1 ? css.length : close + 1;
      const inner = css.slice(CSS_TOKEN.lastIndex, end);
      const remote = remoteUrlsIn(inner);
      for (const url of remote) onRemote(url); // counted even though the whole set is dropped
      // The whole set goes unless EVERY candidate is inert — a set is one declaration and
      // there is no partial answer; a deferred substitution is a set we have not read.
      const allInert = urlsIn(inner).every((u) => INERT_CSS_URL.test(u));
      replacement = remote.length > 0 || close === -1 || !allInert || defersSubstitution(inner)
        ? "none"
        : css.slice(start, end);
    } else {
      const token = readUrlToken(css, CSS_TOKEN.lastIndex);
      end = token === null ? css.length : token.end;
      const raw = token === null ? css.slice(CSS_TOKEN.lastIndex) : token.raw;
      const url = decodeCssEscapes(raw).trim();
      if (REMOTE_URL.test(url)) {
        const proxied = onRemote(url);
        replacement = proxied === null ? "none" : `url("${cssString(proxied)}")`;
      } else if (token === null) {
        replacement = "none"; // unterminated: the browser reads it to EOF, so so do we
      } else if (INERT_CSS_URL.test(url)) {
        // `data:` and `cid:` stay, verbatim. Nothing is fetched by them.
        replacement = css.slice(start, end);
      } else {
        // NOT remote, NOT inert — a relative or protocol-relative reference, which the frame
        // resolves against the embedder and can therefore fetch. Not counted through
        // `onRemote`: the blocked list names hosts the SENDER asked for, and this names none.
        replacement = "none";
      }
    }

    out += css.slice(copied, start) + replacement;
    copied = end;
    // Keep the quote cursor with the scan: the state is about the ORIGINAL text, which is
    // where every subsequent match is found.
    advanceQuote(end);
    CSS_TOKEN.lastIndex = end;
  }
  return copied === 0 ? css : out + css.slice(copied);
}
