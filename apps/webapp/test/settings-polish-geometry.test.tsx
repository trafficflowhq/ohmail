import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Button } from "@ohmail/ui/base";
import { TagLine } from "@ohmail/ui/mail";

/**
 * ═══ THE PHONE-WIDTH TAGS AND HELD-LETTER POLISH — MEASURED IN A REAL ENGINE ═══════════
 *
 * DESIGN-FOLD-WIDTHS §7 and the mechanical rows. jsdom lays
 * nothing out, so this drives headless Chromium over the shipped cascade and each surface's own
 * markup (the `@ohmail/ui` components where the surface uses them, the class structure of
 * `ScreenerView` where it does not) and reads `getBoundingClientRect` at the
 * widths the layout sweep found the defects at. The cases over the settings lines, the mailbox
 * rows and the composer's head left with today's views: the new parts' own cases hold what a
 * person meets there.
 *
 * Every describe ends in a RED CONTROL: the pre-fix rule re-applied as an override on the same page,
 * where the same measurement must read the defect. An arm that only admits proves nothing.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** The cascade these surfaces render under, in the order the app loads it. */
const TAG_SHEETS = [
  "packages/ui/src/base/Primitives/field.css",
  "packages/ui/src/base/Primitives/tag.css",
  "packages/ui/src/mail/Settings/tag-line.css",
];

const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/button.css",
  "packages/ui/src/primitives/switch.css",
  "packages/ui/src/primitives/seg.css",
  "packages/ui/src/primitives/chip.css",
  "packages/ui/src/primitives/text-field.css",
  "packages/ui/src/composites/settings.css",
  ...TAG_SHEETS,
  "apps/webapp/app/app.css",
  "packages/letter-body/src/message-body.css",
].map(css).join("\n");

type Face = "paper" | "ohmarchy";
/** The same sheets with the app's after the package's — the load order is not one the app pins. */
const SHEETS_APP_FIRST = [
  "packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/tokens/src/ohmarchy.css", "packages/ui/src/base.css",
  "apps/webapp/app/app.css", "packages/letter-body/src/message-body.css",
  "packages/ui/src/primitives/button.css", "packages/ui/src/primitives/switch.css", "packages/ui/src/primitives/seg.css",
  "packages/ui/src/primitives/chip.css", "packages/ui/src/primitives/text-field.css", "packages/ui/src/composites/settings.css",
  ...TAG_SHEETS,
].map(css).join("\n");

const page_ = (body: string, extra = "", face: Face = "paper", sheets = SHEETS): string =>
  `<!doctype html><html${face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}><head><meta charset="utf-8">
   <meta name="viewport" content="width=device-width,initial-scale=1">
   <style>${sheets}${extra}</style><style>body{margin:0}</style></head>
   <body class="mo-canvas">${body}</body></html>`;

/** A settings card of `width` px, the container every pane rule reads (`set-pane`). */
const pane = (width: number, inner: string, cls = ""): string =>
  `<div class="set-pane ${cls}" style="width:${width}px;box-sizing:border-box">${inner}</div>`;

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** Lay `html` out at a phone viewport (the 640px phone rules apply) and run `read` in the page. */
async function measure<T>(html: string, read: () => T, viewport = 390): Promise<T> {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 900 } });
  try {
    await page.setContent(html);
    return (await page.evaluate(read)) as T;
  } finally {
    await page.close();
  }
}

/* ══ the new-tag colour dot is a swatch, never a bar ════════════════════════════════════ */

const tagCreate = renderToStaticMarkup(
  <TagLine hue={120} field={{ label: "New tag", value: "" }} acts={<Button disabled>Add</Button>} />,
);
const readTag = (): { dot: Rect; input: Rect } => {
  const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as Rect;
  return { dot: r(".oh-tagdot"), input: r("input") };
};

describe("the tag colour swatch keeps 12-16px at every width", () => {
  for (const [order, sheets] of [["package first", SHEETS], ["app first", SHEETS_APP_FIRST]] as const) for (const width of [328, 360, 470, 640, 760]) {
    it(`${order}, a ${width}px card: the dot is a 12-16px square on the field's line`, async () => {
      const m = await measure(page_(pane(width, tagCreate), "", "paper", sheets), readTag);
      expect(m.dot.width, "the dot was stretched into a bar").toBeLessThanOrEqual(16);
      expect(m.dot.width).toBeGreaterThanOrEqual(12);
      expect(m.dot.height).toBeLessThanOrEqual(16);
      expect(m.dot.height).toBeGreaterThanOrEqual(12);
      const mid = (m.dot.top + m.dot.bottom) / 2;
      expect(mid, "the dot stands on a line of its own").toBeGreaterThan(m.input.top);
      expect(mid).toBeLessThan(m.input.bottom);
    });
  }
  it("RED CONTROL: without the fix the stacked row stretches the dot across the card", async () => {
    const pre = ".oh-tagline{display:flex;flex-direction:column;align-items:stretch}" +
      ".oh-tagline > .oh-tagline-hue{display:block;align-self:stretch;width:100%}.oh-tagline-hue > .oh-tagdot{display:block;width:100%;height:8px}";
    const m = await measure(page_(pane(328, tagCreate), pre), readTag);
    expect(m.dot.width).toBeGreaterThan(100);
  });
});

/* ══ "Original" is a header control in the held card's line ════════════════════════════ */

const heldLine = (width: number): string => `
<article class="hmail" style="width:${width}px"><div class="hm-line">
  <button type="button" class="hm-who"><b>ohmail</b><span class="addr">no-reply@fixture.invalid</span></button>
  <span class="t num">4 Aug</span>
  <span class="hm-adapt"><button type="button" class="mb-bar-btn" aria-pressed="false">Original</button></span>
</div><h2>Verify your email</h2><div class="hm-body"><div class="mb"><div class="mb-sheet" style="height:200px"></div></div></div></article>`;
const readHeld = (): { btn: Rect; t: Rect; sheet: Rect; line: Rect; pos: string } => {
  const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as Rect;
  return { btn: r(".mb-bar-btn"), t: r(".hm-line .t"), sheet: r(".mb-sheet"), line: r(".hm-line"), pos: getComputedStyle(document.querySelector(".mb-bar-btn")!).position };
};

describe("the dark toggle stands right of the date, in flow", () => {
  for (const width of [290, 340, 380, 600]) {
    it(`a ${width}px card: the toggle is in the header line, after the date, clear of the mail`, async () => {
      const m = await measure(page_(heldLine(width)), readHeld, 1100);
      expect(m.pos, "ADAPT_TOGGLE_FIXED").not.toBe("fixed");
      expect(m.btn.left, "the toggle is not right of the date").toBeGreaterThanOrEqual(m.t.right);
      expect(m.btn.bottom, "OVERLAP: the toggle sits on the mail").toBeLessThanOrEqual(m.sheet.top);
      expect(m.btn.right).toBeLessThanOrEqual(m.line.right + 0.5);
      const mid = (m.btn.top + m.btn.bottom) / 2;
      expect(mid, "the toggle left the date's line").toBeGreaterThan(m.t.top - 8);
      expect(mid).toBeLessThan(m.t.bottom + 8);
    });
  }
  /* LOOK UGLY 2: the pill hung 5-6px below the date's line — the slot was centred on a line the
     23px pill itself made taller. The pill's label sits on the date's line. */
  const readInk = (): { label: number; date: number } => {
    const mid = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
    return { label: mid(document.querySelector(".hm-adapt .mb-bar-btn")!), date: mid(document.querySelector(".hm-line .t")!) };
  };
  for (const face of ["paper", "ohmarchy"] as const) for (const width of [364, 600, 760]) {
    it(`${face}, a ${width}px card: the Original label sits on the date's line`, async () => {
      const m = await measure(page_(heldLine(width), "", face), readInk, 1100);
      expect(Math.abs(m.label - m.date), "the pill hangs off the date's line").toBeLessThanOrEqual(2);
    });
  }
  it("an empty slot takes no room", async () => {
    const html = page_(heldLine(340).replace(/<button type="button" class="mb-bar-btn"[^<]*<\/button>/, ""));
    const w = await measure(html, () => document.querySelector(".hm-adapt")!.getBoundingClientRect().width, 1100);
    expect(w).toBe(0);
  });
  it("RED CONTROL: a fixed toggle (the reported shape) overlaps the mail", async () => {
    const m = await measure(page_(heldLine(340), ".hm-adapt .mb-bar-btn{position:fixed;left:250px;top:120px}"), readHeld, 1100);
    expect(m.pos === "fixed" && m.btn.bottom > m.sheet.top).toBe(true);
  });
});
