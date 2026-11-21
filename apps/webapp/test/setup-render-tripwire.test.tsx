/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act, useEffect, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ViewBoundary } from "../app/components/ViewBoundary";
import {
  RENDER_COMMIT_CEILING,
  RenderLoopError,
  createRootWithTripwire,
  renderCommits,
  resetRenderTripwire,
  withRenderTripwire,
} from "./setup-render-tripwire";

/**
 * ═══ A RENDER LOOP MUST FAIL BY NAME, NOT BY CLOCK ═════════════════════════════════════════════
 *
 * A frontend fix planted a true update loop in the composer twice and got the same reading
 * both times: the file ran past four minutes to the suite's timeout with NO assertion reached, and
 * a render counter placed inside the tree never fired, because React's own "Maximum update depth
 * exceeded" lands in `ViewBoundary` — which is exactly what that boundary is for. The lane removed
 * its tripwire rather than ship a guard it had watched not fire, and filed the row.
 *
 * The two loops behave differently and the arms keep them apart. A LAYOUT-effect loop is bounded
 * by React at fifty nested updates, so it ends — inside the boundary, with the fallback painted
 * and nothing named. A PASSIVE-effect loop is not bounded at all: written here without the
 * tripwire it took a vitest worker to an out-of-memory death at 120 s, which is the reading this
 * guard replaces, so it is driven only through the tripwire.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  try {
    act(() => root?.unmount());
  } catch {
    /* A root the tripwire tore down has nothing left to unmount. */
  }
  root = null;
  host?.remove();
  host = null;
  resetRenderTripwire();
});

/** The loop the lane could not drive in the real composer: an effect that writes on every render. */
function PingPong(): React.ReactElement {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN((v) => v + 1);
  });
  return <p>pings {n}</p>;
}

/** The same loop one hook to the left, where React's own nested-update limit ends it. */
function LayoutPingPong(): React.ReactElement {
  const [n, setN] = useState(0);
  useLayoutEffect(() => {
    setN((v) => v + 1);
  });
  return <p>layout {n}</p>;
}

/** Ordinary work: fifty deltas in one window, the walk the composer's real cost was measured on. */
function FiftyDeltas({ onDone }: { onDone: (n: number) => void }): React.ReactElement {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n < 50) setN(n + 1);
    else onDone(n);
  }, [n, onDone]);
  return <p>deltas {n}</p>;
}

describe("the render-loop tripwire at the renderer root", () => {
  it("names the component and the count when an UNBOUNDED loop runs under a real ViewBoundary", () => {
    const el = mount();
    root = createRoot(el);
    const started = Date.now();
    let caught: unknown = null;
    resetRenderTripwire();
    try {
      act(() => {
        root!.render(
          withRenderTripwire(
            <ViewBoundary fallback={<p>the boundary caught it</p>}>
              <PingPong />
            </ViewBoundary>,
            { id: "PingPong" },
          ),
        );
      });
    } catch (e) {
      caught = e;
    }
    const seconds = (Date.now() - started) / 1000;
    expect(caught, "the loop did not reach the tripwire").toBeInstanceOf(RenderLoopError);
    const err = caught as RenderLoopError;
    expect(err.component).toBe("PingPong");
    expect(err.commits).toBeGreaterThan(RENDER_COMMIT_CEILING);
    expect(err.message).toContain("render loop: <PingPong> committed");
    expect(err.message).toContain("ABOVE every ViewBoundary");
    /* THE CLOCK IS THE POINT. A guard that answers after the suite's timeout IS the timeout. */
    expect(seconds, `the tripwire took ${seconds}s`).toBeLessThan(5);
  });

  it("is a reading of the tripwire: without it a bounded loop is swallowed and names nothing", () => {
    const el = mount();
    root = createRoot(el);
    const seen: unknown[] = [];
    let threw: unknown = null;
    try {
      act(() => {
        root!.render(
          <ViewBoundary fallback={<p>the boundary caught it</p>} onError={(e) => seen.push(e)}>
            <LayoutPingPong />
          </ViewBoundary>,
        );
      });
    } catch (e) {
      threw = e;
    }
    /* React's nested-update limit fires and the BOUNDARY takes it: nothing reaches the caller, the
     * fallback is all that is on screen, and the message names React's rule, never the component.
     * That is the state the row was filed for. */
    expect(threw, "the throw escaped the boundary — this fixture no longer reproduces the defect").toBeNull();
    expect(seen.length, "the boundary caught nothing, so the fixture did not loop").toBeGreaterThan(0);
    expect(el.textContent).toContain("the boundary caught it");
    expect(String(seen[0])).toContain("Maximum update depth exceeded");
    expect(String(seen[0])).not.toContain("LayoutPingPong");
  });

  it("and WITH it the same bounded loop is named, because the tripwire sits above the boundary", () => {
    const el = mount();
    root = createRoot(el);
    let caught: unknown = null;
    resetRenderTripwire();
    try {
      act(() => {
        root!.render(
          withRenderTripwire(
            <ViewBoundary fallback={<p>the boundary caught it</p>}>
              <LayoutPingPong />
            </ViewBoundary>,
            { id: "LayoutPingPong", ceiling: 20 },
          ),
        );
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RenderLoopError);
    expect((caught as RenderLoopError).component).toBe("LayoutPingPong");
    expect((caught as RenderLoopError).commits).toBe(21);
  });

  it("admits fifty deltas in one window — the walk the composer's real cost was measured on", () => {
    const el = mount();
    const done: number[] = [];
    root = createRootWithTripwire(el, { id: "FiftyDeltas" });
    act(() => {
      root!.render(<FiftyDeltas onDone={(n) => done.push(n)} />);
    });
    expect(done).toEqual([50]);
    expect(el.textContent).toContain("deltas 50");
    const commits = renderCommits("FiftyDeltas");
    expect(commits).toBeGreaterThan(1);
    expect(
      commits,
      `fifty deltas cost ${commits} commits and the ceiling is ${RENDER_COMMIT_CEILING}`,
    ).toBeLessThanOrEqual(RENDER_COMMIT_CEILING);
  });
});
