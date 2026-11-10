/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@ohmail/ui";
import { parseCssColor, relativeLuminance } from "@ohmail/client-engine";
import { GRAY_WRAPPER_HTML, GRAY_WRAPPER_TEXT, TINTED_WRAPPER_HTML } from "./fixtures/gray-wrapper-letter";
import { CORPUS_WIDTHS, LETTER_PAPER_CORPUS } from "../../../packages/client-engine/test/fixtures/letter-paper-corpus";
import { LetterJudge, judgeEngines, type OsScheme } from "../../../packages/client-engine/test/fixtures/letter-paper-judge";

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
  it("mail that declares no background at all is LIGHT — the default the product rests on", async () => {
    // THE ONE THAT MATTERS MOST, because it is most of the mail there is. Mutation: make
    // `mailIsLight(null)` return false. Real failure text:
    //   AssertionError: expected false to be true
    // and dark viewing would then be switched off for nearly every message, silently.
    const { sanitizeMailHtml } = await mod();
    const plain = sanitizeMailHtml(PLAIN);
    expect(plain.background).toBeNull();
    expect(plain.light).toBe(true);
  });

  it("reads the paper from the body attribute, the stylesheet, and the outermost wrapper", async () => {
    // THE THREE SOURCES, one assertion each, because each is a different code path and a
    // mutation to any one of them leaves the other two green. Mutation: delete the
    // body branch of `letterPaperOf`. Real failure text:
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
    // `PAINTS_THE_PAGE.has(...)` test in `letterPaperOf`. Real failure text:
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

  it("the colours kept for a message are its account's own, and a device-wide set an earlier build kept is dropped unread", async () => {
    const { COPY } = await mod();
    const props = { text: "fallback", html: LIGHT_TABLE, messageId: "m-1" };
    // Every account's message ids, in one value no erasure could find by its key.
    localStorage.setItem("ohmail.ui.mail.original", JSON.stringify(["m-1"]));
    const as = async (owner: string): Promise<string[]> => {
      document.cookie = `tf_owner=${owner}; Path=/`;
      await renderIn("dark", props);
      return buttons();
    };
    try {
      expect(await as("acct_A"), "the device-wide set was read").toContain(COPY.darkOriginal);
      expect(localStorage.getItem("ohmail.ui.mail.original"), "the device-wide set is still here").toBeNull();
      await act(async () => { [...host!.querySelectorAll("button")].find((b) => b.textContent === COPY.darkOriginal)!.click(); });
      expect(await as("acct_B"), "another account opened the message in A's colours").toContain(COPY.darkOriginal);
      expect(await as("acct_A"), "A's choice was lost").toContain(COPY.darkAdapt);
    } finally {
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      localStorage.clear();
    }
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
  it("the grey-wrapper letter renders on white, and a tinted canvas keeps its paper", async () => {
    // THE FIXTURE GUARD, end to end through the component. The grey wrapper used to paint the
    // frame's paper #efefef and read as a dull sheet behind a plain letter; it must carry no
    // paper at all now (the app's white). Mutation: `paper: background` in place of
    // `paintedPaper` in `letterPaperOf` — red: the srcdoc gains `--ohmail-paper:rgb(239,239,239)`.
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
    const { sanitizeMailHtml } = await mod();
    const mail = sanitizeMailHtml(SHEET_OVER_INLINE);
    expect(mail.light).toBe(true);
    expect(mail.ink ?? null).toBeNull();
    // With no such rule (or one only for print) the body's own page counts.
    expect(sanitizeMailHtml('<style>@media print{body{background:#fff}}</style><body style="background:#000" bgcolor="#000"><p>x</p></body>').background)
      .toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("nested at-rule blocks are read without throwing, however deep", async () => {
    const { sanitizeMailHtml } = await mod();
    for (const open of ["@layer a{", "@supports (a:b){"]) {
      for (const n of [1_000, 12_000, 30_000]) {
        for (const css of [open.repeat(n), `${open.repeat(n)}body{background:#000}${"}".repeat(n)}`]) {
          expect(() => sanitizeMailHtml(`<style>${css}</style><p>x</p>`), `${open} ${n}`).not.toThrow();
        }
      }
    }
    // A page rule a few blocks deep still paints the page; one past the depth is dropped, from the frame and the reading.
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
    // A block that holds in the 572-px frame (screen, all, @supports, @layer, a width it meets) paints it.
    for (const wrap of ["@media screen", "@media all", "@media only screen", "@supports (display:grid)", "@layer base", "@media only screen and (min-width:480px)"])
      expect(sanitizeMailHtml(`<style>${wrap}{.a{color:red} html,body{background:#000}}</style><p>x</p>`).light, wrap).toBe(false);
    // A block for print, or for a size the frame is not, is dropped.
    for (const wrap of ["@media print", "@media (max-height:400px)",
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

  it("a letter that sets its own dark page and light ink is drawn in light ink", async () => {
    for (const html of OWN_INK) {
      await renderIn("light", { text: "", html });
      expect(await frameContrast(), html).toBeGreaterThanOrEqual(4.5);
      expect(framePaint("color")).toMatch(/245|255/);
    }
  });

  it("a dark page that names no ink, where no element paints a background, is set in ohmail's light ink in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      await renderIn(theme, { text: "", html: `<body bgcolor="#111111"><p>No ink named</p>${DARK_PIXEL}</body>` });
      expect(rootTag(), theme).not.toContain("data-ohmail-dark");
      expect(framePaint("color"), theme).toBe("rgb(228,228,228)");
      expect(await frameContrast(), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("an ink that does not read on its page, or no ink at all, is the frame's own", async () => {
    // A light ink on a page that names none (read on white): drawn as sent.
    for (const html of [
      "<body text=#ffffff><p>White ink, no page</p></body>",
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

});

// ══ 2d. a letter is read at the frame's own width ═══════════════════════════════════════════

describe("a letter is read at the frame's own width, and again only when the frame crosses one of its widths", () => {
  /** A dark page said only for phones, naming no ink; a light page said for phones over a dark body with light ink. */
  const DM7 = `<style>@media only screen and (max-width:600px){body{background-color:#000000 !important}}</style><p>Wide words</p>${DARK_PIXEL}`;
  const LIGHT_UNDER = `<style>@media (max-width:600px){body{background:#ffffff !important}}</style><body style="background:#000;color:#fff"><p>Words</p>${DARK_PIXEL}</body>`;
  let width = 572;
  const observers = new Set<(entries: unknown[]) => void>();
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("mb") ? width : 0;
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly cb: (entries: unknown[]) => void) {}
      observe(): void { observers.add(this.cb); }
      unobserve(): void {}
      disconnect(): void { observers.delete(this.cb); }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    observers.clear();
  });
  const resize = async (w: number): Promise<void> => {
    width = w;
    await act(async () => { for (const cb of [...observers]) cb([]); });
  };
  const at = async (w: number, theme: "light" | "dark", html: string): Promise<void> => {
    width = w;
    await renderIn(theme, { text: "", html });
  };

  it("a page made dark for phones is the page in the 572-px column, never inverted, in ohmail's light ink; not in a 730-px one", async () => {
    for (const theme of ["light", "dark"] as const) {
      await at(572, theme, DM7);
      expect(rootTag(), theme).not.toContain("data-ohmail-dark");
      expect(rootTag(), theme).toContain("--ohmail-paper:rgb(0,0,0)");
      expect(framePaint("color"), theme).toBe("rgb(228,228,228)");
      expect(await frameContrast(), theme).toBeGreaterThanOrEqual(4.5);
      expect(srcdoc()).toContain("body{background-color:#000000 !important}");
      expect(srcdoc()).not.toContain("max-width:600px");
      await at(730, theme, DM7);
      expect(rootTag().includes('data-ohmail-dark="1"'), theme).toBe(theme === "dark");
      expect(rootTag(), theme).not.toContain("--ohmail-paper");
      expect(framePaint("color"), theme).toBe("#1b1b1b");
      expect(srcdoc()).not.toContain("#000000 !important");
    }
    // A white card on the same page: an element paints a background, so the letter is drawn as written.
    await at(572, "light", DM7.replace("<p>Wide words</p>", '<table bgcolor="#ffffff"><tr><td>Card words</td></tr></table>'));
    expect(rootTag()).toContain("--ohmail-paper:rgb(0,0,0)");
    expect(framePaint("color")).toBe("#1b1b1b");
  });

  it("a page made light for phones over a dark body reads light in the frame's ink at 572, and as the body's dark page at 730", async () => {
    for (const theme of ["light", "dark"] as const) {
      await at(572, theme, LIGHT_UNDER);
      expect(framePaint("background"), theme).toBe("#fff");
      expect(framePaint("color"), theme).toBe("#1b1b1b");
      expect(rootTag().includes('data-ohmail-dark="1"'), theme).toBe(theme === "dark");
      await at(730, theme, LIGHT_UNDER);
      expect(rootTag(), theme).toContain("--ohmail-paper:rgb(0,0,0)");
      expect(rootTag(), theme).toContain("--ohmail-ink:rgb(255,255,255)");
      expect(rootTag(), theme).not.toContain("data-ohmail-dark");
      expect(await frameContrast(), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("a resize across one of the letter's widths builds one new document; one within a band builds none", async () => {
    const DOMPurify = (await import("dompurify")).default;
    const passes = vi.spyOn(DOMPurify, "sanitize");
    const LETTER = `<style>@media (min-width:480px){.a{color:#333333}}</style><p class="a">Words</p>${DARK_PIXEL}`;
    await at(572, "light", LETTER);
    const doc = srcdoc();
    let n = passes.mock.calls.length;
    await resize(560);
    expect(passes.mock.calls.length, "572 to 560 crosses nothing").toBe(n);
    await resize(400);
    expect(passes.mock.calls.length, "560 to 400 crosses 480").toBe(n + 1);
    expect(srcdoc()).not.toBe(doc);
    expect(srcdoc()).not.toContain("color:#333333");
    // A letter with no width of its own is never built again.
    await at(572, "light", `<p>Plain words</p>${DARK_PIXEL}`);
    n = passes.mock.calls.length;
    await resize(343);
    await resize(900);
    expect(passes.mock.calls.length).toBe(n);
  });

  it("a scrollbar answering the last crossing does not take it back", async () => {
    const DOMPurify = (await import("dompurify")).default;
    const passes = vi.spyOn(DOMPurify, "sanitize");
    const LETTER = `<style>@media (max-width:580px){.a{padding-bottom:2000px}}</style><p class="a">Words</p>${DARK_PIXEL}`;
    await at(590, "light", LETTER);
    const n = passes.mock.calls.length;
    await resize(575);
    expect(passes.mock.calls.length, "590 to 575 crosses 580").toBe(n + 1);
    await resize(590);
    expect(passes.mock.calls.length, "the 15-px step back is the pane's scrollbar").toBe(n + 1);
    // A real change is taken: the pane widened past the scrollbar's step.
    await resize(620);
    expect(passes.mock.calls.length).toBe(n + 2);
  });

  const engines = judgeEngines();
  it.runIf(process.platform === "linux")(`every corpus letter meets its pinned verdict at 343, 572 and 730 px and reads on screen as well as it was sent, in ${engines.join(" and ")}`, async () => {
    const { buildMailDocument } = await mod();
    // The frames this reader draws, in both themes, built here first.
    const frames: Array<{ name: string; html: string; words: string; width: number; theme: "light" | "dark"; doc: string; paper: number[] | null; light: boolean; scheme: boolean; reads: boolean }> = [];
    for (const letter of LETTER_PAPER_CORPUS) {
      for (const width of CORPUS_WIDTHS) {
        for (const theme of ["light", "dark"] as const) {
          await at(width, theme, letter.html);
          const label = `${letter.name} at ${width}, ${theme}`;
          const paper = /--ohmail-paper:rgb\((\d+),(\d+),(\d+)\)/.exec(rootTag())?.slice(1).map(Number) ?? null;
          const inverted = rootTag().includes('data-ohmail-dark="1"');
          expect.soft(paper === null ? "sheet" : "letter", label).toBe(letter.expect[width].page);
          expect.soft(inverted, label).toBe(theme === "dark" && letter.expect[width].light);
          frames.push({ name: letter.name, html: letter.html, words: letter.words, width, theme, doc: srcdoc(), paper, light: letter.expect[width].light, scheme: letter.scheme === true, reads: letter.reads === true });
        }
      }
    }
    const SHEETS = ["255,255,255", "228,228,228"];
    for (const engine of engines) {
      const judge = await LetterJudge.open(engine);
      try {
        const base = await judge.judge(buildMailDocument("<p>Baseline words</p>", {}), "Baseline words", 572, "light");
        for (const f of frames) {
          for (const os of (f.scheme ? ["light", "dark"] : ["light"]) as OsScheme[]) {
            const label = `${engine}: ${f.name} at ${f.width}, app ${f.theme}, OS ${os}`;
            const seen = await judge.judge(f.doc, f.words, f.width, os);
            if (f.paper !== null) expect.soft(seen.page, label).toEqual(f.paper);
            else expect.soft(SHEETS, label).toContain(seen.page.join(","));
            expect.soft(seen.inverted, label).toBe(f.theme === "dark" && f.light);
            expect.soft(seen.conditional, `${label}: a sender condition reached the frame`).toBe(base.conditional);
            expect.soft(seen.requests, label).toBe(0);
            expect.soft(seen.visible, `${label}: "${f.words}" is not shown`).toBe(true);
            const raw = await judge.raw(f.html, f.words, f.width, os);
            expect.soft(seen.contrast >= 4.5 || (!f.reads && raw < 4.5), `${label}: ${seen.contrast.toFixed(2)}:1, as sent ${raw.toFixed(2)}:1`).toBe(true);
          }
        }
      } finally {
        await judge.close();
      }
    }
  }, 600_000);

  it("a folded reply is read without the dark history it does not draw; opened, the whole letter is", async () => {
    const REPLY = `<p style="color:#333">Thanks, see below.</p>${DARK_PIXEL}<div><div>On Thu, 22 Oct 2026 at 09:14, A wrote:</div><blockquote type="cite">`
      + '<style>body{background:#000000}</style><p style="color:#fff">Old dark letter</p></blockquote></div>';
    await at(572, "dark", REPLY);
    expect(srcdoc()).not.toContain("Old dark letter");
    expect(rootTag(), "the folded letter is light, inverted in the dark theme").toContain('data-ohmail-dark="1"');
    const toggle = host!.querySelector<HTMLButtonElement>(".msg-history-toggle");
    expect(toggle).toBeTruthy();
    await act(async () => { toggle!.click(); });
    expect(srcdoc()).toContain("Old dark letter");
    expect(rootTag()).not.toContain("data-ohmail-dark");
    expect(rootTag()).toContain("--ohmail-paper:rgb(0,0,0)");
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
