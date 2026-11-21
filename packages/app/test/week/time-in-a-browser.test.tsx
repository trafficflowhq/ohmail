/** @vitest-environment jsdom */
/**
 * THE WEEK AND THE DAY IN GERMAN AT TEXT SIZE 1.5, IN A REAL BROWSER. jsdom has no cascade, so each view is drawn here
 * over long German words (a title, a place, the lane's name, a free stretch, what lies out of sight, the line that
 * says what is not shown), and its markup is laid out in Chromium under every sheet the product page loads, with the
 * page zoomed as the text size zooms it, in a phone's, an unfolded phone's and a desktop's room. Every part keeps its
 * words inside its own box, and every box inside the sheet: nothing spills over its neighbour or out of the view.
 */
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
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

const calendarHtml = new Map<boolean, string>();

async function dayHours(page: Page, view: string, name = /Tuesday.*10/, legacy = true) {
  // Bundle in Node because the layout cases in this file draw their markup in jsdom.
  const html =
    calendarHtml.get(legacy) ??
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { statesPage } from "./packages/app/test/states/build-states.mjs"; process.stdout.write(await statesPage("packages/app/test/states/calrest-page.tsx", { legacy: ${legacy} }));`,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  calendarHtml.set(legacy, html);
  const url = `http://calrest.test/?screen=${view}`;
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(url);
  const day = page.getByRole("group", { name });
  const box = await day.boundingBox();
  if (!box) throw new Error("The selected day has no hours");
  return {
    day,
    x: box.x + box.width / 2,
    y: (minutes: number) => box.y + (box.height * minutes) / 1440,
    editor: page.getByRole("dialog", { name: "New event" }),
  };
}

describe.each(["day", "week"])("creating a timed event in the %s view", (view) => {
  it("draws the snapped range as the pointer moves, then opens it for editing on release", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const { day, x, y, editor } = await dayHours(page, view);

      await page.mouse.move(x, y(581));
      await page.mouse.down();
      await page.mouse.move(x, y(617));
      const first = day.getByText("09:30–10:15", { exact: true });
      await first.waitFor({ state: "visible", timeout: 2000 });
      expect(await editor.count()).toBe(0);

      await page.mouse.move(x, y(644));
      const last = day.getByText("09:30–10:45", { exact: true });
      await last.waitFor({ state: "visible", timeout: 2000 });
      expect(await first.count()).toBe(0);
      const range = await last.evaluate((label) => {
        const block = label.closest("button")!.getBoundingClientRect();
        return { top: block.top, bottom: block.bottom };
      });
      expect(Math.abs(range.top - y(570))).toBeLessThan(2);
      expect(Math.abs(range.bottom - y(645))).toBeLessThan(3);

      await page.mouse.up();
      await editor.waitFor();
      expect(await editor.getByLabel("Start time").inputValue()).toBe("09:30");
      expect(await editor.getByLabel("End time").inputValue()).toBe("10:45");
      expect(await last.count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("clears the range on Escape and leaves the editor closed after release", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const { day, x, y, editor } = await dayHours(page, view);

      await page.mouse.move(x, y(581));
      await page.mouse.down();
      await page.mouse.move(x, y(617));
      const draft = day.getByText("09:30–10:15", { exact: true });
      await draft.waitFor({ state: "visible", timeout: 2000 });

      await page.keyboard.press("Escape");
      await draft.waitFor({ state: "detached", timeout: 2000 });
      await page.mouse.move(x, y(644));
      await page.mouse.up();
      expect(await editor.count()).toBe(0);
      expect(await day.getByText("09:30–10:45", { exact: true }).count()).toBe(0);

      await page.mouse.move(x, y(581));
      await page.mouse.down();
      await page.keyboard.press("Escape");
      await page.mouse.move(x, y(617));
      await page.mouse.up();
      expect(await draft.count()).toBe(0);
      expect(await editor.count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});

it("keeps the pressed quarter-hour when dragging upward", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const { day, x, y, editor } = await dayHours(page, "week");
    await page.mouse.move(x, y(644));
    await page.mouse.down();
    await page.mouse.move(x, y(601));
    const draft = day.getByText("10:00–10:45", { exact: true });
    await draft.waitFor({ state: "visible", timeout: 2000 });
    await page.mouse.up();
    await editor.waitFor();
    expect(await editor.getByLabel("Start time").inputValue()).toBe("10:00");
    expect(await editor.getByLabel("End time").inputValue()).toBe("10:45");
  } finally {
    await page.close();
  }
}, 60_000);

it("leaves a touch swipe free to scroll", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  try {
    const { day, x, y, editor } = await dayHours(page, "day");
    const cdp = await page.context().newCDPSession(page);
    const touchPoint = { x: Math.round(x), y: Math.round(y(720)) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint] });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...touchPoint, y: touchPoint.y - 80 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await editor.count()).toBe(0);
    await expect.poll(async () => (await day.boundingBox())!.y).toBeLessThan(y(0));
  } finally {
    await page.close();
  }
}, 60_000);

it("keeps the one-hour slot on tap", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  try {
    const { x, y, editor } = await dayHours(page, "day");
    await page.touchscreen.tap(x, y(581));
    await editor.waitFor();
    expect(await editor.getByLabel("Start time").inputValue()).toBe("09:45");
    expect(await editor.getByLabel("End time").inputValue()).toBe("10:45");
  } finally {
    await page.close();
  }
}, 60_000);

function hoursViewport(day: ReturnType<Page["getByRole"]>) {
  return day.locator("xpath=ancestor::*[@data-today-scroll]");
}

it.each(["header", "all-day lane", "below the grid", "another column"])(
  "clears the draft and cancels an outside release (%s)",
  async (where) => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const { day, x, y, editor } = await dayHours(page, "week");
      const hours = (await hoursViewport(day).boundingBox())!;
      const header = (await page
        .getByRole("button", { name: "Tuesday, November 10, 2026", exact: true })
        .boundingBox())!;
      const allDay = (await page.locator("[data-cal-all-day-lane]").boundingBox())!;
      const exits = {
        header: { x, y: header.y + header.height / 2 },
        "all-day lane": { x, y: allDay.y + allDay.height / 2 },
        "below the grid": { x, y: hours.y + hours.height + 2 },
        "another column": { x: (await day.boundingBox())!.x - 2, y: y(617) },
      };
      const outside = exits[where as keyof typeof exits];

      await page.mouse.move(x, y(581));
      await page.mouse.down();
      await page.mouse.move(x, y(617));
      const draft = day.getByText("09:30–10:15", { exact: true });
      await draft.waitFor({ state: "visible", timeout: 2000 });
      await page.mouse.move(outside.x, outside.y);
      await page.mouse.up();
      await draft.waitFor({ state: "detached", timeout: 2000 });
      expect(await editor.count()).toBe(0);
    } finally {
      await page.close();
    }
  },
  60_000,
);

it("updates the held draft when the hours scroll and opens that range on the pressed date", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const { day, x, y, editor } = await dayHours(page, "week", /Wednesday.*11/);
    await page.mouse.move(x, y(581));
    await page.mouse.down();
    await page.mouse.move(x, y(617));
    await day.getByText("09:30–10:15", { exact: true }).waitFor({ state: "visible", timeout: 2000 });

    await hoursViewport(day).evaluate(
      (hours, delta) => {
        hours.scrollTop += delta;
      },
      y(60) - y(0),
    );
    const afterScroll = day.getByText("09:30–11:15", { exact: true });
    await afterScroll.waitFor({ state: "visible", timeout: 2000 });
    await page.mouse.up();

    await editor.waitFor();
    expect(await editor.getByLabel("Start time").inputValue()).toBe("09:30");
    expect(await editor.getByLabel("End time").inputValue()).toBe("11:15");
    expect(await editor.getByRole("button", { name: "Event date" }).textContent()).toContain("11");
  } finally {
    await page.close();
  }
}, 60_000);

it.each(["top", "bottom"])(
  "scrolls to further hours while dragging at the %s edge",
  async (edge) => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const { day, x, y, editor } = await dayHours(page, "week");
      const hours = hoursViewport(day);
      const box = (await hours.boundingBox())!;
      const scrollTop = () => hours.evaluate((el) => el.scrollTop);
      const before = await scrollTop();
      const direction = edge === "top" ? -1 : 1;
      await page.mouse.move(x, y(720));
      await page.mouse.down();
      await page.mouse.move(x, edge === "top" ? box.y + 12 : box.y + box.height - 12);
      await expect
        .poll(async () => ((await scrollTop()) - before) * direction, { timeout: 2000 })
        .toBeGreaterThan(20);
      expect(await editor.count()).toBe(0);
      await page.keyboard.press("Escape");
      const stopped = await scrollTop();
      await page.mouse.up();
      const nextFrame = await hours.evaluate(
        (el) =>
          new Promise<number>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.scrollTop)));
          }),
      );
      expect(nextFrame).toBe(stopped);
      expect(await editor.count()).toBe(0);
    } finally {
      await page.close();
    }
  },
  60_000,
);

it("uses the editor's midnight time in a live draft ending at the next day", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const { day, x, editor } = await dayHours(page, "day");
    await hoursViewport(day).evaluate((hours) => {
      hours.scrollTop = hours.scrollHeight;
    });
    const box = (await day.boundingBox())!;
    const y = (minutes: number) => box.y + (box.height * minutes) / 1440;
    await page.mouse.move(x, y(1381));
    await page.mouse.down();
    await page.mouse.move(x, y(1438));
    await day.getByText("23:00–00:00", { exact: true }).waitFor({ state: "visible", timeout: 2000 });

    await page.mouse.up();
    await editor.waitFor();
    expect(await editor.getByLabel("Start time").inputValue()).toBe("23:00");
    expect(await editor.getByLabel("End time").inputValue()).toBe("00:00");
    expect(await editor.getByRole("button", { name: "next day" }).isVisible()).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);

describe("calendar arrival motion", () => {
  it("fades the connector as it opens along the event's edge", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await dayHours(page, "week", undefined, false);
      await page.evaluate(() => document.documentElement.removeAttribute("data-rm"));
      await page.getByRole("button", { name: /Dentist.*09:30/ }).click();
      const frame = await page.locator(".oh-bridge").evaluate((element) => {
        const effect = element.getAnimations().find((animation) => animation instanceof CSSAnimation)
          ?.effect as KeyframeEffect | undefined;
        return effect?.getKeyframes().at(0);
      });
      expect(frame?.transform).toMatch(/^scale\((1, 0|0, 1)\)$/);
      expect(frame?.opacity).toBe("0");
    } finally {
      await page.close();
    }
  });

  it("does not replay the draft chip arrival after a drag or a date change", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const { x, y, editor } = await dayHours(page, "week");
      await page.evaluate(() => {
        document.documentElement.removeAttribute("data-rm");
        document.body.dataset.draftArrivals = "0";
        document.addEventListener("animationstart", (event) => {
          if (event.animationName === "oh-ev-draft-in") {
            document.body.dataset.draftArrivals = String(Number(document.body.dataset.draftArrivals) + 1);
          }
        });
      });
      await page.mouse.click(x, y(812));
      await editor.getByRole("switch", { name: "All day" }).click();
      const chip = page.getByRole("button", { name: "New event, all day" });
      await chip.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      const start = (await chip.boundingBox())!;
      const next = (await page.getByRole("button", { name: /Wednesday, November 11/ }).boundingBox())!;
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(next.x + next.width / 2, start.y + start.height / 2, { steps: 8 });
      await page.mouse.up();
      await editor.getByRole("button", { name: "Event date" }).getByText(/11/).waitFor();
      await expectDraftStill(chip);
      await editor.getByRole("button", { name: "Event date" }).click();
      await page
        .getByRole("dialog", { name: "Event date" })
        .getByRole("gridcell", { name: /Thursday.*November.*12/ })
        .click();
      await editor.getByRole("button", { name: "Event date" }).getByText(/12/).waitFor();
      await expectDraftStill(chip);
      expect(await page.locator("body").getAttribute("data-draft-arrivals")).toBe("1");
    } finally {
      await page.close();
    }
  }, 20_000);

  it.each(["no-preference", "reduce"] as const)(
    "opens the event card with the %s motion preference",
    async (reducedMotion) => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
      try {
        await dayHours(page, "week");
        if (reducedMotion === "no-preference") {
          await page.evaluate(() => document.documentElement.removeAttribute("data-rm"));
        }
        await page.getByRole("button", { name: /Dentist.*09:30/ }).click();
        const card = page.getByRole("dialog", { name: "Dentist" });
        const arrival = await card.evaluate((element) => {
          const effect = element.getAnimations().find((animation) => animation instanceof CSSAnimation)
            ?.effect as KeyframeEffect | undefined;
          return (
            effect && {
              duration: effect.getTiming().duration,
              transform: effect.getKeyframes().at(0)?.transform,
              opacity: effect.getKeyframes().at(0)?.opacity,
            }
          );
        });
        expect(arrival).toEqual(
          reducedMotion === "reduce"
            ? { duration: 150, transform: undefined, opacity: "0" }
            : { duration: 160, transform: "scale(0.9)", opacity: "0" },
        );
      } finally {
        await page.close();
      }
    },
  );

  it.each(["no-preference", "reduce"] as const)(
    "animates the new draft chip with the %s motion preference",
    async (reducedMotion) => {
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
      try {
        const { day, x, y } = await dayHours(page, "week");
        if (reducedMotion === "no-preference") {
          await page.evaluate(() => document.documentElement.removeAttribute("data-rm"));
        }
        await page.mouse.click(x, y(812));
        const draft = day.getByRole("button", { name: /New event, 13:30/ });
        const arrival = await draft.evaluate((element) => {
          const effect = element.getAnimations().find((animation) => animation instanceof CSSAnimation)
            ?.effect as KeyframeEffect | undefined;
          return (
            effect && {
              duration: effect.getTiming().duration,
              transform: effect.getKeyframes().at(0)?.transform,
              opacity: effect.getKeyframes().at(0)?.opacity,
            }
          );
        });
        expect(arrival).toEqual(
          reducedMotion === "reduce"
            ? { duration: 150, transform: "none", opacity: "0" }
            : { duration: 160, transform: "scale(0.96) translateY(4px)", opacity: "0" },
        );
      } finally {
        await page.close();
      }
    },
  );
});

async function expectDraftStill(chip: ReturnType<Page["getByRole"]>) {
  const arrival = await chip.evaluate((element) =>
    element
      .getAnimations()
      .some(
        (animation) =>
          animation instanceof CSSAnimation &&
          animation.animationName === "oh-ev-draft-in" &&
          animation.playState === "running",
      ),
  );
  expect(arrival).toBe(false);
}
