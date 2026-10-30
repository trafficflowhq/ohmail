// @vitest-environment jsdom
/**
 * THE SANITIZER'S WALK IS A LOOP NOW, AND IT WRITES THE SAME BYTES (`src/mail/sanitize.ts`). The
 * recursive walk it replaces overflowed the reader's stack at thousands of nested `<b>` (a few kilobytes, the whole
 * reader screen replaced). The oracle below IS that walk, the base's code with its comments removed,
 * and every input here goes through both: this app's sanitizer suite's own inputs (recorded by running
 * that suite in this file), the web's mutation-XSS corpus, 500 seeded random trees and the depth
 * shapes. A rule change moves both copies or retires this file.
 */
import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "htmlparser2";
import { Element, Text, type AnyNode, type ChildNode } from "domhandler";
import {
  BLANK_GIF,
  cidOfSrc,
  CID_URL,
  declaresPixelAttrs,
  INLINE_IMAGE_SRC,
  isBeaconShaped,
  MAIL_ALLOWED_ATTR,
  MAIL_ALLOWED_TAGS,
  MAIL_MAX_HTML_CHARS,
  mailHostOfUrl,
  neutraliseCss,
  REMOTE_URL,
  SAFE_HREF,
} from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import type { PhoneBlockedAsset, PhoneSanitizedMail, PhoneSanitizeOptions } from "../src/mail/sanitize";
import * as XSS from "../../webapp/test/fixtures/mutation-xss-payloads";
import { HOSTILE_HTML, OWNER_BILLING_HTML } from "../../webapp/test/fixtures/owner-billing-email";

/** Every input the phone sanitizer suite hands the sanitizer, recorded through a transparent wrapper. */
const seen = vi.hoisted(() => [] as Array<[string, PhoneSanitizeOptions | undefined]>);
vi.mock("../src/mail/sanitize", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mail/sanitize")>();
  return {
    ...real,
    sanitizeMailHtmlPhone: (html: string, opts?: PhoneSanitizeOptions) => {
      seen.push([html, opts]);
      return real.sanitizeMailHtmlPhone(html, opts);
    },
  };
});
const { sanitizeMailHtmlPhone: looped } = await vi.importActual<typeof import("../src/mail/sanitize")>("../src/mail/sanitize");
// The suite's own cases run here as well, through the wrapper; their inputs are what `seen` holds.
await import("./mail-sanitize.test");

// ── THE ORACLE: the recursive walk, verbatim from the base but for its comments ────────────────
const PHONE_LINK_SCHEME = "ohmail-link:";
const DROP_CONTENT = new Set([
  "annotation-xml", "audio", "desc", "foreignobject", "head", "iframe", "math", "mi", "mn",
  "mo", "ms", "mtext", "noembed", "noframes", "noscript", "optgroup", "option", "plaintext",
  "script", "svg", "template", "title", "video", "xmp",
]);
const VOID_TAGS = new Set(["area", "br", "col", "hr", "img", "wbr"]);
const ALLOWED_TAG_SET = new Set(MAIL_ALLOWED_TAGS);
const ALLOWED_ATTR_SET = new Set(MAIL_ALLOWED_ATTR);
function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function cssTextSafe(css: string): string {
  return css.replace(/</g, "\\3c ");
}
const STYLE_NEEDS_SCAN = /url\(|image-set\(|@import|\\/i;
function substituteCssCids(css: string, inline: ReadonlyMap<string, string> | undefined): string {
  if (!inline || inline.size === 0 || !/cid:/i.test(css)) return css;
  return css.replace(/url\(\s*(['"]?)\s*(cid:[^'")]*)\1\s*\)/gi, (whole, _q: string, ref: string) => {
    const id = cidOfSrc(ref.trim());
    const minted = id === null ? undefined : inline.get(id);
    if (minted === undefined || !INLINE_IMAGE_SRC.test(minted)) return whole;
    return `url("${minted}")`;
  });
}
function recursiveSanitize(html: string, opts: PhoneSanitizeOptions = {}): PhoneSanitizedMail {
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
  const cssUrl = (url: string, tiny = false): string | null => {
    const beacon = tiny || isBeaconShaped(url);
    record(url, "css", beacon);
    const minted = !beacon || opts.loadPixels === true ? opts.resolvedRemote?.get(url) : undefined;
    return minted !== undefined && INLINE_IMAGE_SRC.test(minted) ? minted : null;
  };
  const doc = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true });
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
    const pixel = tag === "img" && (declaresPixelAttrs(attr) || isBeaconShaped(attr("src") ?? ""));
    const kept: Array<[string, string]> = [];
    for (const [name, rawValue] of Object.entries(el.attribs)) {
      if (!ALLOWED_ATTR_SET.has(name)) continue;
      let value = rawValue;
      if (name === "srcset") {
        for (const cand of rawValue.split(",")) {
          const u = cand.trim().split(/\s+/)[0];
          if (u && REMOTE_URL.test(u)) record(u, "img", pixel);
        }
        continue;
      }
      if (name === "background") {
        if (REMOTE_URL.test(rawValue)) record(rawValue, "attr", isBeaconShaped(rawValue));
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
            if (id !== null && minted === undefined) wantCid(id);
            kept.push(["src", BLANK_GIF]);
          }
          continue;
        }
        if (REMOTE_URL.test(src)) {
          record(src, "img", pixel);
          const minted = !pixel || opts.loadPixels === true ? opts.resolvedRemote?.get(src) : undefined;
          kept.push(["src", minted !== undefined && INLINE_IMAGE_SRC.test(minted) ? minted : BLANK_GIF]);
          continue;
        }
        kept.push(["src", BLANK_GIF]);
        continue;
      }
      if (name === "src") continue;
      if (name === "href") {
        const href = rawValue.trim();
        if (SAFE_HREF.test(href) && !CID_URL.test(href)) {
          links.push(href);
          kept.push(["href", `${PHONE_LINK_SCHEME}${links.length - 1}`]);
        }
        continue;
      }
      kept.push([name, value]);
    }
    const named = ([n, v]: [string, string]): boolean =>
      n === "alt" || n === "aria-hidden" || n === "role" || ((n === "title" || n === "aria-label") && v.trim() !== "");
    if (tag === "img" && !kept.some(named)) {
      kept.push(["alt", pixel ? "" : Copy.mailPicture]);
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
    }
  };
  for (const s of headStyles) emitStyle(s);
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

// ── THE DIFFERENTIAL ────────────────────────────────────────────────────────────────────────────

/** A seeded generator, so a red names a reproducible input. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** A random document over the walk's every branch: allowed, void, dropped-with-content, unknown, head styles, nested html. */
function randomHtml(r: () => number): string {
  const attrs = [
    "", ' class="c"', ' title="t &amp; &quot;q&quot;"', ' href="https://ex.invalid/a"', ' href="javascript:alert(1)"',
    ' href="cid:part@x"', ' src="https://img.invalid/p.png"', ' src="cid:pic@x"', ' src="data:image/png;base64,AAAA"',
    ' style="color:red"', ' style="background:url(https://img.invalid/bg.png)"', ' style="background:url(cid:pic@x)"',
    ' onclick="x()"', ' width="1" height="1"', ' srcset="https://img.invalid/a.png 2x"', ' background="https://img.invalid/b.png"',
  ];
  const tags = ["p", "b", "i", "div", "span", "a", "table", "tr", "td", "ul", "li", "img", "br", "hr", "font", "center",
    "script", "svg", "template", "noscript", "title", "option", "foo", "x-y", "html", "head", "body", "style"];
  const texts = ["t", "a &amp; b", "<", "x>y", "&lt;tag&gt;", "é\u{1F600}", " ", "\n"];
  let out = "";
  const open: string[] = [];
  const n = 1 + Math.floor(r() * 40);
  for (let k = 0; k < n; k++) {
    const roll = r();
    if (roll < 0.45) {
      const tag = pick(r, tags);
      if (tag === "style") out += `<style>.k${k}{background:url(https://img.invalid/${k}.png)} a{color:blue}</style>`;
      else {
        out += `<${tag}${pick(r, attrs)}>`;
        if (r() < 0.7) open.push(tag);
      }
    } else if (roll < 0.7 && open.length > 0) {
      out += `</${open.pop()!}>`;
    } else if (roll < 0.75) {
      out += "<!-- c -->";
    } else {
      out += pick(r, texts);
    }
  }
  while (open.length > 0 && r() < 0.5) out += `</${open.pop()!}>`;
  return out;
}

function randomOpts(r: () => number): PhoneSanitizeOptions | undefined {
  if (r() < 0.4) return undefined;
  return {
    inlineImages: r() < 0.5 ? new Map([["pic@x", PNG]]) : undefined,
    resolvedRemote: r() < 0.5 ? new Map([["https://img.invalid/p.png", PNG], ["https://img.invalid/bg.png", PNG]]) : undefined,
    loadPixels: r() < 0.5,
  };
}

const same = (html: string, opts?: PhoneSanitizeOptions): void => {
  expect(looped(html, opts), html.slice(0, 200)).toEqual(recursiveSanitize(html, opts));
};

describe("the looped walk writes what the recursive walk wrote", () => {
  it("over every input the phone sanitizer suite hands the sanitizer", () => {
    const inputs = [...seen];
    expect(inputs.length, "the suite's inputs were not recorded").toBeGreaterThan(0);
    for (const [html, opts] of inputs) same(html, opts);
  });

  it("over the web's mutation-XSS corpus and its hostile and real-shape fixtures", () => {
    const corpus = Object.values(XSS).flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));
    corpus.push(XSS.quadraticCss(20_000), HOSTILE_HTML, OWNER_BILLING_HTML);
    expect(corpus.length).toBeGreaterThan(10);
    for (const html of corpus) {
      same(html);
      same(html, { resolvedRemote: new Map([[`https://${XSS.MXSS_HOST}/x.png`, PNG]]), loadPixels: true });
    }
  });

  it("over 500 seeded random trees, with and without minted pictures", () => {
    const r = rng(0x5eed);
    for (let k = 0; k < 500; k++) same(randomHtml(r), randomOpts(r));
  });

  it("over the depth shapes up to 1,000, in every walk the sanitizer has", () => {
    for (const n of [1, 10, 100, 500, 1_000]) {
      same(`${"<b>".repeat(n)}deep${"</b>".repeat(n)}`);
      same(`${"<div><i>".repeat(Math.ceil(n / 2))}x`);
      same(`${"<html>".repeat(n)}<head><style>p{color:red}</style></head><body><p>in</p></body>`);
      same(`${"<foo>".repeat(n)}<a href="https://ex.invalid/${n}">a</a>`);
      same(`<p>${"<script>".repeat(n)}hidden</p>`);
    }
  });
});

describe("a message nested thousands deep is sanitized, where the recursion overflowed", () => {
  it("20,000 nested <b>: the loop returns with every tag closed; the recursive walk throws", () => {
    const html = `${"<b>".repeat(20_000)}deep${"</b>".repeat(20_000)}`;
    const out = looped(html).html;
    expect(out.split("<b>").length - 1).toBe(20_000);
    expect(out.split("</b>").length - 1).toBe(20_000);
    expect(out).toContain("deep");
    expect(() => recursiveSanitize(html)).toThrow(RangeError);
  });

  it("20,000 nested <html>: the loop finds the content; the recursive walk throws", () => {
    const html = `${"<html>".repeat(20_000)}<p>inner</p>`;
    expect(looped(html).html).toBe("<p>inner</p>");
    expect(() => recursiveSanitize(html)).toThrow(RangeError);
  });
});
