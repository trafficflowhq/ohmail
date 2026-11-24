/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
import { typeInto } from "./fixtures/rich-editor-driver.js";

const VIEW = 600;
const CARD = 200;
const box = (top: number, height: number) => new DOMRect(0, top, VIEW, height);

beforeEach(() => {
  stubDom();
  localStorage.clear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

async function openReply() {
  const letters = Array.from({ length: 10 }, (_, i) => message(`r${i}`, {
    folder: "ohmail/News",
    subject: `News letter ${i}`,
    date: new Date(Date.UTC(2026, 8, 27, 8, 29 - i)).toISOString(),
  }));
  letters.push(message("preceding", { threadId: "t-r1", subject: "An earlier note" }));
  const shell = await mountShell("#/reads/m/r1", letters, [], { handOff: true });
  const news = within(shell.el).getByRole("region", { name: "News stream" });
  const inNews = within(news);
  const scroller = news.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  const editor = () => inNews.queryByRole("textbox", { name: "Reply body" });
  const cards = () => [...news.querySelectorAll<HTMLElement>("[data-stream-item]")];
  const card = (id: string) => cards().find((el) => el.dataset.streamItem === id)!;
  const conversation = () => card("r1").querySelector('[data-conv-id="preceding"]');
  const size = (el: HTMLElement) => {
    if (el.dataset.streamItem !== "r1") return CARD;
    if (editor() !== null) return CARD + 700;
    return CARD + (conversation() !== null ? 300 : 0);
  };
  const top = (id: string) => card(id).getBoundingClientRect().top;
  const cursor = () => cards().find((el) => el.hasAttribute("data-open"))?.dataset.streamItem;
  const atLine = () => cards().filter((el) => el.getBoundingClientRect().top <= 90).at(-1)?.dataset.streamItem;
  const land = (offset: number) => {
    scroller.scrollTop = offset;
    fireEvent.scroll(scroller);
  };
  const spacer = (edge: "head" | "tail") =>
    Number.parseFloat(scroller.querySelector<HTMLElement>(`[data-stream-${edge}]`)?.style.height ?? "0") || 0;
  Object.defineProperties(scroller, {
    clientHeight: { get: () => VIEW },
    scrollHeight: { get: () => cards().reduce((sum, el) => sum + size(el), spacer("head") + spacer("tail")) },
  });
  scroller.getBoundingClientRect = () => box(0, VIEW);
  scroller.scrollTo = ((o: ScrollToOptions) => land(o.top ?? 0)) as typeof scroller.scrollTo;
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches("[data-stream-item]") && scroller.contains(this)) {
      const before = cards().slice(0, cards().indexOf(this));
      return box(before.reduce((sum, above) => sum + size(above), spacer("head")) - scroller.scrollTop, size(this));
    }
    return nativeRect.call(this);
  });
  await act(async () => { land(186); });
  await press(inNews.getByRole("button", { name: "Reply" }), "Reply");
  await waitFor(() => editor() !== null, "the reply editor");
  await act(async () => { typeInto(editor()!, "Thanks for the news"); });
  await frames(12);
  return { ...shell, news, scroller, editor, conversation, top, cursor, atLine, land };
}

async function frames(count: number) {
  await act(async () => {
    for (let frame = 0; frame < count; frame += 1)
      await new Promise<number>((resolve) => requestAnimationFrame(resolve));
  });
}

type Visit = Awaited<ReturnType<typeof openReply>>;

async function send(visit: Visit, pressSend: () => Promise<void>, check: () => void) {
  let release!: () => void;
  visit.sendGate.wait = new Promise<void>((resolve) => { release = resolve; });
  const before = visit.cursor();
  const cursors = [before];
  const watch = new MutationObserver(() => cursors.push(visit.cursor()));
  watch.observe(visit.scroller, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["data-open"],
  });
  try {
    await pressSend();
    await waitFor(() => visit.sent.some((mutation) => mutation.kind === "mail_send"), "the handed-off send");
    expect(visit.editor(), "the editor closed before the transport answered").toBeNull();
    await frames(12);
    expect(visit.conversation(), "the answered conversation stays in the stream").not.toBeNull();
    check();
    expect(new Set(cursors)).toEqual(new Set([before]));
  } finally {
    watch.disconnect();
    release();
  }
}

describe("a letter answered in place", () => {
  it("after Send the cursor stays on the answered letter and its top stays where it was", async () => {
    const visit = await openReply();
    await act(async () => { visit.land(400); });
    expect(visit.top("r1"), "the answered letter straddles the top of the port").toBeLessThan(0);
    expect(visit.cursor()).toBe("r1");
    // Let the original opening hold expire before the send changes the layout.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    const before = visit.top("r1");

    await send(visit, () => press(within(visit.news).getByRole("button", { name: "Send" }), "Send"), () => {
      expect(visit.cursor()).toBe("r1");
      expect(visit.top("r1")).toBe(before);
    });
  });

  it("read on below it, a handed-off Send leaves the stream on the card being read", async () => {
    const visit = await openReply();
    await act(async () => {
      fireEvent.wheel(visit.scroller, { deltaY: 120 });
      visit.land(1300);
    });
    await frames(20);
    expect(visit.cursor(), "the reading cursor follows the wheel").toBe("r3");
    expect(visit.atLine()).toBe("r3");
    expect(visit.top("r2")).toBeLessThan(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    const before = visit.top("r3");

    await send(visit, () => act(async () => {
      fireEvent.keyDown(visit.editor()!, { key: "Enter", ctrlKey: true });
    }), () => {
      expect(visit.atLine()).toBe("r3");
      expect(visit.cursor()).toBe("r3");
      expect(visit.top("r3")).toBe(before);
    });
  });
});
