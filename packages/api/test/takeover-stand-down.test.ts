import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import type { Db } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

/**
 * ═══ A MAILBOX THE LEASE DISABLED IS NOT A MAILBOX A PERSON DISCONNECTED ═══════════════════
 *
 * `POST /mailboxes/:id/organize` answered one sentence for two states. `organizeHere`'s header
 * has always said what the rule is — *"a stand-down and a disconnect share `status='disabled'`,
 * told apart only by the reason"* — and the guard under it asked `status` alone, so a row the
 * organizer lease stood down got `disconnected`: "This mailbox is disconnected. Reconnect it."
 * It is not disconnected; it is somebody else's to give back, and the take-over is the one thing
 * that gives it back.
 *
 * That row is not a hypothetical. Migration 0083 moved the stand-down onto `organizer_role` and
 * backfilled the old shape to connected readers — EXCEPT where a live sibling already held the
 * address, which its own header states: *"it stays disabled and keeps its reason"*. The pane
 * shows such a row the moment its sibling goes (`groupByAddress`), `readerStandDown` keeps the
 * legacy arm, and the take-over control is drawn on it. Pressing it refused, the pane offers no
 * re-enable, and the only move left was connecting the address again — which manufactures the
 * next superseded row.
 *
 * DRIVEN THROUGH THE ROUTE, not the service: a refusal is only as real as the pipeline the route
 * runs, and this one is step-up gated, spend gated and behind `withAccountTx`.
 *
 * ── HOW TO WATCH THESE FAIL ────────────────────────────────────────────────────────────────
 *
 *  · restore the guard to the unconditional `if (current.status === "disabled")` → arm 1 red,
 *    arm 2 green (the defect exactly);
 *  · drop `status: "connected"` from the ceremony's write → arm 1 reddens on the ROW while the
 *    outcome still reads `authorized`: the stamp alone is inert and the mailbox stays off the
 *    roster;
 *  · narrow the update's predicate back to `ne(status, 'disabled')` → arm 1 answers
 *    `already_organizing` over a row nothing was written to.
 *
 * Arm 2 is the standing positive control: it passes BEFORE the fix, so "stop refusing" cannot
 * pass for the fix.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/** A stored login, because a claim with no password in the body requires one. */
async function storeCredential(db: Db, id: string): Promise<void> {
  await db.insert(mailboxCredentials).values({
    mailboxId: id, accountId: accountOfMailbox(id), transport: "imap", secretEnc: "sealed", keyVersion: 1,
    meta: { host: "imap.example.test", port: 993, secure: true, user: "u" },
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
}

/**
 * The two `disabled` rows, written as their own writers leave them: `markMailboxStoodDown` before
 * mail 0083 (the reason, the role and the holder), and `delete` (the reason CLEARED in the same
 * statement that writes the tombstone — which is what makes the reason the discriminator).
 */
async function disable(
  db: Db, id: string, reason: string | null,
  /**
   * WHICH stood-down row. `reader` is what a pre-0083 stand-down left on a row the migration then
   * promoted; `superseded` is the shape that SURVIVES on a real database — backfill (1) skipped
   * any row whose address had been connected again, so it kept `organizer_role`'s DEFAULT and
   * backfill (2) never reached it, leaving consent NULL. Both must take the ceremony, and only
   * the second is a row production still holds.
   */
  shape: "reader" | "superseded" = "reader",
): Promise<void> {
  await db.update(mailboxes).set({
    status: "disabled",
    disabledReason: reason,
    organizerRole: shape === "reader" ? "reader" : "organizer",
    organizedByKind: reason === null ? null : "local",
    organizedByName: reason === null ? null : "a laptop",
    organizeConsentedAt: shape === "reader" ? new Date("2026-07-01T00:00:00.000Z") : null,
  }).where(eq(mailboxes.id, id));
}

const organize = (id: string, token: string, deps: ApiDeps): Promise<Response> =>
  H(req("POST", `/mailboxes/${id}/organize`, {
    bearer: token, body: JSON.stringify({ intent: "takeover" }),
  }), deps);

describe("POST /mailboxes/:id/organize tells the two disabled states apart", () => {
  it("a row the LEASE stood down takes the hand-over, and the row comes back with it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const id = await seedMailbox(db, { accountId: s.accountId, address: "held@example.test" });
    await storeCredential(db, id);
    await disable(db, id, "organized_elsewhere:local");

    const res = await organize(id, s.token, deps);
    const body = await res.json() as { outcome?: string; previousReason?: string | null };

    expect(body.outcome, "a lease stand-down was refused as a disconnect").toBe("authorized");
    // 202, not 200: the becoming has not happened — the worker's next pass reads the claim.
    expect(res.status).toBe(202);
    // AND IT NAMES WHAT THE MAILBOX IS BEING TAKEN BACK FROM, which is the one sentence this
    // door owes the person.
    expect(body.previousReason).toBe("organized_elsewhere:local");

    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    // The three columns the header names, each an independent failure if omitted: the row is back
    // on the roster, it no longer claims somebody else organizes it, and the ask is recorded.
    expect(after!.status, "the mailbox stayed off the roster, so the stamp bought nothing")
      .toBe("connected");
    expect(after!.disabledReason).toBeNull();
    expect(after!.takeoverAuthorizedAt).not.toBeNull();
    // The GATE promotes, not this: the role is untouched and the becoming is still owed.
    expect(after!.organizerRole).toBe("reader");
  });

  it("a row a PERSON disconnected is still refused, and nothing is written", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const id = await seedMailbox(db, { accountId: s.accountId, address: "gone@example.test" });
    await storeCredential(db, id);
    await disable(db, id, null);

    const res = await organize(id, s.token, deps);
    const body = await res.json() as { outcome?: string };

    expect(body.outcome, "a tombstone was revived").toBe("disconnected");
    expect(res.status).toBe(200);

    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    expect(after!.status).toBe("disabled");
    expect(after!.takeoverAuthorizedAt).toBeNull();
  });

  /**
   * THE ROW A REAL DATABASE STILL HOLDS. Migration 0083's backfill promoted the stood-down rows it
   * could and, by its own partial-unique-index guard, left the rest exactly as they were — which
   * means `organizer_role` at its DEFAULT `'organizer'` and `organize_consented_at` NULL, not the
   * reader shape the promoted ones got. A fix measured only against the promoted shape would be
   * measured against the population the migration removed.
   */
  it("the shape migration 0083 actually left behind takes it too", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const id = await seedMailbox(db, { accountId: s.accountId, address: "left@example.test" });
    await storeCredential(db, id);
    await disable(db, id, "organized_elsewhere:cloud", "superseded");

    const res = await organize(id, s.token, deps);
    const body = await res.json() as { outcome?: string; previousReason?: string | null };

    expect(body.outcome, "the row production still holds was refused").toBe("authorized");
    expect(body.previousReason).toBe("organized_elsewhere:cloud");

    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    expect(after!.status).toBe("connected");
    expect(after!.disabledReason).toBeNull();
    expect(after!.takeoverAuthorizedAt).not.toBeNull();
    // The consent this row never had is recorded now — it is being given, here, by this press.
    expect(after!.organizeConsentedAt).not.toBeNull();
  });

  /**
   * THE CONFLICT THE STATUS MOVE MAKES REACHABLE AGAIN. `mailboxes_active_address_uq` is partial
   * (`WHERE status <> 'disabled'`), so restoring a superseded row re-enters it — and a superseded
   * row is, by migration 0083's own guard, exactly the row that has a live sibling. The honest
   * answer is the address conflict rather than a 500: the sibling IS the mailbox now.
   */
  it("a superseded row whose address is live again is refused as an address conflict", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const dead = await seedMailbox(db, { accountId: s.accountId, address: "both@example.test" });
    await storeCredential(db, dead);
    await disable(db, dead, "organized_elsewhere:local");
    // The reconnect the person was forced into, beside it — legal precisely because the index is
    // partial and the dead row is `disabled`.
    await seedMailbox(db, { accountId: s.accountId, address: "both@example.test" });

    const res = await organize(dead, s.token, deps);
    const body = await res.json() as { error?: { code?: string } };

    expect(res.status, "the address conflict answered as a fault").toBe(409);
    expect(body.error?.code).toBe("mailbox_exists");

    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, dead)).limit(1);
    expect(after!.status, "a refused claim left the row half-restored").toBe("disabled");
    expect(after!.takeoverAuthorizedAt).toBeNull();
  });
});
