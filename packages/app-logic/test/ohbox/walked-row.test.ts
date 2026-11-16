/** @vitest-environment jsdom */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineMessage, ThreadMark } from "@ohmail/client-engine";
import { useWalkedSquares, type WalkedSquares } from "../../src/ohbox/walked-row.js";
import { createThreadWalkChannel, type ThreadWalkChannel } from "../../src/reading/thread-walk-channel.js";
import { act, msg } from "./harness.js";

/*
 * THE WALKED ROW'S SQUARES: the conversation as it stands, asked once a change of what the squares draw, never
 * once a step of the reader's ring.
 */

let root: Root | null = null;
afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
});

const letters = [msg({ id: "a", unread: false }), msg({ id: "b" }), msg({ id: "c" })];

function world() {
  const walk: ThreadWalkChannel = createThreadWalkChannel();
  const asked: string[] = [];
  let conversation: readonly EngineMessage[] = letters;
  const conversationOf = (id: string) => {
    asked.push(id);
    return conversation;
  };
  const seen: Array<WalkedSquares | null> = [];
  const row = { members: [letters[2]!], openTarget: letters[2]! };
  function Probe({ marks }: { marks: readonly ThreadMark[] }) {
    seen.push(useWalkedSquares({ walk, stripOpen: () => undefined, conversationOf }, row, marks));
    return null;
  }
  const draw = (marks: readonly ThreadMark[]) =>
    act(() => {
      root ??= createRoot(document.createElement("div"));
      root.render(React.createElement(Probe, { marks }));
    });
  return {
    walk,
    asked,
    draw,
    last: () => seen[seen.length - 1] ?? null,
    replace: (next: readonly EngineMessage[]) => {
      conversation = next;
    },
  };
}

describe("the walked row's squares", () => {
  it("a step of the ring moves it and asks the conversation nothing", async () => {
    const w = world();
    await w.draw(["read", "unread", "unread"]);
    await act(() => w.walk.publish({ messages: letters, here: "c", openedId: "c" }));
    expect(w.last()?.marks).toEqual(["read", "unread", "unread"]);
    expect(w.last()?.here).toBe(2);
    const once = w.asked.length;
    expect(once).toBeGreaterThan(0);
    await act(() => w.walk.publish({ messages: letters, here: "b", openedId: "c" }));
    await act(() => w.walk.publish({ messages: letters, here: "a", openedId: "c" }));
    expect(w.last()?.here).toBe(0);
    expect(w.asked.length).toBe(once);
  });

  it("a change of the row's own marks asks again and draws the conversation as it stands", async () => {
    const w = world();
    await w.draw(["read", "unread", "unread"]);
    await act(() => w.walk.publish({ messages: letters, here: "c", openedId: "c" }));
    const once = w.asked.length;
    w.replace([letters[0]!, { ...letters[1]!, unread: false }, letters[2]!]);
    await w.draw(["read", "read", "unread"]);
    expect(w.asked.length).toBeGreaterThan(once);
    expect(w.last()?.marks).toEqual(["read", "read", "unread"]);
    expect(w.last()?.here).toBe(2);
  });
});
