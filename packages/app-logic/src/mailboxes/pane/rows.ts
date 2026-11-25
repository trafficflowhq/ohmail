/**
 * THE MAILBOXES PANE'S RULES OVER ITS ROWS, moved out of the web's pane (`MailboxSection.tsx`) as they stood: what a
 * row may call its mailbox, why the connect offer is withheld, one row per address, and the rule that a late answer
 * never paints over a newer one. The old path re-exports them until it leaves.
 */
import { useCallback, useRef } from "react";
import { mailboxCheckedAt, type CheckedRow } from "@ohmail/client-engine";
import { addressKey } from "../../mail-state/address-key.js";

export { mailboxCheckedAt };

/**
 * How often the pane re-reads the mailbox list while it is open.
 *
 * A freshly connected mailbox reports `lastSyncAt: null` until the worker's next cycle, which
 * is up to sixty seconds away. Without polling the pane says "Not synced yet" and stays that
 * way until the user reloads — which is exactly what a fresh connect runs into thirty seconds
 * in: a true statement that looks like a failure because nothing ever changes it.
 */
export const TICK_MS = 10_000;

/**
 * How long an answered write waits for the read that shows it — the first-run flow's `SETTLE_MS`,
 * so the two surfaces keep one bound. Past it the pane stays where it is and says so; the poll's
 * next answer finishes the move.
 */
export const WRITE_SETTLE_MS = 4_000;

/**
 * What the row is allowed to call this mailbox — and why it is not just `status`. `mailboxes.status` DEFAULTS
 * to `'connected'` and `MailboxService.create` inserts without setting it, so the column says `connected`
 * before the host resolves, the password is offered, or one message arrives — measured on a live iCloud
 * mailbox, where a typed Apple ID password (instead of the mandatory app-specific one) produced a row reading
 * "connected" until the worker's first attach failed. No fourth status value, deliberately: the fact is already
 * in the row. The scan stamp is null until a cycle completes. On a Cloud copy the hosted stamp
 * describes the mailbox, and the desktop stamp describes the copy's progress.
 */
export function statusKey(
  m: Pick<CheckedRow, "lastSyncAt" | "hostedLastSyncAt"> & { readonly status: string },
): string {
  return m.status === "connected" && mailboxCheckedAt(m) === null
    ? "status_connecting"
    : `status_${m.status}`;
}

/**
 * Why the connect button is not always there. Walked end to end on a live Cloud account: someone not entitled to
 * another mailbox was offered "Connect a mailbox" and walked through every screen this pane has — provider,
 * credentials, the ohmail account password, and a FRESH SECOND FACTOR — and only then did `POST /mailboxes` refuse.
 * The most annoying step sat in front of the refusal. Every fact this needs was already on the wire: `GET
 * /account/access` is `cost: "read"` with no `stepUp` and answers the entitlements port's own verdict — the same port
 * `readMailboxAllowance` consults inside the create's transaction; `emailVerified` rides on `GET /auth/session`,
 * already called; the slot count is the list this pane holds, filtered exactly as the gate counts it (`status <>
 * 'disabled'`).
 */

/**
 * The precedence is the server's pipeline, in order: `withStepUp` → `withSpendGate` → handler
 * (`packages/api/src/app.ts`), so an unverified address is refused BEFORE the allowance gate — a pane naming a limit
 * to an unverified account would name a refusal that never fires. Then `decideMailboxAllowance`'s own order:
 * `canAddMailbox` first, the count second — an account that may not add another must be told THAT, not that it is
 * full. And it may only ever withhold an offer it can prove is dead: the read is a snapshot, the gate is `SELECT …
 * FOR UPDATE` inside the create's transaction, they can disagree — so every unknown fails OPEN (an unreadable
 * verdict, an unreadable session, a list not arrived) and `connect()`'s catch is untouched. Withholding a connect the
 * server would have allowed is worse than the defect being fixed.
 */

/**
 * The two subscription-shaped blocks are gone, and not because they were wrong: they named
 * states this pane can no longer be in. An account the service has REFUSED does not reach a
 * settings pane at all — every door answers 402 and the client swaps the whole surface for the
 * lock screen, where the way back to paying now lives. What is left for this gate to describe
 * is what an ACTIVE account can be: may it add another mailbox, and has it filled the ones it
 * has. A sentence about choosing a plan would name a refusal that cannot fire here.
 */
export type ConnectBlock = "email_unverified" | "cannot_add" | "at_limit";

/** Everything the decision is made from. Every field is nullable, and null means UNKNOWN. */
export interface ConnectFacts {
  /** `GET /auth/session` → `user.emailVerified`. */
  emailVerified: boolean | null;
  /**
   * `GET /account/access` — the entitlements port's verdict, or `null` while unread.
   *
   * `mailboxes: null` is UNBOUNDED (the port's convention), which an unmetered host also
   * reaches by answering `canAddMailbox: true` with no number. Both mean "the count cannot
   * block", so the count test below is skipped rather than compared against a made-up ceiling.
   */
  access: { canAddMailbox: boolean; mailboxes: number | null } | null;
  /** Mailboxes occupying a slot: `status <> 'disabled'`, exactly as the gate counts. */
  enabledCount: number | null;
}

/** Why the connect button is withheld, or `null` when it is offered. Pure, and total. */
export function connectBlock(f: ConnectFacts): ConnectBlock | null {
  if (f.emailVerified === false) return "email_unverified";
  const a = f.access;
  if (!a) return null;
  // `canAddMailbox` FIRST, the count second — `decideMailboxAllowance`'s own order. An account
  // forbidden another mailbox must be told that, not that it is full: the two are separate
  // questions and the port carries them separately for exactly this reason.
  if (!a.canAddMailbox) return "cannot_add";
  // An unread count fails OPEN, like every other unknown here, and `?? 0` is what that means
  // for a `>=` test: it can only ever offer a connect the server may still refuse, never
  // withhold one it would have allowed. An UNBOUNDED limit skips the test outright — there is
  // no number to reach, and comparing against one would invent a ceiling.
  if (a.mailboxes !== null && (f.enabledCount ?? 0) >= a.mailboxes) return "at_limit";
  return null;
}

/** One address: the row that is shown, and how many disabled ones it stands in front of. */
export interface AddressGroup<T> {
  shown: T;
  superseded: number;
}

/**
 * One address, one row. `delete` is a SOFT delete and mail 0021's unique index is PARTIAL (`WHERE status <>
 * 'disabled'`, on `lower(address)`), so a disabled row is not a conflict and connecting the same address again
 * legally inserts a second one — the intended schema: a tombstone must not lock its own address out for ever. The
 * pane rendered the consequence verbatim: the dead row sat beside the live one, same address, indistinguishable, for
 * ever. Not rare — it is what the only available remedy produces: a mailbox the organizer lease stood down is off the
 * worker's roster (`loadEnabledMailboxes` filters `status <> 'disabled'`) and this pane offers no re-enable, so
 * connecting the address again is the only move a Cloud customer has.
 */

/**
 * Collapse the list to one entry per address. THE SHOWN ROW IS THE LIVE ONE when there is a live one, and the FIRST
 * otherwise. `list` returns the whole account ordered by `id` and the index guarantees at most one non-disabled row
 * per address, so "the live one" is unambiguous whenever it exists. A group of disabled rows with no live sibling is
 * NOT collapsed to a footnote — it keeps a real row. An account whose only mailbox was stood down must still see it,
 * with its reason; that is the state the one-row rule was written for, and hiding it would be the same defect from
 * the other side.
 */
export function groupByAddress<T extends { readonly address: string; readonly status: string }>(
  items: readonly T[],
): AddressGroup<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  for (const m of items) {
    const key = addressKey(m.address);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(m);
    else {
      byKey.set(key, [m]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const rows = byKey.get(key)!;
    const live = rows.find((m) => m.status !== "disabled");
    return {
      shown: live ?? rows[0]!,
      // Counted against the SHOWN row, so a group of one disabled mailbox reports zero — it is
      // not superseded by anything, it is simply the mailbox.
      superseded: rows.filter((m) => m !== (live ?? rows[0]!) && m.status === "disabled").length,
    };
  });
}

/**
 * ONE ASYNCHRONOUS ANSWER'S CLAIM ON THE SCREEN — the pane's ordering rule, in one place.
 *
 * Every read takes a sequence BEFORE its `await` and applies only if nothing newer has been
 * displayed since; every press takes one too, so its own answer is always told and every read
 * issued before it is retired. A dead pane answers `false` to both, which is what lets the two
 * verbs replace the `alive.current` guard at every call site rather than sit beside it.
 */
export interface LatestWins {
  /** A READ's answer: applied only if it is the newest thing issued. */
  claim(): boolean;
  /** A PRESS's own answer: always applied, and it retires every read issued before the press. */
  publish(): boolean;
}

/** A channel of the rule above — one per group of state a late answer can contradict. */
export function useLatestWins(alive: { current: boolean }): () => LatestWins {
  const issued = useRef(0);
  const applied = useRef(0);
  return useCallback((): LatestWins => {
    const seq = ++issued.current;
    return {
      claim: () => {
        if (!alive.current || seq <= applied.current) return false;
        applied.current = seq;
        return true;
      },
      publish: () => {
        if (!alive.current) return false;
        if (seq > applied.current) applied.current = seq;
        return true;
      },
    };
  }, [alive]);
}
