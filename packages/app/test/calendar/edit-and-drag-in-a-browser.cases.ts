import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { it } from "vitest";
import { openCalRestPage } from "../states/calrest-page-open.js";

type OpenCalendar = (view: string, width?: number, state?: string) => Promise<Page>;

export function calendarEditAndDragCases(browser: () => Browser) {
  const open: OpenCalendar = async (view, width = 1440, state = "") => {
    const page = await browser().newPage({
      viewport: { width, height: 900 },
      reducedMotion: new URLSearchParams(state).get("motion") === "reduce" ? "reduce" : "no-preference",
    });
    await openCalRestPage(page, `screen=${view}&viewport&record-times&${state}&motion=full`);
    return page;
  };
  dateCases(open);
  reducedMotionDateCases(open);
  monthDragCases(open);
  monthEdgeCases(open);
  timeDragCases(open);
}

function dateCases(calendar: OpenCalendar) {
  const panels = [
    ["month", 1440],
    ["week", 1440],
    ["month", 390],
  ] as const;
  const panelInputs = panels.flatMap(([view, width]) => [
    [view, width, "mouse"] as const,
    [view, width, "keyboard"] as const,
  ]);

  it.each(panelInputs)(
    "changes an existing event's day in %s at %s px by %s",
    async (view, width, input) => {
      const page = await calendar(view, width, "day=2026-11-12");
      try {
        await page.getByRole("button", { name: /Dentist/ }).click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Edit event" });
        const date = editor.getByRole("button", { name: "Event date" });
        if (input === "mouse") await date.click();
        else await date.press("Enter");
        const picker = page.getByRole("dialog", { name: "Event date" });
        const next = picker.getByRole("gridcell", { name: /Friday, November 13/ });

        // A clipped picker can be in the DOM and even claim focus. Its days must be clickable.
        await next.click({ trial: true, timeout: 2000 });
        if (input === "mouse") await next.click();
        else {
          await expect(picker.getByRole("gridcell", { selected: true })).toBeFocused();
          await page.keyboard.press("ArrowRight");
          await expect(next).toBeFocused();
          await page.keyboard.press("Enter");
        }
        await expect(date).toHaveAttribute("aria-haspopup", "dialog");
        await expect(date).toHaveText(/13/);
        await expect(date).toBeFocused();
        await expect(picker).toHaveCount(0);
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await expectWritten(page, "20261113T093000", "20261113T103000");
      } finally {
        await page.close();
      }
    },
    20_000,
  );

  it.each(panelInputs)(
    "chooses a day in the new event panel in %s at %s px by %s",
    async (view, width, input) => {
      const page = await calendar(view, width);
      try {
        await page.getByRole("button", { name: "New event", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "New event" });
        const date = editor.getByRole("button", { name: "Event date" });
        const picker = page.getByRole("dialog", { name: "Event date" });
        if (input === "mouse") {
          await date.click();
          await picker.getByRole("gridcell", { name: /Wednesday, November 11/ }).click();
        } else {
          await date.press("Space");
          await expect(picker.getByRole("gridcell", { selected: true })).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(picker).toHaveCount(0);
          await expect(date).toBeFocused();
          await date.press("Enter");
          await page.keyboard.press("ArrowRight");
          await page.keyboard.press("Enter");
        }
        await expect(date).toHaveText(/11/);
        await expect(date).toBeFocused();
      } finally {
        await page.close();
      }
    },
    20_000,
  );

  it("saves a phone event edit while the previous change offers Undo", async () => {
    const page = await calendar("month", 390, "day=2026-11-12&undo");
    try {
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      await page.getByRole("button", { name: /Dentist/ }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Edit event" });
      await editor.getByRole("textbox", { name: "Event title" }).fill("Dentist follow-up");
      await editor.getByRole("button", { name: "Save", exact: true }).click({ timeout: 2500 });
      await expect(page.locator("body")).toHaveAttribute("data-written-title", "Dentist follow-up");
    } finally {
      await page.close();
    }
  }, 20_000);

  it("says who sets the time on an invitation", async () => {
    const page = await calendar("week", 1440, "day=2026-11-20");
    try {
      await page.getByRole("button", { name: /Tech check, main hall/ }).click();
      const card = page.getByRole("dialog", { name: "Tech check, main hall" });
      await expect(card.getByText("The organizer sets the time")).toBeVisible();
      await expect(card.getByRole("button", { name: "Event date" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 20_000);
}

function reducedMotionDateCases(calendar: OpenCalendar) {
  it.each(["new", "existing"] as const)(
    "picks the previous day from the %s Week event panel with reduced motion",
    async (kind) => {
      const page = await calendar("week", 1440, "day=2026-11-12&motion=reduce");
      try {
        if (kind === "existing") {
          await page.getByRole("button", { name: /Dentist/ }).click();
          await page.getByRole("button", { name: "Edit", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "New event", exact: true }).click();
        }
        const editor = page.getByRole("dialog", { name: kind === "existing" ? "Edit event" : "New event" });
        const date = editor.getByRole("button", { name: "Event date" });
        await date.focus();
        await page.keyboard.press("Enter");
        const picker = page.getByRole("dialog", { name: "Event date" });
        await expect(picker.getByRole("gridcell", { selected: true })).toBeFocused();
        await page.keyboard.press("ArrowLeft");
        await expect(picker.getByRole("gridcell", { name: /Wednesday, November 11/ })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(date).toHaveText(/11/);
        await expect(date).toBeFocused();
        await expect(picker).toHaveCount(0);
      } finally {
        await page.close();
      }
    },
    20_000,
  );
}

const dragWhen = (page: Page) => page.locator(".cal-drag-when");
const ghost = (page: Page) => page.locator('[data-drag="copy"]');

async function expectWritten(page: Page, start: string, end: string) {
  const time = (value: string) =>
    value.includes("T") ? { kind: "zoned", value, zone: "Europe/Zurich" } : { kind: "date", value };
  await expect
    .poll(async () => {
      const value = await page.locator("body").getAttribute("data-written-times");
      return value && JSON.parse(value);
    })
    .toEqual({ start: time(start), end: time(end) });
}

async function lift(page: Page, handle: Locator) {
  const box = await handle.boundingBox();
  if (!box) throw new Error("The event has no drag handle");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  return box;
}

async function monthDrag(page: Page) {
  const event = page.getByRole("button", { name: /Dentist/ });
  const day = page.locator('[data-cal-drop-day="2026-11-13"][data-cal-drop-kind=month]');
  await lift(page, event);
  const box = (await day.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { event, day, box };
}

function monthDragCases(calendar: OpenCalendar) {
  it("draws the timed Month event at the target day and commits the time shown there", async () => {
    const page = await calendar("month");
    try {
      const { event, day, box } = await monthDrag(page);
      await expect(dragWhen(page)).toHaveText(/Fri 13 Nov.*09:30–10:30/);
      await expect(ghost(page)).toContainText("Dentist");
      await expect(event).toHaveCSS("opacity", "0.4");
      await expect(day).toHaveAttribute("data-cal-drop-active", "");
      const copy = (await ghost(page).boundingBox())!;
      expect(copy.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(copy.x + copy.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(copy.y).toBeGreaterThanOrEqual(box.y);
      expect(copy.y + copy.height).toBeLessThanOrEqual(box.y + box.height);
      await page.mouse.up();
      await expect(ghost(page)).toHaveCount(0);
      await expectWritten(page, "20261113T093000", "20261113T103000");
    } finally {
      await page.close();
    }
  }, 20_000);

  it("removes the Month ghost and restores the original when Escape cancels a drag", async () => {
    const page = await calendar("month");
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const { event, day } = await monthDrag(page);
      await expect(ghost(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(ghost(page)).toHaveCount(0);
      await expect(event).toHaveCSS("opacity", "1");
      await expect(dragWhen(page)).toHaveCount(0);
      await expect(day).not.toHaveAttribute("data-cal-drop-active", "");
      await page.mouse.up();
      await expect(page.locator("body")).not.toHaveAttribute("data-written-times");
      await expect(page.getByRole("dialog", { name: "Dentist" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 20_000);

  it("commits the displayed Month destination when release arrives without another move", async () => {
    const page = await calendar("month");
    try {
      const { box } = await monthDrag(page);
      const previousDay = (await page
        .locator('[data-cal-drop-day="2026-11-12"][data-cal-drop-kind=month]')
        .boundingBox())!;
      const session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        x: previousDay.x + previousDay.width / 2,
        y: box.y + box.height / 2,
      });
      await expectWritten(page, "20261113T093000", "20261113T103000");
    } finally {
      await page.close();
    }
  }, 15_000);
}

function monthEdgeCases(calendar: OpenCalendar) {
  it("shows the Month drop copy inside a partially visible date", async () => {
    const page = await calendar("month", 1440, "day=2026-11-12");
    try {
      await page.setViewportSize({ width: 1440, height: 660 });
      const event = page.getByRole("button", { name: /Dentist/ });
      await event.scrollIntoViewIfNeeded();
      const scroll = page.locator(".oh-mo-weeks");
      const targetDay = "2026-11-05";
      const target = scroll.locator(`[data-cal-drop-day="${targetDay}"]`);
      await scroll.evaluate((el, day) => {
        el.style.scrollSnapType = "none";
        const cell = el.querySelector(`[data-cal-drop-day="${day}"]`)!;
        el.scrollTop += cell.getBoundingClientRect().top - el.getBoundingClientRect().top + 52;
      }, targetDay);
      const viewport = (await scroll.boundingBox())!;
      const cell = (await target.boundingBox())!;
      const y = viewport.y + 44;
      expect(cell.y).toBeLessThan(viewport.y);
      expect(cell.y + cell.height).toBeGreaterThan(y);
      await lift(page, event);
      await page.mouse.move(cell.x + cell.width / 2, y);
      await expect(target).toHaveAttribute("data-cal-drop-active", "");
      await expect(dragWhen(page)).toHaveText(/Thu 5 Nov.*09:30–10:30/);
      await expect(ghost(page)).toContainText("Dentist");
      const copy = (await ghost(page).boundingBox())!;
      expect(copy.x).toBeGreaterThanOrEqual(cell.x - 1);
      expect(copy.x + copy.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
      expect(copy.y).toBeGreaterThanOrEqual(viewport.y - 1);
      expect(copy.y + copy.height).toBeLessThanOrEqual(cell.y + cell.height + 1);
      await page.mouse.up();
      await expectWritten(page, "20261105T093000", "20261105T103000");
    } finally {
      await page.close();
    }
  }, 20_000);
}

function timeDragCases(calendar: OpenCalendar) {
  it.each([
    ["week", true, "20261113T110000", "20261113T120000"],
    ["day", false, "20261112T110000", "20261112T120000"],
  ] as const)(
    "shows and commits a timed move in %s",
    async (view, later, start, end) => {
      const page = await calendar(view, 1440, "day=2026-11-12");
      try {
        const event = page.getByRole("button", { name: /Dentist, 09:30/ });
        const source = await lift(page, event);
        const day = page.getByRole("group", { name: later ? /Friday.*13/ : /Thursday.*12/ });
        const target = (await day.boundingBox())!;
        await page.mouse.move(target.x + target.width / 2, source.y + source.height / 2 + target.height / 16);
        await expect(ghost(page)).toContainText("Dentist");
        await expect(dragWhen(page)).toHaveText(/1[23] Nov.*11:00–12:00/);
        const copy = (await ghost(page).boundingBox())!;
        expect(copy.x).toBeGreaterThanOrEqual(target.x);
        expect(copy.x + copy.width).toBeLessThanOrEqual(target.x + target.width);
        expect(copy.y).toBeGreaterThan(source.y);
        await page.mouse.up();
        await expectWritten(page, start, end);
      } finally {
        await page.close();
      }
    },
    20_000,
  );

  it("shows the resized Day end and commits the time it showed", async () => {
    const page = await calendar("day", 1440, "day=2026-11-12");
    try {
      const event = page.getByRole("button", { name: /Dentist, 09:30/ });
      const grip = await lift(page, event.locator("[data-cal-resize=end]"));
      const day = (await page.getByRole("group", { name: /Thursday.*12/ }).boundingBox())!;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + day.height / 24);
      await expect(ghost(page)).toContainText("Dentist");
      await expect(dragWhen(page)).toHaveText(/Thu 12 Nov.*09:30–11:30/);
      await page.mouse.up();
      await expectWritten(page, "20261112T093000", "20261112T113000");
    } finally {
      await page.close();
    }
  }, 20_000);

  it("shows the day of a moved all-day chip and keeps it all day", async () => {
    const page = await calendar("week", 1440, "state=all");
    try {
      const event = page.getByRole("button", { name: /Glaze order/ });
      const source = await lift(page, event);
      const day = (await page.getByRole("group", { name: /Friday.*13/ }).boundingBox())!;
      await page.mouse.move(day.x + day.width / 2, source.y + source.height / 2);
      await expect(ghost(page)).toContainText("Glaze order");
      await expect(dragWhen(page)).toHaveText("Fri 13 Nov");
      await page.mouse.up();
      await expectWritten(page, "20261113", "20261114");
    } finally {
      await page.close();
    }
  }, 20_000);
}
