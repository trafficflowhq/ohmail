"use client";

/**
 * THE NOTE ON NEWS AND RECEIPTS: how many letters in the pile came from senders nobody let in, and
 * the press that sends them to the Screener (owner report 2026-11-02). Asked of the door each time
 * the pile is shown and after a press, never kept: the deciding fact is the arrival gate's answer,
 * as for the Ohbox's offer. Absent while unanswered, at zero, on a failed read and on a door with
 * no such route. Nothing moves without the press, and the press writes intents only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { UnscreenedPileWire } from "@ohmail/client-engine";

/** What News or Receipts draws: the count, whether it is a floor, and the press. */
export interface PileNoteOffer {
  count: number;
  atLeast: boolean;
  screening: boolean;
  screen: () => void;
}

/** The engine's two pile calls. */
export interface PileNoteDoor {
  pileUnscreened(pile: UnscreenedPileWire): Promise<{ total: number; atLeast: boolean } | null>;
  screenPileUnscreened(pile: UnscreenedPileWire): Promise<number>;
}

/** What a press says afterwards: the count the server screened, none, or a failure. */
export type PileNoteSaid = { kind: "moved"; count: number } | { kind: "none" } | { kind: "failed" };

export function usePileNote(
  door: PileNoteDoor, pile: UnscreenedPileWire, shown: boolean, say: (said: PileNoteSaid) => void,
): PileNoteOffer | null {
  const [answer, setAnswer] = useState<{ total: number; atLeast: boolean } | null>(null);
  const [screening, setScreening] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const ask = useCallback(async () => {
    try {
      const next = await door.pileUnscreened(pile);
      if (alive.current) setAnswer(next);
    } catch {
      // A note, not a surface: a door that will not answer has none to make.
      if (alive.current) setAnswer(null);
    }
  }, [door, pile]);
  useEffect(() => {
    if (shown) void ask();
  }, [shown, ask]);

  const screen = (): void => {
    if (screening) return;
    setScreening(true);
    void door.screenPileUnscreened(pile)
      .then((count) => { say(count > 0 ? { kind: "moved", count } : { kind: "none" }); })
      .catch(() => { say({ kind: "failed" }); })
      .finally(() => {
        if (!alive.current) return;
        setScreening(false);
        void ask();
      });
  };

  if (answer === null || answer.total <= 0) return null;
  return { count: answer.total, atLeast: answer.atLeast, screening, screen };
}
