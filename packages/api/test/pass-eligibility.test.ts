import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createApp, apiRoutes, SCHEDULED_SEND_CRON_PATH, SEND_RECONCILE_CRON_PATH, type ApiDeps,
} from "@trafficflow/api";
import { AWAY_RESPONDER_CRON_PATH, SENT_COPIES_CRON_PATH } from "../src/routes/internal.js";
import { drafts, mailboxes, awayResponders, outboundSends, outboundSentCopies } from "@trafficflow/db";
import type { AccessVerdict, EntitlementsPort } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core/mail";
import { OWED_COPY_CLOUD } from "@trafficflow/services";
import { makeDeps, req } from "./helpers.js";

/**
 * THE WALL'S ELIGIBILITY, AT THE THREE SENDER DOORS (mail 0124).
 *
 * The pass seams (`accountEligible`) were built, tested at the services tier, and WIRED TO
 * NOTHING: every hosted poke ran with the injected default, which is eligible, so a parked
 * account's automation kept firing while its owner met the 402. These cases drive the REAL
 * routes with a refusing entitlements port, because the composition — not the seam — is what
 * shipped missing. Each case reddens when its route's `accountEligible` composition is removed:
 * the injected default is eligible, and the parked account's work would then run.
 */

const app = createApp(apiRoutes);
const H = (r: Request, deps: ApiDeps): Promise<Response> => app.handle(r, deps);
const SECRET = "pass-eligibility-test-secret-abcdefghij-fixture-token";

/** A port refusing exactly the named accounts; everything else is allowed with open limits. */
function portParking(parked: ReadonlySet<string>): EntitlementsPort {
  const verdict = (accountId: string): AccessVerdict => parked.has(accountId)
    ? { ok: false, reason: "payment_required" }
    : { ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true } };
  return {
    access: async (accountId) => verdict(accountId),
    accessOrFault: async (accountId) => verdict(accountId),
    spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
    release: async () => "settled",
    manageLink: async () => null,
    releaseAccount: async () => "none",
  };
}

/** A fake send transport — no network; counts what went out (send-later.test.ts's shape). */
function fakeAdapter() {
  const state = { opened: [] as string[], delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async (mailboxId: string) => ({
    async send(msg: OutboundMessage) {
      state.opened.push(mailboxId);
      state.delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to tear down */ },
  });
  return { factory, state };
}

async function armed(parked: ReadonlySet<string>) {
  const { db, deps } = await makeDeps();
  deps.alerts = { secret: SECRET };
  const fake = fakeAdapter();
  deps.services!.sendAdapter = fake.factory;
  deps.services!.entitlementsPort = portParking(parked);
  return { db, deps, fake };
}

/** One due appointment: a `scheduled` draft whose send_at has passed. */
async function dueDraft(db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string, now: Date) {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `w-${randomUUID().slice(0, 8)}@wall.test`,
    status: "connected",
  }).returning();
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "due", body: "held",
    to: [{ name: null, address: "you@example.com" }], status: "scheduled",
    sendAt: new Date(now.getTime() - 60_000), sendKey: randomUUID(),
    createdAt: now, updatedAt: now,
  }).returning();
  return { mailboxId: mb!.id, draftId: d!.id };
}

describe("the scheduled sender skips a parked account's appointments", () => {
  it("parked ⇒ the row stays `scheduled` and nothing is dialled; open ⇒ it sends", async () => {
    const parkedAccount = randomUUID();
    const { db, deps, fake } = await armed(new Set([parkedAccount]));
    const { draftId } = await dueDraft(db, parkedAccount, deps.now());

    const res = await H(req("GET", SCHEDULED_SEND_CRON_PATH, { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed, "a parked account's appointment was claimed").toBe(0);
    expect(fake.state.delivered).toHaveLength(0);
    const [held] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    // Untouched, not re-armed: still `scheduled`, sent promptly once the account reads open.
    expect(held!.status).toBe("scheduled");

    // THE POSITIVE CONTROL, same door, same rows: an OPEN account's appointment goes out —
    // without it every assertion above passes for a pass that claims nobody's.
    const open = await armed(new Set());
    const seeded = await dueDraft(open.db, randomUUID(), open.deps.now());
    const res2 = await H(req("GET", SCHEDULED_SEND_CRON_PATH, { bearer: SECRET }), open.deps);
    expect((await res2.json()).sent).toBe(1);
    expect(open.fake.state.delivered).toHaveLength(1);
    const [sent] = await open.db.select().from(drafts).where(eq(drafts.id, seeded.draftId));
    expect(sent!.status).toBe("sent");
  });
});

describe("the reconciler skips a parked account's stranded reservations", () => {
  /** A stranded reservation, `pending` and eleven minutes old (send-reconcile-route's shape). */
  async function stranded(db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string, now: Date) {
    const at = new Date(now.getTime() - 11 * 60_000);
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `r-${randomUUID().slice(0, 8)}@wall.test`,
      status: "connected",
    }).returning();
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "stranded", body: "words",
      to: [{ name: null, address: "you@example.com" }],
      status: "sending", createdAt: at, updatedAt: at,
    }).returning();
    const [s] = await db.insert(outboundSends).values({
      accountId, idempotencyKey: randomUUID(), draftId: d!.id,
      mintedMessageId: `<${randomUUID()}@wall.test>`, status: "pending", createdAt: at,
    }).returning();
    return { sendId: s!.id };
  }

  it("parked ⇒ the reservation stays `pending`, no socket opened; open ⇒ it is resolved", async () => {
    const parkedAccount = randomUUID();
    const { db, deps, fake } = await armed(new Set([parkedAccount]));
    const { sendId } = await stranded(db, parkedAccount, deps.now());

    const res = await H(req("GET", SEND_RECONCILE_CRON_PATH, { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
    expect(fake.state.opened, "a parked account's mailbox was dialled").toHaveLength(0);
    const [held] = await db.select().from(outboundSends).where(eq(outboundSends.id, sendId));
    expect(held!.status).toBe("pending");

    // The positive control: an open account's stranded reservation IS worked on.
    const open = await armed(new Set());
    const s2 = await stranded(open.db, randomUUID(), open.deps.now());
    await H(req("GET", SEND_RECONCILE_CRON_PATH, { bearer: SECRET }), open.deps);
    const [resolved] = await open.db.select().from(outboundSends).where(eq(outboundSends.id, s2.sendId));
    expect(resolved!.status).not.toBe("pending");
  });
});

describe("the late Sent-copy pass does not dial a parked account's mailbox", () => {
  async function owed(db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string, now: Date) {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `c-${randomUUID().slice(0, 8)}@wall.test`, status: "connected",
    }).returning();
    const minted = `<${randomUUID()}@wall.test>`;
    const [s] = await db.insert(outboundSends).values({
      accountId, idempotencyKey: randomUUID(), mintedMessageId: minted, providerMessageId: minted, status: "sent",
    }).returning();
    await db.insert(outboundSentCopies).values({ sendId: s!.id, accountId, mailboxId: mb!.id, rawB64: "cmF3", nextAttemptAt: now });
    return { sendId: s!.id };
  }
  const dialling = (dials: string[]): OpenSendAdapter => async (mailboxId: string) => {
    dials.push(mailboxId);
    return {
      async send() { throw new Error("never"); },
      async messageInSent() { return false; },
      async fileSentCopy() { return null; },
      async close() { /* nothing held */ },
    };
  };

  it("the scheduled sender keeps a copy that cannot land under the door's own policy", async () => {
    const { db, deps } = await armed(new Set());
    deps.services!.sendKeepOwedCopy = OWED_COPY_CLOUD;
    deps.services!.sendAdapter = async () => ({
      async send(msg: OutboundMessage, o?: { copy?: string; beforeRelease?: () => Promise<void> }) {
        await o?.beforeRelease?.();
        return { providerMessageId: msg.messageId!, ...(o?.copy === "caller" ? { unfiledCopy: Buffer.from("raw") } : {}) };
      },
      async fileSentCopy() { throw new Error("NO [OVERQUOTA] mailbox full"); },
      async messageInSent() { return false; },
      async close() { /* nothing held */ },
    });
    await dueDraft(db, randomUUID(), deps.now());
    expect((await (await H(req("GET", SCHEDULED_SEND_CRON_PATH, { bearer: SECRET }), deps)).json()).sent).toBe(1);
    expect(await db.select({ id: outboundSentCopies.sendId }).from(outboundSentCopies)).toHaveLength(1);
  });

  it("parked ⇒ the copy waits, no socket opened; open ⇒ it is filed", async () => {
    const parkedAccount = randomUUID();
    const { db, deps } = await armed(new Set([parkedAccount]));
    const dials: string[] = [];
    deps.services!.sendAdapter = dialling(dials);
    const { sendId } = await owed(db, parkedAccount, deps.now());
    const body = await (await H(req("GET", SENT_COPIES_CRON_PATH, { bearer: SECRET }), deps)).json();
    expect({ deferred: body.deferred, dials }).toEqual({ deferred: 1, dials: [] });
    expect(await db.select({ id: outboundSentCopies.sendId }).from(outboundSentCopies)).toEqual([{ id: sendId }]);

    const open = await armed(new Set());
    const openDials: string[] = [];
    open.deps.services!.sendAdapter = dialling(openDials);
    await owed(open.db, randomUUID(), open.deps.now());
    const body2 = await (await H(req("GET", SENT_COPIES_CRON_PATH, { bearer: SECRET }), open.deps)).json();
    expect({ filed: body2.filed, dials: openDials.length }).toEqual({ filed: 1, dials: 1 });
  });
});

describe("the away responder defers a parked account whole", () => {
  async function liveResponder(db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string, now: Date) {
    await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `a-${randomUUID().slice(0, 8)}@wall.test`,
      status: "connected",
    });
    await db.insert(awayResponders).values({
      accountId, enabled: true, body: "Back Monday.", audience: "screened_in",
      throttle: "per_day", piles: ["INBOX"], enabledAt: new Date(now.getTime() - 3_600_000),
    });
  }

  it("parked ⇒ deferred before anything is read or decided; open ⇒ the account is served", async () => {
    const parkedAccount = randomUUID();
    const { db, deps } = await armed(new Set([parkedAccount]));
    await liveResponder(db, parkedAccount, deps.now());

    const res = await H(req("GET", AWAY_RESPONDER_CRON_PATH, { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The pass's own counter for the gate: the account was seen and deliberately not examined,
    // so nothing is recorded as decided and the replies go out promptly on reopening.
    expect(body.deferredAccounts).toBe(1);
    expect(body.sent).toBe(0);

    // The positive control: the same responder on an OPEN account is not deferred.
    const open = await armed(new Set());
    await liveResponder(open.db, randomUUID(), open.deps.now());
    const res2 = await H(req("GET", AWAY_RESPONDER_CRON_PATH, { bearer: SECRET }), open.deps);
    expect((await res2.json()).deferredAccounts).toBe(0);
  });
});

describe("the scheduled sender stays inside its invocation", () => {
  it("starts no send that could not finish before the platform's 60 s; the rest stay appointments", async () => {
    const { db, deps, fake } = await armed(new Set());
    let t = deps.now().getTime();
    deps.now = () => new Date(t);
    for (let i = 0; i < 3; i += 1) await dueDraft(db, randomUUID(), deps.now());
    // Each letter's Sent copy is slow: 30 s of the invocation apiece.
    deps.services!.sendAdapter = async (m) => {
      const a = await fake.factory(m);
      return { ...a, send: async (msg: OutboundMessage) => { t += 30_000; return a.send(msg); } };
    };
    const body = await (await H(req("GET", SCHEDULED_SEND_CRON_PATH, { bearer: SECRET }), deps)).json();
    expect(body).toMatchObject({ claimed: 3, sent: 1, deferred: 2 });
    expect(await db.select().from(drafts).where(eq(drafts.status, "scheduled"))).toHaveLength(2);
  });
});
