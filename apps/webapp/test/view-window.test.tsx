/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX } from "@ohmail/app-logic/lists/list-window";
import { chromium } from "../../../packages/app/test/support/browser-page.js";
import { fakeMail } from "../../../packages/app/test/reader/support/fake-mail";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { mountSeat } from "./_ohbox-1-seat";
import { stubDom } from "./_draft-shell.js";

const ISO = "2026-08-04T09:00:00.000Z";
const N = 5000;
const DEEP = 238;
const SPAN = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1;
const ROWS_AT_TOP = SPAN + 8;
const ROWS_MOUNTED = SPAN + 16;
const streams = [
  ["News", "reads", issue],
  ["Receipts", "receipts", receipt],
] as const;

function windowAt(scroller: HTMLElement) {
  const rows = () => within(scroller).getAllByRole("option");
  return {
    scroller,
    rows,
    rowIndices: () => rows().map((node) => Number(node.dataset.id!.slice(1))),
    pads: () => [...scroller.querySelectorAll<HTMLElement>("div[aria-hidden]")]
      .filter(({ style }) => style.height !== "" && style.height !== "0px"),
  };
}

async function scrollTo(scroller: HTMLElement, px: number): Promise<void> {
  await act(async () => {
    scroller.scrollTop = px;
    fireEvent.scroll(scroller);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function ohbox(count: number) {
  const half = Math.floor(count / 2);
  const letters = Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.parse(ISO) - i * 1000).toISOString();
    const unread = i < half;
    return {
      id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@example.invalid` },
      to: [], cc: [], date, folder: "INBOX", snippet: `snippet of message ${i}`,
      unread, lastReadAt: unread ? null : date, hasAttachments: false, attachmentCount: 0,
      sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
    } as unknown as EngineMessage;
  });
  const { engine } = fakeMail(letters);
  const { container } = mountSeat(engine, { demo: true });
  await act(async () => {});
  return windowAt(container.querySelector<HTMLElement>(".ob-scroll")!);
}

function stocked(i: number, make: typeof issue, unread = false) {
  const date = new Date(Date.parse(ISO) - i * 1000).toISOString();
  return make(`m${i}`, 1, { date, arrivedAt: date, unread, lastReadAt: unread ? null : date });
}

async function stream(name: string, route: string, make: typeof issue, count: number) {
  mountStreamFrame({ at: `#/${route}`, letters: Array.from({ length: count }, (_, i) => stocked(i, make)) });
  await act(async () => {});
  const list = screen.getByRole("region", { name });
  return windowAt(list.querySelector<HTMLElement>(".pl-scroll")!);
}

describe("Ohbox, Reads and Receipts render a windowed list, not a mailbox", () => {
  beforeEach(() => stubDom());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const [name, render] of [
    ["Ohbox", ohbox],
    ...streams.map(([name, route, make]) => [name, (count: number) => stream(name, route, make, count)] as const),
  ] as const) {
    it(`${name}: mounts a viewport's worth of list rows at ${N}, not ${N}`, async () => {
      const m = await render(N);
      const idx = m.rowIndices();
      expect(idx.length).toBe(name === "Ohbox" ? ROWS_AT_TOP - 1 : ROWS_AT_TOP);
      expect(idx[0]).toBe(0);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    });

    it(`${name}: scrolling mounts rows under the thumb and unmounts those far above`, async () => {
      const m = await render(N);
      await scrollTo(m.scroller, 300 * ESTIMATED_ROW_PX);
      const idx = m.rowIndices();
      expect(idx).toContain(300);
      expect(idx).not.toContain(0);
      expect(idx.length).toBe(ROWS_MOUNTED);
    });

    it(`${name}: a short list renders every row and reserves nothing`, async () => {
      const m = await render(12);
      expect(m.rowIndices().length).toBe(12);
      expect(m.pads()).toHaveLength(0);
    });

    it(`${name}: scrolled to the bottom, the list mounts its LAST row and reserves nothing below`, async () => {
      const m = await render(DEEP);
      await scrollTo(m.scroller, DEEP * ESTIMATED_ROW_PX - FALLBACK_VIEWPORT_PX);
      expect(m.rowIndices().at(-1)).toBe(DEEP - 1);
      const last = m.rows().at(-1)!;
      const below = m.pads().filter((pad) =>
        (last.compareDocumentPosition(pad) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      expect(below.map((pad) => pad.style.height)).toEqual([]);
    });
  }

  for (const [name, route, make] of streams) {
    it(`${name}: an unread letter listed late on top leaves the cursor on the letter shown`, async () => {
      const letters = [0, 1, 2].map((i) => stocked(i, make));
      const { address, mail } = mountStreamFrame({ at: `#/${route}`, letters });
      const list = within(screen.getByRole("region", { name }));
      const stream = screen.getByRole("region", { name: `${name} stream` });
      const reading = within(stream);
      const scroller = stream.querySelector<HTMLElement>(".oh-sheet-scroll")!;
      // Give the scroll spy a real viewport and let the anchor absorb the inserted card.
      const cardHeight = 200;
      const cards = () => [...scroller.querySelectorAll("[data-stream-item]")];
      vi.spyOn(scroller, "clientHeight", "get").mockReturnValue(240);
      vi.spyOn(scroller, "scrollHeight", "get").mockImplementation(() => cards().length * cardHeight);
      vi.spyOn(scroller, "scrollTo").mockImplementation((leftOrOptions?: number | ScrollToOptions, top?: number) => {
        const nextTop = typeof leftOrOptions === "number" ? top : leftOrOptions?.top;
        scroller.scrollTop = nextTop ?? scroller.scrollTop;
        fireEvent.scroll(scroller);
      });
      const rect = Element.prototype.getBoundingClientRect;
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (this === scroller) return new DOMRect(0, 0, 400, scroller.clientHeight);
        const index = cards().indexOf(this);
        if (index !== -1) return new DOMRect(0, index * cardHeight - scroller.scrollTop, 400, cardHeight);
        return rect.call(this);
      });
      const paint = () => act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      await paint();
      const cursor = () => list.queryByRole("option", { selected: true })?.dataset.id;
      expect.soft(cursor()).toBe("m0");
      const fresh = new Date(Date.parse(ISO) + 1000).toISOString();
      const newLetter = { ...stocked(9, make, true), date: fresh, arrivedAt: fresh };
      await act(async () => { mail.add(newLetter); });
      await paint();
      expect(list.getAllByRole("option")[0]?.dataset.id).toBe("m9");
      expect(scroller.scrollTop).toBe(cardHeight);
      expect(cursor()).toBe("m0");
      expect(address.read()).toBe(`#/${route}`);
      expect(reading.queryByRole("button", { name: "Collapse" })).toBeNull();
      expect(mail.bodyAsks).toEqual([]);
      expect(mail.mutations).toEqual([]);
    });
  }

  it("the streams opt into content-visibility, and the rule names the rendered card", async () => {
    const css = readFileSync("packages/ui/src/mail/Shell/sheet.css", "utf8");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      for (const [name, route, make] of streams) {
        mountStreamFrame({ at: `#/${route}`, letters: [stocked(0, make)] });
        const reading = screen.getByRole("region", { name: `${name} stream` });
        await page.setContent(reading.outerHTML);
        await page.addStyleTag({ content: css });
        const card = page.locator("[data-stream-item]");
        expect(await card.evaluate((element) => getComputedStyle(element).contentVisibility)).toBe("auto");
        await card.evaluate((element) => {
          const overlay = document.createElement("span");
          overlay.className = "oh-over";
          element.append(overlay);
        });
        expect(await card.evaluate((element) => getComputedStyle(element).contentVisibility)).toBe("visible");
        cleanup();
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
