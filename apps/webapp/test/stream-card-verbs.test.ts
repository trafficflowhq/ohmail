/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { letterBody } from "@ohmail/app/reader/body";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";
import { installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { click, LENA, mountThread, msg as threadMessage } from "./fixtures/thread-read-shell.js";
import messages from "../messages/en.json";

/**
 * READS AND RECEIPTS GET THE MESSAGE, NOT A PREVIEW OF IT.
 *
 * Both views read in the card and mount no reading pane, and the two things that hang off a
 * reading pane were therefore missing from them: the message's verbs, and the sender's screening
 * sheet. The same message in the Ohbox had both a click away. Two absences with one shape — a
 * surface built as a skim and then used as a reader.
 *
 * What is asserted here is the wiring, on the surfaces that were missing it:
 *
 *   · the card being read carries the verbs, and the hundreds that are not do not;
 *   · pressing one dispatches the shell's action for THAT message;
 *   · a click on a card's address resolves to the card's message, exactly as a click on a
 *     list row's address resolves to the row's.
 *
 */

beforeEach(() => {
  stubDom();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function msg(id: string): EngineMessage {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `subject of ${id}`,
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date: "2026-08-03T09:00:00.000Z",
    folder: "INBOX",
    snippet: `snippet of ${id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-03T09:00:00.000Z",
  } as unknown as EngineMessage;
}

const TWO = msg("two");

const stream = () => screen.getByRole("region", { name: "News stream" });
const card = (id: string) => stream().querySelector<HTMLElement>(`[data-stream-item="${id}"]`)!;

function mountRegisteredReads() {
  stubDom();
  return mountStreamFrame({
    at: "#/reads",
    withReply: true,
    letters: [issue("one", 20), issue("two", 19)],
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the card being read carries the message's verbs", () => {
  it("scrolling retargets the footer without unfolding the card", async () => {
    const { mail } = mountRegisteredReads();

    const scroll = stream().querySelector<HTMLElement>("[data-reading-scroll]")!;
    Object.defineProperty(scroll, "clientHeight", { value: 300 });
    Object.defineProperty(scroll, "scrollHeight", { value: 900 });
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 } as DOMRect);
    for (const [id, top] of [["one", 0], ["two", 400]] as const) {
      card(id).getBoundingClientRect = () => ({
        top: top - scroll.scrollTop, bottom: top + 400 - scroll.scrollTop, height: 400,
      } as DOMRect);
    }

    expect(within(stream()).getByRole("toolbar", { name: "Actions" })).toBeTruthy();
    await act(async () => {
      fireEvent.wheel(scroll, { deltaY: 400 });
      scroll.scrollTop = 400;
      fireEvent.scroll(scroll);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(card("two").hasAttribute("data-open")).toBe(true);
    expect(within(card("two")).getByRole("button", { name: "Expand" })).toBeTruthy();
    fireEvent.click(within(within(stream()).getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Later" }));
    expect(mail.mutations.filter((write) => write.kind === "triage_set")).toEqual([
      expect.objectContaining({ messageId: "two", state: "reply_later" }),
    ]);
  });
});

/**
 * REPLY IN PLACE (owner 2026-10-26: "reply in place looks good, build it in"). Reply turns the
 * letter into the Ohbox's conversation where its card stood, the reply joins it after the send,
 * and a letter left with nothing sent gets its card back. Driven through the chrome, the seam the
 * shell answers with: `replyTo`, the conversation and the send lanes.
 */
describe("a letter answered in place", () => {
  const LETTER = { ...msg("one"), threadId: "t1" };
  const SENT = {
    ...msg("sent-1"), threadId: "t1", folder: "Sent", local: true, date: "2026-08-04T11:00:00.000Z",
    from: { name: "Mila", address: "mila@example.com" },
    to: [{ name: "Sender one", address: "one@example.invalid" }],
    snippet: "Thank you, lovely issue.", body: "Thank you, lovely issue.\n\nMila",
  };
  it("the reply joins as a second panel with its square, and the row reads as yours", async () => {
    vi.setSystemTime(new Date("2026-08-05T09:00:00Z"));
    const letters = [LETTER, TWO].map((m) => issue(m.id, m.id === "one" ? 20 : 19, {
      ...m, folder: "ohmail/News", arrivedAt: m.date ?? undefined,
    }));
    const { mail } = mountStreamFrame({ at: "#/reads", letters, withReply: true, readerBody: letterBody });
    const list = within(screen.getByRole("region", { name: "News" }));
    await act(async () => { fireEvent.click(list.getByRole("option", { name: /subject of one/ })); });
    const actions = within(stream()).getByRole("toolbar", { name: "Actions" });
    await act(async () => { fireEvent.click(within(actions).getByRole("button", { name: "Reply" })); });
    const editor = await within(card("one").parentElement!).findByRole("textbox", { name: "Reply body" });
    await act(async () => { mail.add(SENT as unknown as EngineMessage); });
    await act(async () => { fireEvent.keyDown(editor, { key: "Escape" }); });

    const placed = card("one");
    expect(within(placed).getAllByRole("article")).toHaveLength(2);
    const squares = within(placed).getByRole("group", { name: /^2 messages/ });
    const markers = within(squares).getAllByRole("button");
    expect(markers.map((marker) => marker.getAttribute("data-square"))).toEqual(["0", "1"]);
    expect(markers[1]!.getAttribute("data-kind")).toBe("own");
    expect([...placed.querySelectorAll("[data-conv-id]")].map((node) => node.getAttribute("data-conv-id")))
      .toEqual(["one", "sent-1"]);
    const reply = placed.querySelector("[data-conv-id='sent-1']")!;
    expect([...reply.querySelectorAll("p")].map((p) => p.textContent?.trim()), "the paragraph break")
      .toEqual(expect.arrayContaining(["Thank you, lovely issue.", "Mila"]));
    const row = list.getByRole("option", { name: /subject of one/ });
    expect(row.querySelector(".oh-row-who")?.textContent).toBe("Me → Sender one");
    /* "Me → name" says the one it went to by address too, as a sender's row does. */
    expect(row.querySelector(".oh-row-address")?.textContent).toBe("one@example.invalid");
    expect(row.querySelector(".oh-row-preview")?.textContent).toBe("Thank you, lovely issue.");
  });

  it("the in-place bar dispatches for the letter", async () => {
    const { mail } = mountRegisteredReads();
    const list = within(screen.getByRole("region", { name: "News" }));
    await act(async () => { fireEvent.click(list.getByRole("option", { name: /Issue 20/ })); });
    const actions = () => within(stream()).getByRole("toolbar", { name: "Actions" });
    await act(async () => { fireEvent.click(within(actions()).getByRole("button", { name: "Reply" })); });
    expect(await within(card("one").parentElement!).findByRole("textbox", { name: "Reply body" })).toBeTruthy();

    await act(async () => { fireEvent.click(within(actions()).getByRole("button", { name: "Later" })); });
    expect(mail.mutations.filter((mutation) => mutation.kind === "triage_set")).toEqual([
      expect.objectContaining({ kind: "triage_set", messageId: "one", state: "reply_later" }),
    ]);
  });
});

describe("a sender's address is the handle on the sender, on cards as on rows", () => {
  const contact = (letter: EngineMessage) =>
    screen.getByRole("dialog", { name: `Options for ${letter.from.name ?? letter.from.address}` });

  it("resolves a click on a stream card's address to the card's message", async () => {
    const letter = issue("m1", 20, { subject: "The first issue" });
    mountStreamFrame({ at: "#/reads", letters: [letter], withReply: true });
    const item = card(letter.id);
    const button = within(item).getByRole("button", { name: `${letter.from.name} ${letter.from.address}` });
    const realBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === item) return new DOMRect(120, 100, 600, 140);
      if (this === button) return new DOMRect(180, 120, 160, 30);
      if (this.matches(".oh-over")) return new DOMRect(0, 0, 1024, 768);
      return realBounds.call(this);
    });
    await act(async () => { fireEvent.click(button); });
    const dialog = contact(letter);
    expect(dialog).toBeTruthy();
    expect(item.getAttribute("data-stream-item")).toBe("m1");
    expect(dialog.style.left, "the popover follows the sender control").toBe("180px");
  });

  it("still resolves both handles on a list row", async () => {
    installShellEnv();
    try {
      window.location.hash = "#/ohbox";
      await mountThread([threadMessage("m2", 0, { subject: "The second issue" })], { webContactScreening: true });
      const row = screen.getByRole("option", { name: /The second issue/ });
      for (const name of [messages.screening.openFor.replace("{sender}", LENA.name), LENA.address]) {
        const handle = within(row).getByRole("button", { name });
        await click(handle, name);
        const dialog = screen.getByRole("dialog", { name: messages.screening.aria.replace("{sender}", LENA.address) });
        expect(dialog.textContent).toContain(LENA.name);
        expect(handle.closest("[data-id]")?.getAttribute("data-id")).toBe("m2");
        await act(async () => { fireEvent.keyDown(dialog, { key: "Escape" }); });
        expect(screen.queryByRole("dialog")).toBeNull();
      }
    } finally {
      await teardownShellEnv();
    }
  });
});
