/** @vitest-environment jsdom */
/**
 * THE ONE NOTICE, READABLE WHERE NO RAIL STANDS, IN A REAL BROWSER. On a phone's and a fold's width the notice stands
 * in a bar over the list. The frame is drawn here (jsdom has no cascade, so only its markup is taken), then laid out
 * in Chromium under every sheet the product page loads: today's, unlayered, and the new design's. The notice's box
 * lies inside the bar's box, and its title is on screen.
 */
import { execFileSync } from "node:child_process";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { useNotice } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { chromium, pageOf } from "../support/browser-page.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

function List(_: PaneProps) {
  useNotice({ kind: "firstSync", title: "First sync, 1 so far" });
  useNotice({ kind: "trial", title: "Trial ends Wed 18 Nov" });
  /* As long as a real list: the columns take the height their content asks. */
  return <div style={{ height: 3000 }}>the list</div>;
}
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading: List },
};

/** The frame's markup at a room, with the root's attributes it stamped. */
function drawn(room: "phone" | "fold" | "desktop"): { html: string; root: string } {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox },
    stages: {},
    window: fakeWindow(room),
  });
  render(
    <TextProvider
      locale="en"
      messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }}
      timeZone="Europe/Zurich"
    >
      <Frame host={host} />
    </TextProvider>,
  );
  const root = [...document.documentElement.attributes].map((a) => `${a.name}="${a.value}"`).join(" ");
  const html = document.body.innerHTML;
  act(() => cleanup());
  return { html, root };
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe("the notice where no rail stands", () => {
  for (const [room, width, height] of [
    ["phone", 390, 844],
    ["fold", 719, 781],
  ] as const) {
    it(`${room}, ${width} by ${height}: the notice lies inside its bar and its title is on screen`, async () => {
      const { html, root } = drawn(room);
      const page = await browser!.newPage({ viewport: { width, height } });
      await page.setContent(pageOf({ html, root }));
      const status = page.getByRole("status").first();
      const title = page.getByText("Trial ends Wed 18 Nov");
      const notice = await status.boundingBox();
      /* The bar is the notice's ancestor that stands on the frame or on the list's sheet. */
      const bar = await status.evaluate((el) => {
        let at: Element = el;
        while (at.parentElement && !at.parentElement.matches(".fr-frame, .oh-sheet")) at = at.parentElement;
        const box = at.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      });
      /* What a person sees at the middle of the title: the title, not what stands over it or a clip. */
      const seen = await title.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top !== null && (el === top || el.contains(top));
      });
      await page.close();
      expect(notice, "the notice has no box").not.toBeNull();
      expect(notice!.height, "the notice has no height").toBeGreaterThan(12);
      expect(bar.height + 0.5, "the bar is lower than its notice").toBeGreaterThanOrEqual(notice!.height);
      expect(notice!.y + 0.5).toBeGreaterThanOrEqual(bar.y);
      expect(seen, "the title is not on screen").toBe(true);
    });
  }
});

/**
 * NOTHING AT REST RUNS FOR EVER: an endless animation keeps the window drawing frames while nobody does anything (the
 * product's rule for every resting screen; 1.0's census read it off the sheets for its sync strip). Here the browser
 * says what runs: every animation on the page whose iterations never end, the notice's parts first among them, while
 * a first sync and a trial are said in the one slot.
 */
describe("the notice at rest", () => {
  const endless = () =>
    document.getAnimations().flatMap((a) => {
      const effect = a.effect as KeyframeEffect | null;
      if (!effect || effect.getComputedTiming().iterations !== Infinity) return [];
      const target = effect.target;
      const where = target?.closest('[role="status"], [role="alert"]') ? "notice" : "page";
      return [
        `${where}: ${(a as CSSAnimation).animationName ?? "script"} on ${target?.tagName ?? "nothing"}`,
      ];
    });

  for (const [room, width, height] of [
    ["phone", 390, 844],
    ["fold", 719, 781],
    ["desktop", 1440, 900],
  ] as const) {
    it(`${room}, ${width} by ${height}: draws no endless animation`, async () => {
      const page = await browser!.newPage({ viewport: { width, height } });
      await page.setContent(pageOf(drawn(room)));
      const running = await page.evaluate(endless);
      await page.close();
      expect(running).toEqual([]);
    });
  }

  it("sees one where it runs: an endless animation given to the notice is found", async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(
      pageOf(
        drawn("phone"),
        `@keyframes probe-pulse { to { opacity: 0.5 } }
        [role="status"] { animation: probe-pulse 1s linear infinite }`,
      ),
    );
    const running = await page.evaluate(endless);
    await page.close();
    expect(running.length).toBeGreaterThan(0);
    expect(running.every((r) => r.startsWith("notice: probe-pulse"))).toBe(true);
  });
});

describe("first sync at the notice slot", () => {
  let html: string;
  beforeAll(() => {
    // Bundle in Node because this suite also renders frame markup in jsdom.
    html = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { statesPage } from "./packages/app/test/states/build-states.mjs"; process.stdout.write(await statesPage());',
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  }, 120_000);

  it.each([
    ["phone", 390, 844],
    ["desktop", 1440, 900],
  ] as const)(
    "%s keeps the count aligned and removes the moving line when first sync finishes",
    async (device, width, height) => {
      const page = await browser!.newPage({ viewport: { width, height }, reducedMotion: "no-preference" });
      try {
        const url = `http://states.test/?show=firstsync&device=${device}&controls=1`;
        await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: html }));
        await page.goto(url);
        const notice = page.getByRole("status").filter({ hasText: "First sync" });
        const count = notice.getByText("3,846 so far", { exact: true });
        expect(await count.evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toBe("tabular-nums");
        const animations = () => notice.evaluate((el) => el.getAnimations({ subtree: true }).length);
        expect(await animations()).toBe(1);
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await animations()).toBe(0);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        expect(await animations()).toBe(1);
        const shown = await notice.elementHandle();
        await page.getByRole("button", { name: "Finish first sync" }).click();
        await notice.waitFor({ state: "detached" });
        expect(await shown!.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
});
