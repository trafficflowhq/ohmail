/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FixturesAdapter, OhmailEngine } from "@ohmail/client-engine";
import { noteReplyPress } from "../app/shell/sent-reveal";

/**
 * A THREAD OPENS AT THE OPENED MESSAGE, AND STAYS THERE WHILE THE BODIES LAND.
 *
 * The pane puts the `aria-current` panel on screen (the one the bar acts on), not the newest, and
 * re-applies that while sibling bodies land and grow the stack above it, until the reader touches
 * it. jsdom has no layout: the geometry is stubbed on the real elements the effect walks, growth is
 * announced through the `ResizeObserver` it subscribes to, and `scrollTop` is read off the real
 * scroller. `b` is opened in `[a, b, c]`, so the opened and the newest panels cannot coincide.
 */
// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T12:00:00.000Z");

function msg(id: string, date: string): Record<string, unknown> {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId: "t1",
    messageIdHeader: null,
    subject: id === "a" ? "Quote for the north elevation" : "Re: Quote for the north elevation",
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date,
    folder: "INBOX",
    snippet: `snippet-${id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  };
}

const A = msg("a", "2026-07-30T09:00:00.000Z");
const B = msg("b", "2026-07-31T09:00:00.000Z");
const C = msg("c", "2026-08-01T09:00:00.000Z");

/**
 * THE FAKE LAYOUT.
 *
 * One number: how tall each rendered message is. The scroller's content height, and therefore
 * where the last entry sits, is derived from it — so "the siblings hydrated" is expressed as
 * the one thing that actually happens, every entry getting taller, and the position the effect
 * should land on falls out of that rather than being asserted from a constant.
 */
const VIEWPORT = 500;
/** Tall enough that three of them overflow the viewport — a stack with nothing to scroll has
    no anchoring question to get wrong, and the walk below correctly declines to move it. */
let entryHeight = 200;
const contentHeight = (): number => entryHeight * 3;
/** Where the OPENED entry (`b`, the second) sits, in the scroller's own coordinates. */
const openedEntryTop = (): number => entryHeight * 1;
/** What the effect should write: the opened entry's top, less its 14px of breathing room. */
const expectedScrollTop = (): number => openedEntryTop() - 14;

/** The ResizeObserver callbacks the pane has subscribed with. */
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

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Give the pane's own DOM a geometry. `host` is the scroller (`.read-col` in the product); each
 * `[data-conv-id]` is placed by index, in the scroller's coordinates, offset by however far the
 * scroller has already been scrolled — which is what `getBoundingClientRect` reports.
 */
function stubGeometry(): void {
  const el = host!;
  el.style.overflowY = "auto";
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => contentHeight() });
  el.getBoundingClientRect = (() => ({ top: 0, left: 0, right: 0, bottom: VIEWPORT, width: 600, height: VIEWPORT, x: 0, y: 0, toJSON: () => ({}) })) as never;

  const entries = [...el.querySelectorAll<HTMLElement>("[data-conv-id]")];
  entries.forEach((entry, i) => {
    entry.getBoundingClientRect = (() => {
      const top = entryHeight * i - el.scrollTop;
      return { top, left: 0, right: 0, bottom: top + entryHeight, width: 600, height: entryHeight, x: 0, y: top, toJSON: () => ({}) };
    }) as never;
  });
}

async function mountThread(): Promise<void> {
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");

  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(MessageChromeProvider as never, {
          value: {
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            conversationOf: () => [A, B, C],
            bodyOf: (m: Record<string, unknown>) => ({
              text: m.snippet as string,
              state: "snippet",
              html: null,
              loadedRemoteContent: false,
              unsubscribe: "no_header",
              unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            // The thread ask moved from `ConversationEntries` up to `MessagePane` — one call per
            // thread open rather than one per half. Inert here: this file measures the scroller.
            hydrateThread: () => {},
          },
          children: h(MessagePane as never, {
            message: B, tags: [], now: NOW,
            onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
          } as never),
        } as never),
      }),
    );
  });
}

/** The pane anchors in a layout effect, before the geometry exists. Give it one and re-run. */
async function settle(): Promise<void> {
  stubGeometry();
  await act(async () => {
    observing.forEach((cb) => cb());
  });
}

beforeEach(() => {
  entryHeight = 200;
  observing = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("the pane opens a thread on the opened message", () => {
  it("scrolls the opened entry into view, not the newest", async () => {
    await mountThread();
    await settle();
    expect(
      host!.scrollTop,
      "the thread did not open at the opened message",
    ).toBe(expectedScrollTop());
    expect(host!.scrollTop, "the thread opened at its newest message").not.toBe(entryHeight * 2 - 14);
  });

  it("FOLLOWS the stack as the siblings hydrate and push it down", async () => {
    await mountThread();
    await settle();
    const before = host!.scrollTop;

    // Every sibling's body arrives: two lines of snippet become a whole message, three times.
    entryHeight = 340;
    await settle();

    expect(host!.scrollTop, "the pane anchored once and never looked again — the opened message walked off as its older sibling grew")
      .toBe(expectedScrollTop());
    expect(host!.scrollTop).toBeGreaterThan(before);
  });

  it("HANDS OVER the moment the reader touches it, and never moves the scroller again", async () => {
    await mountThread();
    await settle();

    // A wheel gesture anywhere on the page: this reader is reading, and where they are looking
    // is now their decision. Re-anchoring under them would be worse than the bug being fixed.
    await act(async () => {
      window.dispatchEvent(new Event("wheel", { bubbles: true }));
    });
    host!.scrollTop = 0;

    entryHeight = 340;
    await settle();
    expect(host!.scrollTop, "the pane yanked a reader who had scrolled away").toBe(0);
  });
});

/**
 * THE REPLY YOU SENT IS EASED INTO VIEW (`sent-reveal.ts`), in the pane: Send pressed in the editor,
 * the editor closes, the sent copy joins at the foot. A lone letter's first reply turns it into a
 * conversation, and the open anchor used to run again then, putting the letter's top on screen and
 * the reply under the fold. Panels are `TALL` px each in a 500px column; the clock and the frames
 * are the fake timers'.
 */
describe("the reply you sent is brought into view", () => {
  const TALL = 600;
  const S = { ...msg("s", "2026-08-02T11:59:00.000Z"), folder: "Sent", from: { name: "Me", address: "me@example.invalid" } };
  let chrome: Record<string, unknown>;
  let shown: Record<string, unknown> = B;
  let sent: string[] = [];
  let top = 0;
  /** A new key remounts the pane, as a selection the shell drops and finds again does. */
  let paneKey = "p";
  const panels = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>("[data-conv-id]")];
  const contentH = (): number => panels().length * TALL + 120;

  function geometry(): void {
    const el = host!;
    el.style.overflowY = "auto";
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => contentH() });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => { top = Math.max(0, Math.min(contentH() - VIEWPORT, v)); },
    });
    el.getBoundingClientRect = (() => ({ top: 0, left: 0, right: 600, bottom: VIEWPORT, width: 600, height: VIEWPORT, x: 0, y: 0, toJSON: () => ({}) })) as never;
    panels().forEach((p, i) => {
      p.getBoundingClientRect = (() => {
        const t = TALL * i - top;
        return { top: t, left: 0, right: 600, bottom: t + TALL, width: 600, height: TALL, x: 0, y: t, toJSON: () => ({}) };
      }) as never;
    });
  }

  async function render(over: Record<string, unknown>): Promise<void> {
    const { MessagePane } = await import("../app/shell/MessagePane.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
    chrome = { ...chrome, ...over };
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: NOW,
          children: h(MessageChromeProvider as never, {
            value: chrome,
            children: h(MessagePane as never, {
              key: paneKey, message: shown, tags: [], now: NOW, onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
            } as never),
          } as never),
        }),
      );
    });
    geometry();
  }

  async function open(conversation: Record<string, unknown>[]): Promise<void> {
    host = document.createElement("div");
    host.className = "read-col";
    document.body.appendChild(host);
    root = createRoot(host);
    chrome = {
      replyTo: "b",
      replyBody: { text: "Thanks, see you there.", html: "" },
      onReplyBody: () => {},
      closeReply: () => {},
      // The shell's one send door (button, mod+Enter, Send + Done) notes the press, as `shell-compose.ts` does.
      sendReply: (id: string) => { noteReplyPress(id); sent.push(id); },
      replySendState: () => ({ phase: "idle" }),
      openSenderMenu: () => {},
      conversationOf: () => conversation,
      bodyOf: (m: Record<string, unknown>) => ({
        text: m.snippet as string, state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
      hydrateBody: () => {},
      hydrateThread: () => {},
    };
    await render({});
  }
  async function pressSend(): Promise<void> {
    const send = [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Send")!;
    expect(send, "the editor's Send").toBeTruthy();
    await act(async () => { send.click(); });
    expect(sent).toEqual(["b"]);
  }
  /** The mod+Enter binding: the shell's sendReply, never the button's onSend. */
  async function sendByShortcut(): Promise<void> {
    await act(async () => { (chrome.sendReply as (id: string) => void)("b"); });
  }
  /** The send confirmed: the editor closes and the copy joins; then frames run until none is asked for. */
  async function confirm(conversation: Record<string, unknown>[]): Promise<void> {
    await render({ replyTo: null, conversationOf: () => conversation });
    for (let i = 0; i < 120 && vi.getTimerCount() > 0; i++) {
      await act(async () => { vi.advanceTimersByTime(16); });
      geometry();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.setSystemTime(NOW);
    sent = [];
    shown = B;
    top = 0;
    paneKey = "p";
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { vi.useRealTimers(); });

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
    const Own = { ...msg("o", "2026-08-01T12:00:00.000Z"), threadId: "t2", folder: "Sent" };
    shown = Y;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    await render({ replyTo: null, conversationOf: () => [X, Y, Own] });
    await act(async () => { observing.forEach((cb) => cb()); });
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

  /* The desktop on Cloud: the dock closes at once, the confirmed send paints its provisional copy 2.7 s on, and the
     mirror's own Sent row takes its place (a new id) before the layout has settled. */
  const Overlay = { ...S, id: "sent-overlay", local: true };
  const Mirrored = { ...S, id: "mirrored" };
  async function closeDock(): Promise<void> {
    await render({ replyTo: null, conversationOf: () => [A, B] });
    await act(async () => { vi.advanceTimersByTime(2700); });
  }

  it("desktop: the provisional copy replaced by the mirror's row mid-settle is still eased in", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    await render({ conversationOf: () => [A, B, Overlay] });
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
    await render({});
    await confirm([A, B, Mirrored]);
    expect(top).toBe(TALL * 2 - 16);
  });

  it("desktop: the person scrolled while the remounted pane held the reveal: nothing moves", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    paneKey = "q";
    await render({});
    const held = top;
    await act(async () => { window.dispatchEvent(new Event("wheel")); });
    await confirm([A, B, Mirrored]);
    expect(top).toBe(held);
  });

  /** The pane remounted with a live open anchor: its observer sees every later stack resize. */
  async function remount(over: Record<string, unknown>): Promise<void> {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    paneKey = "q";
    await render(over);
  }
  async function resized(): Promise<void> {
    await act(async () => { observing.forEach((cb) => cb()); });
    geometry();
  }

  it("desktop: the remounted pane's open anchor stands down once the copy is eased in", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    await remount({});
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
    await remount({});
    await render({ replyTo: null, conversationOf: () => [A, B, Mirrored] });
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
    await remount({ conversationOf: () => [A, B, Mirrored] });
    await resized();
    expect(top).toBe(TALL * 2 - 16);
  });

  it("the same conversation remounted past the window opens at its opened message again", async () => {
    await open([A, B]);
    top = 700;
    await pressSend();
    await confirm([A, B, S]);
    await act(async () => { vi.advanceTimersByTime(61_000); });
    await remount({});
    await resized();
    expect(top).toBe(TALL * 1 - 14);
  });

  /* The reader closed before the copy joined, the conversation opened again later: a new open, not a remount. */
  async function reopenAfter(ms: number): Promise<void> {
    await open([A, B]);
    top = 700;
    await pressSend();
    await closeDock();
    await act(async () => { root!.render(h("div")); });
    await act(async () => { vi.advanceTimersByTime(ms); });
    await remount({ conversationOf: () => [A, B, Mirrored] });
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
  const Fr = { ...S, id: "fr", folder: "Envoyés" };
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
