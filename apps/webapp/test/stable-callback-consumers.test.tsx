/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { shellFrameOf } from "./source-anchor.js";

/**
 * THE ONE CONVERSION THAT IS NOT A RENAME: a callback that is a FACTORY.
 *
 * `AppShell`'s `commitFeedSeen` does not do the work; it RETURNS the function that does, closed
 * over that render's engine and glance batches. Its two consumers used to be
 *
 *     const commitReadsSeen = useMemo(() => commitFeedSeen("reads"), [commitFeedSeen]);
 *
 * which is correct exactly as long as `commitFeedSeen`'s identity still moves. Give the factory a
 * stable identity — which is the whole point of the change this file guards — and that dependency
 * never changes again, so the memo runs ONCE and both consumers keep the FIRST render's inner
 * closure for the life of the tab. Every later "mark this stream seen" would then be handed to an
 * engine that has been replaced, and nothing would throw: the marks would simply stop landing, and
 * the stream would keep re-showing mail the reader had already seen.
 *
 * That is the classic failure of this pattern and it is invisible to a type checker, so it is
 * guarded from two directions:
 *
 *  1. BEHAVIOUR — both shapes are built here over the real hook, and the test asserts they differ.
 *     The broken shape is kept deliberately: a test in which every arm passes cannot show that it
 *     can tell the arms apart. If a future edit to `useStableCallback` made the memo shape correct
 *     too, `the memo shape is what this avoids` goes red rather than quietly agreeing.
 *  2. SOURCE — the shape assertion below pins `AppShell`'s consumers to applying the factory
 *     INSIDE the call. The behavioural arm cannot see `AppShell` being reverted; this can.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Stands in for the engine: the only thing that matters is WHICH one received the mark. */
type Engine = { id: string; marks: string[] };

/**
 * The shell's shape, reduced to the seam under test: a stable factory, and a consumer built the
 * fixed way (applies the factory per call) or the historical way (memoises the application).
 */
function makeProbe(consumer: "applies-per-call" | "memoised") {
  let commit: ((upToId: string) => void) | null = null;

  function Probe({ engine }: { engine: Engine }): React.ReactElement {
    const commitFeedSeen = useStableCallback((view: string) => (upToId: string) => {
      engine.marks.push(`${view}:${upToId}`);
    });

    /* THE FIX: the factory is applied inside the call, so every call rebuilds the inner closure
       over the CURRENT engine. */
    const applied = useStableCallback((upToId: string) => commitFeedSeen("reads")(upToId));

    /* THE DEFECT: applied once. With a stable `commitFeedSeen` the dependency never moves again,
       so this holds the first render's inner closure — and the first render's engine — for ever. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const memoised = React.useMemo(() => commitFeedSeen("reads"), [commitFeedSeen]);

    commit = consumer === "applies-per-call" ? applied : memoised;
    return h("div", null, engine.id);
  }

  return { Probe, get commit() { return commit; } };
}

async function renderThenReplaceEngine(consumer: "applies-per-call" | "memoised"): Promise<Engine> {
  const probe = makeProbe(consumer);
  const first: Engine = { id: "first", marks: [] };
  const second: Engine = { id: "second", marks: [] };

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => { root.render(h(probe.Probe, { engine: first })); });
  // The engine is replaced, exactly as a reconnect or a re-provision replaces it in the shell.
  await act(async () => { root.render(h(probe.Probe, { engine: second })); });

  // Captured BEFORE the call, the way a child holds the prop it was handed.
  const commit = probe.commit!;
  await act(async () => { commit("m-42"); });

  root.unmount();
  // The first engine must be untouched by anything that ran after it was replaced.
  expect(first.marks.length + second.marks.length, "the mark went nowhere").toBe(1);
  return second.marks.length === 1 ? second : first;
}

describe("a stable factory's consumers", () => {
  it("reach the CURRENT engine after a re-render", async () => {
    const reached = await renderThenReplaceEngine("applies-per-call");
    expect(reached.id).toBe("second");
    expect(reached.marks).toEqual(["reads:m-42"]);
  });

  it("the memo shape is what this avoids: it reaches the engine that has been replaced", async () => {
    /* The positive control for the arm above. This is not a wish about how the code should
       behave — it is the measured behaviour of the shape `AppShell` used to have, and it is what
       makes the first assertion mean something. */
    const reached = await renderThenReplaceEngine("memoised");
    expect(reached.id).toBe("first");
  });

  it("the shell's two stream commits apply the factory inside the call", () => {
    /* The two lines moved to `shell-open-state.ts` with the batchers they close over; the frame
       is resolved from the manifest, so the verbatim match follows them. */
    const shell = shellFrameOf("commitReadsSeen").source;

    for (const [name, view] of [["commitReadsSeen", "reads"], ["commitReceiptsSeen", "receipts"]] as const) {
      expect(
        shell,
        `${name} must apply commitFeedSeen per call, not memoise the application`,
      ).toContain(`const ${name} = useStableCallback((commit: FeedSeenCommit) => commitFeedSeen("${view}")(commit));`);
    }

    /* And the shape it must NOT go back to. Named explicitly so a revert is caught by this test
       rather than by a reader noticing mail stops being marked seen.
       Anchored on a DECLARATION at the start of a line, because the block comment above those two
       lines quotes the broken shape in order to explain it — and an unanchored match reads that
       explanation as the defect. A comment line begins `*`, never `const`. */
    expect(shell).not.toMatch(/^\s*const \w+ = useMemo\(\(\) => commitFeedSeen\(/m);
  });
});
