import {
  claimRefundObligations, noteRefundObligationFault, settleRefundObligation,
  REFUND_OBLIGATION_BATCH, REFUND_OBLIGATION_LEASE_MS,
} from "@trafficflow/db/cloud";
import type { SpendPort, Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

/**
 * THE DRAIN — a refund is a ROW, and this is the arm that turns the row back into money.
 *
 * A spend that bought nothing leaves an obligation (cloud 0036), written by the request that
 * observed the failure and BEFORE any reversal is attempted. Everything the request could not
 * finish — the program was unreachable, the invocation was killed, the release was answered 503 —
 * ends here, and ends the same way whichever of those it was.
 *
 * IDEMPOTENT FROM BOTH SIDES, which is what makes a replay safe: this server claims each row with
 * a lease in one statement, so two workers never dial for one debt; and the entitlements program's
 * own `refund:<attempt>` uniqueness is what makes re-sending a release whose answer was lost the
 * right thing to do rather than a second payment. A row is settled only on a receipt.
 *
 * NEVER THROWS. A worker that is syncing mail must not fall over because a refund is owed, and a
 * debt this pass leaves standing is a debt the next cycle takes: the lease is what returns it.
 */
export interface RefundObligationDrainResult {
  /** Debts this pass claimed. */
  claimed: number;
  /** Debts the program took. The only number that means somebody has their credits back. */
  settled: number;
  /** Debts still owed after this pass — claimed and not settled. They come back next cycle. */
  owed: number;
}

const EMPTY: RefundObligationDrainResult = { claimed: 0, settled: 0, owed: 0 };

export async function refundObligationDrainPass(
  db: Tx,
  deps: {
    /** The program. ABSENT ⇒ this host meters nothing and can owe nothing: the pass does not run. */
    credits?: SpendPort;
    log?: Logger;
    now?: () => Date;
    limit?: number;
    leaseMs?: number;
  },
): Promise<RefundObligationDrainResult> {
  const { credits } = deps;
  if (!credits) return EMPTY;
  const log = deps.log;
  const now = deps.now?.() ?? new Date();

  let claimed: Awaited<ReturnType<typeof claimRefundObligations>>;
  try {
    claimed = await claimRefundObligations(db, now, {
      limit: deps.limit ?? REFUND_OBLIGATION_BATCH,
      leaseMs: deps.leaseMs ?? REFUND_OBLIGATION_LEASE_MS,
    });
  } catch (err) {
    // A host deployed ahead of cloud 0036 is the ordinary reason. WARN and not ERROR: nothing is
    // lost — the debts are in the table the moment it exists — and the next cycle reads them.
    log?.warn("refund_obligation_claim_failed", { err });
    return EMPTY;
  }
  if (claimed.length === 0) return EMPTY;

  const result: RefundObligationDrainResult = { claimed: claimed.length, settled: 0, owed: 0 };
  for (const o of claimed) {
    try {
      // THE RELEASE THE REQUEST OWED, rebuilt from the row: the same action, the same BARE attempt
      // key, the same attempt id the program returned. `refund: true` with the attempt NAMED — a
      // reversal that does not name one falls back to the bare source, which is attempt 1 and may
      // belong to work delivered months ago.
      const receipt = await credits.release(o.accountId, {
        action: o.action, attemptKey: o.attemptKey, refund: true, attempt: o.attempt,
        ...(o.meta ? { meta: o.meta } : {}),
      });
      if (receipt === "settled") {
        await settleRefundObligation(db, o.accountId, o.attempt, deps.now?.() ?? new Date());
        result.settled += 1;
      } else {
        // STILL OWED. The lease is dropped so the next cycle takes it immediately rather than
        // waiting the lease out — a transient outage should cost one cycle, not two minutes.
        await noteRefundObligationFault(db, o.id, "release_unreachable");
        result.owed += 1;
      }
    } catch (err) {
      // A FAULT IS LOGGED ONCE AND THE DEBT STAYS. It is not rethrown and it does not stop the
      // other debts in this batch: one account's unreachable reversal is not another's.
      // `errorClass`, never the message — an error's message can quote a connection string and
      // this column outlives the request.
      log?.warn("refund_obligation_release_failed", {
        accountId: o.accountId, attempt: o.attempt, tries: o.tries, err,
      });
      try {
        await noteRefundObligationFault(db, o.id, errorClassOf(err));
      } catch (noteErr) {
        // The note is diagnostic; the LEASE expiring is what returns the row either way.
        log?.warn("refund_obligation_note_failed", { accountId: o.accountId, err: noteErr });
      }
      result.owed += 1;
    }
  }

  log?.info("refund_obligation_drain", { ...result });
  return result;
}

/** The thrown value's class name. A thrown STRING loses its payload at every other log site. */
function errorClassOf(err: unknown): string {
  if (typeof err === "string") return "String";
  const name = (err as { constructor?: { name?: string } })?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "Unknown";
}
