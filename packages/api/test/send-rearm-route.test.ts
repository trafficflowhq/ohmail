import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts, outboundSends } from "@trafficflow/db";
import { DbAcquireTimeoutError, acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { SendNotSubmitted, type OpenSendAdapter, type OutboundMessage } from "@trafficflow/core/mail";
import { MailboxSideRefusal } from "@trafficflow/services/mail";
import { TransientDialRefusal } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";
import { forwardWorld } from "./_forward-world.js";

/**
 * POST /drafts/:id/send ANSWERS A PASSING FAULT BEFORE SMTP AS RETRYABLE, AND ITS REPLAY SENDS. Through
 * the real route and an injected factory that fails once: the first answer is 424 with
 * `retryable: true`, a `Retry-After` and the same wait in `details`; the row is `failed` with its
 * re-arm deadline; the same-key replay answers 200 `sent` with one delivery and the attempt counted.
 * Before this the first answer was a 500 with no `retryable` (or a 424 saying not retryable), and the
 * replay met 409 `failed`. Controls: a refusal that will not pass answers explicitly not retryable,
 * no `Retry-After`, and its replay dials nothing; a starved pool in front of the send says it may be
 * asked again, since the reservation deduplicates the replay.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const shaped = (fields: Record<string, unknown>): Error => Object.assign(new Error("dial"), fields);

function flaky(o: { dial?: () => unknown; submit?: () => unknown }) {
  const state = { dials: 0, submits: 0, delivered: [] as OutboundMessage[] };
  const open: OpenSendAdapter = async () => {
    state.dials += 1;
    if (state.dials === 1 && o.dial) throw o.dial();
    return {
      async send(msg) {
        state.submits += 1;
        if (state.submits === 1 && o.submit) throw o.submit();
        state.delivered.push(msg);
        return { providerMessageId: msg.messageId ?? "<none>" };
      },
      async messageInSent() { return false; },
      async close() { /* nothing */ },
    };
  };
  return { open, state };
}

async function world(open: OpenSendAdapter) {
  const made = await makeDeps(FIXED_NOW, {}, { sendAdapter: open });
  vi.restoreAllMocks();
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(made.db, { accountId: s.accountId, address: "u@rearm-route.example" });
  const [d] = await made.db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "Fwd: the list", body: "See below.",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
  } as never).returning();
  const row = async () => (await made.db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id)))[0]!;
  return { ...made, s, draftId: d!.id, row };
}
type World = Awaited<ReturnType<typeof world>>;

const press = (w: World, key: string): Promise<Response> =>
  H(req("POST", `/drafts/${w.draftId}/send`, { bearer: w.s.token, headers: { "idempotency-key": key } }), w.deps);

async function answer(res: Response) {
  const body = await res.json() as { status?: string; error?: { code?: string; retryable?: boolean; details?: { retryAfter?: unknown } } };
  return {
    status: res.status, code: body.error?.code, retryable: body.error?.retryable,
    retryAfter: body.error?.details?.retryAfter, header: res.headers.get("retry-after"), wire: body.status,
  };
}

const TRANSIENT: Array<[string, { dial?: () => unknown; submit?: () => unknown }, string]> = [
  ["the connection ended at the dial", { dial: () => shaped({ code: "EIMAPCLOSED" }) }, "send_unreachable"],
  ["a sign-in the server answered 'not now'", { dial: () => shaped({ authenticationFailed: true, serverResponseCode: "UNAVAILABLE" }) }, "send_busy"],
  ["the connection ceiling full", { dial: () => new TransientDialRefusal("mb", "at its ceiling") }, "send_busy"],
  ["the dial refused", { dial: () => shaped({ code: "ECONNREFUSED" }) }, "send_unreachable"],
  ["a 454 at AUTH", { submit: () => new SendNotSubmitted("login", shaped({ code: "EAUTH", responseCode: 454 })) }, "send_busy"],
];

describe("POST /drafts/:id/send — a passing fault before SMTP", () => {
  for (const [what, fault, code] of TRANSIENT) {
    it(`${what}: 424 ${code} retryable with Retry-After, and the same-key replay sends once`, async () => {
      const f = flaky(fault);
      const w = await world(f.open);
      const first = await answer(await press(w, "k1"));
      expect(first).toEqual({ status: 424, code, retryable: true, retryAfter: 2, header: "2", wire: undefined });
      const failed = await w.row();
      expect({ status: failed.status, attempts: failed.attempts, retryUntil: failed.retryUntil !== null })
        .toEqual({ status: "failed", attempts: 1, retryUntil: true });

      const replay = await answer(await press(w, "k1"));
      expect({ status: replay.status, wire: replay.wire }).toEqual({ status: 200, wire: "sent" });
      expect(f.state.delivered).toHaveLength(1);
      const sent = await w.row();
      expect({ status: sent.status, attempts: sent.attempts }).toEqual({ status: "sent", attempts: 2 });
    });
  }
});

describe("POST /drafts/:id/send — a refusal that will not pass", () => {
  const PERMANENT: Array<[string, { dial?: () => unknown; submit?: () => unknown }, { status: number; code: string }]> = [
    ["a certificate that fails", { dial: () => shaped({ code: "CERT_HAS_EXPIRED" }) }, { status: 424, code: "send_not_secured" }],
    ["a 535 at AUTH", { submit: () => new SendNotSubmitted("login", shaped({ code: "EAUTH", responseCode: 535 })) }, { status: 424, code: "send_login_refused" }],
    ["an outgoing server not settled", { dial: () => new MailboxSideRefusal("smtp_not_settled", 502, "not settled") }, { status: 502, code: "smtp_not_settled" }],
  ];
  for (const [what, fault, want] of PERMANENT) {
    it(`${what}: ${want.status} ${want.code}, explicitly not retryable, no Retry-After, and the replay dials nothing`, async () => {
      const f = flaky(fault);
      const w = await world(f.open);
      const first = await answer(await press(w, "k1"));
      expect(first).toEqual({ ...want, retryable: false, retryAfter: undefined, header: null, wire: undefined });
      expect((await w.row()).retryUntil).toBeNull();
      const dials = f.state.dials;
      const replay = await answer(await press(w, "k1"));
      expect({ status: replay.status, wire: replay.wire }).toEqual({ status: 409, wire: "failed" });
      expect(f.state.dials).toBe(dials);
      expect(f.state.delivered).toHaveLength(0);
    });
  }
});

describe("POST /drafts/:id/send — a replay after the two minutes", () => {
  it("is told the refusal that ended its last attempt, not retryable, and dials nothing", async () => {
    const f = flaky({ dial: () => shaped({ code: "EIMAPCLOSED" }) });
    const w = await world(f.open);
    expect((await answer(await press(w, "k1"))).retryable).toBe(true);
    // A phone held offline through the window replays its key on the return.
    w.clock.advance(121_000);
    const late = await answer(await press(w, "k1"));
    expect(late).toEqual({ status: 424, code: "send_unreachable", retryable: false, retryAfter: undefined, header: null, wire: undefined });
    expect(f.state.dials).toBe(1);
    expect(f.state.delivered).toHaveLength(0);
    expect((await w.row()).status).toBe("failed");
  });
});

/* Cloud: another instance holds both of the mailbox's slots in the shared counter, so the fetch door
   refuses a forward's read at once (`mailbox_busy`, 10 s) rather than after its local wait. The
   Desktop and phone shape, the local gate on both stores, is `send-rearm-forward-cap.test.ts`. */
describe("POST /drafts/:id/send — a forward while another instance holds the mailbox's shared IMAP slots", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const takeBoth = async (w: Awaited<ReturnType<typeof forwardWorld>>) => {
    for (let i = 0; i < 2; i++) await acquireImapSlot(w.db as never, { mailboxId: w.mailboxId, max: 2, now: FIXED_NOW });
  };

  it("is offered again at once with the counter's 10 s wait; freed, the same key sends the forward once", async () => {
    const w = await forwardWorld({ admission: "cloud" });
    await takeBoth(w);
    const first = await answer(await w.press("k1"));
    expect(first).toEqual({ status: 429, code: "mailbox_busy", retryable: true, retryAfter: 10, header: "10", wire: undefined });
    const failed = await w.row();
    expect({ status: failed?.status, attempts: failed?.attempts, retryRefusal: failed?.retryRefusal, dials: w.smtp.dials })
      .toEqual({ status: "failed", attempts: 1, retryRefusal: "mailbox_busy", dials: 0 });

    for (let i = 0; i < 2; i++) await releaseImapSlot(w.db as never, w.mailboxId, FIXED_NOW);
    w.clock.advance(10_000);
    const replay = await answer(await w.press("k1"));
    expect({ status: replay.status, wire: replay.wire }).toEqual({ status: 200, wire: "sent" });
    const sent = await w.row();
    expect({ status: sent?.status, attempts: sent?.attempts }).toEqual({ status: "sent", attempts: 2 });
    expect(w.smtp.delivered.map((m) => [m.messageId, m.attachments?.map((a) => a.filename)]))
      .toEqual([[sent?.mintedMessageId, ["plan.pdf"]]]);
  });

  it("held through every attempt: the third is final and names no wait, so no Retry-After beside retryable: false", async () => {
    const w = await forwardWorld({ admission: "cloud" });
    await takeBoth(w);
    for (const named of ["10", "10"]) {
      const a = await answer(await w.press("k1"));
      expect({ retryable: a.retryable, header: a.header }).toEqual({ retryable: true, header: named });
      w.clock.advance(10_000);
    }
    const last = await answer(await w.press("k1"));
    expect(last).toEqual({ status: 429, code: "mailbox_busy", retryable: false, retryAfter: undefined, header: null, wire: undefined });
    const r = await w.row();
    expect({ status: r?.status, attempts: r?.attempts, retryUntil: r?.retryUntil ?? null, dials: w.smtp.dials })
      .toEqual({ status: "failed", attempts: 3, retryUntil: null, dials: 0 });
  });
});

describe("POST /drafts/:id/send — a busy pool in front of the send", () => {
  it("answers 503 db_busy retryable: the reservation deduplicates the replay", async () => {
    const w = await world(flaky({}).open);
    const busy = { ...w.deps, services: { ...w.deps.services!, sends: { send: async () => { throw new DbAcquireTimeoutError(15_000); } } } } as unknown as ApiDeps;
    const res = await H(req("POST", `/drafts/${w.draftId}/send`, { bearer: w.s.token, headers: { "idempotency-key": "k1" } }), busy);
    expect(res.status).toBe(503);
    const a = await answer(res);
    expect({ code: a.code, retryable: a.retryable, header: a.header }).toEqual({ code: "db_busy", retryable: true, header: "5" });
  });
});
