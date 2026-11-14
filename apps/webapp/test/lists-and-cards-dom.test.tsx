/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Message } from "@ohmail/ui/mail";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function measureClip(contentHeight: () => number): void {
  const viewport = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
  const contents = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!.get!;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("oh-message-clip") ? 348 : viewport.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("oh-message-clip") ? contentHeight() : contents.call(this);
  });
}

function shortNews(format: "plain" | "html" = "plain") {
  measureClip(() => 200);
  const text = "Paid, thank you.";
  const body = format === "plain" ? text : undefined;
  const rows = format === "html"
    ? { "message_body:c1": { state: "ready", text, html: "<p>Paid, thank you.</p>" } }
    : {};
  const { address } = mountStreamFrame({ at: "#/reads", withReply: true, letters: [issue("c1", 20, { body })], rows });
  const list = screen.getByRole("region", { name: "News" });
  const region = screen.getByRole("region", { name: "News stream" });
  region.querySelector<HTMLElement>(".oh-sheet-scroll")!.scrollTo = vi.fn();
  const reading = within(region);
  expect(reading.queryByRole("button", { name: "Expand" })).toBeNull();
  return { address, reading, row: within(list).getByRole("option", { name: /Issue 20/ }) };
}

const preview = () => (
  <Message head={<p>Harbour Supply</p>} clip={{ open: false, word: "Expand" }}>
    <div>Paid, thank you.</div>
  </Message>
);

describe("a viewer card's pill and fade are one condition: the clip overflows", () => {
  it("the fitting message loses its Expand control and regains it when its content grows", () => {
    const callbacks: ResizeObserverCallback[] = [];
    const observed: Element[] = [];
    class Observer {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe(target: Element) { observed.push(target); }
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", Observer);
    let height = 200;
    measureClip(() => height);
    render(preview());

    const card = screen.getByRole("article");
    expect(card.querySelector("[data-fits]")).not.toBeNull();
    expect(within(card).queryByRole("button", { name: "Expand" })).toBeNull();
    expect(observed.length).toBeGreaterThan(0);

    height = 900;
    act(() => { for (const callback of callbacks) callback([], {} as ResizeObserver); });
    expect(card.querySelector("[data-fits]")).toBeNull();
    expect(within(card).getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("a short card still opens through its pill — the press the stream's Enter makes", async () => {
    for (const format of ["plain", "html"] as const) {
      const { address, reading, row } = shortNews(format);
      act(() => row.focus());
      await act(async () => { fireEvent.keyDown(row, { key: "Enter" }); });
      expect(address.read()).toBe("#/reads/m/c1");
      expect.soft(reading.queryByRole("button", { name: "Collapse" })?.getAttribute("aria-expanded")).toBe("true");
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it("a keyboard open of a short card hands focus to its first verb, not to the page", async () => {
    for (const format of ["plain", "html"] as const) {
      const { address, row } = shortNews(format);
      act(() => row.focus());
      await act(async () => { fireEvent.keyDown(row, { key: "Enter" }); });
      expect(address.read()).toBe("#/reads/m/c1");
      const toolbar = within(screen.getByRole("toolbar", { name: "Actions" }));
      expect(document.activeElement).toBe(toolbar.getByRole("button", { name: "Reply" }));
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it("a pointer open (the pill not focused) moves nobody's focus", () => {
    const { reading, row } = shortNews();
    act(() => row.focus());
    fireEvent.click(reading.getByRole("heading", { name: "Issue 20" }));
    expect(reading.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(row);
  });

  it("one threshold with the clip: a rendered mail 349-376px tall is cut, so it is not short", () => {
    measureClip(() => 360);
    render(preview());
    expect(screen.getByRole("article").querySelector("[data-fits]")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("an unmeasured viewer keeps its Expand control", () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(0);
    render(preview());
    expect(screen.getByRole("article").querySelector("[data-fits]")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
  });
});

describe("ListPane says its scroller's edges on the column", () => {
  it("data-scrolled once rows went up, data-more-below while rows continue", async () => {
    localStorage.clear();
    stubDom();
    onTestFinished(unmountAll);
    const { el } = await mountShell("#/history", [message("older")]);
    const list = within(el).getByRole("listbox", { name: "History" });
    const scroller = list.closest<HTMLElement>(".pl-scroll")!;
    const column = scroller.parentElement!;
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { value: 1200 });
    const at = async (top: number) => {
      await act(async () => {
        scroller.scrollTop = top;
        fireEvent.scroll(scroller);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    };
    await at(0);
    expect.soft(column.hasAttribute("data-scrolled")).toBe(false);
    expect.soft(column.hasAttribute("data-more-below")).toBe(true);
    await at(800);
    expect.soft(column.hasAttribute("data-scrolled")).toBe(true);
    expect.soft(column.hasAttribute("data-more-below")).toBe(false);
  });
});
