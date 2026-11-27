import { Parser } from "htmlparser2";
import { isMailto } from "./frame-nav";

interface Link {
  href: string;
  label: string;
}

interface TextLink extends Link {
  start: number;
  end: number;
}

const ADDR = /^[a-z0-9.!#$%&'*+/=?^_{}|~-]+@(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i;
const LEADING_PUNCTUATION = /^[([{'`]+/;
const SENTENCE_PUNCTUATION = ".,;:!?'`";
const CLOSING_BRACKET: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const MAX_TAIL = 32;
export const MAX_AUTO_LINKS = 128;

/** Trim passage punctuation while keeping balanced brackets in the actual destination. */
function trimPunctuation(text: string): string {
  let end = text.length;
  while (end > 0 && SENTENCE_PUNCTUATION.includes(text[end - 1]!)) end -= 1;
  if (end === 0 || !")]}".includes(text[end - 1]!)) return text.slice(0, end);

  const balance: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  for (let i = 0; i < end; i += 1) {
    const ch = text[i]!;
    const close = CLOSING_BRACKET[ch];
    if (close !== undefined) balance[close]! += 1;
    else if (balance[ch] !== undefined) balance[ch]! -= 1;
  }
  while (end > 0) {
    const ch = text[end - 1]!;
    if (!SENTENCE_PUNCTUATION.includes(ch)) {
      if ((balance[ch] ?? 0) >= 0) break;
      balance[ch]! += 1;
    }
    end -= 1;
  }
  return text.slice(0, end);
}

function linkOf(candidate: string): Link | null {
  if (ADDR.test(candidate)) return { href: "mailto:" + encodeURIComponent(candidate).replace("%40", "@"), label: candidate };
  if (isMailto(candidate)) return { href: candidate, label: candidate.slice("mailto:".length).split("?")[0] || candidate };
  if (/^tel:\+?[\d().-]+$/i.test(candidate)) return { href: candidate, label: candidate.slice("tel:".length) };
  const web = /^https?:\/\/([^/?#]+)([/?#].*)?$/i.exec(candidate);
  if (!web || /[@%\\\p{C}]/u.test(web[1]!) || /[\\\p{C}]/u.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.host === "") return null;
    const tail = web[2] ?? "";
    return {
      href: url.href,
      label: web[1]! + (tail === "/" ? "" : tail.length > MAX_TAIL ? tail.slice(0, MAX_TAIL) + "…" : tail),
    };
  } catch {
    return null;
  }
}

/** The stored text alternative writes a formatted link as "label (href)". */
function signatureLinks(text: string, html: string): TextLink[] {
  const links: TextLink[] = [];
  let cursor = 0;
  let anchor: Link | null = null;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "a") anchor = { href: attrs.href ?? "", label: "" };
    },
    ontext(text) {
      if (anchor !== null) anchor.label += text;
    },
    onclosetag(name) {
      if (name !== "a" || anchor === null) return;
      const { href, label } = anchor;
      anchor = null;
      if (links.length >= MAX_AUTO_LINKS) return;
      const link = linkOf(href);
      if (link === null) return;

      const words = label.replace(/\s+/g, " ").trim();
      const named = words !== "" && words !== href;
      const printed = named ? words + " (" + href + ")" : href;
      const start = text.indexOf(printed, cursor);
      if (start < 0) return;
      cursor = start + printed.length;
      links.push({ href: link.href, label: named ? words : link.label, start, end: cursor });
    },
  });
  parser.end(html);
  return links;
}

/** Offsets map onto the text being drawn. Only admitted links create interactive text nodes. */
export function textLinks(text: string, signatureHtml?: string | null): TextLink[] {
  const formatted = signatureHtml ? signatureLinks(text, signatureHtml) : [];
  const plain: TextLink[] = [];
  if (formatted.length === MAX_AUTO_LINKS) return formatted;
  for (const token of text.matchAll(/[^\s<>"]+/g)) {
    // Keep apostrophes inside addresses while accepting prose that quotes a URL.
    const raw = token[0];
    const left = LEADING_PUNCTUATION.exec(raw)?.[0].length ?? 0;
    if (!raw.includes(":") && !raw.includes("@")) continue;
    const candidate = trimPunctuation(raw.slice(left));
    const link = linkOf(candidate);
    if (link === null) continue;
    const start = token.index + left;
    const end = start + candidate.length;
    if (formatted.some((span) => start < span.end && end > span.start)) continue;
    plain.push({ ...link, start, end });
    // A long body page can contain thousands of URLs. Bound the native text spans per block.
    if (plain.length + formatted.length >= MAX_AUTO_LINKS) break;
  }
  return formatted.length === 0 ? plain : [...formatted, ...plain].sort((a, b) => a.start - b.start);
}
