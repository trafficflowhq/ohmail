import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { mailboxes } from "../src/schema.js";
import {
  insertOrganizerRequest, listPendingRequests, listSentRequests,
  markRequestsSent, markRequestsApplied, markRequestsExpired, markRequestsRefused,
  listStaleSentRequests, listOutstandingForAccount, REFUSAL_VISIBLE_FOR_MS, mailboxRowsHeld,
} from "../src/organizer-requests.js";

const ACCT = "00000000-0000-0000-0000-0000000000db";
const NOW = new Date("2026-09-03T12:00:00.000Z");

async function seedMailbox(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${crypto.randomUUID()}@x.example`,
  }).returning({ id: mailboxes.id });
  return mb!.id;
}

describe("organizer_requests — the reader's own bookkeeping", () => {
  it("the full state machine: pending → sent → applied", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = crypto.randomUUID();

    const row = await db.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    expect(row.state).toBe("pending");
    expect(row.sentAt).toBeNull();
    expect(row.resolvedAt).toBeNull();

    let pending = await db.transaction((tx) => listPendingRequests(tx, mailboxId));
    expect(pending.map((r) => r.id)).toEqual([id]);

    await db.transaction((tx) => markRequestsSent(tx, [id], NOW));
    pending = await db.transaction((tx) => listPendingRequests(tx, mailboxId));
    expect(pending).toEqual([]);
    const sent = await db.transaction((tx) => listSentRequests(tx, mailboxId));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.state).toBe("sent");
    expect(sent[0]!.sentAt?.getTime()).toBe(NOW.getTime());

    const resolvedAt = new Date(NOW.getTime() + 1000);
    await db.transaction((tx) => markRequestsApplied(tx, [id], resolvedAt));
    const afterApply = await db.transaction((tx) => listSentRequests(tx, mailboxId));
    expect(afterApply).toEqual([]);
  });

  it("sent → expired, on the stale-sent read", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = crypto.randomUUID();
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    const sentAt = NOW;
    await db.transaction((tx) => markRequestsSent(tx, [id], sentAt));

    // `olderThan` names the CUTOFF: a row qualifies when `sentAt < olderThan`. A cutoff BEFORE
    // `sentAt` (e.g. "requests sent before an hour ago", asked one second after sending) must not
    // catch a row sent one second ago.
    const stillFresh = await db.transaction((tx) => listStaleSentRequests(
      tx, mailboxId, new Date(sentAt.getTime() - 1),
    ));
    expect(stillFresh.map((r) => r.id)).not.toContain(id);

    // A cutoff AFTER `sentAt` — the ordinary "24h have passed" shape — catches it.
    const nowStale = await db.transaction((tx) => listStaleSentRequests(
      tx, mailboxId, new Date(sentAt.getTime() + 1),
    ));
    expect(nowStale.map((r) => r.id)).toEqual([id]);

    const resolvedAt = new Date(sentAt.getTime() + 24 * 3600_000 + 1000);
    await db.transaction((tx) => markRequestsExpired(tx, [id], resolvedAt));
    const afterExpire = await db.transaction((tx) => listSentRequests(tx, mailboxId));
    expect(afterExpire).toEqual([]);
  });

  it("state transitions are guarded by the CURRENT state — markRequestsSent is a no-op on an already-sent row", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = crypto.randomUUID();
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await db.transaction((tx) => markRequestsSent(tx, [id], NOW));
    // Applying it, then trying to re-mark it sent, must not resurrect it to `sent`.
    const resolvedAt = new Date(NOW.getTime() + 1000);
    await db.transaction((tx) => markRequestsApplied(tx, [id], resolvedAt));
    await db.transaction((tx) => markRequestsSent(tx, [id], new Date(NOW.getTime() + 2000)));
    const sent = await db.transaction((tx) => listSentRequests(tx, mailboxId));
    expect(sent).toEqual([]); // still applied, not resurrected to sent
  });

  /**
   * ORDERING — `listPendingRequests` sorts `decidedAt` then `id`, matching
   * `packages/organizer/src/request-drain.ts`'s own sort of the folder's records, so a reader's cycle
   * appends two outstanding decisions to the mailbox in the same order the organizer will see
   * them applied in.
   */
  it("listPendingRequests orders by decidedAt then id — stable across ties", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const later = new Date(NOW.getTime() + 60_000);
    // Inserted out of order; a tie on `decidedAt` (b, a) breaks on id ascending.
    const c = crypto.randomUUID();
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id: c, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "c@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: later,
    }));
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id: b!, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "b@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id: a!, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));

    const pending = await db.transaction((tx) => listPendingRequests(tx, mailboxId));
    expect(pending.map((r) => r.id)).toEqual([a, b, c]); // NOW-tied pair first (id order), later-decided c last
  });
});

describe("listOutstandingForAccount", () => {
  it("returns pending and sent rows, across mailboxes, and skips applied/expired ones", async () => {
    const db = await makeTestDb();
    const mbA = await seedMailbox(db);
    const mbB = await seedMailbox(db);
    const pendingId = crypto.randomUUID();
    const sentId = crypto.randomUUID();
    const appliedId = crypto.randomUUID();
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id: pendingId, accountId: ACCT, mailboxId: mbA, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id: sentId, accountId: ACCT, mailboxId: mbB, kind: "screener.decide",
      payload: { scope: "domain", match: "corp.example", appliedFolder: "ohmail/Screened", decision: "no" },
      decidedAt: NOW,
    }));
    await db.transaction((tx) => markRequestsSent(tx, [sentId], NOW));
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id: appliedId, accountId: ACCT, mailboxId: mbA, kind: "screener.decide",
      payload: { scope: "sender", match: "gone@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await db.transaction((tx) => markRequestsSent(tx, [appliedId], NOW));
    await db.transaction((tx) => markRequestsApplied(tx, [appliedId], NOW));

    const out = await db.transaction((tx) => listOutstandingForAccount(tx, ACCT));
    expect(new Set(out.map((o) => o.id))).toEqual(new Set([pendingId, sentId]));
    const byId = new Map(out.map((o) => [o.id, o]));
    // `refusedReason` is null on anything that is not `refused` — the field is only ever the
    // organizer's own answer, never a value a waiting row carries.
    expect(byId.get(pendingId)).toEqual({
      id: pendingId, scope: "sender", match: "a@x.example", decidedAt: NOW, state: "pending",
      refusedReason: null,
    });
    expect(byId.get(sentId)).toEqual({
      id: sentId, scope: "domain", match: "corp.example", decidedAt: NOW, state: "sent",
      refusedReason: null,
    });
  });

  /**
   * A REFUSED ROW IS RETURNED, AND IT IS THE ONE MEMBER OF THIS SET THAT IS NOT OUTSTANDING.
   *
   * The caller excludes `pending`/`sent` senders from the Screener queue. It must NOT exclude a
   * refused one: the organizer said no, so the decision did not happen and the person has to see
   * that sender again. The row rides along only to carry the reason, and it stops riding once the
   * refusal is older than {@link REFUSAL_VISIBLE_FOR_MS} — a terminal row with no bound would sit
   * on the list for ever.
   */
  it("returns a RECENT refusal with its reason, and drops it once it is old", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = crypto.randomUUID();
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "no@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await db.transaction((tx) => markRequestsSent(tx, [id], NOW));
    await db.transaction((tx) => markRequestsRefused(tx, [id], "wrong_mailbox", NOW));

    const fresh = await db.transaction((tx) => listOutstandingForAccount(tx, ACCT, NOW));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ id, state: "refused", refusedReason: "wrong_mailbox" });

    const later = new Date(NOW.getTime() + REFUSAL_VISIBLE_FOR_MS + 60_000);
    expect(await db.transaction((tx) => listOutstandingForAccount(tx, ACCT, later))).toEqual([]);
  });

  it("lower-cases the match", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = crypto.randomUUID();
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "Person@Example.COM", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    const out = await db.transaction((tx) => listOutstandingForAccount(tx, ACCT));
    expect(out[0]?.match).toBe("person@example.com");
  });

  it("skips a row whose payload does not parse, rather than throwing", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = crypto.randomUUID();
    await db.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide", payload: { nonsense: true }, decidedAt: NOW,
    }));
    const out = await db.transaction((tx) => listOutstandingForAccount(tx, ACCT));
    expect(out).toEqual([]);
  });

  it("is empty for an account with no outstanding requests", async () => {
    const db = await makeTestDb();
    const out = await db.transaction((tx) => listOutstandingForAccount(tx, ACCT));
    expect(out).toEqual([]);
  });
});

describe("mailboxRowsHeld — which named ids are rows of this store", () => {
  it("answers any account and removed rows, and ignores what no row can carry", async () => {
    const db = await makeTestDb();
    const mine = await seedMailbox(db);
    const [gone] = await db.insert(mailboxes).values({
      accountId: crypto.randomUUID(), provider: "imap", address: "gone@x.example", status: "disabled",
    }).returning({ id: mailboxes.id });
    const never = crypto.randomUUID();
    const held = await db.transaction((tx) => mailboxRowsHeld(tx, [mine, gone!.id, never, "not-a-uuid", mine]));
    expect([...held].sort()).toEqual([mine, gone!.id].sort());
    expect(await db.transaction((tx) => mailboxRowsHeld(tx, []))).toEqual(new Set());
    expect(await db.transaction((tx) => mailboxRowsHeld(tx, ["phone-row-7"]))).toEqual(new Set());
  });
});

