import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts, outboundSends } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SEND_STALE_AFTER_MS } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, seedThread, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("drafts CRUD + X-Sync-Seq", () => {
  it("POST → GET → PUT → DELETE, each mutation echoes X-Sync-Seq", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const created = await H(req("POST", "/drafts", {
      bearer: s.token, body: JSON.stringify({ mailboxId, subject: "Re: hi", body: "Thanks!" }),
    }), deps);
    expect(created.status).toBe(201);
    expect(created.headers.get("x-sync-seq")).toBeTruthy();
    const draft = await created.json();
    expect(draft.status).toBe("draft");
    expect(draft.mailboxId).toBe(mailboxId);

    const got = await H(req("GET", `/drafts/${draft.id}`, { bearer: s.token }), deps);
    expect(got.status).toBe(200);
    expect((await got.json()).body).toBe("Thanks!");

    const put = await H(req("PUT", `/drafts/${draft.id}`, {
      bearer: s.token, body: JSON.stringify({ body: "Thanks a lot!" }),
    }), deps);
    expect(put.status).toBe(200);
    expect(put.headers.get("x-sync-seq")).toBeTruthy();
    expect((await put.json()).body).toBe("Thanks a lot!");

    const del = await H(req("DELETE", `/drafts/${draft.id}`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);
    expect(del.headers.get("x-sync-seq")).toBeTruthy();
    expect((await H(req("GET", `/drafts/${draft.id}`, { bearer: s.token }), deps)).status).toBe(404);
  });

  it("a created draft surfaces in GET /sync creates (no-tombstone proof)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const created = await H(req("POST", "/drafts", {
      bearer: s.token, body: JSON.stringify({ mailboxId, subject: "Hello" }),
    }), deps);
    const draft = await created.json();

    const sync = await H(req("GET", "/sync?since=0", { bearer: s.token }), deps);
    const body = await sync.json();
    const create = body.changes.creates.find((c: { id: string }) => c.id === draft.id);
    expect(create).toBeDefined();
    expect(create.type).toBe("draft");
    expect(create.entity.subject).toBe("Hello");
    // Did NOT tombstone (the RC4 failure mode without materializeDraft).
    expect(body.changes.deletes.find((d: { id: string }) => d.id === draft.id)).toBeUndefined();
  });

  it("create validates mailboxId ownership: foreign mailbox → 400", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "d-owner" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "d-other" });
    const foreignMailbox = await seedMailbox(db, { accountId: other.accountId });

    // owner tries to compose from another account's mailbox.
    const res = await H(req("POST", "/drafts", {
      bearer: owner.token, body: JSON.stringify({ mailboxId: foreignMailbox }),
    }), deps);
    expect(res.status).toBe(400);
  });

  it("cross-account get / PUT / delete → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "dc-owner" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "dc-other" });
    const mailboxId = await seedMailbox(db, { accountId: owner.accountId });
    const draft = await (await H(req("POST", "/drafts", { bearer: owner.token, body: JSON.stringify({ mailboxId, subject: "A only" }) }), deps)).json();

    expect((await H(req("GET", `/drafts/${draft.id}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("PUT", `/drafts/${draft.id}`, { bearer: other.token, body: JSON.stringify({ body: "x" }) }), deps)).status).toBe(404);
    expect((await H(req("DELETE", `/drafts/${draft.id}`, { bearer: other.token }), deps)).status).toBe(404);
  });

  it("a reply target must be the caller's OWN thread — another account's thread id is a 404, on create and on update", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "t-owner" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "t-other" });
    const mailboxId = await seedMailbox(db, { accountId: owner.accountId });
    const foreignThread = await seedThread(db, { accountId: other.accountId, subject: "not yours" });
    const ownThread = await seedThread(db, { accountId: owner.accountId, subject: "yours" });

    // Create: the foreign thread is refused outright; nothing is stored against it.
    const refused = await H(req("POST", "/drafts", {
      bearer: owner.token, body: JSON.stringify({ mailboxId, subject: "x", threadId: foreignThread }),
    }), deps);
    expect(refused.status).toBe(404);

    // Update: an owned draft cannot be repointed at another account's thread either.
    const draft = await (await H(req("POST", "/drafts", {
      bearer: owner.token, body: JSON.stringify({ mailboxId, subject: "x", threadId: ownThread }),
    }), deps)).json();
    expect((await H(req("PUT", `/drafts/${draft.id}`, {
      bearer: owner.token, body: JSON.stringify({ threadId: foreignThread }),
    }), deps)).status).toBe(404);
    // …while the owned thread is accepted.
    expect((await H(req("PUT", `/drafts/${draft.id}`, {
      bearer: owner.token, body: JSON.stringify({ threadId: ownThread }),
    }), deps)).status).toBe(200);
  });
});

describe("POST /drafts is idempotent — the durable outbox's restart replay must not mint twins", () => {
  it("a same-key retry replays the stored 201 verbatim: one row, same id, same X-Sync-Seq", async () => {
    // The engine's durable outbox replays a lost-response create under the ORIGINAL
    // Idempotency-Key, possibly a restart later. Before this route was idempotent-marked the
    // replay stored a SECOND draft — the compose surface then autosaved into one row while
    // its twin sat in the rail forever.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const body = JSON.stringify({ mailboxId, subject: "Re: once", body: "exactly once" });

    const first = await H(req("POST", "/drafts", {
      bearer: s.token, body, headers: { "idempotency-key": "outbox-replay-1" },
    }), deps);
    expect(first.status).toBe(201);
    const firstDraft = await first.json();

    const replay = await H(req("POST", "/drafts", {
      bearer: s.token, body, headers: { "idempotency-key": "outbox-replay-1" },
    }), deps);
    expect(replay.status).toBe(201);
    const replayed = await replay.json();

    // Byte-for-byte the first answer: same row, same seq echo — the adapter reads `id` off it.
    expect(replayed).toEqual(firstDraft);
    expect(replay.headers.get("x-sync-seq")).toBe(first.headers.get("x-sync-seq"));
    const rows = await db.select().from(drafts);
    expect(rows).toHaveLength(1);
  });

  it("the same key with a DIFFERENT request is a 409, never a silent second draft", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const first = await H(req("POST", "/drafts", {
      bearer: s.token, headers: { "idempotency-key": "outbox-replay-2" },
      body: JSON.stringify({ mailboxId, subject: "A" }),
    }), deps);
    expect(first.status).toBe(201);

    const reused = await H(req("POST", "/drafts", {
      bearer: s.token, headers: { "idempotency-key": "outbox-replay-2" },
      body: JSON.stringify({ mailboxId, subject: "B — not the same request" }),
    }), deps);
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe("idempotency_replay");
    expect(await db.select().from(drafts)).toHaveLength(1);
  });
});

/**
 * ── DISCARDING A MESSAGE THAT HAS A SEND ON RECORD ────────────────────────────────────────────
 *
 * `outbound_sends.draft_id` references `drafts(id)` `ON DELETE no action`
 * (`packages/db-mail/drizzle/0013_outbound_sends.sql`), and every `POST /drafts/:id/send` inserts
 * such a row before it dials. The reservation OUTLIVES the send: `finalizeSent` clears
 * `send_at`/`send_key` and moves the row to `sent`, the ambiguous outcome moves it to
 * `unverified`, and a rollback puts it back at `draft` — in all three the reservation stays,
 * because it is the replay guard that makes a same-key retry safe.
 *
 * `DraftsService.remove` deletes on `status != 'scheduled' AND send_key IS NULL`, which every one
 * of those three states satisfies. The delete therefore reaches the foreign key, Postgres raises
 * 23503, and the router — which maps only `ServiceError` — answers `internal` 500. A person
 * discarding a message whose send could not be confirmed is told the app broke, and the row stays
 * in Drafts either way.
 *
 * The 409 these cases ask for is the honest answer: the row is the account's record of a send that
 * happened, so it stays, and the sentence says why. The `:35` DELETE above is green because it
 * deletes a draft that was never sent — the state this refusal must keep deleting.
 */
describe("DELETE /drafts/:id — a row with a send on record refuses by name, never a 500", () => {
  /** Fake send adapter: echoes the pre-minted id, drives `messageInSent`. */
  function fakeAdapter(opts: { inSent?: boolean } = {}) {
    const state = { sendCalls: 0 };
    const factory: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage) {
        state.sendCalls += 1;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return opts.inSent ?? false; },
      async close() { /* no-op */ },
    });
    return { factory, state };
  }

  /**
   * A DELIVERED message's row IS DISCARDABLE, and the ledger row outlives it.
   *
   * This case asserted `409 send_recorded` and "nothing was removed" — the behaviour mail 0095
   * retires. `sendOnRecord` is now `status IN ('pending','unverified')`, so a `sent` (or `failed`)
   * ledger row no longer refuses the delete: nothing is in flight and nothing is unknown, so
   * refusing was the predicate asking whether a ROW EXISTED rather than whether a send was still on
   * record. What the refusal used to stand in front of was a `23503` from `NOT NULL … ON DELETE NO
   * ACTION`, which the same migration replaces with `ON DELETE SET NULL`.
   *
   * So the assertions move to what the design actually promises, and they are STRONGER than the 409
   * was: the words go, the fact that something was attempted does not, and the replay gate that
   * makes a same-key retry replay instead of delivering a second copy is untouched — its identity
   * is `UNIQUE(account_id, idempotency_key)` and never mentioned `draft_id`. The retry's own answer
   * for a discarded draft (`409 send_key_draft_discarded`) is pinned in
   * `packages/services/test/send-replay-discarded-draft.test.ts`.
   */
  it("a DELIVERED message's row: 204, and the reservation survives with a null draft", async () => {
    const { factory } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const created = await H(req("POST", "/drafts", {
      bearer: s.token,
      body: JSON.stringify({ mailboxId, subject: "Re: hi", body: "Thanks!", to: [{ name: null, address: "you@example.com" }] }),
    }), deps);
    expect(created.status).toBe(201);
    const draft = await created.json();

    const sent = await H(req("POST", `/drafts/${draft.id}/send`, {
      bearer: s.token, headers: { "idempotency-key": "send-recorded-1" },
    }), deps);
    expect(sent.status).toBe(200);
    expect((await sent.json()).status).toBe("sent");

    const del = await H(req("DELETE", `/drafts/${draft.id}`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);
    // THE WORDS GO…
    expect(await db.select().from(drafts).where(eq(drafts.id, draft.id))).toHaveLength(0);
    // …AND THE RECORD OF THE ATTEMPT DOES NOT. One ledger row for this account, its draft
    // reference cleared by the foreign key rather than the row taken with the draft: a CASCADE
    // would have handed the next press of the same key a clean slate for a message that may
    // already be in somebody's inbox.
    const ledger = await db.select().from(outboundSends).where(eq(outboundSends.accountId, s.accountId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.draftId).toBeNull();
    expect(ledger[0]!.status).toBe("sent");
    expect(ledger[0]!.idempotencyKey).toBe("send-recorded-1");
    // And nothing is left pointing at the draft that is gone.
    expect(await db.select().from(outboundSends).where(eq(outboundSends.draftId, draft.id))).toHaveLength(0);
  });

  /**
   * THE ROW A PERSON ACTUALLY PRESSES DISCARD ON. It used to answer 409 `send_recorded` — "resolve
   * it first" — and one reply was pressed for weeks by somebody who did not understand the
   * question. The discard is theirs: 204, the row gone, and the ledger row kept with
   * `resolved_by = 'discard'` so a same-key replay is refused as discarded.
   */
  it("an UNCONFIRMED send's row — the one a person actually presses Discard on: 204, ledger stamped", async () => {
    const { factory } = fakeAdapter({ inSent: false });
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const [row] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    const draftId = row!.id;
    // A crashed prior attempt, past the staleness horizon: the send route probes Sent, finds
    // nothing, and marks the row `unverified` with `send_key` cleared.
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "unverified-discard", draftId,
      mintedMessageId: "<ambiguous@lichtgrat.example>", status: "pending",
      createdAt: new Date(FIXED_NOW.getTime() - SEND_STALE_AFTER_MS - 1000),
    });
    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "unverified-discard" },
    }), deps);
    expect((await res.json()).status).toBe("unverified");

    const del = await H(req("DELETE", `/drafts/${draftId}`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);
    expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toHaveLength(0);
    const [ledger] = await db.select().from(outboundSends)
      .where(eq(outboundSends.idempotencyKey, "unverified-discard"));
    expect(ledger!.status, "a discard is not evidence about delivery").toBe("unverified");
    expect(ledger!.resolvedBy, "the ledger does not say the question was closed by a discard").toBe("discard");
    expect(ledger!.draftId).toBeNull();
  });

  /**
   * THE ONE HOLD THAT STAYS: a send that may still be on the wire. Refused by name with a sentence
   * the row renders; the reconciler settles a stale one within minutes and the next press goes.
   */
  it("a send STILL RUNNING holds its draft — 409 send_recorded, through the route", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const [row] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "live-attempt", draftId: row!.id,
      mintedMessageId: "<live@lichtgrat.example>", status: "pending", createdAt: FIXED_NOW,
    });

    const del = await H(req("DELETE", `/drafts/${row!.id}`, { bearer: s.token }), deps);
    expect(del.status).toBe(409);
    expect((await del.json()).error.code).toBe("send_recorded");
    expect(await db.select().from(drafts).where(eq(drafts.id, row!.id))).toHaveLength(1);
  });

  /**
   * ── AND THE WAY OUT OF THAT ROW, THROUGH THE ROUTE ───────────────────────────────────────
   *
   * A refusal is only as real as the pipeline the route runs, so both halves of the resolution are
   * driven here and not only at the service: the answer a person gives for a send that stopped
   * without one, and the refusal for a send that may not have stopped at all.
   */
  it("a STRANDED `sending` row resolves through the route, and then it deletes", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const [row] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "did this go?", body: "the only copy",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    const draftId = row!.id;
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "stranded-1", draftId,
      mintedMessageId: "<stranded@lichtgrat.example>", status: "pending",
      createdAt: new Date(FIXED_NOW.getTime() - SEND_STALE_AFTER_MS - 1000),
    });

    const res = await H(req("POST", `/drafts/${draftId}/resolve`, {
      bearer: s.token, body: JSON.stringify({ outcome: "not_arrived" }),
    }), deps);

    expect(res.status).toBe(200);
    expect(
      (await res.json()).status,
      "the route answered 200 for a press that moved nothing — the row is still stranded and the "
      + "surface reports a success",
    ).toBe("draft");
    const del = await H(req("DELETE", `/drafts/${draftId}`, { bearer: s.token }), deps);
    expect(del.status, "the resolved row is still undeletable through the route").toBe(204);
  });

  it("a send that may STILL BE RUNNING is refused through the route, by name", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const [row] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "going out now", body: "the only copy",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    const draftId = row!.id;
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "running-1", draftId,
      mintedMessageId: "<running@lichtgrat.example>", status: "pending",
      createdAt: new Date(FIXED_NOW.getTime() - 30_000),
    });

    const res = await H(req("POST", `/drafts/${draftId}/resolve`, {
      bearer: s.token, body: JSON.stringify({ outcome: "not_arrived" }),
    }), deps);

    expect(
      res.status,
      "a send that may be mid-SMTP this second was settled by a press — the row is freed and the "
      + "next one delivers a second copy of mail already on the wire",
    ).toBe(409);
    expect(
      (await res.json()).error.code,
      "the refusal does not name a state a person can wait out, so the surface can only say the "
      + "answer failed to reach the server",
    ).toBe("send_still_running");
    expect(
      (await db.select().from(drafts).where(eq(drafts.id, draftId)))[0]!.status,
      "a refused resolve moved the draft anyway",
    ).toBe("sending");
  });

  it("POSITIVE CONTROL — a row that was never sent still deletes, 204", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draft = await (await H(req("POST", "/drafts", {
      bearer: s.token, body: JSON.stringify({ mailboxId, subject: "never sent" }),
    }), deps)).json();

    const del = await H(req("DELETE", `/drafts/${draft.id}`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);
    expect(await db.select().from(drafts).where(eq(drafts.id, draft.id))).toHaveLength(0);
  });
});

describe("PUT /drafts/:id with ifContentRevision", () => {
  it("refuses an outdated version 409 draft_changed, admits a restatement without a seq, and a malformed one is 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, token: "rev-owner" });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const put = (id: string, body: unknown) => H(req("PUT", `/drafts/${id}`, { bearer: s.token, body: JSON.stringify(body) }), deps);
    const created = await (await H(req("POST", "/drafts", {
      bearer: s.token, body: JSON.stringify({ mailboxId, subject: "Plans", body: "Typed here." }),
    }), deps)).json();
    const first = created.contentRevision as string;
    const moved = await put(created.id, { body: "Typed elsewhere.", ifContentRevision: first });
    expect(moved.status).toBe(200);

    const stale = await put(created.id, { body: "Typed here, and more.", ifContentRevision: first });
    expect({ status: stale.status, code: (await stale.json()).error?.code }).toEqual({ status: 409, code: "draft_changed" });
    const [row] = await db.select({ body: drafts.body }).from(drafts).where(eq(drafts.id, created.id));
    expect(row!.body).toBe("Typed elsewhere.");

    const again = await put(created.id, { body: "Typed elsewhere.", ifContentRevision: first });
    expect({ status: again.status, seq: again.headers.get("x-sync-seq") }).toEqual({ status: 200, seq: null });

    expect((await put(created.id, { body: "x", ifContentRevision: "not-a-revision" })).status).toBe(400);
  });
});
