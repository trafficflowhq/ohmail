import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts, outboundSends, outboundSendFingerprints } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SEND_STALE_AFTER_MS, sendContentFingerprint } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedBody, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Fake send adapter + spy: counts `send` calls, echoes the pre-minted id, drives `messageInSent`. */
function fakeAdapter(opts: { inSent?: boolean } = {}) {
  const state = { sendCalls: 0, inSentCalls: 0, sentIds: [] as string[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.sentIds.push(msg.messageId!);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { state.inSentCalls += 1; return opts.inSent ?? false; },
    async close() { /* no-op */ },
  });
  return { factory, state };
}

async function seedDraft(
  db: ApiDeps["db"], accountId: string, mailboxId: string, status = "draft",
  over: Partial<{ subject: string; body: string; html: string; to: unknown; cc: unknown }> = {},
): Promise<string> {
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId, subject: "Re: hi", body: "Thanks!",
    to: [{ name: null, address: "you@example.com" }], status,
    ...over,
  } as never).returning();
  return d!.id;
}

describe("POST /drafts/:id/send — gated idempotent send (Phase 3c)", () => {
  it("first send → 200 { status:'sent', providerMessageId }, X-Sync-Seq, draft flips to 'sent', visible in /sync", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId);

    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "send-1" },
    }), deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-sync-seq")).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("sent");
    expect(body.providerMessageId).toMatch(/^<.+@/);
    expect(state.sendCalls).toBe(1);

    // The draft flipped to 'sent'.
    const got = await H(req("GET", `/drafts/${draftId}`, { bearer: s.token }), deps);
    expect((await got.json()).status).toBe("sent");

    // outbound_sends row committed 'sent'.
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");

    // A `draft` update is visible in /sync (no tombstone).
    const sync = await H(req("GET", "/sync?since=0", { bearer: s.token }), deps);
    const sbody = await sync.json();
    const seen = [...sbody.changes.creates, ...sbody.changes.updates].find((c: { id: string }) => c.id === draftId);
    expect(seen).toBeDefined();
    expect(seen.type).toBe("draft");
    expect(sbody.changes.deletes.find((d: { id: string }) => d.id === draftId)).toBeUndefined();
  });

  it("CRUX — same Idempotency-Key retry does NOT resend (send-count 1) and returns the same result", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId);

    const one = await H(req("POST", `/drafts/${draftId}/send`, { bearer: s.token, headers: { "idempotency-key": "same" } }), deps);
    const two = await H(req("POST", `/drafts/${draftId}/send`, { bearer: s.token, headers: { "idempotency-key": "same" } }), deps);

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(state.sendCalls).toBe(1);
    expect((await one.json()).providerMessageId).toBe((await two.json()).providerMessageId);
  });

  it("missing Idempotency-Key → 400", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId);

    const res = await H(req("POST", `/drafts/${draftId}/send`, { bearer: s.token }), deps);
    expect(res.status).toBe(400);
    expect(state.sendCalls).toBe(0);
  });

  it("cross-account draft → 404", async () => {
    const { factory } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const owner = await seedSession(db, { now: FIXED_NOW, token: "send-owner" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "send-other" });
    const mailboxId = await seedMailbox(db, { accountId: owner.accountId });
    const draftId = await seedDraft(db, owner.accountId, mailboxId);

    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: other.token, headers: { "idempotency-key": "x" },
    }), deps);
    expect(res.status).toBe(404);
  });

  it("crash-recovery ambiguous → the API surfaces the 'unverified' state (200), no resend", async () => {
    const { factory, state } = fakeAdapter({ inSent: false });
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId, "sending");
    // A CRASHED prior attempt: a pending reservation whose id is NOT in Sent, and whose age is
    // past `SEND_STALE_AFTER_MS` — the recovery path is only for reservations that provably
    // have no live sender behind them any more.
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "amb", draftId,
      mintedMessageId: "<ambiguous@lichtgrat.example>", status: "pending",
      createdAt: new Date(FIXED_NOW.getTime() - SEND_STALE_AFTER_MS - 1000),
    });

    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "amb" },
    }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("unverified");
    expect(body.message).toMatch(/couldn't confirm/i);
    expect(state.sendCalls).toBe(0);
  });

  it("a FRESH pending reservation is in_flight (409) — it must not be probed or marked unverified", async () => {
    // The double-tap: the first attempt is still mid-SMTP when the second request arrives.
    // Probing Sent here finds nothing (the message has not landed YET) and used to write
    // `unverified`, i.e. a send that is in fact succeeding was reported as ambiguous and the
    // user was told to go check their Sent folder. A young reservation is in flight, full stop.
    const { factory, state } = fakeAdapter({ inSent: false });
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId, "sending");
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "live", draftId,
      mintedMessageId: "<inflight@lichtgrat.example>", status: "pending",
      createdAt: new Date(FIXED_NOW.getTime() - 5_000),        // 5 s old: an invocation could still be alive
    });

    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "live" },
    }), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe("in_flight");
    expect(state.sendCalls).toBe(0);                            // never resent
    expect(state.inSentCalls ?? 0).toBe(0);                     // and never even probed

    // The reservation is untouched — no `unverified`, so the real sender can still finalize it.
    const [row] = await db.select().from(outboundSends)
      .where(eq(outboundSends.idempotencyKey, "live"));
    expect(row!.status).toBe("pending");
  });
});

/**
 * THE ACCOUNT'S CLAIM ON THE CONTENT — the duplicate defence that does not need the client's key.
 *
 * These cases are the SHAPE of the guard and they run on PGlite, which means they are worth
 * exactly that: PGlite is one connection, so it cannot host the block-on-unique-index race or show
 * a rollback it never had to perform. The evidence for those is
 * `packages/api/test/send-duplicate-guard.pg.test.ts` on real Postgres over two physical
 * connections. Kept here anyway so the fast suite notices if the refusal stops firing at all.
 */
describe("POST /drafts/:id/send — forwardParts is refused unless it is a list of ids beside forwardOf", () => {
  const ID = "aaaaaaaa-0000-4000-8000-000000000001";
  const FWD = "bbbbbbbb-0000-4000-8000-000000000002";
  const bad: Array<[string, Record<string, unknown>]> = [
    ["without forwardOf", { forwardParts: [ID] }],
    ["not an array", { forwardOf: FWD, forwardParts: ID }],
    ["null", { forwardOf: FWD, forwardParts: null }],
    ["a non-id member", { forwardOf: FWD, forwardParts: [ID, "x"] }],
    ["a non-string member", { forwardOf: FWD, forwardParts: [7] }],
    ["over the part ceiling", { forwardOf: FWD, forwardParts: Array.from({ length: 101 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`) }],
  ];
  for (const [what, body] of bad) {
    it(`${what} → 400, nothing sent`, async () => {
      const { factory, state } = fakeAdapter();
      const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
      const s = await seedSession(db, { now: FIXED_NOW });
      const mailboxId = await seedMailbox(db, { accountId: s.accountId });
      const draftId = await seedDraft(db, s.accountId, mailboxId);
      const res = await H(req("POST", `/drafts/${draftId}/send`, {
        bearer: s.token, headers: { "idempotency-key": `fp-${what}` }, body: JSON.stringify(body),
      }), deps);
      expect(res.status).toBe(400);
      expect(state.sendCalls).toBe(0);
      expect(await db.select().from(outboundSends)).toHaveLength(0);
    });
  }

  it("a well-formed list reaches the send: a part not in the original is 409 forward_parts_changed", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const orig = await seedMessage(db, { accountId: s.accountId, mailboxId });
    await seedBody(db, { messageId: orig.id, text: "the original" });
    const draftId = await seedDraft(db, s.accountId, mailboxId);
    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "fp-ok" },
      body: JSON.stringify({ forwardOf: orig.id, forwardParts: [ID, ID] }),
    }), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("forward_parts_changed");
    expect(state.sendCalls).toBe(0);
  });
});

describe("POST /drafts/:id/send — an identical message is refused as a duplicate", () => {
  it("a SECOND DRAFT with the same content, a fresh key → 409 duplicate_send and ONE submission", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const first = await seedDraft(db, s.accountId, mailboxId);
    const one = await H(req("POST", `/drafts/${first}/send`, {
      bearer: s.token, headers: { "idempotency-key": "dup-k1" },
    }), deps);
    expect(one.status).toBe(200);
    expect(state.sendCalls).toBe(1);

    // The measured sequence: the client shed its draft id, composed a fresh row holding the same
    // message, and minted a fresh key. Neither `UNIQUE (account_id, idempotency_key)` nor the
    // draft-status refusal can see this — both are keyed on something that just changed.
    const second = await seedDraft(db, s.accountId, mailboxId);
    const two = await H(req("POST", `/drafts/${second}/send`, {
      bearer: s.token, headers: { "idempotency-key": "dup-k2" },
    }), deps);

    expect(two.status).toBe(409);
    const body = await two.json();
    expect(body.error.code).toBe("duplicate_send");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.firstSend.status).toBe("sent");
    // THE ASSERTION. Not a row count — the submission is the harm.
    expect(state.sendCalls).toBe(1);

    // The reserve tx rolled back: the second draft never left `draft` and left no reservation.
    const [d2] = await db.select().from(drafts).where(eq(drafts.id, second));
    expect(d2!.status).toBe("draft");
    const rows = await db.select().from(outboundSends).where(eq(outboundSends.draftId, second));
    expect(rows.length).toBe(0);
  });

  it("POSITIVE CONTROL — an EDITED message sends, and the proof is the second submission", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const first = await seedDraft(db, s.accountId, mailboxId);
    expect((await H(req("POST", `/drafts/${first}/send`, {
      bearer: s.token, headers: { "idempotency-key": "edit-k1" },
    }), deps)).status).toBe(200);

    // ONE CHARACTER.
    const second = await seedDraft(db, s.accountId, mailboxId, "draft", { body: "Thanks!!" });
    const two = await H(req("POST", `/drafts/${second}/send`, {
      bearer: s.token, headers: { "idempotency-key": "edit-k2" },
    }), deps);
    expect(two.status).toBe(200);
    expect((await two.json()).status).toBe("sent");
    expect(state.sendCalls).toBe(2);
  });

  it("POSITIVE CONTROL — one extra Cc is a different message", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const first = await seedDraft(db, s.accountId, mailboxId);
    expect((await H(req("POST", `/drafts/${first}/send`, {
      bearer: s.token, headers: { "idempotency-key": "cc-k1" },
    }), deps)).status).toBe(200);

    const second = await seedDraft(db, s.accountId, mailboxId, "draft", {
      cc: [{ name: null, address: "third@example.com" }],
    });
    expect((await H(req("POST", `/drafts/${second}/send`, {
      bearer: s.token, headers: { "idempotency-key": "cc-k2" },
    }), deps)).status).toBe(200);
    expect(state.sendCalls).toBe(2);
  });

  it("a RICH message whose plain part is identical but whose markup differs still sends", async () => {
    // The digest reads what the transport SENDS — `html ?? body` — and not the plain alternative,
    // which for a rich draft is DERIVED from the markup and can be identical for two different
    // messages. Reading `body` alone would refuse the second one and nobody would ever see why.
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const first = await seedDraft(db, s.accountId, mailboxId, "draft", {
      body: "Yes", html: "<p>Yes</p>",
    } as never);
    expect((await H(req("POST", `/drafts/${first}/send`, {
      bearer: s.token, headers: { "idempotency-key": "rich-k1" },
    }), deps)).status).toBe(200);

    const second = await seedDraft(db, s.accountId, mailboxId, "draft", {
      body: "Yes", html: "<p><strong>Yes</strong></p>",
    } as never);
    expect((await H(req("POST", `/drafts/${second}/send`, {
      bearer: s.token, headers: { "idempotency-key": "rich-k2" },
    }), deps)).status).toBe(200);
    expect(state.sendCalls).toBe(2);
  });

  /**
   * THE THREE THE REVIEW FOUND, at the route. Each is a message REFUSED that should have been SENT,
   * which is the worse half of this guard's trade and the reason these cases exist.
   */
  it("a corrected INLINE attachment at the SAME byte length still sends", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
    const send = (draftId: string, key: string, csv: string) => H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": key },
      // `req` takes a STRING body — an object stringifies to "[object Object]" and the route
      // answers 400 on unparseable JSON, which reads exactly like the guard refusing the send.
      body: JSON.stringify({
        attachments: [{ filename: "invoice.csv", contentType: "text/csv", contentBase64: b64(csv) }],
      }),
    }), deps);

    // Same name, same type, same byte length — one digit different.
    expect((await send(await seedDraft(db, s.accountId, mailboxId), "inv-1", "amount\n100\n")).status).toBe(200);
    const second = await send(await seedDraft(db, s.accountId, mailboxId), "inv-2", "amount\n900\n");
    expect(second.status, await second.clone().text()).toBe(200);
    expect(state.sendCalls, "the CORRECTION must leave; refusing it loses the message silently").toBe(2);
  });

  it("plain text that LOOKS like markup is not the same message as that markup", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const plain = await seedDraft(db, s.accountId, mailboxId, "draft", { body: "<p>Approved</p>" } as never);
    expect((await H(req("POST", `/drafts/${plain}/send`, {
      bearer: s.token, headers: { "idempotency-key": "mk-1" },
    }), deps)).status).toBe(200);

    const rich = await seedDraft(db, s.accountId, mailboxId, "draft", {
      body: "Approved", html: "<p>Approved</p>",
    } as never);
    const res = await H(req("POST", `/drafts/${rich}/send`, {
      bearer: s.token, headers: { "idempotency-key": "mk-2" },
    }), deps);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(state.sendCalls).toBe(2);
  });

  it("a duplicate refused while the FIRST attempt is still running is RETRYABLE, not terminal", async () => {
    // `pending` is the absence of an outcome, not an outcome. Settling on it loses the message: the
    // first attempt can still fail before SMTP, and then nothing was ever delivered while the
    // second sender has stopped asking.
    const { factory, state } = fakeAdapter({ inSent: false });
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const first = await seedDraft(db, s.accountId, mailboxId, "sending");
    // A reservation that is live right now: young, still `pending`, with a claim pointing at it.
    const [res1] = await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "live-1", draftId: first,
      mintedMessageId: "<live@lichtgrat.example>", status: "pending",
      createdAt: new Date(FIXED_NOW.getTime() - 5_000),
    }).returning();
    await db.insert(outboundSendFingerprints).values({
      accountId: s.accountId, mailboxId,
      fingerprint: sendContentFingerprint({
        to: [{ name: null, address: "you@example.com" }], cc: [], bcc: [],
        subject: "Re: hi", html: null, body: "Thanks!",
        inReplyToMessageId: null, forwardOf: null, sendAt: null, attachments: [],
      }),
      sendId: res1!.id, createdAt: new Date(FIXED_NOW.getTime() - 5_000),
    });

    const second = await seedDraft(db, s.accountId, mailboxId);
    const res = await H(req("POST", `/drafts/${second}/send`, {
      bearer: s.token, headers: { "idempotency-key": "second-key" },
    }), deps);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("duplicate_send");
    expect(body.error.details.firstSend.status).toBe("pending");
    // THE ASSERTION: retryable, so the client keeps asking until the first attempt settles.
    expect(body.error.retryable, "an unsettled first attempt is not a terminal answer").toBe(true);
    expect(body.error.message, "and the sentence promises no ending").not.toMatch(/on its way|has been sent/i);
    expect(state.sendCalls).toBe(0);
  });

  it("a WAIT expires: past the stale horizon a pending duplicate is TERMINAL, not retryable", async () => {
    // The double-delivery this bound closes: A is pending, B is told to wait and QUEUES, A then
    // DELIVERS, B reconnects past the one-hour window, the claim is reclaimed and B's still-queued
    // verb is admitted — a second delivery with nobody having pressed Send again. A wait with no
    // age limit outlives the window it is waiting inside. Past `SEND_STALE_AFTER_MS` no invocation
    // can still be alive, so "wait" stops being true and the refusal settles.
    const { factory, state } = fakeAdapter({ inSent: false });
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const first = await seedDraft(db, s.accountId, mailboxId, "sending");
    const old = new Date(FIXED_NOW.getTime() - SEND_STALE_AFTER_MS - 1000);
    const [res1] = await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "stale-live", draftId: first,
      mintedMessageId: "<stale@lichtgrat.example>", status: "pending", createdAt: old,
    }).returning();
    await db.insert(outboundSendFingerprints).values({
      accountId: s.accountId, mailboxId,
      fingerprint: sendContentFingerprint({
        to: [{ name: null, address: "you@example.com" }], cc: [], bcc: [],
        subject: "Re: hi", html: null, body: "Thanks!",
        inReplyToMessageId: null, forwardOf: null, sendAt: null, attachments: [],
      }),
      sendId: res1!.id, createdAt: old,
    });

    const res = await H(req("POST", `/drafts/${await seedDraft(db, s.accountId, mailboxId)}/send`, {
      bearer: s.token, headers: { "idempotency-key": "waiter" },
    }), deps);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("duplicate_send");
    expect(body.error.details.firstSend.status).toBe("pending");
    expect(body.error.retryable, "a wait that outlives the stale horizon is no longer a wait").toBe(false);
    expect(state.sendCalls).toBe(0);
  });

  it("a send carrying STAGED files is not covered by the content claim — no false refusal", async () => {
    // Metadata is not an identity: a corrected 5 MiB file keeping its name, type and size collided
    // and the correction was refused as already sent. A staged send is excluded outright rather
    // than covered by an identity that is not one, so two staged sends both go — which is the
    // honest state of the protection rather than a pretence of it.
    const { factory, state } = fakeAdapter();
    // Real uuids: `readStagedIds` refuses anything else with "stagedAttachmentIds must be an id",
    // which answers 400 and reads exactly like the guard refusing the send.
    const TICKET_A = "aaaaaaaa-0000-4000-8000-000000000001";
    const TICKET_B = "aaaaaaaa-0000-4000-8000-000000000002";
    const staged = new Map([[TICKET_A, "AAA"], [TICKET_B, "BBB"]]);
    const source = {
      async declare(_a: string, ids: readonly string[]) {
        return ids.map((id) => ({
          id, sizeBytes: 3, expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
          filename: "report.pdf", contentType: "application/pdf",
        }));
      },
      async fetch(_a: string, ids: readonly string[]) {
        return ids.map((id) => ({
          filename: "report.pdf", contentType: "application/pdf",
          content: Buffer.from(staged.get(id) ?? "", "utf8"),
        }));
      },
    };
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const withStaging = {
      ...deps,
      services: { ...deps.services, attachmentStaging: () => ({ source }) },
    } as typeof deps;
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });

    const send = (draftId: string, key: string, ticket: string) => H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": key },
      body: JSON.stringify({ stagedAttachmentIds: [ticket] }),
    }), withStaging);

    const one = await send(await seedDraft(db, s.accountId, mailboxId), "st-1", TICKET_A);
    expect(one.status, await one.clone().text()).toBe(200);
    const second = await send(await seedDraft(db, s.accountId, mailboxId), "st-2", TICKET_B);
    expect(second.status, await second.clone().text()).toBe(200);
    expect(state.sendCalls, "a corrected staged file must not be refused as already sent").toBe(2);
    // And no claim was taken for either, which is what "excluded" means.
    const claims = await db.select().from(outboundSendFingerprints);
    expect(claims).toHaveLength(0);
  });

  it("a SAME-KEY retry still replays `unverified` — it is never re-read as a duplicate of itself", async () => {
    // The placement control. The claim is taken BELOW the conflict branch; moving it above would
    // answer `duplicate_send` to a client asking what happened to its own key, which is the
    // opposite of what an idempotency key is for.
    const { factory, state } = fakeAdapter({ inSent: false });
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId, "sending");
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "replay-me", draftId,
      mintedMessageId: "<replay@lichtgrat.example>", status: "unverified",
      createdAt: new Date(FIXED_NOW.getTime() - 1000),
    });

    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "replay-me" },
    }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("unverified");
    expect(state.sendCalls).toBe(0);
  });

  it("another account sending the identical message is untouched — the claim is account-scoped", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const a = await seedSession(db, { now: FIXED_NOW, token: "dup-a" });
    const b = await seedSession(db, { now: FIXED_NOW, token: "dup-b" });
    const mbA = await seedMailbox(db, { accountId: a.accountId });
    const mbB = await seedMailbox(db, { accountId: b.accountId });

    expect((await H(req("POST", `/drafts/${await seedDraft(db, a.accountId, mbA)}/send`, {
      bearer: a.token, headers: { "idempotency-key": "acct-a" },
    }), deps)).status).toBe(200);
    expect((await H(req("POST", `/drafts/${await seedDraft(db, b.accountId, mbB)}/send`, {
      bearer: b.token, headers: { "idempotency-key": "acct-b" },
    }), deps)).status).toBe(200);
    expect(state.sendCalls).toBe(2);
  });
});

/**
 * ═══ `GET /drafts/:id/send-attempt` — WHAT HAPPENED UNDER THIS KEY ═════════════════════════
 *
 * The read a client makes BEFORE it re-uploads a staged attachment.
 * It writes nothing and reserves nothing: the only way it can answer `found` is a reservation
 * somebody else's request already made, which is exactly what makes it safe to ask first.
 */
describe("GET /drafts/:id/send-attempt — the send's read half", () => {
  it("answers `found: false` for a key nothing has been sent under, and reserves nothing", async () => {
    const { factory } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId);

    const res = await H(req("GET", `/drafts/${draftId}/send-attempt`, {
      bearer: s.token, headers: { "idempotency-key": "never-used" },
    }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });
    // THE ASKING RESERVED NOTHING — a probe that took the key would spend it.
    expect(await db.select().from(outboundSends)).toHaveLength(0);
  });

  it("answers `found: true` with the first send's facts once the key has been used", async () => {
    const { factory, state } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId);

    expect((await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "probe-1" },
    }), deps)).status).toBe(200);

    const res = await H(req("GET", `/drafts/${draftId}/send-attempt`, {
      bearer: s.token, headers: { "idempotency-key": "probe-1" },
    }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.firstSend.status).toBe("sent");
    expect(typeof body.firstSend.at).toBe("string");
    // AND IT SENT NOTHING of its own.
    expect(state.sendCalls).toBe(1);
  });

  it("a key used on ANOTHER draft is not this draft's answer", async () => {
    const { factory } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const sent = await seedDraft(db, s.accountId, mailboxId);
    const other = await seedDraft(db, s.accountId, mailboxId);

    await H(req("POST", `/drafts/${sent}/send`, {
      bearer: s.token, headers: { "idempotency-key": "probe-2" },
    }), deps);

    const res = await H(req("GET", `/drafts/${other}/send-attempt`, {
      bearer: s.token, headers: { "idempotency-key": "probe-2" },
    }), deps);
    expect(await res.json()).toEqual({ found: false });
  });

  it("400 without the header — the key IS the question", async () => {
    const { db, deps } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const draftId = await seedDraft(db, s.accountId, mailboxId);
    expect((await H(req("GET", `/drafts/${draftId}/send-attempt`, { bearer: s.token }), deps)).status)
      .toBe(400);
  });

  it("another account's key answers nothing", async () => {
    const { factory } = fakeAdapter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
    const owner = await seedSession(db, { now: FIXED_NOW, token: "probe-owner" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "probe-other" });
    const mailboxId = await seedMailbox(db, { accountId: owner.accountId });
    const draftId = await seedDraft(db, owner.accountId, mailboxId);
    await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: owner.token, headers: { "idempotency-key": "probe-3" },
    }), deps);

    const res = await H(req("GET", `/drafts/${draftId}/send-attempt`, {
      bearer: other.token, headers: { "idempotency-key": "probe-3" },
    }), deps);
    expect(await res.json()).toEqual({ found: false });
  });
});
