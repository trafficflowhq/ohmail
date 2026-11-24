/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { createThreadRead } from "@ohmail/client-engine";
import { createThreadReadDom, threadReadTime } from "@ohmail/app-logic/reading/reader-seen";
import { READER_DOM } from "../../../packages/app/src/reader/read-dom.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubThreadLayout } from "./fixtures/thread-layout.js";
import { stubDom } from "./_draft-shell.js";

beforeEach(() => stubDom());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(letters: readonly EngineMessage[], bodies?: Readonly<Record<string, unknown>>) {
  const { mail, address } = mountStreamFrame({ at: "#/reads", letters, bodies, withReply: true });
  const stream = screen.getByRole("region", { name: "News stream" });
  const list = within(screen.getByRole("region", { name: "News" }));
  return {
    mail,
    address,
    stream,
    openLetter: () => fireEvent.click(list.getByRole("option", { name: new RegExp(letters[0]!.subject!) })),
    reply: () => fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Reply" }),
    ),
    readWrites: () => mail.mutations.filter((verb) => verb.kind === "mark_seen" || verb.kind === "feed_mark_seen"),
  };
}

const first = issue("first", 13, { threadId: "thread", unread: false });
const sent = issue("sent", 12, {
  threadId: "thread",
  folder: "Sent" as EngineMessage["folder"],
  local: true,
  unread: false,
});

describe("a letter answered in its reading stream", () => {
  it("a lone letter is one panel of a conversation, so the paper keeps its place when a reply joins", async () => {
    const { stream, mail, openLetter, reply, readWrites } = open([first]);
    openLetter();
    const expand = within(stream).queryByRole("button", { name: "Expand" });
    if (expand) fireEvent.click(expand);
    await waitFor(() => expect(within(stream).getByRole("article").closest('[data-conv-id="first"]')).toBeTruthy());
    const panel = within(stream).getByRole("article");
    const card = panel.closest('[data-stream-window-item="first"]')!;
    reply();

    const editor = await within(stream).findByRole("textbox", { name: "Reply body" });
    expect(card.contains(editor)).toBe(true);
    expect(within(stream).getAllByRole("article")).toEqual([panel]);
    expect(within(stream).queryByRole("group", { name: /1 message/ })).toBeNull();
    act(() => mail.add(sent));
    const squares = within(stream).getByRole("group", { name: "2 messages, all read" });
    expect(within(squares).getAllByRole("button")).toEqual([
      within(squares).getByRole("button", { name: "Message 1 of 2, sent by you" }),
      within(squares).getByRole("button", { name: "Message 2 of 2 from The Weekly, read" }),
    ]);
    expect(card.contains(panel)).toBe(true);
    expect(panel.closest('[data-conv-id="first"]')).toBeTruthy();
    expect(within(stream).getAllByRole("article")).toHaveLength(2);
    expect(within(stream).getByRole("textbox", { name: "Reply body" })).toBe(editor);
    expect(readWrites()).toEqual([]);
  });

  it("two messages draw the squares, without the read rule", async () => {
    const layout = stubThreadLayout({ viewport: 900, defaultHeight: 240, scrollerSelector: ".oh-sheet-scroll" });
    onTestFinished(() => layout.restore());
    const other = issue("other", 12, {
      threadId: "thread", folder: "INBOX", unread: true,
      from: { name: "Ben", address: "ben@kiln.example" },
    });
    const { stream, openLetter, reply, readWrites } = open([first, other], {
      other: { state: "ready", text: "A visible reply.", html: null, loadedRemoteContent: false },
    });
    openLetter();
    reply();
    await within(stream).findByRole("textbox", { name: "Reply body" });

    const squares = within(stream).getByRole("group", { name: "2 messages, 1 unread" });
    expect(within(squares).getAllByRole("button")).toHaveLength(2);
    const sibling = stream.querySelector<HTMLElement>('[data-conv-id="other"][data-unseen]')!;
    expect(sibling).toBeTruthy();
    expect(sibling.hasAttribute("data-body-ready")).toBe(true);
    const scroller = sibling.closest<HTMLElement>(".oh-sheet-scroll")!;
    expect(sibling.getBoundingClientRect().bottom).toBeLessThan(scroller.getBoundingClientRect().bottom);
    fireEvent.wheel(scroller);
    await act(async () => new Promise<void>((done) => requestAnimationFrame(() => done())));
    await layout.passDwell();
    expect(layout.dwelling()).toBe(false);
    expect(readWrites()).toEqual([]);
    expect(sibling.hasAttribute("data-unseen")).toBe(true);

    // A control on this exact layout makes the absent rule observable.
    const record = createThreadRead();
    const read = vi.fn();
    const control = createThreadReadDom({
      scroller, record, names: READER_DOM, onRead: read,
      onEnter: () => record.enter(threadReadTime.now()),
    });
    try {
      fireEvent.wheel(scroller, { deltaY: 100 });
      await act(async () => new Promise<void>((done) => requestAnimationFrame(() => done())));
      expect(layout.dwelling()).toBe(true);
      await layout.passDwell();
      expect(read).toHaveBeenCalledWith(["other"]);
    } finally {
      control.dispose();
    }
  });

  it("the editor takes focus on its arrival only", async () => {
    const later = issue("later", 11, { unread: false });
    const { stream, mail, address, openLetter, reply } = open([first, later]);
    openLetter();
    reply();
    const body = await within(stream).findByRole("textbox", { name: "Reply body" });
    await waitFor(() => expect(document.activeElement).toBe(body));

    const recipients = within(stream).getByRole("button", { name: "Change recipients" });
    recipients.focus();
    expect(document.activeElement).toBe(recipients);
    act(() => mail.patch(first.id, { snippet: "The header has not changed." }));

    expect(within(stream).getByRole("textbox", { name: "Reply body" })).toBe(body);
    await act(async () => new Promise<void>((done) => requestAnimationFrame(() => done())));
    expect(document.activeElement).toBe(recipients);

    act(() => address.visit("#/reads/m/later"));
    expect(within(stream).getByRole("heading", { name: later.subject! })).toBeTruthy();
    act(() => address.visit("#/reads/m/first"));
    const returned = await within(screen.getByRole("region", { name: "News stream" }))
      .findByRole("textbox", { name: "Reply body" });
    await act(async () => new Promise<void>((done) => requestAnimationFrame(() => done())));
    expect(returned).toBe(body);
    expect(document.activeElement).not.toBe(returned);
  });
});
