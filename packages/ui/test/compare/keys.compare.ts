import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { pageOf, type Face } from "./harness.js";
import { chipKeys, chipNames } from "./subjects/keys.js";

/**
 * The keys on a chip, with real keys: every calendar chip in every state, shut and open, is reached
 * with Tab and must wear the focus ring (solid, 2 px, 2 px out, in the focus colour), also with the
 * pointer over it. A picture cannot hold this, as the ring stands outside the chip's box; a forced
 * pseudo-state is not the keys. It always runs, whatever `KIT_ENTRY` or `KIT_ONLY` say.
 */

interface Ring {
  name: string | null;
  style: string;
  width: string;
  offset: string;
  color: string;
  focus: string;
}

/** The ring of what has the keys, and the focus colour as the page resolves it: run inside the page. */
function ringOfFocused(): Ring {
  const el = document.activeElement as HTMLElement;
  const probe = document.createElement("i");
  probe.style.color = "var(--focus)";
  el.parentElement!.append(probe);
  const focus = getComputedStyle(probe).color;
  probe.remove();
  const s = getComputedStyle(el);
  return {
    name: el.getAttribute("aria-label"),
    style: s.outlineStyle,
    width: s.outlineWidth,
    offset: s.outlineOffset,
    color: s.outlineColor,
    focus,
  };
}

const faultOf = (want: string, how: string, r: Ring): string | null =>
  r.name !== want
    ? `${want} (${how}): the keys are on ${r.name ?? "nothing named"}`
    : r.style !== "solid" || r.width !== "2px" || r.offset !== "2px" || r.color !== r.focus
      ? `${want} (${how}): ${r.style} ${r.width} out ${r.offset} in ${r.color}, not solid 2px out 2px in ${r.focus}`
      : null;

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>> | null = null;
beforeAll(async () => {
  browser = await launch(chromium);
});
afterAll(async () => {
  await browser?.close();
});

describe("a calendar chip with the keys on it wears the focus ring", () => {
  it("names every chip once", () => {
    expect(chipNames).toHaveLength(36);
    expect(new Set(chipNames).size).toBe(36);
  });

  it.each(["paper", "ohmarchy"] as Face[])(
    "in %s, with the keys and with the pointer over it",
    async (face) => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.setContent(
          await pageOf("calendar", chipKeys, { face, scheme: "light", device: "desktop" }),
        );
        const faults: string[] = [];
        for (const name of chipNames) {
          await page.keyboard.press("Tab");
          const keys = await page.evaluate(ringOfFocused);
          faults.push(faultOf(name, "keys", keys) ?? "");
          if (keys.name !== name) break;
          await page.locator(":focus").hover();
          faults.push(faultOf(name, "keys and pointer", await page.evaluate(ringOfFocused)) ?? "");
        }
        expect(faults.filter(Boolean)).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
});
