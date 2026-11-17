/**
 * A FINGER HELD DOWN, for a touch state's picture: the gesture is made as a phone's browser makes it (touch events
 * through the browser's own input, which the page reads as touch pointers), and never let go, so the state stands
 * while it is drawn. The reference's own figures: a row swiped 96 to either side, the list pulled 150 down.
 */
import type { Page } from "@playwright/test";

type Point = { x: number; y: number };

/** The touch states, by the reference's `show=`: what is pressed, and how far the finger goes. */
const HELD: Readonly<Record<string, { on: string; by: Point }>> = {
  "swipe-read": { on: '[role="option"][data-id="petra-talk"]', by: { x: 96, y: 0 } },
  "swipe-later": { on: '[role="option"][data-id="petra-talk"]', by: { x: -96, y: 0 } },
  pulldown: { on: '[role="option"]', by: { x: 0, y: 150 } },
};

/** A finger's path on the page, down at `from`, through `steps` moves to `from + by`, still down at the end. */
export async function holdFinger(page: Page, from: Point, by: Point, steps = 8): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let k = 1; k <= steps; k++) {
    const at = { x: from.x + (by.x * k) / steps, y: from.y + (by.y * k) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at] });
  }
}

/** Holds the finger of the touch state the address names, if it names one. */
export async function holdTouchState(page: Page, query: string): Promise<void> {
  const show = new URLSearchParams(query).get("show");
  const held = show ? HELD[show] : undefined;
  if (!held) return;
  const target = page.locator(held.on).first();
  await target.waitFor();
  const box = (await target.boundingBox())!;
  await holdFinger(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, held.by);
}
