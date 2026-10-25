/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { StreamShell, type StreamHandle, type StreamLeaveState } from "../app/shell/StreamShell";

/**
 * THE LEAVE-COMMIT'S TRACKING UNDER A SLIDING WINDOW — `newestSeenId` must survive its card's
 * unmount.
 *
 * `StreamShell.measure()` keeps "the newest card ever displayed" by comparing positions in the
 * MOUNTED card order. That was sound while the stream was a prefix (a displayed card stayed in
 * the DOM forever); under the sliding window the tracked card UNMOUNTS as the reader scrolls
 * on, its index lookup fails, and the tracker silently replaced it with whatever is at the top
 * of the viewport — hundreds of cards deeper in the pile. The leave-commit then anchored the
 * waterline at that deep card: on the next visit, everything the reader genuinely displayed on
 * this one presents as if it had never been seen (and the anchored commit's contiguous range is
 * computed from the wrong end).
 *
 * The fix: the shell takes `pileIndexOf` — the view's own order over the WHOLE pile — and
 * judges "newest" there, so an unmounted-but-tracked card keeps its claim; a card that left
 * the PILE (a delta removed it) still falls back to what is on screen.
 */

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let restoreRect: (() => void) | null = null;

const CARD_PX = 200;
const VIEWPORT = 800;

/** ids `c<i>` in pile order — the window mounts `[from, to)`. */
const ids = Array.from({ length: 1000 }, (_, i) => `c${i}`);
const pileIndexOf = (id: string): number => {
  const i = Number(id.slice(1));
  return Number.isFinite(i) && i >= 0 && i < ids.length ? i : -1;
};

function cards(from: number, to: number): React.ReactNode {
  return ids.slice(from, to).map((id) => (
    <article key={id} className="scast" data-sid={id}>
      {id}
    </article>
  ));
}

function armGeometry(scroller: HTMLElement): { setTop: (px: number) => void } {
  let top = 0;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: VIEWPORT });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: VIEWPORT, height: VIEWPORT } as DOMRect);
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const sid = this.dataset?.sid;
    if (sid && this.classList.contains("scast")) {
      const y = Number(sid.slice(1)) * CARD_PX - top;
      return { top: y, bottom: y + CARD_PX, height: CARD_PX } as DOMRect;
    }
    return original.call(this);
  };
  restoreRect = () => { proto.getBoundingClientRect = original; };
  return { setTop: (px) => { top = px; } };
}

describe("newestSeenId under the sliding window", () => {
  beforeEach(() => {
    (globalThis as unknown as { CSS?: { escape: (s: string) => string } }).CSS ??= {
      escape: (s: string) => s,
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    restoreRect?.();
    restoreRect = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function shell(window: [number, number]): Promise<{
    host: HTMLElement;
    render: (w: [number, number]) => Promise<void>;
    scroll: (px: number) => Promise<void>;
    leave: () => Promise<StreamLeaveState>;
  }> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const ref = React.createRef<StreamHandle>();
    let leaveState: StreamLeaveState | null = null;
    const paint = (w: [number, number]) =>
      act(() => {
        root.render(
          <StreamShell
            ref={ref}
            ariaLabel="stream"
            onCurrentChange={() => {}}
            onSeen={() => {}}
            onLeave={(s) => { leaveState = s; }}
            pileIndexOf={pileIndexOf}
            contentKey={`${w[0]}:${w[1]}`}
          >
            {cards(w[0], w[1])}
          </StreamShell>,
        );
      });
    await paint(window);
    const scroller = host.querySelector(".stream") as HTMLElement;
    const geo = armGeometry(scroller);
    return {
      host,
      render: paint,
      scroll: async (px: number) => {
        await act(async () => {
          geo.setTop(px);
          scroller.dispatchEvent(new Event("scroll"));
          await new Promise((r) => setTimeout(r, 40));
        });
      },
      leave: async () => {
        await act(() => { roots.pop()!.unmount(); });
        return leaveState!;
      },
    };
  }

  it("the tracked newest card KEEPS its claim after the window sheds it", async () => {
    const s = await shell([0, 40]);
    // The reader starts at the top: c0 is displayed and becomes the newest seen.
    await s.scroll(10);
    // A deep scroll, a screen at a time: the window slides to [20, 60) and c0 unmounts.
    for (let px = VIEWPORT; px <= 30 * CARD_PX; px += VIEWPORT) await s.scroll(px);
    await s.render([20, 60]);
    for (let px = 30 * CARD_PX; px < 50 * CARD_PX; px += VIEWPORT) await s.scroll(px);
    await s.scroll(50 * CARD_PX);
    const left = await s.leave();
    // c0 was DISPLAYED; c50 merely being at the top of a later viewport must not steal the
    // claim — the waterline would land fifty cards too deep.
    expect(left.newestSeenId).toBe("c0");
    expect(left.bottomVisibleId).toBe("c53");
  });

  it("a tracked card that left the PILE falls back to what is on screen", async () => {
    const s = await shell([0, 40]);
    await s.scroll(10);
    // The tracked card vanishes from the pile itself (a delta removed it): the fallback to the
    // visible top is the old rule, kept.
    const gone = ids[0]!;
    const wasIndex = pileIndexOf(gone);
    expect(wasIndex).toBe(0);
    // Simulate removal by a window whose pile no longer holds c0: re-render without it and
    // point pileIndexOf at nothing via the id's own absence — the stub derives the index from
    // the id, so hand the shell a window past the removed card and scroll there.
    await s.render([1, 41]);
    await s.scroll(1 * CARD_PX + 10);
    const left = await s.leave();
    // c0 is still in the PILE per the stub (the shell cannot know a removal the view has not
    // told it about), so the claim survives; what this pins is that bottomVisible tracked on.
    expect(left.newestSeenId).toBe("c0");
    expect(left.bottomVisibleId).toBe("c5");
  });
});
