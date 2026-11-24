"use client";

/**
 * THE NOTE ON NEWS AND RECEIPTS: how many letters in the pile came from senders nobody let in, and
 * the press that sends them to the Screener (owner report 2026-11-02). Asked of the door each time
 * the pile is shown and after a press: the deciding fact is the arrival gate's answer,
 * as for the Ohbox's offer. Absent while unanswered, at zero, on a failed read and on a door with
 * no such route. Nothing moves without the press, and the press writes intents only.
 */

import { usePersistedChoice } from "../storage/persisted-ui.js";
import { scopeSuffix, type StorageScope } from "../storage/scope.js";
import type { MailboxFacts } from "../mail-state/mail-state.js";
import type { UnscreenedPileWire } from "@ohmail/wire";
import { createContext, useCallback, useEffect, useRef, useState } from "react";

/** What News or Receipts draws: the count, whether it is a floor, and the press. */
export interface PileNoteOffer {
  count: number;
  atLeast: boolean;
  screening: boolean;
  screen: () => void;
  dismiss: () => void;
}

/** The currently shown pile's offer, supplied by the account-scoped mail ground. */
export const PileNoteContext = createContext<PileNoteOffer | null>(null);

/** The engine's two pile calls. */
export interface PileNoteDoor {
  pileUnscreened(pile: UnscreenedPileWire): Promise<{ total: number; atLeast: boolean } | null>;
  screenPileUnscreened(pile: UnscreenedPileWire): Promise<number>;
}

/** What a press says afterwards: the count the server screened, none, or a failure. */
export type PileNoteSaid = { kind: "moved"; count: number } | { kind: "none" } | { kind: "failed" };

export const isPileNoteCount = (raw: string): raw is `${number}` => /^(0|[1-9]\d*)$/.test(raw) && Number.isSafeInteger(Number(raw));

/** Keep a dismissal only until the count grows from the latest lower count. */
export function usePileNoteDismissal(
  total: number | undefined,
  dismissed: `${number}` | null,
  keep: (count: `${number}`) => void,
): (() => void) | null {
  useEffect(() => {
    if (total !== undefined && dismissed !== null && total < Number(dismissed)) keep(`${total}`);
  }, [total, dismissed, keep]);
  if (total === undefined || dismissed === null || total <= Number(dismissed)) return null;
  return () => keep(`${total}`);
}

/** The account-scoped dismissal count, keyed separately for each pile. */
export function pileNoteNotNowKey(pile: UnscreenedPileWire, scope: StorageScope): string {
  return `ohmail.ui.pileNote.notNow.${pile}.${scopeSuffix(scope)}`;
}

export function usePileNote(
  door: PileNoteDoor, pile: UnscreenedPileWire, shown: boolean, say: (said: PileNoteSaid) => void, scope: StorageScope,
): PileNoteOffer | null {
  const dismissKey = scope === null ? null : pileNoteNotNowKey(pile, scope);
  const [dismissedCount, setDismissedCount] = usePersistedChoice(dismissKey, isPileNoteCount, "0");
  const [answer, setAnswer] = useState<{ total: number; atLeast: boolean } | null>(null);
  const [screening, setScreening] = useState(false);
  const alive = useRef(true);
  const reading = useRef(0);
  const pressing = useRef(false);
  const visible = useRef(shown);
  visible.current = shown;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const ask = useCallback(async () => {
    const request = ++reading.current;
    try {
      const next = await door.pileUnscreened(pile);
      if (alive.current && reading.current === request) setAnswer(next);
    } catch {
      // A note, not a surface: a door that will not answer has none to make.
      if (alive.current && reading.current === request) setAnswer(null);
    }
  }, [door, pile]);
  useEffect(() => {
    if (shown) void ask();
    else if (!pressing.current) setAnswer(null);
    return () => { reading.current += 1; };
  }, [shown, ask]);

  const screen = (): void => {
    if (!alive.current || !visible.current || pressing.current) return;
    pressing.current = true;
    setScreening(true);
    void door.screenPileUnscreened(pile)
      .then((count) => {
        if (!alive.current) return;
        reading.current += 1;
        setAnswer(null);
        say(count > 0 ? { kind: "moved", count } : { kind: "none" });
      })
      .catch(() => { if (alive.current) say({ kind: "failed" }); })
      .finally(() => {
        if (!alive.current) return;
        pressing.current = false;
        if (!visible.current) setAnswer(null);
        setScreening(false);
        if (visible.current) void ask();
      });
  };

  const dismiss = usePileNoteDismissal(answer?.total, dismissedCount, setDismissedCount);
  if (answer === null || dismiss === null) return null;
  return {
    count: answer.total,
    atLeast: answer.atLeast,
    screening,
    screen,
    dismiss,
  };
}

/** Name a shared, known organizer. A pile can cover more than one mailbox. */
export function pileOrganizer(
  mailboxes:
    readonly Pick<MailboxFacts, "status" | "organizerRole" | "organizerState" | "organizedBy">[] | null,
  cloud: boolean,
): string | null {
  const live =
    mailboxes?.filter(
      (mailbox) =>
        mailbox.status !== "disabled" &&
        mailbox.organizerRole === "organizer" &&
        mailbox.organizerState !== "stopped",
    ) ?? [];
  const name = live[0]?.organizedBy?.name?.trim();
  if (name && live.every((mailbox) => mailbox.organizedBy?.name?.trim() === name)) return name;
  return cloud && live.every((mailbox) => !mailbox.organizedBy?.kind || mailbox.organizedBy.kind === "cloud")
    ? "Cloud"
    : null;
}
