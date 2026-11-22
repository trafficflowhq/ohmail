import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "../../../../test/compare/render.mjs";
import { openAccountPage } from "../states/account-open.js";
import { accountStatesIn } from "../states/account-states.js";

/**
 * THE ACCOUNT GROUP IN GERMAN AT TEXT SIZE 1.5, IN A REAL BROWSER: every state of every pane, registered or not, drawn
 * on the account's states page in German with the web's text size at 1.5, at the phone's width and at the desktop's.
 * Held: no box of the pane runs its words out of it, and nothing scrolls sideways. The pane is measured, the frame and
 * the menu around it are not (they are their own tasks'). Run with the comparison, on the workstation, never the
 * farm (its machine lays words out by other measures):
 * `npx vitest run --config test/compare/vitest.compare.config.ts packages/app/test/compare/account-german.compare.ts`.
 */

const ROOMS = [
  { device: "phone", width: 390, height: 844 },
  { device: "desktop", width: 1440, height: 900 },
] as const;
const SIZE = 1.5;

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>> | null = null;
beforeAll(async () => {
  browser = await launch(chromium);
});
afterAll(async () => {
  await browser?.close();
});

/** A state's address on the page: by its name, in German at the text size, with its dialog's own words to walk. */
function queryOf(id: string, address: string | null, device: string): string {
  const words = new URLSearchParams(address ?? "");
  words.delete("device");
  words.set("pick", id);
  words.set("lang", "de");
  words.set("size", String(SIZE));
  words.set("device", device);
  return words.toString();
}

describe("the account group in German at text size 1.5", () => {
  for (const room of ROOMS) {
    it(`at ${room.width}: no box of a pane runs its words out of it, and nothing scrolls sideways`, async () => {
      const found: string[] = [];
      for (const state of accountStatesIn("de")) {
        const tab = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
        try {
          await openAccountPage(tab, queryOf(state.id, state.address, room.device));
          await tab.waitForSelector("[data-account-pane]", { state: "attached" });
          /* Its faces arrived, and two frames drawn since the last answer. */
          await tab.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          });
          const out = await tab.evaluate(() => {
            const pane = document.querySelector("[data-account-pane]");
            const over = [...(pane?.querySelectorAll<HTMLElement>("*") ?? [])]
              .filter((el) => {
                const cs = getComputedStyle(el);
                /* A box of its own that is drawn: inline words are held by the box around them. */
                if (["inline", "contents", "none"].includes(cs.display) || el.clientWidth <= 1) return false;
                return el.scrollWidth > el.clientWidth + 1;
              })
              .map(
                (el) =>
                  `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").slice(0, 40)}"`,
              );
            return {
              drawn: pane !== null,
              over,
              sideways: document.documentElement.scrollWidth - innerWidth,
            };
          });
          if (!out.drawn) found.push(`${state.id}: no pane drawn`);
          found.push(...out.over.map((said) => `${state.id}: ${said}`));
          if (out.sideways > 0) found.push(`${state.id}: scrolls sideways by ${out.sideways} px`);
        } finally {
          await tab.close();
        }
      }
      expect(found).toEqual([]);
    }, 600_000);
  }
});
