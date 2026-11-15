import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps, type HelloConfig } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { drafts, messages, outboundSends, writeInvitation, type Tx } from "@trafficflow/db";
import { SendNotSubmitted, type OpenSendAdapter, type OutboundMessage } from "@trafficflow/core";
import { desktopHostRoutes } from "../src/routes/desktop-host.js";
import type { Route } from "../src/router.js";
import { makeDeps, seedMailbox, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * `POST /messages/:id/invitation/answer` — the press, at the door: the send's key and its bound,
 * the send route's statuses and `X-Sync-Seq`, the refusals in the error envelope, another account's
 * letter answered exactly as a missing one, an unverified account refused, and the route mounted in
 * every table whose `GET /hello` says it is. The answer itself is the service's
 * (`packages/services/test/invitation-answer-service.test.ts`); the `sqlite` project runs this too.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const ME = "mila@lichtgrat.example";
const ORGANIZER = "giulia@studio.example";
const ROUTE = "POST /messages/:id/invitation/answer";

function outbox(fail = false) {
  const sent: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      if (fail) throw new SendNotSubmitted("connect", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
      sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to close */ },
  });
  return { sent, factory };
}

async function world(opts: { fail?: boolean; method?: "REQUEST" | "CANCEL"; attendees?: string[]; emailVerified?: boolean } = {}) {
  const box = outbox(opts.fail);
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: box.factory });
  const s = await seedSession(db, { now: FIXED_NOW, ...(opts.emailVerified === false ? { emailVerified: false } : {}) });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: ME });
  const [letter] = await db.insert(messages).values({
    accountId: s.accountId, mailboxId, messageIdHeader: `${randomUUID()}@studio.example`, bodyHash: randomUUID(),
    dedupKey: `mid:${randomUUID()}`, subject: "Invitation", fromAddress: ORGANIZER, date: FIXED_NOW,
    nativeLocator: { folder: "INBOX", ref: "1:9" }, snippet: "",
  }).returning();
  await writeInvitation(db as unknown as Tx, {
    accountId: s.accountId, messageId: letter!.id, method: opts.method ?? "REQUEST", uid: "kickoff-17@studio.example",
    recurrenceId: "", sequence: 0, startRaw: "20261201T100000Z", startsAt: new Date("2026-12-01T10:00:00Z"),
    organizer: ORGANIZER, attendees: opts.attendees ?? [ME], stampedAt: FIXED_NOW, reply: null, own: false,
  });
  const press = (body: unknown, key: string | null = "press-1", id = letter!.id, token = s.token) => H(req("POST", `/messages/${id}/invitation/answer`, {
    bearer: token, headers: key === null ? {} : { "idempotency-key": key }, body: JSON.stringify(body),
  }), deps);
  return { db, deps, s, box, messageId: letter!.id, press };
}

describe("POST /messages/:id/invitation/answer", () => {
  it("a press: 200 with the answer and its instant, X-Sync-Seq; the same key again: already, nothing more", async () => {
    const w = await world();
    const res = await w.press({ answer: "accepted", basis: null });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("x-sync-seq"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body).toMatchObject({ status: "sent", answer: "accepted" });
    expect(Date.parse(body.answeredAt)).toBeGreaterThanOrEqual(Math.floor(FIXED_NOW.getTime() / 1000) * 1000);
    expect(w.box.sent).toHaveLength(1);
    const again = await w.press({ answer: "accepted", basis: null });
    expect([again.status, (await again.json()).status]).toEqual([200, "already"]);
    expect(w.box.sent).toHaveLength(1);
  });

  it("400 without the key, with one past its bound, and for a word that is not an answer", async () => {
    const w = await world();
    expect((await w.press({ answer: "accepted", basis: null }, null)).status).toBe(400);
    expect((await w.press({ answer: "accepted", basis: null }, "k".repeat(65))).status).toBe(400);
    for (const body of [{ answer: "maybe", basis: null }, { answer: "accepted" }, { answer: "accepted", basis: "ja" }, null]) {
      const res = await w.press(body);
      expect([res.status, (await res.json()).error?.code], JSON.stringify(body)).toEqual([400, "validation_failed"]);
    }
    expect(w.box.sent).toHaveLength(0);
  });

  it("refusals are the error envelope with their word and status, and send nothing", async () => {
    const cancelled = await world({ method: "CANCEL" });
    const c = await cancelled.press({ answer: "accepted", basis: null });
    expect([c.status, (await c.json()).error?.code]).toEqual([409, "invitation_cancelled"]);
    const forwarded = await world({ attendees: ["someone@elsewhere.example"] });
    const f = await forwarded.press({ answer: "accepted", basis: null });
    expect([f.status, (await f.json()).error?.code]).toEqual([422, "invitation_not_invited"]);
    const elsewhere = await world();
    await elsewhere.press({ answer: "accepted", basis: null });
    const e = await elsewhere.press({ answer: "declined", basis: null }, "press-2");
    const envelope = (await e.json()).error;
    expect([e.status, envelope?.code, envelope?.details]).toEqual([409, "invitation_answered_elsewhere", { answer: "accepted" }]);
    expect([cancelled.box.sent.length, forwarded.box.sent.length, elsewhere.box.sent.length]).toEqual([0, 0, 1]);
  });

  it("another account's letter answers the missing letter's very bytes", async () => {
    const w = await world();
    const other = await seedSession(w.db, { now: FIXED_NOW, token: "invitation-other" });
    const theirs = await w.press({ answer: "accepted", basis: null }, "k", w.messageId, other.token);
    const missing = await w.press({ answer: "accepted", basis: null }, "k", randomUUID(), other.token);
    expect(theirs.status).toBe(404);
    expect([theirs.status, await theirs.text()]).toEqual([missing.status, await missing.text()]);
    expect(w.box.sent).toHaveLength(0);
    expect(await w.db.select().from(drafts).where(eq(drafts.accountId, w.s.accountId))).toEqual([]);
  });

  it("the plain send route refuses an answer's draft", async () => {
    const w = await world({ fail: true });
    expect((await w.press({ answer: "accepted", basis: null })).status).toBeGreaterThanOrEqual(400);
    const [draft] = await w.db.select().from(drafts).where(eq(drafts.accountId, w.s.accountId));
    expect(draft!.status).toBe("draft");
    const res = await H(req("POST", `/drafts/${draft!.id}/send`, { bearer: w.s.token, headers: { "idempotency-key": "plain" } }), w.deps);
    expect([res.status, (await res.json()).error?.code]).toEqual([422, "invitation_not_answerable"]);
    expect((await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, draft!.id))).filter((r) => r.idempotencyKey === "plain")).toEqual([]);
  });

  it("an account whose address is not confirmed is refused before anything is read", async () => {
    const w = await world({ emailVerified: false });
    const res = await w.press({ answer: "accepted", basis: null });
    expect([res.status, (await res.json()).error?.code]).toEqual([403, "email_unverified"]);
    expect(w.box.sent).toHaveLength(0);
  });

  it("every table that answers GET /hello mounts the route it names", async () => {
    const tables: ReadonlyArray<readonly [string, readonly Route[]]> = [
      ["apiRoutes", apiRoutes], ["localRoutes", localRoutes], ["selfHostRoutes", selfHostRoutes], ["desktopHostRoutes", desktopHostRoutes],
    ];
    const key = (r: Route): string => `${r.method} ${r.pattern}`;
    for (const [name, table] of tables) {
      expect(table.some((r) => key(r) === "GET /hello"), name).toBe(true);
      const route = table.find((r) => key(r) === ROUTE);
      expect(route, name).toBeDefined();
      expect([route!.wire, route!.relay, route!.cost, route!.options], name).toEqual([true, true, "connection", { replaySafe: true }]);
    }
    const hello: HelloConfig = {
      flavor: "local", needsSetup: false, auth: { password: false, totp: false, webauthn: false, publicSignup: false },
      features: { sse: false, staging: false, ai: false, pairing: false, remoteImages: false, scheduleFiles: false },
    };
    const { deps } = await makeDeps();
    const res = await createApp(localRoutes).handle(req("GET", "/hello"), { ...deps, hello, session: null });
    expect((await res.json()).features.invitationAnswer).toBe(true);
  });
});
