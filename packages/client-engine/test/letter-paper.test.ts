// @vitest-environment jsdom
/**
 * THE LETTER'S PAPER, AT THE WIDTH IT IS DRAWN (`src/letter-paper.ts`): the one gate the web, desktop and
 * phone readers run. The sender's conditions are decided for the frame (a block matches and is
 * unwrapped, or is dropped), so the sheet the frame draws holds none, and the page is read from that
 * sheet as the frame paints it. Untrusted mail: every pass is counted work, never time.
 */
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_VALUE_MAX, LETTER_BLOCK_DEPTH, LETTER_BREAKS_MAX, LETTER_PRELUDE_MAX, backgroundTokens, contrastRatio, cssHex, letterBand,
  letterMediaAt, letterPaperOf, mailIsLight, paintedPaper, parseCssColor, quotedDomTree, relativeLuminance,
  type LetterBreak, type Meter, type QuotedDomNode,
} from "../src/index";

const drawn = (css: string, width: number, meter?: Meter): string | null => letterMediaAt({ width }, meter).sheet(css);
/** Does `@media <prelude>` hold in a frame `width` wide? */
const holds = (prelude: string, width: number): boolean => (drawn(`@media ${prelude}{.hit{color:red}}`, width) ?? "").includes(".hit{color:red}");
/** Does `@supports <prelude>` hold? */
const supported = (prelude: string): boolean => (drawn(`@supports ${prelude}{.hit{color:red}}`, 572) ?? "").includes(".hit{color:red}");

/** A letter as both readers hand it over: its sheets resolved for the frame, its drawn tree, its body. */
function paperOf(html: string, width = 572, skip?: (doc: Document) => Element[], meter?: Meter) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const media = letterMediaAt({ width }, meter);
  const sheets: string[] = [];
  for (const s of [...doc.querySelectorAll("style")]) {
    const text = media.sheet(s.textContent ?? "", { media: s.getAttribute("media"), type: s.getAttribute("type") });
    if (text === null) s.remove();
    else sheets.push(text);
  }
  const b = doc.body;
  const paper = letterPaperOf({
    sheets,
    body: { bgcolor: b.getAttribute("bgcolor"), text: b.getAttribute("text"), style: b.getAttribute("style") },
    root: b as unknown as QuotedDomNode,
    tree: quotedDomTree,
    skip: skip ? new Set(skip(doc) as unknown as QuotedDomNode[]) : undefined,
  }, meter);
  const hex = (c: typeof paper.page) => (c === null ? null : cssHex(c));
  return { light: paper.light, page: hex(paper.page), paper: hex(paper.paper), ink: hex(paper.ink), ground: hex(paper.ground), breaks: media.breaks };
}

describe("a sender's condition is decided for the frame, never by it", () => {
  it("width, device-width, every prefix and range form, on both sides of each threshold", () => {
    const cases: Array<[string, number, boolean]> = [
      ["(min-width:480px)", 479, false], ["(min-width:480px)", 480, true],
      ["(max-width:600px)", 600, true], ["(max-width:600px)", 601, false],
      ["(width:600px)", 599, false], ["(width:600px)", 600, true], ["(width:600px)", 601, false],
      ["(width > 600px)", 600, false], ["(width > 600px)", 601, true],
      ["(width >= 600px)", 599, false], ["(width >= 600px)", 600, true],
      ["(width < 600px)", 599, true], ["(width < 600px)", 600, false],
      ["(width <= 600px)", 600, true], ["(width <= 600px)", 601, false],
      ["(600px < width)", 600, false], ["(600px < width)", 601, true],
      ["(400px <= width <= 700px)", 399, false], ["(400px <= width <= 700px)", 400, true], ["(400px <= width <= 700px)", 700, true], ["(400px <= width <= 700px)", 701, false],
      ["(700px > width >= 400px)", 699, true], ["(700px > width >= 400px)", 700, false],
      ["(max-device-width:480px)", 480, true], ["(max-device-width:480px)", 481, false],
      ["(device-width > 343px)", 343, false], ["(device-width > 343px)", 344, true],
    ];
    for (const [prelude, width, want] of cases) expect(holds(prelude, width), `${prelude} at ${width}`).toBe(want);
  });

  it("height is the fixed 600, aspect-ratio is width over it, portrait is a width of 600 or less", () => {
    for (const w of [343, 572, 730]) {
      expect(holds("(max-height:400px)", w)).toBe(false);
      expect(holds("(min-height:600px)", w)).toBe(true);
      expect(holds("(height:600px)", w)).toBe(true);
      expect(holds("(max-device-height:599px)", w)).toBe(false);
    }
    expect(holds("(min-aspect-ratio: 1/1)", 599)).toBe(false);
    expect(holds("(min-aspect-ratio: 1/1)", 600)).toBe(true);
    expect(holds("(aspect-ratio > 16/9)", 1066)).toBe(false);
    expect(holds("(aspect-ratio > 16/9)", 1067)).toBe(true);
    expect(holds("(max-aspect-ratio: 1)", 600)).toBe(true);
    expect(holds("(max-aspect-ratio: 1)", 601)).toBe(false);
    expect(holds("(orientation: portrait)", 600)).toBe(true);
    expect(holds("(orientation: portrait)", 601)).toBe(false);
    expect(holds("screen and (orientation:landscape)", 601)).toBe(true);
    expect(holds("screen and (orientation:landscape)", 572)).toBe(false);
  });

  it("every length unit names its pixels: em and rem are 16, and the physical units are CSS's", () => {
    for (const len of ["600px", "37.5em", "37.5rem", "6.25in", "15.875cm", "158.75mm", "635Q", "450pt", "37.5pc"]) {
      expect(holds(`(max-width: ${len})`, 600), len).toBe(true);
      expect(holds(`(max-width: ${len})`, 601), len).toBe(false);
    }
    expect(holds("(min-width: 0)", 1)).toBe(true);
  });

  it("types: all and screen match, print, speech and the rest never do", () => {
    const cases: Array<[string, boolean]> = [
      ["all", true], ["screen", true], ["only screen", true], ["print", false], ["speech", false], ["tv", false],
      ["not print", true], ["not screen", false], ["screen, print", true], ["print, speech", false], ["foo", false],
      ["only screen and (max-width:600px)", true], ["only all and (orientation: portrait)", true], ["only", false],
    ];
    for (const [prelude, want] of cases) expect(holds(prelude, 572), prelude).toBe(want);
    // An empty list is every screen.
    expect(drawn("@media {.hit{color:red}}", 572)).toContain(".hit{color:red}");
  });

  it("the colour scheme never depends on the device: light always matches, dark never", () => {
    const cases: Array<[string, boolean]> = [
      ["(prefers-color-scheme: light)", true], ["(prefers-color-scheme: dark)", false], ["( PREFERS-COLOR-SCHEME : LIGHT )", true],
      ["not (prefers-color-scheme: dark)", true], ["not all and (prefers-color-scheme: dark)", true],
      ["screen and (prefers-color-scheme: dark)", false], ["(prefers-color-scheme)", true], ["(prefers-color-scheme: purple)", false],
      ["(prefers-color-scheme: dark), print", false], ["(prefers-color-scheme: dark) or (max-width: 600px)", true],
    ];
    for (const [prelude, want] of cases) expect(holds(prelude, 572), prelude).toBe(want);
  });

  it("anything this reading does not know never matches, even under not", () => {
    for (const prelude of [
      "(hover: hover)", "not all and (hover: hover)", "not (hover: hover)", "(pointer: coarse)", "(min-resolution: 2dppx)",
      "(-webkit-min-device-pixel-ratio: 2)", "(prefers-reduced-motion: reduce)", "(max-width: 600vw)", "not all and (max-width: 600vw)",
      "(width: calc(600px))", "(max-width:600px", "(max-wid\\th: 600px)", "screen and (max-width:600px) or (min-width:1px)",
      "(min-width)", "(max-width: 600px) and", "and (max-width: 600px)", "(orientation: sideways)", "(foo)",
    ]) {
      for (const w of [343, 572, 730]) expect(holds(prelude, w), `${prelude} at ${w}`).toBe(false);
    }
    // `or` joins conditions; an unknown one under `or` still voids its query, not the list.
    expect(holds("(max-width: 400px) or (min-width: 700px)", 500)).toBe(false);
    expect(holds("(max-width: 400px) or (min-width: 700px)", 300)).toBe(true);
    expect(holds("(hover: hover), (max-width: 600px)", 572)).toBe(true);
  });

  it("a sheet's media and type attributes decide whether it is drawn at all", () => {
    const at = (width: number, attrs: { media?: string | null; type?: string | null }) => letterMediaAt({ width }).sheet("a{b:c}", attrs);
    expect(at(572, { media: "print" })).toBeNull();
    expect(at(572, { media: "(prefers-color-scheme: dark)" })).toBeNull();
    expect(at(572, { media: "screen and (max-width:600px)" })).toBe("a{b:c}");
    expect(at(730, { media: "screen and (max-width:600px)" })).toBeNull();
    expect(at(572, { media: "" })).toBe("a{b:c}");
    expect(at(572, { media: null, type: "TEXT/CSS " })).toBe("a{b:c}");
    expect(at(572, { type: "text/plain" })).toBeNull();
    expect(at(572, { type: "" })).toBe("a{b:c}");
  });

  it("@supports holds for declaration, selector and font tests, combined by not, and, or; anything else is false", () => {
    const cases: Array<[string, boolean]> = [
      ["(display:grid)", true], ["not (display:grid)", false], ["selector(:has(a))", true], ["font-tech(color-COLRv1)", true],
      ["font-format(woff2)", true], ["(display:grid) and (a)", false], ["(a) or (b:c)", true], ["foo(x)", false], ["(\\61:b)", false],
      ["((display:grid) and (gap:1px)) or (x:y)", true], ["(a:b) and (c:d) or (e:f)", false], ["", false],
      // A vendor-prefixed test targets one engine: false, so a letter keeps its fallback.
      ["(-webkit-overflow-scrolling:touch)", false], ["(-moz-appearance:none)", false], ["(-ms-grid-columns:1fr)", false],
      ["not (-webkit-overflow-scrolling:touch)", true], ["(-o-x:y) or (display:grid)", true], ["(--brand:red)", true],
    ];
    for (const [prelude, want] of cases) expect(supported(prelude), prelude).toBe(want);
    const kinetic = ".interactive{display:none}@supports (-webkit-overflow-scrolling:touch){.interactive{display:block!important}.fallback{display:none!important}}";
    expect(drawn(kinetic, 572)).toBe(".interactive{display:none} ");
  });

  it("@container, unknown and escaped at-rules go with their blocks; @layer and the kept at-rules stay, resolved inside; nesting is resolved", () => {
    expect(drawn("@container (min-width:0){a{b:c}} d{e:f}", 572)).toBe("  d{e:f}");
    expect(drawn("@foo{body{x:y}} d{e:f}", 572)).toBe("  d{e:f}");
    expect(drawn("@me\\64ia screen{a{b:c}} d{e:f}", 572)).toBe("  d{e:f}");
    expect(drawn("@layer base{ @media print{a{b:c}} d{e:f} }", 572)).toBe("@layer base{  d{e:f} }");
    expect(drawn("@font-face{font-family:x} @keyframes k{from{o:0}to{o:1}} @layer a, b; @import url(x.css);", 572))
      .toBe("@font-face{font-family:x} @keyframes k{from{o:0}to{o:1}} @layer a, b; @import url(x.css);");
    const nested = ".a{ color:red; @media (max-width:600px){ color:blue } }";
    expect(drawn(nested, 572)).toBe(".a{ color:red;  color:blue   }");
    expect(drawn(nested, 730)).toBe(".a{ color:red;  }");
  });

  it("no condition is left at any depth, and every removal leaves one space", () => {
    const blocks = ["@media screen{", "@media print{", "@supports (a:b){", "@supports (a){", "@container (min-width:0){", "@layer x{", ".r{", "@media (max-width:600px){"];
    let css = "";
    for (let i = 0; i < 200; i++) css += `${blocks[i % blocks.length]}.k${i}{c:d}`;
    css += "}".repeat(200);
    for (const w of [343, 572, 730]) expect(drawn(css, w), String(w)).not.toMatch(/@(?:media|supports|container)/i);
    expect(drawn("a{b:c}@media print{x{y:z}}d{e:f}", 572)).toBe("a{b:c} d{e:f}");
    expect(drawn("a{b:c}/* @media print{ */d{e:f}", 572)).toBe("a{b:c} d{e:f}");
    // No two sender tokens join across a removal: a `<` never meets `/style`.
    expect(drawn("x</**//style>{a:b}", 572)).toBe("x< /style>{a:b}");
    expect(drawn("a{b:c<}@media print{x{y:z}}/style>{c:d}", 572)).toBe("a{b:c<} /style>{c:d}");
    // A quoted brace is text; a stray `}` would void the next rule and goes.
    expect(drawn('.q::after{content:"@media print{"} body{x:y}', 572)).toBe('.q::after{content:"@media print{"} body{x:y}');
    expect(drawn("} body{background:#000}", 572)).toBe("  body{background:#000}");
  });

  it("a block nested past the depth is dropped, in the frame and in the reading", () => {
    const deep = (n: number) => `${"@layer a{".repeat(n - 1)}body{background:#000}${"}".repeat(n - 1)}`;
    expect(drawn(deep(LETTER_BLOCK_DEPTH), 572)).toContain("background:#000");
    expect(drawn(deep(LETTER_BLOCK_DEPTH + 1), 572)).not.toContain("background");
    expect(paperOf(`<style>${deep(LETTER_BLOCK_DEPTH)}</style><p>x</p>`).light).toBe(false);
    expect(paperOf(`<style>${deep(LETTER_BLOCK_DEPTH + 1)}</style><p>x</p>`).light).toBe(true);
  });

  it("a layer name counts each of its parts as a level: a deeper or longer one is dropped, in the frame and in the reading", () => {
    const named = (parts: number) => Array.from({ length: parts }, () => "a").join(".");
    const block = (parts: number) => `@layer ${named(parts)}{body{background:#000}} p{c:d}`;
    expect(drawn(block(LETTER_BLOCK_DEPTH), 572)).toContain("background:#000");
    expect(drawn(block(LETTER_BLOCK_DEPTH + 1), 572)).toBe("  p{c:d}");
    expect(drawn(`@layer ${named(LETTER_BLOCK_DEPTH + 1)}; p{c:d}`, 572)).toBe("  p{c:d}");
    expect(drawn(`@layer a, ${named(LETTER_BLOCK_DEPTH + 1)}; p{c:d}`, 572)).toBe("  p{c:d}");
    expect(drawn(`@layer ${"a".repeat(LETTER_PRELUDE_MAX + 1)}{body{background:#000}}`, 572)).not.toContain("background");
    // Nested blocks add their parts: eight of four parts are 32 levels, a ninth is past them.
    const nested = (n: number) => `${"@layer a.b.c.d{".repeat(n)}body{background:#000}${"}".repeat(n)}`;
    expect(drawn(nested(8), 572)).toContain("background:#000");
    expect(drawn(nested(9), 572)).not.toContain("background");
    expect(drawn(`${"@layer a.b.c.d{".repeat(8)}@layer e; p{c:d}${"}".repeat(8)}`, 572)).not.toContain("@layer e");
    // A block names one layer: one naming more is dropped, as the engines drop it.
    expect(drawn("@layer a, b{body{background:#000}} p{c:d}", 572)).toBe("  p{c:d}");
    expect(drawn("@layer a,{body{background:#000}} p{c:d}", 572)).toBe("  p{c:d}");
    // The reading holds the same bound on a sheet nobody resolved.
    const read = (css: string) => letterPaperOf({ sheets: [css], body: null, root: new DOMParser().parseFromString("<p>x</p>", "text/html").body as unknown as QuotedDomNode, tree: quotedDomTree });
    expect(read(block(LETTER_BLOCK_DEPTH)).light).toBe(false);
    expect(read(block(LETTER_BLOCK_DEPTH + 1)).light).toBe(true);
    expect(read(nested(9)).light).toBe(true);
    expect(read("@layer a, b{body{background:#000}}").light).toBe(true);
    expect(read("body{background:#fff} @layer x, y{body{background:#000 !important}}").page).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe("the widths a letter's conditions break at", () => {
  it("are recorded sorted and deduplicated; a letter without a size condition has none", () => {
    const media = letterMediaAt({ width: 572 });
    media.sheet("@media (max-width:600px){a{b:c}} @media (min-width:480px){a{b:c}} @media (max-width:600px){a{b:c}} @media (orientation:portrait){a{b:c}}");
    expect(media.breaks).toEqual([{ px: 480, strict: false }, { px: 600, strict: true }]);
    const none = letterMediaAt({ width: 572 });
    none.sheet("@media screen{a{b:c}} @media (prefers-color-scheme: dark){a{b:c}} @media print{a{b:c}} @supports (a:b){a{b:c}}");
    expect(none.breaks).toEqual([]);
  });

  it(`stop at ${LETTER_BREAKS_MAX}: the next distinct one is a comparison that is false`, () => {
    const css = Array.from({ length: LETTER_BREAKS_MAX + 1 }, (_, i) => `@media (min-width:${i + 1}px){.k${i + 1}{c:d}}`).join("");
    const media = letterMediaAt({ width: 1000 });
    const out = media.sheet(css)!;
    expect(media.breaks).toHaveLength(LETTER_BREAKS_MAX);
    expect(out).toContain(`.k${LETTER_BREAKS_MAX}{c:d}`);
    expect(out).not.toContain(`.k${LETTER_BREAKS_MAX + 1}{c:d}`);
  });

  it("a band is monotone, and two widths in one band resolve every condition alike", () => {
    const css = "@media (max-width:600px){.a{b:c}} @media (min-width:480px) and (max-width:700px){.d{e:f}} @media (orientation:landscape){.g{h:i}} @media (width > 343px){.j{k:l}}";
    const media = letterMediaAt({ width: 572 });
    media.sheet(css);
    const breaks: readonly LetterBreak[] = media.breaks;
    let last = -1;
    const byBand = new Map<number, string>();
    for (let w = 200; w <= 900; w++) {
      const band = letterBand(w, breaks);
      expect(band).toBeGreaterThanOrEqual(last);
      last = band;
      const out = drawn(css, w)!;
      if (byBand.has(band)) expect(out, `${w}`).toBe(byBand.get(band));
      else byBand.set(band, out);
    }
    expect(byBand.size).toBe(breaks.length + 1);
  });
});

describe("the page, read as the frame paints it", () => {
  it("the cascade picks the winner: the last match, then !important, layers and specificity", () => {
    expect(paperOf("<style>body{background:#fff} body{background:#000}</style><p>x</p>").page).toBe("#000000");
    expect(paperOf("<style>body{background:#000 !important} body{background:#fff}</style><p>x</p>").page).toBe("#000000");
    expect(paperOf("<style>@layer a{body{background:#000}} body{background:#fff}</style><p>x</p>").page).toBe("#ffffff");
    expect(paperOf("<style>@layer a{body{background:#000!important}} body{background:#fff!important}</style><p>x</p>").page).toBe("#000000");
    expect(paperOf("<style>@layer a, b; @layer b{body{background:#000}} @layer a{body{background:#fff}}</style><p>x</p>").page).toBe("#000000");
    // Across levels and branches: a layer's own rules over its sublayers', reversed for !important.
    expect(paperOf("<style>@layer a{body{background:#222}} @layer a.x{body{background:#111}}</style><p>x</p>").page).toBe("#222222");
    expect(paperOf("<style>@layer a{body{background:#222!important}} @layer a.x{body{background:#111!important}}</style><p>x</p>").page).toBe("#111111");
    expect(paperOf("<style>@layer a, b; @layer b.y{body{background:#111}} @layer a.x.z{body{background:#222}}</style><p>x</p>").page).toBe("#111111");
    expect(paperOf("<style>@layer a{@layer y{body{background:#111}}} @layer a{@layer x{body{background:#222}}} @layer a.y{}</style><p>x</p>").page).toBe("#222222");
    expect(paperOf("<style>body{background:#333} @layer a.b.c{body{background:#111}}</style><p>x</p>").page).toBe("#333333");
    expect(paperOf("<style>html body{background:#000} body{background:#fff}</style><p>x</p>").page).toBe("#000000");
    expect(paperOf("<style>:root{background:#101010}</style><p>x</p>").page).toBe("#101010");
    expect(paperOf("<style>* {background:#101010}</style><p>x</p>").page).toBe("#101010");
    // CSS whitespace only: a no-break space is part of a name, so `html body` there names no element.
    expect(paperOf("<style>html body{background:#000}</style><p>x</p>").page).toBeNull();
    expect(paperOf("<style> HTML \t>\n Body {background:#000}</style><p>x</p>").page).toBe("#000000");
    expect(paperOf("<style>a, :root   body ,b{background:#000}</style><p>x</p>").page).toBe("#000000");
    // A sheet rule over the dropped inline style: the page as painted.
    expect(paperOf('<style>body{background:#ffffff}</style><body style="background:#000;color:#fff"><p>x</p></body>')).toMatchObject({ light: true, ink: null });
  });

  it("a brace in a comment or a string is text", () => {
    expect(paperOf("<style>@media print{ /* { */ body{background:#fff} } body{background:#000}</style><p>x</p>").page).toBe("#000000");
    expect(paperOf('<style>.a::after{content:"}"} body{background:#0b0b0b}</style><p>x</p>').page).toBe("#0b0b0b");
    expect(paperOf('<style>@media print{.a::after{content:"}"} body{background:#0b0b0b}}</style><p>x</p>').light).toBe(true);
  });

  it("a shorthand with no colour is transparent; background-image alone sets nothing", () => {
    expect(paperOf('<style>body{background:url(x.png) no-repeat}</style><body bgcolor="#000"><p>x</p></body>')).toMatchObject({ page: null, light: true });
    expect(paperOf('<style>body{background-image:url(x.png)}</style><body bgcolor="#000"><p>x</p></body>').page).toBe("#000000");
    expect(paperOf('<style>body{background: url(logo@2x.png) #101010}</style><p>x</p>').page).toBe("#101010");
    expect(paperOf('<style>body{background:rgba(0,0,0,.2)}</style><body bgcolor="#000"><p>x</p></body>').page).toBeNull();
    // A value this reading cannot compute sets nothing.
    expect(paperOf('<style>body{background:var(--x)}</style><body bgcolor="#000"><p>x</p></body>').page).toBe("#000000");
  });

  it("a page set only at some widths is the page only at those widths", () => {
    const DM7 = "<style>@media only screen and (max-width:600px){body{background-color:#000 !important}}</style><p>Wide words</p>";
    expect(paperOf(DM7, 572)).toMatchObject({ light: false, page: "#000000", ink: "#e4e4e4" });
    expect(paperOf(DM7, 730)).toMatchObject({ light: true, page: null, ink: null });
    const LIGHT_UNDER = '<style>@media (max-width:600px){body{background:#fff!important}}</style><body style="background:#000;color:#fff"><p>Words</p></body>';
    expect(paperOf(LIGHT_UNDER, 572)).toMatchObject({ light: true, paper: null, ink: null });
    expect(paperOf(LIGHT_UNDER, 730)).toMatchObject({ light: false, paper: "#000000", ink: "#ffffff" });
  });
});

describe("a wrapper is the page only when it holds the letter", () => {
  it("a dark header bar over unpainted text keeps the light sheet, uninverted", () => {
    const BAR = '<table width="100%"><tr><td bgcolor="#111111" style="color:#fff">Brand</td></tr><tr><td style="color:#333">Your order has shipped.</td></tr></table>';
    expect(paperOf(BAR)).toEqual({ light: false, ground: "#111111", page: null, paper: null, ink: null, breaks: [] });
  });

  it("a wrapper holding every word is the page, a preheader hidden in front of it included", () => {
    expect(paperOf('<div style="background-color:#1a1a2e"><p>Dark by design</p></div>')).toMatchObject({ light: false, paper: "#1a1a2e" });
    expect(paperOf('<div style="display:none">Preheader words</div><table bgcolor="#111111"><tr><td style="color:#eee">News</td></tr></table>'))
      .toMatchObject({ light: false, paper: "#111111" });
  });

  it("a wrapper the body's own ink reads on is the page", () => {
    expect(paperOf('<body style="color:#fff"><p>Intro outside</p><table bgcolor="#000"><tr><td>x</td></tr></table></body>'))
      .toMatchObject({ light: false, paper: "#000000", ink: "#ffffff" });
  });

  it("the history is not read", () => {
    const REPLY = '<p>Reply</p><blockquote><table bgcolor="#000"><tr><td>Old</td></tr></table></blockquote>';
    expect(paperOf(REPLY, 572, (d) => [d.querySelector("blockquote")!])).toMatchObject({ light: true, ground: null });
    expect(paperOf(REPLY)).toMatchObject({ light: false, paper: null });
  });
});

describe("the body's own ink", () => {
  it("is taken only on a dark page it reads on", () => {
    expect(paperOf('<body bgcolor="#000" text="#fff"><p>x</p></body>').ink).toBe("#ffffff");
    expect(paperOf('<body style="background-color: rgb(18, 18, 18); color: rgb(245, 245, 245)"><p>x</p></body>')).toMatchObject({ paper: "#121212", ink: "#f5f5f5" });
    expect(paperOf('<body bgcolor="#767676" text="#ffffff"><p>x</p></body>').ink).toBeNull();
    expect(paperOf('<body text="#ffffff"><p>x</p></body>').ink).toBeNull();
    expect(paperOf('<body bgcolor="#000" text="#333"><p>x</p></body>').ink).toBeNull();
  });
});

describe("ohmail's own light ink, on a dark page that names none", () => {
  const DM7 = "<style>@media only screen and (max-width:600px){body{background-color:#000 !important}}</style><p>Wide words</p>";
  const DARK = "<style>body{background:#000}</style>";

  it("is set where the page at the frame's width is dark, the letter names no ink and no element declares a background", () => {
    expect(paperOf(DM7, 343)).toMatchObject({ light: false, page: "#000000", paper: "#000000", ink: "#e4e4e4" });
    expect(paperOf(DM7, 572)).toMatchObject({ light: false, page: "#000000", paper: "#000000", ink: "#e4e4e4" });
    expect(paperOf(DM7, 730)).toMatchObject({ light: true, page: null, ink: null });
    // html and body are the page, never an element's background, however they are named.
    expect(paperOf('<body bgcolor="#111111" style="background-color:#111111"><p>x</p></body>').ink).toBe("#e4e4e4");
    expect(paperOf("<style>html{background:#000} :root body, html>body{background:#000} *{background-color:#000}</style><p>x</p>").ink).toBe("#e4e4e4");
    // Only a background declaration counts: not a value naming one, a custom property, or a layout attribute.
    const plain = `${DARK}<style>p{margin:0;transition:background-color .2s} .a{--background:#fff}</style>`
      + '<table width="600" border="0" cellpadding="0"><tr><td align="center"><p class="a" style="color:inherit">x</p></td></tr></table>';
    expect(paperOf(plain).ink).toBe("#e4e4e4");
  });

  it("is white where the frame's light ink reads under 4.5:1 on the page", () => {
    expect(paperOf('<body bgcolor="#757575"><p>x</p></body>')).toMatchObject({ light: false, paper: "#757575", ink: "#ffffff" });
  });

  it("is never set when an element other than html and body declares a background, in any spelling or value", () => {
    const cards = [
      '<table bgcolor="#ffffff"><tr><td>x</td></tr></table>',
      '<table><tr><td bgcolor="">x</td></tr></table>',
      '<div bgcolor="transparent">x</div>',
      '<div style="background:#fff">x</div>',
      '<div style="color:#000; background-color: transparent">x</div>',
      '<div style="BACKGROUND-COLOR : none !important">x</div>',
      '<div style="/* a */ background /* b */: rgb(255 255 255)">x</div>',
      '<div style="background-image:url(card.png)">x</div>',
      '<div style="back\\67 round:#fff">x</div>',
      '<div style="display:none;background:#fff">Preheader</div><p>x</p>',
      "<style>.card{background:#fff}</style><div class=\"card\">x</div>",
      "<style>td{background-color:transparent}</style><table><tr><td>x</td></tr></table>",
      "<style>body table{background:none}</style><table><tr><td>x</td></tr></table>",
      "<style>body, td{background:#000}</style><table><tr><td>x</td></tr></table>",
      "<style>@layer card{.card{background:#fff !important}}</style><div class=\"card\">x</div>",
      "<style>body{ .card{background:#fff} }</style><div class=\"card\">x</div>",
      "<style>@keyframes k{from{background:#fff}}</style><div>x</div>",
    ];
    for (const card of cards) {
      for (const width of [343, 572]) expect(paperOf(`${DM7}${card}`, width), `${card} at ${width}`).toMatchObject({ light: false, page: "#000000", ink: null });
    }
  });

  it("is never set over an ink the letter names: its own where it reads, the frame's where it does not", () => {
    expect(paperOf('<body bgcolor="#000" text="#fff"><p>x</p></body>').ink).toBe("#ffffff");
    expect(paperOf('<body bgcolor="#000" text="#333"><p>x</p></body>').ink).toBeNull();
    expect(paperOf('<body style="background:#000;color:#333"><p>x</p></body>').ink).toBeNull();
  });

  it("reads the history only where it is drawn", () => {
    const REPLY = `${DM7}<p>Reply</p><blockquote><table bgcolor="#ffffff"><tr><td>Old</td></tr></table></blockquote>`;
    expect(paperOf(REPLY, 572, (d) => [d.querySelector("blockquote")!]).ink).toBe("#e4e4e4");
    expect(paperOf(REPLY, 572).ink).toBeNull();
  });

  it("is one counted pass over the tree, and a reading that throws reaches the reader, never answered with a guess", () => {
    const html = `${DARK}${`<p style="${"color:#eee;".repeat(200)}">x</p>`.repeat(200)}`;
    const meter = { visited: 0 };
    expect(paperOf(html, 572, undefined, meter).ink).toBe("#e4e4e4");
    expect(meter.visited).toBeLessThanOrEqual(6 * html.length);
    const root = new DOMParser().parseFromString("<p>x</p>", "text/html").body as unknown as QuotedDomNode;
    const tree = { ...quotedDomTree, attr: (): string | null => { throw new RangeError("Maximum call stack size exceeded"); } };
    expect(() => letterPaperOf({ sheets: ["body{background:#000}"], body: null, root, tree })).toThrow(RangeError);
  });
});

describe("colours", () => {
  it("parse, weigh and compare as WCAG does; a near-neutral light paper is the frame's white", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("rgb(13 17 23 / 50%)")?.a).toBeCloseTo(0.5, 5);
    expect(parseCssColor("transparent")).toBeNull();
    expect(relativeLuminance(parseCssColor("#008000")!)).toBeLessThan(0.179);
    expect(mailIsLight(null)).toBe(true);
    expect(mailIsLight(parseCssColor("#808080"))).toBe(true);
    expect(mailIsLight(parseCssColor("darkslategray"))).toBe(false);
    expect(contrastRatio(parseCssColor("#000")!, parseCssColor("#1b1b1b")!)).toBeCloseTo(1.22, 2);
    expect(paintedPaper(parseCssColor("#efefef"))).toBeNull();
    expect(paintedPaper(parseCssColor("#cfe0ff"))).toEqual({ r: 207, g: 224, b: 255, a: 1 });
    expect(paintedPaper(parseCssColor("#111111"))).toEqual({ r: 17, g: 17, b: 17, a: 1 });
    expect(backgroundTokens("url(a b.png)  rgb(18, 18, 18) no-repeat")).toEqual(["url(a b.png)", "rgb(18, 18, 18)", "no-repeat"]);
  });
});

describe("every pass is linear, bounded and never throws on hostile mail", () => {
  /** Counted work of resolving and reading `css` as a letter's one sheet. */
  const work = (css: string): number => {
    const meter = { visited: 0 };
    paperOf(`<style>${css}</style><p>x</p>`, 572, undefined, meter);
    return meter.visited;
  };
  it("deep nesting, open and closed, costs at most six visits a character", () => {
    for (const k of [1_000, 12_000, 30_000]) {
      for (const open of ["@layer a{", "@supports (a:b){", "@media (min-width:1px){", "@media (prefers-color-scheme: light){"]) {
        for (const css of [`${open.repeat(k)}body{background:#0b0b0b}${"}".repeat(k)}`, `${open.repeat(k)}body{background:#0b0b0b}`]) {
          const visited = work(css);
          expect(visited, `${open} x${k}`).toBeGreaterThanOrEqual(css.length);
          expect(visited, `${open} x${k}`).toBeLessThanOrEqual(6 * css.length);
        }
      }
    }
  });

  it("long lists, long preludes, many thresholds and unterminated text stay bounded", () => {
    const shapes = [
      `@media ${"(min-width:1px),".repeat(10_000)}(min-width:1px){body{background:#000}}`,
      `${"body,".repeat(10_000)}body{background:#000}`,
      Array.from({ length: 10_000 }, (_, i) => `@media (min-width:${i}px){.a{b:c}}`).join(""),
      'body{background:#000;content:"abc', "/* x body{background:#000}", "@media screen{body{", "@media screen", "url(x",
      `${"(".repeat(5_000)}`, `@supports ${"not (".repeat(400)}a:b${")".repeat(400)}{body{background:#000}}`,
    ];
    for (const css of shapes) {
      const visited = work(css);
      expect(visited, css.slice(0, 40)).toBeLessThanOrEqual(6 * Math.max(css.length, 10));
    }
    const at = (n: number) => `@media screen and${" ".repeat(n - 25)}(min-width:1px){.hit{color:red}}`;
    expect(drawn(at(LETTER_PRELUDE_MAX), 572)).toContain(".hit");
    expect(drawn(at(LETTER_PRELUDE_MAX + 1), 572)).not.toContain(".hit");
    // Long layer names, many declarations deep in a layer, a long whitespace run in a selector, a comma run.
    const dotted = Array.from({ length: 30_000 }, () => "a").join(".");
    const deepLayer = Array.from({ length: LETTER_BLOCK_DEPTH }, (_, i) => `l${i}`).join(".");
    const deep31 = Array.from({ length: LETTER_BLOCK_DEPTH - 1 }, (_, i) => `l${i}`).join(".");
    const named = [
      `@layer ${dotted}{body{background:#000}}`, `@layer ${dotted};`, `${`@layer ${dotted.slice(0, 900)};`.repeat(50)}`,
      `@layer ${deepLayer}{body{${"background:#000;".repeat(10_000)}}}`,
      `${`@layer ${deepLayer}{body{background:#000}}`.repeat(2_000)}`,
      `a${" ".repeat(100_000)}b{color:red}`, `html${" ".repeat(100_000)}body{background:#000}`,
      `body{background:${",".repeat(BACKGROUND_VALUE_MAX - 1)}x}`.repeat(20),
      // A block prelude of comma runs, which the engines drop, would be a chain of ~930 layers that every losing declaration walks.
      `@layer b{body{background:#111}} @layer a${`,${".".repeat(31)}`.repeat(30)}{body{background:#000}} @layer b{body{${"background:#222;".repeat(5_000)}}}`,
      // Declarations losing to a page 32 levels deep in another branch: the walk to the branch is bounded.
      `@layer b; @layer a.${deep31}{body{background:#000}} @layer b.${deep31}{body{${"background:#222;".repeat(5_000)}}}`,
    ];
    for (const css of named) {
      const visited = work(css);
      expect(visited, css.slice(0, 40)).toBeLessThanOrEqual(6 * css.length);
      const meter = { visited: 0 };
      letterPaperOf({ sheets: [css], body: null, root: new DOMParser().parseFromString("<p>x</p>", "text/html").body as unknown as QuotedDomNode, tree: quotedDomTree }, meter);
      expect(meter.visited, `unresolved ${css.slice(0, 40)}`).toBeLessThanOrEqual(6 * css.length);
    }
    // A background value is read off its first 4 KB, each character once.
    const meter = { visited: 0 };
    backgroundTokens("a ".repeat(200_000), meter);
    expect(meter.visited).toBeLessThanOrEqual(BACKGROUND_VALUE_MAX);
  });

  it("a selector is read by a counted loop, every character: a pattern over it would count nothing", () => {
    const root = new DOMParser().parseFromString("<p>x</p>", "text/html").body as unknown as QuotedDomNode;
    for (const selector of [`a${" ".repeat(160_000)}b`, `html${"\t".repeat(160_000)}>body`]) {
      const meter = { visited: 0 };
      letterPaperOf({ sheets: [`${selector}{background:#000}`], body: null, root, tree: quotedDomTree }, meter);
      // The sheet's scan and the selector's reading each visit every character.
      expect(meter.visited, selector.slice(0, 8)).toBeGreaterThanOrEqual(2 * selector.length);
      expect(meter.visited, selector.slice(0, 8)).toBeLessThanOrEqual(6 * selector.length);
    }
  });
});
