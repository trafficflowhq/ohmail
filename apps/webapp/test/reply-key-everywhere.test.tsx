/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
import messages from "../messages/en.json";

beforeEach(() => { localStorage.clear(); stubDom(); });
afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

const key = (k: string, init: KeyboardEventInit = {}) =>
  act(async () => { fireEvent.keyDown(document.body, { key: k, ...init }); });

async function pile(name: "News" | "Receipts", go: string) {
  const subject = `${name} letter`;
  const { el } = await mountShell("#/ohbox", [
    message("stream-letter", { subject, folder: name === "News" ? "ohmail/News" : "ohmail/Receipts" }),
  ]);
  await key("g");
  await key(go);
  const page = within(el);
  const stream = () => page.queryByRole("region", { name: `${name} stream` });
  await waitFor(() => stream() !== null, `the ${name} stream`);
  const reading = stream()!;
  const port = reading.querySelector<HTMLElement>("[data-reading-scroll]")!;
  Object.defineProperties(port, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 600 },
  });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === port) return new DOMRect(0, 0, 400, 600);
    if (this.closest("[data-stream-item]") && port.contains(this)) return new DOMRect(0, 90, 400, 200);
    return rect.call(this);
  });
  await key("j");
  await waitFor(() => reading.querySelector("[data-stream-item][data-open]") !== null, "the cursor's card");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  const card = () => within(stream()!).getByRole("heading", { name: subject }).closest("[data-stream-window-item]");
  const editor = (label = messages.write.reply.text) => within(stream()!).queryByRole("textbox", { name: label });
  return { card, editor, page };
}

async function expectCollapsed(card: () => Element | null, original: Element | null, editor: () => HTMLElement | null, action: string) {
  expect(original, "the letter opened in place").not.toBeNull();
  await waitFor(() => card() === original &&
    within(original as HTMLElement).queryByRole("button", { name: action }) !== null, "the same letter's collapsed action");
  expect(editor(), "the reply textbox is gone").toBeNull();
}

function expectNoReader(page: ReturnType<typeof within>) {
  expect(page.queryByRole("region", { name: "Open message" }), "the reader sheet").toBeNull();
  expect(page.queryByRole("dialog", { name: "Reading" }), "the reader dialog").toBeNull();
}

describe("CMP-F6 — `r` opens the reply editor outside the Ohbox", () => {
  it("in the Reads stream: `r` on the cursor answers the letter in place, with no reader sheet", async () => {
    const { card, editor, page } = await pile("News", "r");
    const original = card();
    expectNoReader(page);
    let openedReader = false;
    const watch = new MutationObserver(() => {
      openedReader ||= page.queryByRole("region", { name: "Open message" }) !== null ||
        page.queryByRole("dialog", { name: "Reading" }) !== null ||
        document.body.classList.contains("reading");
    });
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "role", "aria-label", "aria-labelledby", "hidden", "aria-hidden"] });

    try {
      await key("r");
      await waitFor(() => editor() !== null, "the reply in the stream");
      expect(original?.contains(editor())).toBe(true);
      expectNoReader(page);
      expect(openedReader, "the page entered the separate reader").toBe(false);
    } finally {
      watch.disconnect();
    }

    await key("Escape");
    await expectCollapsed(card, original, editor, "Expand");
  }, 20_000);

  it("at a phone's width Reply and Forward stay in place too", async () => {
    vi.stubGlobal("innerWidth", 390);
    stubDom({ narrow: true });
    const { card, editor, page } = await pile("News", "r");
    const original = card();
    await key("r");
    await waitFor(() => editor() !== null, "the reply in place");
    expect(original?.contains(editor())).toBe(true);
    expectNoReader(page);
    await key("Escape");
    await expectCollapsed(card, original, editor, "Read in full");
    await key("F", { code: "KeyF", shiftKey: true });
    const forward = () => editor(messages.write.reply.forwardText);
    await waitFor(() => forward() !== null, "the forward in place");
    expect(original?.contains(forward())).toBe(true);
    expectNoReader(page);
  }, 20_000);

  it("in Receipts too", async () => {
    const { card, editor, page } = await pile("Receipts", "e");
    const original = card();
    await key("r");
    await waitFor(() => editor() !== null, "the reply in the receipt's place");
    expect(original?.contains(editor())).toBe(true);
    expectNoReader(page);
  }, 20_000);
});
