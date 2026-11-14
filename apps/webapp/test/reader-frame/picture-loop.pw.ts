/**
 * The reported shape (a report card with five pictures and a beacon, reflowed, the pane
 * scrolled to its end with about 200px to scroll) on the desktop's picture path. Once the
 * pictures are held the pane must be still: no fetch, no probe, no `scrollTop` write, no scroll
 * event over 120 frames. On the base tree every count rises (the fetch loop).
 *
 * Over the new reader: the letter's body as the reader mounts it, handed its pictures by the
 * reader's `letterPictures` over the real door, in the kit's reading column
 * (`harness-reader-1.tsx`; build it first: `node apps/webapp/test/reader-frame/build-harness-reader-1.mjs`).
 */
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { counters, frames, geometry, growBody, reset, scrollToEnd } from "./rig";

/** The built page of the new reader's body; `READER_FRAME_READER_OUT` points a run at a mutation arm's bundle. */
const HARNESS = resolve(
  __dirname, "../../../..", process.env.READER_FRAME_READER_OUT ?? "build/reader-frame-reader-1", "harness.html",
);

/** `rig.ts`'s open, over the new reader's page. */
async function openHarness(page: Page): Promise<void> {
  await page.goto(`file://${HARNESS}`);
  await page.waitForFunction(() => window.__rf !== undefined);
  await page.waitForFunction(() => {
    const f = document.querySelector<HTMLIFrameElement>("#pane iframe");
    return !!f && /px$/.test(f.style.height) && f.style.height !== "600px";
  });
}

const PICTURES = 5;

async function openAtEnd(page: Page): Promise<void> {
  await openHarness(page);
  await page.waitForFunction((n) => window.__rf.held === n, PICTURES, { timeout: 10_000 });
  /* The held pictures re-sanitize the letter: its frame stands on a blank page under the probe for a moment (seen in
     WebKit), so the shape is read once the frame holds the letter again and is sized, as the open waited for. */
  await page.waitForFunction(() => {
    const f = document.querySelector<HTMLIFrameElement>("#pane iframe");
    return !!f && f.contentDocument?.URL === "about:srcdoc" && /px$/.test(f.style.height) && f.style.height !== "600px";
  });
  const g = await geometry(page);
  expect(g.reflow, "the fixture must lay out as reflow, as the reported mail does").toBe(true);
  expect(g.scrollHeight - g.clientHeight, "the pane must overflow by about 200px").toBeGreaterThan(150);
  expect(g.scrollHeight - g.clientHeight).toBeLessThan(260);
  expect(g.chrome + 600, "under the probe the pane must stop overflowing, or nothing clamps")
    .toBeLessThan(g.clientHeight);
  await scrollToEnd(page);
  await page.waitForTimeout(1_000);
  const open = await counters(page);
  expect(open.probes, "control: the open was never measured, so a zero below reads nothing")
    .toBeGreaterThan(0);
  expect(open.scrollTopWrites, "control: the rig's own scroll was not counted").toBeGreaterThan(0);
}

test("five pictures are fetched once and the idle pane is still", async ({ page }) => {
  await openAtEnd(page);
  await reset(page);
  await frames(page, 120);
  const c = await counters(page);
  const total = Object.values(c.fetches).reduce((a, b) => a + b, 0);
  expect({
    urls: Object.keys(c.fetches).length, fetches: total,
    probes: c.probes, scrollTopWrites: c.scrollTopWrites, scrollEvents: c.scrollEvents,
  }, "a held picture was fetched again, or the idle pane was measured or moved").toEqual({
    urls: PICTURES, fetches: PICTURES, probes: 0, scrollTopWrites: 0, scrollEvents: 0,
  });
});

/**
 * a render that hands the same pictures in a NEW map changes nothing the frame reads, so it
 * probes nothing; the positive control is one genuine change (a 50px block in the mail), which
 * must probe exactly once and grow the frame by exactly 50px.
 */
test("same-content re-renders probe nothing; one real change probes once", async ({ page }) => {
  await openAtEnd(page);
  await reset(page);
  await page.evaluate(() => { window.__rf.copyMap = true; });
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate(() => window.__rf.rerender());
    await frames(page, 2);
  }
  await frames(page, 30);
  const idle = await counters(page);
  expect({ probes: idle.probes, scrollTopWrites: idle.scrollTopWrites },
    "a re-render with the same pictures probed the frame").toEqual({ probes: 0, scrollTopWrites: 0 });

  const before = (await geometry(page)).frameHeight;
  await growBody(page);
  await frames(page, 30);
  const grown = await counters(page);
  expect(grown.probes, "one genuine change must probe exactly once").toBe(1);
  expect((await geometry(page)).frameHeight - before, "the frame did not follow the mail").toBe(50);
});
