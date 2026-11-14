/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OWNER_BILLING_HTML, OWNER_BILLING_TEXT } from "./fixtures/owner-billing-email";

/**
 * AN HTML BODY IS DRAWN IN BOUNDED PASSES, LIKE THE PLAIN ONE. Up to the 512 KiB cut a letter was
 * walked whole and a designed mail framed whole: the cut's worth of bytes read a huge accessibility tree as
 * a letter, one enormous name as a one-paragraph letter, and a huge tree and a long stretch of
 * main thread as a table of one-word rows. The walk now stops at a page of text and the frame at
 * MAX_FRAME_ELEMENTS elements or MAX_FRAME_TEXT_CHARS characters of text.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function render(text: string, html: string): Promise<HTMLDivElement> {
  const { MessageBody } = await mod();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, { messageId: "m1", text, html })); });
  return host;
}

/** Distinct words, so no line reads as a quote or a signature. */
const words = (n: number, k: number): string =>
  Array.from({ length: k }, (_, i) => `w${(n * 31 + i).toString(36)}q`).join(" ");

/**
 * A 600 px table of styled rows with a link each: five elements a row. `styled` writes the inline
 * styles a template builder does (about 170 bytes an element), the shape of an ordinary newsletter.
 */
const BUILDER_STYLE = "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:150%;"
  + "mso-line-height-rule:exactly;text-align:left;color:#333333;word-break:break-word;";
function newsletter(rows: number, styled = false): { html: string; text: string } {
  const r: string[] = [], t: string[] = [];
  const pad = styled ? `${BUILDER_STYLE}padding:12px 24px 12px 24px;border-bottom:1px solid #eeeeee;` : "padding:12px 24px;font-family:Arial,sans-serif;color:#333333";
  for (let n = 0; n < rows; n++) {
    r.push(`<tr><td valign="top" style="${pad}">`
      + `<a href="https://example.com/item/${n}" style="color:#0a66c2">Item ${n} ${words(n, 4)}</a><br>${words(n + 7, 18)}</td>`
      + `<td width="120" style="padding:12px;color:#999999">Oct ${1 + (n % 28)}</td></tr>`);
    t.push(`Item ${n} ${words(n, 4)}\n${words(n + 7, 18)}`);
  }
  return {
    html: `<!doctype html><html><head><style>body{margin:0}</style></head><body>`
      + `<table width="600" align="center" cellpadding="0" cellspacing="0" style="width:600px">${r.join("")}</table></body></html>`,
    text: t.join("\n"),
  };
}

/** `count` paragraphs of `k` words each, and the same words as the text part. */
function letter(count: number, k: number): { html: string; text: string } {
  const p = Array.from({ length: count }, (_, n) => words(n, k));
  return { html: `<html><body>${p.map((x) => `<p>${x}</p>`).join("")}</body></html>`, text: p.join("\n\n") };
}

describe("a letter's walk stops at one page of text", () => {
  /** Mutation: `chars: Infinity` in `buildRichNodes` — the walk keeps all of it and both read rich. */
  it("a letter with more than a page of text renders its text part, a page at a time", async () => {
    const { sanitizeMailHtml, MAX_RICH_CHARS } = await mod();
    const many = letter(800, 40);
    expect(many.text.length).toBeGreaterThan(MAX_RICH_CHARS * 2);
    expect(sanitizeMailHtml(many.html).rich, "a letter past a page was walked whole").toBeNull();
    const el = await render(many.text, many.html);
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector(".msg-page-more")?.textContent).toMatch(/^Show more/);
    expect(el.querySelectorAll(".msg-page")).toHaveLength(1);

    const one = `<html><body><p>${words(1, 12_000)}</p></body></html>`;
    expect(sanitizeMailHtml(one).rich, "one paragraph past a page was walked whole").toBeNull();
  });

  /** The bound is exact: a page of text is walked, one character more is not. */
  it("exactly a page is walked; one character more is the text part", async () => {
    const { sanitizeMailHtml, MAX_RICH_CHARS } = await mod();
    const at = `<html><body><p>${"a".repeat(MAX_RICH_CHARS)}</p></body></html>`;
    const past = `<html><body><p>${"a".repeat(MAX_RICH_CHARS + 1)}</p></body></html>`;
    expect(sanitizeMailHtml(at).rich, "a page of text was refused").not.toBeNull();
    expect(sanitizeMailHtml(past).rich, "a page and a character was walked").toBeNull();
  });
});

describe("a frame draws at most MAX_FRAME_ELEMENTS elements and MAX_FRAME_TEXT_CHARS of text", () => {
  /** Mutation: `frameFits` answers `true` — the frame is built and no sentence is shown. */
  it("a designed mail past the element bound renders its text part with the oversize sentence", async () => {
    const { COPY, MAX_FRAME_ELEMENTS, sanitizeMailHtml } = await mod();
    const big = newsletter(Math.ceil(MAX_FRAME_ELEMENTS / 5) + 1);
    expect(sanitizeMailHtml(big.html).prose, "the fixture is not a designed mail").toBe(false);
    const el = await render(big.text, big.html);
    expect(el.querySelector("iframe"), "the frame drew past its element bound").toBeNull();
    expect(el.querySelector(".mb-note")?.textContent).toBe(COPY.oversize);
    expect(el.textContent).toContain("Item 0 ");
  });

  it("a designed mail past the text bound renders its text part too", async () => {
    const { MAX_FRAME_TEXT_CHARS } = await mod();
    const cell = words(3, 12_000);
    expect(cell.length).toBeGreaterThan(MAX_FRAME_TEXT_CHARS / 2);
    const html = `<table width="600" style="width:600px"><tr><td>${cell}</td></tr><tr><td>${cell}</td></tr></table>`;
    const el = await render(`${cell}\n${cell}`, html);
    expect(el.querySelector("iframe"), "the frame drew past its text bound").toBeNull();
    expect(el.querySelector(".mb-note")).not.toBeNull();
  });

  /** The positive control: a template-built newsletter of 200 KiB, the largest ordinary one, is framed as before. */
  it("an ordinary newsletter keeps its frame and says nothing", async () => {
    const nl = newsletter(400, true);
    expect(nl.html.length).toBeGreaterThan(200 * 1024);
    const el = await render(nl.text, nl.html);
    expect(el.querySelector("iframe.mb-frame"), "an ordinary newsletter lost its frame").not.toBeNull();
    expect(el.querySelector(".mb-note")).toBeNull();
  });

  /** The corpus mail renders the way its class says, frame or letter, with no sentence. */
  it("the corpus mail renders as its class says", async () => {
    const { sanitizeMailHtml } = await mod();
    const prose = sanitizeMailHtml(OWNER_BILLING_HTML).prose;
    const el = await render(OWNER_BILLING_TEXT, OWNER_BILLING_HTML);
    expect(el.querySelector("iframe") === null).toBe(prose);
    expect(el.querySelector(".mb-note")).toBeNull();
  });

  /**
   * A letter too big to frame keeps its own rendering and loses only the flip to its layout.
   * Mutation: drop `&& mail.frameFits` from `proseable` — the flip is offered over a frame that
   * may not be drawn.
   */
  it("a letter too big to frame offers no flip; a small one does", async () => {
    const { MAX_FRAME_ELEMENTS } = await mod();
    const big = letter(MAX_FRAME_ELEMENTS + 10, 1);
    const el = await render(big.text, big.html);
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector(".mb-note"), "a letter was told it is too large").toBeNull();
    expect(el.querySelector(".mb-flip"), "the flip was offered over a frame past its bound").toBeNull();
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    const small = letter(3, 5);
    const el2 = await render(small.text, small.html);
    expect(el2.querySelector(".mb-flip"), "a small letter lost its flip").not.toBeNull();
  });

  /** Mutation: `!prose` alone in the cut — a letter with no text part is framed past the bound. */
  it("a letter with no text part past the bound renders the sentence, not a frame", async () => {
    const { COPY, MAX_FRAME_ELEMENTS } = await mod();
    const big = letter(MAX_FRAME_ELEMENTS + 10, 1);
    const el = await render("", big.html);
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector(".mb-note")?.textContent).toBe(COPY.oversize);
  });
});

describe("past MAX_PARSE_ELEMENTS the html part is not parsed at all", () => {
  /**
   * A letter is the case only this bound decides: past the frame bound alone a letter keeps its
   * text part with no sentence. Mutation: drop the `treeWithin(... MAX_PARSE_ELEMENTS)` term in the
   * component — the letter is sanitized and walked, and the sentence is gone.
   */
  it("a letter past the bound renders its text part with the sentence", async () => {
    const { COPY, MAX_PARSE_ELEMENTS } = await mod();
    const { treeWithin } = await import("@ohmail/client-engine/html-tree-budget");
    const big = letter(MAX_PARSE_ELEMENTS + 1, 1);
    expect(treeWithin(big.html, { elements: MAX_PARSE_ELEMENTS }).fits, "the letter did not read past the parse bound").toBe(false);
    const el = await render(big.text, big.html);
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector(".mb-note")?.textContent, "a letter past the parse bound was sanitized").toBe(COPY.oversize);
  });
});

describe("a page of the text part ends at BODY_PAGE_LINES lines too", () => {
  /** Mutation: `lines` ignored in `pageEnd` — thousands of short lines are under a page of characters and drawn whole. */
  it("short lines page by count, and a letter's lines still page by characters", async () => {
    const { pageEnd, BODY_PAGE_LINES, BODY_PAGE_CHARS } = await import("@ohmail/ui");
    const short = Array.from({ length: 3_000 }, (_, n) => `w${n}`).join("\n");
    expect(short.length).toBeLessThan(BODY_PAGE_CHARS);
    const end = pageEnd(short, 0);
    expect(short.slice(0, end).split("\n").length - 1, "the page did not end at its line bound").toBe(BODY_PAGE_LINES);
    const exact = Array.from({ length: BODY_PAGE_LINES }, (_, n) => `w${n}`).join("\n");
    expect(pageEnd(exact, 0), "a text of exactly the line bound was paged").toBe(exact.length);
    const prose = Array.from({ length: 3_000 }, (_, n) => words(n, 10)).join("\n");
    expect(pageEnd(prose, 0)).toBeGreaterThan(BODY_PAGE_CHARS * 0.8);

    const { BodyText } = await import("../app/letter-body/BodyText.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(BodyText, { text: short })); });
    expect(host.querySelector(".msg-page-more")?.textContent).toMatch(/^Show more/);
    expect(host.textContent).not.toContain("w2999");
  });
});

/**
 * THE AMPLIFYING SHAPES, THROUGH THE COMPONENT. A string scan of the raw part or the sanitized
 * markup reads a tree the parser never builds; `treeWithin` counts the one it does. Every host —
 * the reading pane, the Screener's held preview, a News or Receipts card — mounts this same
 * component with the same `(text, html)`, and the oversize decision is this memo's, so a per-shape
 * assertion here is one about every host; the live per-surface pass is the release's.
 */
const open = (n: number): string => Array.from({ length: n }, (_, i) => `<b class="c${i}">`).join("");
const pp = (r: number): string => "<p>t</p>".repeat(r);
/** A designed mail whose boundary (`button`, …) the sanitizer drops, so the FRAME re-parse amplifies. */
const frameShape = (boundary: string): string =>
  `<table width="600" style="width:600px"><tr><td><p>${open(400)}<${boundary}>${pp(1500)}</${boundary}></p></td></tr></table>`;
/** `<li>` reached through a special element the sanitizer drops. */
const liShape = (special: string): string => `<ul><li>${open(400)}<${special}>${"<li>t</li>".repeat(1500)}</${special}></li></ul>`;
/** The FIRST parse amplifies on its own — the openings are closed, the paragraphs follow. */
const parseShape = `<table width="600"><tr><td><p>${open(400)}</p>${pp(1600)}</td></tr></table>`;

describe("a message whose tree amplifies past a bound renders its text part, not a freeze", () => {
  // A DESIGNED mail (a table) or a first-parse bomb past its bound shows the text part WITH the
  // oversize sentence: there is no readable letter to fall back to. button/object/applet/marquee
  // collapse to one tree once the sanitizer drops them, so one of each class is enough.
  it("a designed or first-parse amplifier shows the oversize sentence and no iframe", async () => {
    const { COPY } = await mod();
    for (const html of [frameShape("button"), frameShape("object"), frameShape("marquee"),
      `<noscript>${parseShape}</noscript>`, `<!doctype html>${frameShape("button")}`]) {
      const el = await render("the readable words of this message", html);
      expect(el.querySelector("iframe"), "an amplifying mail drew a frame").toBeNull();
      expect(el.querySelector(".mb-note")?.textContent).toBe(COPY.oversize);
      expect(el.textContent).toContain("the readable words");
      if (root) await act(async () => { root!.unmount(); });
      host?.remove();
      root = null; host = null;
    }
  }, 30_000);

  // A PROSE mail (a list) past the frame bound keeps its readable text part with NO sentence and no
  // frame: the amplification only ever bit the frame re-parse, which is never mounted, and the
  // bounded walk already drew the letter. Mutation: count the frame bound over `clean`, not `doc` —
  // these fit over `clean` and the frame is mounted, a window freeze.
  it("a prose amplifier keeps its text part and mounts no iframe", async () => {
    for (const html of [liShape("form"), liShape("fieldset"), liShape("menu")]) {
      const el = await render("the readable words of this message", html);
      expect(el.querySelector("iframe"), "a prose amplifier drew a frame").toBeNull();
      expect(el.textContent).toContain("the readable words");
      if (root) await act(async () => { root!.unmount(); });
      host?.remove();
      root = null; host = null;
    }
  }, 30_000);

  it("a first-parse amplifier is never handed to DOMParser; one under the bound is", async () => {
    const spy = DOMParser.prototype.parseFromString;
    const seen: string[] = [];
    DOMParser.prototype.parseFromString = function (this: DOMParser, src: string, type: DOMParserSupportedType) {
      seen.push(src);
      return spy.call(this, src, type);
    };
    try {
      // NEEDLE is in the part; past the parse bound the memo refuses before any parse.
      await render("readable words", `<div data-needle="PARSEBOMB">${parseShape}</div>`);
      expect(seen.some((s) => s.includes("PARSEBOMB")), "the parse bomb reached DOMParser").toBe(false);
      if (root) await act(async () => { root!.unmount(); });
      host?.remove(); root = null; host = null;
      // The positive control: a small part under the bound IS parsed.
      await render("readable words", `<div data-needle="UNDERBOUND"><p>hello</p></div>`);
      expect(seen.some((s) => s.includes("UNDERBOUND")), "an ordinary part was not parsed").toBe(true);
    } finally {
      DOMParser.prototype.parseFromString = spy;
    }
  });

  /**
   * A WORK abort routes like an element abort: few elements, but the parse itself would cost the
   * window seconds, so the part is refused at the first-parse site and only the text part and the
   * sentence render. Each shape is asserted to be a work abort, not an element one, before it is
   * mounted. Mutation: drop the throw in the work charge — the deep-stack part reaches DOMParser.
   */
  const workShapes: Array<[string, string]> = [
    ["one tag of 40,000 attributes", `<b data-needle="WORKATTR" ${Array.from({ length: 40_000 }, (_, i) => `a${i.toString(36)}`).join(" ")}>x</b>`],
    ["500 open spans under formatting, then 60,000 short tokens", `<i title="WORKDEEP"><b>${"<span>".repeat(500)}${"a ".repeat(60_000)}`],
  ];
  for (const [name, html] of workShapes) {
    it(`a work abort shows the text part with the sentence and is never parsed: ${name}`, async () => {
      const { COPY, MAX_PARSE_ELEMENTS } = await mod();
      const { treeWithin } = await import("@ohmail/client-engine/html-tree-budget");
      const needle = name.startsWith("one tag") ? "WORKATTR" : "WORKDEEP";
      const spy = DOMParser.prototype.parseFromString;
      const seen: string[] = [];
      DOMParser.prototype.parseFromString = function (this: DOMParser, src: string, type: DOMParserSupportedType) {
        seen.push(src);
        return spy.call(this, src, type);
      };
      try {
        const el = await render("the readable words of this message", html);
        expect(el.querySelector("iframe"), "a work bomb drew a frame").toBeNull();
        expect(el.querySelector(".mb-note")?.textContent).toBe(COPY.oversize);
        expect(el.textContent).toContain("the readable words");
        expect(el.innerHTML.includes(needle), "the work bomb's markup reached the page").toBe(false);
        expect(seen.some((s) => s.includes(needle)), "the work bomb reached DOMParser").toBe(false);
        // Asserted after the render, so a disabled work bound reddens the routing above first.
        expect(treeWithin(html, { elements: MAX_PARSE_ELEMENTS }), `${name} is not a work abort`).toEqual({ fits: false, past: "work" });
        if (root) await act(async () => { root!.unmount(); });
        host?.remove(); root = null; host = null;
        // The positive control: a small designed part is parsed and framed.
        const ok = await render("readable words", `<table width="600" style="width:600px"><tr><td class="WORKCONTROL">hello</td><td>there</td></tr></table>`);
        expect(seen.some((s) => s.includes("WORKCONTROL")), "an ordinary part was not parsed").toBe(true);
        expect(ok.querySelector("iframe.mb-frame"), "an ordinary designed part lost its frame").not.toBeNull();
      } finally {
        DOMParser.prototype.parseFromString = spy;
      }
    }, 30_000);
  }

  /**
   * The frame bound counts the tree the frame parses, not the sanitized string: a document whose
   * `clean` fits over `clean` is past once the shell is added. Mutation: count over `clean` — the edge
   * document then frames.
   */
  it("the frame bound counts the shell: a clean tree that fits is past as a document", async () => {
    const { sanitizeMailHtml, buildMailDocument, MAX_FRAME_ELEMENTS } = await mod();
    const { treeWithin } = await import("@ohmail/client-engine/html-tree-budget");
    // A clean tree of exactly MAX_FRAME_ELEMENTS (html/head/body + div + rows): fits over clean,
    // past once buildMailDocument adds the shell's meta/style elements.
    const rows = Array.from({ length: MAX_FRAME_ELEMENTS - 4 }, (_, n) => `<p>r${n}</p>`).join("");
    const { html: clean } = sanitizeMailHtml(`<div>${rows}</div>`);
    const overClean = treeWithin(clean, { elements: MAX_FRAME_ELEMENTS, textChars: 1 << 20 });
    expect(overClean.fits, "the clean tree did not fit as the edge needs").toBe(true);
    expect(overClean.fits && overClean.elements).toBe(MAX_FRAME_ELEMENTS);
    const doc = buildMailDocument(clean, {});
    expect(treeWithin(doc, { elements: MAX_FRAME_ELEMENTS, textChars: 1 << 20 }), "the document fit over the frame bound").toEqual({
      fits: false,
      past: "elements",
    });
  });

  /**
   * The component counts the frame bound over `doc`, not `clean`: a DESIGNED mail whose sanitized
   * tree is exactly MAX_FRAME_ELEMENTS fits over `clean` and is past once the shell is added, so it
   * shows the sentence rather than mounting a frame that lays out thousands of elements. Mutation: count
   * over `clean` in the memo — this fixture frames.
   */
  it("a designed mail at the clean bound shows the sentence, not a frame (counts doc)", async () => {
    const { COPY } = await mod();
    // 681 two-cell rows: the sanitized tree is MAX_FRAME_ELEMENTS, the built document is past it.
    const rows = Array.from({ length: 681 }, (_, n) => `<tr><td>a${n}</td><td>b${n}</td></tr>`).join("");
    const el = await render("the readable words of this message", `<table width="600" style="width:600px">${rows}</table>`);
    expect(el.querySelector("iframe"), "the designed edge document mounted a frame").toBeNull();
    expect(el.querySelector(".mb-note")?.textContent).toBe(COPY.oversize);
  });
});

describe("sender text in alt/title/aria is cut to MAX_ATTR_TEXT_CHARS (L2)", () => {
  it("a 300,000-character alt is cut on the frame path and the walk path", async () => {
    const { sanitizeMailHtml, buildMailDocument, MAX_ATTR_TEXT_CHARS } = await mod();
    const big = "a".repeat(300_000);
    const cid = "data:image/png;base64,iVBORw0KGgo=";
    // Every `kind: "image"` node anywhere in the walked tree.
    const images = (nodes: unknown): Array<{ alt: string }> => {
      const out: Array<{ alt: string }> = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) { for (const x of n) walk(x); return; }
        if (n && typeof n === "object") {
          const o = n as Record<string, unknown>;
          if (o.kind === "image" && typeof o.alt === "string") out.push({ alt: o.alt });
          for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
        }
      };
      walk(nodes);
      return out;
    };
    // The walk path: a prose letter with one resolved embedded picture whose alt is hundreds of thousands of characters.
    const walked = sanitizeMailHtml(`<p>hello world this is a letter</p><img src="cid:logo" alt="${big}">`, {
      cidImages: new Map([["logo", cid]]),
    });
    const walkedImages = images(walked.rich);
    expect(walkedImages.length, "the picture was not walked").toBeGreaterThan(0);
    for (const im of walkedImages) expect(im.alt.length).toBe(MAX_ATTR_TEXT_CHARS);
    // The frame path: the same alt in the document the frame parses.
    const framed = sanitizeMailHtml(`<table width="600"><tr><td><img src="cid:logo" alt="${big}"></td></tr></table>`, {
      cidImages: new Map([["logo", cid]]),
    });
    const doc = buildMailDocument(framed.html, {});
    const altInDoc = /alt="(a+)"/.exec(doc);
    expect(altInDoc, "the frame document carries no alt").not.toBeNull();
    expect(altInDoc![1].length).toBe(MAX_ATTR_TEXT_CHARS);
  });
});

describe("a body whose text part has not loaded", () => {
  /** Mutation: `text.trim()` without `?? ""` in `hasText` — the pane throws on a body with no text yet. */
  it("renders with a null text part, html or none", async () => {
    const el = await render(null as unknown as string, "<p>hello</p>");
    expect(el.querySelector("iframe.mb-frame"), "a letter with no text part keeps its frame").not.toBeNull();
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    const el2 = await render(null as unknown as string, null as unknown as string);
    expect(el2.querySelector("iframe")).toBeNull();
  });
});
