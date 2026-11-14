/** @vitest-environment jsdom */
/**
 * TWO LIVE TRASH WINDOWS STAND UNTIL TRASH IS SEATED: the web shell's (`shell/trash-window.ts`) and the place's
 * (`@ohmail/app-logic/trash`, the same window with its wire required). One sequence of wire answers is played to both
 * and every reading must agree: the rows, the state, the cursor, a reset, a failed page, a body read once.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTrashWindow as usePlaceWindow, trashLiveState as placeState } from "@ohmail/app-logic/trash";
import type { TrashWindowItemWire, TrashWindowPageWire } from "../app/api-client";
import { trashLiveState as shellState, useTrashWindow as useShellWindow, type TrashWire } from "../app/shell/trash-window";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const item = (uid: number, origin: "ohmail" | "provider" = "provider"): TrashWindowItemWire => ({
  mailboxId: "mb",
  uid,
  uidValidity: "7",
  subject: `Letter ${uid}`,
  from: { name: null, address: "someone@ex.example" },
  date: "2026-08-02T09:00:00.000Z",
  messageIdHeader: null,
  seen: true,
  origin,
});

/** A scripted wire: each list answers the next page of the script (or fails); every ask is counted. */
function scripted(pages: Array<TrashWindowPageWire | "fail">) {
  const asked: string[] = [];
  let at = 0;
  const wire: TrashWire = {
    list: async (opts) => {
      asked.push(`list:${opts?.cursor ?? "-"}`);
      const page = pages[at++];
      if (page === undefined || page === "fail") throw new Error("no answer");
      return page;
    },
    body: async (_m, uid) => {
      asked.push(`body:${uid}`);
      return { subject: "", text: `text ${uid}` };
    },
  };
  return { wire, asked };
}

const box = (window: "ok" | "no_trash_folder" | "unreachable" = "ok", reset?: boolean) => ({
  id: "mb",
  address: "a@ex.example",
  window,
  ...(reset ? { reset } : {}),
});

const SCRIPT: Array<TrashWindowPageWire | "fail"> = [
  { mailboxes: [box()], items: [item(1), item(2, "ohmail"), item(3)], nextCursor: "c1" },
  { mailboxes: [box()], items: [item(3), item(4)], nextCursor: "c2" },
  "fail",
  { mailboxes: [box("ok", true)], items: [item(9)], nextCursor: null },
  { mailboxes: [box("unreachable")], items: [], nextCursor: null },
];

async function play(use: (wire: TrashWire) => ReturnType<typeof useShellWindow>, state: typeof shellState) {
  const { wire, asked } = scripted(SCRIPT);
  const h = renderHook(() => use(wire));
  const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
  const reading = () => ({
    phase: h.result.current.phase,
    keys: h.result.current.items.map((i) => i.uid),
    cursor: h.result.current.nextCursor,
    state: state(h.result.current).state,
  });
  const seen: unknown[] = [];
  await flush();
  seen.push(reading());
  act(() => h.result.current.loadOlder());
  await flush();
  seen.push(reading());
  act(() => h.result.current.loadOlder());
  await flush();
  seen.push(reading());
  act(() => h.result.current.openBody(h.result.current.items[0]!));
  act(() => h.result.current.openBody(h.result.current.items[0]!));
  await flush();
  seen.push(h.result.current.bodyFor(h.result.current.items[0]!));
  act(() => h.result.current.reload());
  await flush();
  seen.push(reading());
  act(() => h.result.current.reload());
  await flush();
  seen.push(reading());
  h.unmount();
  return { seen, asked };
}

describe("the place's live Trash window and the web shell's agree", () => {
  it("on every reading of one sequence, and on every ask made of the wire", async () => {
    const shell = await play((wire) => useShellWindow(true, wire), shellState);
    const place = await play((wire) => usePlaceWindow(true, wire), placeState);
    expect(place).toEqual(shell);
    expect(shell.seen[0]).toMatchObject({ keys: [1, 3], state: "rows" });
  });

  it("the place's window with `none` asks nothing; the shell's has no such answer and needs a wire", async () => {
    const h = renderHook(() => usePlaceWindow(true, "none"));
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.supported).toBe(false);
    expect(h.result.current.items).toEqual([]);
  });
});
