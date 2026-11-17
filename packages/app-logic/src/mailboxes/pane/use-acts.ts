"use client";

/**
 * THE ROW'S PRESSES THAT NEED NO SECOND FACTOR: a re-sync, the forwarding notice's dismissal, and stopping the
 * organizing here (it gives control away, keeps every credential and every message, and is undone by the press beside
 * it; a person who lost their second factor must still be able to stop a machine from filing their mail). Each is
 * the server's request, said as one; a spinner belongs to its own press, never to the screen's newest answer.
 */
import { useCallback, useState } from "react";
import { filerKey } from "../../mail-state/mail-state.js";
import type { MailboxId } from "../connect/types.js";
import { NONE, type PaneCalls } from "./calls.js";
import type { Lines } from "./lines.js";
import type { MailboxesList } from "./use-mailboxes.js";
import type { MailboxRow } from "./types.js";

export interface ActsInput {
  readonly wire: Pick<PaneCalls, "resync" | "dismissForwardingNotice" | "stopOrganizing">;
  readonly list: Pick<MailboxesList, "refresh" | "afterWrite" | "wins" | "alive">;
  readonly lines: Pick<Lines, "refused" | "tell" | "clear">;
  /** The mail state's own re-read: the strip above reads the same route on its own slower clock. */
  readonly refreshMailState: () => void;
  /** A dismissal answers the row it changed; it is folded into the list at once. */
  readonly fold: (row: MailboxRow) => void;
  readonly filer: "cloud" | "server";
}

export interface Acts {
  readonly queued: ReadonlySet<string>;
  readonly dismissing: ReadonlySet<string>;
  readonly releasing: ReadonlySet<string>;
  /** The mailbox whose release asks whether it was meant, or `null`. */
  readonly releaseFor: MailboxId | null;
  resync(id: MailboxId): void;
  dismissQuiet(id: MailboxId): void;
  askRelease(id: MailboxId | null): void;
  release(id: MailboxId): void;
}

const adding =
  (id: string) =>
  (s: ReadonlySet<string>): ReadonlySet<string> =>
    new Set(s).add(id);
const leaving =
  (id: string) =>
  (s: ReadonlySet<string>): ReadonlySet<string> => {
    const next = new Set(s);
    next.delete(id);
    return next;
  };

export function useActs(input: ActsInput): Acts {
  const { wire, list, lines, refreshMailState, fold, filer } = input;
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(() => new Set());
  const [releasing, setReleasing] = useState<ReadonlySet<string>>(() => new Set());
  const [releaseFor, setReleaseFor] = useState<MailboxId | null>(null);

  /** Ask the worker to re-scan: nothing is synced when this answers, so the row says so until it is. */
  const resync = useCallback(
    (id: MailboxId): void => {
      lines.clear();
      setQueued(adding(id));
      const mine = list.wins();
      void wire.resync(id).then(async (answer) => {
        if (answer.ok) {
          await list.refresh();
          refreshMailState();
          if (list.alive.current) setQueued(leaving(id));
          return;
        }
        if (!mine.publish()) return;
        lines.refused(answer.refusal);
        setQueued(leaving(id));
      });
    },
    [lines, list, refreshMailState, wire],
  );

  const dismissQuiet = useCallback(
    (id: MailboxId): void => {
      const dismiss = wire.dismissForwardingNotice;
      if (dismiss === NONE) return;
      lines.clear();
      setDismissing(adding(id));
      const mine = list.wins();
      void dismiss(id).then((answer) => {
        if (mine.publish()) {
          if (answer.ok) fold(answer.value);
          else lines.refused(answer.refusal);
        }
        if (list.alive.current) setDismissing(leaving(id));
      });
    },
    [fold, lines, list, wire],
  );

  const release = useCallback(
    (id: MailboxId): void => {
      const stop = wire.stopOrganizing;
      if (stop === NONE) return;
      lines.clear();
      setReleasing(adding(id));
      const mine = list.wins();
      void stop(id).then(async (answer) => {
        if (!answer.ok) {
          if (mine.publish()) {
            setReleaseFor(null);
            lines.refused(answer.refusal);
          }
        } else if (mine.publish()) {
          const { outcome } = answer.value;
          lines.tell({
            said: {
              key:
                outcome === "requested"
                  ? filerKey("stopQueued", filer)
                  : outcome === "not_organizing"
                    ? filerKey("stopNot", filer)
                    : "organizerDisconnected",
            },
          });
          // The role moves at the worker's gate: the well stays open, its confirm spent, until a read answers.
          await list.afterWrite();
          if (list.alive.current) setReleaseFor(null);
        }
        if (list.alive.current) setReleasing(leaving(id));
      });
    },
    [filer, lines, list, wire],
  );

  return {
    queued,
    dismissing,
    releasing,
    releaseFor,
    resync,
    dismissQuiet,
    askRelease: setReleaseFor,
    release,
  };
}
