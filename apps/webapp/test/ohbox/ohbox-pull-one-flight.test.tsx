/** @vitest-environment jsdom */
// First: the new shell's door pins the API base before anything reads it.
import { act } from "../fixtures/live-walk-shell.js";
import { mountSeated, seatDown, seatEnv, setViewport } from "../_ohbox-2-seated.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** A pull gesture and the list's menu item share one in-flight pull request. Exercise both entry points while the first request is pending. */

let posts: number;
/** The ring's answer waits until the test lets it go: the flight stands while both triggers are pressed. */
let release: (() => void) | null;

/** A phone's browser: one column, and a coarse pointer, as the browser shell reads it. */
function phoneWindow(): void {
  setViewport(true);
  const narrow = window.matchMedia;
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    query === "(pointer: coarse)" ? ({ ...narrow(query), matches: true }) as MediaQueryList : narrow(query);
}

/** The served ring held: every `POST /sync/pull` counted, its answer kept until `release`. */
function holdTheRing(): void {
  const base = globalThis.fetch;
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST" && /\/sync\/pull$/.test(String(url))) {
      posts += 1;
      return new Promise<Response>((done) => {
        release = () =>
          done(new Response(JSON.stringify({ requested: 1, requestedAt: "2026-08-04T09:00:00.000Z", mailboxes: [] }), {
            status: 202, headers: { "content-type": "application/json" },
          }));
      });
    }
    return base(url as RequestInfo, init);
  }) as typeof globalThis.fetch;
}

let host: HTMLElement | null = null;

beforeEach(() => {
  posts = 0;
  release = null;
  seatEnv(true);
  phoneWindow();
});

afterEach(async () => {
  release?.();
  host = null;
  await seatDown();
});

async function mount(): Promise<void> {
  host = await mountSeated([{ id: "n1", unread: true }, { id: "n2", unread: true }]);
  holdTheRing();
}

function touches(type: string, at: { x: number; y: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: at ? [{ clientX: at.x, clientY: at.y, identifier: 1 }] : [] });
  return event;
}

/** A finger pulls the list down 150 at its top and lets go. */
function pullDown(on: Element): void {
  on.dispatchEvent(touches("touchstart", { x: 100, y: 200 }));
  for (const dy of [30, 60, 90, 120, 150]) on.dispatchEvent(touches("touchmove", { x: 100, y: 200 + dy }));
  on.dispatchEvent(touches("touchend", null));
}

describe("Pull new mail on a phone's browser", () => {
  it("rings once for a pull and a press of the list's menu item in the same moment", async () => {
    await mount();
    const scroller = host!.querySelector(".ob-scroll")!;
    expect(scroller.hasAttribute("data-touch-list"), "the list is under a finger").toBe(true);
    const actions = [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === "Ohbox actions",
    );
    await act(async () => actions!.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) =>
      /Pull new mail/.test(m.textContent ?? ""),
    );
    expect(item, "the list's menu offers Pull new mail").toBeDefined();
    /* Both before the list is drawn again: neither trigger has seen the other's flight yet. */
    await act(async () => {
      pullDown(scroller.querySelector('[role="option"]')!);
      item!.click();
    });
    expect(posts, "the two triggers are two flights").toBe(1);
    await act(async () => pullDown(scroller.querySelector('[role="option"]')!));
    expect(posts, "a pull while the first is under way").toBe(1);
  });
});
