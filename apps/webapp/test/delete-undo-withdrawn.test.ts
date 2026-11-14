/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createDeleteUndo } from "@ohmail/app-logic/press/delete-undo";

/**
 * A HELD DELETE's UNDO IS WITHDRAWN WHEN ITS WINDOW CLOSES EARLY, never left above its outcome.
 * Moved word for word from `toast-undo-kept.test.tsx` (whose other cases stand over today's Screener view until
 * its mount): the delete window is the ground's press seam's, and this case reads it alone.
 */

describe("an Undo whose window closed early is withdrawn, never left above its outcome", () => {
  it("the delete window withdraws its Undo when it is flushed or undone from the keyboard", () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const queue = createDeleteUndo({
      scope: null,
      mutate: async () => ({ status: "confirmed" }) as never,
      toast: (_m, o) => { if (o?.signal) signals.push(o.signal); },
      copy: {
        deleted: "Deleted.", undo: "Undo", undone: "Kept.", failed: "Refused.", noUndo: "No undo.",
      },
      onHeld: () => {},
      refusal: () => null,
      pressId: () => `press-${++n}`,
    });
    expect(queue.remove({ id: "m1", mailboxId: "mb1" })).toBe(true);
    expect(signals, "the premise: the press offered an Undo under a signal").toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    queue.flush();
    expect(signals[0]!.aborted, "flushed early: the capsule is withdrawn").toBe(true);
    queue.remove({ id: "m2", mailboxId: "mb1" });
    queue.undo("m2");
    expect(signals[1]!.aborted, "undone from the keyboard: the capsule's Undo is spent").toBe(true);
  });
});
