/** @vitest-environment jsdom */
/**
 * THE SQUARES' WALK, TWICE, ONE SEQUENCE (the direction's rule for repeated glue; CHECK-JOIN-2 RULINGS (e)). Today's
 * `ThreadMarks` and the new column's `useThreadWalk` (both on the default names) stand each over one stubbed column
 * of the same three letters, laid out as `packages/app/test/reader/squares.test.tsx` lays its column out: the
 * scroller 800 tall, each letter's top read live against the scroll. The same steps are played on both: measured, a
 * hand scroll to three offsets, a press on the second square, the app's own stamped scroll, a hand scroll, a press on
 * the last letter. After each step the old ring's square and the new walk's `here` are the same letter; after each
 * press both scrollers stand at the same offset.
 *
 * The walk is not cut out of `ThreadMarks.tsx` (it leaves whole with `places`); until then this holds the two equal.
 */
import { useCallback, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/client-engine";
import { useThreadWalk, type ThreadWalk } from "@ohmail/app-logic/reader";
import { scrollProgrammatically } from "@ohmail/app-logic/session/programmatic-scroll";
import { ThreadMarks } from "../app/shell/ThreadMarks";
import messages from "../messages/en.json";

const member = (id: string, day: number): EngineMessage => ({
  id, accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
  from: { name: `Sender ${id}`, address: `${id}@example.invalid` }, to: [], cc: [],
  date: new Date(Date.UTC(2026, 10, 10 + day, 9)).toISOString(),
  folder: "INBOX", snippet: "", unread: false, hasAttachments: false,
  attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-11-10T09:00:00.000Z",
} as unknown as EngineMessage);
const LETTERS = [member("a", 0), member("b", 1), member("c", 2)];
const TOPS = [0, 900, 1800];
const HEIGHT = 3000;

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** One stubbed column: the scroller's box and each letter's, as a browser would lay them out. */
function Column({ onScroller, children }: { onScroller: (el: HTMLElement | null) => void; children?: ReactNode }) {
  const scrollerRef = useCallback((el: HTMLDivElement | null) => {
    if (el !== null) {
      Object.defineProperty(el, "clientHeight", { value: 800, configurable: true });
      Object.defineProperty(el, "scrollHeight", { value: HEIGHT, configurable: true });
      el.getBoundingClientRect = () => rect(0, 800);
      LETTERS.forEach((m, i) => {
        const panel = el.querySelector<HTMLElement>(`[data-conv-id="${m.id}"]`)!;
        panel.getBoundingClientRect = () => rect(TOPS[i]! - el.scrollTop, 800);
      });
    }
    onScroller(el);
  }, [onScroller]);
  return (
    <>
      <div ref={scrollerRef}>
        {LETTERS.map((m) => <article key={m.id} data-conv-id={m.id}>{`the letter ${m.id}`}</article>)}
      </div>
      {children}
    </>
  );
}

const twin: { old: HTMLElement | null; fresh: HTMLElement | null; walk: ThreadWalk | null } = { old: null, fresh: null, walk: null };

function Old() {
  const [ref] = useState(() => ({ current: null as HTMLElement | null }));
  const keep = useCallback((el: HTMLElement | null) => { ref.current = el; twin.old = el; }, [ref]);
  return (
    <section aria-label="old">
      <Column onScroller={keep}>
        <ThreadMarks messages={LETTERS} scroller={ref} onEnter={() => undefined} openedId="a" />
      </Column>
    </section>
  );
}

function New() {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const keep = useCallback((el: HTMLElement | null) => { setScroller(el); twin.fresh = el; }, []);
  twin.walk = useThreadWalk({ scroller, messages: LETTERS, openedId: "a", onEnter: () => undefined });
  return (
    <section aria-label="new">
      <Column onScroller={keep} />
    </section>
  );
}

/** A frame or two later, as the walks read a scroll and a layout. */
function settle(): void {
  act(() => { vi.advanceTimersByTime(50); });
}
/** The person's own scroll, on both columns. */
function byHand(top: number): void {
  act(() => {
    for (const el of [twin.old!, twin.fresh!]) {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    }
  });
  settle();
}

/** The old ring's letter: the square that says it is the current location. */
function oldRing(): string | null {
  const bar = within(screen.getByRole("region", { name: "old" })).getByRole("toolbar");
  const at = within(bar).getAllByRole("button").findIndex((b) => b.getAttribute("aria-current") === "location");
  return at < 0 ? null : LETTERS[at]!.id;
}
const newHere = (): string | null => (twin.walk!.here < 0 ? null : LETTERS[twin.walk!.here]!.id);

function same(step: string): void {
  expect(oldRing(), `${step}: the old column's ring stands on a letter`).not.toBeNull();
  expect(newHere(), `${step}: the new walk is on the old ring's letter`).toBe(oldRing());
}

/** A press on square `i`: today's square button, and the new walk's press. */
function press(i: number): void {
  const bar = within(screen.getByRole("region", { name: "old" })).getByRole("toolbar");
  fireEvent.click(within(bar).getAllByRole("button")[i]!);
  act(() => { twin.walk!.jump(i); });
  settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  twin.old = twin.fresh = null;
  twin.walk = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the old squares and the new walk, one sequence", () => {
  it("stand on the same letter after every step, and at the same offset after every press", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Old />
        <New />
      </NextIntlClientProvider>,
    );
    act(() => { window.dispatchEvent(new Event("resize")); });
    settle();
    same("measured");
    expect(newHere()).toBe("a");

    for (const top of [700, 1300, 2100]) {
      byHand(top);
      same(`a hand scroll to ${top}`);
    }

    press(1);
    expect(twin.fresh!.scrollTop, "a press on the second square: both scrollers at one offset").toBe(twin.old!.scrollTop);
    same("a press on the second square");
    expect(newHere()).toBe("b");

    act(() => {
      for (const el of [twin.old!, twin.fresh!]) {
        scrollProgrammatically(el, 0);
        el.dispatchEvent(new Event("scroll"));
      }
    });
    settle();
    same("the app's own stamped scroll");
    expect(newHere(), "the app's own scroll keeps the pressed letter").toBe("b");

    byHand(1900);
    same("a hand scroll after the press");
    expect(newHere(), "a hand scroll lets go of the pressed letter").not.toBe("b");

    press(2);
    expect(twin.fresh!.scrollTop, "a press on the last letter: both scrollers at one offset").toBe(twin.old!.scrollTop);
    same("a press on the last letter");
    expect(newHere()).toBe("c");
  });
});
