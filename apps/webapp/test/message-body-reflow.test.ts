/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { HOSTILE_HTML, OWNER_BILLING_HTML } from "./fixtures/owner-billing-email";

/**
 * ── REFLOW, DON'T SHRINK ────────────────────────────────────────────────────────────────
 *
 * The reported experience: the message viewer *"often has horizontal scrolling, gets too small
 * in text size, doesn't feel like a native mail app"*. Both halves are one mechanism — the
 * frame was measured, found wider than its column, and the WHOLE document was scaled down,
 * text included, whatever made it wide. A plain business letter carrying one long tracked link
 * measured wide for that one link and was then rendered at 0.6 for its entire length.
 *
 * So mail is classified: SIMPLE mail is laid out AT the column and rendered at the app's own
 * reading size; RIGID mail — the fixed-width newsletter grid — keeps the scale-to-fit it has
 * always had, because reflowing a 600px grid does not produce a narrower newsletter, it
 * produces a collapsed pile of cells.
 *
 * Every assertion below was watched go RED against the named mutation and then restored.
 *
 * jsdom performs no layout, so what this file proves is what the DOCUMENT SAYS — the class,
 * the attribute that carries it, the arithmetic that reads it, and the type it declares. That
 * the frame then measures unscrolled in a real engine is a browser question and is answered by
 * driving one.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}
afterEach(async () => { await unmount(); });

/** Mount the real component on one message's html and hand back the srcdoc it built. */
/**
 * `text` is a PARAMETER because the reflow attribute lives on the frame's root, and a non-rigid
 * document with a text part no longer builds a frame at all — it renders as `BodyText` in the
 * app's own type (see `isRigidLayout`). Passing `""` is how a letter is still put through the
 * framed path, which is the path this file is about: the empty-text-part fallback is the one
 * remaining route a prose-classified document has to a frame, and it is a real one.
 */
async function mountedSrcdoc(html: string, text = "plain part"): Promise<string> {
  await unmount();
  const { MessageBody } = await mod();
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, { text, html })); });
  return host.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

/** The `<html …>` tag alone — the string `data-ohmail-reflow` also appears in the sheet. */
const rootTagOf = (doc: string): string => /<html[^>]*>/.exec(doc)?.[0] ?? "";

/** Ordinary mail: a letter, a signature table with no fixed canvas, one very long link. */
/* The `data:` logo is not decoration: without a picture this letter is the PROSE class and
   renders with no frame at all, so every `srcdoc` assertion below would be reading "". A
   reflowable message that still needs a frame is exactly a letter with an image in it. */
const PLAIN_LETTER = `<!DOCTYPE html><html><body>
<div style="font-family:Calibri,sans-serif;font-size:11pt">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="120" height="40">
<p>Guten Tag,</p>
<p>vielen Dank f&uuml;r Ihre Nachricht. Auch kann man Euch nicht erreichen, wenn die
Durchwahl besetzt ist &mdash; wir melden uns in jedem Fall zur&uuml;ck.</p>
<p><a href="https://tracking.example.invalid/ls/click?upn=u001.Vq7pZr2LkTw3nHqQyZ2fVbNqAq9zXcMw7RtLpKdGhY4vTnBxSeUiOlWmQaZrCdEfGhIjKlMnOpQrStUvWxYz">Ihre Kontaktanfrage ansehen</a></p>
<table cellpadding="0" cellspacing="0" border="0">
  <tr><td>Musterfirma GmbH</td></tr>
  <tr><td>Beispielstra&szlig;e 1</td></tr>
</table>
</div></body></html>`;

/** The shape every bulk sender uses: a 600px card, declared in the sender's own stylesheet. */
const NEWSLETTER_600 = `<!DOCTYPE html><html><head><style>
  .wrap { width:100%; background:#f5f4ef; }
  .card { width:600px; max-width:600px; background:#ffffff; }
  @media only screen and (max-width:620px) { .card { width:100% !important; } }
</style></head><body>
<table class="wrap" width="100%"><tr><td><table class="card"><tr><td>
<h1>This month at Example</h1><p>Three stories, one offer.</p>
</td></tr></table></td></tr></table></body></html>`;

/** The same grid declared the other way round — on the element, not in a stylesheet. */
const NEWSLETTER_ATTR =
  `<table width="700" cellpadding="0"><tr><td width="350">left</td><td width="350">right</td></tr></table>`;

const reflowOf = async (html: string): Promise<boolean> => (await mod()).sanitizeMailHtml(html).reflow;

// ══ 1. the classification ══════════════════════════════════════════════════════════════

describe("mail is classified before it is fitted", () => {
  it("an ordinary letter is SIMPLE — no fixed canvas, so nothing to lose by reflowing", async () => {
    // Mutation: make `isRigidLayout` return `true` unconditionally, or drop the `>= RIGID_MIN_PX`
    // comparison so any declared width counts — this goes red and the letter is scaled again.
    expect(await reflowOf(PLAIN_LETTER)).toBe(true);
    // …and a mail with no html structure at all is the same answer, which is the common case.
    expect(await reflowOf("<p>Kurze Nachricht.</p>")).toBe(true);
    // The hostile fixture declares no canvas either. It is here because "hostile" and "rigid"
    // are unrelated questions and a classifier that conflated them would be wrong twice.
    expect(await reflowOf(HOSTILE_HTML)).toBe(true);
  });

  it("a 600px newsletter card is RIGID even when the width is only in the STYLESHEET", async () => {
    // The acceptance fixture declares `.card{width:600px}` in a `<style>`, not on the element.
    // Mutation: stop passing `styleText` to `isRigidLayout` and read only element attributes —
    // this goes red, and every real newsletter is reflowed into a collapsed pile of cells.
    expect(await reflowOf(NEWSLETTER_600)).toBe(false);
    expect(await reflowOf(OWNER_BILLING_HTML)).toBe(false);
  });

  it("…and when it is only on the element", async () => {
    expect(await reflowOf(NEWSLETTER_ATTR)).toBe(false);
  });

  it("a `max-width` cap is NOT a fixed canvas — the responsive spelling stays SIMPLE", async () => {
    // `max-width:600px` already reflows below its own value. Treating it as rigid would put the
    // best-behaved mail in the class built for the worst-behaved.
    // Mutation: add `max-` to the optional prefix in `widestFixedWidthPx` and this goes red.
    expect(await reflowOf(`<div style="max-width:640px">hello</div>`)).toBe(true);
    expect(await reflowOf(`<style>.card{max-width:640px}</style><div class="card">hi</div>`)).toBe(true);
  });

  it("a media QUERY about the viewport is not a width declaration", async () => {
    // Every responsive newsletter contains `@media (max-width:620px)`, and a regexp that read it
    // as a declaration would call a 320px-wide mail rigid. Anchoring on `;`/`{` is what refuses
    // it — mutation: drop the anchor from `widestFixedWidthPx` and this goes red.
    expect(await reflowOf(`<style>@media (min-width:600px){p{color:#333}}</style><p>hi</p>`)).toBe(true);
  });

  it("an oversized IMAGE is not a canvas — a picture caps to the column and keeps its shape", async () => {
    // Mutation: add `img` to `CANVAS_TAGS`. A holiday photo pasted at 1600px would then put the
    // whole letter around it into the scaled class.
    expect(await reflowOf(`<p>Look:</p><img src="data:image/gif;base64,R0lGOD" width="1600">`)).toBe(true);
  });

  it("a two-column grid built at PERCENTAGES reflows, and is SIMPLE", async () => {
    // The class is about a declared fixed canvas, not about cell counts. A percentage grid
    // narrows with its container and needs no shrinking.
    expect(await reflowOf(`<table width="100%"><tr><td width="50%">a</td><td width="50%">b</td></tr></table>`))
      .toBe(true);
  });
});

// ══ 2. what the document then carries ══════════════════════════════════════════════════

describe("the class reaches the frame as one root attribute", () => {
  it("a reflowed document is stamped, and a rigid one is not", async () => {
    const { buildMailDocument } = await mod();
    // Mutation: drop the `reflow` option from the component's `buildMailDocument` call — the
    // rules below stay dormant in every document and nothing reflows.
    expect(buildMailDocument("<p>x</p>", { reflow: true })).toContain('<html data-ohmail-reflow="1">');
    expect(buildMailDocument("<p>x</p>", { reflow: false })).toContain("<html>");
    // Default OFF: a caller that does not classify gets exactly the document this function has
    // always built, so a forgotten field can never reflow a newsletter.
    expect(buildMailDocument("<p>x</p>")).toContain("<html>");
  });

  it("the reflow rules ship DORMANT in every document, like the dark ones", async () => {
    const { buildMailDocument } = await mod();
    const doc = buildMailDocument("<p>x</p>");
    expect(doc).toContain(":root[data-ohmail-reflow] *{max-width:100% !important}");
    expect(doc).toContain(":root[data-ohmail-reflow] table{table-layout:auto !important}");
    // A min-width beats the max-width cap, so it is released on every layout box, not the cells
    // alone: an account letter's outer `<table style="min-width:348px">` stood 42px past a 322px
    // phone column (measured in WebKit and Chromium; 0 with the table released).
    expect(doc).toContain(":root[data-ohmail-reflow] :is(table,td,th,div,center){min-width:0 !important}");
    expect(doc).toContain(":root[data-ohmail-reflow] img{height:auto !important}");
    // `pre` used to be `pre-wrap !important` here, and that re-flowed stack traces and — with
    // `anywhere` inherited — broke identifiers in half. The block now keeps its whitespace and
    // scrolls itself instead; message-body-tables.test.ts holds the matching table exemption.
    // `overflow-y:hidden` joined it because CSS coerces a computed `visible` to `auto` on the
    // OTHER axis as soon as one axis scrolls — so `overflow-x:auto` alone made this block a
    // vertical scroll container too, and on a platform whose horizontal scrollbar takes room from
    // the content box it then captures the reader's wheel instead of the reading stream.
    expect(doc).toContain(
      ":root[data-ohmail-reflow] pre{white-space:pre !important;overflow-x:auto !important;overflow-y:hidden !important;overscroll-behavior-x:contain;overflow-wrap:normal !important}",
    );
    // The half that fixes the letter nobody would call wide: one long link stops forcing the
    // document's min-content width past the column.
    expect(doc).toContain("overflow-wrap:anywhere");
  });

  it("THE COMPONENT CARRIES THE CLASS FROM THE SANITIZER TO THE FRAME", async () => {
    /**
     * THE WIRING, AND IT IS HERE BECAUSE THE OTHER GUARDS DID NOT CATCH IT. Measured: replacing
     * the component's `reflow` argument with `reflow: false` — the whole slice, disconnected —
     * left every assertion above GREEN, because they drive `sanitizeMailHtml` and
     * `buildMailDocument` directly and never the seam between them. That is the
     * "built, tested, unreachable" shape, so the mount is the guard.
     *
     * Mutation: pass `reflow: false` from `MessageBody`'s `buildMailDocument` call — red here
     * and nowhere else.
     */
    expect(rootTagOf(await mountedSrcdoc(PLAIN_LETTER, ""))).toContain('data-ohmail-reflow="1"');
    expect(rootTagOf(await mountedSrcdoc(NEWSLETTER_600))).not.toContain("data-ohmail-reflow");
    expect(rootTagOf(await mountedSrcdoc(OWNER_BILLING_HTML))).not.toContain("data-ohmail-reflow");
  });

  it("stamping reflow does not disturb the dark document's byte-for-byte equality", async () => {
    // `message-body.test.ts` pins that the dark build is the light build plus one attribute.
    // The reflow attribute is a property of the DOCUMENT and must not break that property.
    const { buildMailDocument } = await mod();
    const light = buildMailDocument("<p>x</p>", { reflow: true });
    const dark = buildMailDocument("<p>x</p>", { reflow: true, dark: true });
    expect(dark.replace(' data-ohmail-dark="1"', "")).toBe(light);
  });
});

// ══ 3. text size ═══════════════════════════════════════════════════════════════════════

describe("reflowed mail is set in the app's own reading size", () => {
  it("the frame's base type equals `.msg-body`, read out of the shipped stylesheet", async () => {
    /**
     * NOT A HAND-COPIED NUMBER. The frame is a separate document that inherits nothing, so the
     * size has to be duplicated — and a duplicated constant drifts silently. This parses the
     * real rule out of `packages/ui/src/composites/message.css` and holds the frame's constants
     * against it, so a change to either side is a red test rather than mail that is subtly the
     * wrong size.
     *
     * Mutation: change `NATIVE_FONT_SIZE` to "12px" (the shrink this slice exists to remove) —
     * red. Change `.msg-body`'s own font-size — also red, which is the point.
     */
    // `import.meta.url` is an http url under the jsdom environment, so the sheet is located
    // from the working directory instead — the root suite runs at the repo root, the app's own
    // runs in `apps/webapp`, and both are named rather than guessed.
    const REL = "packages/ui/src/composites/message.css";
    const sheet = [resolve(process.cwd(), REL), resolve(process.cwd(), "../..", REL)].find(existsSync);
    expect(sheet, `could not find ${REL} from ${process.cwd()}`).toBeTruthy();
    const css = readFileSync(sheet!, "utf8");
    const rule = /\.msg-body\{([^}]*)\}/.exec(css);
    expect(rule, ".msg-body must exist — it is the app's reading size").toBeTruthy();
    const size = /font-size\s*:\s*([^;]+)/.exec(rule![1]!)?.[1]?.trim();
    const line = /line-height\s*:\s*([^;]+)/.exec(rule![1]!)?.[1]?.trim();

    const { NATIVE_FONT_SIZE, NATIVE_LINE_HEIGHT, buildMailDocument } = await mod();
    expect(NATIVE_FONT_SIZE).toBe(size);
    expect(NATIVE_LINE_HEIGHT).toBe(line);
    // …and those constants are what the document actually declares.
    expect(buildMailDocument("<p>x</p>")).toContain(
      `:root[data-ohmail-reflow] body{font-size:${size};line-height:${line};`,
    );
  });

  /**
   * THE FRAME DECLARES `--type-up` ITSELF, and this is the assertion that stops a silent 16px
   * Times mail body shipping behind a green suite.
   *
   * The size above is a `calc()` reading a custom property. The frame is a SEPARATE DOCUMENT and
   * inherits nothing from the shell, so a `--type-up` it does not declare is not "0" — an
   * unresolvable custom property makes the whole declaration invalid at computed-value time, which
   * is `font-size: unset`. The identity case above would still pass: both strings would match,
   * and neither of them would render.
   */
  it("the frame declares the phone type slot, so its calc can resolve at all", async () => {
    const { buildMailDocument } = await mod();
    const doc = buildMailDocument("<p>x</p>");
    expect(doc, "the frame's font-size reads a property the frame never declares")
      .toContain(":root[data-ohmail-reflow]{--type-up:0px}");
    // And the step is decided on the FRAME's own width, because the frame is its own width class.
    expect(doc).toContain("@media (max-width:640px){:root[data-ohmail-reflow]{--type-up:1px}}");
  });
});

// ══ 3b. the prose scale is tightened, and the values are the guard ═════════════════════

describe("the prose scale is set tight, and no rule reintroduces the old air", () => {
  /**
   * The plain-letter rhythm was tightened (a 1.55 leading, 10px between paragraphs, a 4px step
   * between the lines of a quoted block) so a run of short paragraphs reads as one letter rather
   * than a stack of separated blocks. These are the shipped values in
   * `packages/ui/src/composites/message.css`, parsed here so a later loosening is a red test
   * rather than mail that quietly drifts back to the old spacing. jsdom applies no stylesheet, so
   * the file's own text is the fact — the same technique as the text-size guard above.
   *
   * Mutation: put `.msg-p{margin:0 0 14px}` back — red on the 10px assertion; likewise the 1.55
   * leading and the 4px quote step.
   */
  it("the body leading, the paragraph gap and the quoted-line step are the tightened numbers", () => {
    const REL = "packages/ui/src/composites/message.css";
    const sheet = [resolve(process.cwd(), REL), resolve(process.cwd(), "../..", REL)].find(existsSync);
    expect(sheet, `could not find ${REL} from ${process.cwd()}`).toBeTruthy();
    const css = readFileSync(sheet!, "utf8");

    const body = /\.msg-body\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(/line-height\s*:\s*1\.55\b/.test(body), ".msg-body line-height must be 1.55").toBe(true);

    // `.msg-p{` and not `.msg-p:last-child{` or `.msg-quote .msg-p,` — the literal `{` after the
    // class is what pins this to the standalone paragraph rule.
    const p = /\.msg-p\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(/margin\s*:\s*0\s+0\s+10px\b/.test(p), ".msg-p bottom margin must be 10px").toBe(true);

    const quote =
      /\.msg-quote\s+\.msg-p\s*,\s*\.msg-quote\s+\.msg-attribution\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(/margin-bottom\s*:\s*4px\b/.test(quote), "the quoted-line step must be 4px").toBe(true);
  });
});

// ══ 4. the arithmetic that reads the class ═════════════════════════════════════════════

describe("simple mail is never scaled, and rigid mail still is", () => {
  it("a reflowed mail is left at 1 however wide it measured", async () => {
    // THE GUARD FOR THE REPORTED DEFECT. Mutation: delete `if (reflow) return 1;` from
    // `fitScale` and a simple mail is shrunk to 0.6 again — the "gets too small in text size"
    // half of the complaint, restored.
    const { fitScale } = await mod();
    expect(fitScale(390, 700, true)).toBe(1);
    expect(fitScale(390, 4000, true)).toBe(1);
    // The frame is what reads the attribute back off the live root, so there is exactly one
    // place the two halves meet, and it is the one below.
  });

  it("a rigid newsletter still fits a wide column, floored at MIN_FIT_SCALE", async () => {
    const { fitScale, MIN_FIT_SCALE } = await mod();
    expect(fitScale(720, 900, false)).toBeCloseTo(0.8, 5);
    expect(fitScale(720, 1300, false)).toBe(MIN_FIT_SCALE);
    // Readability still wins over fit past the floor.
    expect(fitScale(720, 4000, false)).toBe(MIN_FIT_SCALE);
    // A mail that already fits is untouched in either class.
    expect(fitScale(621, 600, false)).toBe(1);
  });

  it("the column decides first: under 480px nothing is scaled, 480-699 floors at 0.75", async () => {
    // A collapsed News card at 390 is a ~320px column, where 0.6 of 15px is 8px text: the
    // newsletter as a thumbnail. Mutation: drop `columnPx < REFLOW_BELOW_PX` and the wide rigid
    // mail is scaled to 0.6 again; drop the mid floor and a 520px column scales to 0.65.
    const { fitScale, REFLOW_BELOW_PX, MID_FIT_SCALE, WIDE_COLUMN_PX } = await mod();
    expect([REFLOW_BELOW_PX, MID_FIT_SCALE, WIDE_COLUMN_PX]).toEqual([480, 0.75, 700]);
    expect(fitScale(390, 600, false)).toBe(1);
    expect(fitScale(479, 1200, false)).toBe(1);
    expect(fitScale(480, 600, false)).toBeCloseTo(0.8, 5);
    expect(fitScale(520, 800, false)).toBe(MID_FIT_SCALE);
    expect(fitScale(699, 1200, false)).toBe(MID_FIT_SCALE);
    expect(fitScale(700, 1200, false)).toBeCloseTo(0.6, 2);
  });

  it("`measure` reads the class off the document rather than from a closure", async () => {
    // The wiring, asserted as the property that makes it work: the attribute the classifier
    // produced is on the ROOT of the document `buildMailDocument` returns, which is the element
    // `measure` calls `hasAttribute` on. jsdom lays nothing out, so this is the reachable half;
    // the browser check drives the other.
    const { buildMailDocument } = await mod();
    const doc = new DOMParser().parseFromString(
      buildMailDocument("<p>x</p>", { reflow: true }),
      "text/html",
    );
    expect(doc.documentElement.hasAttribute("data-ohmail-reflow")).toBe(true);
  });
});
