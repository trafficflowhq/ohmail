import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { changeLog, drafts, mailboxes, outboundSendFingerprints, outboundSends } from "@trafficflow/db";
import { mintMessageId, SendNotSubmitted } from "@trafficflow/core";
import type { OpenSendAdapter, OutboundMessage, SendOptions } from "@trafficflow/core";
import { SendService, SEND_STALE_AFTER_MS, SEND_SUBMISSION_CEILING_MS } from "../src/index.js";
import type { ServiceContext, StagedAttachmentSource } from "../src/index.js";

/**
 * A RESERVATION THAT OFFERED NOTHING IS FORGOTTEN, NEVER LEFT `unverified` (mail 0162).
 *
 * The desktop quit while `openSendAdapter` was still logging in to a slow IMAP server: no SMTP had
 * been offered, the row stayed `pending`, and the next start could only look in Sent, found
 * nothing and wrote `unverified` — Drafts said "We're checking your Sent folder" for good and the
 * reply never went (a tester's finding). The attempt now commits `offered` right before its first SMTP
 * traffic; a stale row still `unoffered` is removed with its claim, the draft is a draft again, and
 * the key's replay sends it once. A row that may have been offered keeps verify-by-Sent.
 */

const svc = new SendService();
/** Another process's resolver (a dead run's successor, or another host): it cannot see `svc`'s live attempts. */
const elsewhere = new SendService();
const START = new Date("2026-10-23T12:00:00.000Z");
const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((r) => r, (e: unknown) => e);
const until = async (ok: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never");
};

/**
 * A transport whose dial, upload or final reply can be held open, as a slow server holds it. As the
 * real adapter does, the end-of-data mark waits for `beforeRelease`, and a session that ends before
 * it is `SendNotSubmitted("data")`. `marks` counts the end-of-data marks the server received.
 */
function transport(o: {
  holdDial?: boolean; holdUpload?: boolean; holdReply?: boolean; inSent?: boolean; onDial?: () => Promise<void>;
} = {}) {
  const state = { dials: 0, submits: 0, probes: 0, marks: 0, delivered: [] as OutboundMessage[] };
  const held: Array<(go: boolean) => void> = [];
  const hold = (): Promise<void> => new Promise<void>((resolve, reject) => {
    held.push((go) => (go ? resolve() : reject(Object.assign(new Error("reset"), { code: "ECONNRESET" }))));
  });
  const factory: OpenSendAdapter = async () => {
    state.dials += 1;
    if (o.onDial) await o.onDial();
    if (o.holdDial) await hold();
    return {
      async send(msg: OutboundMessage, opts?: SendOptions) {
        state.submits += 1;
        try {
          if (o.holdUpload) await hold();
          await opts?.beforeRelease?.();
        } catch (err) {
          throw new SendNotSubmitted("data", err);
        }
        state.marks += 1;
        if (o.holdReply) await hold();
        state.delivered.push(msg);
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { state.probes += 1; return o.inSent ?? false; },
      async close() { /* nothing to tear down */ },
    };
  };
  /** `go`: the held step carries on; otherwise the connection resets under it. */
  return { factory, state, release: (go = false) => { for (const r of held.splice(0)) r(go); } };
}

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${randomUUID().slice(0, 8)}@offer.test`, status: "connected",
  }).returning();
  let t = START.getTime();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => new Date(t), requestId: "offer" };
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "Re: the slow server", body: "Pressed before the close.",
    to: [{ name: "Mila", address: "mila@offer.test" }], status: "draft",
  }).returning();
  const row = async (key: string) => (await db.select().from(outboundSends)
    .where(and(eq(outboundSends.accountId, accountId), eq(outboundSends.idempotencyKey, key))))[0];
  const draft = async () => (await db.select().from(drafts).where(eq(drafts.id, d!.id)))[0]!;
  const changes = async () => (await db.select({ seq: changeLog.seq }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, d!.id)))).length;
  const claims = async (sendId: string) => (await db.select().from(outboundSendFingerprints)
    .where(eq(outboundSendFingerprints.sendId, sendId))).length;
  return {
    db, ctx, accountId, mailboxId: mb!.id, draftId: d!.id, row, draft, changes, claims,
    advance: (ms: number) => { t += ms; },
  };
}
type World = Awaited<ReturnType<typeof world>>;

const press = (w: World, key: string, open: OpenSendAdapter, more: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
  svc.send(w.ctx, w.draftId, key, { openSendAdapter: open, attemptCeilingMs: 600_000, ...more } as never, input as never);

/** One staged file, as object storage holds it for the web app's large sends. */
const staging: StagedAttachmentSource = {
  async declare(_a, ids) {
    return ids.map((id) => ({
      id, sizeBytes: 4, expiresAt: new Date(START.getTime() + 86_400_000), filename: "plan.pdf", contentType: "application/pdf",
    }));
  },
  async fetch(_a, ids) {
    return ids.map(() => ({ filename: "plan.pdf", contentType: "application/pdf", content: Buffer.from("plan") }));
  },
};

/** The state a quit during the slow login leaves: a `pending` reservation whose dial never answered. */
async function quitDuringLogin(w: World, key: string) {
  const slow = transport({ holdDial: true });
  const first = outcome(press(w, key, slow.factory));
  await until(() => slow.state.dials === 1);
  const left = (await w.row(key))!;
  return { slow, first, left };
}

describe("a stale reservation that offered nothing", () => {
  it("is forgotten with its claim, the draft is a draft again, and the key's replay delivers once", async () => {
    const w = await world();
    const { slow, first, left } = await quitDuringLogin(w, "k1");
    expect({ status: left.status, offerState: left.offerState }).toEqual({ status: "pending", offerState: "unoffered" });
    expect(await w.claims(left.id)).toBe(1);
    const before = await w.changes();

    w.advance(SEND_STALE_AFTER_MS + 1);
    const probe = transport();
    const out = await svc.resolveStale(w.ctx, left, w.mailboxId, probe.factory);
    expect({ status: out.status, by: out.by }).toEqual({ status: "forgotten", by: "not_offered" });
    expect(probe.state.dials, "the forget needs no dial").toBe(0);
    expect(await w.row("k1"), "the reservation is gone").toBeUndefined();
    expect(await w.claims(left.id), "its content claim is gone").toBe(0);
    expect((await w.draft()).status).toBe("draft");
    expect(await w.changes() - before, "one draft change").toBe(1);

    slow.release();
    await first;
    const replay = transport();
    const r = await press(w, "k1", replay.factory);
    expect(r.status).toBe("sent");
    expect(replay.state.delivered, "one press, one message").toHaveLength(1);
    expect(replay.state.delivered[0]!.messageId, "a fresh reservation mints a fresh id").not.toBe(left.mintedMessageId);
    expect((await w.draft()).status).toBe("sent");
  });

  it("a same-key press on it reserves afresh, once, and sends", async () => {
    const w = await world();
    const { slow, first, left } = await quitDuringLogin(w, "k2");
    slow.release();
    // The released dial's own window ends the row `failed`; put back what a quit leaves.
    await first;
    await w.db.update(outboundSends).set({ status: "pending", offerState: "unoffered" }).where(eq(outboundSends.id, left.id));
    await w.db.update(drafts).set({ status: "sending" }).where(eq(drafts.id, w.draftId));
    w.advance(SEND_STALE_AFTER_MS + 1);

    const replay = transport();
    const r = await press(w, "k2", replay.factory);
    expect(r.status).toBe("sent");
    expect(replay.state.probes, "nothing was probed").toBe(0);
    expect(replay.state.delivered).toHaveLength(1);
    const now = (await w.row("k2"))!;
    expect({ status: now.status, offerState: now.offerState, fresh: now.id !== left.id })
      .toEqual({ status: "sent", offerState: "complete", fresh: true });
  });

  it("forgetInherited forgets the last run's unoffered rows, keeps the rest, and only for its account", async () => {
    const w = await world();
    const { slow, first, left } = await quitDuringLogin(w, "k3");
    const other: ServiceContext = { ...w.ctx, accountId: randomUUID() };
    const none = await svc.forgetInherited(other, [left.id]);
    expect(none).toEqual({ forgotten: 0, remaining: [left.id] });
    expect((await w.row("k3"))?.status, "another account's context forgets nothing").toBe("pending");

    const offered = randomUUID();
    const r = await svc.forgetInherited(w.ctx, [left.id, offered]);
    expect(r).toEqual({ forgotten: 1, remaining: [offered] });
    expect(await w.row("k3")).toBeUndefined();
    slow.release();
    await first;
  });

  it("CONTROL: a resolver in another account's context leaves the row as it is", async () => {
    const w = await world();
    const { slow, first, left } = await quitDuringLogin(w, "k4");
    w.advance(SEND_STALE_AFTER_MS + 1);
    const other: ServiceContext = { ...w.ctx, accountId: randomUUID() };
    const out = await svc.resolveStale(other, left, w.mailboxId, null, "defer");
    expect(out.status).not.toBe("forgotten");
    expect((await w.row("k4"))?.status).toBe("pending");
    slow.release();
    await first;
  });
});

describe("a staged press's reservation is never forgotten", () => {
  // Its files ride the request, not the row, and the client's replay of a key the server holds
  // carries none: forgetting it would send the message without them and answer Sent.
  it("a file-less same-key replay of a stale staged press whose dial never answered delivers nothing", async () => {
    const w = await world();
    const slow = transport({ holdDial: true });
    const first = outcome(press(w, "s1", slow.factory, { stagedAttachments: staging }, { stagedAttachmentIds: ["t1"] }));
    await until(() => slow.state.dials === 1);
    const left = (await w.row("s1"))!;
    expect({ status: left.status, offerState: left.offerState }).toEqual({ status: "pending", offerState: "unoffered" });
    w.advance(SEND_STALE_AFTER_MS + 1);

    expect(await svc.forgetInherited(w.ctx, [left.id]), "the start's pass keeps it").toEqual({ forgotten: 0, remaining: [left.id] });
    const deferred = await svc.resolveStale(w.ctx, left, w.mailboxId, null, "defer");
    expect(deferred.status, "the reconcile pass keeps it").not.toBe("forgotten");
    expect((await w.row("s1"))?.id).toBe(left.id);

    const replay = transport({ inSent: false });
    await outcome(press(w, "s1", replay.factory, { stagedAttachments: staging }));
    expect(replay.state.delivered, "nothing goes without its files").toHaveLength(0);
    expect((await w.row("s1"))?.id, "the reservation is the press's own").toBe(left.id);
    slow.release();
    await first;
  });
});

describe("an upload that never released its end-of-data mark sent nothing", () => {
  it("a stale `uploading` row is forgotten without a dial, and the key's replay delivers once", async () => {
    const w = await world();
    const slow = transport({ holdUpload: true });
    const first = outcome(press(w, "u1", slow.factory));
    await until(() => slow.state.submits === 1);
    const left = (await w.row("u1"))!;
    expect(left.offerState).toBe("uploading");
    w.advance(SEND_STALE_AFTER_MS + 1);
    const probe = transport();
    const out = await elsewhere.resolveStale(w.ctx, left, w.mailboxId, probe.factory);
    expect({ status: out.status, by: out.by, dials: probe.state.dials }).toEqual({ status: "forgotten", by: "not_offered", dials: 0 });
    expect((await w.draft()).status).toBe("draft");
    slow.release();
    await first;
    const replay = transport();
    expect((await press(w, "u1", replay.factory)).status).toBe("sent");
    expect(replay.state.delivered).toHaveLength(1);
    expect(slow.state.marks, "the dropped upload delivered nothing").toBe(0);
  });

  it("when the cleanup wins the race, the end-of-data mark is never released", async () => {
    const w = await world();
    const slow = transport({ holdUpload: true });
    const first = outcome(press(w, "u2", slow.factory));
    await until(() => slow.state.submits === 1);
    w.advance(SEND_STALE_AFTER_MS + 1);
    const out = await elsewhere.resolveStale(w.ctx, (await w.row("u2"))!, w.mailboxId, null, "defer");
    expect(out.status).toBe("forgotten");
    slow.release(true);   // the upload's last byte arrives after the row was decided
    expect(await first).toMatchObject({ code: "send_upload_dropped" });
    expect(slow.state.marks, "the server never received the end of the message").toBe(0);
    expect(slow.state.delivered).toHaveLength(0);
  });

  it("a staged press's dropped upload ends `failed`: never forgotten, never probed", async () => {
    const w = await world();
    const slow = transport({ holdUpload: true });
    const first = outcome(press(w, "u3", slow.factory, { stagedAttachments: staging }, { stagedAttachmentIds: ["t1"] }));
    await until(() => slow.state.submits === 1);
    w.advance(SEND_STALE_AFTER_MS + 1);
    const out = await elsewhere.resolveStale(w.ctx, (await w.row("u3"))!, w.mailboxId, null, "defer");
    expect({ status: out.status, by: out.by }).toEqual({ status: "failed", by: "not_offered" });
    expect({ status: (await w.row("u3"))!.status, draft: (await w.draft()).status }).toEqual({ status: "failed", draft: "draft" });
    slow.release(true);
    await first;
    expect(slow.state.marks).toBe(0);
  });

  it("an upload past its ceiling is refused at the release, and the send fails as dropped", async () => {
    expect(SEND_SUBMISSION_CEILING_MS, "the attempt ends before a resolver may decide its row").toBeLessThan(SEND_STALE_AFTER_MS);
    const w = await world();
    const slow = transport({ holdUpload: true });
    const first = outcome(press(w, "u4", slow.factory, { submissionCeilingMs: SEND_SUBMISSION_CEILING_MS }));
    await until(() => slow.state.submits === 1);
    w.advance(SEND_SUBMISSION_CEILING_MS + 1);
    slow.release(true);
    expect(await first).toMatchObject({ code: "send_upload_dropped" });
    expect(slow.state.marks).toBe(0);
    expect({ status: (await w.row("u4"))!.status, draft: (await w.draft()).status }).toEqual({ status: "failed", draft: "draft" });
  });
});

describe("an attempt still running in this process outlives the stale cutoff", () => {
  it("a replay, a Cancel and a resolver past it answer in flight, and the late 250 finalizes `sent`", async () => {
    const w = await world();
    const slow = transport({ holdUpload: true, holdReply: true });
    const first = outcome(press(w, "live", slow.factory));
    await until(() => slow.state.submits === 1);
    w.advance(SEND_STALE_AFTER_MS + 1);
    const probe = transport();
    expect((await press(w, "live", probe.factory)).status, "mid-upload").toBe("in_flight");
    slow.release(true);
    await until(() => slow.state.marks === 1);
    expect((await press(w, "live", probe.factory)).status, "waiting for the 250").toBe("in_flight");
    expect((await svc.withdraw(w.ctx, "live", w.draftId, { openSendAdapter: probe.factory })).outcome).toBe("in_flight");
    expect((await svc.resolveStale(w.ctx, (await w.row("live"))!, w.mailboxId, probe.factory)).by).toBe("deferred");
    expect({ dials: probe.state.dials, status: (await w.row("live"))!.status }).toEqual({ dials: 0, status: "pending" });
    slow.release(true);
    expect(await first).toMatchObject({ status: "sent" });
    expect({ status: (await w.row("live"))!.status, draft: (await w.draft()).status }).toEqual({ status: "sent", draft: "sent" });
  });
});

describe("a Send again that offered nothing is held again, never forgotten", () => {
  /** The first press was taken and its answer lost: held `unverified`, not in Sent. */
  async function held(w: World) {
    const lost = transport({ holdReply: true });
    const first = outcome(press(w, "first", lost.factory));
    await until(() => lost.state.marks === 1);
    lost.release();
    expect(await first).toMatchObject({ status: "unverified" });
  }

  it("a stale one comes back `unverified`, keeps its row and its claim, and its replay sends nothing", async () => {
    const w = await world();
    await held(w);
    const slow = transport({ holdUpload: true });
    const again = outcome(press(w, "again", slow.factory, {}, { again: true }));
    await until(() => slow.state.submits === 1);
    const left = (await w.row("again"))!;
    expect({ offerState: left.offerState, mark: left.retryRefusal }).toEqual({ offerState: "uploading", mark: "send_unverified" });
    w.advance(SEND_STALE_AFTER_MS + 1);
    const out = await elsewhere.resolveStale(w.ctx, left, w.mailboxId, null, "defer");
    expect({ status: out.status, by: out.by }).toEqual({ status: "unverified", by: "earlier_unverified" });
    expect((await w.row("again"))?.status, "not deleted").toBe("unverified");
    expect(await w.claims(left.id), "the claim stays with it").toBe(1);
    expect((await w.draft()).status).toBe("unverified");
    slow.release(true);
    await again;
    const replay = transport();
    expect(await press(w, "again", replay.factory, {}, { again: true })).toMatchObject({ status: "unverified" });
    expect([replay.state.submits, slow.state.marks], "nothing goes").toEqual([0, 0]);
  });

  it("the start's pass holds an unoffered one again rather than forgetting it", async () => {
    const w = await world();
    await held(w);
    const slow = transport({ holdDial: true });
    const again = outcome(press(w, "again", slow.factory, {}, { again: true }));
    await until(() => slow.state.dials === 1);
    const left = (await w.row("again"))!;
    expect(await elsewhere.forgetInherited(w.ctx, [left.id])).toEqual({ forgotten: 0, remaining: [] });
    expect((await w.row("again"))?.status).toBe("unverified");
    slow.release();
    await again;
    expect((await w.row("again"))?.status).toBe("unverified");
  });
});

describe("CONTROLS: a reservation that may have been offered keeps verify-by-Sent", () => {
  it("a `complete` row (its mark released, no reply yet) is probed and becomes `unverified`", async () => {
    const w = await world();
    const slow = transport({ holdReply: true });
    const first = outcome(press(w, "k5", slow.factory));
    await until(() => slow.state.marks === 1);
    const left = (await w.row("k5"))!;
    expect(left.offerState).toBe("complete");
    w.advance(SEND_STALE_AFTER_MS + 1);
    const probe = transport({ inSent: false });
    const out = await elsewhere.resolveStale(w.ctx, left, w.mailboxId, probe.factory);
    expect({ status: out.status, by: out.by }).toEqual({ status: "unverified", by: "probe" });
    expect(probe.state.probes).toBe(1);
    expect(probe.state.delivered).toHaveLength(0);
    slow.release();
    await first;
  });

  it("a row an older build marked `offered` is probed as today", async () => {
    const w = await world();
    const [s] = await w.db.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "k6o", draftId: w.draftId,
      mintedMessageId: mintMessageId("offer.test"), status: "pending", offerState: "offered", createdAt: START,
    }).returning();
    await w.db.update(drafts).set({ status: "sending" }).where(eq(drafts.id, w.draftId));
    w.advance(SEND_STALE_AFTER_MS + 1);
    const probe = transport({ inSent: false });
    const out = await svc.resolveStale(w.ctx, s!, w.mailboxId, probe.factory);
    expect({ status: out.status, probes: probe.state.probes }).toEqual({ status: "unverified", probes: 1 });
  });

  it("a row from before the column (`unknown`) is probed as today", async () => {
    const w = await world();
    const [s] = await w.db.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "k6", draftId: w.draftId,
      mintedMessageId: mintMessageId("offer.test"), status: "pending", createdAt: START,
    }).returning();
    expect(s!.offerState).toBe("unknown");
    await w.db.update(drafts).set({ status: "sending" }).where(eq(drafts.id, w.draftId));
    w.advance(SEND_STALE_AFTER_MS + 1);
    const probe = transport({ inSent: false });
    const out = await svc.resolveStale(w.ctx, s!, w.mailboxId, probe.factory);
    expect(out.status).toBe("unverified");
    expect(probe.state.probes).toBe(1);
  });

  it("a scheduled draft keeps today's arms", async () => {
    const w = await world();
    await w.db.update(drafts).set({ status: "sending", sendAt: START, sendKey: "k7" }).where(eq(drafts.id, w.draftId));
    const [s] = await w.db.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "k7", draftId: w.draftId,
      mintedMessageId: mintMessageId("offer.test"), status: "pending", offerState: "unoffered", createdAt: START,
    }).returning();
    w.advance(SEND_STALE_AFTER_MS + 1);
    const probe = transport({ inSent: false });
    const out = await svc.resolveStale(w.ctx, s!, w.mailboxId, probe.factory);
    expect(out.status).toBe("unverified");
    expect(probe.state.probes).toBe(1);
  });

  it("a lost offer compare-and-swap offers nothing", async () => {
    const w = await world();
    const tr = transport({
      // Another resolver takes the row while the dial is in flight.
      onDial: async () => { await w.db.update(outboundSends).set({ status: "unverified" }).where(eq(outboundSends.idempotencyKey, "k8")); },
    });
    const r = await press(w, "k8", tr.factory);
    expect(r.status).toBe("in_flight");
    expect(tr.state.submits, "no SMTP").toBe(0);
  });

  it("a re-arm starts its attempt `unoffered` again", async () => {
    const w = await world();
    const seen: string[] = [];
    let n = 0;
    const factory: OpenSendAdapter = async () => {
      seen.push((await w.row("k9"))!.offerState);
      n += 1;
      const attempt = n;
      return {
        async send(msg: OutboundMessage) {
          if (attempt === 1) throw new SendNotSubmitted("connect", Object.assign(new Error("x"), { code: "ESOCKET", syscall: "connect" }));
          return { providerMessageId: msg.messageId! };
        },
        async messageInSent() { return false; },
        async close() { /* nothing */ },
      };
    };
    const first = await outcome(press(w, "k9", factory, { rearmTransient: true }));
    expect((first as { retryable?: boolean }).retryable).toBe(true);
    expect((await w.row("k9"))!.offerState).toBe("uploading");
    w.advance(3_000);
    const r = await press(w, "k9", factory, { rearmTransient: true });
    expect(r.status).toBe("sent");
    expect(seen).toEqual(["unoffered", "unoffered"]);
  });
});
