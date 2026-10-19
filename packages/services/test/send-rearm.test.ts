import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { attachments, drafts, mailboxes, messageBodies, outboundSends, outboundSendFingerprints } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendNotSubmitted } from "@trafficflow/core";
import {
  MailboxSideRefusal, SendService, ServiceError, TransientDialRefusal, runScheduledSendPass,
  SEND_FAILED_SENTENCE, SEND_STALE_AFTER_MS,
} from "../src/index.js";
import type { ServiceContext, StagedAttachmentSource } from "../src/index.js";
import * as sendModule from "../src/send-service.js";
import { seedBody, seedMessage } from "../../api/test/helpers.js";

/**
 * A SEND THAT FAILED FOR A PASSING REASON BEFORE ANY SMTP IS OFFERED AGAIN, UNDER ITS OWN KEY.
 *
 * A forward on Desktop went only on the third press of Send. One fault before
 * SMTP spent the key: the row was recorded `failed`, the answer said nothing about retrying, the
 * client's same-key replay met 409 `failed`, and only a press under a new key sent. Here the first
 * answer to such a fault is retryable with a short wait, and the same-key replay re-arms the one
 * reservation: the same row, the same minted Message-ID, never a second message. A refusal that
 * will not pass, a fault after DATA, an edited message, a staged send and the scheduled pass are
 * never re-armed; three attempts within two minutes bound it; Cancel during the wait ends it.
 */

const svc = new SendService();
const START = new Date("2026-10-19T08:00:00.000Z");
const WINDOW_MS = 120_000;
const shaped = (fields: Record<string, unknown>): Error => Object.assign(new Error("dial"), fields);
const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((r) => r, (e: unknown) => e);
const HANG = Symbol("hang");

type Fault = (() => unknown) | typeof HANG | null;
type Script = { dial?: Fault[]; submit?: Fault[] };

/** One scripted transport: the n-th dial and the n-th submission each meet the n-th fault, if any. */
function transport(script: Script = {}) {
  const state = { dials: 0, submits: 0, probes: 0, delivered: [] as OutboundMessage[] };
  const hung: Array<() => void> = [];
  const factory: OpenSendAdapter = async () => {
    const fault = script.dial?.[state.dials] ?? null;
    state.dials += 1;
    if (fault === HANG) {
      await new Promise<void>((_resolve, reject) => { hung.push(() => reject(shaped({ code: "ECONNRESET" }))); });
    } else if (fault) {
      throw fault();
    }
    return {
      async send(msg: OutboundMessage) {
        const f = script.submit?.[state.submits] ?? null;
        state.submits += 1;
        if (f && f !== HANG) throw f();
        state.delivered.push(msg);
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { state.probes += 1; return false; },
      async close() { /* nothing to tear down */ },
    };
  };
  return { factory, state, release: () => { for (const r of hung.splice(0)) r(); } };
}

async function world(o: { body?: string } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "me@rearm.test" }).returning();
  let t = START.getTime();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => new Date(t), requestId: "rearm" };
  const newDraft = async (body = o.body ?? "See below."): Promise<string> => {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "The list", body,
      to: [{ name: null, address: "you@rearm.test" }], status: "draft",
    }).returning();
    return d!.id;
  };
  const draftId = await newDraft();
  const row = async (key: string) => (await db.select().from(outboundSends)
    .where(and(eq(outboundSends.accountId, accountId), eq(outboundSends.idempotencyKey, key))))[0]!;
  const draft = async (id = draftId) => (await db.select().from(drafts).where(eq(drafts.id, id)))[0]!;
  return { db, ctx, accountId, mailboxId: mb!.id, draftId, newDraft, row, draft, advance: (ms: number) => { t += ms; } };
}
type World = Awaited<ReturnType<typeof world>>;

const press = (
  w: World, key: string, tr: ReturnType<typeof transport>,
  input: Parameters<SendService["send"]>[4] = {}, more: Record<string, unknown> = {}, draftId = w.draftId,
) => svc.send(w.ctx, draftId, key, { openSendAdapter: tr.factory, rearmTransient: true, ...more } as never, input);

/** The fields of a refusal a test reads; `null` when the press did not refuse. */
function refusal(e: unknown) {
  if (!(e instanceof ServiceError)) return { notATypedRefusal: e instanceof Error ? e.name : typeof e };
  return {
    code: e.code, httpStatus: e.httpStatus, retryable: e.retryable,
    retryAfter: (e.details as { retryAfter?: unknown } | undefined)?.retryAfter,
  };
}

const TRANSIENT_DIALS: Array<[string, () => unknown, string]> = [
  ["the connection ended (EIMAPCLOSED)", () => shaped({ code: "EIMAPCLOSED" }), "send_unreachable"],
  ["the dial refused (ECONNREFUSED)", () => shaped({ code: "ECONNREFUSED" }), "send_unreachable"],
  ["the provider's token endpoint down", () => shaped({ code: "OAUTH_TOKEN_ENDPOINT_UNAVAILABLE" }), "send_unreachable"],
  ["a sign-in answered UNAVAILABLE", () => shaped({ authenticationFailed: true, serverResponseCode: "UNAVAILABLE" }), "send_busy"],
  ["a sign-in answered LIMIT", () => shaped({ authenticationFailed: true, serverResponseCode: "LIMIT" }), "send_busy"],
  ["a throttled command (ETHROTTLE)", () => shaped({ code: "ETHROTTLE" }), "send_busy"],
  ["a command refused after the sign-in (NO)", () => shaped({ responseStatus: "NO" }), "send_busy"],
  ["the connection ceiling full (TransientDialRefusal)", () => new TransientDialRefusal("mb", "at its ceiling"), "send_busy"],
  ["the read deadline (EIMAPBOUND read_deadline)", () => shaped({ name: "ImapBoundExceeded", code: "EIMAPBOUND", bound: "read_deadline" }), "send_timeout"],
];

const TRANSIENT_SUBMITS: Array<[string, () => unknown, string]> = [
  ["a 454 at AUTH", () => new SendNotSubmitted("login", shaped({ code: "EAUTH", responseCode: 454 })), "send_busy"],
  ["a socket that never connected", () => new SendNotSubmitted("connect", shaped({ code: "ESOCKET", syscall: "connect" })), "send_unreachable"],
  ["the token endpoint down at submission", () => new SendNotSubmitted("token" as never, shaped({ code: "OAUTH_TOKEN_ENDPOINT_UNAVAILABLE" })), "send_unreachable"],
];

describe("a transient refusal before SMTP is offered again under its own key", () => {
  const cases: Array<[string, Script, string]> = [
    ...TRANSIENT_DIALS.map(([w, f, c]): [string, Script, string] => [w, { dial: [f] }, c]),
    ...TRANSIENT_SUBMITS.map(([w, f, c]): [string, Script, string] => [w, { submit: [f] }, c]),
  ];
  for (const [what, fault, code] of cases) {
    it(`${what}: 424 ${code}, retryable with a 2 s wait; the replay sends that row once`, async () => {
      const w = await world();
      const tr = transport(fault);
      const first = await outcome(press(w, "k1", tr));
      expect(refusal(first)).toEqual({ code, httpStatus: 424, retryable: true, retryAfter: 2 });
      const failed = await w.row("k1");
      expect({
        status: failed.status, attempts: failed.attempts, retryUntil: failed.retryUntil?.toISOString() ?? null,
        retryRefusal: failed.retryRefusal,
      }).toEqual({
        status: "failed", attempts: 1, retryUntil: new Date(START.getTime() + WINDOW_MS).toISOString(), retryRefusal: code,
      });
      expect((await w.draft()).status, "the draft is an ordinary draft during the wait").toBe("draft");

      const replay = await press(w, "k1", tr);
      expect(replay.status).toBe("sent");
      expect(tr.state.delivered, "one press, one message").toHaveLength(1);
      const sent = await w.row("k1");
      expect({ status: sent.status, attempts: sent.attempts, retryUntil: sent.retryUntil, retryRefusal: sent.retryRefusal })
        .toEqual({ status: "sent", attempts: 2, retryUntil: null, retryRefusal: null });
      expect(tr.state.delivered[0]!.messageId, "the replay is the same message").toBe(sent.mintedMessageId);
      expect((await w.db.select().from(outboundSends).where(eq(outboundSends.accountId, w.accountId))).length).toBe(1);
    });
  }
});

/* OUR OWN PER-MAILBOX IMAP CAP, FULL WHEN A FORWARD READS ITS ORIGINAL: the fetch door refuses
   `mailbox_busy`, retryable at its source with the wait a slot frees in (2 s after its local wait,
   10 s from the shared counter). Nothing was offered, so it is offered again like the server's busy,
   never sooner than either wait. The real door through the real route is
   `packages/api/test/send-rearm-forward-cap.test.ts`; these are the rules, on both stores. */
describe("our own per-mailbox cap, full before SMTP, is offered again", () => {
  /** The fetch door as it refuses (`attachments-adapter.ts`), the sentence aside. */
  const capFull = (retryAfter: number, retryable = true) =>
    new ServiceError("mailbox_busy", 429, "this mailbox already has as many live connections as we will open at once", { retryAfter }, retryable);

  async function forwarded(w: World): Promise<string> {
    const orig = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, subject: "The list", fromAddress: "list@rearm.test",
      nativeLocator: { folder: "INBOX", ref: "1:9" },
    });
    await seedBody(w.db, { messageId: orig.id, text: "The list.", html: null });
    await w.db.insert(attachments).values({
      accountId: w.accountId, messageId: orig.id, filename: "a.pdf", contentType: "application/pdf",
      sizeBytes: 4, partId: "2", inline: false,
    });
    return orig.id;
  }

  /** The fetch door: its n-th open meets the n-th refusal, if any, and otherwise reads the file. */
  function door(refusals: Array<ServiceError | null>) {
    const state = { opens: 0 };
    const openFetchAdapter = async () => {
      const refused = refusals[state.opens] ?? null;
      state.opens += 1;
      if (refused) throw refused;
      return {
        async fetchPart() { return { contentType: "application/pdf", filename: "a.pdf", body: new Uint8Array([1, 2, 3, 4]) }; },
        async close() { /* nothing to tear down */ },
      };
    };
    return { openFetchAdapter, state };
  }

  it("mailbox_busy: 429 retryable with the wait the cap names; the replay sends the forward once, nothing offered before", async () => {
    const w = await world();
    const forwardOf = await forwarded(w);
    const tr = transport();
    const fetch = door([capFull(10)]);
    const first = await outcome(press(w, "k1", tr, { forwardOf }, { openFetchAdapter: fetch.openFetchAdapter }));
    expect(refusal(first)).toEqual({ code: "mailbox_busy", httpStatus: 429, retryable: true, retryAfter: 10 });
    const failed = await w.row("k1");
    expect({ status: failed.status, attempts: failed.attempts, retryUntil: failed.retryUntil?.toISOString() ?? null, retryRefusal: failed.retryRefusal })
      .toEqual({ status: "failed", attempts: 1, retryUntil: new Date(START.getTime() + WINDOW_MS).toISOString(), retryRefusal: "mailbox_busy" });
    expect(tr.state.dials, "a refused read reached SMTP").toBe(0);

    w.advance(10_000);
    const replay = await press(w, "k1", tr, { forwardOf }, { openFetchAdapter: fetch.openFetchAdapter });
    expect(replay.status).toBe("sent");
    expect(tr.state.delivered.map((m) => m.attachments?.map((a) => a.filename))).toEqual([["a.pdf"]]);
    const sent = await w.row("k1");
    expect({ status: sent.status, attempts: sent.attempts, retryRefusal: sent.retryRefusal }).toEqual({ status: "sent", attempts: 2, retryRefusal: null });
    expect(tr.state.delivered[0]!.messageId).toBe(sent.mintedMessageId);
  });

  it("the wait is the longer of the attempt's own and the cap's: 2 s over a 1 s cap, 5 s over a 2 s one", async () => {
    const w = await world();
    const forwardOf = await forwarded(w);
    const tr = transport();
    const fetch = door([capFull(1), capFull(2)]);
    const more = { openFetchAdapter: fetch.openFetchAdapter };
    expect(refusal(await outcome(press(w, "k1", tr, { forwardOf }, more)))).toMatchObject({ retryable: true, retryAfter: 2 });
    expect(refusal(await outcome(press(w, "k1", tr, { forwardOf }, more)))).toMatchObject({ retryable: true, retryAfter: 5 });
    expect((await press(w, "k1", tr, { forwardOf }, more)).status).toBe("sent");
    expect({ attempts: (await w.row("k1")).attempts, delivered: tr.state.delivered.length }).toEqual({ attempts: 3, delivered: 1 });
  });

  it("a cap wait that would end past the window is not offered: final, and the answer names no wait", async () => {
    const w = await world();
    const forwardOf = await forwarded(w);
    const tr = transport();
    const fetch = door([capFull(10), capFull(10)]);
    const more = { openFetchAdapter: fetch.openFetchAdapter };
    expect(refusal(await outcome(press(w, "k1", tr, { forwardOf }, more)))).toMatchObject({ retryable: true, retryAfter: 10 });
    w.advance(111_000);
    // Re-armed at 111 s; the cap's 10 s would end at 121 s, past the two minutes.
    expect(refusal(await outcome(press(w, "k1", tr, { forwardOf }, more))))
      .toEqual({ code: "mailbox_busy", httpStatus: 429, retryable: false, retryAfter: undefined });
    expect((await w.row("k1")).retryUntil).toBeNull();
    expect(tr.state.dials).toBe(0);
  });

  it("a replay after the window is told the cap's refusal, not retryable, and reads and dials nothing", async () => {
    const w = await world();
    const forwardOf = await forwarded(w);
    const tr = transport();
    const fetch = door([capFull(2)]);
    const more = { openFetchAdapter: fetch.openFetchAdapter };
    expect(refusal(await outcome(press(w, "k1", tr, { forwardOf }, more)))).toMatchObject({ retryable: true, retryAfter: 2 });
    // A phone held offline through the window replays its key on the return.
    w.advance(WINDOW_MS + 1_000);
    const late = await outcome(press(w, "k1", tr, { forwardOf }, more));
    expect(refusal(late)).toEqual({ code: "mailbox_busy", httpStatus: 429, retryable: false, retryAfter: undefined });
    expect((late as ServiceError).message).toBe(SEND_FAILED_SENTENCE);
    expect({ opens: fetch.state.opens, dials: tr.state.dials, draft: (await w.draft()).status }).toEqual({ opens: 1, dials: 0, draft: "draft" });
  });

  it("by its code and its source's own flag, never by text: these stay final, and name no wait", async () => {
    const decoys: Array<[string, ServiceError]> = [
      ["mailbox_busy its source did not offer again", capFull(2, false)],
      ["another refusal that says mailbox_busy in its words", new ServiceError("upstream_unavailable", 502, "mailbox_busy", { retryAfter: 2 }, true)],
    ];
    for (const [what, refused] of decoys) {
      const w = await world();
      const forwardOf = await forwarded(w);
      const tr = transport();
      const e = await outcome(press(w, "k1", tr, { forwardOf }, { openFetchAdapter: door([refused]).openFetchAdapter }));
      expect(refusal(e), what).toEqual({ code: refused.code, httpStatus: refused.httpStatus, retryable: false, retryAfter: undefined });
      expect((await w.row("k1")).retryUntil, what).toBeNull();
    }
  });

  it("CONTROL: a door that does not offer sends again (the scheduled pass's) keeps a full cap final", async () => {
    const w = await world();
    const forwardOf = await forwarded(w);
    const tr = transport();
    const e = await outcome(svc.send(w.ctx, w.draftId, "k1",
      { openSendAdapter: tr.factory, openFetchAdapter: door([capFull(2)]).openFetchAdapter } as never, { forwardOf }));
    expect(refusal(e)).toEqual({ code: "mailbox_busy", httpStatus: 429, retryable: false, retryAfter: undefined });
    expect((await w.row("k1")).retryUntil).toBeNull();
  });
});

describe("a refusal that will not pass is final, and says so", () => {
  const cases: Array<[string, Script, { code: string; httpStatus: number }]> = [
    ["a certificate that fails", { dial: [() => shaped({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })] }, { code: "send_not_secured", httpStatus: 424 }],
    ["a sign-in refused", { dial: [() => shaped({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" })] }, { code: "send_login_refused", httpStatus: 424 }],
    ["a grant the provider revoked", { dial: [() => shaped({ code: "OAUTH_INVALID_GRANT" })] }, { code: "send_login_refused", httpStatus: 424 }],
    ["a 535 at AUTH", { submit: [() => new SendNotSubmitted("login", shaped({ code: "EAUTH", responseCode: 535 }))] }, { code: "send_login_refused", httpStatus: 424 }],
    ["STARTTLS that failed", { submit: [() => new SendNotSubmitted("secure", shaped({ code: "ETLS" }))] }, { code: "send_not_secured", httpStatus: 424 }],
    ["an outgoing server not settled", { dial: [() => new MailboxSideRefusal("smtp_not_settled", 502, "not settled")] }, { code: "smtp_not_settled", httpStatus: 502 }],
    ["a fault of ours", { dial: [() => new TypeError("cannot read properties of undefined")] }, { code: "internal", httpStatus: 500 }],
    ["a count bound, not a clock", { dial: [() => shaped({ name: "ImapBoundExceeded", code: "EIMAPBOUND", bound: "list_folders" })] }, { code: "internal", httpStatus: 500 }],
  ];
  for (const [what, script, want] of cases) {
    it(`${what}: ${want.httpStatus} ${want.code}, explicitly not retryable, and the replay dials nothing`, async () => {
      const w = await world();
      const tr = transport(script);
      const first = await outcome(press(w, "k1", tr));
      expect(refusal(first)).toEqual({ ...want, retryable: false, retryAfter: undefined });
      const r = await w.row("k1");
      expect({ status: r.status, retryUntil: r.retryUntil, retryRefusal: r.retryRefusal })
        .toEqual({ status: "failed", retryUntil: null, retryRefusal: null });
      const dials = tr.state.dials;
      const replay = await press(w, "k1", tr);
      expect(replay.status).toBe("failed");
      expect(tr.state.dials, "a final failure was dialled again").toBe(dials);
      expect(tr.state.delivered).toHaveLength(0);
    });
  }

  it("a fault of ours keeps its cause and the standing sentence, and stays ours (no notOurFault)", async () => {
    const w = await world();
    const ours = new TypeError("cannot read properties of undefined");
    const e = await outcome(press(w, "k1", transport({ dial: [() => ours] }))) as ServiceError;
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.message).toBe(SEND_FAILED_SENTENCE);
    expect((e as { cause?: unknown }).cause).toBe(ours);
    expect((e as { notOurFault?: unknown }).notOurFault).toBeUndefined();
  });

  it("smtp_not_settled keeps its class and stays no fault of ours", async () => {
    const w = await world();
    const e = await outcome(press(w, "k1", transport({ dial: [() => new MailboxSideRefusal("smtp_not_settled", 502, "x")] })));
    expect(e).toBeInstanceOf(MailboxSideRefusal);
    expect((e as { notOurFault?: unknown }).notOurFault).toBe(true);
  });

  it("a forward whose original this host cannot read is final", async () => {
    const w = await world();
    const orig = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, subject: "The list", fromAddress: "list@rearm.test",
      nativeLocator: { folder: "INBOX", ref: "1:7" },
    });
    await seedBody(w.db, { messageId: orig.id, text: "The list.", html: null });
    await w.db.insert(attachments).values({
      accountId: w.accountId, messageId: orig.id, filename: "a.pdf", contentType: "application/pdf",
      sizeBytes: 4, partId: "2", inline: false,
    });
    const tr = transport();
    const e = await outcome(press(w, "k1", tr, { forwardOf: orig.id }));
    expect(refusal(e)).toEqual({ code: "forward_original_unavailable", httpStatus: 409, retryable: false, retryAfter: undefined });
    expect((await w.row("k1")).retryUntil).toBeNull();
  });

  it("a forwarded original too large to read is final: payload_too_large, and the replay reads nothing", async () => {
    const w = await world();
    const orig = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, subject: "The list", fromAddress: "list@rearm.test",
      nativeLocator: { folder: "INBOX", ref: "1:8" },
    });
    // Its words were let go by the store, so the forward reads them from the mailbox at send.
    await w.db.insert(messageBodies).values({ messageId: orig.id, text: "", html: null, withheldReason: "storage_cap" });
    let reads = 0;
    const openFetchAdapter = async () => ({
      async fetchPart() { throw new Error("no parts here"); },
      async fetchRaw() { reads += 1; throw Object.assign(new Error("over the ceiling"), { code: "ERAWTOOLARGE" }); },
      async close() { /* nothing */ },
    });
    const tr = transport();
    const e = await outcome(press(w, "k1", tr, { forwardOf: orig.id }, { openFetchAdapter }));
    expect(refusal(e)).toEqual({ code: "payload_too_large", httpStatus: 413, retryable: false, retryAfter: undefined });
    expect((await w.row("k1")).retryUntil).toBeNull();
    expect((await press(w, "k1", tr, { forwardOf: orig.id }, { openFetchAdapter })).status).toBe("failed");
    expect({ reads, dials: tr.state.dials }).toEqual({ reads: 1, dials: 0 });
  });
});

describe("the bounds: three attempts, two minutes, one key", () => {
  it("three transient failures: the third is final, three dials in all, and a replay after it dials nothing", async () => {
    const w = await world();
    const closed = () => shaped({ code: "EIMAPCLOSED" });
    const tr = transport({ dial: [closed, closed, closed] });
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true, retryAfter: 2 });
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true, retryAfter: 5 });
    expect(refusal(await outcome(press(w, "k1", tr)))).toEqual({ code: "send_unreachable", httpStatus: 424, retryable: false, retryAfter: undefined });
    const r = await w.row("k1");
    expect({ status: r.status, attempts: r.attempts, retryUntil: r.retryUntil }).toEqual({ status: "failed", attempts: 3, retryUntil: null });
    expect((await press(w, "k1", tr)).status).toBe("failed");
    expect(tr.state.dials).toBe(3);
    expect(tr.state.delivered).toHaveLength(0);
  });

  it("a wait that would end past the window is not offered: that attempt is final", async () => {
    const w = await world();
    const closed = () => shaped({ code: "EIMAPCLOSED" });
    const tr = transport({ dial: [closed, closed] });
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true });
    w.advance(116_000);
    // Re-armed at 116 s; its 5 s wait would end at 121 s, past the two minutes.
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ code: "send_unreachable", retryable: false });
    expect((await w.row("k1")).retryUntil).toBeNull();
    expect(tr.state.dials).toBe(2);
  });

  /* A phone held offline past the window replays its key on the return: it is told why the send
     did not go, not the generic `failed`, so the person knows to press again. */
  const LAPSED: Array<[string, () => unknown, string]> = [
    ["the connection ended", () => shaped({ code: "EIMAPCLOSED" }), "send_unreachable"],
    ["a sign-in answered UNAVAILABLE", () => shaped({ authenticationFailed: true, serverResponseCode: "UNAVAILABLE" }), "send_busy"],
    ["the read deadline", () => shaped({ name: "ImapBoundExceeded", code: "EIMAPBOUND", bound: "read_deadline" }), "send_timeout"],
  ];
  for (const [what, fault, code] of LAPSED) {
    it(`${what}: a replay after the window is told ${code}, not retryable, with zero dials`, async () => {
      const w = await world();
      const tr = transport({ dial: [fault] });
      expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ code, retryable: true });
      w.advance(WINDOW_MS + 1_000);
      expect(refusal(await outcome(press(w, "k1", tr)))).toEqual({ code, httpStatus: 424, retryable: false, retryAfter: undefined });
      const r = await w.row("k1");
      expect({ status: r.status, attempts: r.attempts }).toEqual({ status: "failed", attempts: 1 });
      expect((await w.draft()).status).toBe("draft");
      expect([tr.state.dials, tr.state.delivered.length]).toEqual([1, 0]);
    });
  }

  it("CONTROL: a final failure is not a lapsed one: its replay answers failed, before the window's end and after", async () => {
    const w = await world();
    const closed = () => shaped({ code: "EIMAPCLOSED" });
    const tr = transport({ dial: [closed, closed, closed] });
    for (let i = 0; i < 3; i++) await outcome(press(w, "k1", tr));
    expect((await press(w, "k1", tr)).status).toBe("failed");
    w.advance(WINDOW_MS + 1_000);
    expect((await press(w, "k1", tr)).status, "a final row is not a lapsed one").toBe("failed");
    expect(tr.state.dials).toBe(3);
  });

  it("the window is short of the stale age by a whole attempt and a minute to spare", () => {
    const m = sendModule as unknown as Record<string, unknown>;
    expect([m.SEND_MAX_ATTEMPTS, m.SEND_REARM_WINDOW_MS, m.SEND_REARM_WAIT_S]).toEqual([3, 120_000, [2, 5]]);
    expect((m.SEND_REARM_WINDOW_MS as number) + (m.SEND_ATTEMPT_CEILING_MS as number) + 60_000)
      .toBeLessThan(m.SEND_STALE_AFTER_MS as number);
    expect((m.SEND_REARM_WAIT_S as number[]).length).toBe((m.SEND_MAX_ATTEMPTS as number) - 1);
  });
});

describe("a re-arm is the same message, proved", () => {
  const closedOnce = () => transport({ dial: [() => shaped({ code: "EIMAPCLOSED" })] });

  it("an edited draft is another message: nothing is re-armed and nothing is sent", async () => {
    const w = await world();
    const tr = closedOnce();
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true });
    await w.db.update(drafts).set({ body: "Changed my mind." }).where(eq(drafts.id, w.draftId));
    expect((await press(w, "k1", tr)).status).toBe("failed");
    expect([tr.state.dials, tr.state.delivered.length]).toEqual([1, 0]);
  });

  it("a replay without its inline file is another message", async () => {
    const w = await world();
    const tr = closedOnce();
    const file = { filename: "list.csv", contentType: "text/csv", content: Buffer.from("a,b\n1,2\n") };
    expect(refusal(await outcome(press(w, "k1", tr, { attachments: [file] })))).toMatchObject({ retryable: true });
    expect((await press(w, "k1", tr)).status).toBe("failed");
    expect([tr.state.dials, tr.state.delivered.length]).toEqual([1, 0]);
  });

  it("the same words sent under another key hold the claim: the replay re-arms nothing, one delivery in all", async () => {
    const w = await world();
    const tr = closedOnce();
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true });
    // A second draft with the identical message, sent under its own key, takes the content claim.
    const twin = await w.newDraft();
    expect((await press(w, "k2", tr, {}, {}, twin)).status).toBe("sent");
    expect((await press(w, "k1", tr)).status).toBe("failed");
    expect(tr.state.delivered).toHaveLength(1);
  });

  it("a staged send is not re-armed", async () => {
    const w = await world();
    const tr = closedOnce();
    const staged: StagedAttachmentSource = {
      async declare(_a, ids) {
        return ids.map((id) => ({ id, sizeBytes: 5, expiresAt: new Date(START.getTime() + 3_600_000), filename: "big.bin", contentType: "application/octet-stream" }));
      },
      async fetch(_a, ids) {
        return ids.map(() => ({ filename: "big.bin", contentType: "application/octet-stream", content: Buffer.from("bytes") }));
      },
    };
    const e = await outcome(press(w, "k1", tr, { stagedAttachmentIds: ["t-1"] }, { stagedAttachments: staged }));
    expect(refusal(e)).toEqual({ code: "send_unreachable", httpStatus: 424, retryable: false, retryAfter: undefined });
    expect((await w.row("k1")).retryUntil).toBeNull();
  });

  it("a replay refused for another revision rolls its re-arm back: the failure still stands for the right one", async () => {
    const w = await world();
    const tr = closedOnce();
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true });
    const refused = await outcome(press(w, "k1", tr, { ifContentRevision: "f".repeat(64) }));
    expect(refusal(refused)).toMatchObject({ code: "draft_changed", httpStatus: 409 });
    const r = await w.row("k1");
    expect({ status: r.status, attempts: r.attempts, retryUntil: r.retryUntil !== null }).toEqual({ status: "failed", attempts: 1, retryUntil: true });
    expect((await press(w, "k1", tr)).status).toBe("sent");
    expect(tr.state.delivered).toHaveLength(1);
  });
});

describe("Cancel during the wait", () => {
  it("withdraws the key: the replay is told so, nothing is delivered, and the same words go under a new key", async () => {
    const w = await world();
    const tr = transport({ dial: [() => shaped({ code: "EIMAPCLOSED" })] });
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true });
    const cancelled = await svc.withdraw(w.ctx, "k1", w.draftId, { openSendAdapter: tr.factory });
    expect(cancelled.outcome).toBe("withdrawn");
    const r = await w.row("k1");
    expect({ status: r.status, resolvedBy: r.resolvedBy, retryUntil: r.retryUntil, retryRefusal: r.retryRefusal })
      .toEqual({ status: "withdrawn", resolvedBy: "person", retryUntil: null, retryRefusal: null });
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ code: "send_withdrawn", httpStatus: 409, retryable: false });
    expect(tr.state.delivered).toHaveLength(0);
    expect((await w.draft()).status).toBe("draft");
    expect(await w.db.select().from(outboundSendFingerprints).where(eq(outboundSendFingerprints.sendId, r.id)))
      .toEqual([]);
    // Send pressed again over the same words is a new key, and nothing claims those words.
    expect((await press(w, "k2", tr)).status).toBe("sent");
    expect(tr.state.delivered).toHaveLength(1);
  });

  it("CONTROL: Cancel over a final failure answers failed and changes nothing", async () => {
    const w = await world();
    const tr = transport({ dial: [() => shaped({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })] });
    await outcome(press(w, "k1", tr));
    expect((await svc.withdraw(w.ctx, "k1", w.draftId, { openSendAdapter: tr.factory })).outcome).toBe("failed");
    expect((await w.row("k1")).status).toBe("failed");
  });
});

describe("a crash between attempts sends at most once", () => {
  it("the attempt dies after its re-arm committed: in_flight until stale, then the Sent check settles it, nothing resent", async () => {
    const w = await world();
    const tr = transport({ dial: [() => shaped({ code: "EIMAPCLOSED" }), HANG] });
    expect(refusal(await outcome(press(w, "k1", tr)))).toMatchObject({ retryable: true });
    // The re-armed attempt's dial never answers: the process holding it is as good as dead.
    const dying = outcome(press(w, "k1", tr, {}, { attemptCeilingMs: 60_000 }));
    for (let i = 0; i < 200 && (await w.row("k1")).status !== "pending"; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await w.row("k1")).status).toBe("pending");
    expect((await press(w, "k1", tr)).status, "a live re-armed attempt is answered in_flight").toBe("in_flight");
    w.advance(SEND_STALE_AFTER_MS + 1_000);
    const settled = await press(w, "k1", tr);
    expect(settled.status).toBe("unverified");
    expect(tr.state.probes).toBe(1);
    expect(tr.state.delivered, "nothing was resent").toHaveLength(0);
    tr.release();
    await dying;
    expect((await w.row("k1")).status, "the dead attempt's late ending writes nothing over the settled row").toBe("unverified");
  });
});

describe("the scheduled pass is unchanged", () => {
  it("a transient fault ends the appointment with its sentence and is never re-armed", async () => {
    const w = await world();
    const at = new Date(START.getTime() + 60_000);
    await w.db.update(drafts).set({ status: "scheduled", sendAt: at, sendKey: "appt-1" }).where(eq(drafts.id, w.draftId));
    const tr = transport({ dial: [() => shaped({ code: "EIMAPCLOSED" })] });
    const r = await runScheduledSendPass(w.db, { openSendAdapter: tr.factory, now: () => new Date(at.getTime() + 1_000) });
    expect(r).toMatchObject({ claimed: 1, failed: 1, deferred: 0, sent: 0 });
    const d = await w.draft();
    expect({ status: d.status, sendKey: d.sendKey, sendAt: d.sendAt }).toEqual({ status: "draft", sendKey: null, sendAt: null });
    expect(d.sendError).toMatch(/could not be reached/);
    const row = await w.row("appt-1");
    expect({ status: row.status, retryUntil: row.retryUntil }).toEqual({ status: "failed", retryUntil: null });
    expect(tr.state.delivered).toHaveLength(0);
  });
});
