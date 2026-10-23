/**
 * MAY THIS SEND LEAVE ITS EDITOR AT ONCE? — the one question, asked at the press.
 *
 * When the connection is healthy, Send closes the compose (or the reply dock) the moment the send is
 * durably queued (the engine's outbox write, ahead of the wire), and the sending finishes in the
 * sidebar's foot (`SendingLine`). When it is not, the editor stays and says why, as it always has.
 * Pure, so every arm can be proven alone; health is read at the press, a later failure is said in the
 * line.
 */
import type { MailStateKey, MailboxFacts } from "./mail-state";
import type { SyncStatus } from "./sync-scheduler";
import { useBrowserOnline } from "./browser-online";
import { useStableCallback } from "./stable-callback";

/** The mail states a healthy connection reads as: settled, filing our own decisions, or importing. */
const HEALTHY_KEYS: ReadonlySet<MailStateKey> = new Set<MailStateKey>(["quiet", "filing", "importing"]);

export interface HandOffInputs {
  /** `MailState.key` — the ladder's verdict. On the desktop it reads the engine's freshness probe. */
  stateKey: MailStateKey;
  sync: Pick<SyncStatus, "bootstrapping" | "failures" | "terminal" | "refused" | "ownerLost" | "standingDown">;
  /** The browser's own online flag. */
  online: boolean;
  /** `OhmailEngine.outboxHeld()`: a timed-out dispatch's barrier stands. */
  outboxHeld: boolean;
  /** A paired computer that is not answering. */
  hostOffline: boolean;
  /** The sending mailbox's facts, or `null`/absent when they cannot be read. */
  mailbox: MailboxFacts | null | undefined;
  /** A send-later press: it never hands off (its own flow lands on Drafts). */
  scheduled: boolean;
}

export function mayHandOff(i: HandOffInputs): boolean {
  if (i.scheduled || !i.online || i.outboxHeld || i.hostOffline) return false;
  if (!HEALTHY_KEYS.has(i.stateKey)) return false;
  const s = i.sync;
  if (s.bootstrapping || s.failures > 0 || s.terminal || s.refused || s.ownerLost || s.standingDown === true) return false;
  const mb = i.mailbox;
  if (!mb || mb.status !== "connected" || mb.errorCode !== null) return false;
  if (mb.unreachableSince != null) return false;
  return true;
}

/** {@link mayHandOff} for a press from `mailboxId`, read from the shell's live state at the press. */
export function useMayHandOffFor(i: Pick<HandOffInputs, "stateKey" | "sync" | "hostOffline"> & {
  engine: { outboxHeld?: () => boolean };
  facts: readonly MailboxFacts[] | null | undefined;
}): (mailboxId: string | null) => boolean {
  const online = useBrowserOnline();
  return useStableCallback((mailboxId: string | null): boolean => mayHandOff({
    stateKey: i.stateKey, sync: i.sync, online, hostOffline: i.hostOffline,
    outboxHeld: typeof i.engine.outboxHeld === "function" && i.engine.outboxHeld(),
    mailbox: mailboxId === null ? null : i.facts?.find((f) => f.id === mailboxId) ?? null,
    scheduled: false,
  }));
}
