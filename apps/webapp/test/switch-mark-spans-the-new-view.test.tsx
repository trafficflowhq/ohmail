/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  beginSwitch,
  resetUiVitalsForTest,
  takeUiVitals,
  useSwitchEnd,
} from "@ohmail/app-logic/session/ui-vitals";
import {
  go,
  goAddress,
  goFolder,
  goScreener,
  goTag,
  goTriage,
  parseHash,
  switchKeyOf,
} from "../app/shell/routing";

/**
 * ═══ A SWITCH IS MEASURED TO THE NEW VIEW BEING ON SCREEN ════════════════════════════════════
 *
 * `ui-vitals.test.ts` drives the mark's two ends directly. What it cannot show is that a REAL
 * React switch puts the deriving-and-committing of the target view INSIDE the reading — which is
 * the whole of the correction: the mark used to end two frames after the press, so everything the
 * new view cost was outside it (130 ms by the app's own p95 against 1 942 ms by the driver
 * watching the view arrive, Linux 0.19.0).
 *
 * So the switch here is driven through a renderer: the press, a view that costs time to render,
 * the layout commit that puts its first row in the document, and the paint. Restore the two-frame
 * end in `beginSwitch` and the recorded duration collapses to the press's own frame.
 *
 * The second half is the KEY. Both ends spell the view through `switchKeyOf`, so a verb that
 * writes one hash and a shell that renders another would leave the mark hanging for ever. Each
 * verb is driven and ended with the key the shell derives from the hash it actually wrote.
 */

/** React refuses to recognise `act` without it, and prints a warning per render instead. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let clock = 0;
let frames: FrameRequestCallback[] = [];
let container: HTMLDivElement;
let root: Root;

/** Run every scheduled frame callback once — `afterPaint` needs two of these. */
function paint(): void {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb(clock);
}

beforeEach(() => {
  clock = 0;
  frames = [];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetUiVitalsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The cost the target view pays before its rows exist — charged in the render, as a derivation is. */
function Rows({ cost, count }: { cost: number; count: number }) {
  clock += cost;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} data-row={i}>
          row {i}
        </div>
      ))}
    </>
  );
}

/**
 * The shell's own shape: one `useSwitchEnd` for every view, keyed by the route, `null` while the
 * target view has nothing of its own on screen.
 */
function Shell({ view, ready, cost }: { view: string; ready: boolean; cost: number }) {
  useSwitchEnd(ready ? view : null);
  return <div>{ready ? <Rows cost={cost} count={3} /> : <span>loading</span>}</div>;
}

describe("the switch mark spans the target view's commit", () => {
  it("charges the new view's own render to the switch, and ends at the paint after it", () => {
    act(() => root.render(<Shell view="#/ohbox" ready cost={0} />));
    paint();
    paint();
    expect(takeUiVitals().switchCount, "the first view of a session is not a switch").toBe(0);

    clock = 1_000;
    beginSwitch("#/screener");
    clock += 5; // the hash write and the re-render React schedules for it
    act(() => root.render(<Shell view="#/screener" ready cost={400} />));
    // The rows are in the document and nothing is recorded yet: the paint is still owed.
    expect(container.querySelectorAll("[data-row]").length).toBe(3);
    expect(takeUiVitals().switchCount).toBe(0);

    clock += 16;
    paint();
    paint();
    const report = takeUiVitals();
    expect(report.switchCount).toBe(1);
    // 5 (the navigation) + 400 (deriving the view) + 16 (the paint). A mark that ends two frames
    // after the press reads the 5 and calls the switch fast.
    expect(report.switchP95Ms).toBe(421);
  });

  it("waits for the rows when the target view arrives with nothing to show", () => {
    act(() => root.render(<Shell view="#/ohbox" ready cost={0} />));
    paint();
    paint();

    clock = 2_000;
    beginSwitch("#/folder/f1");
    clock += 3;
    // The folder is on screen as a spinner: `useSwitchEnd` is passed `null`, and a spinner is
    // not the view somebody pressed for.
    act(() => root.render(<Shell view="#/folder/f1" ready={false} cost={0} />));
    clock += 240;
    paint();
    paint();
    expect(takeUiVitals().switchCount, "a placeholder ends no switch").toBe(0);

    act(() => root.render(<Shell view="#/folder/f1" ready cost={30} />));
    clock += 16;
    paint();
    paint();
    const report = takeUiVitals();
    expect(report.switchCount).toBe(1);
    // The whole wait — the press, the fetch the spinner covered, the rows and the paint.
    expect(report.switchP95Ms).toBe(3 + 240 + 30 + 16);
  });

  it("records the second press and not the view nobody waited for", () => {
    act(() => root.render(<Shell view="#/ohbox" ready cost={0} />));
    paint();
    paint();

    clock = 5_000;
    beginSwitch("#/screener");
    clock += 100;
    beginSwitch("#/reads"); // a second press before the screener ever committed
    clock += 20;
    act(() => root.render(<Shell view="#/reads" ready cost={50} />));
    clock += 16;
    paint();
    paint();
    const report = takeUiVitals();
    expect(report.switchCount, "one reading, not two and not none").toBe(1);
    expect(report.switchP95Ms, "measured from the press that was answered").toBe(20 + 50 + 16);
  });

  it("times a press back to the view it left while the new one was still a placeholder", () => {
    act(() => root.render(<Shell view="#/ohbox" ready cost={0} />));
    paint();
    paint();

    clock = 7_000;
    beginSwitch("#/folder/f1");
    act(() => root.render(<Shell view="#/folder/f1" ready={false} cost={0} />));
    clock += 100;
    beginSwitch("#/ohbox"); // the Ohbox is no longer on screen, so this is a real wait
    clock += 20;
    act(() => root.render(<Shell view="#/ohbox" ready cost={30} />));
    clock += 16;
    paint();
    paint();
    const report = takeUiVitals();
    expect(report.switchCount, "a press back to the view left behind went untimed").toBe(1);
    expect(report.switchP95Ms).toBe(20 + 30 + 16);
  });
});

describe("both ends of the mark spell the view the same way", () => {
  /**
   * The verb writes a hash; the shell renders the route that hash parses to and ends the mark
   * with `switchKeyOf` over it. Driving the real verbs and ending with the real derivation is
   * what proves the pair — a key spelled by hand in either place would leave the mark pending
   * and `switchCount` at zero.
   */
  const verbs: [name: string, drive: () => void][] = [
    ["go", () => go("reads")],
    ["goTag", () => goTag("pottery")],
    ["goFolder", () => goFolder("fld_1")],
    ["goAddress", () => goAddress("someone@example.test")],
    ["goScreener", () => goScreener("spam")],
    ["goTriage", () => goTriage("aside")],
  ];

  for (const [name, drive] of verbs) {
    it(`${name}'s key is the one the shell derives from the hash it wrote`, () => {
      clock = 10;
      drive();
      clock += 40;
      const rendered = switchKeyOf(parseHash(window.location.hash));
      act(() => root.render(<Shell view={rendered} ready cost={0} />));
      clock += 16;
      paint();
      paint();
      const report = takeUiVitals();
      expect(report.switchCount, `${name} started a mark this key cannot end`).toBe(1);
      expect(report.switchP95Ms).toBe(56);
    });
  }

  it("a screener SEGMENT is its own place, and the segment the verb wrote is the one that ends it", () => {
    clock = 0;
    goScreener("screened");
    act(() => root.render(<Shell view={switchKeyOf(parseHash("#/screener"))} ready cost={0} />));
    paint();
    paint();
    expect(takeUiVitals().switchCount, "the waiting segment is not the screened one").toBe(0);
  });
});
