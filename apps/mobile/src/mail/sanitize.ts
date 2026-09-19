/**
 * The phone's mail sanitizer — the same RULES the web reader executes (the shared
 * `mail-render-rules` module in `@ohmail/client-engine`; `MessageBody.tsx` is the reference),
 * run over an htmlparser2 parse because React Native has no DOM for DOMPurify. Two layers,
 * like the web: this pass decides what the document SAYS; the frame it lands in decides what
 * it MAY DO (`MailBodyFrame` — JS off, CSP `default-src 'none'; img-src data:`, no real URL in
 * the document at all). The output is CONSTRUCTED, never sliced from the input: every text and
 * attribute byte is re-escaped on emit, so a parser differential can cost a picture but cannot
 * smuggle raw sender bytes into the rendered document.
 */

import { parseDocument } from "htmlparser2";
import { Element, Text, type AnyNode, type ChildNode } from "domhandler";
import {
  BEACON_PATH,
  BLANK_GIF,
  cidOfSrc,
  CID_URL,
  declaresPixelAttrs,
  INLINE_IMAGE_SRC,
  MAIL_ALLOWED_ATTR,
  MAIL_ALLOWED_TAGS,
  MAIL_MAX_HTML_CHARS,
  mailHostOfUrl,
  neutraliseCss,
  REMOTE_URL,
  SAFE_HREF,
} from "@ohmail/client-engine";

/** One blocked remote reference — the web's `BlockedAsset` shape, minted by the same rules. */
export interface PhoneBlockedAsset {
  url: string;
  host: string;
  via: "img" | "css" | "attr";
  pixel: boolean;
}

export interface PhoneSanitizedMail {
  /** The sanitized body markup — for `buildPhoneMailDocument`, never for any other sink. */
  html: string;
  /** Every remote reference refused, deduplicated by `via:url` — what the notice bar counts. */
  blocked: PhoneBlockedAsset[];
  /** Remote stylesheet urls (`@import`) — refused with no consent story, said separately. */
  sheets: string[];
  /** Unresolved Content-IDs the body references, in reference order — `loadInlineImages`' ask. */
  cids: string[];
  /**
   * THE LINK TABLE. The document never carries a sender URL: every allowed href is rewritten to
   * `ohmail-link:<index>` and the real target lives here, so the only way a link can open is
   * through the app's own confirm — the WebView hands non-whitelisted navigations to the OS,
   * and a raw href would reach the browser past the confirm.
   */
  links: string[];
  /** The html part was past {@link MAIL_MAX_HTML_CHARS} and was not rendered at all. */
  oversize?: boolean;
}

export interface PhoneSanitizeOptions {
  /** `contentId → data: URI` from the engine's mint — gated by {@link INLINE_IMAGE_SRC} on write. */
  inlineImages?: ReadonlyMap<string, string>;
  /** `url → data: URI` from the app's consented fetches — same gate, same write. */
  resolvedRemote?: ReadonlyMap<string, string>;
  /** The account's own switch (mail 0072): a classified beacon may resolve like any picture. */
  loadPixels?: boolean;
}

/** The scheme the document's links carry instead of their targets. */
export const PHONE_LINK_SCHEME = "ohmail-link:";

/**
 * Tags whose CONTENT goes with them when the tag is refused — DOMPurify's `FORBID_CONTENTS`
 * default, which the web executes implicitly. Every other refused tag keeps its children
 * (a `<picture>` is dropped, the `<img>` inside it survives).
 */
const DROP_CONTENT = new Set([
  "annotation-xml", "audio", "desc", "foreignobject", "head", "iframe", "math", "mi", "mn",
  "mo", "ms", "mtext", "noembed", "noframes", "noscript", "optgroup", "option", "plaintext",
  "script", "svg", "template", "title", "video", "xmp",
]);

/** The void elements among the allowed tags — serialized self-closed, never with an end tag. */
const VOID_TAGS = new Set(["area", "br", "col", "hr", "img", "wbr"]);

const ALLOWED_TAG_SET = new Set(MAIL_ALLOWED_TAGS);
const ALLOWED_ATTR_SET = new Set(MAIL_ALLOWED_ATTR);

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `<` may not survive into a `<style>` element's raw text (it is the one sink html entities do
 * not protect), and CSS has its own escape for it: `\3c ` reads back as `<` inside a string and
 * is invalid-but-inert everywhere else. Value-preserving where it matters, breakout-proof by
 * construction.
 */
function cssTextSafe(css: string): string {
  return css.replace(/</g, "\\3c ");
}

/** A style attribute that could name a resource — the same precheck the web's fast path runs. */
const STYLE_NEEDS_SCAN = /url\(|image-set\(|@import|\\/i;

/**
 * Substitute `url(cid:…)` in ONE inline-style value from the message's own minted parts — the
 * same map and the same gate as the `<img>` branch, after `neutraliseCss` has already decided
 * every remote reference. Unresolved (or resolved to anything but a gated raster `data:` URI)
 * it stays verbatim: `cid:` is inert by {@link INERT_CSS_URL}, and drawing nothing costs
 * nothing. `<style>` SHEETS deliberately keep their `cid:` verbatim — the web reader's own
 * posture: element text may not be rewritten after sanitisation.
 */
function substituteCssCids(css: string, inline: ReadonlyMap<string, string> | undefined): string {
  if (!inline || inline.size === 0 || !/cid:/i.test(css)) return css;
  return css.replace(/url\(\s*(['"]?)\s*(cid:[^'")]*)\1\s*\)/gi, (whole, _q: string, ref: string) => {
    const id = cidOfSrc(ref.trim());
    const minted = id === null ? undefined : inline.get(id);
    if (minted === undefined || !INLINE_IMAGE_SRC.test(minted)) return whole;
    return `url("${minted}")`;
  });
}

/**
 * Sanitize one message's html by the shared rule set. Pure — the caller memoizes on the html
 * and the two maps' identities, exactly as the web memoizes its pass.
 */
export function sanitizeMailHtmlPhone(html: string, opts: PhoneSanitizeOptions = {}): PhoneSanitizedMail {
  const blocked: PhoneBlockedAsset[] = [];
  const sheets: string[] = [];
  const cids: string[] = [];
  const links: string[] = [];
  if (html.length > MAIL_MAX_HTML_CHARS) {
    return { html: "", blocked, sheets, cids, links, oversize: true };
  }

  const seen = new Set<string>();
  const record = (url: string, via: PhoneBlockedAsset["via"], pixel: boolean): void => {
    const key = `${via}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocked.push({ url, host: mailHostOfUrl(url), via, pixel });
  };
  const recordSheet = (url: string): void => {
    if (!sheets.includes(url)) sheets.push(url);
  };
  const wantCid = (id: string): void => {
    if (!cids.includes(id)) cids.push(id);
  };

  /** The css `url()` rule — one place, like the web's `cssUrl`: a beacon is never resolved. */
  const cssUrl = (url: string, tiny = false): string | null => {
    const beacon = tiny || BEACON_PATH.test(url);
    record(url, "css", beacon);
    const minted = !beacon || opts.loadPixels === true ? opts.resolvedRemote?.get(url) : undefined;
    return minted !== undefined && INLINE_IMAGE_SRC.test(minted) ? minted : null;
  };

  const doc = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true });

  /**
   * `<style>` lives in `<head>` and the walk refuses `head` whole, so — exactly as the web
   * moves head styles into the body before DOMPurify sees them — the head's sheets are emitted
   * FIRST, in source order, neutralised like any other.
   */
  const headStyles: Element[] = [];
  const findHeadStyles = (nodes: readonly ChildNode[]): void => {
    for (const n of nodes) {
      if (!(n instanceof Element)) continue;
      if (n.tagName === "head") {
        for (const c of n.children) {
          if (c instanceof Element && c.tagName === "style") headStyles.push(c);
        }
        continue;
      }
      if (n.tagName === "html") findHeadStyles(n.children);
    }
  };
  findHeadStyles(doc.children);

  const out: string[] = [];

  const emitStyle = (el: Element): void => {
    const text = el.children.map((c) => (c instanceof Text ? c.data : "")).join("");
    const neutral = neutraliseCss(text, (url) => cssUrl(url), recordSheet);
    out.push("<style>", cssTextSafe(neutral), "</style>");
  };

  const emitElement = (el: Element): void => {
    const tag = el.tagName;
    if (!ALLOWED_TAG_SET.has(tag)) {
      if (!DROP_CONTENT.has(tag)) walk(el.children);
      return;
    }
    if (tag === "style") {
      emitStyle(el);
      return;
    }

    const attr = (name: string): string | null => {
      const v = el.attribs[name];
      return v === undefined ? null : v;
    };

    // Decided FIRST and used by both the style rewrite and the img branch, like the web's
    // post-pass, so the answer cannot depend on which of them runs first.
    const pixel = tag === "img" && (declaresPixelAttrs(attr) || BEACON_PATH.test(attr("src") ?? ""));

    const kept: Array<[string, string]> = [];
    for (const [name, rawValue] of Object.entries(el.attribs)) {
      if (!ALLOWED_ATTR_SET.has(name)) continue;
      let value = rawValue;

      if (name === "srcset") {
        // A second, independent way to name a remote image; dropped whole (no consent story
        // for a candidate set), each remote candidate still counted — the web's rule.
        for (const cand of rawValue.split(",")) {
          const u = cand.trim().split(/\s+/)[0];
          if (u && REMOTE_URL.test(u)) record(u, "img", pixel);
        }
        continue;
      }
      if (name === "background") {
        // html 3.2, still emitted by bulk mail. Dropped even under consent; counted.
        if (REMOTE_URL.test(rawValue)) record(rawValue, "attr", BEACON_PATH.test(rawValue));
        continue;
      }
      if (name === "style") {
        if (STYLE_NEEDS_SCAN.test(rawValue)) {
          value = substituteCssCids(
            neutraliseCss(rawValue, (url) => cssUrl(url, pixel)),
            opts.inlineImages,
          );
        }
        kept.push([name, value]);
        continue;
      }
      if (name === "src" && tag === "img") {
        const src = rawValue.trim();
        if (CID_URL.test(src)) {
          const id = cidOfSrc(src);
          const minted = id === null ? undefined : opts.inlineImages?.get(id);
          if (minted !== undefined && INLINE_IMAGE_SRC.test(minted)) {
            kept.push(["src", minted]);
          } else {
            // Not minted yet (or not mintable): a blank box, never a fetch — and the id is
            // recorded so the engine can be asked for exactly the parts the document names.
            if (id !== null && minted === undefined) wantCid(id);
            kept.push(["src", BLANK_GIF]);
          }
          continue;
        }
        if (REMOTE_URL.test(src)) {
          record(src, "img", pixel);
          // A beacon is never resolved, not even after consent — `pixel` overrides the map,
          // unless the account's own switch lifted exactly that (mail 0072).
          const minted = !pixel || opts.loadPixels === true ? opts.resolvedRemote?.get(src) : undefined;
          kept.push(["src", minted !== undefined && INLINE_IMAGE_SRC.test(minted) ? minted : BLANK_GIF]);
          continue;
        }
        // `data:` and every other scheme: refused by the URI gate (the web strips these), and
        // blanked rather than left dangling so the layout keeps its box.
        kept.push(["src", BLANK_GIF]);
        continue;
      }
      if (name === "src") continue; // `src` off anything but `<img>` names nothing renderable
      if (name === "href") {
        const href = rawValue.trim();
        // Only a scheme the gate admits AND a target the app can open leaves a token; `cid:`
        // passes the gate but names a part of this message, so it stays visible-but-inert.
        if (SAFE_HREF.test(href) && !CID_URL.test(href)) {
          links.push(href);
          kept.push(["href", `${PHONE_LINK_SCHEME}${links.length - 1}`]);
        }
        continue;
      }
      kept.push([name, value]);
    }

    const attrs = kept.map(([n, v]) => ` ${n}="${escAttr(v)}"`).join("");
    if (VOID_TAGS.has(tag)) {
      out.push(`<${tag}${attrs}/>`);
      return;
    }
    out.push(`<${tag}${attrs}>`);
    walk(el.children);
    out.push(`</${tag}>`);
  };

  const walk = (nodes: readonly ChildNode[]): void => {
    for (const n of nodes) {
      if (n instanceof Text) {
        out.push(escText(n.data));
        continue;
      }
      if (n instanceof Element) {
        emitElement(n);
        continue;
      }
      // Comments, doctypes, CDATA, processing instructions: dropped.
    }
  };

  for (const s of headStyles) emitStyle(s);

  /** The body's children when the mail has a document structure; the whole parse otherwise. */
  const findBody = (nodes: readonly AnyNode[]): Element | null => {
    for (const n of nodes) {
      if (!(n instanceof Element)) continue;
      if (n.tagName === "body") return n;
      if (n.tagName === "html") {
        const inner = findBody(n.children);
        if (inner) return inner;
      }
    }
    return null;
  };
  const body = findBody(doc.children);
  walk(body ? body.children : doc.children);

  return { html: out.join(""), blocked, sheets, cids, links };
}
