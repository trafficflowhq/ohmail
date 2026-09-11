"use client";

/**
 * The mail renderer: the html part, sanitized, in a frame that cannot phone home. Two jobs:
 * DOMPurify decides what the document SAYS (no script, handler, form, frame, `javascript:`,
 * `<base>`, `<meta refresh>`, remote reference); the sandboxed `<iframe srcdoc>` with its own
 * CSP decides what the browser MAY DO — never allow-scripts/forms/top-navigation
 * (`allow-same-origin` is safe only without scripts). Remote content is not requested: every
 * remote reference is removed pre-build, `default-src 'none'` covers the rest. Text rewrites
 * only BEFORE the sanitizer; images ride `GET /img` only; `cid:` images are this message's own
 * bytes.
 */

import DOMPurify from "dompurify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalTheme } from "@ohmail/ui";
import {
  anchorFor,
  BodyText,
  isAttribution,
  MAX_QUOTE_DEPTH,
  type BodyNode,
  type InlineNode,
  type QuoteNode,
  type RichParagraphNode,
  type TableCellNode,
  type TableRowNode,
} from "../shell/BodyText";
import { UI_KEYS, usePersistedIdSet } from "../shell/persisted-ui";
import { interceptLinkClicks } from "../shell/open-external";
import "./message-body.css";
import { liveCopy } from "../shell/locale";
import { CAPTION_KEY, type BlockNotice, type NoticeKind } from "./BlockNotice";

/**
 * The English sentences — the FALLBACK, not the source: every string comes
 * from the `mailBody` namespace of `messages/<locale>.json`, and `COPY` is
 * the resolved view. Not the intl hook: this component renders BARE (no
 * provider) in a dozen unit tests, three of which import `COPY` to assert
 * on-screen text, and `useTranslations` throws without a provider. It stays
 * a table and stays the parity oracle: `test/locale-shim-parity.test.ts`
 * holds it against `en.json` key for key and text for text — deleting it
 * deletes the check.
 */
const EN = {
  blockedOne: "1 remote image blocked.",
  blockedMany: (n: number) => `${n} remote images blocked.`,
  pixelOne: "One of them is a tracking pixel.",
  pixelMany: (n: number) => `${n} of them are tracking pixels.`,
  pixelOnly: "A tracking pixel was blocked.",
  /**
   * SAID UNDER THE LOADED MODES, where the pictures are on screen and the beacons alone were
   * refused — the "images by default" world has no "N remote images blocked" sentence to hang
   * "one of them" off, so the refusal is stated whole. The singular reuses {@link pixelOnly}.
   */
  pixelsRefusedMany: (n: number) => `${n} tracking pixels were blocked.`,
  /**
   * THE CAPTIONS — what the reading stream's card head CALLS each of the three notices when it
   * carries the disclosure as a glyph instead of a bar (`BlockNotice`). Two words in the meta
   * line's voice, never a shortened sentence and never a colour that reads as an error; the whole
   * sentence above is the glyph's description and opens on hover, focus or a press. Which caption
   * a message gets is `NOTICE_CAPTION` in `BlockNotice.tsx`, and `test/tracking-notice.test.tsx`
   * holds every notice sentence in this table against that mapping and both catalogues.
   */
  pixelCaption: "Tracker blocked",
  imagesCaption: "Images blocked",
  sheetCaption: "Stylesheet blocked",
  show: "Show images",
  /** The dark-viewer toggle. Shown only in a dark theme; flips THIS message between the
   *  adapted (dark) rendering and its original light one, and the choice is remembered. */
  darkOriginal: "Original",
  darkAdapt: "Adapt to dark",
  darkOriginalTitle: "Show this message in its original colours",
  darkAdaptTitle: "Adapt this message to the dark theme",
  /**
   * THE WAY BACK TO THE SENDER'S OWN RENDERING: Mail that declares no canvas is set in the app's type over the
   * message's TEXT part, which draws no pictures at all. For most mail that is the better rendering and nothing is
   * lost — but "nothing is lost" is a claim about the AVERAGE message, and this control is what makes it safe to be
   * wrong about a particular one. A photograph a sender embedded, a table whose columns carry the meaning, a receipt
   * whose layout IS the information: one press and the message is drawn exactly as it was sent, in the frame, with
   * the sandbox and the image blocking unchanged. It replaces an earlier attempt that tried to be clever — messages
   * whose remote pictures the reader had consented to were kept in the frame automatically.
   */

  /**
   * That reverted the whole default on any account where remote images load by default, because consent is then true
   * from the first paint: measured on a live account, every message in a four-message thread came back framed. A
   * DECISION THE READER MAKES cannot be inferred from a setting they made once about something else.
   */
  design: "Show original",
  designTitle: "Show this message with the sender's own formatting",
  plain: "Show as text",
  plainTitle: "Show this message as text, in the app's own type",
  frameTitle: "Message content",
  unsupported: "Showing the plain-text version of this message.",
  /**
   * SAID AFTER the image sentence, never before it. The browser-level test of the blocking
   * bar reads the FIRST number in it and holds that against the number of remote images the
   * message names, so a stylesheet count in front would make the check measure the wrong
   * thing.
   */
  sheetOne: "A remote stylesheet was blocked, so this message may look plain.",
  sheetMany: (n: number) =>
    `${n} remote stylesheets were blocked, so this message may look plain.`,
  /** The size fallback. It states the reason, because a bare plain-text render reads as a bug. */
  oversize: "This message's HTML part is too large to render safely. Showing the plain-text version.",
};

/**
 * THE SAME TABLE, RESOLVED AGAINST THE ACTIVE CATALOGUE — read by every call site in this file.
 *
 * `EN` is the fallback and the parity oracle; this is what renders. See `liveCopy` in
 * `app/shell/locale.ts` for why the members are getters, and the note on `EN` for why the read is
 * not `useTranslations`.
 */
export const COPY: typeof EN = liveCopy("mailBody", EN, {
  blockedMany: ["count"], pixelMany: ["count"], pixelsRefusedMany: ["count"], sheetMany: ["n"],
});


// ── the allow-lists ────────────────────────────────────────────────────────────────────

/**
 * The tags a mail may use. An allow-list, so a tag nobody has thought about is absent by default. `style` is the
 * interesting one — a stylesheet that cannot leave its document is what makes a newsletter look like a newsletter;
 * its TEXT is still rewritten ({@link neutraliseCss}) so it cannot name a remote url — BEFORE this list is applied,
 * never after: the mutation-XSS rule stated on {@link sanitizeMailHtml}. Everything a mail client's bug reports are
 * made of is absent by omission: `script`, `iframe`, `form`, `object`, `embed`, `base`, `link`, `meta`, `svg`, `math`
 * and the rest. A `FORBID_TAGS` list stood here and was deleted because it could not be watched: emptying it left the
 * suite GREEN — an allow-list already refuses everything it does not name, so the pair read as belt-and-braces and
 * behaved as neither.
 */

/**
 * One list, one deletion point: `test/message-body.test.ts` mutates by ADDING `iframe`, `form` and `object` to this
 * array, and that goes red.
 */
const ALLOWED_TAGS = [
  "a", "abbr", "acronym", "address", "area", "article", "aside", "b", "bdi", "bdo", "big",
  "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "data", "dd",
  "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd",
  "label", "legend", "li", "main", "map", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u",
  "ul", "var", "wbr",
];

/**
 * The four attributes whose value NAMES A RESOURCE. Kept apart from the rest because
 * DOMPurify's URI check applies to every attribute it is not told to exempt — see
 * {@link PRESENTATION_ATTR}.
 */
const URL_ATTR = ["href", "src", "srcset", "background"];

/**
 * The presentational vocabulary bulk mail is actually written in. No `on*` in it. THESE MUST BE DECLARED URI-SAFE,
 * AND FINDING THAT OUT COST AN EXPERIMENT: DOMPurify runs `ALLOWED_URI_REGEXP` against the value of EVERY attribute
 * except the ones in its `URI_SAFE_ATTRIBUTES` set (`alt`, `class`, `id`, `style`, `title`, `role`, …). With {@link
 * SAFE_HREF} as that regexp — which is strict, and deliberately so — `width="100%"`, `align="center"`,
 * `bgcolor="#fff"` and `cellpadding="0"` all FAIL it and are stripped. Measured against dompurify 3.4.13: `<table
 * width="100%" align="center" cellpadding="0">` came back as `<table>`, and every fixed-width mail collapsed to a
 * single unstyled column while every security assertion stayed green.
 */

/**
 * That is the failure shape this repo keeps naming — a change that is correct about safety and silently wrong about
 * the product — so it is written down here rather than left as a list somebody has to re-derive.
 */
const PRESENTATION_ATTR = [
  "alt", "title", "width", "height", "align", "valign", "border", "cellpadding",
  "cellspacing", "bgcolor", "style", "class", "id", "colspan", "rowspan", "dir", "lang",
  "type", "start", "value", "size", "color", "face", "abbr", "headers", "scope", "span",
  "role", "aria-label", "aria-hidden", "datetime",
];

const ALLOWED_ATTR = [...URL_ATTR, ...PRESENTATION_ATTR];

/**
 * THE URI GATE — ONE CONSTANT, ENFORCED TWICE, DELETABLE IN ONE PLACE. It is handed to DOMPurify as
 * `ALLOWED_URI_REGEXP` (which strips a failing `href` before this file ever sees the node) AND read again in the hook
 * (which is what decides that a link with no usable href becomes visible-but-inert rather than silently unclickable).
 * That is deliberately NOT two guards. `BodyText`'s header states the rule this follows: "two overlapping guards read
 * as belt-and-braces and behave as neither — deleting one leaves the test green, so neither one is ever proven to do
 * anything". Here there is one value. Widen it to `/./` and BOTH enforcement points open at once, which is exactly
 * the mutation `test/message-body.test.ts` performs to prove the gate is load-bearing. `cid:` is admitted because it
 * names a part of this very message and cannot leave the machine.
 */

/**
 * `data:` is NOT: a `data:text/html` href navigates to attacker markup, and every legitimate use of `data:` in mail
 * is an image, which is a `src` and handled as one.
 */
const SAFE_HREF = /^(?:https?:|mailto:|tel:|cid:)/i;

/** A scheme that fetches over the network. What "remote" means everywhere in this file. */
const REMOTE_URL = /^https?:\/\//i;

/** An `<img src>` naming a part of this very message. Resolved from the message's own bytes. */
const CID_URL = /^cid:/i;

/**
 * The only url schemes a stylesheet may name, and it is a POSITIVE list on purpose. {@link SAFE_HREF} is the positive
 * list DOMPurify applies to `href`/`src`/`background`; the CSS path gets neither check — `style` is in DOMPurify's
 * own `URI_SAFE_ATTRIBUTES` and a `<style>` element is TEXT — so the only url policy there is {@link neutraliseCss}.
 * Its final branch asked "is this remote?" and kept everything else verbatim, a different question from the one its
 * comment answered: a RELATIVE url is not `https?://` and is not inert either.
 */

/**
 * What that admitted once the reader loads images: a srcdoc document has no `<base>`, so it resolves against the
 * EMBEDDER — `url(/api/…)` became a cookie-bearing `https://ohmail.app/api/…` GET (the sandbox keeps
 * `allow-same-origin`), `url(//host/x)` a remote fetch past both the proxy and the counter — unbounded,
 * authenticated, and absent from the blocked list the reader sees.
 */

/**
 * That ending is now closed at the policy as well: `img-src` names the proxy's own path rather
 * than `'self'` ({@link proxyImgSource}), so the same payload against a reverted version of
 * this branch fetches nothing. This branch still keeps the COUNT honest, which the policy
 * cannot — a refusal the reader is never told about is a blocked-content bar saying zero while
 * the browser refuses five. So the question is now "is this inert?": `data:` carries its own
 * bytes and `cid:` names a part of this very message; both fetch nothing. Everything else —
 * relative, protocol-relative, a fragment, an unknown scheme — becomes `none`, and the
 * counter-case in `test/message-body.test.ts` stops this degenerating into "delete every url".
 */
const INERT_CSS_URL = /^(?:data:|cid:)/i;

/**
 * The only shape a resolved embedded image may take: a base64 `data:` URI
 * of one of the four raster types (`INLINE_IMAGE_MIME`). Enforced HERE, at
 * the write into the document, not only at the mint: the map arrives
 * through a prop, and "the engine is the only caller" is a fact about
 * today's wiring, not a property of this function. A value of any other
 * shape — `javascript:`, `data:text/html`, `data:image/svg+xml`, non-base64
 * characters — reads as absent and the image stays blanked;
 * `test/message-body.test.ts` hands this a hostile map and watches.
 */
const INLINE_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The Content-ID an `<img src="cid:…">` names — brackets and the scheme stripped — or null. */
function cidOfSrc(src: string): string | null {
  const raw = src.slice(4).replace(/^</, "").replace(/>$/, "").trim();
  return raw === "" ? null : raw;
}

/** A 1×1 fully-transparent GIF. Stands in for every blocked image, including the beacon. */
const BLANK_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// ── what was blocked ───────────────────────────────────────────────────────────────────

export interface BlockedAsset {
  /** The url the sender asked us to fetch. Never fetched; carried so consent can. */
  url: string;
  /** Its host, lowercased — what a reader is shown, and "" if it does not parse. */
  host: string;
  /** Where it was named: an image, a CSS `url()`, or an element's `background` attribute. */
  via: "img" | "css" | "attr";
  /**
   * A beacon rather than a picture. Decided from TWO signals that are in the message itself
   * — declared 1×1/0×0 dimensions, and a beacon-shaped path — and deliberately NOT from a
   * host list. the server's tracker-blocker keeps such a list, it is not
   * importable here (`@trafficflow/core` is a node package: mailparser, `node:crypto`), and
   * a second copy of it would drift. Nothing is blocked BECAUSE of this flag — everything
   * remote is blocked either way — so the only thing it can be wrong about is a sentence.
   */
  pixel: boolean;
}

/**
 * A url shaped like an open-tracking beacon. The common bulk-sender form —
 * `tracker.example.com/wf/open?u=…` — matches on `/wf/open`; the rest of the alternation is
 * the other spellings the same beacon is published under.
 */
const BEACON_PATH =
  /(?:\/(?:wf\/open|open|track|tracking|beacon|pixel|imp|impression)(?:[/?#]|$)|\.(?:gif|png)\?)/i;

/** The host of a url, lowercased, or "" when it will not parse. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** A CSS/HTML length that is 1 or 0 — `"1"`, `"1px"`, `"0"`. `null` when it is not a number. */
function tinyDimension(v: string | null): boolean {
  if (v == null) return false;
  const n = Number(v.replace(/px$/i, "").trim());
  return Number.isFinite(n) && n <= 1;
}

/** True when an `<img>` DECLARES itself invisible — the classic beacon shape. */
function declaresPixel(el: Element): boolean {
  if (tinyDimension(el.getAttribute("width")) && tinyDimension(el.getAttribute("height"))) return true;
  const style = el.getAttribute("style") ?? "";
  const w = /(?:^|;)\s*width\s*:\s*([^;!]+)/i.exec(style);
  const h = /(?:^|;)\s*height\s*:\s*([^;!]+)/i.exec(style);
  return tinyDimension(w?.[1] ?? null) && tinyDimension(h?.[1] ?? null);
}

// ── CSS ────────────────────────────────────────────────────────────────────────────────

/**
 * What replaces a cut rule, and why it is not the empty string: one pass over a stylesheet has
 * to be a fixed point, and an empty replacement is what stops it being one — deleting `@import
 * q;` from `@im@import q;port"https://…";` leaves an `@import` the pass has already walked past
 * (measured: the sheet was requested). `;` makes the arithmetic impossible and is correct CSS
 * in every position. A claim about CSS tokens, not markup — the sanitizer re-parses this text
 * afterwards. The watched claim is idempotency: `neutraliseCss(neutraliseCss(x)) ===
 * neutraliseCss(x)`; `test/message-body-mutation-xss.test.ts` mutates this constant to `""` to
 * prove it.
 */
const CUT = ";";

/**
 * A character an identifier may continue with. `@import` is only `@import` when the at-rule
 * NAME ends there — `@imports` and `@import\75 rl` are different rules and must not be cut.
 * Non-ASCII is an ident character in CSS, hence the `\u0080-` range rather than `[a-z0-9_-]`.
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
 * a matcher: the regexp it replaced (`/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi`) was quadratic on
 * input with no `)` — measured 125 KB → 6.1 s, 500 KB → 95.3 s, synchronously inside `useMemo`
 * on the main thread, and a 500 KB marketing email is ordinary. This pattern has no
 * backtracking quantifier; every terminator is found with `indexOf` from a forward-only
 * position, so the pass is linear. An unterminated token ends the scan; the remainder is copied
 * verbatim — a token the browser will not parse either.
 */
const CSS_TOKEN = /@import|(?:-webkit-)?image-set\(|url\(|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n\r\f])/gi;

/**
 * The name of a function can be escaped too — for a while only the argument was. `\75 rl(…)` and
 * `\69 mage-set("…")` are `url` and `image-set` to the CSS tokenizer, and a relative `\75
 * rl(/api/…)` in a srcdoc document (no `<base>`) resolves against the embedder — an authenticated
 * same-origin GET the old `img-src data: 'self'` permitted ({@link proxyImgSource} narrowed that).
 * So the scan also stops on an ESCAPE and reads the identifier it sits in — anchored on the
 * backslash and bounded by {@link ESCAPED_NAME_MAX} (the longest relevant name,
 * `-webkit-image-set`, fully escaped is 136 chars), because an unbounded identifier walk from every
 * position is the quadratic this tokenizer exists to end.
 */
const ESCAPED_NAME_MAX = 160;

/** Is this the hex of a CSS escape? */
function isHexDigit(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/**
 * The identifier an escape at `at` belongs to, and where it ends. `name` is
 * the raw text; the caller decodes it. Nothing read here is ever emitted,
 * so a wrong reading can cost a picture and can never manufacture a url
 * ({@link decodeCssEscapes}'s rule). The forward walk consumes ESCAPE
 * SEQUENCES, not merely identifier characters — the space in `\75 rl`
 * terminates the escape and belongs to it, so a naive walk read the name
 * as `\75` and concluded it was not a function. Both directions are capped
 * by {@link ESCAPED_NAME_MAX}, so the walk is O(1) per backslash.
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
 * `\70` is `p`. `url(htt\70 s://evil.example/x)` is `https://` to the CSS tokenizer and is
 * fetched; it is not `https://` to a regexp reading the raw text, which is how that shape
 * reached the network and was still counted as zero blocked.
 *
 * Decoding is used ONLY to decide whether a token is remote. Nothing decoded is ever emitted,
 * so a decoding this gets wrong can cost a picture and can never manufacture a url.
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

/** The `)` that closes the `(` we just consumed, or -1. Quote-aware, single forward pass. */
function closingParen(css: string, from: number): number {
  let depth = 1;
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    // A COMMENT IS NOT SYNTAX. CSS strips comments before it parses, so a `)` inside one closes
    // nothing — and reading it as the close truncated the token here: `image-set(/* ) */ "/api/x")`
    // ended at the comment, the body scanned was an unterminated comment with no candidates, the
    // vacuous `every(inert)` kept the prefix, and the real bare-string candidate sat in the text
    // the scan resumed into, where no token start matches a bare string. A live reference, kept
    // and uncounted, from one comment.
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
 * Where an `@import` actually ends — the first `;` CSS would read as one.
 * `indexOf(";")` was not that: a semicolon inside the import's quoted URL
 * is string data, and cutting there removed the opening quote and left the
 * remainder as live CSS — the rewrite MANUFACTURED a working
 * `background:url(/api/x)` that had not existed in the message, and broke
 * idempotency (a second pass removed what the first created). Strings and
 * comments are skipped by the same rules as everywhere else; an at-rule
 * with no terminator runs to EOF (CSS Syntax §5.4.2).
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
 * reads differently: `/url\(/` missed `\75 rl(` (a live reference, uncounted); `/\btype\(/`
 * missed `\74 ype(` (a valid image deleted); decoding the whole body first turned `\22` payload
 * into a delimiter (another valid image deleted); `/\bvar\(/` missed `v\61 r(` and matched
 * `var(` inside a quoted SVG payload. A walk answers all four because the distinctions are
 * structural; decoding happens per token, on text known to be a name or a value. Linear: one
 * forward pass, no backtracking.
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

    // A comment is nothing at all — not a string, not a name. `/* " */` used to set quote state.
    if (c === "/" && raw[i + 1] === "*") {
      const close = raw.indexOf("*/", i + 2);
      i = close === -1 ? raw.length : close + 2;
      continue;
    }

    // A STRING. Its escapes are characters in the value, so it is read raw here and decoded whole.
    if (c === '"' || c === "'") {
      let j = i + 1;
      let body = "";
      while (j < raw.length) {
        const d = raw[j]!;
        if (d === "\\") {
          // A BACKSLASH-NEWLINE IS A LINE CONTINUATION, not two characters of the value: CSS
          // removes it (Syntax §4.3.5), so a `data:` URI a formatter wrapped across two lines is
          // one candidate. Keeping the pair made it fail the `data:` test and deleted the image.
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

    // A FUNCTION NAME — possibly written with escapes. `escapedIdentAt` reads one from any
    // position inside it, and an identifier start is the cheapest anchor.
    if (continuesIdent(raw.charCodeAt(i))) {
      const ident = escapedIdentAt(raw, i);
      const end = ident.start + ident.name.length;
      if (raw[end] === "(") {
        const name = decodeCssEscapes(ident.name).trim().toLowerCase();
        functions.push(name);
        depth++;
        if (HINT.has(name) && skipDepth === -1) skipDepth = depth;
        if (name === "url" || name === "-webkit-url") {
          // An UNQUOTED url argument runs to the `)`; a quoted one is handled by the string arm
          // on the next iteration.
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
 * Every REMOTE url a token's body names, in any of the spellings that fetch: a `url()`, or a
 * bare string — which is how `image-set("https://…" 1x)` and `@import"https://…";` name one.
 */
function urlsIn(inner: string): string[] {
  return scanCssValue(inner).candidates;
}

/**
 * Does this token body name something not substituted until after we have decided? `var()`
 * resolves at computed-value time, so `image-set(var(--x) 1x)` presented an EMPTY candidate
 * list — `[].every(inert)` is true — and was kept verbatim while `--x: "/api/…"` survived on
 * its own; the pair fetched. A construct this scanner cannot normalise is dropped rather than
 * passed — the unterminated-token rule, applied to a value that arrives later. Asked of the
 * WALK, not the raw text: `v\61 r(` is a substitution a literal test missed, and `var(` inside
 * a quoted SVG data URL is payload a literal test deleted a legitimate image for.
 */
function defersSubstitution(inner: string): boolean {
  return scanCssValue(inner).functions.includes("var");
}

/** The subset of {@link urlsIn} that names a REMOTE host — what the reader's blocked list counts. */
function remoteUrlsIn(inner: string): string[] {
  return urlsIn(inner).filter((u) => REMOTE_URL.test(u));
}

/**
 * Take everything out of a stylesheet that names a network resource: `@import` outright, and every remote `url(…)` through
 * `onRemote`. Not the enforcement — the frame's `default-src 'none'` is what makes a remote url unfetchable, and it holds for
 * shapes this scanner does not know. This exists so the reader is not shown a broken box, so the bar can COUNT what the mail
 * tried, and so a consented background can point at the proxy. Three shapes it used to miss (`@import"…"`, `url(htt\70
 * s://…)`, `image-set("…" 1x)`) were each requested and refused by the CSP alone — the accounting said a thing had not
 * happened. `image-set()` collapses to `none`; `@import` is cut whole and reports through `onSheet`, not `onRemote` — no
 * consent story exists for a sender's stylesheet, and an unconsentable entry in `blocked` would make "Show images" lie. It is
 * still said ({@link COPY.sheetOne}): blocking silently is its own defect.
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
   * branch asks: `content:"\\75 rl(/api/x)"` is a STRING whose visible text is `url(/api/x)` —
   * it names no resource, and the escape-aware branch, having no notion of quoting, rewrote a
   * piece of the sender's visible text into `none`. The three LITERAL branches deliberately
   * keep their behaviour, quoted or not: they are what the mutation-XSS guards are written
   * against, and narrowing them would be a security change smuggled behind a false-positive
   * fix. The cursor only moves forward; the pass stays linear.
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
        // A COMMENT IS NOT A STRING, and reading one as a string was a bypass rather than a
        // nuisance: `/* " */` left an unmatched quote open, so every escaped `url()` after it in
        // the sheet looked quoted to the branch below and was passed through untouched. One
        // character of sender-authored comment disabled the whole rule for the rest of the file.
        inComment = true;
        i++;
      } else if (c === "\\") {
        // AN ESCAPE OUTSIDE A STRING CONSUMES ITS NEXT CHARACTER TOO. Without this, `\"` in an
        // ordinary declaration — a legal escaped quote in an identifier or a value — opened a
        // string that nothing closed, and every escaped function name after it in the rule was
        // treated as quoted text and left alone. The same one-character disable as the comment
        // case above, reached a different way.
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
      // AN ESCAPE. Almost always inside a string and none of our business; occasionally it is a
      // character of a FUNCTION NAME written to hide it from the three literal alternatives —
      // `\75 rl(…)`, `\69 mage-set(…)`, `@\69 mport …`. See {@link escapedIdentAt}.
      advanceQuote(start);
      // Inside a string it is TEXT. See {@link advanceQuote}.
      if (quote !== null) continue;
      const ident = escapedIdentAt(css, start);
      const decoded = decodeCssEscapes(ident.name).toLowerCase();
      // A FUNCTION token is the identifier IMMEDIATELY followed by `(` — CSS Syntax §4.3.4 admits
      // no whitespace there, and neither does this: `\75 rl (x)` is an ident beside a
      // parenthesized group, it fetches nothing, and treating it as a url would be a false
      // positive in a sanitizer.
      const isFunction = css[ident.end] === "(";
      // An AT-RULE name is not followed by `(` at all; the `@` before it is what names it.
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
      // the end of the sheet — CSS Syntax §5.4.2 ends an at-rule at EOF — so cutting to EOS is
      // not a shortcut, it is the same span the browser would have consumed.
      if (continuesIdent(css.charCodeAt(CSS_TOKEN.lastIndex))) continue;
      const semi = endOfAtRule(css, CSS_TOKEN.lastIndex);
      end = semi === -1 ? css.length : semi + 1;
      for (const url of remoteUrlsIn(css.slice(CSS_TOKEN.lastIndex, end))) onSheet(url);
      replacement = CUT;
    } else if (kind === "image-set") {
      // AN UNCLOSED FUNCTION IS STILL A REFERENCE. CSS Syntax §4.3.6 closes a `url` token at
      // EOF and returns it, so "copy the remainder verbatim and stop" would leave a live,
      // uncounted remote url behind — the DoS-safe answer and the leak-unsafe one. Everything
      // from the token to the end goes.
      const close = closingParen(css, CSS_TOKEN.lastIndex);
      end = close === -1 ? css.length : close + 1;
      const inner = css.slice(CSS_TOKEN.lastIndex, end);
      const remote = remoteUrlsIn(inner);
      for (const url of remote) onRemote(url); // counted even though the whole set is dropped
      // THE SAME NARROWING AS THE `url()` BRANCH BELOW, for the same reason: a set whose
      // candidates are relative is not a set with no urls in it. The whole set goes unless
      // EVERY candidate is inert — a set is one declaration and there is no partial answer.
      const allInert = urlsIn(inner).every((u) => INERT_CSS_URL.test(u));
      // AND a set whose candidate arrives by substitution is a set we have not read. See
      // {@link defersSubstitution}: `image-set(var(--x) 1x)` presents no candidates at all, so
      // the inert test above passes vacuously and the set was kept.
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
        // resolves against the embedder and can therefore fetch. See {@link INERT_CSS_URL}.
        // Not counted through `onRemote`: the reader's blocked list names hosts the SENDER
        // asked for, and this url names none — showing them `/api/messages/…` would be a
        // sentence about our own origin, not about the message.
        replacement = "none";
      }
    }

    out += css.slice(copied, start) + replacement;
    copied = end;
    // Keep the quote cursor with the scan: the state is about the ORIGINAL text, which is where
    // every subsequent match is found.
    advanceQuote(end);
    CSS_TOKEN.lastIndex = end;
  }
  return copied === 0 ? css : out + css.slice(copied);
}

/**
 * Rewrite remote `url()` in ONE element's inline `style` by the same rule.
 *
 * This one runs AFTER the sanitizer, and it is allowed to because it writes an ATTRIBUTE: the
 * html serializer quotes every attribute value and escapes `&` and `"` inside it, so a value
 * cannot end its own attribute however it is composed. Element TEXT has no such property,
 * which is the whole of {@link CUT}.
 */
function neutraliseStyleAttr(el: Element, onRemote: (url: string) => string | null): void {
  const style = el.getAttribute("style");
  /**
   * The fast path has to know every spelling the scanner knows, or it decides on the scanner's
   * behalf that there is nothing to scan. This precheck skips `neutraliseCss` on the majority
   * of style attributes; it listed the three LITERAL token starts, and when the scanner learned
   * escaped function names this did not — so `style="background:\75 rl(/api/…)"` reached the
   * frame intact, on the easiest surface to put one. A backslash now hands it to the scanner:
   * the same anchor `CSS_TOKEN` uses, and over-inclusion here is free — on text that names
   * nothing the scanner returns the input unchanged.
   */
  if (!style || !/url\(|image-set\(|@import|\\/i.test(style)) return;
  el.setAttribute("style", neutraliseCss(style, onRemote));
}

// ── links ──────────────────────────────────────────────────────────────────────────────

/**
 * Does the visible text of this link disagree with where it goes? The case:
 * a link labelled "Manage your subscription" pointing at
 * `tracker.example.com/ls/click?u=…` — the honest thing is to say the
 * destination out loud rather than hide it or refuse the link. The test is
 * deliberately narrow: the visible text NAMES A HOST, and it is not the
 * host the link goes to. Broadening to "the text is not the url" would
 * flag every ordinary link — a warning that means nothing by the second one.
 */
export function textDisagreesWithHref(text: string, host: string): boolean {
  // BOUNDED BEFORE IT IS MATCHED. The subject is a sender-authored link label, so it can be
  // any size at all, and `(?:[a-z0-9-]+\.)+` over a megabyte of dotted junk is the same class
  // of main-thread stall the CSS scanner above is written to avoid. A link whose visible text
  // names a host names it at the front; 2 KiB is far past any label a reader can see.
  const claimed = /(?:^|\s)(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/\s]|$)/i.exec(
    text.trim().slice(0, 2048),
  );
  if (!claimed) return false;
  const claimedHost = claimed[1]!.toLowerCase();
  if (!host) return true;
  return claimedHost !== host && !host.endsWith(`.${claimedHost}`);
}

// ── how light is this mail? ────────────────────────────────────────────────────────────

/**
 * WHY THE DARK RENDERING HAS TO ASK THIS AT ALL: The dark rendering is one filter — `invert(1) hue-rotate(180deg)` —
 * and a filter has no opinion about what it is given. Applied to a mail that is ALREADY dark it produces a light one,
 * so a reader in a dark theme gets a white flash from exactly the senders who took the trouble to design for dark.
 * That is not a rough edge; it is the transform doing its job to the wrong input, and no amount of tuning the filter
 * fixes it. So the filter is gated on a cheap reading of the mail's own paper: invert what is light, leave alone what
 * is not. Everything below exists to answer that one question from the document this file already has in its hands,
 * and nothing else reads it.
 */

/**
 * The colour keywords bulk mail is actually written with. Deliberately NOT the full CSS list:
 * every entry here is a name this scanner must recognise to avoid mistaking a declared
 * background for "none declared", and the ones that matter are the neutrals a page is painted
 * with. A name that is absent falls through to "no opinion", which defaults to light — the
 * same answer as a mail that declares nothing, and the safe direction (see {@link mailIsLight}).
 */
const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff", snow: "#fffafa", ivory: "#fffff0", floralwhite: "#fffaf0",
  ghostwhite: "#f8f8ff", whitesmoke: "#f5f5f5", seashell: "#fff5ee", beige: "#f5f5dc",
  oldlace: "#fdf5e6", linen: "#faf0e6", antiquewhite: "#faebd7", aliceblue: "#f0f8ff",
  azure: "#f0ffff", mintcream: "#f5fffa", honeydew: "#f0fff0", lavender: "#e6e6fa",
  gainsboro: "#dcdcdc", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", silver: "#c0c0c0",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", gray: "#808080", grey: "#808080",
  dimgray: "#696969", dimgrey: "#696969", black: "#000000",
  navy: "#000080", darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", midnightblue: "#191970",
};

export interface Rgb { r: number; g: number; b: number; a: number }

/**
 * A CSS colour, as numbers, or `null` for "this file has no opinion".
 *
 * `null` is a real answer and not a failure: `transparent`, `inherit`, a gradient, a colour
 * function this does not parse, and plain nonsense all mean the same thing to the caller —
 * KEEP LOOKING — and none of them may be mistaken for an opaque background that was declared.
 * The alpha is carried for exactly that reason: `rgba(0,0,0,0)` is spelled like a colour and
 * paints nothing, and treating it as black is how a light mail gets classified dark.
 */
export function parseCssColor(input: string): Rgb | null {
  const v = input.trim().toLowerCase();
  if (v.length === 0) return null;
  const named = NAMED_COLORS[v];
  const hex = named ?? v;
  if (hex.startsWith("#")) {
    const d = hex.slice(1);
    const ok = /^[0-9a-f]+$/.test(d);
    if (ok && (d.length === 3 || d.length === 4)) {
      const p = (i: number): number => Number.parseInt(d[i]! + d[i]!, 16);
      return { r: p(0), g: p(1), b: p(2), a: d.length === 4 ? p(3) / 255 : 1 };
    }
    if (ok && (d.length === 6 || d.length === 8)) {
      const p = (i: number): number => Number.parseInt(d.slice(i, i + 2), 16);
      return { r: p(0), g: p(2), b: p(4), a: d.length === 8 ? p(6) / 255 : 1 };
    }
    return null;
  }
  // `rgb(1,2,3)`, `rgba(1,2,3,.5)` and the space-separated `rgb(1 2 3 / 50%)` form.
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[1]!.split(/[,/\s]+/).filter((s) => s.length > 0);
  if (parts.length < 3) return null;
  const chan = (s: string): number => {
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n)) return Number.NaN;
    return s.endsWith("%") ? (n / 100) * 255 : n;
  };
  const r = chan(parts[0]!), g = chan(parts[1]!), b = chan(parts[2]!);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  let a = 1;
  if (parts.length >= 4) {
    const rawAlpha = parts[3]!;
    const n = Number.parseFloat(rawAlpha);
    if (!Number.isFinite(n)) return null;
    a = rawAlpha.endsWith("%") ? n / 100 : n;
  }
  return { r, g, b, a };
}

/**
 * WCAG 2.x relative luminance. The sRGB channels are linearised before they are weighted,
 * which is the difference between "how bright is this number" and "how bright does this look";
 * a plain channel average calls `#008000` light and it is not.
 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number): number => {
    const s = Math.min(Math.max(c, 0), 255) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * THE THRESHOLD, AND IT IS NOT A ROUND NUMBER BY ACCIDENT.
 *
 * 0.179 is the relative luminance at which black and white text have equal contrast against a
 * background — the crossover the WCAG contrast formula produces from `(L+0.05)` on both sides.
 * Above it a designer reaches for dark ink, below it for light ink, which is precisely the
 * question the dark rendering needs answered: "was this mail drawn to be read as dark-on-light?"
 * A mid grey therefore reads as light, which is the right call — inverting `#808080` returns
 * very nearly `#808080`, so the cost of being wrong in that region is nil either way.
 */
export const LIGHT_LUMINANCE = 0.179;

/**
 * An OPAQUE-ENOUGH background declared on one element, or `null` for "nothing declared here". Both spellings mail
 * uses: the html 3.2 `bgcolor` attribute, which is still what a table-based newsletter is built from, and a
 * `background`/`background-color` declaration in the inline `style`. The shorthand is scanned token by token because
 * `background:#fff url(x) no-repeat` is one declaration with the colour buried in it. A translucent value (alpha
 * under a half) is `null` — it lets the surface behind it through, so it is not what the mail is painted on.
 */
function declaredBackground(el: Element): Rgb | null {
  const opaque = (c: Rgb | null): Rgb | null => (c && c.a >= 0.5 ? c : null);
  const attr = el.getAttribute("bgcolor");
  const fromAttr = attr ? opaque(parseCssColor(attr)) : null;
  if (fromAttr) return fromAttr;
  const style = el.getAttribute("style");
  if (!style) return null;
  const decl = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i.exec(style);
  if (!decl) return null;
  for (const token of decl[1]!.trim().split(/\s+/)) {
    const c = opaque(parseCssColor(token));
    if (c) return c;
  }
  return null;
}

/** A `html{…}` / `body{…}` rule's background colour in a stylesheet's text, or `null`. */
const SHEET_PAGE_BG =
  /(?:^|[};])\s*(?:html|body)\s*(?:,\s*(?:html|body)\s*)*\{[^{}]*?background(?:-color)?\s*:\s*([^;!}]+)/i;

/**
 * The tags a PAGE is painted with. A background on an `<a>` or a `<span>` is a highlight on a
 * word, not the paper, and letting one of those decide would classify a newsletter by whichever
 * inline flourish happened to come first in the document.
 */
const PAINTS_THE_PAGE = new Set([
  "table", "tbody", "tr", "td", "th", "div", "center", "section", "article", "main", "body",
]);

/**
 * How far into the document the wrapper chain is followed. A table-based newsletter nests
 * `table > tbody > tr > td` three deep before it reaches anything visible and often does it
 * twice, so this has to be more than a handful — and it must still be a CONSTANT, because the
 * scan runs synchronously inside `useMemo` on the thread that paints the app, like everything
 * else in this file.
 */
const BG_SCAN_LIMIT = 40;

/**
 * The mail's effective paper, from the document and not from a guess. Three places a mail says what it is painted on,
 * in the order they win: `<body bgcolor>` / `<body style>` — the most explicit statement, read from the PARSED
 * document because DOMPurify returns the body's CONTENT and the body element's own attributes never survive; a
 * `html{…}` or `body{…}` rule in the mail's own stylesheet — how a designed newsletter says it; and the outermost
 * container that declares one — document order is the wrapper chain in a table-based mail, so the first hit IS the
 * outermost. `null` means the mail declared nothing, the ordinary case: such mail is drawn on the browser's white,
 * and {@link mailIsLight} says so. What it cannot see, stated: there is no layout here — this runs before the frame
 * exists — so "dominant" is decided by depth and tag, not painted area.
 */

/**
 * A mail whose outermost wrapper is a narrow dark bar over a white page reads as dark and is left alone; that costs
 * one mail its original colours in a dark theme (a rendering the reader can ask for by name), while the opposite
 * error is a white flash. Biased on purpose, and the per-message toggle is the exit.
 */
export function effectiveBackground(
  parsedBody: Element | null,
  sanitized: Element | null,
  styleText: string,
): Rgb | null {
  if (parsedBody) {
    const own = declaredBackground(parsedBody);
    if (own) return own;
  }
  const sheet = SHEET_PAGE_BG.exec(styleText);
  if (sheet) {
    for (const token of sheet[1]!.trim().split(/\s+/)) {
      const c = parseCssColor(token);
      if (c && c.a >= 0.5) return c;
    }
  }
  if (sanitized) {
    let seen = 0;
    for (const el of sanitized.querySelectorAll("*")) {
      if (++seen > BG_SCAN_LIMIT) break;
      if (!PAINTS_THE_PAGE.has(el.tagName.toLowerCase())) continue;
      const c = declaredBackground(el);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Is this mail worth inverting?
 *
 * `null` — nothing declared — is TRUE, and that default is the whole product: mail that names
 * no background is drawn on white by every renderer there has ever been, including
 * {@link FRAME_CSS}'s own `body{background:#fff}`, and it is the overwhelming majority of what
 * arrives. Defaulting the other way would switch dark viewing off for almost everything.
 */
export function mailIsLight(bg: Rgb | null): boolean {
  return bg === null || relativeLuminance(bg) > LIGHT_LUMINANCE;
}

/**
 * HOW FAR FROM GREY A PAPER MAY DRIFT AND STILL COUNT AS "NO COLOUR", on the 0–255 channel scale. It is a chroma —
 * the spread between the strongest and weakest sRGB channel — so it needs no colour-space conversion and reads as
 * exactly "how far from grey is this". 12 is chosen against the two things it has to separate. A template's habit —
 * the faint off-white or grey a mail builder drops behind a white card (`#efefef`, `#f5f5f5`, a warm `#faf8f2`) — has
 * a chroma at or near 0 and is caught. A DELIBERATE pale tint — a brand's `#eef2ff`, a pale-yellow highlight card —
 * clears it (17, 51) and is kept. The band is narrow on purpose: clamping a paper that WAS meant costs one letter
 * drawn on white instead of near-white, which the "Show original" flip returns; not clamping costs the dull grey
 * sheet behind an otherwise white letter, which is the reported defect.
 */
export const NEUTRAL_CHROMA = 12;

/**
 * ── THE PAPER ACTUALLY PAINTED, WITH A NEAR-NEUTRAL LIGHT GROUND CLAMPED TO THE APP'S WHITE ─ {@link
 * effectiveBackground} reads what a mail DECLARES; this decides what to PAINT it on, and the two are kept apart
 * deliberately — the declared value still drives {@link mailIsLight} and the dark-viewing seam untouched, so the
 * inversion tests keep asserting the real colour. A letter that declares a faint grey/off-white page is not asking
 * the reader to keep that grey; it is the sender's template, and painting the frame's paper grey puts a dull sheet
 * behind a white letter. So a paper that is BOTH light (above the inversion threshold) AND effectively colourless
 * (chroma within {@link NEUTRAL_CHROMA}) becomes `null` — the app's own white, the same default a mail that declares
 * no background at all is drawn on.
 */

/**
 * Two papers keep their ground: a DELIBERATE colour (chroma past the band — a tinted card, a brand ground) and a DARK
 * canvas (a sender who drew a dark page). Only the near-white-grey middle is dropped. `null` in, `null` out: a mail
 * that declared nothing is unchanged.
 */
export function clampedPaper(bg: Rgb | null): Rgb | null {
  if (bg === null) return null;
  if (!mailIsLight(bg)) return bg;
  const chroma = Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b);
  return chroma <= NEUTRAL_CHROMA ? null : bg;
}

/**
 * A colour this file computed, as CSS. Alpha is dropped deliberately — this is only ever used
 * to paint the frame's PAPER, which is the bottom-most surface and has nothing to blend with.
 */
export function cssColor(c: Rgb): string {
  const n = (v: number): number => Math.round(Math.min(Math.max(v, 0), 255));
  return `rgb(${n(c.r)},${n(c.g)},${n(c.b)})`;
}

// ── the sanitizer ──────────────────────────────────────────────────────────────────────

// ── simple or rigid: which of the two layouts this mail is ─────────────────────────────

/**
 * Reflow, don't shrink. Scale-to-fit was the only answer this viewer had, and it was wrong for most mail: the frame
 * is measured, found wider than the column, and the WHOLE DOCUMENT is shrunk — text included, whatever made it wide.
 * A plain business letter carrying one long tracked link measured wide for that link and rendered at 0.6 for its
 * entire length. So the mail is classified first: SIMPLE (no fixed canvas — personal, business and transactional
 * mail, the overwhelming majority) is REFLOWED — every declared width capped at the column, long words break, text at
 * the app's own reading size; a document with no fixed canvas has nothing to lose by reflowing. RIGID (a fixed layout
 * canvas wider than a reading column — the 600/700 px newsletter grid) keeps the shipped scale-to-fit with its {@link
 * MIN_FIT_SCALE} floor, because reflowing one produces a collapsed pile of cells, not a narrower newsletter.
 */

/**
 * One rule decides it, and it is the one the sender actually writes: a fixed newsletter canvas is always DECLARED —
 * `<table width="600">`, `style="width:600px"`, or `.card{width:600px}` in the sender's own stylesheet. No heuristic
 * about cell counts or nesting depth: a two-column grid built at percentages reflows perfectly well and is SIMPLE,
 * and a single-column card declared at 600 px is RIGID, because shrinking is what keeps its padding and images in
 * proportion. `max-width` is deliberately NOT a fixed width — it is a cap that already reflows below its value, the
 * responsive spelling, and treating it as rigid would put the best-behaved mail in the class built for the
 * worst-behaved. Read from the final document and the neutralised stylesheet, for {@link SanitizedMail.light}'s
 * reason: the answer has to be about the document the frame will build, not the html that arrived.
 */
export const RIGID_MIN_PX = 520;

/**
 * And the upper bound, which is the half real mail forced. A canvas is a reading column somebody designed, and mail
 * templates declare theirs in a narrow, well-known range: `<table width="600">` above all, with 624, 640, 700 and 800
 * making up nearly all the rest — nothing designed for mail is wider, because it would side-scroll in every client.
 * What IS wider is markup that was never a mail design: the case that found this was two ordinary business replies
 * classified rigid on a single `<div style="width:1578px">` of pasted WooCommerce admin HTML — no design to preserve,
 * and the rigid path rendered the sender's actual sentences at about 0.4, precisely the "shrunk until it cannot be
 * read" failure the reflow class ended.
 */

/**
 * So rigidity is a BAND, not a floor: below {@link RIGID_MIN_PX} there is no canvas, above this there is no mail
 * design either, and both reflow. 1000 because the widest genuine canvas measured is 800 and a 960-grid template
 * exists; 1578 is comfortably outside either.
 */
export const RIGID_MAX_PX = 1000;

/**
 * The elements a fixed CANVAS is declared on. An `<img width="700">` is not a canvas — an
 * oversized picture caps to the column and keeps its aspect ratio, which is a reflow that
 * costs nothing — so images are deliberately absent and a mail is not called rigid for
 * carrying one.
 */
const CANVAS_TAGS = "table,tr,td,th,col,colgroup,div,center";

/** Is this a declared mail canvas — a width in the band, not a cap and not pasted debris? */
function isCanvasPx(n: number | null): boolean {
  return n !== null && n >= RIGID_MIN_PX && n <= RIGID_MAX_PX;
}

/**
 * Does a chunk of css DECLARE a canvas — any `width` / `min-width` in the band? ANY, not the widest, and that is the
 * whole reason this is a predicate rather than a number. It used to return the widest declaration and the caller
 * compared it to the floor, which reads the same on a document with one width and differently on a document with two:
 * a real 600 px newsletter with a pasted 1578 px fragment in it answered 1578, and under an upper bound that would
 * have dropped a genuine design out of the rigid class because of the debris beside it. A canvas is a thing a
 * document CONTAINS; a maximum is not the way to ask whether it does. Anchored at a declaration boundary (`;`, `{`,
 * or the start of a style attribute or of a rule's block, which is where {@link sheetsDeclare} slices), which is what
 * keeps two near-misses out: `max-width:600px` a cap, not a canvas — `-` is not a boundary, so it never matches.
 */

/**
 * `@media (max-width:620px)` a QUERY about the viewport, inside `(`, which is not a boundary either. Every responsive
 * newsletter contains one.
 */
function declaresCanvas(css: string): boolean {
  const re = /(?:^|[;{])\s*(?:min-)?width\s*:\s*(\d+(?:\.\d+)?)\s*px/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (isCanvasPx(Number(m[1]))) return true;
  }
  return false;
}

/** An html `width="600"` / `width="600px"` as a number. `null` for `"100%"` and for junk. */
function widthAttrPx(v: string | null): number | null {
  if (v == null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

/**
 * The frame is the exception, and rigidity is the whole test. `prose` — render as
 * {@link BodyText} over the message's TEXT part, in the app's own type — is now exactly
 * `!`{@link isRigidLayout}: one reading of one document decides {@link SanitizedMail.reflow},
 * {@link SanitizedMail.prose} and whether a frame is built at all. Most mail between people is
 * a paragraph and a sign-off, html only because every client sends html — and a sandboxed
 * iframe costs a document, a stylesheet, a measurement pass and a resize observer to draw it in
 * the SENDER's type inside a product that has its own.
 */

/**
 * Three tests were here and are gone: no picture, no background image, and a stylesheet under a length threshold.
 * Calibrated against fixtures, they do not survive real mail — the commonest message there is (a business reply with
 * a table for the quoted thread, a signature logo, and the `<style>` block a desktop client emits) failed two of them
 * and was rendered in a frame, in the sender's type, for no design that existed. They answered "did the sender's
 * client emit markup?", which is always yes, rather than "did the sender lay something out?" — and a DECLARED CANVAS
 * is the only evidence of the second: `isRigidLayout` finds a fixed width at or past {@link RIGID_MIN_PX}, and that
 * alone is a design the frame exists to render faithfully. Everything else is a letter: tables, inline images,
 * signature logos and all.
 */

/**
 * What the reader loses, said plainly: a picture in a non-rigid mail is not drawn. `cid:`
 * images were never drawn in the frame either, so that half costs nothing; a REMOTE picture the
 * reader consented to load is the half that does, and the render branch at the bottom hands
 * those messages back to the frame rather than letting "Show images" become a button that does
 * nothing. Beacons are excluded from that test: a beacon is not a picture — it renders as
 * nothing, and letting one drag a letter into a frame would undo this rule for a thing the
 * reader cannot see.
 */

/**
 * The one thing this must never become: no untrusted markup STRING ever reaches a DOM sink — no
 * `dangerouslySetInnerHTML`, no `innerHTML`, no srcdoc-in-the-app-document. The `srcdoc` sandbox is where the
 * sanitizer's OUTPUT STRING renders, and "the sanitizer said it was fine, so we can inline it" is the sentence that
 * removes that boundary. What the prose class renders natively is not that string: {@link buildRichNodes} walks the
 * sanitized DOM through a second, narrower allow-list and emits DATA — text runs, bounded ints, gated hrefs — which
 * `BodyText` turns into elements it constructs itself. Sender bytes enter the app document only as React text nodes,
 * and every attribute is a value this code computed. `test/message-body-prose.test.ts` holds both halves: the
 * structure renders, and no sender markup, class, style, id or handler exists anywhere in the app's tree.
 */

/**
 * Does this document declare a fixed layout canvas wider than a reading column? Exported so the classification can be
 * watched directly against real mail rather than inferred from a rendered frame — see the reflow guards in
 * `test/message-body.test.ts` and the prose guards in `test/message-body-prose.test.ts`. It is the ONLY classifier
 * behind both. `styleText` is the sanitized document's `<style>` texts — one entry per element, the same union {@link
 * isDesignedLayout} takes — and it is read through the same rule-wise walk ({@link sheetsDeclare}): each sheet its
 * own tokenizer run, a declaration counted only inside a selector's block.
 */

/**
 * The flat declaration regex stays for inline `style` ATTRIBUTES, where a bare `width:600px` really is a declaration;
 * in a SHEET the same text outside a rule is one no browser applies, and a flat read of the sheets — joined, or even
 * one element at a time — turned ruleless fragments, comment text and string data into canvas evidence the rendered
 * document has not got. That one seam was circled repeatedly; the walk is its close.
 */
export function isRigidLayout(root: Element, styleText: string | readonly string[]): boolean {
  if (sheetsDeclare(styleText, declaresCanvas)) return true;
  for (const el of root.querySelectorAll(CANVAS_TAGS)) {
    if (isCanvasPx(widthAttrPx(el.getAttribute("width")))) return true;
    const style = el.getAttribute("style");
    if (style && declaresCanvas(style)) return true;
  }
  return false;
}

/**
 * Does a chunk of css declare a RESPONSIVE canvas — a `max-width` in the same band? A
 * fixed-width newsletter used to say `<table width="600">`; the responsive successor says
 * `<table width="100%" style="max-width:600px">` and hides its fixed twin inside an
 * `<!--[if mso]>` conditional the sanitizer strips as a comment. So the only canvas declaration
 * surviving into the document this classifier reads is the `max-width`, and a rule refusing it
 * classifies precisely the best-built marketing mail as a letter — the reported defect: a real
 * marketing message (nested borderless tables, `max-width:580px` cards) walked into the prose
 * renderer, which drew a border around each nesting level of a design that draws none.
 */

/**
 * NOT part of {@link isRigidLayout}: `declaresCanvas` deliberately refuses `max-width`, and that stays right for what
 * RIGID decides — rigid mail is scale-to-fit, and a `max-width` document already reflows below its cap, so shrinking
 * it would shrink a document that fits. This predicate feeds the OTHER decision — framed versus prose — where the
 * question is not "must this be shrunk" but "did the sender lay something out": a `max-width` canvas answers yes to
 * the second and no to the first, exactly the divergence {@link SanitizedMail.prose} reserved room for. Anchored at a
 * declaration boundary like `declaresCanvas`, for the same near-miss: `@media (max-width:620px)` is a QUERY about the
 * viewport — inside `(`, not a boundary — and every responsive template contains one.
 */
function declaresResponsiveCanvas(css: string): boolean {
  const re = /(?:^|[;{])\s*max-width\s*:\s*(\d+(?:\.\d+)?)\s*px/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (isCanvasPx(Number(m[1]))) return true;
  }
  return false;
}

/**
 * CSS comments out, in ONE forward pass — quote-aware, and linear by construction. The obvious lazy global regex
 * (comment-open, anything, comment-close) fails both of this file's standing rules at once — and its delimiters
 * cannot even be written in THIS comment without ending it, which is the trap in miniature. It is QUADRATIC on
 * hostile input: a stylesheet of repeated comment-opens that never close makes the lazy quantifier re-scan the
 * remainder from every start — the `url(` regex's failure shape (measured there at 125 KB → 6.1 s), on the same
 * render thread, reachable within the 512 KiB cap. And it is blind to STRINGS: a `content` property may hold a
 * comment-open in one quoted value and a comment-close in another, both text to CSS, and a regex that cannot know
 * that deletes every real rule between them.
 */

/**
 * So: one scan, every terminator found with `indexOf` from a position that only moves forward. A quoted string is
 * copied whole (escapes honoured); an unterminated string runs to EOF, which can only make this find FEWER canvases —
 * the safe direction, prose. An unterminated comment runs to EOF too, which is CSS Syntax's own rule for it, and is
 * also what the browser will do to whatever "rules" sit inside it — they were never live CSS, so hiding them from the
 * classifier tells no lies.
 */
/**
 * The index just past ONE CSS escape whose backslash sits at `backslash` (CSS Syntax §4.3.7):
 * one to six hex digits consume an OPTIONAL single whitespace terminator (`\r\n` counting as
 * one); any other character is consumed literally; a backslash at EOF consumes nothing more.
 * The terminator is the half a naive "skip one char" misses — `\61` ended by a line feed keeps
 * that line feed INSIDE the escape, so a scanner that surfaced it re-entered the outer scan
 * from the middle of a string.
 */
function pastCssEscape(css: string, backslash: number): number {
  let j = backslash + 1;
  if (j >= css.length) return j;
  let hex = 0;
  while (hex < 6 && j < css.length && /[0-9a-fA-F]/.test(css[j]!)) {
    j += 1;
    hex += 1;
  }
  if (hex === 0) return j + 1;
  if (css[j] === "\r" && css[j + 1] === "\n") return j + 2;
  if (css[j] === " " || css[j] === "\t" || css[j] === "\n" || css[j] === "\r" || css[j] === "\f") {
    return j + 1;
  }
  return j;
}

function stripCssComments(css: string): string {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    // A top-level escape consumes its WHOLE token ({@link pastCssEscape}) — `\'` and `\"` are
    // ident characters to CSS, not string openers, and treating one as a string swallowed
    // everything to EOF and left a live comment "inside" it for the rule scan to read as CSS.
    if (c === "\\") {
      i = pastCssEscape(css, i);
      continue;
    }
    // ── A STRING'S CONTENTS ARE DATA, AND THE CLASSIFIER VIEW BLANKS THEM ────────────────
    // Not merely SKIPPED: a preserved string can hold rule-shaped text — braces, a max-width
    // declaration, comment delimiters — and every downstream reader (the brace walk, the
    // declaration regex) would need its own string awareness to avoid reading it as CSS.
    // Emitting an EMPTY string token instead closes the whole family at one seam: no string
    // byte survives into the view the classifier reads, and a string never carries a live
    // declaration, so blanking one can never hide a real canvas. Escapes are consumed whole,
    // and CSS Syntax §4.3.5's bad-string rule ends the token at an unescaped newline (which
    // stays in the output — it was never part of the string).
    if (c === '"' || c === "'") {
      out += css.slice(copied, i) + c + c;
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== "\n" && css[j] !== "\r" && css[j] !== "\f") {
        if (css[j] === "\\") { j = pastCssEscape(css, j); continue; }
        j += 1;
      }
      i = j < css.length && css[j] === c ? j + 1 : j;
      copied = i;
      continue;
    }
    // An UNQUOTED url token is data to CSS from `url(` to its `)` — a comment-open inside one
    // is part of the url, and treating it as a comment ate every live rule up to the next
    // comment-close-lookalike in a later url. Blanked to `url()` for the string rationale
    // above: url data can hold braces too. `continuesIdent` keeps `xurl(` from matching, and
    // `@`/`#` are rejected by name: `@url(` is an at-keyword and `#url(` an id selector, whose
    // parenthesised text is ordinary CSS the comment rules still govern. The QUOTED form —
    // `url( "…" )` — is NOT taken here: its argument is a string the branch above blanks, and
    // between the argument and the function's `)` ordinary CSS rules apply again.
    if (
      (c === "u" || c === "U") &&
      /^url\(/i.test(css.slice(i, i + 4)) &&
      (i === 0 ||
        (!continuesIdent(css.charCodeAt(i - 1)) && css[i - 1] !== "@" && css[i - 1] !== "#"))
    ) {
      let j = i + 4;
      // ALL of CSS's whitespace — a template may break the line after `url(` before a quoted
      // argument, and a skip that only knew space/tab would misread the quoted form as
      // unquoted data and stop at a `)` inside the string.
      while (
        j < css.length &&
        (css[j] === " " || css[j] === "\t" || css[j] === "\n" || css[j] === "\r" || css[j] === "\f")
      ) j += 1;
      if (css[j] === '"' || css[j] === "'") {
        i = j; // the string branch blanks the argument; the outer scan resumes after it
        continue;
      }
      out += css.slice(copied, i) + "url(";
      while (j < css.length && css[j] !== ")") {
        if (css[j] === "\\") { j = pastCssEscape(css, j); continue; }
        j += 1;
      }
      i = j;
      copied = i;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      out += css.slice(copied, i) + " ";
      const close = css.indexOf("*/", i + 2);
      if (close === -1) { copied = css.length; break; }
      i = close + 2;
      copied = i;
      continue;
    }
    i += 1;
  }
  return copied === 0 ? css : out + css.slice(copied);
}

/**
 * The stylesheet half of the same question — rule-wise, because a sheet's declarations belong to selectors
 * and a canvas is a property of LAYOUT elements: `img.hero { max-width:600px }` caps a picture, and reading
 * the sheet flat would frame a letter on the strength of an image-size rule. A rule whose selector names
 * `img` as a tag token contributes nothing (`.imgwrap` is a class and does not match); a mixed list (`td,
 * img`) is skipped whole — one designed mail rendered as a letter, the pre-existing behaviour, in a shape
 * templates do not use. The rule regex cannot cross braces, so a media prelude is never read as a block.
 * Both canvas predicates read sheets through this one walk, taking the predicate as a parameter, so the two
 * scans cannot drift apart one fix at a time.
 */
/** A selector list that targets images — `img` as a TAG token; `.imgwrap` is a class and is not. */
const IMG_SELECTOR = /(?:^|[\s,>+~(])img\b/i;

/**
 * IMG as a decoded tag token — `i\6dg` spells `img` in CSS escapes and must read as it. The
 * decode PRESERVES TOKEN BOUNDARIES, which a plain decode does not: an escape decoding to a
 * letter or digit keeps its identity, so the escaped img spelling matches; any other decoded
 * character becomes a word placeholder, so an escaped combinator stays identifier data —
 * `.foo\+img` is a class named `foo+img`, and a plain decode would hand {@link IMG_SELECTOR} a
 * `+` boundary with an img tag behind it. The placeholder is a letter so a non-word character
 * after a decoded `img` cannot forge the word-boundary match.
 */
function selectsImage(selector: string): boolean {
  if (!selector.includes("\\")) return IMG_SELECTOR.test(selector);
  const preserved = selector.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g,
    (_m, hex: string | undefined, literal: string | undefined) => {
      let ch = "";
      if (hex === undefined) ch = literal ?? "";
      else {
        const cp = Number.parseInt(hex, 16);
        if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
          try { ch = String.fromCodePoint(cp); } catch { ch = ""; }
        }
      }
      return /^[A-Za-z0-9]$/.test(ch) ? ch : "x";
    },
  );
  return IMG_SELECTOR.test(preserved);
}

/**
 * What a rule's selector is EVIDENCE-wise, for the canvas scans:
 *   · `"live"`  — its declarations may be canvas evidence;
 *   · `"image"` — a real rule whose subject is an image: its declarations are picture sizing,
 *                 never canvas evidence, but rules NESTED in it can still resolve to live
 *                 subjects beside the image;
 *   · `"gone"`  — unmatchable (a descendant of an image, or nested in something unmatchable).
 *                 Nothing nested inside comes back: a sibling of a nonexistent element does
 *                 not exist either — reviving these was a review finding.
 */
type Evidence = "live" | "image" | "gone";

/**
 * Resolve a selector nested in an image-subject rule — per comma-alternative, resolve the
 * implicit parent and read the SUBJECT, with CSS escapes respected (`\&` is identifier data;
 * `i\6dg` decodes to the img tag). `.card` → implicit `& .card`, a descendant of an image:
 * "gone"; `& + .card` → a live canvas beside it: "live"; `+ .card` → the same with `&` implicit;
 * `& + .card &` and `& + img.hero` → subject is an image: "image". Aggregation is by
 * permissiveness: any live alternative makes the rule live, else any image-subject keeps it
 * escapable, else gone. A parent reference inside `:is()` reads as "image" — conservative.
 * Splitting respects escapes, parens and brackets.
 */
function nestedEvidence(sel: string): Evidence {
  const alternatives: string[] = [];
  {
    let depth = 0;
    let buf = "";
    for (let i = 0; i < sel.length; i += 1) {
      const ch = sel[i]!;
      if (ch === "\\") {
        const past = pastCssEscape(sel, i);
        buf += sel.slice(i, past);
        i = past - 1;
        continue;
      }
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        alternatives.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    alternatives.push(buf);
  }
  let best: Evidence = "gone";
  for (const raw of alternatives) {
    const alt = raw.trim();
    if (alt === "") continue;
    // Tokenize into compounds — each knowing whether it holds an UNESCAPED `&` — with the
    // combinator BEFORE each (null before the first, unless the alternative is RELATIVE and
    // leads with one).
    type Compound = { text: string; amp: boolean };
    const compounds: Compound[] = [];
    const combs: (string | null)[] = [];
    let depth = 0;
    let buf = "";
    let amp = false;
    let nextComb: string | null = null;
    let combBefore: string | null = null;
    const close = () => {
      if (buf === "") return;
      compounds.push({ text: buf, amp });
      combs.push(combBefore);
      buf = "";
      amp = false;
    };
    for (let i = 0; i < alt.length; i += 1) {
      const ch = alt[i]!;
      if (ch === "\\") {
        const past = pastCssEscape(alt, i);
        if (buf === "") { combBefore = nextComb; nextComb = null; }
        buf += alt.slice(i, past); // escape data: never a nesting token
        i = past - 1;
        continue;
      }
      if (depth > 0) {
        if (ch === "(" || ch === "[") depth += 1;
        else if (ch === ")" || ch === "]") depth -= 1;
        if (ch === "&") amp = true;
        buf += ch;
        continue;
      }
      if (ch === "(" || ch === "[") {
        depth += 1;
        if (buf === "") { combBefore = nextComb; nextComb = null; }
        buf += ch;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
        if (buf !== "") { close(); nextComb = " "; }
        continue;
      }
      if (ch === ">" || ch === "+" || ch === "~") {
        if (buf !== "") close();
        nextComb = ch;
        continue;
      }
      if (buf === "") { combBefore = nextComb; nextComb = null; }
      if (ch === "&") amp = true;
      buf += ch;
    }
    close();
    if (compounds.length === 0) continue;
    if (!compounds.some((c) => c.amp)) {
      // Implicit parent: relative nesting keeps its leading combinator; otherwise descendant.
      if (combs[0] === null) combs[0] = " ";
      compounds.unshift({ text: "&", amp: true });
      combs.unshift(null);
    }
    // Reachability first: a parent-bearing compound followed by a descendant or child
    // combinator requires an element INSIDE an image, so the whole alternative matches
    // nothing, whatever its subject says.
    let unreachable = false;
    for (let i = 0; i < compounds.length - 1; i += 1) {
      if (!compounds[i]!.amp) continue;
      const after = combs[i + 1] ?? " ";
      if (after === " " || after === ">") {
        unreachable = true;
        break;
      }
    }
    if (unreachable) continue; // "gone" — the floor best already holds
    const subject = compounds[compounds.length - 1]!;
    if (subject.amp || selectsImage(subject.text)) {
      if (best === "gone") best = "image";
      continue;
    }
    return "live";
  }
  return best;
}

function sheetsDeclare(
  styleText: string | readonly string[],
  declares: (block: string) => boolean,
): boolean {
  // ── EACH `<style>` ELEMENT IS ITS OWN TOKENIZER RUN ─────────────────────────────────────
  // A browser ends every sheet at its own EOF: an unterminated string or comment in one
  // element cannot eat the next element's rules. A single concatenated scan CAN — one sheet
  // ending with a backslash inside an unterminated string consumed the separator and blanked
  // the following sheet's genuine canvas — and a JOIN also manufactures evidence the other way:
  // `.a{` ending one sheet and `width:600px` opening the next read as a declaration inside a
  // rule that exists in neither. So the caller hands the sheets as an ARRAY and each is
  // stripped and walked on its own. The plain-string form remains for a caller (or test)
  // holding one sheet.
  const sheets = typeof styleText === "string" ? [styleText] : styleText;
  for (const one of sheets) {
    if (oneSheetDeclares(one, declares)) return true;
  }
  return false;
}

function oneSheetDeclares(styleText: string, declares: (block: string) => boolean): boolean {
  // Comments go FIRST, for two reasons that are both real CSS: `/* img defaults */ .card{…}`
  // would put the token `img` into the captured selector and skip a genuine canvas rule, and a
  // brace inside a comment would misalign every rule after it. See {@link stripCssComments}
  // for why this is a forward scan and not a regex.
  const sheet = stripCssComments(styleText);

  // The block structure, read the way the browser reads it: one
  // escape-aware pass keeps a stack of open blocks and, per block, its
  // DIRECT declaration text — an inner rule's width is never attributed to
  // the outer selector; the walk closes and applies open blocks at EOF as
  // the browser does, an escaped brace (`--x:\}`) is data, and a nested
  // rule leaves the outer rule's own declarations counted. PARSE-dead
  // (empty selector: dropped whole) is not EVIDENCE-skipped (an `img`-token
  // selector is real CSS; nested rules resolve by SUBJECT,
  // {@link nestedEvidence}). At-rules are transparent. Every brace read is
  // structure (strings and urls blanked, escapes stepped over). Linear.
  type Level = {
    /** May this level's own declaration text be evaluated (and under a live selector)? */
    evalDecls: boolean;
    /** Browser-level: false under a parse-dead (empty-selector) rule — nothing comes back. */
    parseAlive: boolean;
    /** Evidence state — see {@link Evidence}: image scopes are escapable, gone ones are not. */
    evidence: Evidence;
    /** The level's direct declaration text, nested blocks excluded. */
    decl: string;
    /** Text since the last `;` / block boundary — the next block's selector candidate. */
    pending: string;
  };
  const stack: Level[] = [
    { evalDecls: false, parseAlive: true, evidence: "live", decl: "", pending: "" },
  ];
  const closeTop = (): boolean => {
    const level = stack.pop()!;
    return level.evalDecls && declares(level.decl + level.pending);
  };
  for (let j = 0; j < sheet.length; j += 1) {
    const ch = sheet[j];
    const cur = stack[stack.length - 1]!;
    if (ch === "\\") {
      const past = pastCssEscape(sheet, j);
      cur.pending += sheet.slice(j, past);
      j = past - 1;
    } else if (ch === ";") {
      cur.decl += cur.pending + ";";
      cur.pending = "";
    } else if (ch === "{") {
      const sel = cur.pending.trim();
      cur.pending = "";
      if (sel.startsWith("@")) {
        stack.push({
          evalDecls: cur.evalDecls,
          parseAlive: cur.parseAlive,
          evidence: cur.evidence,
          decl: "",
          pending: "",
        });
      } else {
        const parseAlive = cur.parseAlive && sel !== "";
        const evidence: Evidence =
          cur.evidence === "live"
            ? selectsImage(sel)
              ? "image"
              : "live"
            : cur.evidence === "image"
              ? nestedEvidence(sel)
              : "gone";
        stack.push({
          evalDecls: parseAlive && evidence === "live",
          parseAlive,
          evidence,
          decl: "",
          pending: "",
        });
      }
    } else if (ch === "}") {
      if (stack.length > 1) {
        if (closeTop()) return true;
      } else {
        // A stray close at the top level is a parse error the browser skips; the text before
        // it is not a selector for anything that follows.
        cur.pending = "";
      }
    } else {
      cur.pending += ch;
    }
  }
  // End of sheet: the browser closes every block still open and applies what it holds.
  while (stack.length > 1) {
    if (closeTop()) return true;
  }
  return false;
}

/**
 * Is this mail designed — did the sender lay something out — even where no fixed canvas says so? {@link
 * isRigidLayout} caught the fixed-width half and missed two: a RESPONSIVE canvas (`max-width` in the {@link
 * RIGID_MIN_PX}–{@link RIGID_MAX_PX} band, in the sheet or on a layout element — {@link
 * declaresResponsiveCanvas}), and NESTED LAYOUT TABLES — nesting is how table layout is built, and no
 * letter-writing client emits one (Gmail quotes with `blockquote`, Outlook with a div). The costs are
 * asymmetric: designed-read-as-letter draws borders over a design that draws none (the reported defect);
 * letter-read-as-designed renders one message in the sender's type, still reflowed at the column. Exported: the
 * classification is watched against document shapes directly (`test/message-body-designed.test.ts`).
 */
export function isDesignedLayout(root: Element, styleText: string | readonly string[]): boolean {
  if (sheetsDeclare(styleText, declaresResponsiveCanvas)) return true;
  for (const el of root.querySelectorAll(CANVAS_TAGS)) {
    const style = el.getAttribute("style");
    if (style && declaresResponsiveCanvas(style)) return true;
  }
  return root.querySelector("table table") !== null;
}

// ── the rich walker: the prose rendering's OWN allow-list ──────────────────────────────

/**
 * A second, narrower allow-list: the prose rendering has no frame — its elements live in the
 * app's own document — so this walker emits `BodyText`'s node model. The invariant: no sender
 * byte leaves except as the `text` of a text run, and no sender attribute leaves at all (`href`
 * via {@link anchorFor}, `colspan` via {@link boundedSpan}; `style`/`class` never read). Absent
 * on purpose: `img` (the strip lists them) and `style` ({@link RICH_SKIP}); everything else is
 * transparent. `pre` reads as literal text; `blockquote` maps to the text parser's QuoteNode,
 * clamped by {@link MAX_QUOTE_DEPTH}; past {@link MAX_RICH_NODES} it answers `null`.
 */
export const MAX_RICH_NODES = 4096;

/** The ceiling on a parsed `colspan`/`rowspan`. Real mail tables sit far under it. */
export const MAX_TABLE_SPAN = 20;

/**
 * The ceiling on DOM NESTING the walk will follow. The node cap bounds breadth; this bounds
 * the recursion itself, because a 512 KiB html part that is nothing but `<div><div><div>…`
 * parses to ~10⁵ levels and a recursive walk of it is a stack overflow, not a letter. 256 is
 * past any real thread (Gmail nests one `blockquote` per hop) and nowhere near the stack.
 * Exceeding it poisons the budget, so the whole build refuses and the text part renders.
 */
const MAX_WALK_DEPTH = 256;

/** Elements whose CONTENT must not reach the prose — see the header above. */
const RICH_SKIP = new Set(["style", "img"]);

/** The walk's budget. Decremented per EMITTED node; below zero the whole build is refused. */
interface RichBudget { left: number }
function spend(b: RichBudget): boolean { return --b.left >= 0; }
/** Refuse the whole build — see {@link MAX_WALK_DEPTH} and {@link buildRichNodes}. */
function poison(b: RichBudget): void { b.left = -1; }

/** `colspan="3"` → 3; junk, absence and zero → 1; anything huge → {@link MAX_TABLE_SPAN}. */
function boundedSpan(v: string | null): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_TABLE_SPAN);
}

/** The sender's words in an inline run — what attribution detection and emptiness read. */
function textOfInline(nodes: InlineNode[]): string {
  let s = "";
  for (const n of nodes) {
    if (n.kind === "text") s += n.text;
    else if (n.kind === "break") s += "\n";
    else s += textOfInline(n.children);
  }
  return s;
}

/**
 * One node of inline content. Text becomes a text run; `strong`/`b`, `em`/`i`, `u` become
 * styled runs; `a` passes {@link anchorFor} or dissolves into its own label; EVERYTHING else
 * is transparent — its children are walked in place, the element is never emitted.
 */
function appendInline(node: ChildNode, out: InlineNode[], b: RichBudget, nest: number): void {
  if (b.left < 0) return;
  if (nest > MAX_WALK_DEPTH) { poison(b); return; }
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = node.nodeValue ?? "";
    if (text.length > 0 && spend(b)) out.push({ kind: "text", text });
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (RICH_SKIP.has(tag)) return;
  if (tag === "br") { if (spend(b)) out.push({ kind: "break" }); return; }
  if (tag === "strong" || tag === "b") {
    if (spend(b)) out.push({ kind: "strong", children: inlineOf(el, b, nest) });
    return;
  }
  if (tag === "em" || tag === "i") {
    if (spend(b)) out.push({ kind: "em", children: inlineOf(el, b, nest) });
    return;
  }
  if (tag === "u") {
    if (spend(b)) out.push({ kind: "underline", children: inlineOf(el, b, nest) });
    return;
  }
  if (tag === "code") {
    // Literal characters INSIDE a sentence — a path, a header name, a flag. The block form is
    // `pre` (usually wrapping one of these), and the block walk claims it before this function
    // is ever reached, so a `pre > code` becomes one preformatted block and not a code run
    // inside a paragraph.
    if (spend(b)) out.push({ kind: "code", children: inlineOf(el, b, nest) });
    return;
  }
  if (tag === "a") {
    /**
     * One gate, the same one the plain-text path trusts: `anchorFor` re-parses the href and
     * answers with a URL it constructed or `null` — and null is the DEFAULT branch: the label
     * stays as text, exactly as the sender wrote it, with no anchor. That covers
     * `mailto:`/`tel:`/ `cid:` (admitted for the frame, not linked here), relative hrefs, and
     * hrefs the post-pass removed. The label is the sender's — the property the plain path's
     * label≡href construction never had to defend — so the disagreement check rides along: a
     * label naming another host gets the destination's host printed beside it.
     */
    const gate = anchorFor((el.getAttribute("href") ?? "").trim());
    const children = inlineOf(el, b, nest);
    if (gate === null) { out.push(...children); return; }
    const host = hostOfUrl(gate.href);
    if (spend(b)) {
      out.push({
        kind: "link",
        href: gate.href,
        host,
        elsewhere: textDisagreesWithHref(el.textContent ?? "", host),
        children,
      });
    }
    return;
  }
  // Transparent: `span`, `font`, and any block the sender nested mid-line. Words flow on.
  for (const child of el.childNodes) appendInline(child, out, b, nest + 1);
}

/**
 * The literal text of a `pre` subtree — the one place this walker reads a
 * subtree as a string, and deliberately NOT `el.textContent`:
 * {@link RICH_SKIP} (textContent would fold a `<style>`'s stylesheet into
 * the snippet as if the sender typed it — that rule holds inside a `pre`
 * too), and `<br>` (inside preformatted text a br is a line the sender
 * drew, and textContent silently joins two lines of a stack trace). The
 * result is only ever sender BYTES, never markup: one React text node.
 */
function preTextOf(node: ChildNode, b: RichBudget, nest: number): string {
  if (nest > MAX_WALK_DEPTH) { poison(b); return ""; }
  if (node.nodeType === 3 /* TEXT_NODE */) return node.nodeValue ?? "";
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (RICH_SKIP.has(tag)) return "";
  if (tag === "br") return "\n";
  let s = "";
  for (const child of el.childNodes) s += preTextOf(child, b, nest + 1);
  return s;
}

function inlineOf(el: Element, b: RichBudget, nest: number): InlineNode[] {
  const out: InlineNode[] = [];
  for (const child of el.childNodes) appendInline(child, out, b, nest + 1);
  return out;
}

/** The tags the BLOCK walk handles by name. Anything else is a transparent block. */
const RICH_INLINE = new Set(["br", "strong", "b", "em", "i", "u", "a", "span", "font",
  "abbr", "acronym", "bdi", "bdo", "big", "cite", "code", "data", "dfn", "del", "ins",
  "kbd", "label", "mark", "q", "rp", "rt", "ruby", "s", "samp", "small", "strike",
  "sub", "sup", "time", "tt", "var", "wbr"]);

/**
 * The block walk: accumulate inline content into a paragraph run, flush it at every block
 * boundary, and emit the structural kinds by name. A paragraph whose words trim to nothing
 * is dropped — that is the whitespace between a mail builder's `<div>`s, not content.
 */
function blocksOf(container: Element, depth: number, b: RichBudget, nest: number): BodyNode[] {
  if (nest > MAX_WALK_DEPTH) { poison(b); return []; }
  const out: BodyNode[] = [];
  let run: InlineNode[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const children = run;
    run = [];
    const words = textOfInline(children).trim();
    if (words.length === 0) return;
    if (spend(b)) {
      const para: RichParagraphNode = { kind: "rich", attribution: isAttribution(words), children };
      out.push(para);
    }
  };

  for (const node of container.childNodes) {
    if (b.left < 0) break;
    if (node.nodeType !== 1 /* ELEMENT_NODE */) { appendInline(node, run, b, nest + 1); continue; }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (RICH_SKIP.has(tag)) continue;
    if (RICH_INLINE.has(tag)) { appendInline(node, run, b, nest + 1); continue; }

    flush();
    if (tag === "blockquote") {
      // The clamp is the SAME semantic as the text path's: past MAX_QUOTE_DEPTH the words
      // survive at the deepest level and only the wrapper count is capped.
      if (depth >= MAX_QUOTE_DEPTH) { out.push(...blocksOf(el, depth, b, nest + 1)); continue; }
      const children = blocksOf(el, depth + 1, b, nest + 1);
      if (children.length > 0 && spend(b)) {
        const quote: QuoteNode = { kind: "quote", depth: depth + 1, children };
        out.push(quote);
      }
    } else if (tag === "ul" || tag === "ol") {
      const items: BodyNode[][] = [];
      for (const child of el.children) {
        if (b.left < 0) break;
        if (RICH_SKIP.has(child.tagName.toLowerCase())) continue;
        const item = blocksOf(child, depth, b, nest + 1);
        if (item.length > 0) items.push(item);
      }
      if (items.length > 0 && spend(b)) out.push({ kind: "list", ordered: tag === "ol", items });
    } else if (tag === "pre") {
      // THE ONE BLOCK WHOSE WHITESPACE IS CONTENT. Everywhere else in this walk the sender's
      // spacing is noise between elements; in a `pre` the indentation IS the structure, so the
      // subtree is read as literal text (see {@link preTextOf}) and handed to `BodyText` as a
      // string it renders in a container that scrolls. A `pre` of nothing but whitespace is the
      // same non-content a blank paragraph is, and is dropped for the same reason.
      let text = "";
      for (const child of el.childNodes) text += preTextOf(child, b, nest + 1);
      if (text.trim().length > 0 && spend(b)) out.push({ kind: "pre", text });
    } else if (tag === "table") {
      tableOf(el, depth, b, out, nest + 1);
    } else if (tag === "hr") {
      if (spend(b)) out.push({ kind: "rule" });
    } else if (/^h[1-6]$/.test(tag)) {
      const children = inlineOf(el, b, nest);
      if (textOfInline(children).trim().length > 0 && spend(b)) {
        out.push({
          kind: "heading",
          level: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6,
          children,
        });
      }
    } else {
      // `p`, `div`, and every unhandled block container (`center`, `section`, an orphaned
      // `td`): a block boundary whose content is walked in place.
      out.push(...blocksOf(el, depth, b, nest + 1));
    }
  }
  flush();
  return out;
}

/**
 * Rows from wherever the parser put them — direct `tr` children and the ones inside
 * `thead`/`tbody`/`tfoot` — in document order. A `caption`'s words land as a paragraph
 * above the table rather than being dropped. Cells carry {@link boundedSpan} ints and their
 * own block children, so a nested table nests instead of flattening into its parent.
 */
function tableOf(el: Element, depth: number, b: RichBudget, out: BodyNode[], nest: number): void {
  const rows: TableRowNode[] = [];
  const addRow = (tr: Element): void => {
    const cells: TableCellNode[] = [];
    for (const c of tr.children) {
      if (b.left < 0) break;
      const tag = c.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      if (!spend(b)) break;
      cells.push({
        header: tag === "th",
        colSpan: boundedSpan(c.getAttribute("colspan")),
        rowSpan: boundedSpan(c.getAttribute("rowspan")),
        children: blocksOf(c, depth, b, nest + 1),
      });
    }
    if (cells.length > 0 && spend(b)) rows.push({ cells });
  };
  for (const child of el.children) {
    if (b.left < 0) break;
    const tag = child.tagName.toLowerCase();
    if (tag === "tr") addRow(child);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const tr of child.children) {
        if (tr.tagName.toLowerCase() === "tr") addRow(tr);
      }
    } else if (tag === "caption") {
      out.push(...blocksOf(child, depth, b, nest + 1));
    }
  }
  if (rows.length > 0 && spend(b)) out.push({ kind: "table", rows });
}

/**
 * The walker's whole answer for one sanitized document: the node tree, or `null` when the
 * mail holds no usable structure or wants more than {@link MAX_RICH_NODES} of it. `null`
 * means "render the text part", which is the rendering every prose message had before this
 * walker existed — the fallback is the previous behaviour, not a degraded one.
 */
export function buildRichNodes(root: Element): BodyNode[] | null {
  const b: RichBudget = { left: MAX_RICH_NODES };
  const nodes = blocksOf(root, 0, b, 0);
  if (b.left < 0) return null;
  return nodes.length > 0 ? nodes : null;
}

export interface SanitizeOptions {
  /**
   * How to reach a remote image, or `null` for "you may not". `null` is the default and the
   * only value the product ships today; see the header for why the consent path waits on a
   * route. A function here rewrites every blocked url through it instead of blanking it —
   * which is the ONLY way an image may ever load, because it is what keeps the sender from
   * seeing the reader's address.
   */
  imageProxy?: ((url: string) => string) | null;
  /**
   * The message's own embedded images: `contentId → data: URI`, minted by the engine from the
   * part's own bytes (`OhmailEngine.loadInlineImages`). A `cid:` `<img>` whose Content-ID is
   * here renders in place; one that is not stays blanked and is reported in {@link
   * SanitizedMail.cids}. Nothing is fetched by the document — the URI carries the bytes — so
   * the frame's CSP needs no widening. The values are still not trusted: {@link
   * INLINE_IMAGE_SRC} gates every one at the point of use, so a caller wired to something other
   * than the engine cannot smuggle a `javascript:` or `data:text/html` into a src through this
   * map.
   */
  cidImages?: ReadonlyMap<string, string> | null;
  /**
   * MAY A TRACKING PIXEL TAKE THE PROXY TOO? `false` — the default, and the only value this file
   * ever assumed until the account switch existed (mail 0072) — keeps `pixel` overriding `proxy`:
   * a beacon is blanked whatever else loads. `true` hands a classified pixel to {@link imageProxy}
   * like any picture. It is a modifier ON the proxy, never a source of one: with `imageProxy` null
   * nothing loads in either position, so a client with no proxy cannot leak by setting it.
   */
  loadPixels?: boolean;
}

export interface SanitizedMail {
  /** The body markup, ready to be put in a frame. Never stored, never sent anywhere. */
  html: string;
  /** Every remote resource the sender named and we refused. */
  blocked: BlockedAsset[];
  /**
   * Remote STYLESHEETS, kept apart from {@link blocked} rather than mixed into it.
   *
   * `blocked` is what the "Show images" affordance would load; a sheet can never be loaded
   * through an image proxy, so an entry there would make that button lie about what it does.
   * It is still counted and still said, because an `@import`-only newsletter arrives unstyled
   * and a reader with no sentence to read has been failed twice.
   */
  sheets: string[];
  /**
   * IS THIS MAIL WORTH INVERTING? The one input to dark viewing, decided from the document
   * — see {@link effectiveBackground}. `true` for mail that is effectively light (including
   * the common case of a mail that declares no background at all); `false` for mail a sender
   * already drew dark, which the filter must leave alone or it turns white.
   *
   * It is a property of the SANITIZED mail rather than a separate pass over the raw html so
   * that the answer is about the document the frame will actually build.
   */
  light: boolean;
  /**
   * MAY THIS MAIL BE LAID OUT AT THE COLUMN'S WIDTH INSTEAD OF SHRUNK TO IT? The one input to
   * the reflow path — see {@link isRigidLayout} for the rule and for why there are two classes.
   *
   * `true` for mail that declares no fixed canvas, which is most mail. `false` for the
   * fixed-width newsletter grid, which keeps the scale-to-fit it has always had.
   *
   * It travels with the sanitized result for the same reason {@link light} does: it is a
   * reading of THIS document, and the component would otherwise have to re-parse the html.
   */
  reflow: boolean;
  /**
   * Is this a letter rather than a layout? The one input to the frameless path. `true` means the
   * component may skip the iframe and render in the app's own type — {@link rich} when the walker
   * produced it, the text part otherwise. It never means the sanitized html string may be inlined:
   * this flag chooses between two SAFE renderings. No longer equal to {@link reflow}: `reflow`
   * means "no FIXED canvas" (the only mail that must scale-to-fit); `prose` means "no design at
   * all" — a responsive canvas or a nested layout grid ({@link isDesignedLayout}) keeps its frame,
   * reflowed at the column, because the app's table typography would draw a border around every
   * layout cell of a design that draws none.
   */
  prose: boolean;
  /**
   * THE NATIVE RICH RENDERING of a prose mail — {@link buildRichNodes}' walk of the sanitized
   * document, or `null`. `null` on a rigid mail (the frame renders it), on a walk past
   * {@link MAX_RICH_NODES}, and on a document with no usable structure; in every `null` case
   * the prose path renders the TEXT PART, which is what it always rendered. It is DATA, not
   * markup: text runs and constructed attributes, rendered by `BodyText` element by element —
   * the serialized {@link html} string never reaches the app document on any path.
   */
  rich: BodyNode[] | null;
  /**
   * The paper {@link light} was decided from, or `null` when the mail declared none. Carried
   * for the tests and for anyone debugging a message that inverted when it should not have;
   * nothing in the render path reads it.
   */
  background: Rgb | null;
  /**
   * The Content-IDs of every `cid:` image this document references and could NOT resolve —
   * distinct, in document order, still rendered as blanked boxes. The component reports them
   * so the shell can fetch exactly these parts and re-run the pass with
   * {@link SanitizeOptions.cidImages} filled; a document whose references all resolved (or
   * that has none) carries an empty array, which is what makes the fetch effect terminate.
   */
  cids: string[];
  /**
   * The html part was past {@link MAX_HTML_CHARS} and was not rendered at all. Present only
   * in that case, so an ordinary message carries no flag to test.
   */
  oversize?: true;
}

/**
 * The floor under the main thread — not a performance preference.
 * Everything below runs synchronously inside `useMemo`, on the thread that
 * paints the app: linear is a claim about the shapes measured; a cap is a
 * claim about the shape nobody has measured yet. Crossing it renders the
 * text part with {@link COPY.oversize} saying why — honest; hanging is not
 * an outcome. 512 KiB is deliberately generous: `prepareHtmlForStorage`
 * cuts stored html at 256 KiB, so this exists for the path that skips
 * storage and for the day that cap moves.
 */
export const MAX_HTML_CHARS = 512 * 1024;

/** True when this environment has a DOM the sanitizer can parse with. */
export function sanitizerAvailable(): boolean {
  return typeof window !== "undefined" && DOMPurify.isSupported === true;
}

/**
 * Sanitize one message's html. Returns markup, not a document ({@link buildMailDocument} wraps
 * it); throws nothing — unparseable input yields empty markup and the text part renders. One
 * rule, which replaced a DOMPurify hook that shipped a mutation-XSS by editing sanitizer output
 * as TEXT (`<style>` serializes raw — {@link CUT}): text is rewritten only BEFORE
 * `purify.sanitize`, so an invented shape is markup the sanitizer refuses; after it only
 * ATTRIBUTES change, over the document the frame will have (the hook missed injected `<a>`s; an
 * attribute write cannot re-open the parser). `RETURN_DOM: true` avoids a second parse.
 */
export function sanitizeMailHtml(html: string, opts: SanitizeOptions = {}): SanitizedMail {
  const blocked: BlockedAsset[] = [];
  const sheets: string[] = [];
  const proxy = opts.imageProxy ?? null;
  const cidImages = opts.cidImages ?? null;
  // Strictly `=== true`: an absent option, `undefined` and anything else all mean BLOCK.
  const loadPixels = opts.loadPixels === true;
  // The unresolved `cid:` references — distinct, in document order. See {@link SanitizedMail.cids}.
  const cids: string[] = [];
  const cidsSeen = new Set<string>();
  const recordCid = (cid: string): void => {
    if (cidsSeen.has(cid)) return;
    cidsSeen.add(cid);
    cids.push(cid);
  };

  // `light: true`, `reflow: false` and `prose: false` on both refusals are not readings of
  // anything — neither path renders a frame, so nothing consults any of them. They are stated
  // rather than left optional so the fields are total. `prose: false` in particular is the
  // conservative side: these branches produce no document to have read, and a `true` here would
  // send an unparseable message down the frameless path on the strength of nothing.
  if (!sanitizerAvailable()) {
    return { html: "", blocked, sheets, light: true, reflow: false, prose: false, rich: null, background: null, cids };
  }
  if (html.length > MAX_HTML_CHARS) {
    return { html: "", blocked, sheets, light: true, reflow: false, prose: false, rich: null, background: null, cids, oversize: true };
  }

  const seen = new Set<string>();
  const record = (url: string, via: BlockedAsset["via"], pixel: boolean): void => {
    const key = `${via}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocked.push({ url, host: hostOfUrl(url), via, pixel });
  };
  const recordSheet = (url: string): void => {
    if (!sheets.includes(url)) sheets.push(url);
  };

  /**
   * `<style>` LIVES IN `<head>`, AND THE SANITIZER ONLY EVER SEES `<body>`. DOMPurify parses into a body context and
   * returns the body's content, so a stylesheet in the head is silently dropped — which would mean every designed
   * mail arrives unstyled and the whole point of rendering html is lost. So the styles are moved into the body first,
   * in source order, where `<style>` is still valid html and the sanitizer can see them. The head is otherwise
   * discarded, which is how `<base href>` and `<meta http-equiv= refresh>` leave — and they are also in {@link
   * FORBID_TAGS}, because "the parser happened to put it somewhere we throw away" is not a rule anybody can rely on.
   */
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const headStyles = [...parsed.head.querySelectorAll("style")];
  for (const s of headStyles.reverse()) parsed.body.insertBefore(s, parsed.body.firstChild);

  const purify = DOMPurify;

  /**
   * What replaces a remote `url()` in css: the proxy when the reader has consented and the url is not beacon-shaped,
   * `null` (⇒ `none`) otherwise. A css `url()` in a STYLESHEET has no width or height to inspect, so {@link
   * BEACON_PATH} is the only signal there. On an `<img>`'s own inline `style` there IS one, and `declaresPixel` is
   * passed in as `tiny` — otherwise a 1×1 image whose beacon hides in a css background classifies as a picture. That
   * asymmetry is the reason this is a named function rather than an inline lambda: the img branch and this one must
   * agree that a beacon is never fetched, and one place saying it is easier to keep true than two.
   */
  const cssUrl = (url: string, tiny = false): string | null => {
    const beacon = tiny || BEACON_PATH.test(url);
    record(url, "css", beacon);
    // `loadPixels` lifts the beacon override and nothing else — the proxy is still the only road.
    return proxy && (!beacon || loadPixels) ? proxy(url) : null;
  };

  /**
   * THE POST-PASS, ONE ELEMENT AT A TIME. Attributes only — see the header of this function
   * for why that is the line and not a coincidence. It runs over the FINAL document, so what
   * it annotates is what the reader gets, however that element came to be there.
   */
  const onAttributes = (node: Element): void => {
    const tag = node.tagName.toLowerCase();

    // Decided FIRST, and used by both the style-attribute rewrite below and the img branch, so
    // the answer cannot depend on which of them happens to run first.
    const pixel =
      tag === "img" && (declaresPixel(node) || BEACON_PATH.test(node.getAttribute("src") ?? ""));

    neutraliseStyleAttr(node, (url) => cssUrl(url, pixel));

    // A background image is a picture, and dark viewing must not negate it. The dark filter
    // inverts everything under it, and {@link FRAME_CSS} negates `img` back so photographs and
    // logos keep their real colours; an element painted with a CSS background image is the same
    // picture by another spelling, so it is MARKED here and counter-inverted by the sheet. Only
    // a surviving `url()` counts: the rewrite above has turned every REMOTE one into `none`, so
    // what is left is `data:` (and `cid:`) — rare, and written for the case where it is not,
    // because the shape it fixes is a logo band rendering as its own photographic negative.

    // The artifact this buys, named rather than discovered later: a filter applies to an
    // element AND its descendants, so counter-inverting a box with both a background image and
    // text puts that TEXT back to its original colour too — dark ink on a dark surface; CSS
    // cannot invert a box's background and not its content. The trade is deliberate: a hero
    // banner whose picture is its point reads correctly and its overlaid caption reads worse,
    // which is better than the banner arriving as a negative. Same escape as everywhere in this
    // transform — the reader can drop the message back to its original colours.
    const styled = node.getAttribute("style");
    if (styled && /background[^:;]*:[^;]*url\(/i.test(styled)) {
      node.setAttribute("data-ohmail-bgimg", "1");
    }

    // `background="…"` on <body>/<table>/<td> is html 3.2 and bulk mail still emits it.
    // Dropped rather than rewritten even under consent: it is a deprecated attribute with no
    // reliable layout meaning left, and nothing in the last fifteen years of mail depends on
    // it rendering. Counted, so the bar still says it was there.
    const bg = node.getAttribute("background");
    if (bg) {
      node.removeAttribute("background");
      if (REMOTE_URL.test(bg)) record(bg, "attr", BEACON_PATH.test(bg));
    }

    if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      // `srcset` is a second, independent way to name a remote image and a blocker that
      // only reads `src` leaves it fetchable. It is dropped whole rather than parsed:
      // there is no consent story for a candidate set.
      const srcset = node.getAttribute("srcset");
      if (srcset) {
        node.removeAttribute("srcset");
        for (const cand of srcset.split(",")) {
          const u = cand.trim().split(/\s+/)[0];
          if (u && REMOTE_URL.test(u)) record(u, "img", pixel);
        }
      }
      if (REMOTE_URL.test(src)) {
        record(src, "img", pixel);
        // A BEACON IS NEVER FETCHED, NOT EVEN AFTER CONSENT, NOT EVEN THROUGH THE PROXY: Found by driving a real
        // browser at a live newsletter with consent granted: the beacon went through the proxy alongside the
        // message's real images. That is not a leak of the READER — the proxy's url-only signature means their IP
        // never travels — but the ESP still learns that this message was opened, at that minute, because somebody
        // asked. "Show images" is a request for the pictures; nobody consents to a beacon, and there is no image
        // behind one to show. So `pixel` overrides `proxy`. It is decided from the two signals in the message itself
        // ({@link declaresPixel}, {@link BEACON_PATH}) and it can therefore be wrong in one direction: a 1×1 image
        // that is genuinely a spacer stays blank. That costs a reader nothing.

        // UNLESS THE ACCOUNT SAID OTHERWISE (mail 0072): `loadPixels` is the reader's own switch, off by default, and
        // it lifts exactly this override: a classified beacon then takes the proxy like any picture. It cannot widen
        // anything else — with no proxy it is inert, and the CSP still admits only the proxy's own path, so a beacon
        // that reached the document by another route fetches nothing.
        if (proxy && (!pixel || loadPixels)) {
          node.setAttribute("src", proxy(src));
        } else {
          node.setAttribute("src", BLANK_GIF);
          node.setAttribute("data-ohmail-blocked", "1");
        }
        // WHAT THIS IMAGE WAS JUDGED TO BE, kept on the element because `data-ohmail-blocked`
        // cannot answer it: under the manual mode a picture and a beacon are both blanked and
        // both carry that marker, so a reader of the final document could not tell "this message
        // shows nothing" from "this message shows a photograph the reader has not asked for yet".
        // The COMPONENT asks that question from `blocked[].pixel` rather than from the document
        // (see the render branch's `showsPicture`); this attribute is the same fact spelled onto
        // the element, for a reader of the frame's own document. A sender's own copy of it cannot
        // survive `ALLOW_DATA_ATTR: false` — the single gate the anti-phishing markers rely on.
        if (pixel) node.setAttribute("data-ohmail-pixel", "1");
      } else if (CID_URL.test(src)) {
        // ── AN EMBEDDED IMAGE RESOLVES FROM THE MESSAGE'S OWN BYTES, OR STAYS BLANK ───────
        //
        // A `cid:` names a part of this very message; it cannot phone home, so resolving it
        // costs the sender nothing to learn and the reader their own signature logos, pasted
        // screenshots and embedded receipts. The caller supplies the bytes as `data:` URIs
        // (the engine fetched them from the part itself — never from any url the sender wrote)
        // and this branch does exactly one thing with them: an ATTRIBUTE write, the only kind
        // of write the post-pass is allowed. {@link INLINE_IMAGE_SRC} gates every value, so a
        // map entry that is not a small-raster data: URI blanks exactly like a missing one.
        const cid = cidOfSrc(src);
        const resolved = cid ? cidImages?.get(cid) : undefined;
        if (cid && resolved && INLINE_IMAGE_SRC.test(resolved)) {
          node.setAttribute("src", resolved);
        } else {
          if (cid) recordCid(cid);
          node.setAttribute("src", BLANK_GIF);
          node.setAttribute("data-ohmail-embedded", "1");
        }
      } else if (!src.startsWith("data:")) {
        // Anything relative. It cannot be resolved from here, and a browser renders an
        // unresolvable src as a broken-image glyph in the middle of the mail.
        node.setAttribute("src", BLANK_GIF);
        node.setAttribute("data-ohmail-embedded", "1");
      }
      return;
    }

    if (tag === "a") {
      // Already filtered by `ALLOWED_URI_REGEXP`: a `javascript:` href arrives here as the
      // empty string because DOMPurify removed the attribute. Re-reading the same constant
      // is what turns "no usable destination" into something a reader can SEE — the link
      // stays on screen, struck through, saying so — instead of a live-looking link that
      // does nothing when pressed.
      const href = (node.getAttribute("href") ?? "").trim();
      if (!SAFE_HREF.test(href)) {
        node.removeAttribute("href");
        node.setAttribute("data-ohmail-inert", "1");
        return;
      }
      // Forced, not defaulted. A link with no target navigates the FRAME, which would
      // replace the message with the destination — and would do it without the sandbox's
      // top-navigation permission, so the app would look like it had eaten itself.
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
      const host = REMOTE_URL.test(href) ? hostOfUrl(href) : "";
      if (host) {
        node.setAttribute("data-ohmail-host", host);
        node.setAttribute("title", `Goes to ${host}`);
        if (textDisagreesWithHref(node.textContent ?? "", host)) {
          node.setAttribute("data-ohmail-elsewhere", "1");
        }
      }
    }
  };

  /**
   * Data table or layout table — decided here, because CSS inside the frame cannot. The reflow sheet needs two
   * opposite wrapping rules for one element: a LAYOUT cell needs `overflow-wrap:anywhere`, or one long tracked link's
   * min-content forces the whole letter into a sideways scroll; a DATA cell — an invoice line — needs the opposite,
   * because `anywhere` lets auto table layout crush the table and split the values themselves ("3,528.00" rendered as
   * "3,528." over "00" on a 390px walk). No selector can tell those apart, so the document has to say which is which:
   * an ATTRIBUTE, `data-ohmail-datatable`, the only kind of write the post-pass may perform. A sender's own copy of
   * the stamp dies at `ALLOW_DATA_ATTR: false`, and this classifier re-decides from shape alone.
   */

  /**
   * What counts as data — each clause a real mail shape: it nests no table (nesting is how layout grids are BUILT,
   * and a wrapper is a wrapper whatever its cells look like); two-plus rows and columns (a single row or column has
   * no alignment to protect); then any of a header row (`th` is a sender saying "these are fields"), a declared
   * border grid (`border="1"` is how bulk invoices draw one), or every cell being short text without block children.
   * The costs are asymmetric by design: data-read-as-layout keeps today's behaviour (a value may split);
   * layout-read-as-data costs a sideways scroll on that letter — so the block-content and length checks hold the
   * second, worse error down: a cell holding a `div`, `p` or picture is composing a page, and a cell past 120
   * characters is a sentence whatever it is wearing.
   */

  /**
   * `test/message-body-tables.test.ts` holds all of it, forged stamps included.
   */
  const DATA_CELL_MAX_CHARS = 120;
  const markDataTables = (root: Element): void => {
    for (const table of root.querySelectorAll("table")) {
      if (table.querySelector("table")) continue;
      const rows = table.querySelectorAll("tr");
      if (rows.length < 2) continue;
      let cols = 0;
      for (const row of rows) cols = Math.max(cols, row.children.length);
      if (cols < 2) continue;
      const border = Number.parseInt(table.getAttribute("border") ?? "0", 10);
      let data = table.querySelector("th") !== null || (Number.isFinite(border) && border > 0);
      if (!data) {
        data = true;
        for (const cell of table.querySelectorAll("td")) {
          if (
            cell.querySelector("div,p,img,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,hr") ||
            (cell.textContent ?? "").trim().length > DATA_CELL_MAX_CHARS
          ) {
            data = false;
            break;
          }
        }
      }
      if (data) table.setAttribute("data-ohmail-datatable", "1");
    }
  };

  /**
   * ── THE PRE-PASS. THE ONLY TEXT REWRITE IN THIS FILE, AND IT IS UPSTREAM OF EVERYTHING ──
   *
   * Every `<style>` in the document, not just the ones in `<body>`: the hoist above moved the
   * head's stylesheets as NODES, so a single walk covers both and there is no second path to
   * remember. Whatever this produces is a STRING the sanitizer then parses, which is what
   * makes "the sanitizer has the last word" a property of the arrangement rather than a
   * promise — see the comment on the `sanitize` call below, which is where that property
   * actually lives.
   */
  let styleText = "";
  for (const el of parsed.querySelectorAll("style")) {
    el.textContent = neutraliseCss(el.textContent ?? "", (u) => cssUrl(u), recordSheet);
    // Accumulated for {@link effectiveBackground} only, and it is the NEUTRALISED text — the
    // sheet the frame is going to get — so the paper this reads is the paper the reader sees.
    styleText += `${el.textContent}\n`;
  }

  /**
   * ── THE ARGUMENT IS A STRING, AND THAT IS THE LOAD-BEARING PART ─────────────────────────
   *
   * DOMPurify also accepts a NODE (`purify.cjs.js:2291-2296`), and with `RETURN_DOM` it would
   * work — which is why this is written down rather than left to look like a style choice.
   * Handing it `parsed.body` moves the serialize/reparse round-trip from INSIDE the sanitizer
   * to the caller's own `innerHTML` at the end, and a `<style>` text the pre-pass rewrote
   * would then reach the frame without the sanitizer ever having parsed it — the mutation-XSS
   * this file was rearranged to close, restored by a one-token edit that typechecks.
   */
  const sanitized = purify.sanitize(parsed.body.innerHTML, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP: SAFE_HREF,
      ADD_URI_SAFE_ATTR: PRESENTATION_ATTR,
      // `FORCE_BODY` IS WHY THE SENDER'S STYLESHEET SURVIVES AT ALL: Without it, DOMPurify's own `DOMParser` pass
      // hoists a leading `<style>` into `<head>` — the html parser's ordinary behaviour — and DOMPurify returns
      // `body.innerHTML`, so the stylesheet is silently gone. Measured against dompurify 3.4.13:
      // `<style>.a{color:red}</style><p>hi</p>` sanitized to `<p>hi</p>` under FOUR different configurations,
      // including one that named `style` in `ALLOWED_TAGS` and emptied `FORBID_CONTENTS`. With `FORCE_BODY: true` the
      // same input keeps the style. It is the difference between "mail renders like mail" and "every designed message
      // arrives as a single unstyled column", and no security assertion notices.

      // Safe here for the reason the whole shape is safe: the stylesheet lands in a sandboxed frame with `default-src
      // 'none'`, where it can neither fetch nor escape. DOMPurify's own mXSS rule still removes a `<style>` whose
      // text contains element markup (measured: `<style><img src=x onerror=…></style>` → empty string) — and since
      // the pre-pass above, the text that rule inspects is the NEUTRALISED text, which is the text the frame is going
      // to get. Before, it inspected a string nobody shipped.
      FORCE_BODY: true,
      // `ALLOW_DATA_ATTR: false` IS THE GATE ON MARKER FORGERY, AND IT IS THE ONLY ONE: Everything this file marks up
      // with — `data-ohmail-host`, `data-ohmail-elsewhere`, `data-ohmail-inert`, `target`, `rel` — is written by the
      // post-pass, which runs AFTER DOMPurify has filtered every attribute, so none of them needs to be allowed here.
      // A SENDER'S copy of them must not survive: `<a href="mailto:x@y" data-ohmail-host= A `mailto:` has no host, so
      // the post-pass cannot overwrite a forged `data-ohmail-host` on one — this line is the ONLY thing that refuses
      // it, and the post-pass deliberately does not clear markers it did not set: a second removal would leave this
      // flag unwatchable (deleting either would keep the suite green).

      // Measured: adding `ADD_ATTR: ["data-ohmail-host", "target"]` leaves the suite GREEN (the post-pass overwrites
      // both on any http(s) link); flipping THIS to `true` goes red. The mutation in `test/message-body.test.ts` is
      // therefore on this flag, and the fixture is a `mailto:`.
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: true,
      KEEP_CONTENT: true,
      RETURN_DOM: true,
    }) as unknown as HTMLElement | null;

  // `IS_EMPTY_INPUT` returns null under `RETURN_DOM`, which is a message with no html left.
  if (!sanitized) return { html: "", blocked, sheets, light: true, reflow: false, prose: false, rich: null, background: null, cids };

  // ── THE POST-PASS. Over the document the frame will have, not the one we handed over. ──
  for (const node of sanitized.querySelectorAll("*")) onAttributes(node);
  markDataTables(sanitized);

  // Read AFTER the post-pass, from the final document, for the same reason the post-pass runs
  // there: what the reader is shown is what this must be an answer about. Both are READS — the
  // post-pass above is the last thing that writes, and it writes attributes only, which is the
  // rule this whole function is arranged around.
  const background = effectiveBackground(parsed.body, sanitized, styleText);
  // The divergence `prose` reserved room for: `reflow` still answers
  // `isRigidLayout` alone (a fixed canvas must be scaled); `prose` answers
  // "did the sender lay something out?" — rigid OR designed keeps its
  // frame, only the letter is set in the app's type. Both classifiers read
  // the SANITIZED document's own sheets — DOMPurify drops a `<style>` whose
  // text smells of markup, and a canvas living only in a dropped sheet is
  // one the rendered document has not got. Both scans take the sheets one
  // element per entry, rule-wise through {@link sheetsDeclare}: a joined
  // view manufactured declarations across sheet EOFs, and a flat regex
  // read comment text as canvas evidence.
  const sanitizedSheets = [...sanitized.querySelectorAll("style")].map((s) => s.textContent ?? "");
  const rigid = isRigidLayout(sanitized, sanitizedSheets);
  const designed = rigid || isDesignedLayout(sanitized, sanitizedSheets);
  return {
    html: sanitized.innerHTML,
    blocked,
    sheets,
    light: mailIsLight(background),
    reflow: !rigid,
    prose: !designed,
    // THE WALK RUNS ON THE SAME ELEMENT the line above is about to serialize — the sanitized,
    // post-passed document — and only for a mail the frame will not render. What it emits is
    // data (text runs, bounded ints, gated hrefs); the serialized string stays the frame's.
    rich: designed ? null : buildRichNodes(sanitized),
    background,
    cids,
  };
}

// ── the document ───────────────────────────────────────────────────────────────────────

/**
 * A url this file hands the proxy purely so the proxy will mint one back. Never fetched, and
 * never in a document — {@link proxyImgSource} reads the SHAPE of the answer and discards it.
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so a mistake here fetches nothing.
 */
const CSP_PROBE_URL = "https://csp-probe.invalid/probe.png";

/**
 * A CSP `host-source` this file is willing to write into a double-quoted `<meta content="…">`. A syntax
 * gate, not a policy one — the source is derived from a caller's function. Two characters would be
 * catastrophic and both are legal in a url path: `;` ends the directive (a path could append `script-src
 * 'unsafe-inline'`) and `"` ends the attribute. `URL` percent-encodes the second and NOT the first — the
 * asymmetry that is easier to refuse than remember. So the shape is a positive list: scheme, host,
 * optional port, a path of unreserved characters and `/`. `%` is excluded too — CSP matches after
 * percent-decoding, so an encoded path is a second spelling of the same source. Anything else answers
 * `null`, which is the blocked policy ({@link proxyImgSource}).
 */
const CSP_HOST_SOURCE = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/[A-Za-z0-9._~/-]*$/;

/**
 * The one url the frame may fetch, as a CSP source — or `null`: fetch nothing. Not `'self'`
 * (every url on this origin): twice a url the sanitizer left behind resolved against the
 * embedder into an authenticated same-origin GET the old policy permitted. Naming the PATH ends
 * the family — both prior fixes become redundant. Measured in Chromium: exact path matches
 * (query/fragment ignored); prefixes and case variants blocked; `%`-spellings match after
 * decoding ({@link CSP_HOST_SOURCE} refuses `%`). The redirect hole is closed at the proxy
 * (never 3xx, mutation-watched). Minted via the caller's proxy fn ({@link CSP_PROBE_URL});
 * fail-closed null.
 */
export function proxyImgSource(proxy: (url: string) => string, pageOrigin: string): string | null {
  let minted: string;
  try {
    minted = proxy(CSP_PROBE_URL);
  } catch {
    return null;
  }
  let origin: string;
  try {
    origin = new URL(pageOrigin).origin;
  } catch {
    return null;
  }
  let u: URL;
  try {
    // The proxy's own url may be root-relative (`/api/img?…`) or absolute; both resolve here
    // exactly as the browser resolves the `src` this same function will write, which is the
    // whole point of deriving the source from it.
    u = new URL(minted, origin);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.origin !== origin) return null;
  const source = `${u.origin}${u.pathname}`;
  return CSP_HOST_SOURCE.test(source) ? source : null;
}

/**
 * The frame's own Content-Security-Policy. THIS IS THE ENFORCEMENT: everything above is presentation and accounting;
 * this line makes "opening a message fetches nothing" true for the remote-reference shape nobody has thought of — an
 * allow-list of `data:` over a `default-src 'none'`, so an unknown vector is refused by not being mentioned.
 * `img-src` gains ONE SOURCE — the image proxy's own path, nothing else — when images are consented: the one place a
 * consented image may come from is our own proxy, which fetches server-side so the sender never sees the reader.
 * {@link proxyImgSource} decides whether such a source can be stated at all; `null` here is the blocked policy. There
 * is no policy under which this frame may name a sender's host or any other path of ours.
 */

/**
 * This policy is an INTERSECTION with the app's own, measured in Chrome: a `srcdoc` document
 * inherits the embedder's policy container. A control page rendering a real marketing message
 * RAW in a plain `srcdoc` frame under the app's CSP produced five requests, every one reported
 * `[FAILED] csp` — the open-tracking beacon among them; the same control without the app CSP
 * fetched that beacon `[200]`. So the app's `img-src 'self' data: blob:` is a real second
 * layer. The intersection is also why this directive is the ONLY place the narrowing can
 * happen: the app's policy must keep `'self'` in `img-src` (the product chrome is same-origin
 * images), so a frame that says `'self'` inherits the app's breadth rather than adding to it.
 */

/**
 * A separate cookie-less origin for the proxy is the stronger version, and it is not what was built — recorded rather
 * than dropped. The proxy's AUTHORISATION is the host-only `tf_session` cookie plus an owned `mid`
 * (`packages/api/src/routes/privacy.ts`), so a cookie-less origin has no authorisation left and would need signed
 * capability urls — new key material, new rotation, a token in a url whose query the sender chose — and it would
 * re-split the single origin `auth/origins.ts` exists to describe. The residue the path narrowing leaves is strictly
 * smaller: a sender who defeats the sanitizer reaches `/api/img` itself, which already refuses without consent,
 * without an owned `mid`, and without passing the SSRF gate — and never carries the reader's address either way.
 */

/**
 * Two more considered and refused. A `<base>` in the frame's head (so relative urls resolve somewhere dead) would
 * need `base-uri` to stop being `'none'` — a widening — to buy a second answer to a question this directive already
 * answers; this file's own rule ({@link SAFE_HREF}) is that two overlapping guards behave as neither. And a source in
 * the BLOCKED policy for a future `cid:` url: blocked-by-default is the product's central promise, and the slice that
 * resolved `cid:` references confirmed the refusal — they resolve as `data:` URIs minted from the part's own bytes
 * ({@link SanitizeOptions.cidImages}), which the blocked policy has always admitted. @param imgSource the proxy's own
 * source expression from {@link proxyImgSource}, or `null` for the blocked policy. NOT a boolean: a caller that knows
 * only "images are on" cannot say WHERE from, and that gap is what `'self'` used to paper over.
 */
export function frameCsp(imgSource: string | null): string {
  return [
    "default-src 'none'",
    `img-src data:${imgSource === null ? "" : ` ${imgSource}`}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The app's own reading size, so a reflowed mail is set in the same type as
 * the rest of the product. These two values are `.msg-body`'s
 * (`packages/ui/src/composites/message.css`), duplicated because the frame
 * is a separate document that inherits nothing — and the duplication is
 * watched: `test/message-body.test.ts` parses `.msg-body` out of that
 * stylesheet and asserts these strings against it. Base only, deliberately
 * unqualified: a sender who sets their own sizes still wins; what it fixes
 * is the mail that declares nothing.
 */
export const NATIVE_FONT_SIZE = "calc(14.5px + var(--type-up))";
export const NATIVE_LINE_HEIGHT = "1.55";

/**
 * The stylesheet the frame starts from — the sheet the letter is printed on. It must lose to
 * anything the sender declares: every rule is unqualified and none is `!important` except two
 * LAYOUT decisions — `:root,:root>body{height:auto}` (the frame is measured under a probe
 * viewport) and the reflow block (capping a declared width at the column IS the reflow; a rule
 * that lost to the sender there would do nothing). `img:not([width])` rather than a blanket
 * `img{max-width:100%}`: bulk mail lays itself out with `width=` attributes inside fixed tables,
 * and clamping those collapses the design — the clamp is for the pasted 4000 px photograph,
 * which never carries a width attribute.
 */
const FRAME_CSS = `
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
/* THE ONE !important IN THIS FILE, and it is a MEASUREMENT rule rather than a style
   preference: the frame is measured under a fixed probe viewport, so a sender's body{height:100%}
   would report the probe's height and clip a 2000px mail to it. It is no longer what stops the
   runaway — see measure() — which is why it can now afford to lose a fight it once had to win.
   :root rather than html on purpose: a sender's html,body{height:300vh!important} is equal
   specificity and LATER in the document, so it used to win outright. Chrome, not theory. */
:root,:root>body{height:auto !important}
/* THE PAPER. --ohmail-paper is the mail's OWN declared background when it has one (see
   effectiveBackground, and buildMailDocument, which is what sets the variable); #fff is the
   default every renderer has always used for mail that declares nothing.
   It matters most for a mail this viewer declines to invert. A sender's dark design usually
   lives on an inner wrapper table, not on a body element the sanitizer keeps — so the frame's
   own white paper showed around and beneath it, and a dark newsletter read as a white card.
   The inverted path overrides this below with #e4e4e4, which is chosen to invert to the app's
   own dark panel; specificity is what keeps the two apart, so the paper applies exactly when
   the filter does not. */
body{margin:0;padding:16px;background:var(--ohmail-paper,#fff);color:#1b1b1b;
  font:15px/1.62 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  overflow-wrap:break-word}
img{border:0}
img:not([width]){max-width:100%;height:auto}
a{color:#1a56db}
/* A blocked image keeps its space and says what it is, instead of leaving a broken glyph.
   A 1x1 beacon stays 1x1 and therefore stays invisible — a tracker must not be rewarded
   with a visible box for having tried. */
img[data-ohmail-blocked]:not([width="1"]),img[data-ohmail-embedded]:not([width="1"]){
  background:#f4f3ee;outline:1px dashed #d8d5cc;outline-offset:-1px;min-width:14px;min-height:14px}
/* WHERE A LINK ACTUALLY GOES, without a line of script — the frame has none and never will.
   Shown on hover AND on focus, because a keyboard reader is exactly the person who cannot
   see a status bar. \`title\` carries the same sentence for assistive technology. */
a[data-ohmail-host]:hover::after,a[data-ohmail-host]:focus::after{
  content:" \\2192 " attr(data-ohmail-host);font-size:.82em;opacity:.75;white-space:nowrap}
/* Said WITHOUT hovering when the visible text names one place and the link goes to another
   — the click-tracker case, which is the one an unsuspecting reader cannot see. */
a[data-ohmail-elsewhere]::after{
  content:" (" attr(data-ohmail-host) ")";font-size:.82em;opacity:.7;white-space:nowrap}
a[data-ohmail-inert]{text-decoration:line-through;opacity:.75}
/* ── DARK VIEWING, GATED ON ONE ROOT ATTRIBUTE ─────────────────────────────────────────
   The transform is a single filter on the body — invert lightness, then hue-rotate 180° so
   colours land back near where they started rather than as their complements. White paper
   becomes dark, ink becomes light. It ships in EVERY document, dormant, and is switched by
   :root[data-ohmail-dark] alone: the component sets that attribute on the LIVE frame with
   toggleAttribute (see the effect), so flipping theme never rebuilds the srcdoc and never
   re-parses or re-measures the mail. The body's own default background is a light grey that
   INVERTS to the app's dark panel, so a short mail carrying no background of its own meets
   its surround with no seam. This is a lightness transform, not a redesign: a sender who set
   a dark background gets it inverted to light, which is the known cost of the technique and
   the reason the reader can drop back to the original per message. */
:root[data-ohmail-dark] body{background:#e4e4e4;filter:invert(1) hue-rotate(180deg)}
/* THE CANVAS UNDER A SCALED MAIL, and it exists for the intersection of the two transforms
   below. The body's background normally propagates to the frame's canvas and paints the whole
   viewport — but a body that has been SCALED no longer covers the right-hand edge, and a
   propagated background is painted outside the element's own filter, so that edge would show
   #e4e4e4 as light grey beside an inverted mail. Declaring a background on :root takes over
   the propagation with a value that is already the inverse of the body's, so the strip and the
   paper match. In the unscaled case body covers the viewport and none of this is visible. */
:root[data-ohmail-dark]{background:#1b1b1b}
/* Two wrongs make a right: the body filter negated every picture, so negate the pictures
   back — real images keep their real colours while the page around them stays inverted.
   The [data-ohmail-bgimg] marker is the same picture spelled as a CSS background (see the
   post-pass, which is what sets it, and which also names the artifact this costs).
   video, svg and canvas CANNOT MATCH TODAY and are not a guard: ALLOWED_TAGS admits none of
   them, so the sanitizer removes them before this sheet is ever applied. They are named
   because this is the one place a picture's counter-inversion belongs, so that admitting one
   of those tags is a one-line change here rather than a bug found in a dark theme. */
:root[data-ohmail-dark] img,
:root[data-ohmail-dark] video,
:root[data-ohmail-dark] svg,
:root[data-ohmail-dark] canvas,
:root[data-ohmail-dark] [data-ohmail-bgimg]{filter:invert(1) hue-rotate(180deg)}
/* A blocked-image placeholder is OUR chrome, not the sender's picture. Leave it inverted
   WITH the page (filter:none cancels the re-inversion above) so its box reads as a quiet
   dark panel rather than flipping to a light one on the dark surface. */
:root[data-ohmail-dark] img[data-ohmail-blocked],
:root[data-ohmail-dark] img[data-ohmail-embedded]{filter:none}
/* ── SCALE TO FIT, GATED ON THE SECOND ROOT ATTRIBUTE ──────────────────────────────────
   A fixed-width newsletter — 600 or 700 px of table, which is most of bulk mail — is wider
   than a reading column on a narrow window, and the browser's answer is a horizontal
   scrollbar under every message. This is the other answer: lay the mail out exactly as its
   sender wrote it and shrink the RESULT to the column, which is what a phone does with a
   desktop page. Dormant in every document like the dark rules, driven by --ohmail-scale, and
   switched by :root[data-ohmail-scaled] — see measure(), which is what computes both.

   ── COMPOSITION WITH THE DARK FILTER, WHICH IS ON THIS SAME ELEMENT ──────────────────
   The body carries filter (above) and transform (here) at once whenever a wide mail is read
   in a dark theme. CSS defines that order: the element is rendered, the FILTER is applied to
   that rendering, and the TRANSFORM then maps the filtered result into the parent. Nothing
   here depends on the order holding, because a uniform scale and a per-pixel colour operation
   commute — inverting then shrinking and shrinking then inverting produce the same pixels —
   but the two must stay separate properties on one selector each. A shorthand, or a second
   rule that set filter while scaling, would silently drop one of them.

   transform-origin:0 0 because the mail must shrink toward the top-left corner it starts in;
   the default 50% 50% would pull it away from both edges and leave a margin the reader did not
   ask for. And the transform is applied ONLY when it is needed: a transform other than none
   makes the element a containing block for fixed and absolutely positioned descendants, so
   applying scale(1) unconditionally would change how ordinary mail lays out for no gain. */
:root[data-ohmail-scaled] body{transform-origin:0 0;transform:scale(var(--ohmail-scale,1))}
/* ── AND A SCALED DOCUMENT IS NOT A SCROLLER, because its overflow is not real ─────────
   A transform is a PAINT operation: it changes nothing about layout. So a scaled mail's
   \`documentElement\` keeps its full unscaled height while the frame around it is sized to the
   PAINTED extent — and the difference is scrollable overflow the reader can reach and that
   contains nothing. Measured on a collapsed Receipts card carrying a 600px newsletter grid:
   at 1440 the frame was 369px and the document 394 (scale .935), at 390 the frame was 237
   and the document 394 (scale .6, plus 56px of the same phantom sideways). A real wheel over
   that card moved the frame's own document 25px and moved the stream NOT AT ALL — the mail
   slid up inside the card and left blank behind it, which is what "the wheel lands inside an
   unexpanded message" is.

   \`overflow:hidden\` rather than the frame being made taller: the painted extent already fits
   the frame exactly, so there is nothing to show and nothing to clip. \`hidden\` keeps the
   document programmatically scrollable (anchors, \`scrollIntoView\`) while taking it out of the
   wheel's chain, which is the whole of what is wanted.

   GATED ON ITS OWN ATTRIBUTE AND NOT ON \`data-ohmail-scaled\`, because the two conditions are
   not the same one: a mail whose painted extent is past {@link MAX_FRAME_PX} really is taller
   than its frame, and that document must keep its scroller or the tail of a 20 000px mail
   becomes unreachable. \`measure()\` sets this attribute in the same statement that writes the
   height, so the two can never disagree. */
:root[data-ohmail-fitclip]{overflow:hidden}
/* ── REFLOW, GATED ON THE THIRD ROOT ATTRIBUTE ─────────────────────────────────────────
   The other answer to a mail that is wider than its column, and the one most mail should have
   been getting all along: lay it out AT the column instead of laying it out at its natural
   width and shrinking the result. Dormant in every document like the dark and scale rules, and
   switched by :root[data-ohmail-reflow] alone — see isRigidLayout(), which is what decides it,
   and measure(), which reads the same attribute back off the live root and does not fit a
   document that carries it.

   The universal selector rather than a list of tags. A width can be declared on anything, and
   an enumerated list is a list somebody has to remember to extend; max-width does not apply to
   non-replaced inline elements, so in practice this reaches exactly the boxes that can be too
   wide. It never makes anything NARROWER than its container — max-width:100% is a cap, so a
   mail that already fits is untouched by it — which is why one blanket rule is safe here and a
   blanket width:auto would not have been: that would collapse a full-width wrapper to its
   contents.

   min-width on cells because a min-width is the other way to pin a table wider than its
   container, and it beats max-width when the two disagree. table-layout:auto because a fixed
   table lays its columns out from the first row's declared widths and ignores the cap. And
   img{height:auto} because clamping a picture's WIDTH without releasing its height attribute
   is how a photograph arrives stretched.

   overflow-wrap:anywhere and not break-word, and this is the half that fixes the mail nobody
   would call wide: anywhere is the value that also reduces an element's MIN-CONTENT size, so
   one long tracked link inside an ordinary letter stops forcing the whole document wide. That
   single link is what used to make a plain message measure 900px and render at 0.6.

   TWO EXEMPTIONS FROM anywhere, both because SOME content's min-content IS the content
   (no backticks in this comment — it lives inside a template literal):

   · A DATA TABLE'S CELLS. anywhere let a four-column invoice lay out at a 290px column
     and split its own values — "3,528.00" over two lines is a different amount. Stamped
     cells (see markDataTables — the sanitizer's post-pass decides, because no selector can
     tell an invoice from the grid a letter is built of) get break-word: the same wrapping
     between words, but the longest token keeps its min-content, so a column can never get
     narrower than its widest value and a number never splits. A table that is then wider
     than the column overflows the frame's viewport, which scrolls — inside the sheet, never
     the pane (.mb's containment is about the PANE; the frame is its own document).

   · PREFORMATTED BLOCKS. pre-wrap re-flowed a stack trace's four-thousand-character
     lines and — with anywhere inherited — broke them mid-identifier, which is a different
     document exactly the way a re-flowed header dump is. The block keeps its literal
     whitespace and becomes its OWN scroll container instead, the same construction the
     native path's .msg-pre-wrap uses and for the same reason: the element allowed to be
     wide must sit inside the element that scrolls — here they are the same element, capped
     at the column by the * rule above. */
/* THE FRAME DECLARES THE SLOT ITSELF, and without this line the body renders at the browser's
   default size with every test still green.

   The re-flow frame is a SEPARATE DOCUMENT. It inherits no custom property from the shell, so the
   calc() above resolves against a --type-up that does not exist there — and an unresolvable custom
   property makes the whole declaration invalid at computed-value time, which is font-size: unset,
   not font-size: 14.5px. The mail body would silently become the browser's default.

   The frame is its own width class, so the phone step is decided here on the frame's OWN width
   rather than inherited from the shell's.

   NOTE FOR ANYONE EDITING THIS BLOCK: it is inside a JS template literal, so a backtick or a
   dollar-brace interpolation inside a CSS comment here is a syntax error in the module rather
   than a comment. Both were written here by hand and both broke the build; the second was in
   the sentence warning about the first. */
:root[data-ohmail-reflow]{--type-up:0px}
@media (max-width:640px){:root[data-ohmail-reflow]{--type-up:1px}}
:root[data-ohmail-reflow] body{font-size:${NATIVE_FONT_SIZE};line-height:${NATIVE_LINE_HEIGHT};
  overflow-wrap:anywhere}
:root[data-ohmail-reflow] *{max-width:100% !important}
:root[data-ohmail-reflow] td,:root[data-ohmail-reflow] th{min-width:0 !important}
:root[data-ohmail-reflow] table{table-layout:auto !important}
:root[data-ohmail-reflow] img{height:auto !important}
:root[data-ohmail-reflow] table[data-ohmail-datatable] td,:root[data-ohmail-reflow] table[data-ohmail-datatable] th{overflow-wrap:break-word !important}
/* \`overflow-y:hidden\` is not decoration: CSS coerces a computed \`visible\` to \`auto\` on the
   OTHER axis the moment one axis scrolls, so \`overflow-x:auto\` alone makes this block a
   VERTICAL scroll container too — and on any platform whose horizontal scrollbar takes room
   from the content box (a classic scrollbar, which is what the desktop's WebKitGTK draws) it
   then has a scrollbar's worth of vertical overflow and captures the reader's wheel. The block
   has nothing to scroll vertically — its height IS its content's — so naming the axis clips
   nothing and leaves the stream the only thing a wheel can reach. \`overscroll-behavior-x\`
   keeps a sideways gesture that reaches the block's end from turning into a history swipe.
   Same rule, same reason, on the native path's \`.msg-pre-wrap\`/\`.msg-table-wrap\`. */
:root[data-ohmail-reflow] pre{white-space:pre !important;overflow-x:auto !important;overflow-y:hidden !important;overscroll-behavior-x:contain;overflow-wrap:normal !important}
`;

/**
 * Assemble the whole `srcdoc`. A pure string function on purpose: it is what the jsdom tests assert on, while the
 * live browser test asserts on what a real engine does with it. `dark` IS ONE ATTRIBUTE AND NOTHING ELSE: The dark
 * transform lives entirely in {@link FRAME_CSS}, gated on `:root[data-ohmail-dark]`. All this option does is stamp
 * that attribute on the root element, so the light and dark documents are byte-identical apart from it — which is the
 * property that lets the live flip be a `toggleAttribute` on the frame's own `documentElement` rather than a rebuilt
 * srcdoc. `test/message-body.test.ts` pins that: strip the attribute from the dark output and it must equal the light
 * output exactly, so a dark path that wrapped or re-sheeted the body would go red.
 */
export function buildMailDocument(
  bodyHtml: string,
  /**
   * `imgSource` is the proxy's own CSP source ({@link proxyImgSource}) or `null` for "this
   * document fetches nothing". It replaced an `imagesLoaded: boolean`, and the type change is
   * the point: a caller holding a boolean knows that images are on and NOT where they may come
   * from, so the only policy it could ask for was `'self'` — every url on this origin.
   */
  opts: { imgSource?: string | null; dark?: boolean; reflow?: boolean; paper?: Rgb | null } = {},
): string {
  // The paper rides on the ROOT ELEMENT and is independent of `dark`, so the light and dark
  // builds of the same message still differ by the attribute alone — which is the equality
  // `test/message-body.test.ts` pins and the reason the live flip can be a `toggleAttribute`.
  const paper = opts.paper ? ` style="--ohmail-paper:${cssColor(opts.paper)}"` : "";
  /**
   * REFLOW IS THE SAME MECHANISM AS DARK: one attribute, a block of dormant rules. It defaults
   * OFF here rather than on, so a caller that does not classify gets exactly the document this
   * function has always built — the classification lives in {@link sanitizeMailHtml}, and a
   * default of `true` would let a caller reflow a newsletter by forgetting a field.
   *
   * It is baked into the srcdoc rather than toggled live, because unlike `dark` it is a
   * property of the DOCUMENT and not of the reader's theme: it can only change when the html
   * changes, and when the html changes the frame is rebuilt anyway.
   */
  const reflow = opts.reflow === true ? " data-ohmail-reflow=\"1\"" : "";
  return [
    `<!doctype html><html${opts.dark === true ? " data-ohmail-dark=\"1\"" : ""}${reflow}${paper}><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(opts.imgSource ?? null)}">`,
    // Belongs to the same promise as the CSP: if a consented image is ever fetched through
    // the proxy, not even the path of the page the reader is on travels with it.
    "<meta name=\"referrer\" content=\"no-referrer\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    `<style>${FRAME_CSS}</style></head><body>`,
    bodyHtml,
    "</body></html>",
  ].join("");
}

/** The sandbox tokens, as one string, so the test and the element read the same source. */
export const FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * THE VIEWPORT EVERY MEASUREMENT IS TAKEN UNDER — a constant, which is the entire point.
 *
 * `vh`, `vw` and a percentage height all resolve against the frame's own box, and that box is
 * what this component WRITES. Pinning it to one number for the duration of the read turns the
 * measurement into a pure function of the content, so there is no loop to damp. 600 px is
 * chosen to be a plausible reading viewport rather than a degenerate one: `100vh` in a mail
 * then renders as something a person would recognise, and `0` would collapse it.
 */
const PROBE_PX = 600;

/**
 * THE CEILING, AND THE SENDER HAS NO SAY IN IT.
 *
 * Measured on the shipped build: a `150vh` child drove `frame.style.height` to 33 554 400 px
 * and the host page's `scrollHeight` to 33 554 432. {@link PROBE_PX} is what stops that
 * arithmetic; this is what stops the arithmetic nobody has thought of. 20 000 px is roughly
 * twenty-five screens — past any newsletter, short of anything that hurts.
 */
const MAX_FRAME_PX = 20_000;

/**
 * HOW SMALL THE MAIL MAY BE SHRUNK BEFORE FITTING STOPS BEING WORTH IT. Scale-to-fit trades size for the absence of a
 * horizontal scrollbar, and past a point that trade is a bad one: a 1 200 px poster in a 390 px column is a scale of
 * 0.32, which renders 15 px body text at under 5 px — present, technically un-scrolled, and unreadable. So the scale
 * is CAPPED at the floor rather than the fit, and whatever still does not fit gets the horizontal scroll it was
 * always going to get. Readability wins over fit. 0.6 is chosen against the shape this exists for: the fixed-width
 * newsletter. 600 px and 700 px are what bulk mail is built at, and the narrowest reading column this app produces is
 * around 390 px — so 390/700 = 0.56 … 390/600 = 0.65, and the common cases land at or just under the floor while
 * anything pathological is refused outright.
 */
export const MIN_FIT_SCALE = 0.6;

/**
 * The uniform scale that fits `naturalPx` of content into `columnPx` of column — 1 when it
 * already fits, and never below {@link MIN_FIT_SCALE}.
 *
 * SEPARATED FROM {@link measure} ON PURPOSE. jsdom performs no layout, so every number the
 * measurement reads is 0 there and the fitting can only be proven in a real engine — except
 * for this, which is arithmetic and is watched in the unit suite. What the browser check has
 * to prove is that the right numbers reach it.
 *
 * A zero or negative reading (a frame that is not laid out, a detached document, jsdom) is 1:
 * "do not scale" is the only safe answer to "I could not measure", and it is what keeps this
 * from writing a transform under the unit suite.
 *
 * ── `reflow` IS THE FIRST TERM, AND IT IS AN ANSWER RATHER THAN A HINT ──────────────────
 *
 * A reflowed mail has already been laid out at the column's width (see the reflow block in
 * {@link FRAME_CSS}), so a scale is not a second-best fit for it — it is a shrink applied to a
 * document that already fits, which is exactly the reported defect. There is deliberately no
 * "reflow first, then scale whatever still overflows" fallback: that would put every mail back
 * one long word away from being rendered at 0.6, and the residual case is a genuinely wide
 * element (a data table, a code block) which gets a scrollbar and stays readable. Readability
 * wins over fit here for the same reason {@link MIN_FIT_SCALE} exists.
 *
 * The term lives HERE and not in {@link measure} so that the decision is arithmetic that a unit
 * test can watch fail. Deleting it leaves a simple mail scaled, and the guard goes red.
 */
export function fitScale(columnPx: number, naturalPx: number, reflow = false): number {
  if (reflow) return 1;
  if (!Number.isFinite(columnPx) || !Number.isFinite(naturalPx)) return 1;
  if (columnPx <= 0 || naturalPx <= 0) return 1;
  if (naturalPx <= columnPx) return 1;
  return Math.max(MIN_FIT_SCALE, columnPx / naturalPx);
}

/**
 * THE SCROLLABLE ANCESTORS OF THE FRAME, nearest first, plus the document scroller. {@link measure} sizes the frame
 * by briefly SHRINKING it to {@link PROBE_PX}. Anything that scrolls above the frame — the reading pane, the app
 * column, the page itself — has its own `scrollHeight` drop by the difference the instant the frame shrinks, and the
 * browser clamps that element's `scrollTop` to the new, smaller maximum during the forced layout the probe read
 * triggers. Restoring the frame's height does NOT unclamp it.
 */

/**
 * These are the elements whose `scrollTop` the probe must capture and put back, or a reader who has scrolled down is
 * yanked toward the top on every reflow: every remote image that loads, every column resize. jsdom performs no
 * layout, so `scrollHeight`/`clientHeight` are both 0 there and this returns `[]` — the whole preservation is a no-op
 * under the unit suite and only does work in a real engine, which is why #95's acceptance is a browser check, not a
 * jsdom one.
 */
function scrollAncestors(el: Element): Element[] {
  const out: Element[] = [];
  let node: Element | null = el.parentElement;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (
      (oy === "auto" || oy === "scroll" || oy === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      out.push(node);
    }
    node = node.parentElement;
  }
  const se = el.ownerDocument.scrollingElement;
  if (se && !out.includes(se) && se.scrollHeight > se.clientHeight) out.push(se);
  return out;
}

/**
 * WHAT THE BAR SAYS ABOUT WHAT WAS REFUSED — composed once, read twice. The bar above a framed message and the glyph
 * in a stream card's head state the SAME fact from the SAME terms, and this is the one place the sentences are
 * chosen, so the two can never disagree. `lead` is the images-or-beacons sentence, `hit` the "one of them is a
 * tracking pixel" that rides inside an images sentence (the bar sets it in the accent), `sheet` the stylesheet
 * sentence, said LAST, ALWAYS: the browser-level test of the bar reads the FIRST number in it and holds that against
 * the remote images the message names, and a stylesheet count in front would make that guard measure the wrong thing.
 * `spaceBeforeSheet` is the bar's exact separator rule — a space whenever the message named remote images, even where
 * the loaded modes left `lead` unsaid.
 */

/**
 * `pixelSaid` is whether the lead sentence itself is a beacon sentence, kept as a fact rather than re-derived from
 * the strings: the caption a host shows is decided from it, and a string comparison against a translated sentence is
 * not a decision. Every member reads `COPY`, so the answer follows the active catalogue like the bar always did.
 */
interface BlockedSaid {
  lead: string | null;
  pixelSaid: boolean;
  hit: string | null;
  sheet: string | null;
  spaceBeforeSheet: boolean;
}

function sayBlocked(t: {
  remote: readonly BlockedAsset[];
  sheets: readonly string[];
  pixels: number;
  remoteShown: boolean;
  pixelsRefused: number;
}): BlockedSaid {
  const { remote, sheets, pixels, remoteShown, pixelsRefused } = t;
  let lead: string | null = null;
  let pixelSaid = false;
  if (remote.length > 0) {
    if (remoteShown) {
      /* The pictures are on screen; only the refused beacons are left to report. */
      if (pixelsRefused > 0) {
        lead = pixelsRefused === 1 ? COPY.pixelOnly : COPY.pixelsRefusedMany(pixelsRefused);
        pixelSaid = true;
      }
    } else if (remote.length === pixels && pixels > 0) {
      lead = COPY.pixelOnly;
      pixelSaid = true;
    } else {
      lead = remote.length === 1 ? COPY.blockedOne : COPY.blockedMany(remote.length);
    }
  }
  const hit =
    !remoteShown && pixels > 0 && remote.length !== pixels
      ? pixels === 1 ? COPY.pixelOne : COPY.pixelMany(pixels)
      : null;
  const sheet =
    sheets.length > 0 ? (sheets.length === 1 ? COPY.sheetOne : COPY.sheetMany(sheets.length)) : null;
  return { lead, pixelSaid, hit, sheet, spaceBeforeSheet: remote.length > 0 };
}

/** Stable empties for the renders where there is no sanitized document to read them from. */
const NO_ASSETS: readonly BlockedAsset[] = [];
const NO_SHEETS: readonly string[] = [];

// ── the component ──────────────────────────────────────────────────────────────────────

export interface MessageBodyProps {
  /**
   * WHICH MESSAGE THIS IS — carried only so the dark-viewer "original" override can be
   * remembered PER MESSAGE. Absent ⇒ the override still works for the session but is not
   * persisted (the desktop shell, a bare test mount). Nothing else reads it, and it never
   * touches the sanitize/srcdoc pipeline.
   */
  messageId?: string;
  /** The sensitivity-redacted text part. Always present; the fallback when there is no html. */
  text: string;
  /** The stored `text/html` part, or `null`. Sensitive mail stores none (pipeline.ts). */
  html?: string | null;
  /** Whether the reader has already consented to remote content for THIS message. */
  remoteLoaded?: boolean;
  /**
   * Turn a sender's image url into one this app may load. Absent ⇒ there is no way to load
   * an image, so no button is offered — the demo build, and any client with no API behind it.
   *
   * It must mint a SAME-ORIGIN url, because the frame's policy is derived from it: what the
   * url's origin and path are is what {@link proxyImgSource} writes into `img-src`, and a
   * function this file cannot read a source out of is treated as absent in every position.
   */
  imageProxy?: ((url: string) => string) | null;
  /** Called when the reader asks for images. Absent ⇒ no button. */
  onLoadRemote?: () => void;
  /**
   * THE ACCOUNT'S PIXEL SWITCH (mail 0072). `false` — the default, and what every caller without a
   * remote-images chrome passes — keeps a classified beacon blanked in every mode. `true` lets it
   * ride the proxy with the pictures. See {@link SanitizeOptions.loadPixels}; it is inert without
   * {@link imageProxy}.
   */
  loadTrackingPixels?: boolean;
  /**
   * The message's embedded images, `contentId → data: URI` — see
   * {@link SanitizeOptions.cidImages}, which is where this goes verbatim. Absent ⇒ every
   * `cid:` image stays a blanked box, which is what the demo and any client without an
   * attachment service render. The map's IDENTITY is a memo dependency: hand a stable
   * reference between arrivals (the engine's `inlineImagesOf` does) or the mail re-sanitizes
   * per render.
   */
  cidImages?: ReadonlyMap<string, string>;
  /**
   * Called — from an effect, never during render — with the Content-IDs the FRAMED document
   * references and cannot resolve, in document order, so the shell can fetch exactly those
   * parts. Not called for the frameless rendering (it draws no images; the strip lists them
   * there) and not called when everything resolved, which is what terminates the loop: fetch
   * → map grows → re-sanitize → nothing unresolved → silence. Repeat calls with the same ids
   * must be cheap; the engine's single-flight and its refusal to re-ask a failed part are
   * what this leans on.
   */
  onCidImages?: (contentIds: string[]) => void;
  /**
   * HOW THIS MESSAGE IS ACTUALLY BEING DRAWN, reported to whoever mounted the component.
   *
   * `"prose"` is the frameless path — {@link BodyText} in the app's own type, over the walker's
   * rich nodes or the text part, and it draws **no images at all** either way (`img` is absent
   * from the walker's allow-list). `"framed"` is the sandboxed `srcdoc`, where the sender's
   * html paints its own pictures.
   *
   * A CALLBACK AND NOT A PROP THE CALLER COMPUTES, because the caller cannot compute it. The
   * classification is a field of `sanitizeMailHtml`'s result (`prose`), a pass this component
   * already runs and memoizes; running it a second time in the pane to ask one boolean would
   * sanitize every message twice per render. Two of the three terms are this component's own
   * anyway — an empty text part, and the reader's "Show original" press, which is per mount.
   *
   * It exists for the attachment strip. The frameless rendering drawing no images means a `cid:`
   * picture the sender embedded is on screen NOWHERE unless the strip lists it, and the strip is
   * a sibling of this component rather than a child of it. Optional, and every surface that does
   * not have that problem omits it and is unchanged.
   *
   * Fired after mount and on every change, never during render.
   */
  onRenderMode?: (mode: "prose" | "framed") => void;
  /**
   * THE HOST STATES THE BLOCKING DISCLOSURE ITSELF — and this component then does not. Present, it is called (from an
   * effect, never during render) with what this message had refused and how that is said — the caption a meta line
   * shows and the whole sentence behind it (`BlockNotice`) — or `null` when nothing was refused. Every surface that
   * mounts this viewer passes it and puts the fact in its own meta line as a glyph — the reading stream's card head,
   * the message header the reading pane and a conversation panel share, the Screener card's line
   * (`test/block-notice-surfaces.test.tsx` is the census) — and the bar here keeps only the controls it still owns
   * ("Show images", the dark toggle), with no sentence and no box around them. Absent — a bare mount with no meta
   * line to carry the fact — the bar says the sentence exactly as it always has.
   */

  /**
   * The fact is stated in every case; what moves is where. A callback and not a value the host computes, for the
   * reason `onRenderMode` is one: the terms are fields of the sanitize pass this component already runs, and asking
   * for them from outside would sanitize every message twice. The reported object is rebuilt only when one of its
   * three strings changes, so a host that stores it re-renders once per real change.
   */
  onNotice?: (notice: BlockNotice | null) => void;
}

/**
 * ONE COMPONENT, EVERY SURFACE THAT RENDERS A MESSAGE. `BodyText`'s header says why: "the
 * fix landing on the pane while the thread below it keeps dumping raw text is a shape this
 * repo has shipped five times". The plain-text path is delegated to `BodyText` verbatim
 * rather than reimplemented, so a message with no html renders exactly as it does today.
 */
export function MessageBody({
  messageId,
  text,
  html,
  remoteLoaded = false,
  imageProxy = null,
  onLoadRemote,
  loadTrackingPixels = false,
  cidImages,
  onCidImages,
  onRenderMode,
  onNotice,
}: MessageBodyProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  /**
   * DARK VIEWING — READ THE THEME, LET THE READER OVERRIDE IT PER MESSAGE: `useOptionalTheme` and not `useTheme`:
   * this component renders bare (the desktop shell, `test/message-body.test.ts`), and `null` there means light, the
   * same default the provider itself starts from. The transform only ever engages in a dark theme. A message can be
   * dropped back to its original light rendering — a dark-mode invert is a lightness transform, and some mail (a
   * poster, a logo-heavy newsletter) is worse for it. That decision is per message and remembered:
   * `usePersistedIdSet` holds the ids the reader chose to keep original, in one capped key. Without a `messageId` the
   * override is session-only, which is the right amount for a surface that cannot name the message.
   */
  const theme = useOptionalTheme();
  const themeDark = theme?.resolved === "dark";
  const overrides = usePersistedIdSet(UI_KEYS.mailOriginal);
  const [sessionOriginal, setSessionOriginal] = useState(false);
  const original = messageId ? overrides.has(messageId) : sessionOriginal;
  const setOriginal = useCallback(
    (on: boolean) => {
      if (messageId) overrides.set(messageId, on);
      else setSessionOriginal(on);
    },
    [messageId, overrides],
  );
  /**
   * "SHOW ORIGINAL" — THE FRAME, ON REQUEST, FOR MAIL THAT DECLARES NO CANVAS: SESSION-ONLY AND PER MOUNT, which is
   * the opposite of the dark override above and is deliberate. The dark choice is about a PROPERTY OF THE SENDER —
   * their poster inverts badly, and it will invert badly every time — so it is remembered across reloads. This one is
   * about a moment: "I want to see how this particular message was laid out, now". Persisting it would accumulate a
   * set of messages that quietly opt out of the app's own typography for ever, which is the default this component
   * was just rearranged to establish. It resets when `messageId` changes so that selecting the next message does not
   * inherit the last one's answer.
   */
  const [showOriginal, setShowOriginal] = useState(false);
  useEffect(() => { setShowOriginal(false); }, [messageId]);
  /**
   * The transform is WANTED when the theme is dark and the reader has not asked for the
   * original. Whether it is actually APPLIED is `dark` below, which adds the third condition:
   * the mail has to be light enough to be worth inverting. Two names because the difference
   * matters — this one is the reader's intent, and it survives opening a mail the transform
   * declines to touch.
   */
  const darkWanted = themeDark && !original;
  /**
   * FIRST CLIENT RENDER MUST MATCH THE SERVER RENDER, OR REACT THROWS AWAY THE TREE. `"use client"` does not mean
   * "client only" — Next executes this component on the server for the first paint, where {@link sanitizerAvailable}
   * is false and the text fallback renders. Deciding straight off `sanitizerAvailable()` would make the client's
   * FIRST render a frame where the server sent a paragraph, which is a hydration mismatch: React 18 discards the
   * subtree and re-renders it client-side, and logs an error doing it. So the frame appears on the render AFTER
   * mount, deliberately. The cost is one extra render; the practical flash is none, because the body is hydrated by
   * an engine that only exists in the browser — `html` is null during every real server render.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  /**
   * THE POLICY AND THE REWRITE ARE THE SAME DECISION, SO THEY READ ONE VALUE: {@link proxyImgSource} answers "can
   * this file state, truthfully, where a consented image comes from?" — and a `null` there is not a detail of the
   * CSP. It is the answer to whether the proxy may be used AT ALL. A document whose `<img src>` was rewritten through
   * a proxy the policy then refuses is a broken picture, and — worse — a blocked-content bar that has already counted
   * that image as loaded. So the source is computed from the PROP rather than from the consented proxy, and every
   * place the proxy is offered or used is gated on it: the sanitizer's rewrite, the frame's policy, and the "Show
   * images" button.
   */

  /**
   * Not reachable in a shipped build — `next.config.mjs` fails the build if the api base is ever an absolute origin,
   * so the minted url is always same-origin — which is precisely why it is wired as one value instead of three checks
   * that could disagree later.
   */
  const imgSource = useMemo(
    () =>
      imageProxy && typeof window !== "undefined"
        ? proxyImgSource(imageProxy, window.location.origin)
        : null,
    [imageProxy],
  );
  const proxy = remoteLoaded && imgSource !== null ? imageProxy : null;

  const mail = useMemo(() => {
    if (!html) return null;
    if (!mounted || !sanitizerAvailable()) return { state: "unsupported" as const };
    const { html: clean, blocked, sheets, oversize, light, reflow, prose, rich, background, cids } =
      sanitizeMailHtml(html, { imageProxy: proxy, cidImages, loadPixels: loadTrackingPixels });
    // A message too large to neutralise renders as TEXT, with a reason. Never as a blank
    // frame, and never by taking however long the neutralising would have taken.
    if (oversize) return { state: "oversize" as const };
    if (clean.trim().length === 0) return null;
    return {
      state: "ok" as const,
      /**
       * IS THERE ANYTHING TO ADAPT? Mail the sender already drew dark is left alone — see
       * {@link effectiveBackground}. It travels with the sanitized result rather than being
       * recomputed by the component, because it is a reading of THIS document and the
       * component would otherwise have to re-parse the html to ask.
       */
      light,
      /**
       * IS THIS A LETTER? Decided in the same pass as `light` and `reflow` and carried the same
       * way — see {@link isRigidLayout}. The RENDER branch that reads it is at the bottom of this
       * component, and it adds two terms this classifier cannot see: a non-empty text part, and
       * no remote picture the reader has already consented to. Both are stated there.
       */
      prose,
      /**
       * THE LETTER'S OWN STRUCTURE, walked out of the sanitized document — see
       * {@link SanitizedMail.rich}. Handed to `BodyText` on the prose path; `null` falls back
       * to the text part there, which was the whole of the prose rendering before the walker.
       */
      rich,
      // `darkWanted && light` is baked in for the FIRST paint (no flash), then never rebuilt:
      // every later flip goes through the toggleAttribute effect below. It is deliberately NOT
      // a dep — rebuilding the srcdoc on a theme change would re-parse and re-measure the whole
      // mail, which is exactly what the attribute mechanism exists to avoid. A rebuild driven
      // by a real dep (html/proxy/mount) reads the current value here, so the two never diverge.
      doc: buildMailDocument(clean, {
        // `proxy` is non-null exactly when the reader has consented AND a source could be
        // stated, so this is the one value both the rewrite and the policy were decided from.
        imgSource: proxy ? imgSource : null,
        dark: darkWanted && light,
        // Baked in, never toggled: unlike `dark` this is a property of the document rather than
        // of the theme, so it can only change when `html` changes — and that already rebuilds
        // the frame. See `isRigidLayout` for what decides it.
        reflow,
        // The mail's own paper, so a message this viewer declines to invert does not sit on a
        // white sheet it never asked for — but a near-neutral light ground (the grey a template
        // drops behind a white letter) is clamped back to the app's white, see clampedPaper.
        // Ignored whenever the filter is on — see FRAME_CSS.
        paper: clampedPaper(background),
      }),
      blocked,
      sheets,
      /** The unresolved `cid:` references — what the request effect below reports upward. */
      cids,
    };
    // `darkWanted` is intentionally omitted — it is applied live via toggleAttribute, never by
    // rebuilding the frame; see the note on `doc` above. `cidImages` IS a dep: an arrived
    // embedded image can only reach the frame through a rebuild, and its identity moves once
    // per arrival batch (the engine replaces the map, never mutates it). `imgSource` is a dep
    // for the same reason `proxy` is — it is half of the document the frame gets — and it is
    // memoized on `imageProxy`, so it moves only when the proxy itself does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, proxy, imgSource, mounted, cidImages, loadTrackingPixels]);

  /**
   * THE THREE-TERM ANSWER, IN ONE PLACE SO NOTHING DISAGREES WITH ANYTHING ELSE.
   *
   * `adaptable` — this mail is light, so inverting it means something. False for a mail drawn
   * dark by its sender, and false before there is a document to have read.
   * `dark` — the filter is actually on. The live `toggleAttribute` and the surround both read
   * THIS, so a mail the transform declines to touch never gets a dark-styled frame around a
   * light body.
   */
  const adaptable = mail?.state === "ok" ? mail.light : false;
  const dark = darkWanted && adaptable;

  /**
   * FLIP THE DARK TRANSFORM ON THE LIVE DOCUMENT — never by rebuilding the srcdoc. The transform is gated on
   * `:root[data-ohmail-dark]` in the frame's own sheet, so switching it on or off is one attribute write on the
   * frame's `documentElement`. A rebuild would re-parse the sender's html and force a fresh measurement pass; this
   * does neither, so a theme change (or the reader's per-message override) is instant and motionless. `ready` and
   * `mail` are deps so the attribute is re-asserted after the frame (re)loads — a new srcdoc starts from whatever
   * `dark` was baked in, and this keeps the live document in step with the current value. In jsdom `contentDocument`
   * is null, so this is a no-op there, which is why the dark transform's real proof is a browser check and not this
   * file.
   */
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    doc.documentElement.toggleAttribute("data-ohmail-dark", dark);
  }, [dark, ready, mail]);

  /**
   * SIZE THE FRAME TO THE MAIL — AND THE OBVIOUS WAY TO DO IT RUNS AWAY.
   *
   * A fixed-height frame with its own scrollbar is the thing every reader hates about webmail;
   * a mail client's message is as tall as the message and the PANE scrolls. Reading
   * `contentDocument` is what `allow-same-origin` is for, and it is safe for the reason in the
   * header — there is no script inside to abuse it.
   *
   * ── THE RUNAWAY, MEASURED IN A REAL BROWSER ─────────────────────────────────────────────
   *
   * This was `Math.max(documentElement.scrollHeight, body.scrollHeight)`, re-run from a
   * `ResizeObserver` that observed the IFRAME. Both halves of that are wrong, and together
   * they are a monotonic growth loop. Measured on a real newsletter in a 390 px column, 2.5 s
   * after load:
   *
   *   frame.style.height   899px  ·  documentElement.scrollHeight  899  ·  body.scrollHeight  634
   *   (hostile fixture)   1617px  ·                               1617  ·                     159
   *
   * `documentElement.scrollHeight` is `max(content, VIEWPORT)`, and inside a frame the
   * viewport IS the height we just set — so every measurement returned at least the previous
   * answer, the observer on the iframe fired on our own write, and the frame grew forever. A
   * 159 px message occupied 1 617 px of the pane and climbing.
   *
   * **No unit test could have seen this.** jsdom performs no layout: every one of those
   * numbers is 0 there, and `test/message-body.test.ts` can only assert that no fixed `height`
   * attribute is set. It took driving Chrome at the acceptance fixture.
   *
   * ── AND `height:auto!important` DID NOT CLOSE IT. MEASURED AGAIN ─────────────────────────
   *
   * That rule says nothing about a CHILD. `<div style="height:150vh">` measured
   * `frame.style.height` = **33 554 400 px** — Chrome's own layout ceiling — because inside the
   * frame the viewport IS the height written a moment earlier, so 150vh grows with every pass.
   * And `<style>html,body{height:300vh!important}</style>` reached the same number by beating
   * the rule head-on: equal specificity, later in the document. The host page's `scrollHeight`
   * reached 33 554 432. A message is not allowed to do that to the tab it is opened in.
   *
   * ── SO THE MEASUREMENT STOPS READING A VIEWPORT THE SENDER CAN MOVE ─────────────────────
   *
   *  1. The frame is set to {@link PROBE_PX} — a CONSTANT — and read under it. Every viewport
   *     unit in the mail then resolves against a number this component chose and the sender
   *     cannot influence, so the reading is a pure function of the content and the column
   *     width. There is no feedback edge left to run away along.
   *  2. `documentElement.offsetHeight` — the html box, content-sized, never clamped up to the
   *     viewport the way `scrollHeight` is.
   *  3. {@link MAX_FRAME_PX}, which the sender also cannot influence. A mail that still wants
   *     more than that gets the frame's own scrollbar, which is a bad reading experience and
   *     not a hung tab.
   *  4. The observer watches the mail's `body` (its content reflowing) and this component's
   *     own container (the app's column changing width). It must NEVER watch the iframe,
   *     because the iframe's size is what this function WRITES.
   *
   * ── THE PROBE AND THE FINAL WRITE ARE ONE STRAIGHT LINE, AND NOTHING MAY SIT BETWEEN ────
   *
   * `ResizeObserver` reports against the box it last reported, and both writes happen inside
   * one task — so the probe is never observed and (4) stays safe. An early `return` in between
   * would leave the frame AT the probe height and start a permanent oscillation, which is why
   * the only branch here is on the write itself.
   *
   * The 1 px epsilon and the remembered height are both GONE with the feedback edge that
   * needed them: the reading is a pure function of the content, so a re-measure that changes
   * nothing writes the same string, and that is a no-op.
   */
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.documentElement) return;
    // ── PRESERVE THE PANE'S SCROLL ACROSS THE PROBE ────────────────────────────────────
    // Capture the scroll offset of every scrollable ancestor BEFORE the probe shrinks the
    // frame, and restore each AFTER the final height is written. Without this, the probe's
    // forced layout clamps a scrolled-down pane's scrollTop to the shrunken maximum and the
    // restore never puts it back — see {@link scrollAncestors}. Reading `.scrollTop` in the
    // restore flushes layout at the FINAL height first, so the assignment lands against the
    // full scroll range, not the probe's. Both writes stay in one task so nothing paints in
    // between and the reader sees no motion.
    const scrollers = scrollAncestors(frame);
    const tops = scrollers.map((el) => el.scrollTop);

    const root = doc.documentElement;
    const restore = frame.style.height;

    // ── THE PROBE READS THE MAIL AT ITS NATURAL SIZE, WHICH MEANS UNSCALED TOO ─────────
    //
    // The height probe pins the VIEWPORT to a constant so a sender's `vh` cannot move it. The
    // fit needs the same treatment for the other axis, and for a sharper reason: the scale is
    // applied to `body`, and a transformed body contributes its TRANSFORMED extent to the
    // document's scrollable overflow — so measuring while the previous fit is still applied
    // reads back the column width, computes a scale of 1, removes the transform, and finds the
    // mail overflowing again on the next pass. That is an oscillation, not a measurement.
    // Clearing the attribute first makes the reading a pure function of the content and the
    // column, exactly like the height, and leaves no feedback edge for either axis.
    root.removeAttribute("data-ohmail-scaled");
    /* Off for the probe alongside the scale, and for the same reason: the reading must be a pure
       function of the content, and a root that is not a scroll container is a root laid out
       under different rules than the one the previous pass measured. */
    root.removeAttribute("data-ohmail-fitclip");
    frame.style.height = `${PROBE_PX}px`;

    // `clientWidth` of the FRAME is the column; `scrollWidth` of the frame's root is the widest
    // the mail actually needs, and it is already clamped up to the viewport, so it is never
    // less than the column and the scale is never above 1.
    //
    // READ OFF THE LIVE ROOT rather than closed over. The attribute is baked into the srcdoc by
    // `buildMailDocument`, so the document itself carries the answer and this callback stays
    // dependency-free — which is what keeps it out of the ResizeObserver's teardown/rebuild
    // cycle. A reflowed mail is never fitted; see `fitScale`.
    const reflow = root.hasAttribute("data-ohmail-reflow");
    const scale = fitScale(frame.clientWidth, root.scrollWidth, reflow);
    // Measured BEFORE the transform is applied, then scaled by the same factor — a transform is
    // a paint-time operation and never changes `offsetHeight`, so the frame would otherwise be
    // told to reserve the mail's full unscaled height and leave a gap under a fitted message.
    const raw = Math.ceil(root.offsetHeight * scale);
    const h = Math.min(raw, MAX_FRAME_PX);
    /** The mail wanted more room than {@link MAX_FRAME_PX} allows, so the frame really is short. */
    const clampedByCeiling = raw > MAX_FRAME_PX;

    if (scale < 1) {
      root.style.setProperty("--ohmail-scale", String(scale));
      root.setAttribute("data-ohmail-scaled", "1");
    } else {
      root.style.removeProperty("--ohmail-scale");
    }
    frame.style.height = h > 0 ? `${h}px` : restore;
    /**
     * THE FRAME'S HEIGHT AND ITS DOCUMENT'S SCROLLABILITY ARE ONE DECISION: A scaled document's layout height is its
     * UNSCALED one — a transform is a paint operation — so sizing the frame to the painted extent leaves the document
     * with scrollable overflow that has nothing in it. That overflow captured the wheel over a collapsed
     * reading-stream card: measured, the frame's own document moved 25px at 1440 (157 at 390) while the stream did
     * not move at all. `:root[data-ohmail-fitclip]` in the document's own stylesheet takes the root out of the
     * wheel's chain, and it is written HERE, in the statement after the height, because the two facts are the same
     * fact — a second place deciding it could differ from this one. NOT when the ceiling clamped the height: then the
     * mail is genuinely taller than its frame and its own document is the only way to reach the rest of it.
     */
    root.toggleAttribute("data-ohmail-fitclip", scale < 1 && !clampedByCeiling && h > 0);

    for (let i = 0; i < scrollers.length; i++) {
      if (scrollers[i]!.scrollTop !== tops[i]) scrollers[i]!.scrollTop = tops[i]!;
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    measure();
    const frame = frameRef.current;
    const shell = shellRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    // The mail's own content, and the column it sits in. Deliberately NOT `frame`.
    const body = frame.contentDocument?.body;
    if (body) ro.observe(body);
    if (shell) ro.observe(shell);
    return () => ro.disconnect();
  }, [ready, measure, mail]);

  /**
   * IS THERE A FRAME ON SCREEN, OR IS THIS THE APP'S OWN TYPE?: Computed HERE, above the three early returns below,
   * because it is read by a hook and a hook may not sit behind a return. That placement is also what makes it total:
   * `!mail` (no html, or nothing left after sanitizing), `unsupported` and `oversize` all render {@link BodyText} and
   * therefore all draw NO IMAGES — the same fact the `ok` branch's `proseView` states, reached by a different road.
   * Answering only for the `ok` branch would have left three renderings this component treats identically reported as
   * though they carried a frame. The `ok` branch's own `proseView` is this value; see its note below for the three
   * terms.
   */
  const framelessView =
    mail?.state !== "ok" ? true : mail.prose && text.trim().length > 0 && !showOriginal;
  /**
   * REPORT IT — see {@link MessageBodyProps.onRenderMode}. In an effect, so nothing is announced for a render React
   * may discard, and so a listener that sets state is never doing it during this component's render. The reported
   * value is derived from a BOOLEAN, so a listener that maps it to a primitive gets React's own bail-out on an
   * unchanged value and this cannot become a loop however unstable the callback's identity is. It follows the
   * reader's "Show original" press, which is the point: that press brings the frame back and with it every picture
   * the html paints, and a signal that ignored it would leave a strip listing pictures that are already on screen.
   */
  useEffect(() => {
    onRenderMode?.(framelessView ? "prose" : "framed");
  }, [framelessView, onRenderMode]);

  /**
   * ── ASK FOR THE EMBEDDED IMAGES THE FRAME IS SHOWING BLANKED — see {@link MessageBodyProps.onCidImages}
   * ──────────────────────────────────────────────────────────── Framed renderings only: the frameless path draws no
   * images at all, and the strip lists the message's pictures there instead — fetching bytes a rendering cannot show
   * would be pure spend. A reader's "Show original" press flips `framelessView`, this fires, and the frame's blanked
   * boxes are asked for at that moment. TERMINATION is the `cids` array draining, not any state here: resolved
   * references stop being reported by the sanitize pass, and the engine refuses to re-fetch what failed. So a re-fire
   * with an unchanged list — a re-render, an unstable callback — is a cheap no-op by the callee's contract, not by
   * this effect's memory.
   */
  const wantedCids = mail?.state === "ok" && !framelessView ? mail.cids : undefined;
  useEffect(() => {
    if (wantedCids && wantedCids.length > 0) onCidImages?.(wantedCids);
  }, [wantedCids, onCidImages]);

  /**
   * ── WHAT WAS REFUSED, AND WHAT IS SAID ABOUT IT ─────────────────────────────────────────
   *
   * Computed HERE, above the early returns, because the effect that reports it to a host is a hook
   * — the same reason `framelessView` sits up here. On the three renders that carry no sanitized
   * document (`!mail`, `unsupported`, `oversize`) the terms are empty and nothing is refused, which
   * is also what those renders have always said: no bar.
   */
  const okMail = mail && mail.state === "ok" ? mail : null;
  const remote = okMail ? okMail.blocked : NO_ASSETS;
  const sheets = okMail ? okMail.sheets : NO_SHEETS;
  const pixels = remote.filter((b) => b.pixel).length;
  /**
   * ── DID THE PICTURES ACTUALLY LOAD? NOT THE SAME QUESTION AS `remoteLoaded` ─────────────
   *
   * `remoteLoaded` is the READER's answer — the stored flag, this session's press, or the
   * account's auto mode. Whether anything then loaded is a second fact, and the bar is about
   * the second one: it is the surface that tells a reader what was withheld, so keying it on
   * consent means a message can show blanked boxes while the bar says nothing at all.
   *
   * The two disagree in exactly the cases the sanitizer was ALSO given no proxy — a client
   * with no image proxy (the demo, any build with no API), and the fail-closed branch where
   * {@link proxyImgSource} cannot state a source the frame's policy would accept. In both, the
   * pictures are counted in `mail.blocked` and must be reported as blocked. Reading `proxy`
   * rather than re-deriving the terms is what keeps that impossible to get wrong: it is the
   * same value the rewrite was performed with, so the sentence cannot disagree with the
   * document it describes.
   *
   * The one measured case behind the second half: an app served from an IPv6 literal origin.
   * `http://[::1]:3000` has no expressible CSP host-source — checked in Chromium, not assumed:
   * `img-src http://[::1]:45365/api/img` refused BOTH a matching and a non-matching url, while
   * `'self'` fetched both, so the source contributes nothing and the whole directive is a
   * refusal. There is no spelling that would work (CSP3's `host-char` is ALPHA/DIGIT/"-"), so
   * `null` is the only truthful answer and this term is what keeps its consequence visible
   * instead of silent. Production is a domain; this is a development topology.
   */
  const remoteShown = proxy !== null;
  // UNDER THE LOADED MODES THE BEACONS ALONE WERE REFUSED — and that refusal is still said, in a
  // sentence of its own, because it is the one privacy fact this product is named for and the
  // "images by default" world would otherwise report nothing at all. Unless the reader turned the
  // pixel switch off too (`loadTrackingPixels`), in which case nothing was refused and nothing is
  // said. The manual-mode sentences below are untouched by this term.
  const pixelsRefused = remoteShown && !loadTrackingPixels ? pixels : 0;
  // A loaded remote image is no longer "blocked", so it contributes nothing to the bar — the
  // status line that used to say "Images loaded for this message." was pure noise and is gone.
  // Blocked stylesheets have no consent path, so they still count even when images loaded.
  const hasBlocked = (remote.length > 0 && !remoteShown) || sheets.length > 0 || pixelsRefused > 0;
  /**
   * The sentences, chosen once (`sayBlocked`) for the bar below AND for the host's glyph. The
   * caption follows the beacon when there is one — the fact this product is named for leads —
   * then the pictures, then the stylesheet; the glyph's text is the bar's sentences joined by a
   * space, in the bar's order.
   */
  const said = hasBlocked ? sayBlocked({ remote, sheets, pixels, remoteShown, pixelsRefused }) : null;
  const noticeKind: NoticeKind | null =
    said === null ? null
    : said.pixelSaid || said.hit !== null ? "pixel"
    : said.lead !== null ? "images"
    : "sheet";
  const noticeCaption = noticeKind === null ? null : COPY[CAPTION_KEY[noticeKind]];
  const noticeText =
    said === null ? null : [said.lead, said.hit, said.sheet].filter((s): s is string => s !== null).join(" ");
  /**
   * REPORT IT — see {@link MessageBodyProps.onNotice}. In an effect, for the reasons `onRenderMode`
   * gives, and keyed on the three STRINGS rather than on an object, so a host storing the answer is
   * told once per real change and never once per render.
   */
  useEffect(() => {
    if (!onNotice) return;
    onNotice(
      noticeKind !== null && noticeCaption !== null && noticeText !== null
        ? { kind: noticeKind, caption: noticeCaption, text: noticeText }
        : null,
    );
  }, [onNotice, noticeKind, noticeCaption, noticeText]);

  // ── no html, or nothing left after sanitizing: the text part, unchanged ──
  if (!mail) return <BodyText text={text} />;

  // ── a DOM the sanitizer could not use (a server render), or an html part past the size
  //    cap. Both render the text WITH THE REASON — never the raw html, never a blank frame. ──
  if (mail.state !== "ok") {
    return (
      <>
        <BodyText text={text} />
        <p className="mb-note">
          {mail.state === "oversize" ? COPY.oversize : COPY.unsupported}
        </p>
      </>
    );
  }

  // `remote`, `sheets`, `pixels`, `remoteShown`, `pixelsRefused`,
  // `hasBlocked` and `said` are computed above the early returns, beside
  // `framelessView`, because a hook reads them. The bar also carries the
  // dark-viewer toggle, so it appears in a dark theme even with nothing
  // blocked; the empty text span still takes the flex space, pushing the
  // toggle right. `adaptable`, not `themeDark` alone: a mail the sender
  // already drew dark has no adaptation to offer, and a control that
  // visibly does nothing is worse than an absent one.
  /**
   * The frameless path — a letter, set in the app's own type. `mail.prose` is the document's
   * answer; this component adds two terms: an empty text part keeps its frame, and "Show original"
   * is a press and only a press (the `remoteLoaded` inference framed every pictured message under
   * the load-by-default setting). What renders: the walker's node tree, else the text part, both
   * through {@link BodyText} — no markup string ever enters the app's document
   * (`test/message-body-prose.test.ts` plants hostile markup and asserts none reaches the DOM). The
   * bar stays when it has something to say, never for the flip alone; dark toggle suppressed.
   */
  /**
   * IS THIS MAIL ELIGIBLE for the frameless rendering — the document's answer plus the text part
   * this component holds. It drives the flip control after the body (the way between the app's
   * own type and the sender's own layout), which may only appear where there is one to go back
   * TO. It is deliberately NOT a term of {@link showBar}: a prose letter with nothing blocked has
   * no sentence to show, and a bar put up to carry only the flip is the empty strip this removes.
   */
  const proseable = mail.prose && text.trim().length > 0;
  /* The same three terms as {@link framelessView} above, and deliberately that value rather than a
     second spelling of it: two copies of this expression would be two things to keep in step, and
     the one the strip reads is the one computed above. */
  const proseView = framelessView;
  const canAdapt = themeDark && adaptable && !proseView;
  // `imgSource !== null` is the third term and it is the same rule the sanitizer's `proxy` is
  // gated on: a button that consents to images the frame's policy will then refuse is a control
  // over a capability nothing can serve, which this file already refuses to render elsewhere.
  const canLoad =
    imageProxy != null && imgSource !== null && onLoadRemote != null && !remoteLoaded && !proseView;
  /**
   * THE HOST SAYS IT, OR THE BAR DOES — never both, never neither. `onNotice` present means the
   * mounting surface states the blocking disclosure in its own chrome (a meta line: the stream
   * card's head, the message header, the Screener card's line), so the sentence and its glyph
   * leave this bar; what stays is a control with a job.
   */
  const hostTakesNotice = onNotice != null;
  const barSaysIt = hasBlocked && !hostTakesNotice;
  /**
   * THE BAR CARRIES A SENTENCE OR A CONTROL WITH A JOB — never nothing. `barSaysIt` is the
   * privacy disclosure (a beacon or a stylesheet the message named and this refused), where this
   * component is the one saying it; `canAdapt` is the dark-viewer toggle, meaningful only over a
   * frame in a dark theme; `controlsOnly` is the host-said case where "Show images" still has
   * pictures to load — the button keeps its place above the body, the box does not (`mb-bar-quiet`).
   * `proseable` is NOT here: it is the frameless flip, which now lives as its own quiet control
   * after the body, so a plain letter with nothing to report shows no bar at all.
   */
  const controlsOnly = hostTakesNotice && hasBlocked && canLoad;
  const showBar = barSaysIt || canAdapt || controlsOnly;
  /**
   * IS WHAT THE READER IS LOOKING AT DARK? Not the same question as `dark`, which is only
   * whether the FILTER is on. A mail the sender drew dark is dark on screen with no filter at
   * all, and the surround has to match that too or a dark newsletter sits in a light frame.
   */
  const surfaceDark = themeDark && (dark || !adaptable);

  return (
    <div className="mb" ref={shellRef}>
      {showBar ? (
        <div
          className={hostTakesNotice ? "mb-bar mb-bar-quiet" : "mb-bar"}
          /* A live region only while a sentence lives here; a row of controls announces nothing. */
          role={hostTakesNotice ? undefined : "status"}
        >
          {barSaysIt ? (
            <svg className="mb-bar-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4Z" />
              <circle cx="8" cy="8" r="1.7" />
              <path d="m3 13 10-10" />
            </svg>
          ) : null}
          {hostTakesNotice ? null : (
            /* The sentences are `said`, chosen above the returns by `sayBlocked` — the same
               choice the host's glyph reads, so the two can never disagree. Empty when nothing
               was refused (a dark-toggle-only bar): the span still takes the flex space, which is
               what pushes the toggle to the right. */
            <span className="mb-bar-text">
              {said?.lead}
              {said?.hit ? (
                <>
                  {" "}
                  <span className="mb-bar-hit">{said.hit}</span>
                </>
              ) : null}
              {/* LAST, ALWAYS. The browser-level test of this bar reads the FIRST number in it
                  and holds that against the remote images the message names; a stylesheet count
                  in front of that would make the guard measure the wrong thing. */}
              {said?.sheet ? (
                <>
                  {said.spaceBeforeSheet ? " " : null}
                  {said.sheet}
                </>
              ) : null}
            </span>
          )}
          {/* "Show images" is SUPPRESSED on the frameless path (`canLoad` reads `!proseView`),
              because that rendering draws no images at all — the button would consent to
              something and then show nothing, which is the objection `canAdapt` answers for the
              dark toggle. The route to those images is "Show original" beside it, which brings
              the frame back and takes this button with it. */}
          {canLoad ? (
            <button type="button" className="mb-bar-btn" onClick={onLoadRemote}>
              {COPY.show}
            </button>
          ) : null}
          {/* The dark-viewer toggle. Only meaningful in a dark theme — in light there is
              nothing to adapt — so it is absent otherwise. `aria-pressed` reports whether the
              reader has forced the original light rendering for this message. */}
          {canAdapt ? (
            <button
              type="button"
              className="mb-bar-btn"
              aria-pressed={original}
              title={original ? COPY.darkAdaptTitle : COPY.darkOriginalTitle}
              onClick={() => setOriginal(!original)}
            >
              {original ? COPY.darkAdapt : COPY.darkOriginal}
            </button>
          ) : null}
        </div>
      ) : null}

      {proseView ? (
        /* A LETTER, in the app's own type — no frame, no sheet, no measurement pass, and NEVER
           a markup string. `rich` is the walker's node tree (tables, lists, real anchors),
           rendered by `BodyText` element by element; when it is null — the walk refused, or the
           mail had no structure worth keeping — the text part renders exactly as it always has.
           See `proseView` above. */
        <BodyText text={text} rich={mail.rich} />
      ) : (
        /* `data-dark` themes the sheet the frame sits on — the chrome this file owns — to match
           the transform inside the frame, so a short mail's surround does not read as a light
           hole in a dark panel. It follows the per-message override, not just the theme. */
        <div className="mb-sheet" data-dark={surfaceDark ? "1" : undefined}>
          <iframe
            ref={frameRef}
            className="mb-frame"
            title={COPY.frameTitle}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={mail.doc}
            onLoad={(ev) => {
              /* THE SENDER'S OWN LINKS, which are in a document of their own.
                 A click in here does not bubble to the app — separate documents — so the shell's
                 one link handler is installed on this one too. It is inert unless the desktop
                 build armed it (`shell/open-external.ts`), which is what leaves the web app's
                 anchors exactly as the browser gives them.
                 `contentDocument` is reachable because this frame's sandbox keeps
                 `allow-same-origin`; scripts are still not in that list, so nothing in here can
                 have moved the links before this runs. */
              const frameDoc = (ev.currentTarget as HTMLIFrameElement).contentDocument;
              if (frameDoc) interceptLinkClicks(frameDoc, { trustSameOrigin: false });
              setReady(true);
              measure();
            }}
          />
        </div>
      )}

      {/* THE FRAMELESS DEFAULT IS REVERSIBLE, PER MESSAGE — a quiet text control AFTER the body,
          not a button in a bar. Mail that declares no canvas is set in the app's own type by
          default; this is the one press to the sender's own layout (and back), offered whichever
          way the message is currently shown. A prose letter with nothing blocked shows no bar, so
          this control — quiet, and out of the way under the letter — is the whole of the chrome
          it carries. See `COPY.design` for why it is a press, not something read off a setting. */}
      {proseable ? (
        <button
          type="button"
          className="mb-flip"
          aria-pressed={showOriginal}
          title={showOriginal ? COPY.plainTitle : COPY.designTitle}
          onClick={() => setShowOriginal(!showOriginal)}
        >
          {showOriginal ? COPY.plain : COPY.design}
        </button>
      ) : null}
    </div>
  );
}
