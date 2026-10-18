/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QUEUE_SETTLE_MS, QUEUE_SETTLE_START, firstRunImportOver, queueSettleNext, queueSettling,
  useFirstRunQueueSettle, type QueueSettleEvent, type QueueSettleState,
} from "../app/shell/first-run-queue-settle";

/**
 * THE RUN'S PULL ENDS WHEN THE IMPORT IS OVER AND THE STORE HAS ANSWERED THE QUEUE SINCE. The stamp
 * and the Screener's waiting count come from two clocks; when the stamp's poll landed first the run
 * walked to the summary over an empty count and "Open ohmail" closed the flow for good.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** Folds events from a state, counting the asks. */
function fold(events: QueueSettleEvent[], from: QueueSettleState = QUEUE_SETTLE_START) {
  let state = from;
  let asks = 0;
  for (const e of events) {
    const step = queueSettleNext(state, e);
    state = step.state;
    if (step.ask) asks += 1;
  }
  return { state, asks };
}

const notOver = { kind: "notOver", mailboxId: "mb-1" } as const;
const over = (now = 0) => ({ kind: "over", mailboxId: "mb-1", now }) as const;
const answered = { kind: "answered", mailboxId: "mb-1" } as const;
const timeout = { kind: "timeout", mailboxId: "mb-1" } as const;

describe("the queue settle, as a reducer", () => {
  it("(a) the import's end, seen while the run is open, asks the store once", () => {
    const r = fold([notOver, over()]);
    expect(r.asks).toBe(1);
    expect(queueSettling(r.state, "mb-1")).toBe(true);
    expect(queueSettling(r.state, "mb-2"), "another mailbox's run is not held").toBe(false);
  });

  it("(b) the store's answer ends the hold", () => {
    const r = fold([notOver, over(), answered]);
    expect(queueSettling(r.state, "mb-1")).toBe(false);
    expect(r.asks).toBe(1);
  });

  it("(c) the bound ends it when the store never answers", () => {
    const r = fold([notOver, over(), timeout]);
    expect(queueSettling(r.state, "mb-1")).toBe(false);
  });

  it("(d) RESUME CONTROL — an import already over at the first look holds nothing", () => {
    const r = fold([over(), over(), answered]);
    expect(r.asks).toBe(0);
    expect(queueSettling(r.state, "mb-1")).toBe(false);
  });

  it("(e) every edge asks once, and never while an ask is out", () => {
    expect(fold([notOver, over(), answered, notOver, over()]).asks).toBe(2);
    expect(fold([notOver, over(), over(), over()]).asks, "asked again while asking").toBe(1);
    /* The import flaps while the ask is out: no second ask, and the answer that lands after the
       second edge is fresh enough to end the hold. */
    const flap = fold([notOver, over(), notOver, over(), answered]);
    expect(flap.asks).toBe(1);
    expect(queueSettling(flap.state, "mb-1")).toBe(false);
    /* The answer lands between the two edges: the second edge is after it and asks again. */
    expect(fold([notOver, over(), notOver, answered, over()]).asks).toBe(2);
  });

  it("an answer about another mailbox, or after the run closed, ends nothing it did not start", () => {
    const asking = fold([notOver, over()]).state;
    expect(queueSettling(queueSettleNext(asking, { kind: "answered", mailboxId: "mb-2" }).state, "mb-1")).toBe(true);
    const closed = queueSettleNext(asking, { kind: "inactive" }).state;
    expect(queueSettling(closed, "mb-1")).toBe(false);
    expect(queueSettleNext(closed, over()).ask, "a closed run asks on its first look").toBe(false);
  });

  it("(f) the hold only narrows 'over' to 'not yet'; a host that cannot tell stays one", () => {
    expect(firstRunImportOver(true, true)).toBe(false);
    expect(firstRunImportOver(true, false)).toBe(true);
    expect(firstRunImportOver(false, false)).toBe(false);
    expect(firstRunImportOver(false, true)).toBe(false);
    expect(firstRunImportOver(undefined, true)).toBe(false);
    // Absent is "cannot tell" (`importOverOf` falls back to the stamp): not `false`, not `null`.
    expect(firstRunImportOver(undefined, false)).toBeUndefined();
  });
});

describe("the queue settle, as a hook", () => {
  const roots: Root[] = [];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    for (const r of roots.splice(0)) await act(() => { r.unmount(); });
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  async function mount(reread: () => Promise<void>, start: { over: boolean }) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push(root);
    const seen: boolean[] = [];
    let setOver: (o: boolean) => void = () => {};
    const Probe = () => {
      const [o, put] = React.useState(start.over);
      setOver = put;
      const settling = useFirstRunQueueSettle({ active: true, mailboxId: "mb-1", over: o, reread });
      seen.push(settling);
      return h("i", { "data-settling": String(settling) });
    };
    await act(async () => { root.render(h(Probe, null)); });
    const settling = () => el.querySelector("i")?.getAttribute("data-settling") === "true";
    return { settling, seen, flip: async (o: boolean) => { await act(async () => { setOver(o); }); } };
  }

  it("a store that never answers releases at the bound", async () => {
    const reread = vi.fn(() => new Promise<void>(() => {}));
    const s = await mount(reread, { over: false });
    await s.flip(true);
    expect(s.settling()).toBe(true);
    expect(reread).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(QUEUE_SETTLE_MS - 1); });
    expect(s.settling()).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(s.settling()).toBe(false);
  });

  it("a store that refuses releases at once", async () => {
    const reread = vi.fn(() => Promise.reject(new Error("offline")));
    const s = await mount(reread, { over: false });
    await s.flip(true);
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(s.settling()).toBe(false);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("the render that sees the import end already holds — no frame of 'over' first", async () => {
    const s = await mount(() => new Promise<void>(() => {}), { over: false });
    const before = s.seen.length;
    await s.flip(true);
    expect(s.seen.slice(before), "a render saw the import over before the hold").not.toContain(false);
  });

  it("RESUME CONTROL — mounted over a finished import, it neither asks nor holds", async () => {
    const reread = vi.fn(async () => {});
    const s = await mount(reread, { over: true });
    expect(s.settling()).toBe(false);
    expect(s.seen).not.toContain(true);
    expect(reread).not.toHaveBeenCalled();
  });
});
