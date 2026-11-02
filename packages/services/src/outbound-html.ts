import sanitizeHtml from "sanitize-html";
import { DRAFT_BODY_MAX_BYTES, htmlToPlainText } from "@trafficflow/core/mail";

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
 * argued in `0022_message_body_html_cap.sql`. This constant and `drafts_html_cap` in
 * `0037_draft_html.sql` are one ceiling expressed twice (a migration freezes when applied; code
 * does not) and a test reconciles them. Measured in BYTES: `octet_length` is what the constraint
 * counts. The LITERAL now lives once, in `DRAFT_BODY_MAX_BYTES` — the plain half took the same
 * number for the same migration's reason, and a client predicate that depended on two literals
 * agreeing is the second number to keep true that both doc comments warn about.
 */
export const DRAFT_HTML_CAP_BYTES = DRAFT_BODY_MAX_BYTES;

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
 * A FORWARD'S QUOTED ORIGINAL: the same grammar, plus the original's inline pictures where they
 * stood — an `<img>` whose src is `cid:` of a part this send carries (`cids`, bare Content-IDs),
 * with its alt and size. Any other picture is dropped: a cid nothing carries draws a broken box,
 * and a remote or `data:` one is the payload the grammar keeps out.
 */
export function sanitizeQuotedHtml(html: string, cids: ReadonlySet<string>): string {
  const quote: sanitizeHtml.IOptions = {
    ...POLICY,
    allowedTags: [...ALLOWED_TAGS, QUOTE_LINE, QUOTE_CELL],
    nonTextTags: [...POLICY.nonTextTags!, "head", "title", "noscript", "template"],
    transformTags: {
      ...Object.fromEntries(LINE_TAGS.map((t) => [t, QUOTE_LINE])),
      td: QUOTE_CELL, th: QUOTE_CELL,
    },
  };
  return keepLines(sanitizeHtml(html, cids.size === 0 ? quote : {
    ...quote,
    allowedTags: [...quote.allowedTags as string[], "img"],
    allowedAttributes: { ...POLICY.allowedAttributes, img: ["src", "alt", "width", "height"] },
    allowedSchemesByTag: { img: ["cid"] },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    exclusiveFilter: (frame) => frame.tag === "img" && !cids.has((frame.attribs.src ?? "").replace(/^cid:/i, "")),
  }));
}

/**
 * A letter's own block tags outside the grammar (a Gmail line is a `div`, a receipt a table).
 * Dropped bare, their lines ran together in the quote; each becomes a line break instead.
 */
const LINE_TAGS = [
  "div", "section", "article", "header", "footer", "main", "aside", "nav", "center", "address",
  "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "caption",
  "dl", "dt", "dd", "figure", "figcaption", "hr",
];
const QUOTE_LINE = "x-ohmail-line";
const QUOTE_CELL = "x-ohmail-cell";
/** Tags whose edges are already line edges in the grammar. */
const GRAMMAR_BLOCKS = new Set(["p", "ul", "ol", "li", "blockquote", "pre"]);

/**
 * Turn the quote's line and cell markers into what a reader of the letter saw: a `<br />` where a
 * block ended after words (only one, and none at a grammar block or at the end), ` | ` between
 * two filled cells of a row; `\n` inside a `<pre>`. Runs over sanitize-html's own output, whose
 * text and attribute values carry no raw `<` or `>`.
 */
function keepLines(html: string): string {
  let out = "";
  let filled = false;
  let pending = false;
  let pre = 0;
  for (const tok of html.split(/(<[^>]*>)/)) {
    if (tok === "") continue;
    if (!tok.startsWith("<")) {
      if (tok.trim() !== "") {
        if (pending) out += pre > 0 ? "\n" : "<br />";
        pending = false;
        filled = true;
      }
      out += tok;
      continue;
    }
    const closing = tok.startsWith("</");
    const name = (/^<\/?([a-z0-9-]+)/i.exec(tok)?.[1] ?? "").toLowerCase();
    if (name === QUOTE_LINE) {
      if (filled) pending = true;
      filled = false;
      continue;
    }
    if (name === QUOTE_CELL) {
      if (!closing && filled && !pending) { out += " | "; filled = false; }
      continue;
    }
    if (GRAMMAR_BLOCKS.has(name)) {
      if (name === "pre") pre = Math.max(0, pre + (closing ? -1 : 1));
      pending = false;
      filled = false;
    } else if (!closing) {
      if (pending) out += pre > 0 ? "\n" : "<br />";
      pending = false;
      if (name === "br") filled = false;
      else if (name === "img") filled = true;
    }
    out += tok;
  }
  return out;
}

/**
 * The text rendering of html moved to `@trafficflow/core/html-text` so ingest can derive the
 * words of an HTML-only message for its search document from the same function; re-exported
 * here so every outbound caller keeps its import.
 */
export { htmlToPlainText } from "@trafficflow/core/mail";

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
