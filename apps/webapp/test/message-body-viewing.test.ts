/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@ohmail/ui";
import { GRAY_WRAPPER_HTML, GRAY_WRAPPER_TEXT, TINTED_WRAPPER_HTML } from "./fixtures/gray-wrapper-letter";

/**
 * ── HOW A MESSAGE IS *VIEWED*: DARK ADAPTATION AND FITTING THE COLUMN ───────────────────
 *
 * `message-body.test.ts` is about what a message may DO — the sanitizer, the sandbox, the CSP.
 * This file is about what the reader SEES once all of that has been decided, and it exists
 * because both mechanisms here are transforms applied to the same surface and neither can be
 * proven by looking at the markup alone.
 *
 * ── WHAT JSDOM CAN AND CANNOT SETTLE, PER SECTION ───────────────────────────────────────
 *
 * jsdom performs NO LAYOUT and applies NO STYLESHEET. `offsetHeight`, `scrollWidth` and
 * `clientWidth` are all 0, and a `filter` or a `transform` in the injected sheet is a string
 * nobody computes. So:
 *
 *   DECIDED HERE   which mail is classified light or dark, and from what; that the component
 *                  refuses to stamp the dark attribute on a mail it judged dark; that the
 *                  counter-inversion for pictures is in the sheet and that a background-image
 *                  element is marked for it; that the fit arithmetic and its floor are right;
 *                  that no colour in the sender's document is ever rewritten.
 *
 *   LIVE ONLY      that the invert filter looks right on real mail, that photographs come back
 *                  to their true colours, that a wide newsletter actually stops scrolling
 *                  sideways, and that the scaled frame reserves the right height. Every one of
 *                  those is a question about a rendering engine and is answered by driving one.
 *                  The measurement path is deliberately INERT in jsdom (see the last section),
 *                  which is itself asserted so that a green run here is never mistaken for
 *                  evidence about the fit.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}
afterEach(async () => { await unmount(); });

type Mod = typeof import("../app/components/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/components/MessageBody.js");

/** Mount the component inside a theme, which is the only way the dark path engages at all. */
async function renderIn(
  preference: "light" | "dark",
  props: Parameters<Mod["MessageBody"]>[0],
): Promise<HTMLDivElement> {
  await unmount();
  const { MessageBody } = await mod();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(ThemeProvider, {
        defaultPreference: preference,
        storageKey: null,
        children: h(MessageBody, props),
      }),
    );
  });
  return host;
}

const srcdoc = (): string => host!.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
/**
 * THE ROOT TAG ALONE — `<html …>` and nothing after it.
 *
 * Asserting on the whole document for `data-ohmail-dark` is a trap twice over: the string also
 * appears in the dormant `:root[data-ohmail-dark]` selectors that ship in EVERY document, and
 * the root element carries a second attribute (the paper) whose presence depends on the
 * fixture — so `toContain('<html data-ohmail-dark="1">')` breaks on a message that happens to
 * declare a background. Both of those cost a red run that said nothing about the product.
 */
const rootTag = (): string => /<html[^>]*>/.exec(srcdoc())?.[0] ?? "";
const buttons = (): string[] =>
  [...host!.querySelectorAll("button")].map((b) => b.textContent ?? "");

// ── the fixtures, each one a shape real mail actually arrives in ────────────────────────

/** The overwhelming majority: no background declared anywhere. Drawn on white by everyone. */
const PLAIN = "<p>Hello there.</p>";
/** A table-based newsletter on white — the `bgcolor` spelling bulk mail is still built from. */
const LIGHT_TABLE =
  '<body><table bgcolor="#ffffff" width="600"><tr><td>Newsletter</td></tr></table></body>';
/** A sender who designed for dark, saying so on the body element. */
/* Each of these carries a `data:` picture, and it is load-bearing rather than incidental: a
   message with no picture, no canvas and no sheet is the PROSE class and renders frameless,
   so the `rootTag()` assertions below would be reading an empty string. Dark viewing is a
   property of the FRAME's document, so these fixtures have to be messages that get one. */
const DARK_PIXEL = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="64" height="64">';
const DARK_BODY = `<body bgcolor="#111111"><p style="color:#eee">Dark by design</p>${DARK_PIXEL}</body>`;
/** The same intent, said in the stylesheet instead — GitHub's dark canvas colour. */
const DARK_SHEET = `<style>body{background:#0d1117}</style><p>Dark by design</p>${DARK_PIXEL}`;
/** A dark wrapper table, which is how an html-mail builder emits the same thing. */
const DARK_TABLE = `<div style="background-color:#1a1a2e"><p>Dark by design</p>${DARK_PIXEL}</div>`;
/** A 1x1 transparent gif — a background image that SURVIVES neutralising, because it is data:. */
const DATA_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// ══ 1. which mail is light, and what the answer is read from ════════════════════════════

describe("the paper a mail is painted on", () => {
  it("parses the colour spellings mail is written in, and refuses the ones that paint nothing", async () => {
    // THE GUARD under everything else in this file: a colour this cannot read is a background
    // that reads as "none declared", which defaults to LIGHT — so a parser gap silently turns
    // a dark mail into an inverted one. Mutation: drop the `#rgb` branch (return null for
    // length 3). Real failure text:
    //   AssertionError: expected null to deeply equal { r: 255, g: 255, b: 255, a: 1 }
    const { parseCssColor } = await mod();
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#111111")).toEqual({ r: 17, g: 17, b: 17, a: 1 });
    expect(parseCssColor("rgb(13, 17, 23)")).toEqual({ r: 13, g: 17, b: 23, a: 1 });
    expect(parseCssColor("rgb(13 17 23 / 50%)")?.a).toBeCloseTo(0.5, 5);
    expect(parseCssColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("black")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    // The ones that are NOT a background: no opinion, so the scan keeps looking.
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("inherit")).toBeNull();
    expect(parseCssColor("linear-gradient(#fff,#000)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
    // `rgba(0,0,0,0)` is spelled like a colour and paints nothing. Reading it as BLACK is
    // precisely how a white mail would be classified dark and left uninverted.
    const invisible = parseCssColor("rgba(0,0,0,0)");
    expect(invisible?.a).toBe(0);
  });

  it("weights luminance perceptually, so the threshold means what it says", async () => {
    // Mutation: replace the linearisation with a plain (r+g+b)/3/255 average. Real failure
    // text: AssertionError: expected 0.4 to be less than 0.179  — a mid green would then
    // count as light and a dark-green mail would be inverted to a bright one.
    const { relativeLuminance, parseCssColor, LIGHT_LUMINANCE } = await mod();
    expect(relativeLuminance(parseCssColor("#ffffff")!)).toBeCloseTo(1, 5);
    expect(relativeLuminance(parseCssColor("#000000")!)).toBeCloseTo(0, 5);
    expect(relativeLuminance(parseCssColor("#008000")!)).toBeLessThan(LIGHT_LUMINANCE);
    // The crossover is where black and white ink contrast equally; white is above it.
    expect(relativeLuminance(parseCssColor("#f5f5f5")!)).toBeGreaterThan(LIGHT_LUMINANCE);
    expect(relativeLuminance(parseCssColor("#0d1117")!)).toBeLessThan(LIGHT_LUMINANCE);
  });

  it("mail that declares no background at all is LIGHT — the default the product rests on", async () => {
    // THE ONE THAT MATTERS MOST, because it is most of the mail there is. Mutation: make
    // `mailIsLight(null)` return false. Real failure text:
    //   AssertionError: expected false to be true
    // and dark viewing would then be switched off for nearly every message, silently.
    const { sanitizeMailHtml, mailIsLight } = await mod();
    expect(mailIsLight(null)).toBe(true);
    const plain = sanitizeMailHtml(PLAIN);
    expect(plain.background).toBeNull();
    expect(plain.light).toBe(true);
  });

  it("reads the paper from the body attribute, the stylesheet, and the outermost wrapper", async () => {
    // THE THREE SOURCES, one assertion each, because each is a different code path and a
    // mutation to any one of them leaves the other two green. Mutation: delete the
    // `parsedBody` branch of `effectiveBackground`. Real failure text:
    //   AssertionError: expected true to be false   (DARK_BODY classified light)
    const { sanitizeMailHtml } = await mod();

    expect(sanitizeMailHtml(LIGHT_TABLE).light).toBe(true);

    const viaBody = sanitizeMailHtml(DARK_BODY);
    expect(viaBody.light).toBe(false);
    expect(viaBody.background).toEqual({ r: 17, g: 17, b: 17, a: 1 });

    const viaSheet = sanitizeMailHtml(DARK_SHEET);
    expect(viaSheet.light).toBe(false);
    expect(viaSheet.background).toEqual({ r: 13, g: 17, b: 23, a: 1 });

    const viaWrapper = sanitizeMailHtml(DARK_TABLE);
    expect(viaWrapper.light).toBe(false);
  });

  it("a highlighted WORD is not the paper", async () => {
    // The scan is restricted to elements that paint a page. Mutation: delete the
    // `PAINTS_THE_PAGE.has(...)` test in `effectiveBackground`. Real failure text:
    //   AssertionError: expected false to be true
    // — a black `<span>` highlight in the first line would decide the whole message.
    const { sanitizeMailHtml } = await mod();
    const mail = '<p>ordinary <span style="background:#000000">inverse bit</span> text</p>';
    expect(sanitizeMailHtml(mail).light).toBe(true);
  });

  it("a fully transparent background is not a background", async () => {
    // Mutation: drop the `a >= 0.5` test in `declaredBackground`. Real failure text:
    //   AssertionError: expected false to be true  — `rgba(0,0,0,0)` would read as black.
    const { sanitizeMailHtml } = await mod();
    expect(sanitizeMailHtml('<div style="background:rgba(0,0,0,0)"><p>hi</p></div>').light).toBe(true);
  });
});

// ══ 2. the component refuses to invert a mail that is already dark ══════════════════════

describe("dark viewing is offered for light mail and withheld from dark mail", () => {
  it("stamps the dark attribute on a light message in a dark theme", async () => {
    // Mutation: `dark: darkWanted` in place of `dark: darkWanted && light`. This one STAYS
    // GREEN — it is the control that proves the next test is the real guard.
    await renderIn("dark", { text: "fallback", html: LIGHT_TABLE });
    expect(rootTag()).toContain('data-ohmail-dark="1"');
  });

  it("DOES NOT stamp it on a mail the sender already drew dark — the double-inversion guard", async () => {
    // THE DEFECT THIS SLICE EXISTS FOR. Inverting an already-dark mail produces a LIGHT one,
    // so a dark theme flashed white on exactly the senders who designed for dark.
    // Mutation: `dark: darkWanted` in place of `dark: darkWanted && light`. Real failure text:
    //   AssertionError: expected '<!doctype html><html data-ohmail-dark="1">…' not to contain
    //   '<html data-ohmail-dark="1"'
    // `text: ""` KEEPS THE FRAME. This test is about the frame's paper, and a document that
    // declares no canvas is rendered in the app's own type now — the empty text part is the
    // fallback that still routes a letter through the framed path. See `isRigidLayout`.
    await renderIn("dark", { text: "", html: DARK_BODY });
    // THE ROOT ELEMENT specifically — see {@link rootTag}. The bare string still appears
    // further down, in the dormant `:root[data-ohmail-dark]` selectors that ship in every
    // document, so asserting over the whole srcdoc would be asserting that the sheet is
    // missing: a different claim, and a false one.
    expect(rootTag()).not.toContain("data-ohmail-dark");
    // The frame WAS built, and it carries this mail's own paper rather than the default white.
    expect(rootTag()).toContain("--ohmail-paper:rgb(17,17,17)");
    // And the mail is there, unaltered.
    expect(srcdoc()).toContain("Dark by design");
  });

  it("offers the Original/Adapt toggle only when there is an adaptation to make", async () => {
    // A control that visibly does nothing is worse than an absent one. Mutation: revert
    // `canAdapt` to plain `themeDark`. Real failure text:
    //   AssertionError: expected [ 'Original' ] to have a length of +0 but got 1
    const { COPY } = await mod();

    await renderIn("dark", { text: "fallback", html: LIGHT_TABLE });
    expect(buttons()).toContain(COPY.darkOriginal);

    // `text: ""` KEEPS THE FRAME. This test is about the frame's paper, and a document that
    // declares no canvas is rendered in the app's own type now — the empty text part is the
    // fallback that still routes a letter through the framed path. See `isRigidLayout`.
    await renderIn("dark", { text: "", html: DARK_BODY });
    expect(buttons().filter((t) => t === COPY.darkOriginal || t === COPY.darkAdapt)).toHaveLength(0);

    // And never in a light theme, for either kind of mail.
    await renderIn("light", { text: "fallback", html: LIGHT_TABLE });
    expect(buttons().filter((t) => t === COPY.darkOriginal || t === COPY.darkAdapt)).toHaveLength(0);
  });

  it("the toggle still flips the message back to its original colours", async () => {
    // The shipped affordance, unchanged by this slice — it now flips the FILTER rather than a
    // rewritten palette. Mutation: make `setOriginal` a no-op. Real failure text:
    //   AssertionError: expected 'Original' to be 'Adapt to dark'
    const { COPY } = await mod();
    const el = await renderIn("dark", { text: "fallback", html: LIGHT_TABLE });
    const toggle = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === COPY.darkOriginal,
    );
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { toggle!.click(); });
    const after = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(after).toContain(COPY.darkAdapt);
    const flipped = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === COPY.darkAdapt,
    );
    expect(flipped!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a mail left uninverted sits on ITS OWN paper, not on the frame's white sheet", async () => {
    // ── FOUND BY LOOKING AT IT, NOT BY A TEST ─────────────────────────────────────────
    //
    // Declining to invert a dark mail exposed something the inversion used to hide: a sender's
    // dark design lives on an inner wrapper table, not on a `<body>` the sanitizer keeps, so
    // the frame's own `background:#fff` showed around and beneath it and the message rendered
    // as a white card with a dark rectangle in it. The paper is now the mail's own declared
    // background.
    //
    // Mutation: drop the `paper` option from the component's `buildMailDocument` call, or
    // revert FRAME_CSS's `background:var(--ohmail-paper,#fff)` to `background:#fff`. Real
    // failure text:
    //   AssertionError: expected '<!doctype html><html><head>…' to contain '--ohmail-paper'
    const { sanitizeMailHtml, buildMailDocument } = await mod();
    const { html, background } = sanitizeMailHtml(DARK_BODY);
    expect(background).toEqual({ r: 17, g: 17, b: 17, a: 1 });
    const doc = buildMailDocument(html, { paper: background });
    expect(doc).toContain('style="--ohmail-paper:rgb(17,17,17)"');
    expect(doc).toContain("background:var(--ohmail-paper,#fff)");

    // The INVERTED path must keep its own chosen paper — #e4e4e4 is picked to invert to the
    // app's dark panel, and letting the sender's colour through there would invert to something
    // arbitrary. Specificity is what separates them, so both rules have to be present.
    expect(doc).toContain(":root[data-ohmail-dark] body{background:#e4e4e4;");

    // AND THE EQUALITY THAT MAKES THE LIVE FLIP POSSIBLE STILL HOLDS. The paper is independent
    // of the theme, so stripping the dark attribute must still yield the light document.
    const darkDoc = buildMailDocument(html, { paper: background, dark: true });
    expect(darkDoc.replace(' data-ohmail-dark="1"', "")).toBe(doc);

    // A mail that declared nothing carries no paper at all, so the default stands.
    expect(buildMailDocument("<p>x</p>", { paper: null })).toContain("<html>");
  });

  it("plain-text mail gets no filter and no frame at all", async () => {
    // The text path keeps real theme tokens — it is `BodyText`, not a document under a filter.
    // Mutation: render the frame for a message with no html. Real failure text:
    //   AssertionError: expected <iframe /> to be null
    const el = await renderIn("dark", { text: "just words", html: null });
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.textContent).toContain("just words");
  });
});

// ══ 2b. a near-neutral light paper is clamped to the app's own white ══════════════════════

describe("a colourless light paper is clamped to white; a real canvas keeps its ground", () => {
  it("clampedPaper drops a colourless light ground and keeps everything else", async () => {
    // THE UNIT GUARD. A letter that declares a faint grey/off-white page is not asking to keep
    // that grey — it is the sender's template — so the frame is painted on the app's white
    // instead. Mutation: `return bg` (never clamp). Real failure text:
    //   AssertionError: expected { r: 239, g: 239, b: 239, a: 1 } to be null
    const { clampedPaper, parseCssColor } = await mod();
    // near-neutral LIGHT → the app's own white (null, the same as "declared nothing")
    expect(clampedPaper(parseCssColor("#efefef"))).toBeNull();
    expect(clampedPaper(parseCssColor("#ffffff"))).toBeNull();
    expect(clampedPaper(parseCssColor("#f5f5f5"))).toBeNull();
    expect(clampedPaper(parseCssColor("#faf8f2"))).toBeNull(); // a warm template off-white
    // a DELIBERATE light tint clears the neutral band and is kept
    expect(clampedPaper(parseCssColor("#cfe0ff"))).toEqual({ r: 207, g: 224, b: 255, a: 1 });
    // a DARK canvas is a sender who drew a dark page — kept
    expect(clampedPaper(parseCssColor("#111111"))).toEqual({ r: 17, g: 17, b: 17, a: 1 });
    // a mail that declared nothing stays nothing
    expect(clampedPaper(null)).toBeNull();
  });

  it("the grey-wrapper letter renders on white, and a tinted canvas keeps its paper", async () => {
    // THE FIXTURE GUARD, end to end through the component. The grey wrapper used to paint the
    // frame's paper #efefef and read as a dull sheet behind a plain letter; it must carry no
    // paper at all now (the app's white). Mutation: `paper: background` in place of
    // `paper: clampedPaper(background)` — red: the srcdoc gains `--ohmail-paper:rgb(239,239,239)`.
    await renderIn("light", { text: GRAY_WRAPPER_TEXT, html: GRAY_WRAPPER_HTML });
    expect(rootTag(), "the grey wrapper still paints a grey paper").not.toContain("--ohmail-paper");

    // The other side of the clamp: a real pale-blue canvas is a design, and it keeps its ground.
    await renderIn("light", { text: "A designed card.", html: TINTED_WRAPPER_HTML });
    expect(rootTag()).toContain("--ohmail-paper:rgb(207,224,255)");
  });
});

// ══ 2c. the page a letter is drawn on, and the ink on it ═══════════════════════════════════

/** The frame body's painted `prop` (`background` or `color`), resolved through the root's custom properties. */
const framePaint = (prop: "background" | "color"): string => {
  const rule = new RegExp(`(?:^|[}\\n])body\\{[^}]*?(?:^|;)${prop}:([^;}]+)`).exec(srcdoc())?.[1] ?? "";
  const vars = /<html[^>]*style="([^"]*)"/.exec(rootTag())?.[1] ?? "";
  return rule.replace(/var\((--[\w-]+),([^)]+)\)/, (_m, name: string, fallback: string) =>
    new RegExp(`${name}:([^;"]+)`).exec(vars)?.[1] ?? fallback);
};
const frameContrast = async (): Promise<number> => {
  const { parseCssColor, relativeLuminance } = await mod();
  const [a, b] = [relativeLuminance(parseCssColor(framePaint("background"))!), relativeLuminance(parseCssColor(framePaint("color"))!)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe("a letter's page and ink read together", () => {
  /** A receipt whose dark-scheme rule follows another rule in its @media block. */
  const DARK_MEDIA = "<style>@media (prefers-color-scheme: dark){ .logo{display:none} body{background-color:#1e1e1e !important} }</style>"
    + '<table><tr><td style="color:#333333">Your receipt</td></tr></table>';
  /** A dark newsletter whose page rule sits in a screen block, after another rule. */
  const SCREEN_DARK = "<style>@media screen{ .a{margin:0} body{background:#000000;color:#ffffff} }</style><p>Dark newsletter words</p>";
  /** White cards with no ink of their own under a page read as dark: (a) a dark header table, (b) a dark header div, (c) a dark body. */
  const CARDS = [
    `<table bgcolor=#222><tr><td style=color:#fff>Brand</td></tr></table><table bgcolor=#fff><tr><td>Your order has shipped</td></tr></table>${DARK_PIXEL}`,
    `<div style="background:#222;color:#fff">Brand</div><div style="background:#fff">Your order has shipped</div>${DARK_PIXEL}`,
    `<body bgcolor=#000><table bgcolor=#fff><tr><td>Your order has shipped</td></tr></table>${DARK_PIXEL}</body>`,
    // The same white card on a dark body, spelled as editors write it: spaced rgb, a rule, hsl, a gradient, a variable.
    '<body bgcolor=#000><table style="background-color: rgb(255, 255, 255)"><tr><td>Your order has shipped</td></tr></table></body>',
    '<html><head><style>.card{background-color: rgb(255, 255, 255)}</style></head><body bgcolor=#000><table class="card"><tr><td>Your order has shipped</td></tr></table></body></html>',
    '<body bgcolor=#000><table style="background-color: hsl(0, 0%, 100%)"><tr><td>Your order has shipped</td></tr></table></body>',
    '<body bgcolor=#000><table style="background: linear-gradient(to bottom, #ffffff, #ffffff)"><tr><td>Your order has shipped</td></tr></table></body>',
    '<html><head><style>.card{--card: #ffffff; background-color: var(--card)}</style></head><body bgcolor=#000><table class="card"><tr><td>Your order has shipped</td></tr></table></body></html>',
  ];
  /** Letters that set their own dark page and light ink. */
  const OWN_INK = [
    '<body style="background-color:#121212;color:#f5f5f5"><p>Dark page, light words</p></body>',
    "<body bgcolor=#000 text=#fff><p>Dark page, light words</p></body>",
    '<body style="background-color: rgb(18, 18, 18); color: rgb(245, 245, 245)"><p>Dark page, light words</p></body>',
  ];
  /** A dark page said only for narrow screens: the browser applies it, the page reading never does. */
  const NARROW_DARK = "<style>@media only screen and (max-width:600px){body{background-color:#000000}}</style><p>Wide words</p>";
  /** A mid-grey page (classed light, painted white) with a light ink of its own. */
  const GREY_OWN_INK = '<body bgcolor="#767676" text="#ffffff"><p>Grey page, white words</p></body>';
  /** A sheet rule paints a light page; the body's inline dark page and light ink are dropped with the body. */
  const SHEET_OVER_INLINE = '<style>body{background:#ffffff}</style><body style="background:#000;color:#fff"><p>Sheet page words</p></body>';

  it("a sheet html/body rule is the page over the body's dropped inline one", async () => {
    const { sanitizeMailHtml, pageBackground } = await mod();
    const mail = sanitizeMailHtml(SHEET_OVER_INLINE);
    expect(mail.light).toBe(true);
    expect(mail.ink ?? null).toBeNull();
    const body = new DOMParser().parseFromString('<body style="background:#000" bgcolor="#000"></body>', "text/html").body;
    expect(pageBackground(body, "body{background-color:#fff}")).toMatchObject({ r: 255, g: 255, b: 255 });
    // With no such rule (or one only for print) the body's own page counts.
    expect(pageBackground(body, "@media print{body{background:#fff}}")).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("a background value is split in one bounded pass, a function's arguments kept together", async () => {
    const { colourTokens } = await mod();
    expect(colourTokens(" rgb(18, 18, 18)  url(x) ")).toEqual(["rgb(18, 18, 18)", "url(x)"]);
    expect(colourTokens("url(a b) rgb(1, 2, 3) no-repeat")).toEqual(["url(a b)", "rgb(1, 2, 3)", "no-repeat"]);
    expect(colourTokens("rgb(var(--a, 1) , 2, 3) #fff")).toEqual(["rgb(var(--a, 1) , 2, 3)", "#fff"]);
    // Counted work: each character is visited at most once, and only the first 4 KB are read.
    for (const n of [1_000, 200_000]) {
      const value = "a ".repeat(n);
      const work = { visited: 0 };
      colourTokens(value, work);
      expect(work.visited, String(n)).toBeGreaterThan(0);
      expect(work.visited, String(n)).toBeLessThanOrEqual(Math.min(value.length, 4096));
    }
  });

  it("nested at-rule blocks are read in one bounded pass, however deep", async () => {
    const { screenRules, sanitizeMailHtml } = await mod();
    for (const open of ["@layer a{", "@supports (a){"]) {
      for (const n of [1_000, 12_000, 30_000]) {
        for (const css of [open.repeat(n), `${open.repeat(n)}body{background:#000}${"}".repeat(n)}`]) {
          const work = { visited: 0 };
          screenRules(css, work);
          expect(work.visited, `${open} ${n}`).toBeGreaterThan(0);
          expect(work.visited, `${open} ${n}`).toBeLessThanOrEqual(2 * css.length);
          expect(() => sanitizeMailHtml(`<style>${css}</style><p>x</p>`), `${open} ${n}`).not.toThrow();
        }
      }
    }
    // A page rule a few blocks deep still paints the page; one past the depth followed is left to the browser.
    const nested = (n: number): string => `<style>${"@layer a{".repeat(n)}body{background:#000}${"}".repeat(n)}</style><p>x</p>`;
    expect(sanitizeMailHtml(nested(3)).light).toBe(false);
    expect(sanitizeMailHtml(nested(40)).light).toBe(true);
    // A rule after a closed block is read again; a stray brace ends nothing it did not open.
    expect(sanitizeMailHtml("<style>@layer a{@media print{body{background:#fff}} .a{x:y}} } body{background:#000}</style><p>x</p>").light).toBe(false);
  });

  it("a letter whose sanitizing throws is shown as text, and the letters around it stay", async () => {
    const DOMPurify = (await import("dompurify")).default;
    const spy = vi.spyOn(DOMPurify, "sanitize").mockImplementation(() => { throw new RangeError("Maximum call stack size exceeded"); });
    try {
      const { MessageBody } = await mod();
      await unmount();
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(h(ThemeProvider, {
          defaultPreference: "light", storageKey: null,
          children: [h("p", { key: "a" }, "The letter above"), h(MessageBody, { key: "b", text: "Plain words of the letter", html: "<p>Rich words</p>" })],
        }));
      });
      expect(spy).toHaveBeenCalled();
      expect(host.textContent).toContain("The letter above");
      expect(host.textContent).toContain("Plain words of the letter");
      expect(host.querySelector(".mb-note")?.textContent).toBeTruthy();
      expect(host.querySelector("iframe")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("a body rule inside an at-rule block is neither the paper nor the light/dark class", async () => {
    const { sanitizeMailHtml } = await mod();
    const mail = sanitizeMailHtml(DARK_MEDIA);
    expect(mail.background).toBeNull();
    expect(mail.light).toBe(true);
    await renderIn("light", { text: "", html: DARK_MEDIA });
    expect(rootTag()).not.toContain("--ohmail-paper");
    expect(srcdoc()).toContain("Your receipt");
    await renderIn("dark", { text: "", html: DARK_MEDIA });
    expect(rootTag()).toContain('data-ohmail-dark="1"');
    // A top-level rule after such a block still paints the page.
    expect(sanitizeMailHtml(`<style>@media print{body{background:#fff}} body{background:#0d1117}</style><p>x</p>${DARK_PIXEL}`).light).toBe(false);
    // A block that holds at every width (screen, all, @supports, @layer) still paints it.
    for (const wrap of ["@media screen", "@media all", "@media only screen", "@supports (display:grid)", "@layer base"])
      expect(sanitizeMailHtml(`<style>${wrap}{.a{color:red} html,body{background:#000}}</style><p>x</p>`).light, wrap).toBe(false);
    // A block for print, or one that holds only at some sizes, is left to the browser.
    for (const wrap of ["@media print", "@media only screen and (min-width:480px)", "@media (max-height:400px)",
      "@media screen and (orientation:landscape)", "@media (min-aspect-ratio:1/1)", "@container (min-width:400px)"])
      expect(sanitizeMailHtml(`<style>${wrap}{.a{color:red} html,body{background:#000}}</style><p>x</p>`).light, wrap).toBe(true);
  });

  it("a dark page said inside @media screen is still a dark letter, never inverted in the dark theme", async () => {
    for (const html of [SCREEN_DARK, "<style>.a{margin:0} body{background:#000000;color:#ffffff}</style><p>Dark newsletter words</p>"]) {
      await renderIn("dark", { text: "", html });
      expect(srcdoc()).toContain("Dark newsletter words");
      expect(rootTag(), html).not.toContain("data-ohmail-dark");
    }
  });

  it("a dark page said only for narrow screens is drawn on the light paper, in its ink", async () => {
    await renderIn("light", { text: "", html: NARROW_DARK });
    expect(framePaint("background")).toBe("#fff");
    expect(await frameContrast()).toBeGreaterThanOrEqual(4.5);
    await renderIn("dark", { text: "", html: NARROW_DARK });
    expect(rootTag()).toContain('data-ohmail-dark="1"');
  });

  it("a letter that sets its own dark page and light ink is drawn in light ink", async () => {
    for (const html of OWN_INK) {
      await renderIn("light", { text: "", html });
      expect(await frameContrast(), html).toBeGreaterThanOrEqual(4.5);
      expect(framePaint("color")).toMatch(/245|255/);
    }
  });

  it("an ink that does not read on its page, or no ink at all, is the frame's own", async () => {
    // A light ink on a page that names none (read on white), and a dark page that names no ink: drawn as sent.
    for (const html of [
      "<body text=#ffffff><p>White ink, no page</p></body>",
      `<body bgcolor="#111111"><p>No ink named</p>${DARK_PIXEL}</body>`,
      // A light page painted white: its light ink would vanish on the white.
      GREY_OWN_INK,
      // The sheet's light page is the one painted, so the inline light ink is not taken.
      SHEET_OVER_INLINE,
    ]) {
      await renderIn("light", { text: "", html });
      expect.soft(framePaint("color"), html).toBe("#1b1b1b");
    }
    // White cards under a page read as dark keep the frame's dark ink: a light one would vanish on the cards.
    for (const html of CARDS) {
      await renderIn("light", { text: "", html });
      expect.soft(framePaint("color"), html).toBe("#1b1b1b");
    }
    // The ordinary letter keeps the frame's own ink and paper.
    await renderIn("light", { text: "fallback", html: LIGHT_TABLE });
    expect(framePaint("color")).toBe("#1b1b1b");
    expect(framePaint("background")).toBe("#fff");
  });

  describe.runIf(process.platform === "linux")("in a browser, light and dark", () => {
    it("every letter reads on screen in both themes; an inverted frame never matches the letter's dark-scheme rules", async () => {
      const css = readFileSync(resolve(process.cwd(), "apps/webapp/app/components/message-body.css"), "utf8");
      const { chromium } = createRequire(resolve(process.cwd(), "package.json"))("@playwright/test") as typeof import("@playwright/test");
      const browser = await chromium.launch();
      try {
        // No emulated scheme: Playwright's default would answer every frame's media query itself.
        const page = await browser.newPage({ colorScheme: null });
        const letters: [string, string][] = [[DARK_MEDIA, "Your receipt"], [SCREEN_DARK, "Dark newsletter words"], ...CARDS.map((c): [string, string] => [c, "Your order has shipped"]),
          ...OWN_INK.map((c): [string, string] => [c, "Dark page, light words"]), ["<body text=#fff><p>White ink, no page</p></body>", "White ink, no page"],
          [NARROW_DARK, "Wide words"], [GREY_OWN_INK, "Grey page, white words"], [SHEET_OVER_INLINE, "Sheet page words"]];
        for (const [html, words] of letters) {
          for (const theme of ["light", "dark"] as const) {
            await renderIn(theme, { text: "", html });
            const sheet = host!.querySelector(".mb-sheet")!.cloneNode(true) as Element;
            sheet.querySelector("iframe")!.removeAttribute("sandbox"); // so the test can read the frame
            await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${sheet.outerHTML}</body></html>`);
            await page.waitForFunction((w) => document.querySelector("iframe")?.contentDocument?.body?.textContent?.includes(w), words);
            const seen = await page.evaluate((w) => {
              const doc = document.querySelector("iframe")!.contentDocument!;
              const win = doc.defaultView!;
              const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
              let at: Element = doc.body;
              while (walk.nextNode()) if (walk.currentNode.textContent!.includes(w)) at = walk.currentNode.parentElement!;
              const inverted = win.getComputedStyle(doc.body).filter.includes("invert");
              const ctx = doc.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
              const shown = (c: string): number => {
                ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
                const v = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((x) => (inverted ? 255 - x : x) / 255);
                const [r, g, b] = v.map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
                return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
              };
              // The ground is the nearest painted box under the words (a card, a gradient's first stop), else the page.
              const paint = (el: Element): string | null => {
                const s = win.getComputedStyle(el);
                if (!/^rgba\(.*, 0\)$|^transparent$/.test(s.backgroundColor)) return s.backgroundColor;
                return /gradient/.test(s.backgroundImage) ? /rgba?\([^)]*\)/.exec(s.backgroundImage)?.[0] ?? null : null;
              };
              let under: Element = at;
              while (under !== doc.body && paint(under) === null) under = under.parentElement!;
              const [ink, ground] = [shown(win.getComputedStyle(at).color), shown(paint(under) ?? win.getComputedStyle(under).backgroundColor)];
              return { inverted, schemeDark: win.matchMedia("(prefers-color-scheme: dark)").matches, contrast: (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05) };
            }, words);
            expect.soft(seen.contrast, `${words}, ${theme}: ${html.slice(0, 90)}`).toBeGreaterThanOrEqual(4.5);
            if (seen.inverted) expect(seen.schemeDark, `${words}, ${theme}: dark-scheme rules under the inversion`).toBe(false);
          }
        }
      } finally {
        await browser.close();
      }
    }, 60_000);
  });
});

// ══ 3. pictures survive the inversion ═══════════════════════════════════════════════════

describe("media is counter-inverted so photographs keep their real colours", () => {
  it("the sheet negates every picture back, including one spelled as a background", async () => {
    // Mutation: delete `[data-ohmail-bgimg]` from the counter-invert selector list. Real
    // failure text:
    //   AssertionError: expected '…:root[data-ohmail-dark] img,…' to contain
    //   '[data-ohmail-bgimg]{filter:invert(1) hue-rotate(180deg)}'
    const { buildMailDocument } = await mod();
    const doc = buildMailDocument("<p>x</p>");
    expect(doc).toContain(":root[data-ohmail-dark] img,");
    expect(doc).toContain(":root[data-ohmail-dark] [data-ohmail-bgimg]{filter:invert(1) hue-rotate(180deg)}");
    // OUR OWN chrome stays inverted with the page — a blocked-image placeholder is not a
    // sender's picture and must not flip to a light box on a dark surface.
    expect(doc).toContain(":root[data-ohmail-dark] img[data-ohmail-embedded]{filter:none}");
  });

  it("marks an element whose background image SURVIVED neutralising", async () => {
    // Mutation: delete the `data-ohmail-bgimg` write in the post-pass. Real failure text:
    //   AssertionError: expected '<div style="background-image:url(data:…)">…' to contain
    //   'data-ohmail-bgimg'
    const { sanitizeMailHtml } = await mod();
    const { html } = sanitizeMailHtml(`<div style="background-image:url(${DATA_GIF})">hi</div>`);
    expect(html).toContain('data-ohmail-bgimg="1"');
    // The shorthand spelling too, which is how mail usually writes it. The `<td>` is inside a
    // real table on purpose: a bare one is not valid html and the PARSER drops it long before
    // the sanitizer has an opinion, which would make this assert nothing.
    const short = sanitizeMailHtml(
      `<table><tr><td style="background:#fff url(${DATA_GIF}) no-repeat">x</td></tr></table>`,
    );
    expect(short.html).toContain('data-ohmail-bgimg="1"');
  });

  it("does NOT mark an element whose remote background was already blanked", async () => {
    // A remote `url()` is rewritten to `none` before this runs, so there is no picture left to
    // protect and a marker would counter-invert a plain coloured box — turning its text back to
    // dark-on-dark for nothing. Mutation: mark on the presence of the word `background` alone.
    // Real failure text:
    //   AssertionError: expected '<div style="background-image:none">hi</div>' not to contain
    //   'data-ohmail-bgimg'
    const { sanitizeMailHtml } = await mod();
    const { html } = sanitizeMailHtml(
      '<div style="background-image:url(https://tracker.example.com/bg.png)">hi</div>',
    );
    expect(html).not.toContain("data-ohmail-bgimg");
    expect(html).toContain("none");
  });

  it("a sender cannot forge the marker", async () => {
    // `ALLOW_DATA_ATTR: false` is what refuses it, and the post-pass only ever ADDS the marker
    // to an element that really carries a surviving background image. Mutation: flip
    // `ALLOW_DATA_ATTR` to true. Real failure text:
    //   AssertionError: expected '<p data-ohmail-bgimg="1">x</p>' not to contain
    //   'data-ohmail-bgimg'
    const { sanitizeMailHtml } = await mod();
    const { html } = sanitizeMailHtml('<p data-ohmail-bgimg="1">x</p>');
    expect(html).not.toContain("data-ohmail-bgimg");
  });
});

// ══ 4. the colour REWRITER must never come back ═════════════════════════════════════════

describe("dark viewing never edits the sender's colours", () => {
  it("the sanitized document carries the sender's exact colours, in light and in dark alike", async () => {
    // ── WHY THIS GUARD EXISTS AT ALL ──────────────────────────────────────────────────
    //
    // The whole breakage class this slice retires is "adapt the mail by REWRITING its colours
    // in the DOM": it is inconsistent from one sender to the next and it destroys layouts,
    // because a colour in mail is load-bearing (a table cell's `bgcolor` is a border, a spacer,
    // a rule) and there is no way to tell which. The adaptation is a FILTER over the finished
    // rendering instead, and this asserts the difference: sanitizing is colour-preserving, and
    // the light and dark documents differ by ONE attribute and nothing else.
    //
    // Mutation: add a post-pass line that rewrites a dark `color:` to a light one — e.g.
    // `if (styled?.includes("color:#333")) node.setAttribute("style", styled.replace("#333","#ccc"))`.
    // Real failure text:
    //   AssertionError: expected '<p style="color:#ccc">…' to contain 'color:#333'
    const { sanitizeMailHtml, buildMailDocument } = await mod();
    const authored =
      '<table bgcolor="#f4f4f4"><tr><td style="color:#333;background-color:#ffffff">' +
      '<font color="#1a56db">link-ish</font></td></tr></table>';
    const { html } = sanitizeMailHtml(authored);
    for (const literal of ["#f4f4f4", "color:#333", "#ffffff", "#1a56db"]) {
      expect(html).toContain(literal);
    }
    // And the dark document is the light one plus the root attribute — byte for byte. A
    // rewriter would have to produce a different BODY, so this equality is the structural
    // half of the same claim.
    const light = buildMailDocument(html);
    const dark = buildMailDocument(html, { dark: true });
    expect(dark.replace(' data-ohmail-dark="1"', "")).toBe(light);
  });

  it("the adaptation is a filter, and it ships dormant in every document", async () => {
    // Mutation: move the invert rules into a dark-only branch of `buildMailDocument`. Real
    // failure text: AssertionError: expected '…' to contain 'filter:invert(1) hue-rotate(180deg)'
    // — and the live flip could then no longer be a `toggleAttribute` on the frame's document.
    const { buildMailDocument } = await mod();
    const light = buildMailDocument("<p>x</p>");
    expect(light).toContain(":root[data-ohmail-dark] body{background:#e4e4e4;filter:invert(1) hue-rotate(180deg)}");
    expect(light).not.toContain("<html data-ohmail-dark");
  });
});

// ══ 5. fitting a wide mail into the column ══════════════════════════════════════════════

describe("scale-to-fit", () => {
  it("computes the uniform scale that makes a wide mail fit", async () => {
    // Mutation: `columnPx / naturalPx` → `naturalPx / columnPx`. Real failure text:
    //   AssertionError: expected 1.5384… to be close to 0.65
    const { fitScale } = await mod();
    expect(fitScale(720, 900)).toBeCloseTo(0.8, 5);
    expect(fitScale(600, 700)).toBeCloseTo(0.857, 3);
  });

  it("never scales a mail that already fits", async () => {
    // A transform makes the body a containing block for positioned descendants, so applying
    // one to ordinary mail changes its layout for no gain. Mutation: drop the
    // `naturalPx <= columnPx` early return. Real failure text:
    //   AssertionError: expected 0.65 to be 1
    const { fitScale } = await mod();
    expect(fitScale(600, 600)).toBe(1);
    expect(fitScale(900, 600)).toBe(1);
  });

  it("caps at the floor rather than shrinking mail into illegibility", async () => {
    // READABILITY BEATS FIT. Past the floor the mail keeps its horizontal scroll, which is the
    // honest outcome for a 1200px poster in a 390px column. Mutation: remove the `Math.max`
    // against MIN_FIT_SCALE. Real failure text:
    //   AssertionError: expected 0.3 to be 0.6
    // The 0.6 floor is a wide column's (700px and up); a narrower one reflows or floors higher.
    const { fitScale, MIN_FIT_SCALE } = await mod();
    expect(MIN_FIT_SCALE).toBe(0.6);
    expect(fitScale(720, 2400)).toBe(MIN_FIT_SCALE);
    expect(fitScale(700, 5000)).toBe(MIN_FIT_SCALE);
    // The boundary itself is the fit, not the floor.
    expect(fitScale(720, 1200)).toBeCloseTo(0.6, 5);
  });

  it("answers 1 for a reading it could not take, which is what keeps jsdom out of the fit", async () => {
    // Every layout number is 0 in jsdom, and "do not scale" is the only safe answer to "I could
    // not measure". Mutation: return `columnPx / naturalPx` unguarded. Real failure text:
    //   AssertionError: expected NaN to be 1
    const { fitScale } = await mod();
    expect(fitScale(0, 0)).toBe(1);
    expect(fitScale(0, 600)).toBe(1);
    expect(fitScale(390, 0)).toBe(1);
    expect(fitScale(Number.NaN, 600)).toBe(1);
  });

  it("the fit rule ships dormant in every document, gated on its own attribute", async () => {
    // Same shape as the dark rules: the sheet the reader already has is switched in place, so
    // fitting never rebuilds the srcdoc and never re-parses the mail. Mutation: delete the rule
    // from FRAME_CSS. Real failure text:
    //   AssertionError: expected '…' to contain ':root[data-ohmail-scaled] body{'
    const { buildMailDocument } = await mod();
    const doc = buildMailDocument("<p>x</p>");
    expect(doc).toContain(":root[data-ohmail-scaled] body{transform-origin:0 0;transform:scale(var(--ohmail-scale,1))}");
    // The attribute is written by the measurement, never baked into the document.
    expect(doc).not.toContain("data-ohmail-scaled=");
  });

  it("THE COMPOSITION ORDER: the filter and the transform are separate properties on one element", async () => {
    // Both land on `body` whenever a wide mail is read in a dark theme. They compose — a
    // uniform scale and a per-pixel colour operation commute — but only as long as they stay
    // two declarations. Mutation: fold the scale into the dark rule as
    // `filter:invert(1) hue-rotate(180deg);transform:scale(...)`, which drops the fit for every
    // LIGHT reader. Real failure text:
    //   AssertionError: expected '…' to contain ':root[data-ohmail-scaled] body{'
    const { buildMailDocument } = await mod();
    const doc = buildMailDocument("<p>x</p>");
    const darkRule = /:root\[data-ohmail-dark\] body\{([^}]*)\}/.exec(doc);
    const fitRule = /:root\[data-ohmail-scaled\] body\{([^}]*)\}/.exec(doc);
    expect(darkRule).toBeTruthy();
    expect(fitRule).toBeTruthy();
    // The dark rule carries the filter and NO transform; the fit rule the reverse. Either one
    // reaching into the other's property is what silently drops a mechanism.
    expect(darkRule![1]).toContain("filter:");
    expect(darkRule![1]).not.toContain("transform");
    expect(fitRule![1]).toContain("transform:");
    expect(fitRule![1]).not.toContain("filter");
  });

  it("the measurement is INERT in jsdom, so nothing here is evidence about the fit", async () => {
    // THE HONESTY GUARD. jsdom reports every layout number as 0, `fitScale` answers 1, and the
    // component must therefore write no transform at all — if it did, this suite would be
    // asserting against a fit that no engine ever computed. Mutation: `if (scale <= 1)` in
    // place of `if (scale < 1)` in measure(). Real failure text:
    //   AssertionError: expected '1' to be null
    const el = await renderIn("light", { text: "fallback", html: LIGHT_TABLE });
    const iframe = el.querySelector("iframe")!;
    const doc = (iframe as HTMLIFrameElement).contentDocument;
    // jsdom gives a srcdoc frame no contentDocument to measure; when it does, it is unscaled.
    if (doc?.documentElement) {
      expect(doc.documentElement.getAttribute("data-ohmail-scaled")).toBeNull();
      expect(doc.documentElement.style.getPropertyValue("--ohmail-scale")).toBe("");
    }
    // The frame itself is never given a fixed height attribute by the markup.
    expect(iframe.getAttribute("height")).toBeNull();
  });
});
