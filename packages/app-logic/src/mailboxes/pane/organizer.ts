"use client";

/**
 * WHO ORGANIZES A MAILBOX, AND WHAT TAKING IT OVER WOULD DO. The check reads the mailbox itself and writes nothing:
 * the endpoint behind it cannot write a claim. One check at a time, because each opens a short-lived connection to
 * the person's provider.
 *
 * THE SENTENCE IS CHOSEN FROM THE FRESH READ, NEVER FROM THE STORED REASON: an install still checking in is stopped by
 * a take-over, one that has gone quiet is promised nothing. An unreadable claim is still evidence somebody claimed.
 */
import { useCallback, useState } from "react";
import { holderIsLive } from "@trafficflow/core/reader-refusal";
import { claimLeftBehind, filerKey, readerStandDown, type FilerSelf } from "../../mail-state/mail-state.js";
import type { MailboxId, Refusal } from "../connect/types.js";
import { NONE, type PaneCalls } from "./calls.js";
import type { LatestWins } from "./rows.js";
import type { MailboxRow, OrganizerPeek } from "./types.js";

/** A sentence of the catalogue, with its values: the `mailboxes` namespace unless it names another. */
export interface PaneSaid {
  readonly ns?: "mailboxes" | "devices" | "sync";
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

/** Who files a mailbox this pane's shell organizes, by whose service it is: data, never a platform's name. */
export const FILER_OF_SERVICE = {
  managed: "cloud",
  self: "server",
  ownComputer: "computer",
} as const satisfies Record<"managed" | "self" | "ownComputer", FilerSelf>;

/** The web's own rows have no sentence for a computer; a computer's pane says the hosted service's. */
export const webFilerOf = (filer: FilerSelf): "cloud" | "server" => (filer === "server" ? "server" : "cloud");

/** What the check found, and what taking over does to the holder it found. */
export function organizerSaid(
  peek: OrganizerPeek,
  ago: (iso: string) => string,
  filer: "cloud" | "server",
): { readonly found: PaneSaid; readonly effect: PaneSaid } {
  const holder = peek.holders[0];
  const when = holder ? ago(holder.heartbeatAt) : "";
  const machine = holder?.displayName ?? null;
  const found: PaneSaid =
    holder === undefined
      ? { key: peek.unreadable > 0 ? "organizerUnreadable" : "organizerNone" }
      : holder.active
        ? machine
          ? { key: "organizerHeldNamed", values: { machine, when } }
          : { key: "organizerHeld", values: { when } }
        : machine
          ? { key: "organizerStoppedNamed", values: { machine, when } }
          : { key: "organizerStopped", values: { when } };
  const live =
    peek.unreadable > 0 ||
    holderIsLive({ by: holder ? { kind: holder.kind, name: holder.displayName } : null, state: peek.state });
  return { found, effect: { key: filerKey(live ? "takeoverEffect" : "takeoverEffectLapsed", filer) } };
}

/**
 * Whether a row draws a take-over press: a released mailbox's one press, or a stand-down's check and its confirm.
 * A claim of this install's own left behind is handed back instead, and a paused one waits for the account.
 */
export function drawsTakeover(m: MailboxRow): boolean {
  const sd = readerStandDown(m);
  return sd === "released" || (sd !== null && sd !== "parked" && !claimLeftBehind(m));
}

export interface PeekInput {
  readonly wire: Pick<PaneCalls, "organizer">;
  /** The check's own channel of the ordering rule: two checks whose answers cross keep the newer. */
  readonly wins: () => LatestWins;
  /** The check could not be made: the server's sentence, and nothing invented beside it. */
  onRefused(refusal: Refusal): void;
}

export interface Peek {
  /** The one mailbox being checked, and what was found; `peek: null` while the read is out. */
  readonly checking: { readonly id: MailboxId; readonly peek: OrganizerPeek | null } | null;
  check(id: MailboxId): void;
  close(): void;
}

export function useOrganizerPeek(input: PeekInput): Peek {
  const [checking, setChecking] = useState<Peek["checking"]>(null);
  const { wire, wins, onRefused } = input;
  const check = useCallback(
    (id: MailboxId): void => {
      const ask = wire.organizer;
      if (ask === NONE) return;
      setChecking({ id, peek: null });
      const mine = wins();
      void ask(id).then((answer) => {
        if (!mine.claim()) return;
        if (answer.ok) setChecking({ id, peek: answer.value });
        else {
          setChecking(null);
          onRefused(answer.refusal);
        }
      });
    },
    [onRefused, wins, wire],
  );
  const close = useCallback(() => setChecking(null), []);
  return { checking, check, close };
}
