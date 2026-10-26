import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, mailboxes as mailboxesTbl, mailboxProfileMirror, organizerRequests, rules as rulesTbl, idempotencyKeys } from "@trafficflow/db";
import { PUBLISHED_RULE_ID } from "@trafficflow/core/rule-order";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * the two RULE-MUTATING VERBS that are not `POST`, under a retried
 * `Idempotency-Key`.
 *
 * An earlier change closed the duplicate-rule class on `POST /rules`. It is not the whole gap,
 * because a retry does not only risk a duplicate ROW — it risks a WRONG ANSWER:
 *
 *  1. `DELETE /rules/:id` retried after a lost response hits `deleted.length === 0` and
 *     throws `not_found`. The revoke SUCCEEDED and the caller is told it failed. The
 *     engine's retry queue drains every pending action (`flushPending`), so this is the
 *     ordinary path, not an exotic one.
 *  2. `PATCH /rules/:id` retried the same way re-runs the UPDATE, appends a SECOND
 *     `change_log` row and answers a DIFFERENT `X-Sync-Seq`. Churn rather than a wrong
 *     answer — every synced client is woken for a delta that changes nothing — so it
 *     ranks second.
 *
 * Neither can duplicate a rule: `remove` and `update` address an EXISTING id, so the
 * `rules` row is unique by construction. This file is therefore about ANSWERS.
 *
 * The concurrent halves live in `rules-verb-replay.pg.test.ts`; PGlite is one connection
 * and cannot reach the interleaving where two lookups both miss.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const RULE = { kind: "domain", match: "acme.example", destination: "ohmail/News" };

/** `POST /rules` and return the created id. */
async function makeRule(deps: ApiDeps, token: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await H(req("POST", "/rules", { bearer: token, body: JSON.stringify({ ...RULE, ...over }) }), deps);
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

const del = (token: string, id: string, key?: string): Request =>
  req("DELETE", `/rules/${id}`, { bearer: token, headers: key ? { "idempotency-key": key } : {} });

const patch = (token: string, id: string, body: unknown, key?: string): Request =>
  req("PATCH", `/rules/${id}`, {
    bearer: token, body: JSON.stringify(body), headers: key ? { "idempotency-key": key } : {},
  });

const changesFor = (db: ApiDeps["db"], accountId: string, entityId: string, op: string) =>
  db.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityId, entityId), eq(changeLog.op, op),
  ));

describe("DELETE /rules/:id replays its first outcome under a key", () => {
  it("a retried DELETE answers 204 and the FIRST seq, not 404", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeRule(deps, s.token);
    const key = "del-retry";

    const first = await H(del(s.token, id, key), deps);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    const seq = first.headers.get("x-sync-seq");
    expect(seq).toBeTruthy();

    // THE DEFECT: the retry queue re-sends the same action after a lost response.
    const retry = await H(del(s.token, id, key), deps);
    expect(retry.status).toBe(204);
    expect(await retry.text()).toBe("");
    expect(retry.headers.get("x-sync-seq")).toBe(seq);

    // One delete change, not two — a replay must not re-notify every synced client.
    expect(await changesFor(db, s.accountId, id, "delete")).toHaveLength(1);
  });

  it("WITHOUT a key an unknown id is still 404 — a probe is not a retry", async () => {
    // The narrow half of the decision. 204-for-everything would turn `DELETE /rules/:id`
    // into an endpoint that never says "no such rule", including for a stranger's id
    // (account scoping makes cross-account indistinguishable from missing).
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeRule(deps, s.token);

    expect((await H(del(s.token, id), deps)).status).toBe(204);
    expect((await H(del(s.token, id), deps)).status).toBe(404);          // no key ⇒ no evidence of a retry
    expect((await H(del(s.token, crypto.randomUUID()), deps)).status).toBe(404);
  });

  it("a cross-account DELETE is 404 even carrying a key (account scoping is not weakened)", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const id = await makeRule(deps, owner.token);

    expect((await H(del(other.token, id, "cross-key"), deps)).status).toBe(404);
    // and nothing was claimed under the stranger's account
    const claimed = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, other.accountId), eq(idempotencyKeys.key, "cross-key")));
    expect(claimed).toHaveLength(0);
    // the rule is untouched
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.id, id))).toHaveLength(1);
  });

  it("the SAME key aimed at a DIFFERENT rule is a 409, never a silent 204", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const a = await makeRule(deps, s.token);
    const b = await makeRule(deps, s.token, { match: "other.example" });
    const key = "shared-key";

    expect((await H(del(s.token, a, key), deps)).status).toBe(204);

    const wrong = await H(del(s.token, b, key), deps);
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe("idempotency_replay");
    // b survives: a 409 refuses, it does not half-apply.
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.id, b))).toHaveLength(1);
  });

  it("a genuine second delete under its OWN key is unaffected", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const a = await makeRule(deps, s.token);
    const b = await makeRule(deps, s.token, { match: "other.example" });

    const ra = await H(del(s.token, a, "key-a"), deps);
    const rb = await H(del(s.token, b, "key-b"), deps);
    expect([ra.status, rb.status]).toEqual([204, 204]);
    expect(rb.headers.get("x-sync-seq")).not.toBe(ra.headers.get("x-sync-seq"));
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.accountId, s.accountId))).toHaveLength(0);
  });

  it("a DELETE that genuinely 404s does NOT burn the key", async () => {
    // A failed request stores nothing (the claim is inside the tx that threw), so the same
    // key remains usable — the key is a promise about an EFFECT, and there was none. Proven
    // by USING it afterwards, not merely by the absent row: a key that survives in the table
    // but 409s on reuse would pass the row check and still be burnt.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const key = "unburnt";
    const id = await makeRule(deps, s.token);

    expect((await H(del(s.token, crypto.randomUUID(), key), deps)).status).toBe(404);
    const claimed = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, s.accountId), eq(idempotencyKeys.key, key)));
    expect(claimed).toHaveLength(0);

    // Same key, a real rule this time: it works, and its own retry replays.
    const ok = await H(del(s.token, id, key), deps);
    expect(ok.status).toBe(204);
    const again = await H(del(s.token, id, key), deps);
    expect(again.status).toBe(204);
    expect(again.headers.get("x-sync-seq")).toBe(ok.headers.get("x-sync-seq"));
  });
});

describe("PATCH /rules/:id replays its first outcome under a key", () => {
  it("a retried PATCH replays the first body and seq, and emits ONE change row", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeRule(deps, s.token);
    const key = "patch-retry";

    const first = await H(patch(s.token, id, { priority: 7 }, key), deps);
    expect(first.status).toBe(200);
    const b1 = await first.json();
    const seq = first.headers.get("x-sync-seq");
    expect(b1.priority).toBe(7);

    const retry = await H(patch(s.token, id, { priority: 7 }, key), deps);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(b1);
    expect(retry.headers.get("x-sync-seq")).toBe(seq);

    // THE churn assertion: two `rule`/`update` rows means every synced client was woken
    // twice for one edit, and the second seq is a delta that changes nothing.
    expect(await changesFor(db, s.accountId, id, "update")).toHaveLength(1);
  });

  it("the same key with a DIFFERENT patch body is a 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeRule(deps, s.token);
    const key = "patch-guard";

    expect((await H(patch(s.token, id, { priority: 1 }, key), deps)).status).toBe(200);

    const wrong = await H(patch(s.token, id, { priority: 2 }, key), deps);
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe("idempotency_replay");

    // The refused patch did not land.
    const row = await db.select().from(rulesTbl).where(eq(rulesTbl.id, id));
    expect(row[0]!.priority).toBe(1);
  });

  it("two DELIBERATE patches under different keys both apply", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeRule(deps, s.token);

    const r1 = await H(patch(s.token, id, { priority: 1 }, "p1"), deps);
    const r2 = await H(patch(s.token, id, { priority: 2 }, "p2"), deps);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect((await r2.json()).priority).toBe(2);
    expect(Number(r2.headers.get("x-sync-seq"))).toBeGreaterThan(Number(r1.headers.get("x-sync-seq")));
    expect(await changesFor(db, s.accountId, id, "update")).toHaveLength(2);
  });

  it("an UNKEYED patch is unchanged — no key, no replay, and that is still correct", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeRule(deps, s.token);

    const r1 = await H(patch(s.token, id, { priority: 3 }), deps);
    const r2 = await H(patch(s.token, id, { priority: 3 }), deps);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await changesFor(db, s.accountId, id, "update")).toHaveLength(2);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A REPLAY ANSWERS WHAT THE ORIGINAL ANSWERED — a QUEUED answer never comes back as DONE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Since mail 0094 a rule edit on an account whose every live mailbox another install organizes is
 * ASKED FOR, not done: the local row stays, a request travels, and the door answers `202` with
 * `{ pending, travel }`. The retry after a lost response has to say the same thing. It did not:
 * `DELETE /rules/:id` replayed its stored row through its OWN shaping, which reads no status at
 * all and answers `204` — "the rule is gone" — while the organizer is offline and still running
 * it. The person is told a rule is gone, the mail keeps being filed by it, and nothing on the
 * surface disagrees.
 *
 * The four cases below are the invariant from both sides and at two verbs, because the fix is in
 * the LAYER and not at this route: one renderer turns a stored row into a response, so a route
 * cannot shape a replay and cannot lose the class while doing it.
 */

/** Make every live mailbox on this account one another install holds — the queued world. */
async function heldElsewhere(db: ApiDeps["db"], accountId: string, mailboxId: string): Promise<void> {
  await db.update(mailboxesTbl).set({
    organizerRole: "reader",
    organizerState: "held",
    organizedByCapabilities: "requests,rules",
    organizedByKind: "local",
    organizedByName: "mila-thinkpad",
  }).where(eq(mailboxesTbl.id, mailboxId));
}

/** An organizer mailbox, so the rule can be created locally before the account becomes a reader. */
async function organizerMailbox(db: ApiDeps["db"], accountId: string): Promise<string> {
  const [mb] = await db.insert(mailboxesTbl).values({
    accountId, provider: "imap",
    address: `replay-${crypto.randomUUID().slice(0, 8)}@lichtgrat.example`,
    organizerRole: "organizer",
  }).returning();
  return mb!.id;
}

describe("a replay answers what the original answered", () => {
  it("CONTROL 1 — a QUEUED delete replays as 202 with its body, never 204", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await organizerMailbox(db, s.accountId);
    const id = await makeRule(deps, s.token);
    await heldElsewhere(db, s.accountId, mailboxId);
    const key = "queued-del-retry";

    // The press. Nothing is removed here — the row is the person's only visible copy of a rule
    // still running on the machine that runs it — so the door says it was ASKED FOR.
    const first = await H(del(s.token, id, key), deps);
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(body.pending).toBe(true);
    expect(body.travel.pending).toHaveLength(1);
    // and the rule is still here, which is the whole reason 204 would be a lie
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.id, id))).toHaveLength(1);

    // THE DEFECT: the response is lost and the engine's retry queue re-sends the action.
    const retry = await H(del(s.token, id, key), deps);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(body);
    // No seq on either answer: nothing changed in this store, and a seq would advance every
    // client's cursor past a change that does not exist.
    expect(retry.headers.get("x-sync-seq")).toBeNull();
    // Still here. A reader who saw 204 would have been told the opposite.
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.id, id))).toHaveLength(1);
  });

  it("CONTROL 2 — a COMPLETED delete still replays as completed (204, first seq, no body)", async () => {
    // The positive control. Preserving the class must not turn the ordinary 204 into a 202, and
    // the bodiless answer must stay bodiless: `new Response(JSON.stringify(x), {status:204})`
    // throws, so a replay path that learned statuses and forgot bodies is a 500 here.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeRule(deps, s.token);
    const key = "done-del-retry";

    const first = await H(del(s.token, id, key), deps);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    const seq = first.headers.get("x-sync-seq");
    expect(seq).toBeTruthy();

    const retry = await H(del(s.token, id, key), deps);
    expect(retry.status).toBe(204);
    expect(await retry.text()).toBe("");
    expect(retry.headers.get("x-sync-seq")).toBe(seq);
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.id, id))).toHaveLength(0);
  });

  it("CONTROL 3 — a QUEUED patch replays as 202 too, so the fix is in the layer", async () => {
    // A SECOND queued verb, and one that reaches the stored row by the OTHER road: `PATCH` is
    // `options: { idempotent: true }` and replays through `withIdempotency`, while `DELETE` reads
    // the key in its own handler. One mutation of the renderer's status line reddens both, which
    // is what "the fix is in the layer" means and the only way to show it.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await organizerMailbox(db, s.accountId);
    const id = await makeRule(deps, s.token);
    await heldElsewhere(db, s.accountId, mailboxId);
    const key = "queued-patch-retry";

    const first = await H(patch(s.token, id, { priority: 9 }, key), deps);
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(body.pending).toBe(true);

    const retry = await H(patch(s.token, id, { priority: 9 }, key), deps);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(body);
    // The rule is unchanged here — the edit is in flight, not applied.
    const [row] = await db.select().from(rulesTbl).where(eq(rulesTbl.id, id));
    expect(row!.priority).toBe(0);
  });

  it("CONTROL 4 — a queued delete under a key aimed at ANOTHER rule is still 409", async () => {
    // Preserving the class must not weaken the hash check: the 409 is decided before any stored
    // response is rendered, and a renderer that answered first would turn a misaimed key into a
    // successful-looking 202 for a rule nobody asked about.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await organizerMailbox(db, s.accountId);
    const a = await makeRule(deps, s.token);
    const b = await makeRule(deps, s.token, { match: "other.example" });
    await heldElsewhere(db, s.accountId, mailboxId);
    const key = "queued-shared-key";

    expect((await H(del(s.token, a, key), deps)).status).toBe(202);

    const wrong = await H(del(s.token, b, key), deps);
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe("idempotency_replay");
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.accountId, s.accountId))).toHaveLength(2);
  });
});

describe("a published rule changed by its key replays its 202", () => {
  /** The organizer's copy of the account's one mailbox lists two rules; this install holds none. */
  async function readerOnly(db: ApiDeps["db"], accountId: string): Promise<void> {
    const mailboxId = await organizerMailbox(db, accountId);
    await heldElsewhere(db, accountId, mailboxId);
    await db.insert(mailboxProfileMirror).values({
      mailboxId, accountId, readAt: FIXED_NOW,
      doc: { v: 2, rules: [
        { kind: "domain", match: "acme.example", destination: "ohmail/News", priority: 0, enabled: true },
        { kind: "domain", match: "other.example", destination: "INBOX", priority: 0, enabled: true },
      ] },
    });
  }
  const keyOf = (match: string) => ({ kind: "domain", match, subjectContains: null, bodyContains: null });
  const delByKey = (token: string, key: unknown, idem: string): Request =>
    req("DELETE", `/rules/${PUBLISHED_RULE_ID}`, { bearer: token, body: JSON.stringify({ key }), headers: { "idempotency-key": idem } });

  it("DELETE by key answers 202, writes no rule row, and its retry replays the same body", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await readerOnly(db, s.accountId);
    const first = await H(delByKey(s.token, keyOf("acme.example"), "key-del"), deps);
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(body.pending).toBe(true);
    expect(body.rule).toBeUndefined();
    const retry = await H(delByKey(s.token, keyOf("acme.example"), "key-del"), deps);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(body);
    expect(await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, s.accountId))).toHaveLength(1);
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.accountId, s.accountId))).toEqual([]);
  });

  it("PATCH by key answers 202 and replays it; the same idempotency key aimed at another rule is 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await readerOnly(db, s.accountId);
    const first = await H(patch(s.token, PUBLISHED_RULE_ID, { key: keyOf("acme.example"), destination: "INBOX" }, "key-patch"), deps);
    expect(first.status).toBe(202);
    const body = await first.json();
    const retry = await H(patch(s.token, PUBLISHED_RULE_ID, { key: keyOf("acme.example"), destination: "INBOX" }, "key-patch"), deps);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(body);
    const wrong = await H(patch(s.token, PUBLISHED_RULE_ID, { key: keyOf("other.example"), destination: "INBOX" }, "key-patch"), deps);
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe("idempotency_replay");
    const wrongDel = await H(delByKey(s.token, keyOf("other.example"), "key-del-2"), deps);
    expect(wrongDel.status).toBe(202);
    expect((await H(delByKey(s.token, keyOf("acme.example"), "key-del-2"), deps)).status).toBe(409);
  });
});
