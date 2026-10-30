/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OWNER_BILLING_HTML, OWNER_BILLING_TEXT, HOSTILE_HTML, HOSTILE_HOST } from "./fixtures/owner-billing-email";
import { COPY } from "../app/components/MessageBody";

/**
 * ── THE PROSE CLASS: A LETTER IS NOT A LAYOUT, AND DOES NOT NEED A FRAME ─────────────────
 *
 * Most mail between people is a paragraph and a sign-off that happens to arrive as html,
 * because every client sends html. Rendering it in a sandboxed iframe draws it in the SENDER's
 * type inside a product that has its own, and costs a document, a stylesheet and a measurement
 * pass to do it. `isRigidLayout` picks the DESIGNED mail out — that, and only that, keeps its
 * frame — and everything else renders through the same `BodyText` a message with no html has
 * always used.
 *
 * ── THE DEFAULT FLIPPED, AND THESE GUARDS FLIPPED WITH IT ────────────────────────────────
 *
 * This file used to assert four criteria: not rigid, no picture, no background image, and a
 * stylesheet under a length threshold. The last three were calibrated on fixtures, and against
 * ordinary business mail they are all three satisfied by things every mail client emits — a
 * signature logo, an inline screenshot, the boilerplate `<style>` a desktop client writes about
 * its own paragraph classes. They are gone, and the tests that asserted them are inverted below
 * rather than deleted, so that re-introducing any of them is red with a sentence saying why.
 *
 * ── THE ONE THING THIS FILE IS REALLY FOR ────────────────────────────────────────────────
 *
 * The prose class renders NATIVE RICH TEXT now: `buildRichNodes` walks the SANITIZED document
 * through a second, narrower allow-list and `BodyText` constructs every element itself —
 * paragraphs, headings, lists, tables, quotes, gated links. The invariant that survives the
 * change is the one `security-headers.ts` states: **no untrusted markup STRING reaches a DOM
 * sink; sender bytes enter the app document only as React text nodes, and every attribute on
 * screen is one this code constructed.** The dangerous version is still one line away —
 * *"the sanitizer approved this markup, so it is safe to inline"* — and the guards below hold
 * both halves at once: the structure REALLY renders (a walker that emitted nothing would make
 * every "nothing hostile survives" assertion pass vacuously), and nothing sender-authored — a
 * markup string, a class, a style, a handler, an unvetted href — exists anywhere in the tree.
 *
 * jsdom's limits are the same here as in `message-body.test.ts`: this file is about what the app
 * document CONTAINS, which jsdom answers exactly.
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

async function render(props: Parameters<Mod["MessageBody"]>[0]): Promise<HTMLDivElement> {
  await unmount();
  const { MessageBody } = await mod();
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, props)); });
  return host;
}

/** `sanitizeMailHtml(html).prose` — the classification, read from the real pass. */
async function proseOf(html: string, opts: Parameters<Mod["sanitizeMailHtml"]>[1] = {}): Promise<boolean> {
  const { sanitizeMailHtml } = await mod();
  return sanitizeMailHtml(html, opts).prose;
}

/** What a real client sends for "Thanks — see you Friday." */
const LETTER =
  `<div dir="ltr"><p>Thanks — I'll see you Friday.</p><p>— Sam</p>` +
  `<blockquote><p>On Tuesday you wrote:</p><p>Are we still on?</p></blockquote></div>`;

/** A picture, in the smallest form that needs no network. */
const PICTURE = `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80" height="80">`;

describe("what counts as prose", () => {
  /**
   * THE CASE THE FEATURE EXISTS FOR. No canvas, no picture, no sheet — a letter, including the
   * quoted original every reply carries, which is markup but is not a design.
   *
   * Mutation: `return false` at the end of `isProseDocument`. Real failure text:
   *   AssertionError: a plain letter is not being recognised as one: expected false to be true
   */
  it("a plain letter, quoted original and all", async () => {
    expect(await proseOf(LETTER), "a plain letter is not being recognised as one").toBe(true);
  });

  /**
   * ══ THE RULING THAT FLIPPED THE DEFAULT ══════════════════════════════════════════════
   *
   * A PICTURE NO LONGER DISQUALIFIES, and this test is the inversion of the one that stood here.
   * The old rule read "any `<img>` that is not a beacon means the sender put something on screen
   * the text part does not contain, so it needs a frame". It was calibrated on fixtures, and on
   * real mail it is answering the wrong question: ordinary business replies carry a signature
   * logo, a pasted screenshot, a `cid:` reference — none of which is a DESIGN, and every one of
   * which was enough to render a German letter in the sender's font inside a sandboxed document.
   *
   * The frame is for designed mail, and a design is a declared canvas. Everything else is a
   * letter and is set in the app's own type, pictures and all.
   *
   * Mutation: restore the `querySelectorAll("img")` loop to the classification. Real failure
   * text:
   *   AssertionError: a letter with a signature logo was pushed back into a frame: expected
   *   false to be true
   */
  it("a picture does not disqualify — logo, screenshot, or an unresolvable cid:", async () => {
    expect(
      await proseOf(LETTER + PICTURE),
      "a letter with a signature logo was pushed back into a frame",
    ).toBe(true);
    expect(await proseOf(`${LETTER}<img src="https://sender.example/hero.png" width="600">`))
      .toBe(true);
    // `cid:` is an inline attachment this build cannot resolve. It painted nothing in the frame
    // either, so the frame was never buying the reader anything for it.
    expect(await proseOf(`${LETTER}<img src="cid:logo@example">`)).toBe(true);
  });

  /**
   * A TABLE IS NOT A DESIGN. Every quoted thread and every signature block in the wild is a
   * table, and a table with no declared canvas reflows perfectly well.
   *
   * Mutation: add `if (root.querySelector("table")) return false` to the classification. Real
   * failure text:
   *   AssertionError: a quoted thread in a table was called a design: expected false to be true
   */
  it("a table with no canvas is still a letter", async () => {
    const quoted =
      `<p>Passt, bis Freitag.</p>` +
      `<table border="0" cellpadding="0" width="100%"><tr><td>` +
      `<p>Am Dienstag schrieben Sie:</p><p>Sind wir noch verabredet?</p></td></tr></table>`;
    expect(await proseOf(quoted), "a quoted thread in a table was called a design").toBe(true);
  });

  /**
   * A BEACON IS NOT A PICTURE, AND MUST NOT DISQUALIFY. It renders as nothing, it is never
   * fetched, and excluding it would drop a great deal of ordinary mail out of this class over a
   * thing the reader cannot see.
   *
   * This is also the guard on the marker the classifier reads. Mutation: delete the
   * `if (pixel) node.setAttribute("data-ohmail-pixel", "1")` line in the post-pass. Real failure
   * text:
   *   AssertionError: a letter carrying a beacon lost its prose classification: expected false
   *   to be true
   */
  it("a tracking beacon does not disqualify a letter", async () => {
    const withBeacon = `${LETTER}<img src="https://t.example/wf/open?u=1" width="1" height="1">`;
    expect(await proseOf(withBeacon), "a letter carrying a beacon lost its prose classification")
      .toBe(true);
  });

  /**
   * A DESIGN IS A DESIGN. The real marketing fixture declares a canvas, carries pictures and
   * ships a stylesheet — every test fails, and it must keep its frame under all of them.
   */
  it("a designed newsletter is never prose", async () => {
    expect(await proseOf(OWNER_BILLING_HTML)).toBe(false);
  });

  /**
   * THE RIGID TERM ON ITS OWN. A fixed canvas with no picture and no sheet still fails, because
   * a declared width is a layout the frame exists to reproduce.
   *
   * Mutation: `prose: isProseDocument(sanitized, styleText)` — dropping the `!rigid &&`. Real
   * failure text:
   *   AssertionError: a declared 600px canvas was called prose: expected true to be false
   */
  it("a fixed canvas is not prose even with nothing in it", async () => {
    expect(
      await proseOf(`<table width="640"><tr><td><p>hello</p></td></tr></table>`),
      "a declared 600px canvas was called prose",
    ).toBe(false);
  });

  /**
   * A BACKGROUND IMAGE IS A PICTURE UNDER ANOTHER SPELLING, and it stops disqualifying for the
   * same reason a picture does — it is decoration, not a layout. Both spellings are asserted so
   * that re-introducing either half of the old rule is red.
   */
  it("a background image does not disqualify, on an element or in the sheet", async () => {
    const inline = `${LETTER}<div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">x</div>`;
    expect(await proseOf(inline), "an inline background image forced a frame").toBe(true);
    const sheet = `<style>.hero{background:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)}</style>${LETTER}`;
    expect(await proseOf(sheet), "a background image in the sheet forced a frame").toBe(true);
  });

  /**
   * A STYLESHEET IS NOT A CANVAS. The old rule capped the sender's css at a kilobyte on the
   * argument that "a sender who wrote a stylesheet was styling something" — true, and not the
   * question. Every desktop client emits a sheet about its own paragraph and quote classes, and
   * a mail with 40 rules and no declared width still reflows into the reading column exactly as
   * one with none does.
   *
   * Mutation: restore the length test. Real failure text:
   *   AssertionError: a sheet with no canvas in it was treated as a design: expected false to
   *   be true
   */
  it("a stylesheet with no canvas in it is still a letter", async () => {
    const boilerplate = `<style>p.MsoNormal{margin:0;font-size:11pt;font-family:Calibri,sans-serif}</style>`;
    expect(await proseOf(boilerplate + LETTER), "a client's paragraph class is not a design")
      .toBe(true);

    const big = `<style>${".card{padding:12px;border:1px solid #eee;border-radius:8px}".repeat(40)}</style>`;
    expect(await proseOf(big + LETTER), "a sheet with no canvas in it was treated as a design")
      .toBe(true);

    // …and the same sheet WITH a canvas in it is a design, so this is a boundary and not a
    // blanket permit.
    const withCanvas = `<style>.wrap{width:600px}</style>${LETTER}`;
    expect(await proseOf(withCanvas), "a canvas declared in the sheet stopped counting")
      .toBe(false);
  });

  /**
   * ── THE UPPER BOUND, WHICH REAL MAIL FORCED ─────────────────────────────────────────────
   *
   * `width:1578px` is not a mail design; it is what a pasted chunk of some web ADMIN UI carries.
   * Two ordinary German business replies on a reported account classified rigid on exactly one
   * such div and were rendered scale-to-fit at roughly 0.4 — the sender's own sentences shrunk
   * to illegibility to preserve a "layout" nobody authored.
   *
   * Mutation: drop the `<= RIGID_MAX_PX` term from `isCanvasPx`. Real failure text:
   *   AssertionError: a pasted 1578px admin fragment was treated as a mail design: expected
   *   false to be true
   */
  it("a width far past any reading column is debris, not a canvas", async () => {
    const pasted = `${LETTER}<div style="width:1578px"><table><tr><td>pasted admin UI</td></tr></table></div>`;
    expect(await proseOf(pasted), "a pasted 1578px admin fragment was treated as a mail design")
      .toBe(true);

    // ANTI-VACUITY, and it is the case the band exists to keep separate: a document that
    // declares a real 600px canvas AND carries the same debris is still a design.
    //
    // BOTH WIDTHS IN THE SHEET, deliberately. Written first as `<table width="600">` around the
    // debris, this passed under every mutation — the ATTRIBUTE path answers 600 on its own and
    // the css scan is never reached, so the assertion named a mechanism it did not exercise.
    // Mutation it now watches: make `declaresCanvas` answer the WIDEST declaration and compare
    // that to the band, which is the obvious way to write it and is wrong — 1578 wins, the band
    // rejects it, and a real newsletter loses its frame because of the debris pasted into it.
    const both = `<style>.wrap{width:600px}.pasted{width:1578px}</style>${LETTER}`;
    expect(await proseOf(both), "debris beside a real canvas took the design out of the frame")
      .toBe(false);
  });
});

describe("what the reader gets", () => {
  /**
   * NO FRAME, AND THE LETTER'S OWN PARAGRAPHS — the html's structure walked into native
   * elements, NOT the text part flattened. The trailing blockquote is the same QuoteNode the
   * plain-text parser builds, so the history fold applies to html mail with no further wiring.
   *
   * Mutations, each watched red:
   *   · render the `.mb-sheet` branch unconditionally (drop `proseView ?`) — the iframe line.
   *   · `<BodyText text={text} />` without `rich` — the paragraphs become the text part's
   *     ("First." / "Second." / "Third.") and the toEqual below names the regression.
   *   · treat `blockquote` as transparent in the walker (drop the QuoteNode emission) — the
   *     quoted words render inline at mount and the fold assertions go red.
   */
  it("a letter renders natively — its own paragraphs, no frame, and the history folds", async () => {
    const el = await render({ text: "First.\n\nSecond.\n\nThird.", html: LETTER });
    expect(el.querySelector("iframe"), "a letter was still rendered in a frame").toBeNull();
    expect(el.querySelector(".mb-sheet")).toBeNull();
    // The words on screen are the LETTER's, not the text part's:
    const paras = [...el.querySelectorAll("p.msg-p")].map((p) => p.textContent);
    expect(paras, "the html's own paragraphs were not rendered")
      .toEqual(["Thanks — I'll see you Friday.", "— Sam"]);
    expect(el.textContent).not.toContain("Second.");
    // the fold, unchanged on this path: the trailing quote is NOT IN THE DOM until asked for…
    expect(el.querySelector(".msg-quote"), "the trailing history rendered while collapsed").toBeNull();
    expect(el.textContent).not.toContain("Are we still on?");
    const btn = el.querySelector<HTMLButtonElement>(".msg-history-toggle");
    expect(btn, "the trailing quoted history lost its fold on the rich path").not.toBeNull();
    // …and expanding renders it as a real quote container, attribution role intact.
    await act(async () => { btn!.click(); });
    const q = el.querySelector('.msg-quote[data-quote-depth="1"]');
    expect(q, "expanding did not render the quoted history").not.toBeNull();
    expect(q!.textContent).toContain("Are we still on?");
    expect(q!.querySelector(".msg-attribution")!.textContent).toBe("On Tuesday you wrote:");
  });

  /**
   * AND THE FALLBACK: a message classified prose whose TEXT PART IS EMPTY keeps its frame,
   * because the words exist only inside the html and rendering "" would be a blank message.
   *
   * Mutation: `const proseView = mail.prose;` — dropping the `text.trim()` term. Real failure
   * text:
   *   AssertionError: a prose message with no text part rendered nothing at all: expected null
   *   not to be null
   */
  it("an empty text part keeps the frame", async () => {
    const el = await render({ text: "   ", html: LETTER });
    expect(el.querySelector("iframe"), "a prose message with no text part rendered nothing at all")
      .not.toBeNull();
  });

  /**
   * A DESIGNED MESSAGE IS UNCHANGED. The regression half: this path must take mail OUT of the
   * frame only when it was never a design.
   */
  it("a designed message still gets its frame", async () => {
    const el = await render({ text: OWNER_BILLING_TEXT, html: OWNER_BILLING_HTML });
    expect(el.querySelector("iframe")).not.toBeNull();
  });

  /**
   * THE BAR SURVIVES THE FRAME. A prose message can still have named a beacon — that is exactly
   * why a beacon does not disqualify — and the bar is the only place the product says one was
   * refused. Rendering "just the text" would delete a privacy disclosure for the one class of
   * message where the disclosure is all there was to report.
   *
   * Mutation: `return <BodyText text={text} />` in place of the whole `proseView` branch. Real
   * failure text:
   *   AssertionError: the blocked-beacon notice was lost with the frame: expected null not to be
   *   null
   */
  it("a beacon is still reported on a message that has no frame", async () => {
    const el = await render({
      text: "Thanks.",
      html: `${LETTER}<img src="https://t.example/wf/open?u=1" width="1" height="1">`,
    });
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector(".mb-bar"), "the blocked-beacon notice was lost with the frame")
      .not.toBeNull();
    expect(el.querySelector(".mb-bar-text")!.textContent).toContain("tracking pixel");
  });

  /**
   * ── THE EMPTY BAR IS GONE, AND THE FLIP OUTLIVES IT ────────────────────────────────────
   *
   * A plain letter with nothing blocked used to raise a whole bar to hold one button — a strip
   * of chrome above an otherwise clean message. The bar now appears ONLY for a sentence
   * (`hasBlocked || canAdapt`); the frameless flip moved to its own quiet control after the body.
   * So this message shows NO bar and still offers the way to the sender's own layout.
   *
   * Mutation: `const showBar = hasBlocked || canAdapt || proseable` (the empty-bar condition this
   * slice removed). Real failure text:
   *   AssertionError: an empty bar was raised over a letter with nothing to say: expected
   *   <div class="mb-bar" …> to be null
   */
  it("a prose letter with nothing blocked shows no bar, and the flip is its own control", async () => {
    const el = await render({ text: "Thanks — see you Friday.", html: LETTER });
    expect(el.querySelector("iframe"), "the fixture stopped being a letter").toBeNull();
    expect(el.querySelector(".mb-bar"), "an empty bar was raised over a letter with nothing to say")
      .toBeNull();
    const flip = el.querySelector<HTMLButtonElement>(".mb-flip");
    expect(flip, "the frameless letter offered no way to the sender's own rendering").not.toBeNull();
    expect(flip!.textContent).toBe(COPY.design);
    // …and it is NOT inside a bar: the housing actually changed, it did not just re-appear.
    expect(el.querySelector(".mb-bar .mb-flip")).toBeNull();
  });
});

/**
 * ── THE DEFAULT MUST NOT BE UNDONE BY A SETTING ─────────────────────────────────────────────
 *
 * Found live, not in review. The frameless rendering was first made conditional on "the reader
 * has not consented to this message's remote pictures", so that "Show images" could not become a
 * button with no visible effect. On an account where remote images load BY DEFAULT that
 * condition is true from the first paint, and every message with a picture in it came back
 * framed — the flip had no effect for those readers at all.
 */
describe("the frameless default survives an account that loads images by default", () => {
  const WITH_PICTURE = `${LETTER}<img src="https://sender.example/photo.jpg" width="480">`;

  /**
   * Mutation: `const proseView = proseable && !showOriginal && !(remoteLoaded && remote.some((b) => !b.pixel));`
   * — the shape that shipped for twenty minutes. Real failure text:
   *   AssertionError: an account-wide image setting put a letter back in a frame: expected
   *   <iframe …> to be null
   */
  it("a letter with a loaded picture is still rendered natively", async () => {
    const el = await render({
      text: "Thanks — see you Friday.",
      html: WITH_PICTURE,
      remoteLoaded: true,
      imageProxy: (u: string) => `/api/img?u=${encodeURIComponent(u)}`,
    });
    expect(el.querySelector("iframe"), "an account-wide image setting put a letter back in a frame")
      .toBeNull();
    // The letter's own words, from the walked html — and still no <img>, loaded or not.
    expect(el.textContent).toContain("Thanks — I'll see you Friday.");
    expect(el.querySelector("img")).toBeNull();
  });

  /**
   * AND THE WAY BACK IS REAL. The reader gets the sender's own rendering on request — which is
   * what makes the paragraph above safe rather than merely opinionated.
   *
   * The flip is its own quiet control AFTER the body (`.mb-flip`), not a button in the bar —
   * so it survives on a letter that raises no bar at all. Mutation: drop the `proseable ?` flip
   * control after the body. Real failure text:
   *   AssertionError: frameless mail offers no route to the sender's own rendering: expected
   *   null not to be null
   */
  it("…and the reader can ask for the sender's own rendering, and get back", async () => {
    const el = await render({ text: "Thanks.", html: WITH_PICTURE });
    const btn = [...el.querySelectorAll<HTMLButtonElement>(".mb-flip")]
      .find((b) => b.textContent === COPY.design);
    expect(btn, "frameless mail offers no route to the sender's own rendering").not.toBeUndefined();
    expect(el.querySelector("iframe")).toBeNull();
    // `aria-pressed` is a LOCATED CONTRACT, not decoration: the browser journeys find this
    // control by class and read their bearings from this attribute (`intoSenderLayout`,
    // the UX suite's mail lab — labels are translated, so the class+state pair is the
    // only stable handle). The visual treatment may recede; this pair may not move.
    expect(btn!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => { btn!.click(); });
    expect(el.querySelector("iframe"), "\"Show original\" did not produce the frame").not.toBeNull();

    const back = [...el.querySelectorAll<HTMLButtonElement>(".mb-flip")]
      .find((b) => b.textContent === COPY.plain);
    expect(back, "there is no way back out of the frame").not.toBeUndefined();
    expect(back!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { back!.click(); });
    expect(el.querySelector("iframe")).toBeNull();
  });

  /**
   * "SHOW IMAGES" IS ABSENT ON THE FRAMELESS PATH, because that rendering draws none — a button
   * that consents to something and then shows nothing is worse than no button, and "Show
   * original" is the honest route. Mutation: drop `&& !proseView` from `canLoad`.
   */
  it("no Show-images button on a rendering that draws no images", async () => {
    const el = await render({
      text: "Thanks.",
      html: WITH_PICTURE,
      imageProxy: (u: string) => `/api/img?u=${encodeURIComponent(u)}`,
      onLoadRemote: () => {},
    });
    expect(el.querySelector("iframe")).toBeNull();
    const labels = [...el.querySelectorAll(".mb-bar-btn")].map((b) => b.textContent);
    expect(labels, "a consent button was offered over a rendering that shows no images")
      .not.toContain(COPY.show);
    // The DISCLOSURE stays: the message named a remote picture and the bar is where that is said.
    expect(el.querySelector(".mb-bar-text")!.textContent).toContain("remote image");
  });
});

/**
 * ── THE NATIVE RICH RENDERING — the letter's own structure, in the app's type ─────────────
 *
 * The fixture is chosen against the built-tested-unreachable failure: it must be a message
 * `isRigidLayout` classifies PROSE — a plain business letter that happens to carry a table —
 * and every guard goes through `MessageBody` end-to-end, because a fixture the classifier
 * sends to the frame tests a walker no message reaches. `width="100%"` is not a canvas
 * (`widthAttrPx` answers null for a percentage), which the first test pins.
 */
describe("native rich text — structure renders, every attribute is ours", () => {
  const TABLE_LETTER =
    `<p>Prices are below.</p>` +
    `<table width="100%" cellpadding="4">` +
    `<thead><tr><th>Item</th><th colspan="2">Cost</th></tr></thead>` +
    `<tbody><tr><td>Widget</td><td colspan="9999">12 CHF</td><td rowspan="0">—</td></tr></tbody>` +
    `</table>` +
    `<ul><li>First point</li><li>Second point<ul><li>Nested point</li></ul></li></ul>` +
    `<ol><li>Step one</li></ol>` +
    `<h2>Terms</h2><hr>` +
    `<p><b>Bold</b>, <em>emphasis</em>, <u>underline</u>, a line<br>break.</p>`;

  it("ANTI-VACUITY — the table letter really is the prose class", async () => {
    expect(await proseOf(TABLE_LETTER), "a 100% table was mistaken for a canvas").toBe(true);
  });

  /**
   * Mutations, each watched red:
   *   · `boundedSpan` returns the raw parsed int — the 9999 assertion names the DoS shape.
   *   · drop the `table` branch from the walker — `.msg-table` is null and the words vanish.
   */
  it("a table renders natively, spans parsed and bounded", async () => {
    const el = await render({ text: "fallback", html: TABLE_LETTER });
    expect(el.querySelector("iframe"), "the table letter went to the frame — nothing below tests anything")
      .toBeNull();
    const table = el.querySelector(".msg-table");
    expect(table, "the letter's table did not render natively").not.toBeNull();
    // Header cells keep their role; the sane colspan survives as a NUMBER this code parsed.
    const cost = table!.querySelector<HTMLTableCellElement>("th[colspan]");
    expect(cost).not.toBeNull();
    expect(cost!.colSpan).toBe(2);
    expect(cost!.textContent).toBe("Cost");
    // The 9999 is clamped, and the junk rowspan (0) is simply absent.
    const wide = [...table!.querySelectorAll<HTMLTableCellElement>("td[colspan]")]
      .find((c) => c.textContent === "12 CHF");
    expect(wide, "the clamped cell vanished").not.toBeUndefined();
    const { MAX_TABLE_SPAN } = await mod();
    expect(wide!.colSpan, "a sender's colspan reached the DOM unbounded").toBe(MAX_TABLE_SPAN);
    expect(table!.querySelector("[rowspan]")).toBeNull();
    // A wide table scrolls INSIDE the letter, not across the pane.
    expect(el.querySelector(".msg-table-wrap")).not.toBeNull();
  });

  it("lists, headings, rules and emphasis render as constructed elements", async () => {
    const el = await render({ text: "fallback", html: TABLE_LETTER });
    // ul/ol/li, with the nested list NESTED.
    const lists = el.querySelectorAll(".msg-list");
    expect(lists.length, "the lists did not render").toBeGreaterThanOrEqual(3);
    expect(el.querySelector("ul.msg-list li ul.msg-list li")!.textContent).toBe("Nested point");
    expect(el.querySelector("ol.msg-list li")!.textContent).toBe("Step one");
    // The heading at the APP's scale-cap class, the rule as our element.
    expect(el.querySelector("h2.msg-h")!.textContent).toBe("Terms");
    expect(el.querySelector("hr.msg-hr")).not.toBeNull();
    // `b` folds to `strong` — the sender's tag never survives, the meaning does.
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("strong")!.textContent).toBe("Bold");
    expect(el.querySelector("em")!.textContent).toBe("emphasis");
    expect(el.querySelector("u")!.textContent).toBe("underline");
    expect(el.querySelector("p.msg-p br"), "the sender's line break was lost").not.toBeNull();
  });

  /**
   * THE VIEWER'S TYPE IS THE POINT: no sender presentation attribute exists anywhere in the
   * native tree — not the table's `width`/`cellpadding`, not a `style`, not a `class`. The
   * sanitizer KEEPS all of these for the frame, so their absence here is the walker's doing
   * and this is the assertion that would go red if a rewrite started copying attributes.
   */
  it("no sender attribute survives into the native tree", async () => {
    const el = await render({ text: "fallback", html: TABLE_LETTER });
    expect(el.querySelector("[width]"), "a sender width reached the app document").toBeNull();
    expect(el.querySelector("[cellpadding]")).toBeNull();
    expect(el.querySelector("[style]")).toBeNull();
  });
});

describe("native links — one gate, the sender's label, the honest host", () => {
  /**
   * The anchor carries the app's own attributes and the sender's label. The href is
   * `anchorFor`'s — re-derived from a parsed URL — which `body-text.test.ts` already holds
   * against every scheme trick; what is new here is that the LABEL is sender-authored, and
   * the two tests after this one are what that costs.
   */
  it("an https anchor renders with the sender's label and the app's own attributes", async () => {
    const el = await render({
      text: "fallback",
      html: `<p>See <a href="https://shop.example/order/123?q=1">your order</a>.</p>`,
    });
    const a = el.querySelector<HTMLAnchorElement>("a.msg-link");
    expect(a, "a plain https link did not render as an anchor").not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://shop.example/order/123?q=1");
    expect(a!.textContent).toBe("your order");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a!.getAttribute("title")).toBe("Goes to shop.example");
    // An ordinary label names no host, so no disclosure is added — a warning on every link
    // is a warning on none (textDisagreesWithHref's own rule).
    expect(a!.querySelector(".msg-link-host")).toBeNull();
  });

  /**
   * THE ANTI-PHISHING DISCLOSURE, natively — the framed path's `data-ohmail-elsewhere`
   * marker, as a real element. Mutation: drop the `elsewhere` term from the walker's link
   * node (always false) — the host span disappears and this goes red.
   */
  it("a label that names another host gets the real one printed beside it", async () => {
    const el = await render({
      text: "fallback",
      html: `<p><a href="https://click.trk.example/r/9">bank.example/secure</a></p>`,
    });
    const a = el.querySelector<HTMLAnchorElement>("a.msg-link")!;
    expect(a.getAttribute("href")).toBe("https://click.trk.example/r/9");
    const host = a.querySelector(".msg-link-host");
    expect(host, "a disagreeing label rendered with no disclosure").not.toBeNull();
    expect(host!.textContent).toContain("click.trk.example");
  });

  /**
   * THE GATE IS `anchorFor` AND NOTHING ELSE. The sanitizer's `SAFE_HREF` admits `mailto:`
   * for the frame, so on this path the walker's gate is the ONLY thing between a `mailto:`
   * and a live anchor — which makes this the assertion that proves the gate is load-bearing.
   * Mutation: delete the `SAFE_PROTOCOLS` line in `anchorFor` — `mailto:` (and `cid:`)
   * become anchors and this goes red. (`javascript:` is exercised in the zero-network
   * describe below, end to end.)
   */
  it("mailto: is text, not a link — the rejected branch is the default branch", async () => {
    const el = await render({
      text: "fallback",
      html: `<p>Just <a href="mailto:x@example.com">write us</a>.</p>`,
    });
    expect(el.querySelector("a"), "a mailto: href became a live anchor natively").toBeNull();
    expect(el.textContent).toContain("write us");
  });

  /**
   * The disagreement check reads the label AS DRAWN: hidden words the walk skips must not
   * stand in for the host. The whole label names bank.example too, so reading `el.textContent`
   * no longer turns this red; the glue case below is what bites.
   */
  it("a hidden host in the label neither draws nor hides the real one", async () => {
    const el = await render({
      text: "fallback",
      html: `<p><a href="https://evil.example/login"><span style="display:none">evil.example </span>bank.example</a></p>`,
    });
    const a = el.querySelector<HTMLAnchorElement>("a.msg-link")!;
    expect(a.firstChild!.textContent, "the hidden half of the label was drawn").toBe("bank.example");
    expect(a.querySelector(".msg-link-host")?.textContent ?? "", "a decoy label hid the real host")
      .toContain("evil.example");
  });

  /** Hidden glue joins the decoy to the drawn host. Mutation: `textDisagreesWithHref(el.textContent …)`. */
  it("hidden glue in the label cannot make the decoy agree with the host", async () => {
    const el = await render({
      text: "fallback",
      html: `<p><a href="https://evil.example/login"><span style="display:none">evil.example/</span>bank.example</a></p>`,
    });
    expect(el.querySelector(".msg-link .msg-link-host")?.textContent ?? "", "hidden glue hid the real host")
      .toContain("evil.example");
  });

  /**
   * After "Show original" the frame says it too. Mutation: the frame's note reads only the whole
   * label's first host (the rule before this test) → red.
   */
  it("after Show original, the frame names the real host beside the decoy", async () => {
    const el = await render({
      text: "fallback",
      html: `<p><a href="https://evil.example/login"><span style="display:none">evil.example </span>bank.example</a></p>`,
    });
    const flip = [...el.querySelectorAll<HTMLButtonElement>(".mb-flip")].find((b) => b.textContent === COPY.design);
    await act(async () => { flip!.click(); });
    const doc = new DOMParser().parseFromString(el.querySelector("iframe")?.getAttribute("srcdoc") ?? "", "text/html");
    expect(doc.querySelector("a")?.hasAttribute("data-ohmail-elsewhere"), "the frame hid the real host").toBe(true);
  });

  /**
   * An override draws "bank.example" from "bankelpmaxe." and a variation selector splits a host
   * without a gap. The note is drawn isolated, left to right, so the override the first label
   * leaves open cannot reorder it. Mutations: no bidi rule → the first note; no strip of what
   * draws nothing → the second; the note a plain span → the isolation.
   */
  it("a reordered or invisibly split host gets the real one beside it, drawn isolated", async () => {
    const el = await render({
      text: "fallback",
      html: `<p>Sign in at <a href="https://evil.example/a">bank&#x202E;elpmaxe.</a> today.</p>` +
        `<p>Or at <a href="https://evil.example/b">bank&#xFE00;.example</a>.</p>`,
    });
    const notes = [...el.querySelectorAll(".msg-link .msg-link-host")];
    expect(notes.map((n) => n.textContent), "a disguised host hid the real one").toEqual([" (evil.example)", " (evil.example)"]);
    expect(notes.map((n) => `${n.localName} ${n.getAttribute("dir")}`)).toEqual(["bdi ltr", "bdi ltr"]);
  });

  /**
   * An override before the link draws its label backwards ("elpmaxe.knab-ym" as "my-bank.example")
   * and the label's own reading never sees it, so the link is drawn isolated from the text around
   * it, as the real sheet says. Mutation: the isolation dropped from `.msg-link` → red.
   */
  it("an override around a link cannot turn its label around", async () => {
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(resolve(process.cwd(), "packages/ui/src/composites/message.css"), "utf8");
    document.head.appendChild(sheet);
    try {
      const el = await render({
        text: "fallback",
        html: `<p>Sign in at &#x202E;<a href="https://evil.example/">elpmaxe.knab-ym</a>&#x202C; today.</p>`,
      });
      const a = el.querySelector(".msg-link");
      expect(a?.textContent).toBe("elpmaxe.knab-ym");
      expect(getComputedStyle(a!).unicodeBidi, "an override outside the label reaches into it").toBe("isolate");
    } finally {
      sheet.remove();
    }
  });

  /**
   * Links nest in prose too, where a removed element leaves one inside another. A link that holds
   * one is named outright and no label is read past a link inside it, so the links cost about
   * what the same letter nested through <b> costs. Mutation: read each link's whole label again
   * (the walk's `textOfInline`) → over the bound.
   */
  it("a link that holds another link names its host, and each label is read once", async () => {
    const { sanitizeMailHtml } = await mod();
    const nested = (open: string, close: string, levels = 250, words = 12_000): string =>
      `<p>${`${open}<object>`.repeat(levels)}${"e.ee ".repeat(words)}${`</object>${close}`.repeat(levels)}</p>`;
    sanitizeMailHtml(nested(`<a href="https://e.ee/x">`, "</a>", 2, 10));
    const timed = (html: string): [number, ReturnType<typeof sanitizeMailHtml>] => {
      const started = performance.now();
      const out = sanitizeMailHtml(html);
      return [performance.now() - started, out];
    };
    const [plain] = timed(nested("<b>", "</b>"));
    const [linked, { rich }] = timed(nested(`<a href="https://e.ee/x">`, "</a>"));
    const [again] = timed(nested(`<a href="https://e.ee/x">`, "</a>"));
    const marked: boolean[] = [];
    const visit = (nodes: readonly { kind: string; elsewhere?: boolean; children?: unknown }[]): void => {
      for (const n of nodes) {
        if (n.kind === "link") marked.push(n.elsewhere === true);
        if (Array.isArray(n.children)) visit(n.children);
      }
    };
    visit(rich ?? []);
    expect(marked).toEqual([...Array(249).fill(true), false]);
    expect(Math.min(linked, again)).toBeLessThan(1.75 * plain);
  });
});

/**
 * WHAT THE LETTER HIDES STAYS HIDDEN. A newsletter's preheader is `display:none` text plus
 * zero-width filler; the frame never draws it, so the prose walk must not either. Only the
 * element's own `display:none` hides it: `mso-hide:all` and `font-size:0` wrap content other
 * clients draw.
 */
describe("hidden preheaders and filler", () => {
  const lines = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(".msg-p, .msg-line")].map((p) => p.textContent ?? "");

  it("a hidden preheader with filler draws nothing above the letter", async () => {
    const el = await render({
      text: "Hello Ben,\n\nThe plan is in.",
      html: `<div style="display:none;font-size:1px;max-height:0;overflow:hidden;mso-hide:all">` +
        `Your weekly picks&#847;&zwnj;&nbsp;&shy;</div><p>Hello Ben,</p><p>The plan is in.</p>`,
    });
    expect(el.querySelector("iframe"), "the preheader letter must render as prose").toBeNull();
    expect(lines(el), "the hidden preheader drew a line").toEqual(["Hello Ben,", "The plan is in."]);
    expect(el.textContent).not.toContain("weekly picks");
    expect(el.textContent).not.toMatch(/[͏‌­]/);
  });

  it("a hidden span, list item, cell, row, picture and pre piece draw nothing", async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const el = await render({
      text: "fallback",
      cidImages: new Map([["seen@x", gif], ["hid@x", gif]]),
      html: `<p>Hello <span style="DISPLAY: none !important">secret </span>Ben</p>` +
        `<ul><li>One</li><li style="display:none">hidden item</li></ul>` +
        `<table width="100%"><tr><td>Cell</td><td style="display:none">hidden cell</td></tr>` +
        `<tr style="display:none"><td>hidden row</td></tr></table>` +
        `<p><img src="cid:seen@x" alt="seen"><img src="cid:hid@x" alt="hid" style="display:none"></p>` +
        `<pre>line one<span style="display:none"> hidden pre</span></pre>`,
    });
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.textContent).not.toMatch(/secret|hidden/);
    expect(el.querySelector("p.msg-p")!.textContent).toBe("Hello Ben");
    expect([...el.querySelectorAll(".msg-list li")].map((li) => li.textContent)).toEqual(["One"]);
    expect([...el.querySelectorAll(".msg-table td")].map((td) => td.textContent)).toEqual(["Cell"]);
    expect([...el.querySelectorAll("img.msg-img")].map((i) => i.getAttribute("alt"))).toEqual(["seen"]);
    expect(el.querySelector("pre.msg-pre")!.textContent).toBe("line one");
  });

  it("a visible run of filler alone draws no line", async () => {
    const el = await render({
      text: "fallback",
      html: `<p>Before.</p><div>&#847;&zwnj;&#847;&zwnj;&nbsp;&shy;</div><p>After.</p>`,
    });
    expect(lines(el), "a filler-only run drew an empty line").toEqual(["Before.", "After."]);
  });

  it("font-size:0 columns and mso-hide:all alone stay drawn", async () => {
    const el = await render({
      text: "fallback",
      html: `<div style="font-size:0"><div style="display:inline-block;font-size:14px">Left column</div>` +
        `<div style="display:inline-block;font-size:14px">Right column</div></div>` +
        `<div style="mso-hide:all">Not for Outlook</div>`,
    });
    expect(el.textContent).toContain("Left column");
    expect(el.textContent).toContain("Right column");
    expect(el.textContent).toContain("Not for Outlook");
  });
});

describe("the caps — breadth, and the fall back to the text part", () => {
  /**
   * THE NODE CAP, MAX_QUOTE_DEPTH's precedent applied to breadth: a walk that wants more than
   * MAX_RICH_NODES refuses ENTIRELY and the prose path renders the text part — the rendering
   * every prose message had before the walker existed. Refuse-whole rather than truncate,
   * because a silently truncated letter reads as a complete one.
   *
   * Mutation: drop the `b.left < 0` refusal in `buildRichNodes` — thousands of paragraphs
   * render and the count below names it.
   */
  it("past the node cap, the letter falls back to the text part", async () => {
    const big = `<p>w</p>`.repeat(3000);
    expect(await proseOf(big)).toBe(true);
    const { sanitizeMailHtml } = await mod();
    expect(sanitizeMailHtml(big).rich, "the walk did not refuse past MAX_RICH_NODES").toBeNull();

    const el = await render({ text: "the plain part", html: big });
    expect(el.querySelector("iframe"), "the cap sent the letter to the frame instead of the text part")
      .toBeNull();
    expect(el.textContent).toContain("the plain part");
    expect(el.querySelectorAll("p.msg-p"), "the capped walk still rendered its nodes").toHaveLength(1);
  });

  /** The DEPTH bound: pathological nesting refuses the build instead of blowing the stack. */
  it("pathological nesting falls back to the text part too", async () => {
    const deep = `${"<div>".repeat(400)}hello${"</div>".repeat(400)}`;
    const { sanitizeMailHtml } = await mod();
    expect(sanitizeMailHtml(deep).rich, "a 400-deep nest was walked rather than refused").toBeNull();
    const el = await render({ text: "the plain part", html: deep });
    expect(el.textContent).toContain("the plain part");
  });
});

/**
 * ── ZERO NETWORK, AND NOTHING HOSTILE SURVIVES — the native path's own hostile fixture ────
 *
 * The demo-zero-network idiom: every egress primitive a browser has is trapped for the
 * duration, and the assertion is that opening the message drives none of them. jsdom fires no
 * subresource loads itself, so the sharper half is the DOM one — the elements and attributes
 * that COULD fetch or execute must not exist at all.
 */
describe("zero network — img, @import, script, onclick, javascript: leave nothing behind", () => {
  const originals: Record<string, unknown> = {};
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    const count = () => { calls += 1; };
    originals.fetch = globalThis.fetch;
    globalThis.fetch = (async () => { count(); return new Response("{}"); }) as unknown as typeof fetch;
    originals.XMLHttpRequest = (globalThis as Record<string, unknown>).XMLHttpRequest;
    (globalThis as Record<string, unknown>).XMLHttpRequest = class {
      open(): void { count(); }
      send(): void { /* never reached in a passing run */ }
      setRequestHeader(): void { /* noop */ }
    };
    originals.WebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class { constructor() { count(); } close(): void {} };
    originals.EventSource = (globalThis as Record<string, unknown>).EventSource;
    (globalThis as Record<string, unknown>).EventSource = class { constructor() { count(); } close(): void {} };
  });
  afterEach(() => {
    globalThis.fetch = originals.fetch as typeof fetch;
    for (const key of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
      if (originals[key] === undefined) delete (globalThis as Record<string, unknown>)[key];
      else (globalThis as Record<string, unknown>)[key] = originals[key];
    }
  });

  it("every vector is absent from the DOM, and no egress primitive fires", async () => {
    const fixture =
      `<p>the words</p>` +
      `<img src="https://evil.example/wf/open?u=1">` +
      `<style>@import url("https://evil.example/e.css");.x{background:url(https://evil.example/b.png)}</style>` +
      `<script>fetch("https://evil.example/s")</script>` +
      `<p onclick="fetch('https://evil.example/c')">click me</p>` +
      `<a href="javascript:fetch('https://evil.example/j')">win</a>`;
    expect(await proseOf(fixture), "the fixture stopped classifying as prose").toBe(true);

    const el = await render({ text: "fallback", html: fixture });
    expect(el.querySelector("iframe")).toBeNull();
    // The walker really ran — the words render natively (a walker that emitted nothing would
    // make every absence below vacuous).
    expect(el.textContent).toContain("the words");
    expect(el.textContent).toContain("click me");
    expect(el.textContent).toContain("win");
    // Nothing that could fetch or execute exists: no element, no attribute, no scheme.
    expect(el.querySelector("img, style, script"), "a fetching element reached the app document")
      .toBeNull();
    expect(el.querySelector("[onclick]")).toBeNull();
    expect(el.querySelector("a"), "the javascript: href became an anchor").toBeNull();
    const markup = el.innerHTML;
    expect(markup, "a sender url survived into the app's markup").not.toContain("evil.example");
    expect(markup).not.toContain("@import");
    expect(markup).not.toContain("onclick");
    expect(markup).not.toContain("javascript:");
    // And the tab reached for the network exactly never.
    expect(calls, "opening the message performed a network operation").toBe(0);
  });
});

describe("the sink invariant, under fire", () => {
  /**
   * ══ THE GUARD THIS FILE EXISTS FOR, RESTATED FOR THE RICH PATH ═══════════════════════
   *
   * A message is CONSTRUCTED to classify as prose and to carry what would be catastrophic if
   * markup ever reached the app AS A STRING: a class an app-DOM sink would materialise, a
   * style, an id, a `<b>` — beside content the walker legitimately renders. The claim has two
   * halves and both are asserted: the WORDS and STRUCTURE render (text nodes, constructed
   * elements), and the sender's markup-as-markup — class, style, id, their tag spelling —
   * exists nowhere.
   *
   * The mutation is the one-line "optimisation" that motivates the whole file:
   *   `if (proseView) return <div dangerouslySetInnerHTML={{ __html: mail.html }} />;`
   * (with `html` added to the memo's result). Real failure text:
   *   AssertionError: a sender attribute was materialised in the app document: expected
   *   <p class="leak" …> to be null
   */
  it("sender markup reaches the app only as text nodes and constructed elements", async () => {
    const planted =
      `<p>Hello.</p><p class="leak" style="position:fixed" id="pwn">planted</p>` +
      `<a href="https://${HOSTILE_HOST}/x">click</a><b>bold</b>`;
    expect(await proseOf(planted), "the fixture stopped classifying as prose").toBe(true);

    const el = await render({ text: "Hello.", html: planted });
    expect(el.querySelector("iframe")).toBeNull();
    // The words render — as text nodes…
    expect(el.textContent).toContain("planted");
    expect(el.textContent).toContain("bold");
    // …the sender's attributes exist NOWHERE — not on an element, not in the serialized tree.
    expect(el.querySelector("p.leak"), "a sender attribute was materialised in the app document")
      .toBeNull();
    expect(el.querySelector("#pwn")).toBeNull();
    expect(el.innerHTML).not.toContain("leak");
    expect(el.innerHTML).not.toContain("position:fixed");
    // …the sender's <b> is OUR <strong>: the meaning survived, the markup did not. Either of the
    // walker's own paragraph classes will do — this `<b>` sits at the body's top level, which is a
    // LINE (`.msg-line`) rather than a paragraph, and which of the two it is belongs to
    // `message-body-line-spacing.test.ts`. What is asserted here is that the element around it was
    // constructed by us at all.
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("p.msg-p strong, p.msg-line strong")).not.toBeNull();
    // …and the anchor is the walker's: href re-derived through a parsed URL, our attributes.
    const a = el.querySelector<HTMLAnchorElement>("a.msg-link");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe(`https://${HOSTILE_HOST}/x`);
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  /**
   * ══ AND THE HOSTILE FIXTURE ITSELF TAKES THIS PATH — NATIVELY NOW ════════════════════
   *
   * The repo's worst input declares no canvas, so it is a letter, and the letter renders RICH:
   * its words and its one linkable anchor on screen, everything executable or fetching gone.
   * Note what the anchor is: `<a href="https://evil.example/login">https://www.bank.example/
   * secure</a>` — the click-tracker/phish shape — renders with the sender's label AND the real
   * host said beside it, which is strictly more honest than the text part's flattened URL ever
   * was. The `javascript:` anchor renders as its label, with no anchor.
   *
   * Mutation: `if (proseView) return <div dangerouslySetInnerHTML={{ __html: mail.html }} />;`
   * Real failure text:
   *   AssertionError: the hostile fixture's markup reached the app's own document: expected
   *   <style>…</style> to be null
   */
  it("the hostile fixture renders natively, and nothing executable or fetching survives", async () => {
    expect(await proseOf(HOSTILE_HTML), "the hostile fixture declares a canvas after all")
      .toBe(true);

    const el = await render({ text: "the words", html: HOSTILE_HTML });
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector("style"), "the hostile fixture's markup reached the app's own document")
      .toBeNull();
    // Element absences are asserted past the bar, whose own icon is an app `<svg>` — product
    // chrome, not mail. Everything the MAIL could have contributed is checked on the clone.
    const mail = el.cloneNode(true) as HTMLElement;
    mail.querySelector(".mb-bar")?.remove();
    expect(mail.querySelector("script, base, form, input, img, iframe, object, embed, svg, video"))
      .toBeNull();
    expect(el.innerHTML).not.toContain("@import");
    expect(el.innerHTML).not.toContain("onerror");
    expect(el.innerHTML).not.toContain("onload");
    expect(el.innerHTML).not.toContain("javascript:");
    expect(el.innerHTML).not.toContain("leak");
    // The words render natively…
    expect(el.textContent).toContain("Hello.");
    // …the javascript: link is its label, with no anchor around it…
    expect(el.textContent).toContain("Click me");
    // …and the ONE linkable anchor renders honestly: the sender's label, the real host beside
    // it, because the label (`www.bank.example`) names a host the link does not go to.
    const anchors = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("href")).toBe(`https://${HOSTILE_HOST}/login`);
    expect(anchors[0]!.querySelector(".msg-link-host")!.textContent).toContain(HOSTILE_HOST);
    // The privacy disclosure is still made: the fixture names remote images and a remote
    // sheet, and the bar is the only place the product says it refused them.
    expect(el.querySelector(".mb-bar"), "the blocked-asset disclosure was lost with the frame")
      .not.toBeNull();
  });

  /**
   * AND A DESIGNED MESSAGE STILL GOES THROUGH THE FRAME, so the boundary has both sides under
   * watch. The real marketing fixture declares a canvas; nothing about that path changed.
   */
  it("a designed message still takes the framed path", async () => {
    expect(await proseOf(OWNER_BILLING_HTML)).toBe(false);
    const el = await render({ text: OWNER_BILLING_TEXT, html: OWNER_BILLING_HTML });
    expect(el.querySelector("iframe")).not.toBeNull();
  });
});
