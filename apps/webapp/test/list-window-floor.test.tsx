/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  ESTIMATED_ROW_PX,
  FALLBACK_VIEWPORT_PX,
  FULL_RANGE_MAX_ROWS,
  MEASURED_FULL_RANGE_MAX_ROWS,
  useListWindow,
  WINDOW_TOP,
} from "../app/shell/list-window";

/**
 * WHICH FLOOR A LIST GETS. A list whose items carry `data-index` is measured row by row, so it
 * windows above MEASURED_FULL_RANGE_MAX_ROWS — a switch into a few hundred rows mounts a
 * screenful. A list that stamps none could only be priced at one height, so it keeps rendering
 * whole up to FULL_RANGE_MAX_ROWS, the 0.19.2 bound. jsdom has no layout: the window runs on its
 * own fallbacks, imported, so a changed estimate cannot pass here by accident.
 */

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The rows a window at the top mounts: the fallback viewport's span plus the overscan below. */
const ROWS_AT_TOP = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1 + 8;

function List({ count, stamp, onRender, tab = "" }: { count: number; stamp: boolean; onRender?: () => void; tab?: string }): React.ReactElement {
  onRender?.();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count });
  return (
    <div ref={scrollerRef} className="scroller" data-row-height={win.rowHeight}>
      <div aria-hidden {...{ [WINDOW_TOP]: "" }} style={{ height: win.padTop }} />
      {Array.from({ length: win.end - win.start }, (_, k) => (
        <div key={tab + (win.start + k)} className="row" data-id={`r${win.start + k}`} {...(stamp ? { "data-index": win.start + k } : {})} />
      ))}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
    </div>
  );
}

let roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  document.body.innerHTML = "";
});

async function mountList(count: number, stamp: boolean): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => root.render(<List count={count} stamp={stamp} />));
  return host;
}
const rowsOf = async (count: number, stamp: boolean): Promise<number> =>
  (await mountList(count, stamp)).querySelectorAll(".row").length;

describe("the window's floor follows what the list measures", () => {
  it("a stamped list longer than its window mounts the window, not the list", async () => {
    expect(ROWS_AT_TOP).toBeLessThan(480);
    expect(await rowsOf(480, true)).toBe(ROWS_AT_TOP);
  });

  it("a list that stamps no index renders whole up to the old bound, and windows past it", async () => {
    expect(await rowsOf(480, false)).toBe(480);
    expect(await rowsOf(FULL_RANGE_MAX_ROWS, false)).toBe(FULL_RANGE_MAX_ROWS);
    expect(await rowsOf(FULL_RANGE_MAX_ROWS + 1, false)).toBe(ROWS_AT_TOP);
  });

  it(`a stamped list of ${MEASURED_FULL_RANGE_MAX_ROWS} rows renders whole, and a longer one windows`, async () => {
    expect(await rowsOf(MEASURED_FULL_RANGE_MAX_ROWS, true)).toBe(MEASURED_FULL_RANGE_MAX_ROWS);
    const over = await rowsOf(MEASURED_FULL_RANGE_MAX_ROWS + ROWS_AT_TOP, true);
    expect(over).toBe(ROWS_AT_TOP);
  });

  /* THE WORK A SWITCH INTO A LIST DRAWN WHOLE PAYS BEFORE PAINT: one render, each row's height and
     the origin read once. Its sums show nothing on screen, so what the reads learn re-renders it
     after paint; a second synchronous render re-read every row inside the click (a Screener tab's
     first switch paid that). Read with `flushSync`, which returns once the commit's synchronous work
     is done: before paint. Mutation watched red: the update back on a synchronous render (2 renders,
     22 reads). The first read itself forces the new tab's layout, which whoever reads first pays. */
  it("a switch into a list drawn whole renders once and reads each row once before paint; a window re-prices", async () => {
    let reads = 0;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const rect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) { reads += 1; return this.classList.contains("row") ? 40 : 0; },
    });
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element) { reads += 1; return (rect!.value as () => DOMRect).call(this); },
    });
    const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const env = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);
      let renders = 0;
      const show = (count: number, tab: string) => {
        renders = 0;
        reads = 0;
        flushSync(() => root.render(<List count={count} tab={tab} stamp onRender={() => { renders += 1; }} />));
        return { renders, reads };
      };
      const rowHeight = () => host.querySelector<HTMLElement>(".scroller")!.dataset.rowHeight;
      expect(show(10, "a"), "10 rows and the origin, once, in one render").toEqual({ renders: 1, reads: 11 });
      await painted();
      expect(rowHeight(), "the measurement never reached the sums").toBe("40");
      expect(show(12, "b"), "a switch to 12 other rows").toEqual({ renders: 1, reads: 13 });
      await painted();
      const windowed = show(MEASURED_FULL_RANGE_MAX_ROWS + 200, "c");
      expect(windowed.reads, "control: a window measures its slice before paint").toBeGreaterThanOrEqual(ROWS_AT_TOP);
      expect(windowed.renders, "control: and re-prices it before paint").toBeGreaterThan(1);
      expect(rowHeight()).toBe("40");
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
      if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
      if (rect) Object.defineProperty(Element.prototype, "getBoundingClientRect", rect);
    }
  });

  it("a measured list is the scroller's one anchor: the browser's own anchoring is off there", async () => {
    const anchorOf = async (stamp: boolean) =>
      ((await mountList(480, stamp)).querySelector(".scroller") as HTMLElement).style.overflowAnchor;
    expect(await anchorOf(true)).toBe("none");
    expect(await anchorOf(false), "a list that stamps nothing keeps the browser's anchoring").toBe("");
  });
});
