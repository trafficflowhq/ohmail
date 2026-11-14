/** @vitest-environment jsdom */
/**
 * WHAT THIS TAB TOOK AWAY ITSELF (the switch's point 66): the one press seam keeps, for the session, the
 * letters its own deleting verbs sent away (a delete once its window closed, a move to another folder), so that a
 * tombstone one of them left is this tab's own and never said to be "moved or deleted elsewhere". A letter nobody
 * here pressed is not this tab's, and a delete taken back by its Undo sent nothing away.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_MS } from "@ohmail/app-logic/press/delete-undo";
import { useShellDispatch } from "@ohmail/app-logic/press/shell-dispatch";
import { useOwnGone } from "../../src/frame/index.js";
import { fakeMail, letter } from "../reader/support/fake-mail.js";

function seamOver() {
  const mail = fakeMail([letter("m1"), letter("m2"), letter("m3")]);
  const view = renderHook(() =>
    useShellDispatch({
      engine: mail.engine,
      reader: mail.engine.read(),
      toast: () => undefined,
      t: (key) => key,
      placeLabel: (folder) => folder,
      demo: false,
      refreshFacts: () => undefined,
      scope: "acct-1",
    }),
  );
  view.result.current.rosterRef.current = { kind: "absent" };
  return { mail, seam: () => view.result.current };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => vi.useRealTimers());

describe("the letters this tab's own verbs took away", () => {
  it("holds a letter moved to another folder through the seam, and none it did not press", async () => {
    const { seam } = seamOver();
    await act(async () => {
      await seam().dispatchPress({ kind: "move", messageId: "m1", folder: "Archive" } as never);
    });
    expect(seam().ownGone!.has("m1")).toBe(true);
    expect(seam().ownGone!.has("m2")).toBe(false);
  });

  it("holds a deleted letter once its window closed and the delete was sent; a delete taken back holds nothing", async () => {
    const { mail, seam } = seamOver();
    act(() => seam().deleting.remove({ id: "m2", mailboxId: "mb-1" }));
    expect(seam().ownGone!.has("m2"), "nothing is sent away inside the window").toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS + 50);
    });
    expect(mail.mutations.some((m) => m.kind === "message_delete")).toBe(true);
    expect(seam().ownGone!.has("m2")).toBe(true);
    act(() => seam().deleting.remove({ id: "m3", mailboxId: "mb-1" }));
    act(() => void seam().runArmedUndo());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS + 50);
    });
    expect(seam().ownGone!.has("m3")).toBe(false);
  });

  it("reads as nobody's own where no room is on", () => {
    const view = renderHook(() => useOwnGone());
    expect(view.result.current("m1")).toBe(false);
  });
});
