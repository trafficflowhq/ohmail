import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  contacts, folderState, mailboxes, messages, routingDecisions, type Tx,
} from "@trafficflow/db";
import { sourceFor } from "@trafficflow/db";
import type { SpendAction, SpendOutcome } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  NO_TRUSTED_AUTHSERV_IDS, UNMETERED_STORAGE_CAP,
  type ClassifierPort, type ClassifierResult, type CreditGate,
} from "@trafficflow/core/mail";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle, reconcileMailbox } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A READER CYCLE SPENDS NOTHING AND DECIDES NOTHING — with a live classifier injected
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY A DOUBLE AND NOT AN ABSENCE (the "injected default untested" risk) ──────────────────
 *
 * A reader's `classifier: undefined` is BYTE-IDENTICAL to "this deployment has no AI". A test
 * that ran a reader cycle with no classifier wired would pass on both the correct implementation
 * and on one that had no reader mode at all — it would be asserting that AI-off deployments make
 * no AI calls, which nobody doubted. So the classifier, the credit gate and the routing port are
 * all INJECTED and LIVE here, exactly as the hosted worker wires them, and the assertion is that
 * a reader cycle touches none of them.
 *
 * The three counters are three different failures:
 *
 *  · `classify` calls — somebody's mail sent to a model on a mailbox this install does not
 *    organize, which is a privacy statement before it is a cost one;
 *  · `tryDebit` calls — somebody's money spent on a decision that will never be applied;
 *  · `routing_decisions` rows — a decision RECORDED, which the retro passes and the approval
 *    surface both read, so a reader's phantom decision would surface as a real one the moment
 *    this install were ever promoted.
 *
 * ── AND THE NEGATIVE CONTROL IS THE POINT OF THE FILE ───────────────────────────────────────
 *
 * The same seed, the same doubles, `role: "organizer"` — and all three counters move. Without it
 * the green above proves only that the cycle did nothing at all, which a broken fixture also
 * produces. `readerMode` is derived from `role` in exactly one place (`sync.ts#syncCycleWithin`),
 * so flipping this one field is the mutation the ruling asks to see red.
 */

const ACCOUNT = "00000000-0000-4000-8000-00000000c0de";

/** Counts every call. The port a reader must never reach. */
class CountingClassifier implements ClassifierPort {
  calls = 0;
  async classify(): Promise<ClassifierResult> {
    this.calls++;
    return { destination: "ohmail/News", confidence: 0.99, rationale: "double" };
  }
}

/** Counts every debit. `true` so the gate never itself becomes the reason nothing happened. */
class CountingCredits implements CreditGate {
  debits = 0;
  async spend(_a: string, action: SpendAction, key: string): Promise<SpendOutcome> {
    this.debits++;
    return { verdict: "ok", charged: true, attempt: sourceFor(action, key) };
  }
}

async function world(): Promise<{
  db: Tx; repo: WorkerRepo; adapter: MailboxAdapter; accountId: string; mailboxId: string;
  fleet: FakeAdapterFleet;
}> {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId: ACCOUNT, provider: "imap", address: `r-${randomUUID().slice(0, 8)}@lichtgrat.example` })
    .returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id },
  );
  // KNOWN CORRESPONDENTS, and the choice is load-bearing. `evaluateRules` answers the SCREENER
  // for an unruled stranger — a deterministic destination — so a stranger never reaches the AI
  // branch at all (`decision.destination == null` is the gate on it). The unclear residue is a
  // sender the account HAS written to, with no rule saying where their mail goes: that is the
  // one shape an organizer buys a classification for, so it is the only shape that can prove a
  // reader does not.
  await db.insert(contacts).values([
    { accountId: ACCOUNT, address: "colleague@example.com" },
    { accountId: ACCOUNT, address: "partner@example.net" },
  ]).onConflictDoNothing();
  fleet.control.set(mb!.id, {
    deliver: [
      { from: "colleague@example.com", subject: "hello", messageId: "<r1@example.com>" },
      { from: "partner@example.net", subject: "again", messageId: "<r2@example.net>" },
    ],
  });
  return { db, repo: makeDrizzleRepo(db), adapter, accountId: ACCOUNT, mailboxId: mb!.id, fleet };
}

async function cycle(
  w: Awaited<ReturnType<typeof world>>,
  role: "organizer" | "reader",
  classifier: CountingClassifier,
  credits: CountingCredits,
): Promise<void> {
  const deps = {
    repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
    role,
    classifier,
    credits,
    // The ROUTING port is the repo, exactly as the hosted worker wires it — so a decision, if one
    // were made, would land in `routing_decisions` through the real path rather than a stub.
    trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS,
    storageCap: UNMETERED_STORAGE_CAP,
    // Typed rather than omitted — `writeAuthority` is required. A READER names itself so the one
    // verb it may write (`\Seen`) is admitted; an organizer rides the fixture's held permit, since
    // "nobody supplied one" is refused at the first write.
    writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
  } as const;
  await runSyncCycle(deps);
  // The reconciler too: a move a reader recorded but did not execute would still be a decision,
  // and `reconcileMailbox` is where an organizer's would become an IMAP write.
  await reconcileMailbox(deps);
}

/**
 * THE USER-COMMANDED SWEEP, AS AN INJECTED PORT — the same discipline as the classifier above.
 *
 * `SyncDeps.junkSweep` is how a cycle learns that somebody pressed the one-time Quarantine→Junk
 * offer. It is a PORT, so a reader that ran it would be indistinguishable from a deployment with
 * no offer unless the port is present and counted.
 */
class CountingSweep {
  requests = 0;
  runs = 0;
  async requested(): Promise<string | null> { this.requests++; return "2026-09-02 00:00:00+00"; }
  async run(): Promise<{
    moved: string[]; skipped: readonly unknown[]; junkFolder: string | null;
    deferred: number; deferralsHold: boolean; examinedAll: boolean;
  }> {
    this.runs++;
    return { moved: [], skipped: [], junkFolder: "Junk", deferred: 0, deferralsHold: false, examinedAll: true };
  }
  async remaining(): Promise<number> { return 0; }
  async clear(): Promise<void> { /* nothing to retire in a double */ }
}

describe("a reader cycle runs no AI, spends no credit and records no decision", () => {
  it("A RECORDED COMMAND IS NOT EXECUTED BY A READER — the sweep port is never asked", async () => {
    /* THE SHAPE THIS CLOSES, and it is the more exploitable half of the reader mode.
     *
     * The sweep and the folder verbs are COMMANDS RECORDED EARLIER, by an install that WAS the
     * organizer when the person pressed the button. The API's job ended when it recorded them, so
     * nothing refuses them afterwards — and a demotion between the press and the cycle turned a
     * queued command into a real IMAP mutation on a mailbox another install now organizes. Worse
     * than a live decision, because nobody is at the screen to notice.
     *
     * `requested()` is asserted at ZERO rather than `run()` alone: the cycle must not even ASK,
     * because asking is what the guard is placed before, and a guard that let the read through
     * would be one refactor from letting the run through with it.
     *
     * The same single `!readerMode` guard covers the folder-ops pass three lines above it, which
     * executes `folder_ops` rows the same way. That pass takes no injectable port, so this is the
     * probe for both — stated rather than implied.
     */
    const w = await world();
    const sweep = new CountingSweep();
    const classifier = new CountingClassifier();
    const credits = new CountingCredits();
    await runSyncCycle({
      // A READER rides a reader's authority, the one every root composes for it — never omitted:
      // an omission is the shape that let a hosted cycle write to a mailbox whose lease it had
      // never asked about.
      writeAuthority: { noLease: "reader" },
      repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
      role: "reader", classifier, credits,
      trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS,
      storageCap: UNMETERED_STORAGE_CAP,
      junkSweep: sweep as unknown as NonNullable<Parameters<typeof runSyncCycle>[0]["junkSweep"]>,
    });
    expect(sweep.requests, "a reader read a user-commanded sweep stamp it may not serve").toBe(0);
    expect(sweep.runs, "a reader executed a bulk IMAP move on somebody else's mailbox").toBe(0);

    // NEGATIVE CONTROL, in the same test so the two cannot drift: the identical composition as an
    // ORGANIZER asks and runs. Without it a zero above is satisfied by a port that is never wired.
    const w2 = await world();
    const sweep2 = new CountingSweep();
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo: w2.repo, adapter: w2.adapter, accountId: w2.accountId, mailboxId: w2.mailboxId,
      role: "organizer", classifier: new CountingClassifier(), credits: new CountingCredits(),
      trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS,
      storageCap: UNMETERED_STORAGE_CAP,
      junkSweep: sweep2 as unknown as NonNullable<Parameters<typeof runSyncCycle>[0]["junkSweep"]>,
    });
    expect(sweep2.requests, "the organizer arm never asked — the reader assertion is vacuous")
      .toBeGreaterThan(0);
    expect(sweep2.runs).toBeGreaterThan(0);
  });

  it("READER: the classifier is injected and never called; nothing is debited or decided", async () => {
    const w = await world();
    const classifier = new CountingClassifier();
    const credits = new CountingCredits();
    await cycle(w, "reader", classifier, credits);

    // THE MIRROR GREW. Asserted first, because every other assertion in this test is about an
    // ABSENCE — and an absence on an empty mirror proves nothing at all.
    const rows = await w.db.select().from(messages).where(eq(messages.mailboxId, w.mailboxId));
    expect(rows.length, "a reader's mirror must GROW — that is the whole product difference").toBe(2);

    expect(classifier.calls, "a reader sent somebody's mail to a model").toBe(0);
    expect(credits.debits, "a reader spent somebody's credits").toBe(0);
    const decisions = await w.db.select().from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decisions.length, "a reader recorded a routing decision").toBe(0);

    // AND NOTHING IS FILED. The rows are `peer` — INBOX is a folder ohmail ORGANIZES, so the
    // placement was made by another install of this account, not by the person's own hand; see
    // `pipeline.ts#readerAdoption`. Every UNPRESSED mover is still out of reach by DATA as well as
    // by the branch that put them there (only `rule-retro` admits `peer`, and only for a rule
    // whose owner asked for it), and `desired === observed === INBOX` means the reconciler
    // computes `none` and issues no IMAP move.
    //
    // `'peer'` EXACTLY, never "not us": the value is the whole record of WHICH install placed the
    // message, and an assertion that accepted anything but `'us'` would pass for a row this
    // install had filed as the user's own hand.
    const states = await w.db.select().from(folderState);
    expect(states.length).toBe(2);
    for (const st of states) {
      expect(st.lastSetBy, "a reader's placement is another install's, not ours and not the user's")
        .toBe("peer");
      expect(st.desiredFolder).toBe("INBOX");
      expect(st.observedFolder).toBe("INBOX");
    }
  });

  it("NEGATIVE CONTROL — the same seed as an ORGANIZER calls, debits and decides", async () => {
    const w = await world();
    const classifier = new CountingClassifier();
    const credits = new CountingCredits();
    await cycle(w, "organizer", classifier, credits);

    const rows = await w.db.select().from(messages).where(eq(messages.mailboxId, w.mailboxId));
    expect(rows.length).toBe(2);
    // Both senders are known and unruled, so `evaluateRules` answers `unclear` and the AI branch
    // is entered for both — one classify and one debit each. If this ever goes to zero the test
    // above has stopped meaning anything and the fixture, not the reader mode, is what changed.
    expect(classifier.calls, "the organizer arm must reach the classifier or the reader test is vacuous")
      .toBe(2);
    expect(credits.debits).toBe(2);
    const decisions = await w.db.select().from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decisions.length, "an organizer records its decisions").toBe(2);

    // …and the placement is OURS. `last_set_by: 'us'` is the fact that matters and is precisely
    // what a reader must never write: every retro pass keys on it, and `reconcileFolders` will
    // carry such a row to the server. The destination itself is the classifier double's answer
    // or the Ohbox depending on graduation, so it is deliberately not asserted here — this test
    // is about WHO decided, not about where.
    const states = await w.db.select().from(folderState);
    expect(states.length).toBe(2);
    for (const st of states) expect(st.lastSetBy).toBe("us");
  });
});
