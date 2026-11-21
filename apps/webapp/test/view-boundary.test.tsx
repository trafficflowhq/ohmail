/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ViewBoundary } from "../app/components/ViewBoundary";

/**
 * THE PER-VIEW ERROR BOUNDARY IS LOAD-BEARING, NOT DECORATION.
 *
 * A render throw in a pile used to unwind to Next's root and paint the entire tab as the client-
 * side "Application error" — rail, sync strip and every way out gone with it. `ViewBoundary` keeps
 * that throw inside the pane. The proof has two halves, both here: WITHOUT the boundary a throwing
 * render escapes to the caller (so the guard has something real to stop), and WITH it the throw
 * becomes an in-pane fallback while a sibling — standing in for the rail — is untouched.
 */

function Throws(): React.ReactElement {
  throw new Error("view render blew up");
}

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => root.render(node as React.ReactElement));
  return host;
}

describe("a per-view error boundary keeps a render throw in the pane, with the rail alive", () => {
  beforeEach(() => {
    // React logs the caught error loudly; the throw is what is under test, not the log.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("without the boundary, a throwing view render escapes to the caller", async () => {
    let escaped: unknown = null;
    try {
      await render(<Throws />);
    } catch (e) {
      escaped = e;
    }
    expect(escaped, "a raw throwing render did not escape — the boundary below would prove nothing")
      .not.toBeNull();
  });

  it("with the boundary, the throw becomes an in-pane fallback and a sibling survives", async () => {
    const host = await render(
      <div>
        <nav className="rail" />
        <ViewBoundary fallback={<div className="view-fail">failed</div>}>
          <Throws />
        </ViewBoundary>
      </div>,
    );
    expect(host.querySelector(".view-fail"), "the fallback did not render").not.toBeNull();
    expect(host.querySelector(".rail"), "the throw took the rail down with it").not.toBeNull();
  });

  it("reports what it caught, for a log line", async () => {
    let caught: unknown = null;
    await render(
      <ViewBoundary onError={(e) => { caught = e; }} fallback={<div className="view-fail" />}>
        <Throws />
      </ViewBoundary>,
    );
    expect((caught as Error | null)?.message).toBe("view render blew up");
  });
});
