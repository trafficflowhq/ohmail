/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { StreamShell, type StreamHandle } from "../app/shell/StreamShell";

/**
 * TRI-F2 (stream half) — A PROGRAMMATIC JUMP OWNS THE CURSOR WHILE IT LANDS.
 *
 * `StreamShell.scrollTo` animates, and every frame fired the scroll-spy, which reads
 * "current" off geometry mid-flight. The killer was the pinned-to-end rule: a jump to a card
 * near the END of the pile bottoms the scroller out, the spy declared the pile's LAST card
 * current, and the search jump landed cursor and highlight on a message nobody clicked — a
 * card below the reading line can never reach it, so the wrong cursor was permanent.
 *
 * The case below reproduces exactly that geometry and asserts the spy stands down: the
 * clicked card keeps the cursor, and the last card is never announced.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  if (typeof globalThis.requestAnimationFrame !== "function") {
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) =>
      setTimeout(() => cb(performance.now()), 5) as unknown as number;
    (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** A rect at `top`, one card high. */
const rect = (top: number, height = 200): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe("the scroll-spy during a programmatic jump", () => {
  it("a jump that bottoms out keeps the CLICKED card current — never the pile's last", async () => {
    const onCurrentChange = vi.fn();
    const ref = React.createRef<StreamHandle>();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    const card = (sid: string) => h("div", { className: "scast", "data-sid": sid, key: sid });
    await act(async () => {
      root.render(
        h(StreamShell, {
          ref,
          ariaLabel: "stream",
          onCurrentChange,
          onSeen: () => {},
          contentKey: 1,
          children: [card("c1"), card("c2"), card("c3"), card("c4")],
        }),
      );
    });

    const el = container.querySelector<HTMLElement>(".stream")!;
    // The scroller: 600px viewport over 1200px of content, i.e. maximum scrollTop = 600.
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1200 });
    let scrollTop = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = Math.min(600, Math.max(0, v));
      },
    });
    el.getBoundingClientRect = () => rect(0, 600);
    // Content offsets: c3 sits deep enough that centring it needs a scrollTop beyond the
    // maximum — the jump BOTTOMS OUT with c3 still below the 90px reading line, and c4 is
    // the pile's last card. The old spy declared c4 current in exactly this state.
    const cards = container.querySelectorAll<HTMLElement>(".scast");
    const contentTop: Record<string, number> = { c1: 0, c2: 300, c3: 836, c4: 1000 };
    cards.forEach((c) => {
      c.getBoundingClientRect = () => rect(contentTop[c.dataset.sid!]! - scrollTop);
    });
    el.scrollTo = ((opts: ScrollToOptions) => {
      // jsdom has no smooth scrolling: land instantly at the requested offset (clamped by
      // the setter, as a real scroller clamps), then let the scroll event drive the spy
      // exactly as a real frame would.
      el.scrollTop = opts.top ?? 0;
      el.dispatchEvent(new Event("scroll"));
    }) as typeof el.scrollTo;

    await act(async () => {
      ref.current!.scrollTo("c3");
    });
    await flush();

    // The spy must not reassign the cursor away from the jump's target. In particular the
    // pinned-to-end rule may not hand it to c4 — that was the wrong-message landing.
    const announced = onCurrentChange.mock.calls.map((c) => c[0]);
    expect(announced, `the spy announced: ${announced.join(", ") || "(nothing)"}`).not.toContain("c4");

    // And an ORDINARY scroll afterwards still drives the spy — the stand-down is a flight,
    // not a mute switch. Scrolling back up puts c2 at the reading line: a plain change.
    el.scrollTop = 300;
    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(onCurrentChange.mock.calls.map((c) => c[0])).toContain("c2");
  });

  it("a jump onto short cards keeps the CLICKED card current — never one that also fits above the line", async () => {
    // Collapsed receipt cards are one line high: parked at 14px, the target's next two neighbours
    // also start above the 90px line, and the spy handed the cursor to the second of them.
    const onCurrentChange = vi.fn();
    const ref = React.createRef<StreamHandle>();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    await act(async () => {
      root.render(h(StreamShell, {
        ref, ariaLabel: "stream", onCurrentChange, onSeen: () => {}, contentKey: 1,
        children: ids.map((sid) => h("div", { className: "scast", "data-sid": sid, key: sid })),
      }));
    });
    const el = container.querySelector<HTMLElement>(".stream")!;
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
    let scrollTop = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = Math.min(1400, Math.max(0, v)); },
    });
    el.getBoundingClientRect = () => rect(0, 600);
    container.querySelectorAll<HTMLElement>(".scast").forEach((c, i) => {
      c.getBoundingClientRect = () => rect(i * 38 - scrollTop, 38);
    });
    el.scrollTo = ((opts: ScrollToOptions) => {
      el.scrollTop = opts.top ?? 0;
      el.dispatchEvent(new Event("scroll"));
    }) as typeof el.scrollTo;

    await act(async () => { ref.current!.scrollTo("c2"); });
    await flush();

    const announced = onCurrentChange.mock.calls.map((c) => c[0]);
    expect(announced, `the spy announced: ${announced.join(", ") || "(nothing)"}`).not.toContain("c3");
    expect(announced).not.toContain("c4");
  });
});
