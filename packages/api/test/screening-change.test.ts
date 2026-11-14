import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  mailboxes, organizerRequests, markRequestsApplied, markRequestsRefused, markRequestsSent,
} from "@trafficflow/db";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * A SCREENING CHANGE MADE ON A READER SAYS WHERE IT WENT, through `GET/PATCH /account/screening`.
 *
 * On a reader the press queues a `profile.update` and writes nothing here, so the answer used to
 * carry the unchanged values and nothing else: the pane said "Saved.", and an ack the holder sent
 * back — applied or refused — reached no surface. The acks are recorded here by the reader's own
 * settlement (`markRequests*`, what its cycle calls on reading one).
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

type Deps = Awaited<ReturnType<typeof makeDeps>>;

async function readerWorld(): Promise<{ w: Deps; token: string; accountId: string }> {
  const w = await makeDeps();
  const s = await seedSession(w.db, { now: FIXED_NOW });
  await w.db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "reader@lichtgrat.example",
    organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,profile",
    organizedByKind: "local", organizedByName: "work-laptop",
  });
  return { w, token: s.token, accountId: s.accountId };
}

async function patch(w: Deps, token: string, body: unknown) {
  const res = await H(req("PATCH", "/account/screening", { bearer: token, body: JSON.stringify(body) }), w.deps);
  expect(res.status).toBeLessThan(300);
  return res.json();
}

async function get(w: Deps, token: string) {
  const res = await H(req("GET", "/account/screening", { bearer: token }), w.deps);
  expect(res.status).toBe(200);
  return res.json();
}

async function newestRequestId(w: Deps, accountId: string): Promise<string> {
  const rows = await w.db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
  rows.sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime() || (a.id < b.id ? 1 : -1));
  return rows[0]!.id;
}

describe("a reader's Screening change", () => {
  it("is asked at the press, not saved", async () => {
    const { w, token } = await readerWorld();
    const answer = await patch(w, token, { ohboxPolicy: "people_only" });
    expect(answer.pending).toBe(true);
    expect(answer.ohboxPolicy).toBeNull();
    expect(answer.change, "the answer does not say the change is waiting").toEqual({
      state: "asked", holder: null, refusal: null,
    });
  });

  it("reads applied once the holder acks it, with the applied value shown", async () => {
    const { w, token, accountId } = await readerWorld();
    await patch(w, token, { ohboxPolicy: "people_only" });
    const id = await newestRequestId(w, accountId);
    await w.db.transaction((tx) => markRequestsSent(tx, [id], FIXED_NOW));
    await w.db.transaction((tx) => markRequestsApplied(tx, [id], FIXED_NOW));

    const now = await get(w, token);
    expect(now.change).toEqual({ state: "applied", holder: null, refusal: null });
    expect(now.ohboxPolicy, "Applied over the old switch").toBe("people_only");
  });

  it("reads refused with the holder's name, and the refused value is not shown", async () => {
    const { w, token, accountId } = await readerWorld();
    await patch(w, token, { ohboxPolicy: "people_only" });
    const first = await newestRequestId(w, accountId);
    await w.db.transaction((tx) => markRequestsSent(tx, [first], FIXED_NOW));
    await w.db.transaction((tx) => markRequestsApplied(tx, [first], FIXED_NOW));

    w.clock.advance(60_000);
    await patch(w, token, { impersonationFiling: false });
    const second = await newestRequestId(w, accountId);
    expect(second).not.toBe(first);
    await w.db.transaction((tx) => markRequestsSent(tx, [second], FIXED_NOW));
    await w.db.transaction((tx) => markRequestsRefused(tx, [second], "invalid_payload", FIXED_NOW));

    const now = await get(w, token);
    expect(now.change, "the refusal reached no surface").toEqual({
      state: "refused", holder: "work-laptop", refusal: "unreadable",
    });
    expect(now.impersonationFiling, "the refused value is not shown").toBe(true);
    expect(now.ohboxPolicy, "the earlier applied change is still shown").toBe("people_only");
  });

  it("names a refusal the holder read and turned away apart from one it could not read", async () => {
    const { w, token, accountId } = await readerWorld();
    await patch(w, token, { ohboxBar: "people I know" });
    const id = await newestRequestId(w, accountId);
    await w.db.transaction((tx) => markRequestsSent(tx, [id], FIXED_NOW));
    await w.db.transaction((tx) => markRequestsRefused(tx, [id], "stale", FIXED_NOW));
    expect((await get(w, token)).change).toEqual({ state: "refused", holder: "work-laptop", refusal: "other" });
  });

  it("goes quiet a day after a refusal", async () => {
    const { w, token, accountId } = await readerWorld();
    await patch(w, token, { ohboxPolicy: "people_only" });
    const id = await newestRequestId(w, accountId);
    const dayAgo = new Date(FIXED_NOW.getTime() - 25 * 60 * 60 * 1000);
    await w.db.transaction((tx) => markRequestsSent(tx, [id], dayAgo));
    await w.db.transaction((tx) => markRequestsRefused(tx, [id], "invalid_payload", dayAgo));
    expect((await get(w, token)).change).toBeUndefined();
  });

  it("an install that organizes one mailbox writes here and says nothing of the travel", async () => {
    const { w, token, accountId } = await readerWorld();
    await w.db.insert(mailboxes).values({ accountId, provider: "imap", address: "own@lichtgrat.example" });
    const answer = await patch(w, token, { ohboxPolicy: "people_only" });
    expect(answer.ohboxPolicy).toBe("people_only");
    expect("change" in answer).toBe(false);
    const id = await newestRequestId(w, accountId);
    await w.db.transaction((tx) => markRequestsSent(tx, [id], FIXED_NOW));
    await w.db.transaction((tx) => markRequestsRefused(tx, [id], "invalid_payload", FIXED_NOW));
    const now = await get(w, token);
    expect("change" in now, "a refusal from the other holder is read as this install's state").toBe(false);
    expect(now.ohboxPolicy).toBe("people_only");
  });

  it("an install that organizes answers exactly as before", async () => {
    const w = await makeDeps();
    const s = await seedSession(w.db, { now: FIXED_NOW });
    await w.db.insert(mailboxes).values({ accountId: s.accountId, provider: "imap", address: "own@lichtgrat.example" });
    const answer = await patch(w, s.token, { ohboxPolicy: "people_only" });
    expect(answer.ohboxPolicy).toBe("people_only");
    expect("pending" in answer).toBe(false);
    expect("change" in answer).toBe(false);
    expect("change" in (await get(w, s.token))).toBe(false);
  });
});
