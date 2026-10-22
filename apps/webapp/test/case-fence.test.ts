/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { setTimeout as sleep } from "node:timers/promises";
import { act, CaseEnded, endCase, tracked } from "./_case-fence";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let orphan: Promise<void> | null = null;
let orphanError: unknown = null;

afterEach(async () => {
  await endCase();
  if (root) await act(() => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe("a body that outlives its case", () => {
  it("leaves a continuation behind, the way a body past its budget does", () => {
    // Parked in a counted wait when its case ends, then reaching for act() with a long scope.
    orphan = (async () => {
      await tracked(sleep(50));
      await act(async () => { await sleep(400); });
    })().catch((e: unknown) => { orphanError = e; });
  });

  it("does not stop the next case's renders from flushing", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { await sleep(200); root!.render(React.createElement("p", null, "first")); });
    await sleep(400);
    await act(() => { root!.render(React.createElement("p", null, "second")); });
    expect(host.textContent, "a render after the orphan's scope did not flush").toBe("second");
    await orphan;
    expect(orphanError, "the orphan's act() was not refused").toBeInstanceOf(CaseEnded);
  });
});
