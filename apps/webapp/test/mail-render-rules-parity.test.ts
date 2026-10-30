/** @vitest-environment jsdom */
/**
 * ═══ THE TWO SPELLINGS OF THE MAIL RENDERER'S RULES CANNOT DRIFT APART ═══════════════════════
 *
 * `@ohmail/client-engine`'s `mail-render-rules` is the phone reader's rule set, MIRRORED from
 * this app's `MessageBody.tsx` (the reference). Three readings hold them equal: the DATA read
 * out of the reference's own source text (the tables are module-private there — text is the
 * read that reddens when either side moves); the CSS neutraliser held to BEHAVIORAL equality
 * over the hostile fixture classes plus idempotency; the sanitizer spot-driven against the
 * shared tables. Mutation watched: a tag added to the leaf's allow-list reddened this file and
 * the phone suite at once (restored, `cmp`-proven).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
// node's own URL class, by name — under jsdom the global `URL` refuses file: schemes.
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
/* @reads: apps/webapp/app/components/MessageBody.tsx apps/webapp/app/shell/BodyText.tsx packages/core/src/privacy/tracker-blocker.ts packages/client-engine/src/mail-render-rules.ts packages/core/src/html-text.ts
   Read by a path built at runtime or reached through a package barrel, so no landing pass
   selects this file when one of them moves — the shape `reads-list.mjs` exists for. */

  BEACON_PATH,
  isBeaconShaped,
  BLANK_GIF,
  CID_URL,
  declaresPixelAttrs,
  drawsNoWords,
  FILLER_TOKEN,
  hiddenByOwnStyle,
  INERT_CSS_URL,
  INLINE_IMAGE_SRC,
  MAIL_ALLOWED_TAGS,
  MAIL_MAX_HTML_CHARS,
  MAIL_PRESENTATION_ATTR,
  MAIL_URL_ATTR,
  neutraliseCss as leafNeutraliseCss,
  REMOTE_URL,
  SAFE_HREF,
  withoutFiller,
} from "@ohmail/client-engine";
import {
  MAX_HTML_CHARS,
  neutraliseCss as webNeutraliseCss,
  sanitizeMailHtml,
} from "../app/components/MessageBody";
import {
  BEACON_PATH as SERVER_BEACON_PATH,
  detectTrackers,
  htmlWords,
  isBeaconUrl,
} from "@trafficflow/core/mail";

const SRC = readFileSync(
  join(fileURLToPath(new NodeURL(import.meta.url)), "..", "..", "app/components/MessageBody.tsx"),
  "utf8",
);

/**
 * INLINE_IMAGE_SRC's home in the webapp is the shell's body renderer, not this reference: the
 * inline-image fix gave the sink that gates it its own module, and `MessageBody` imports and
 * re-exports the one literal. So the parity question is asked where the webapp declares it, and
 * the re-export is asserted beside it — two declarations would be the drift this file exists for.
 */
const BODY_TEXT_SRC = readFileSync(
  join(fileURLToPath(new NodeURL(import.meta.url)), "..", "..", "app/shell/BodyText.tsx"),
  "utf8",
);

/** One module-private array literal out of the reference's source, by its declaration. */
function sourceArray(name: string): string[] {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`, "s").exec(SRC);
  if (!m) throw new Error(`${name} not found in MessageBody.tsx`);
  return [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

/** One regex literal out of a webapp source, by its declaration. */
function regexIn(src: string, name: string, where: string): string {
  const m = new RegExp(`const ${name} =\\s*(/.*?/[a-z]*);`, "s").exec(src);
  if (!m) throw new Error(`${name} not found in ${where}`);
  return m[1]!;
}

/** One module-private regex literal out of the reference's source, by its declaration. */
function sourceRegex(name: string): string {
  return regexIn(SRC, name, "MessageBody.tsx");
}

describe("the data is the same data", () => {
  it("tags and attributes", () => {
    expect([...MAIL_ALLOWED_TAGS]).toEqual(sourceArray("ALLOWED_TAGS"));
    expect([...MAIL_URL_ATTR]).toEqual(sourceArray("URL_ATTR"));
    expect([...MAIL_PRESENTATION_ATTR]).toEqual(sourceArray("PRESENTATION_ATTR"));
  });
  it("the gates, the beacon shape, the blank pixel and the size cap", () => {
    expect(sourceRegex("SAFE_HREF")).toBe(SAFE_HREF.toString());
    expect(sourceRegex("REMOTE_URL")).toBe(REMOTE_URL.toString());
    expect(sourceRegex("CID_URL")).toBe(CID_URL.toString());
    expect(sourceRegex("INERT_CSS_URL")).toBe(INERT_CSS_URL.toString());
    expect(regexIn(BODY_TEXT_SRC, "INLINE_IMAGE_SRC", "BodyText.tsx")).toBe(INLINE_IMAGE_SRC.toString());
    // ONE literal in the webapp, re-exported — never a second declaration beside the import.
    expect(SRC).toContain('export { INLINE_IMAGE_SRC } from "../shell/BodyText";');
    expect(SRC).not.toMatch(/const INLINE_IMAGE_SRC =\s*\//);
    expect(SRC).toContain(BLANK_GIF);
    expect(SRC.replace(/\s+/g, " ")).toContain(BEACON_PATH.source.replace(/\s+/g, " "));
    expect(MAIL_MAX_HTML_CHARS).toBe(MAX_HTML_CHARS);
  });
});

describe("neutraliseCss: the same answers on the hostile classes", () => {
  /** The fixture classes the reference's own suite is written against. */
  const FIXTURES = [
    'body{background:url("https://evil.example/x.png")}',
    "body{background:url(https://evil.example/x.png)}",
    "body{background:url( https://evil.example/x )}",
    '@import "https://evil.example/mail.css";p{color:red}',
    '@import"https://s.example/a.css";',
    'div{background-image:image-set("https://e.example/a.png" 1x, "https://e.example/b.png" 2x)}',
    "div{background:\\75 rl(htt\\70 s://evil.example/esc)}",
    'p{content:"\\75 rl(/api/x)"}',
    "/* \" */ p{background:url(https://after-comment.example/x)}",
    "div{background:url(cid:logo@x)}",
    "div{background:url(data:image/png;base64,AAAA)}",
    "div{background:url(/api/relative)}",
    "div{background:url(//host.example/protocol-relative)}",
    "div{background:url(https://unterminated.example/x",
    "div{background-image:image-set(var(--x) 1x)}",
    "@imports q; p{color:red}",
    "p{width:1px;height:1px}",
  ];
  it("byte-equal output and identical callback traffic on every fixture", () => {
    for (const css of FIXTURES) {
      const calls: { web: string[]; leaf: string[]; webSheet: string[]; leafSheet: string[] } = {
        web: [], leaf: [], webSheet: [], leafSheet: [],
      };
      const web = webNeutraliseCss(css, (u) => (calls.web.push(u), null), (u) => calls.webSheet.push(u));
      const leaf = leafNeutraliseCss(css, (u) => (calls.leaf.push(u), null), (u) => calls.leafSheet.push(u));
      expect(leaf, css).toBe(web);
      expect(calls.leaf, css).toEqual(calls.web);
      expect(calls.leafSheet, css).toEqual(calls.webSheet);
    }
  });
  it("both are fixed points, and a substitute lands identically", () => {
    for (const css of FIXTURES) {
      const once = leafNeutraliseCss(css, () => null);
      expect(leafNeutraliseCss(once, () => null), css).toBe(once);
    }
    const sub = "data:image/png;base64,AAAA";
    const css = "div{background:url(https://c.example/x.png)}";
    expect(leafNeutraliseCss(css, () => sub)).toBe(webNeutraliseCss(css, () => sub));
  });
});

describe("the statement runner answers what the shared tables claim", () => {
  it("refuses by omission and keeps the presentation vocabulary", () => {
    const out = sanitizeMailHtml(
      '<table width="100%" align="center"><tr><td bgcolor="#fff">x</td></tr></table><script>1</script><iframe src="https://e.example"></iframe>',
    );
    expect(out.html).toContain('width="100%"');
    expect(out.html).toContain('align="center"');
    expect(out.html).not.toContain("script");
    expect(out.html).not.toContain("iframe");
  });
  it("the href gate is the shared gate", () => {
    expect(SAFE_HREF.test("https://a.example/x")).toBe(true);
    expect(SAFE_HREF.test("javascript:alert(1)")).toBe(false);
    expect(SAFE_HREF.test("data:text/html;base64,x")).toBe(false);
    const out = sanitizeMailHtml('<a href="javascript:alert(1)">press</a>');
    expect(out.html).not.toContain("javascript:");
  });
});

/**
 * THE PIXEL LABEL IS ONE RULE ON EVERY READER AND AT THE PROXY: the web (and the desktop, which
 * renders through it), the phone's leaf and core's hit list give the same verdict on each url and
 * each declared size. A sized picture at `p.png?w=120` read as a beacon on the proxy while the
 * readers had it as a picture would be blank with no sentence saying why.
 */
describe("the pixel rule: the readers and the server's twin give one answer", () => {
  const URLS = [
    "https://t.example/wf/open?upn=abc", "https://t.example/open.aspx?x=1", "https://t.example/pixel.gif?id=1",
    "https://t.example/track/open.php?u=1", "https://t.example/imp",
    "https://images.example/p.png?uid=abc123", "https://t.example/img.jpg?recipient=r-1",
    "https://images.example/p.png?w=120", "https://images.example/p.gif?e2e=1", "https://shop.example/hero.jpg?campaign=fall",
    "https://shop.example/hero.jpg?utm_medium=email", "https://open.example.com/logo.png",
    "https://cdn.example/open-source-logo.png", "https://images.example/p.png?next=/open",
  ];
  it("one literal, and the same verdict on every url", () => {
    expect(SERVER_BEACON_PATH.toString()).toBe(BEACON_PATH.toString());
    const verdicts = URLS.map((u) => [
      u,
      sanitizeMailHtml(`<img src="${u}" width="120" height="120">`).blocked[0]?.pixel,
      BEACON_PATH.test(u),
      isBeaconUrl(u),
      detectTrackers(`<img src="${u}" width="120" height="120">`)[0]?.isPixel ?? false,
    ]);
    for (const [u, ...v] of verdicts) expect(new Set(v).size, `${u}: ${JSON.stringify(v)}`).toBe(1);
    expect(verdicts.filter((v) => v[1] === true).map((v) => v[0]), "the table's beacons").toEqual(URLS.slice(0, 7));
  });

  /**
   * `%6F` and `o` are the same url (RFC 3986 §6.2.2.2), so a pixel spelled
   * `/%6fpen` is a beacon on every reader; a RESERVED escape is a different url — `/wf%2Fopen` is
   * not `/wf/open` — and the control that the decoder decodes nothing else.
   */
  it("a percent-encoded beacon is a beacon on every reader, and a reserved escape stays what it is", () => {
    const ENCODED = [
      "https://t.example/%6fpen?u=1", "https://t.example/%6Fp%65n", "https://t.example/wf/%6Fpen?x=1",
      "https://t.example/p%69xel.gif", "https://t.example/img.jpg?%72ecipient=r-1",
      "https://t.example/wf%2Fopen?u=1", "https://images.example/logo%20final.png",
    ];
    const verdicts = ENCODED.map((u) => [
      u,
      sanitizeMailHtml(`<img src="${u}" width="120" height="120">`).blocked[0]?.pixel,
      isBeaconShaped(u),
      isBeaconUrl(u),
      detectTrackers(`<img src="${u}" width="120" height="120">`)[0]?.isPixel ?? false,
    ]);
    for (const [u, ...v] of verdicts) expect(new Set(v).size, `${u}: ${JSON.stringify(v)}`).toBe(1);
    expect(verdicts.filter((v) => v[1] === true).map((v) => v[0]), "the encoded beacons").toEqual(ENCODED.slice(0, 5));
  });

  it("the declared-size half agrees too, `!important` included", () => {
    const SIZES: Record<string, string>[] = [
      { width: "1", height: "1" }, { width: "0", height: "0px" }, { style: "width:1px;height:1px" },
      { style: "width:1px !important;height:1px !important" }, { width: "120", height: "120" },
      { width: "1" }, { style: "width:1px" }, { width: "1", height: "600" },
    ];
    for (const attrs of SIZES) {
      const tag = `<img src="https://images.example/p.png" ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}>`;
      const v = [
        sanitizeMailHtml(tag).blocked[0]?.pixel,
        declaresPixelAttrs((n) => attrs[n] ?? null),
        detectTrackers(tag)[0]?.isPixel ?? false,
      ];
      expect(new Set(v).size, `${tag}: ${JSON.stringify(v)}`).toBe(1);
    }
  });
});

describe("what a letter hides: the reader and the stored words agree", () => {
  it("hiddenByOwnStyle hides exactly what core's htmlWords skips", () => {
    const STYLES = [
      "display:none", "DISPLAY : NONE !important", "color:red; display:none;", "display:block",
      "display:none-x", "x-display:none", "mso-hide:all", "font-size:0", "visibility:hidden",
      "max-height:0;overflow:hidden", "",
    ];
    for (const s of STYLES) {
      expect(hiddenByOwnStyle(s), s).toBe(htmlWords(`<div style="${s}">gone</div><p>kept</p>`) === "kept");
    }
    expect(hiddenByOwnStyle(null)).toBe(false);
  });

  it("drawsNoWords and FILLER_TOKEN read filler as core does; an emoji sequence stays", () => {
    const RUNS = ["\u034f\u200c\u00a0\u00ad", "\u200b \u2060", " \n\t", "\u{1F469}\u200d\u{1F4BB}", "a\u200c", ""];
    for (const r of RUNS) expect(drawsNoWords(r), JSON.stringify(r)).toBe(htmlWords(`<p>${r}</p>`) === "");
    for (const r of RUNS) expect(drawsNoWords(r), JSON.stringify(r)).toBe(withoutFiller(r).trim() === "");
    for (const t of ["\u034f\u200c", "\u00ad", "\u200d", "\u{1F469}\u200d\u{1F4BB}", "a"]) {
      expect(FILLER_TOKEN.test(t), JSON.stringify(t)).toBe(htmlWords(`<p>${t} x</p>`) === "x");
    }
  });
});
