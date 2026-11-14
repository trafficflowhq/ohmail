/**
 * DISCARD IN ONE PRESS, WITH UNDO. The press hides the row and offers Undo for `UNDO_MS`; the delete is sent when the
 * window closes or the place is left, never before, so Undo sends nothing and a tab that dies inside the window keeps
 * the draft. A send waiting on the row is taken back at the press, before the window opens: a letter never goes out
 * after Discard. A refusal hides nothing and is said in the row.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PressVerdict } from "@ohmail/client-engine";
import { UNDO_MS } from "../press/undo-window.js";
import type { UndoToastFn } from "../press/undo-door.js";
import type { DiscardRefusal, DraftsDoor } from "./door.js";

/** The sentences the window raises, in the place's words. */
export interface DiscardWords {
  readonly discarded: string;
  readonly undo: string;
  /** The waiting send was taken back and the row is gone. */
  readonly notSent: string;
  /** The server said no: its sentence, or none. */
  readonly refused: (reason: string | null) => string;
  /** The delete waits for this client's next try, or for the install that organizes the mailbox. */
  readonly queued: (wait: "retry" | "organizer") => string;
}

export interface DiscardWindow {
  /** Rows a Discard hides while its window is open, and after while the server answers. */
  readonly hidden: ReadonlySet<string>;
  discard(id: string): void;
  readonly refusal: DiscardRefusal | null;
}

interface Open {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly ends: AbortController;
  readonly withdrew: boolean;
}

/** What the server's answer says, and whether the row stands again. */
function sayVerdict(
  verdict: PressVerdict,
  withdrew: boolean,
  w: DiscardWords,
  say: UndoToastFn,
  show: (on: boolean) => void,
): void {
  switch (verdict.kind) {
    case "refused":
      show(false);
      say(w.refused(verdict.refusal?.message?.trim() || null));
      return;
    case "queued":
      // The organizer's wait painted the row back; this client's own retry keeps it gone.
      if (verdict.wait === "organizer") show(false);
      say(w.queued(verdict.wait));
      return;
    case "applied":
      if (withdrew) say(w.notSent);
      return;
    case "silent":
      return;
    default: {
      const unhandled: never = verdict;
      void unhandled;
      show(false);
      say(w.refused(null));
    }
  }
}

export function useDiscardWindow(door: DraftsDoor, report: UndoToastFn, words: DiscardWords): DiscardWindow {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [refusal, setRefusal] = useState<DiscardRefusal | null>(null);
  const open = useRef(new Map<string, Open>());
  const asking = useRef(new Set<string>());
  const mounted = useRef(true);
  const latest = useRef({ door, report, words });
  latest.current = { door, report, words };

  const show = useCallback((id: string, on: boolean) => {
    if (!mounted.current) return;
    setHidden((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const commit = useCallback(
    (id: string) => {
      const held = open.current.get(id);
      if (!held) return;
      open.current.delete(id);
      clearTimeout(held.timer);
      held.ends.abort();
      void latest.current.door
        .discard(id)
        .catch((): PressVerdict => ({ kind: "refused", refusal: undefined }))
        .then((verdict) => {
          const { report: say, words: w } = latest.current;
          sayVerdict(verdict, held.withdrew, w, say, (on) => show(id, on));
        });
    },
    [show],
  );

  const undo = useCallback(
    (id: string) => {
      const held = open.current.get(id);
      if (!held) return;
      open.current.delete(id);
      clearTimeout(held.timer);
      show(id, false);
    },
    [show],
  );

  const discard = useCallback(
    (id: string) => {
      if (open.current.has(id) || asking.current.has(id)) return;
      const { door: d } = latest.current;
      const decision = d.decide(id);
      if (decision.kind === "refuse") {
        setRefusal({ draftId: id, why: decision.why, at: Date.now() });
        return;
      }
      asking.current.add(id);
      void d
        .withdrawWaiting(id)
        .catch(() => "unknown" as const)
        .then((answer) => {
          asking.current.delete(id);
          if (answer === "already_sent" || answer === "unknown") {
            if (mounted.current) {
              setRefusal({
                draftId: id,
                why: answer === "already_sent" ? "still-sending" : "cancel-unknown",
                at: Date.now(),
              });
            }
            return;
          }
          if (!mounted.current) return;
          const ends = new AbortController();
          const timer = setTimeout(() => commit(id), UNDO_MS);
          open.current.set(id, { timer, ends, withdrew: answer === "withdrawn" });
          show(id, true);
          const { report: say, words: w } = latest.current;
          say(w.discarded, {
            undo: true,
            action: w.undo,
            onAction: () => undo(id),
            duration: UNDO_MS,
            signal: ends.signal,
          });
        });
    },
    [commit, show, undo],
  );

  /* Leaving the place closes every open window: the deletes go now, as they would have. */
  useEffect(() => {
    mounted.current = true;
    const windows = open.current;
    return () => {
      mounted.current = false;
      for (const id of [...windows.keys()]) commit(id);
    };
  }, [commit]);

  return { hidden, discard, refusal };
}
