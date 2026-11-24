/**
 * The mail frame: the one place a customer mail's markup is written.
 *
 * A template hands it a `MailDoc` (words as runs, blocks, at most one action, a footer) and gets
 * back the html part and the text part, both made from the same runs, so the two cannot drift.
 * Only this file writes markup and only this file calls `esc`; a template never holds a `<`.
 *
 * Its rules, held by `mail-templates.test.ts`:
 *  1. NO REMOTE RESOURCE, ever. ohmail takes tracking pictures out of other people's mail; its own
 *     carries none. The wordmark is typed: the name in the title's face, its full stop in `hot`.
 *  2. The one style element is `DARK_BLOCK`: the dark colours behind one media query, no address,
 *     no import. A client that drops it shows the light mail whole.
 *  3. Every value is text and is escaped; nothing is parsed for marks. An href is the action's URL,
 *     a link run's URL (both through `safeUrl`), or `mailto:` and one plain address.
 *
 * It imports nothing, so it can move to another package in one piece.
 */

export type MailLocale = "en" | "de";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** Extra RFC 5322 headers (only `List-Unsubscribe`, on the waitlist confirmation). */
  headers?: Record<string, string>;
  /** Where a reply goes when this mail asks for one; the transport's configured address otherwise. */
  replyTo?: string;
}

// ── The two guards ──────────────────────────────────────────────────────────

/** HTML-escape a value. Applied to every value the frame writes into markup. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validate a URL destined for an `href`. Only `https:` passes (`http:` for `localhost`): a
 * `javascript:`/`data:` URL is stored XSS in the webmail clients that render our HTML. It throws
 * rather than falling back, and `MailerPort.send` catches the throw. THE THROWN MESSAGE MUST NOT
 * CONTAIN THE URL: two of these URLs carry a live credential in their query string, and a render
 * failure's message goes to logs. The message carries only the allow-listed scheme and the length.
 */
export function safeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`mail template: not an absolute URL (${shapeOf(url)})`);
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new Error(`mail template: refusing non-https URL scheme ${JSON.stringify(schemeOf(parsed))}`);
  }
  return parsed.toString();
}

/** A rejected URL's length, and nothing else: bounded, numeric, useless to a log reader. */
function shapeOf(url: unknown): string {
  return `${typeof url === "string" ? url.length : 0} chars`;
}

/** `new URL("SECRET-TOKEN:x")` parses and its protocol would be the secret: only known schemes are named. */
const NAMEABLE_SCHEMES = new Set([
  "http:", "https:", "javascript:", "data:", "vbscript:", "file:", "ftp:",
  "mailto:", "tel:", "blob:", "about:", "ws:", "wss:",
]);

function schemeOf(parsed: URL): string {
  return NAMEABLE_SCHEMES.has(parsed.protocol) ? parsed.protocol : "other";
}

// ── The kit's values a mail may use ─────────────────────────────────────────

/**
 * The paper face's colours, by the tokens' own names. A mail cannot read a stylesheet, so they are
 * literals; `test/mail-colours-are-the-tokens.test.ts` holds them equal to `packages/tokens`.
 */
export const MAIL_COLOURS = {
  light: {
    ground: "#F0EBE3", sheet: "#FFFFFF", ink: "#12100E", ink2: "#5A534B",
    "soft-sheet": "#F0EBE3", solid: "#12100E", "on-solid": "#FFFFFF", hot: "#F8431A",
  },
  dark: {
    ground: "#0E0D0C", sheet: "#23201C", ink: "#F6F1E9", ink2: "#B8AFA3",
    "soft-sheet": "#34302B", solid: "#F6F1E9", "on-solid": "#12100E", hot: "#FF6A3D",
  },
} as const;

/** The paper face's measures the frame draws with, in px; held equal to the tokens like the colours. */
export const MAIL_MEASURES = {
  "t-head": 28, "t-read": 17, "t-meta": 13, "r-sheet": 20, "r-row": 12, "sheet-pad": 32,
} as const;

const L = MAIL_COLOURS.light;
const D = MAIL_COLOURS.dark;
const M = MAIL_MEASURES;
const TEXT = "Arial,Helvetica,sans-serif";
const HEAD = "'Arial Black',Arial,Helvetica,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono','Courier New',monospace";

/** The one style element: the dark colours and nothing else. */
export const DARK_BLOCK = [
  ":root{color-scheme:light dark;supported-color-schemes:light dark}",
  "@media (prefers-color-scheme:dark){",
  `.g{background:${D.ground} !important}`,
  `.s{background:${D.sheet} !important}`,
  `.i{color:${D.ink} !important}`,
  `.j{color:${D.ink2} !important}`,
  `.k{background:${D.solid} !important;color:${D["on-solid"]} !important}`,
  `.q{background:${D["soft-sheet"]} !important}`,
  `.r{color:${D.hot} !important}`,
  "}",
].join("\n");

// ── What a template hands the frame ─────────────────────────────────────────

/** A piece of a sentence: text, bold text, a link, or a mail address. Every one is text, never markup. */
export type Run = string | { b: string } | { link: string; href: string } | { mail: string };

export type Block =
  | { p: Run[] }
  | { strong: Run[] }
  | { facts: ReadonlyArray<readonly [label: string, value: string]> }
  | { label: string; code: string };

/** A footer line; `htmlOnly` lines are left out of the text part (it already carries the URL). */
export type FooterLine = Run[] | { htmlOnly: Run[] };

export interface MailDoc {
  lang: MailLocale;
  subject: string;
  /** A sentence that says what happened; it ends in a full stop. */
  title: string;
  /** The hidden line a client shows beside the subject; the first sentence of the first paragraph when unset. */
  preheader?: string;
  blocks: Block[];
  action?: { label: string; url: string };
  footer: FooterLine[];
  replyTo?: string;
  headers?: Record<string, string>;
}

// ── Runs ────────────────────────────────────────────────────────────────────

/** One plain address: one `@` and none of the characters that would make a mailto carry more. */
function plainAddress(a: string): boolean {
  return /^[^\s<>"?&#%,;@]+@[^\s<>"?&#%,;@]+$/.test(a);
}

/** A figure and its unit stay on one line in the html part; the text part keeps plain spaces. */
function tie(t: string): string {
  return esc(t).replace(/(\d) (GB|MB|%|\$|€|£|h)(?![A-Za-z])/g, "$1&nbsp;$2");
}

/** A line break inside a value is a space in the text part: a value never adds a line of its own. */
const oneLine = (t: string): string => t.replace(/\r\n?|\n/g, " ");

function runText(r: Run): string {
  if (typeof r === "string") return oneLine(r);
  if ("b" in r) return oneLine(r.b);
  if ("mail" in r) return oneLine(r.mail);
  const href = safeUrl(r.href);
  if (r.link === href) return oneLine(r.link);
  const bare = href.replace(/\/$/, "");
  if (bare.replace(/^https:\/\//, "") === r.link) return bare;
  return oneLine(`${r.link} (${href})`);
}

function runHtml(r: Run, cls: string, color: string): string {
  if (typeof r === "string") return tie(r);
  if ("b" in r) return `<strong style="font-weight:700;">${tie(r.b)}</strong>`;
  if ("mail" in r) {
    if (!plainAddress(r.mail)) return esc(r.mail);
    return `<a class="${cls}" href="mailto:${esc(r.mail)}" style="color:${color};text-decoration:underline;">${esc(r.mail)}</a>`;
  }
  const wrap = /^https?:/.test(r.link) ? "overflow-wrap:anywhere;word-break:break-word;" : "";
  return `<a class="${cls}" href="${esc(safeUrl(r.href))}" style="color:${color};text-decoration:underline;${wrap}">${esc(r.link)}</a>`;
}

const runsText = (runs: Run[]): string => runs.map(runText).join("");
const runsHtml = (runs: Run[], cls: string, color: string): string => runs.map((r) => runHtml(r, cls, color)).join("");

/** The first sentence: up to the first full stop that ends a word (a German date's "13." is not one). */
function firstSentence(t: string): string {
  for (let i = 2; i < t.length; i++) {
    if (t[i] !== ".") continue;
    const before = t[i - 1]!;
    const after = t[i + 1];
    if (/[\d\s]/.test(before)) continue;
    if (after === undefined || /\s/.test(after)) return t.slice(0, i + 1);
  }
  return t;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

function blockHtml(b: Block, last: boolean, hasAction: boolean): string {
  const mb = last ? (hasAction ? 24 : 0) : 14;
  const read = `${M["t-read"]}px/27px ${TEXT}`;
  const P = (inner: string, weight = 400): string =>
    `        <p class="i" style="margin:0 0 ${mb}px;font:${weight} ${read};color:${L.ink};">${inner}</p>`;
  if ("p" in b) return P(runsHtml(b.p, "i", L.ink));
  if ("strong" in b) return P(runsHtml(b.strong, "i", L.ink), 700);
  if ("facts" in b) {
    return `        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${mb}px;">\n` +
      b.facts.map(([k, v]) =>
        `          <tr><td class="j" style="vertical-align:top;padding:0 16px 0 0;font:400 ${read};color:${L.ink2};white-space:nowrap;">${esc(k)}</td>` +
        `<td class="i" style="vertical-align:top;font:700 ${read};color:${L.ink};">${esc(v)}</td></tr>`).join("\n") +
      "\n        </table>";
  }
  if ("code" in b) {
    return `        <p class="i" style="margin:0 0 8px;font:400 ${read};color:${L.ink};">${esc(b.label)}</p>\n` +
      `        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${mb}px;"><tr>` +
      `<td class="q i" style="background:${L["soft-sheet"]};border-radius:${M["r-row"]}px;padding:12px 16px;font:700 22px/28px ${MONO};color:${L.ink};letter-spacing:0.04em;">${esc(b.code)}</td></tr></table>`;
  }
  throw new Error("mail frame: unknown block");
}

function blockText(b: Block): string {
  if ("p" in b) return runsText(b.p);
  if ("strong" in b) return runsText(b.strong);
  if ("facts" in b) return b.facts.map(([k, v]) => `${oneLine(k)}: ${oneLine(v)}`).join("\n");
  if ("code" in b) return `${b.label} ${b.code}`;
  throw new Error("mail frame: unknown block");
}

// ── The frame ───────────────────────────────────────────────────────────────

/** The name the wordmark spells, in both parts: the html sets its full stop in `hot`, the text part writes it plain. */
const MARK_NAME = "ohmail";

/** The wordmark, typed: nothing is fetched and it turns dark in every client. */
const WORDMARK = `<span class="i" style="font:900 22px/22px ${HEAD};color:${L.ink};letter-spacing:-0.02em;">${MARK_NAME}` +
  `<span class="r" style="color:${L.hot};">.</span></span>`;

export function renderDoc(doc: MailDoc): RenderedEmail {
  const lang: MailLocale = doc.lang === "de" ? "de" : "en";
  const blocks = doc.blocks;
  const action = doc.action ? { label: doc.action.label, url: safeUrl(doc.action.url) } : null;
  const first = blocks[0];
  const preheader = doc.preheader ?? firstSentence(first && "p" in first ? runsText(first.p) : doc.title);
  const vmlWidth = action ? Math.ceil(action.label.length * 9.2) + 50 : 0;
  const button = action ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>
          <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${esc(action.url)}" style="height:48px;v-text-anchor:middle;width:${vmlWidth}px;" arcsize="50%" stroke="f" fillcolor="${L.solid}"><w:anchorlock xmlns:w="urn:schemas-microsoft-com:office:word"/><center style="color:${L["on-solid"]};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${esc(action.label)}</center></v:roundrect><![endif]-->
          <!--[if !mso]><!--><a class="k" href="${esc(action.url)}" style="display:inline-block;background:${L.solid};border-radius:999px;padding:15px 24px;font:700 16px/18px ${TEXT};color:${L["on-solid"]};text-decoration:none;white-space:nowrap;">${esc(action.label)}</a><!--<![endif]-->
        </td></tr></table>` : "";
  const footerHtml = doc.footer.map((f) => (Array.isArray(f) ? f : f.htmlOnly));
  const footerText = doc.footer.filter((f): f is Run[] => Array.isArray(f));
  const html = `<!doctype html>
<html lang="${lang}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(doc.title)}</title>
<style>
${DARK_BLOCK}
</style>
</head>
<body class="g" style="margin:0;padding:0;background:${L.ground};">
<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${L.ground};">${esc(preheader)}</span>
<table class="g" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${L.ground};">
  <tr><td align="center" style="padding:32px 12px 40px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
      <tr><td style="padding:0 ${M["sheet-pad"]}px 20px;">
        ${WORDMARK}
      </td></tr>
      <tr><td class="s" style="background:${L.sheet};border-radius:${M["r-sheet"]}px;padding:${M["sheet-pad"]}px;">
        <h1 class="i" style="margin:0 0 16px;font:900 ${M["t-head"]}px/32px ${HEAD};color:${L.ink};letter-spacing:-0.02em;">${tie(doc.title)}</h1>
${blocks.map((b, i) => blockHtml(b, i === blocks.length - 1, action !== null)).join("\n")}${button}
      </td></tr>
      <tr><td class="j" style="padding:20px ${M["sheet-pad"]}px 0;font:400 ${M["t-meta"]}px/20px ${TEXT};color:${L.ink2};">
${footerHtml.map((f, i) => `        <p style="margin:0${i === footerHtml.length - 1 ? "" : " 0 6px"};">${runsHtml(f, "j", L.ink2)}</p>`).join("\n")}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`;
  const text = [
    `${MARK_NAME}.`, "", doc.title, "",
    ...blocks.flatMap((b) => [blockText(b), ""]),
    ...(action ? [`${action.label}:`, action.url, ""] : []),
    "--", ...footerText.map(runsText), "",
  ].join("\n");
  return {
    subject: doc.subject,
    text,
    html,
    ...(doc.headers ? { headers: doc.headers } : {}),
    ...(doc.replyTo !== undefined ? { replyTo: doc.replyTo } : {}),
  };
}
