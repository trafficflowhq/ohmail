/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, within, type RenderResult } from "@testing-library/react";
import { OhmailEngine, type EntityReader } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { noteReplyPress } from "@ohmail/app-logic/writing/sent-reveal";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
import type { PanelVerb } from "@ohmail/ui/mail";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { PlaceEntry } from "../../../packages/app/src/frame/contract.js";
import { readerEntry, type ReaderReply } from "../../../packages/app/src/reader/index.js";
import { TextProvider } from "../../../packages/app/src/text/index.js";
import { fakeMail, letter, type FakeMail } from "../../../packages/app/test/reader/support/fake-mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../../../packages/app/test/support/fake-window.js";
import { LETTER_WORDS, READER_PLACE, bodyDouble } from "./_reader-1-letters.js";

/**
 * THE REPLY YOU SENT IS EASED INTO VIEW (`sent-reveal.ts`), in the new reader's column: Send pressed on the open
 * reply's panel, the reply closes, the sent copy joins at the conversation's foot. A lone letter's first reply turns
 * it into a conversation, and the open anchor used to run again then, putting the letter's top on screen and the
 * reply under the fold.
 *
 * Re-pointed (share reader-1) from today's `MessagePane` under a `MessageChromeProvider` onto the reader as the frame
 * mounts it (`_reader-1-letters.tsx`'s pieces): the conversation is the mirror's letters of one thread (a provisional
 * copy giving way to the mirror's row is the one hidden as the other is shown); the reply is the reader's `reply` part
 * as `write` hands it (its sheet, and its verbs in the panel's place while it is open; Send notes the press as the
 * shell's one send door does, `shell-compose.ts`); a pane remounted is the frame drawn again under another key. The
 * person's press on Send is a pointer's press (pointerdown, then click), and mod+Enter is a key pressed in the reply.
 * jsdom lays nothing out: the column's scroller is `VIEWPORT` tall, each letter `TALL` px, placed by index under the
 * scroll; the clock and the frames are the fake timers'. The expectations are today's, untouched.
 *
 * The open's own anchor (opened at the opened letter, following the stack while bodies land, handed over at the
 * person's first gesture) retired from this file to the reader's own `packages/app/test/reader/squares.test.tsx`
 * "the open" cases, which state the same promises over the same column.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const NOW = new Date("2026-08-02T12:00:00.000Z");
const VIEWPORT = 500;

function msg(id: string, date: string): EngineMessage {
  return letter(id, {
    threadId: "t1",
    subject: id === "a" ? "Quote for the north elevation" : "Re: Quote for the north elevation",
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    date,
    arrivedAt: date,
    updatedAt: date,
    snippet: `snippet-${id}`,
    unread: false,
  });
}

const A = msg("a", "2026-07-30T09:00:00.000Z");
const B = msg("b", "2026-07-31T09:00:00.000Z");

/** The ResizeObserver callbacks the column has subscribed with, where a case stands one. */
let observing: Array<() => void> = [];
class FakeResizeObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    observing.push(this.cb);
  }
  disconnect(): void {
    observing = observing.filter((c) => c !== this.cb);
  }
  unobserve(): void {}
}

const WRITE_PLACE: PlaceEntry = {
  id: "write",
  body: "write",
  rail: null,
  panes: { kind: "wide", Wide: () => h("p", null, "the place that writes") },
};

function Keys({ children }: { children: React.ReactNode }) {
  return h(KeymapContext.Provider, { value: useKeymapStore(), children });
}

describe("the reply you sent is brought into view", () => {
  const TALL = 600;
  const S = { ...msg("s", "2026-08-02T11:59:00.000Z"), folder: "Sent", from: { name: "Me", address: "me@example.invalid" } } as unknown as EngineMessage;
  let sent: string[] = [];
  let top = 0;
  /** A new key remounts the pane, as a selection the shell drops and finds again does. */
  let paneKey = "p";
  let mail: FakeMail;
  let address: FakeAddress;
  let view: RenderResult;
  let tree: (key: string | null) => React.ReactElement;
  /** The letters the mirror shows: every other letter it ever held is hidden (a provisional copy that gave way). */
  let shownIds = new Set<string>();

  /** The reply's sheet is open: `write`'s state, read by its sheet and by the panel through its verbs. */
  let replyOpen = true;
  const replyListeners = new Set<() => void>();
  const useReplyOpen = (): boolean =>
    React.useSyncExternalStore(
      (l) => {
        replyListeners.add(l);
        return () => replyListeners.delete(l);
      },
      () => replyOpen,
    );
  const setReplyOpen = (open: boolean): void => {
    replyOpen = open;
    for (const l of [...replyListeners]) l();
  };
  /** The shell's one send door (the panel's Send, mod+Enter) notes the press, as `shell-compose.ts` does. */
  const sendReply = (id: string): void => {
    noteReplyPress(id);
    sent.push(id);
  };
  const SEND_VERBS: readonly PanelVerb[] = [{ id: "send", label: "Send", kind: "ink", onPress: () => sendReply("b") }];
  function ReplySheet() {
    const open = useReplyOpen();
    if (!open) return null;
    return h("textarea", {
      "aria-label": "Reply",
      defaultValue: "Thanks, see you there.",
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendReply("b");
      },
    });
  }
  const REPLY: ReaderReply = {
    Sheet: ReplySheet,
    useOpen: () => () => {},
    useVerbs: () => (useReplyOpen() ? SEND_VERBS : null),
  };

  const scroller = (): HTMLElement | null => document.querySelector<HTMLElement>(".oh-sheet-scroll");
  const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-conv-id]")];
  const contentH = (): number => panels().length * TALL + 120;

  function geometry(): void {
    const el = scroller();
    if (el === null) return;
    el.style.overflowY = "auto";
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => contentH() });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(contentH() - VIEWPORT, v));
      },
    });
    el.getBoundingClientRect = (() => ({ top: 0, left: 0, right: 600, bottom: VIEWPORT, width: 600, height: VIEWPORT, x: 0, y: 0, toJSON: () => ({}) })) as never;
    panels().forEach((p, i) => {
      p.getBoundingClientRect = (() => {
        const t = TALL * i - top;
        return { top: t, left: 0, right: 600, bottom: t + TALL, width: 600, height: TALL, x: 0, y: t, toJSON: () => ({}) };
      }) as never;
    });
  }

  /** The mirror now shows `letters` (each added where it is new), and the readers are told. */
  async function mirrorShows(letters: readonly EngineMessage[]): Promise<void> {
    shownIds = new Set(letters.map((m) => m.id));
    await act(async () => {
      for (const m of letters) mail.add(m);
    });
    geometry();
  }

  function mountColumn(letters: readonly EngineMessage[], open = "b"): void {
    mail = fakeMail([], [], {});
    shownIds = new Set(letters.map((m) => m.id));
    for (const m of letters) mail.add(m);
    const raw = mail.engine.read();
    const hiding: EntityReader = {
      ...raw,
      get: <T,>(type: string, id: string) => (type === "message" && !shownIds.has(id) ? undefined : raw.get<T>(type, id)),
      list: <T,>(type: string) =>
        raw.list<T>(type).filter((m) => !(type === "message" && !shownIds.has((m as { id: string }).id))),
    } as EntityReader;
    const engine = { ...mail.engine, read: () => hiding, verbRead: () => hiding } as typeof mail.engine;
    address = fakeAddress(`#/ohbox/m/${open}`);
    const made = fakeHost({
      engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE, write: WRITE_PLACE },
      reader: readerEntry({
        body: bodyDouble().body,
        files: "none",
        pictures: "none",
        look: "none",
        sentCopy: "none",
        reply: REPLY,
        invitation: "none",
      }),
      window: fakeWindow("desktop"),
      address,
    });
    tree = (key) =>
      h(TextProvider, {
        locale: "en",
        messages: LETTER_WORDS.en,
        timeZone: "UTC",
        children: h(Keys, {
          children:
            key === null
              ? h("div")
              : h(PresentedMirrorContext.Provider, { key, value: hiding }, h(Frame, { host: made.host })),
        }),
      });
  }

  /** Open `b`, its reply open; `conversation` empty: the lone letter. */
  async function open(conversation: readonly EngineMessage[]): Promise<void> {
    mountColumn(conversation.length === 0 ? [B] : conversation);
    await act(async () => {
      view = render(tree(paneKey));
    });
    geometry();
    expect(screen.getByRole("textbox", { name: "Reply" }), "the reply's sheet").toBeTruthy();
  }
  /** Draw the column again: the same key keeps it, another remounts it. */
  async function redraw(): Promise<void> {
    await act(async () => {
      view.rerender(tree(paneKey));
    });
    geometry();
  }
  /** The person presses the reply panel's Send, as a pointer presses it. */
  async function pressSend(): Promise<void> {
    const send = within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Send" });
    expect(send, "the reply's Send").toBeTruthy();
    await act(async () => {
      fireEvent.pointerDown(send);
      fireEvent.click(send);
    });
    expect(sent).toEqual(["b"]);
  }
  /** The mod+Enter binding: a key pressed in the reply, the shell's send door, never the panel's Send. */
  async function sendByShortcut(): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), { key: "Enter", ctrlKey: true });
    });
  }
  /** The send confirmed: the reply closes and the copy joins; then frames run until none is asked for. */
  async function confirm(conversation: readonly EngineMessage[]): Promise<void> {
    await act(async () => {
      setReplyOpen(false);
    });
    await mirrorShows(conversation);
    for (let i = 0; i < 120 && vi.getTimerCount() > 0; i++) {
      await act(async () => {
        vi.advanceTimersByTime(16);
      });
      geometry();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.setSystemTime(NOW);
    sent = [];
    top = 0;
    paneKey = "p";
    replyOpen = true;
    observing = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a lone letter's first reply: no jump back to the letter; the reply eases in, its top a margin below the view's top", async () => {
    await open([]);
    top = 100;
    await pressSend();
    await confirm([B, S]);
    const sTop = TALL * 1;
    expect(top, "the anchor put the letter back on screen and the reply under the fold").toBe(sTop - 16);
  });

  it("a lone letter's reply sent with mod+Enter: no jump back; the reply eases in", async () => {
    await open([]);
    top = 100;
    await sendByShortcut();
    await confirm([B, S]);
    expect(top).toBe(TALL * 1 - 16);
  });

  it("a lone letter, scrolled after Send: the switch to a conversation moves nothing", async () => {
    await open([]);
    top = 100;
    await pressSend();
    await act(async () => { window.dispatchEvent(new Event("wheel")); });
    await confirm([B, S]);
    expect(top, "the anchor jumped the view back to the letter's top").toBe(100);
  });

  it("a lone letter whose send confirms past the window: nothing moves", async () => {
    await open([]);
    top = 100;
    await pressSend();
    await act(async () => { vi.advanceTimersByTime(61_000); });
    await confirm([B, S]);
    expect(top).toBe(100);
  });

  it("in a conversation, sent with mod+Enter: the reply eases in", async () => {
    await open([A, B]);
    top = 700;
    await sendByShortcut();
    await confirm([A, B, S]);
    expect(top).toBe(TALL * 2 - 16);
  });

  it("in a conversation: the reply eases in once the editor has closed", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await confirm([A, B, S]);
    expect(top).toBe(TALL * 2 - 16);
  });

  it("the person scrolled after pressing Send: nothing moves", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await act(async () => { window.dispatchEvent(new Event("wheel")); });
    await confirm([A, B, S]);
    expect(top).toBe(700);
  });

  it("another conversation opened before the send confirmed opens at its opened message, and nothing eases", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    const X = { ...msg("x", "2026-08-01T10:00:00.000Z"), threadId: "t2" };
    const Y = { ...msg("y", "2026-08-01T11:00:00.000Z"), threadId: "t2" };
    const Own = { ...msg("o", "2026-08-01T12:00:00.000Z"), threadId: "t2", folder: "Sent" } as unknown as EngineMessage;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    await act(async () => {
      setReplyOpen(false);
      for (const m of [X, Y, Own]) mail.add(m);
      shownIds = new Set(["a", "b", "x", "y", "o"]);
      address.visit("#/ohbox/m/y");
    });
    geometry();
    await act(async () => { observing.forEach((cb) => cb()); });
    await act(async () => { vi.advanceTimersByTime(16); });
    expect(top, "the new conversation's anchor: its opened message").toBe(TALL * 1 - 14);
    for (let i = 0; i < 60; i++) await act(async () => { vi.advanceTimersByTime(16); });
    expect(top).toBe(TALL * 1 - 14);
  });

  it("an arrival that is not the person's own send moves nothing", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    const theirs = msg("theirs", "2026-08-02T11:59:30.000Z");
    await confirm([A, B, theirs]);
    expect(top).toBe(700);
  });

  /* The desktop on Cloud: the reply closes at once, the confirmed send paints its provisional copy 2.7 s on, and the
     mirror's own Sent row takes its place (a new id) before the layout has settled. */
  const Overlay: EngineMessage = { ...S, id: "sent-overlay", local: true };
  const Mirrored: EngineMessage = { ...S, id: "mirrored" };
  async function closeDock(): Promise<void> {
    await act(async () => {
      setReplyOpen(false);
    });
    await mirrorShows([A, B]);
    await act(async () => { vi.advanceTimersByTime(2700); });
  }

  it("desktop: the provisional copy replaced by the mirror's row mid-settle is still eased in", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    await mirrorShows([A, B, Overlay]);
    await act(async () => { vi.advanceTimersByTime(60); });
    await confirm([A, B, Mirrored]);
    expect(top).toBe(TALL * 2 - 16);
  });

  it("desktop: the pane remounted before the copy joined still eases it in", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    paneKey = "q";
    await redraw();
    await confirm([A, B, Mirrored]);
    expect(top).toBe(TALL * 2 - 16);
  });

  it("desktop: the person scrolled while the remounted pane held the reveal: nothing moves", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    paneKey = "q";
    await redraw();
    const held = top;
    await act(async () => { window.dispatchEvent(new Event("wheel")); });
    await confirm([A, B, Mirrored]);
    expect(top).toBe(held);
  });

  /** The pane remounted with a live open anchor: its observer sees every later stack resize. */
  async function remount(conversation?: readonly EngineMessage[]): Promise<void> {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    paneKey = "q";
    if (conversation !== undefined) shownIds = new Set(conversation.map((m) => m.id));
    if (conversation !== undefined) for (const m of conversation) mail.add(m);
    await redraw();
  }
  async function resized(): Promise<void> {
    await act(async () => { observing.forEach((cb) => cb()); });
    await act(async () => { vi.advanceTimersByTime(16); });
    geometry();
  }

  it("desktop: the remounted pane's open anchor stands down once the copy is eased in", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    await remount();
    await confirm([A, B, Mirrored]);
    expect(top).toBe(TALL * 2 - 16);
    await act(async () => { vi.advanceTimersByTime(500); });
    await resized();
    expect(top, "the anchor pulled the view back to the opened letter").toBe(TALL * 2 - 16);
  });

  it("desktop: a stack resize partway through the ease neither re-anchors nor stops it", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    await remount();
    await mirrorShows([A, B, Mirrored]);
    const from = top;
    let mid = false;
    for (let i = 0; i < 120; i++) {
      await act(async () => { vi.advanceTimersByTime(16); });
      geometry();
      if (!mid && top !== from) { mid = true; await resized(); }
    }
    expect(mid).toBe(true);
    expect(top).toBe(TALL * 2 - 16);
  });

  it("desktop: the pane remounted just after the reveal keeps the reply in view", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await confirm([A, B, S]);
    expect(top).toBe(TALL * 2 - 16);
    await remount([A, B, Mirrored]);
    await resized();
    expect(top).toBe(TALL * 2 - 16);
  });

  it("the same conversation remounted past the window opens at its opened message again", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await confirm([A, B, S]);
    await act(async () => { vi.advanceTimersByTime(61_000); });
    await remount();
    await resized();
    expect(top).toBe(TALL * 1 - 14);
  });

  /* The reader closed before the copy joined, the conversation opened again later: a new open, not a remount. */
  async function reopenAfter(ms: number): Promise<void> {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    await act(async () => { view.rerender(tree(null)); });
    await act(async () => { vi.advanceTimersByTime(ms); });
    await remount([A, B, Mirrored]);
    await resized();
  }

  for (const [label, ms] of [["10 s", 10_000], ["90 s", 90_000]] as const) {
    it(`the reader closed before the copy joined, reopened ${label} on: it opens at the opened message and nothing eases`, async () => {
      await reopenAfter(ms);
      expect(top, "the open anchor stood down for a press of the closed reader").toBe(TALL * 1 - 14);
      for (let i = 0; i < 60; i++) {
        await act(async () => { vi.advanceTimersByTime(16); });
        geometry();
      }
      expect(top).toBe(TALL * 1 - 14);
    });
  }

  /* A Sent folder made after connecting: the copy lands in 'Envoyés' before any mailbox read named it,
     then the read the copy asks for records it (the engine's statement, as the shell makes it). */
  const Fr = { ...S, id: "fr", folder: "Envoyés", mailboxId: "mb" } as unknown as EngineMessage;
  async function landThenRecord(scrolled: boolean): Promise<number> {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter() });
    try {
      await open([A, B]);
      top = 700;
      await pressSend();
      if (scrolled) await act(async () => { window.dispatchEvent(new Event("wheel")); });
      await confirm([A, B, Fr]);
      expect(top, "a copy nobody knew as Sent moved the view").toBe(700);
      engine.setSentFolders([{ id: "mb", sentFolder: "Envoyés" }]);
      await act(async () => { mail.patch("fr", {}); });
      await confirm([A, B, Fr]);
      return top;
    } finally {
      engine.setSentFolders([]);
    }
  }

  it("a reply saved to an 'Envoyés' recorded after it landed eases in", async () => {
    expect(await landThenRecord(false)).toBe(TALL * 2 - 16);
  });

  it("CONTROL: the person scrolled after Send: the recorded 'Envoyés' reply moves nothing", async () => {
    expect(await landThenRecord(true)).toBe(700);
  });
});
