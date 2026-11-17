/** @vitest-environment jsdom */
/**
 * THE WEEK AND THE DAY IN GERMAN AT TEXT SIZE 1.5, IN A REAL BROWSER. jsdom has no cascade, so each view is drawn here
 * over long German words (a title, a place, the lane's name, a free stretch, what lies out of sight, the line that
 * says what is not shown), and its markup is laid out in Chromium under every sheet the product page loads, with the
 * page zoomed as the text size zooms it, in a phone's, an unfolded phone's and a desktop's room. Every part keeps its
 * words inside its own box, and every box inside the sheet: nothing spills over its neighbour or out of the view.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DayView } from "../../src/day/index.js";
import { WeekView } from "../../src/week/index.js";
import { chromium, pageOf } from "../support/browser-page.js";
import { at, date, event, mountView, PLANS } from "../support/time-views.js";

const LONG = "Jahresabschlussbesprechung mit der Geschäftsleitung";
const PLACE = "Konferenzraum Oberwinterthur, zweiter Stock";
const events = [
  event(LONG, at(2026, 11, 18, 10), at(2026, 11, 18, 11, 30), { second: PLACE }),
  event("Kurz", at(2026, 11, 18, 10, 15), at(2026, 11, 18, 10, 45)),
  event("Frühschicht", at(2026, 11, 18, 5), at(2026, 11, 18, 5, 30)),
  event("Spätvorstellung", at(2026, 11, 18, 22), at(2026, 11, 18, 23)),
  event("Weihnachtsmarktvorbereitungen", date(2026, 11, 18), date(2026, 11, 20)),
  event(
    "Atlantis",
    {
      kind: "zoned",
      wall: { year: 2026, month: 11, day: 18, hour: 9, minute: 0, second: 0 },
      tzid: "Nowhere/Atlantis",
    },
    at(2026, 11, 18, 10),
  ),
];

type Room = "phone" | "fold" | "desktop";
const WIDTH: Record<Room, number> = { phone: 390, fold: 719, desktop: 1440 };

/** A view's markup in German, scrolled so that something lies above and below the hours in view. */
function drawn(view: "week" | "day", room: Room): { html: string; root: string } {
  const m = mountView(
    view === "week" ? WeekView : DayView,
    { anchor: date(2026, 11, 18), events, plan: PLANS[room] },
    "de",
  );
  const el = m.container.querySelector<HTMLElement>(".oh-tg-scroll")!;
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
  act(() => {
    el.scrollTop = 7 * 60;
    fireEvent.scroll(el);
  });
  const html = `<div class="tv-room">${m.container.innerHTML}</div>`;
  act(() => cleanup());
  return { html, root: `data-device="${room}" lang="de" style="zoom: 1.5; --ui-zoom: 1.5"` };
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

interface Spill {
  part: string;
  words: string;
  why: string;
}

/** Every part whose words leave its box, or whose box leaves the sheet. */
async function spillsIn(view: "week" | "day", room: Room): Promise<{ parts: number; spills: Spill[] }> {
  const page = await browser!.newPage({ viewport: { width: WIDTH[room], height: 900 } });
  try {
    await page.setContent(
      pageOf(
        drawn(view, room),
        ".tv-room { height: 100%; display: flex; flex-direction: column; padding: 8px; box-sizing: border-box }",
      ),
    );
    return await page.evaluate(() => {
      const sheet = document.querySelector(".oh-tg")!.getBoundingClientRect();
      const parts = [
        ...document.querySelectorAll<HTMLElement>(
          ".oh-ev, .oh-allday-label, .oh-tg-day, .oh-tg-free, .oh-oos, .oh-refusal, .oh-tg-hr",
        ),
      ];
      const spills: { part: string; words: string; why: string }[] = [];
      for (const el of parts) {
        const box = el.getBoundingClientRect();
        if (box.width === 0) continue;
        const words = (el.textContent ?? "").trim();
        if (box.left < sheet.left - 0.5 || box.right > sheet.right + 0.5)
          spills.push({ part: el.className, words, why: "out of the sheet" });
        /* Words wider than their part: cut by its own ellipsis is the kit's way (the part says so in its style). */
        const cut =
          getComputedStyle(el).textOverflow === "ellipsis" ||
          [...el.querySelectorAll("*")].some((c) => getComputedStyle(c).textOverflow === "ellipsis");
        if (el.scrollWidth > el.clientWidth + 1 && !cut && getComputedStyle(el).overflowX === "visible")
          spills.push({
            part: el.className,
            words,
            why: `words ${el.scrollWidth} px in ${el.clientWidth} px`,
          });
      }
      return { parts: parts.length, spills };
    });
  } finally {
    await page.close();
  }
}

describe("German at text size 1.5", () => {
  for (const view of ["week", "day"] as const) {
    for (const room of ["phone", "fold", "desktop"] as const) {
      it(`the ${view} in a ${room}'s room keeps every word inside its part`, async () => {
        const found = await spillsIn(view, room);
        expect(found.parts).toBeGreaterThan(10);
        expect(found.spills).toEqual([]);
      }, 60_000);
    }
  }
});
