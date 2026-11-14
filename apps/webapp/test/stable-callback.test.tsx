/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";

/**
 * THE THREE PROPERTIES `useStableCallback` IS FOR, AND THE THIRD IS THE ONE THAT MATTERS.
 *
 * Identity stability and reading the latest value are the ordinary reasons for a hook like this,
 * and both are asserted below. The third is the reason it exists at all
 * (the project's design notes §2): the implementation from an earlier render must become
 * UNREACHABLE once a newer one arrives. A `useCallback` that survives a render pins the whole
 * render scope it was created in — in `AppShell` that is a consent partition and a projection over
 * every message in the mailbox — and the chain gains a link per render.
 *
 * The census is a `WeakRef` per render's implementation plus a forced collect, so it measures
 * reachability rather than intent. It obtains its own collector (see `collectGarbage`) rather than
 * requiring a runner flag, and throws rather than proceeding without one.
 *
 * Mutations watched:
 *  · replace the hook's body with `useCallback(fn, [fn])`
 *    → RED: "keeps one identity" sees 31 identities instead of 1.
 *  · freeze the ref (`latest.current ??= fn`)
 *    → RED, twice: "runs the newest implementation" answers 100 where 101 is owed, and the
 *      reachability census finds the first implementation still live.
 *  · move `forwardTo` back inside the hook
 *    → STILL GREEN, and that is recorded rather than hidden. It was expected to fire on the
 *      premise that the inlined closure's scope would also hold `fn`; it does not, because the JS engine
 *      context-allocates only the variables an inner closure REFERENCES, and that one references
 *      `latest` alone. The module-scope factory is therefore robustness, not the mechanism — see
 *      the hook's header, which was corrected to say so.
 */

/**
 * A COLLECTOR THIS FILE OBTAINS FOR ITSELF, rather than a `--expose-gc` the runner has to be
 * told to pass.
 *
 * Nothing else in the repo needs `--expose-gc`, and the webapp's tests run from the repo root
 * through the shared `vitest.config.ts`; adding the flag there would change the node arguments of
 * every suite in the monorepo to serve one file. `v8.setFlagsFromString` + a `vm` context hands
 * this file a real collector and puts the flag back, touching no shared configuration.
 *
 * It THROWS when it cannot get one. A census of reachability that quietly proceeds without a
 * collector reports "nothing is live" for the one reason that has nothing to do with the subject.
 */
async function collectGarbage(): Promise<void> {
  let gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (!gc) {
    const v8 = await import("node:v8");
    const vm = await import("node:vm");
    v8.setFlagsFromString("--expose-gc");
    try {
      gc = vm.runInNewContext("gc") as () => void;
    } finally {
      v8.setFlagsFromString("--no-expose-gc");
    }
  }
  if (typeof gc !== "function") throw new Error("no collector: this census measures reachability, and cannot without one");
  /* A WeakRef is not cleared in the job that created or last dereferenced it, so a collect in the
     same turn as the renders reports every implementation live regardless of the hook. */
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  gc();
}

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const N_RENDERS = 30;

function mount(render: (bump: () => void) => void): { root: Root; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  void render;
  return { root, host };
}

describe("useStableCallback", () => {
  it("keeps one identity for the life of the component", async () => {
    const seen: Array<(n: number) => number> = [];
    let bump: () => void = () => {};

    function Probe(): React.ReactElement {
      const [tick, setTick] = React.useState(0);
      bump = () => setTick((n) => n + 1);
      const stable = useStableCallback((n: number) => n + tick);
      seen.push(stable);
      return h("div", null, String(tick));
    }

    const { root } = mount(() => {});
    await act(async () => { root.render(h(Probe)); });
    for (let i = 0; i < N_RENDERS; i++) await act(async () => { bump(); });

    expect(seen.length).toBeGreaterThan(N_RENDERS);
    expect(new Set(seen).size).toBe(1);
    root.unmount();
  });

  it("runs the newest implementation, not the one it was created from", async () => {
    let bump: () => void = () => {};
    let stable: ((n: number) => number) | null = null;

    function Probe(): React.ReactElement {
      const [tick, setTick] = React.useState(0);
      bump = () => setTick((n) => n + 1);
      stable = useStableCallback((n: number) => n + tick);
      return h("div", null, String(tick));
    }

    const { root } = mount(() => {});
    await act(async () => { root.render(h(Probe)); });
    expect(stable!(100)).toBe(100);
    await act(async () => { bump(); });
    expect(stable!(100)).toBe(101);
    await act(async () => { bump(); });
    expect(stable!(100)).toBe(102);
    root.unmount();
  });

  it("read DURING RENDER, it answers with this render's values", async () => {
    /* Two sites in `AppShell` call a stable callback during render — `mirrorHolds` and
       `receiptsIsUnread` (via `.filter`) — so the hook's contract permits it, and a permission
       nobody has watched fail is not one worth granting.
       This is the assertion that would go red if the ref assignment ever moved into an effect:
       the effect runs after commit, so a render-time read would answer with the PREVIOUS commit's
       closure and this test would see the tick before the one it rendered. */
    const seen: number[] = [];
    let bump: () => void = () => {};

    function Probe(): React.ReactElement {
      const [tick, setTick] = React.useState(0);
      bump = () => setTick((n) => n + 1);
      const stable = useStableCallback(() => tick);
      // Called during render, after its own hook call — the shell's shape.
      seen.push(stable());
      return h("div", null, String(tick));
    }

    const { root } = mount(() => {});
    await act(async () => { root.render(h(Probe)); });
    for (let i = 0; i < 3; i++) await act(async () => { bump(); });

    // Every render's read equals that render's tick: no read lags behind its own render.
    expect(seen.length).toBeGreaterThan(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBe(3);
    root.unmount();
  });

  it("drops every earlier implementation, so no render scope survives through it", async () => {
    const impls: Array<WeakRef<object>> = [];
    let bump: () => void = () => {};

    function Probe(): React.ReactElement {
      const [tick, setTick] = React.useState(0);
      bump = () => setTick((n) => n + 1);
      /* A FRESH implementation every render, closing over something big enough to be worth
         releasing — the shape of a real render scope, which holds that render's derivations. */
      const heavy = new Array<number>(2048).fill(tick);
      const impl = (n: number): number => n + heavy.length + tick;
      impls.push(new WeakRef(impl as unknown as object));
      const stable = useStableCallback(impl);
      return h("div", null, String(stable(0)));
    }

    const { root } = mount(() => {});
    await act(async () => { root.render(h(Probe)); });
    for (let i = 0; i < N_RENDERS; i++) await act(async () => { bump(); });
    await collectGarbage();

    const live = impls.filter((r) => r.deref() !== undefined).length;
    // The renders must have actually produced implementations, or a live count of zero would pass
    // for the wrong reason.
    expect(impls.length).toBeGreaterThan(N_RENDERS);
    /* THE FIRST ONE SPECIFICALLY, and not just the total. A bound of "a small constant" is
       satisfied by a hook that pins exactly one old implementation for ever, which is a real
       failure mode wearing a passing number — the frozen-ref mutation is precisely that, and this
       is the assertion that catches it. */
    expect(impls[0]!.deref()).toBeUndefined();
    // And nothing else lingers: only the newest may still be reachable, plus React's alternate.
    expect(live).toBeLessThanOrEqual(3);
    root.unmount();
  });
});
