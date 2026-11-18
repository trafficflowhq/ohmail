import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  mailboxes, organizerRequests, markRequestsRefused, markRequestsSent,
} from "@trafficflow/db";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * THE AWAY RESPONDER, THE DORMANCY WINDOW AND THE SIGNATURE SAY WHERE A READER'S CHANGE WENT —
 * the Screening pane's reading on the three other settings that travel. Each answer carries the
 * newest request's state (`change`, `dormancyChange`, `signatureChanges[mailboxId]`) on the read
 * and on the write's echo; the acks are recorded by the reader's own `markRequests*`.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
type Deps = Awaited<ReturnType<typeof makeDeps>>;
const HOLDER = "work-laptop";

async function world(role: "reader" | "organizer" = "reader") {
  const w = await makeDeps();
  const s = await seedSession(w.db, { now: FIXED_NOW });
  const [mb] = await w.db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "reader@lichtgrat.example",
    ...(role === "reader" ? {
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,profile",
      organizedByKind: "local", organizedByName: HOLDER,
    } : {}),
  }).returning();
  return { w, token: s.token, accountId: s.accountId, mailboxId: mb!.id };
}

async function call(w: Deps, token: string, method: string, path: string, body?: unknown, status?: number) {
  const res = await H(req(method, path, { bearer: token, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), w.deps);
  if (status === undefined) expect(res.status, `${method} ${path}`).toBeLessThan(300);
  else expect(res.status, `${method} ${path}`).toBe(status);
  return res.json();
}

/** The holder turns the newest request away, as the reader's settlement records an ack. */
async function refuseNewest(w: Deps, accountId: string, reason: string): Promise<void> {
  const rows = await w.db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
  rows.sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime());
  await w.db.transaction((tx) => markRequestsSent(tx, [rows[0]!.id], FIXED_NOW));
  await w.db.transaction((tx) => markRequestsRefused(tx, [rows[0]!.id], reason, FIXED_NOW));
}

const ASKED = { state: "asked", holder: null, refusal: null };
const REFUSED = { state: "refused", holder: HOLDER, refusal: "unreadable" };

describe("the away responder on a reader", () => {
  it("the 202 says the change is waiting, and a refusal reaches the read", async () => {
    const { w, token, accountId, mailboxId } = await world();
    const put = await call(w, token, "PUT", "/away-responder", { enabled: true, body: "Back Monday." }, 202);
    expect(put.pending).toBe(true);
    expect(put.change).toEqual(ASKED);
    expect(put.enabled).toBe(false);
    expect(put.body).toBeNull();
    expect(put.travel).toEqual({
      appliedLocally: [],
      pending: [{ mailboxId, requestId: expect.any(String), holder: expect.objectContaining({ name: HOLDER }) }],
      refused: [],
    });
    await refuseNewest(w, accountId, "invalid_payload");
    expect((await call(w, token, "GET", "/away-responder")).change, "the refusal reached no surface")
      .toEqual(REFUSED);
  });

  it("a mixed account writes here and names the held mailbox in the 200 answer", async () => {
    const { w, token, accountId, mailboxId } = await world("organizer");
    const [held] = await w.db.insert(mailboxes).values({
      accountId, provider: "imap", address: "held@example.invalid",
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,profile",
      organizedByKind: "local", organizedByName: HOLDER,
    }).returning();

    const put = await call(w, token, "PUT", "/away-responder", { enabled: true, body: "Back Monday." }, 200);
    expect(put.body).toBe("Back Monday.");
    expect(put).not.toHaveProperty("pending");
    expect(put).not.toHaveProperty("change");
    expect(put.travel).toEqual({
      appliedLocally: [mailboxId],
      pending: [{ mailboxId: held!.id, requestId: expect.any(String), holder: expect.objectContaining({ name: HOLDER }) }],
      refused: [],
    });
    const { travel: _spread, ...row } = put;
    expect(await call(w, token, "GET", "/away-responder", undefined, 200)).toEqual(row);
  });

  it("CONTROL: an install that organizes answers without it", async () => {
    const { w, token } = await world("organizer");
    const put = await call(w, token, "PUT", "/away-responder", { enabled: true, body: "Back Monday." }, 200);
    expect("change" in put).toBe(false);
    expect("travel" in put).toBe(false);
    expect("pending" in put).toBe(false);
    expect(put.body).toBe("Back Monday.");
    const get = await call(w, token, "GET", "/away-responder", undefined, 200);
    expect("change" in get).toBe(false);
    expect(get).toEqual(put);
  });
});

describe("the dormancy window on a reader", () => {
  it("the echo says the window was sent, and a refusal reaches GET /consent", async () => {
    const { w, token, accountId } = await world();
    const echo = await call(w, token, "PATCH", "/consent/settings", { screeningScope: "all_time" });
    expect(echo.dormancyChange, "the dial snapped back with nothing said").toEqual(ASKED);
    await refuseNewest(w, accountId, "invalid_payload");
    expect((await call(w, token, "GET", "/consent")).dormancyChange).toEqual(REFUSED);
  });

  it("CONTROL: an install that organizes echoes only what it wrote", async () => {
    const { w, token } = await world("organizer");
    expect(await call(w, token, "PATCH", "/consent/settings", { dormancyDays: 90 })).toEqual({ dormancyDays: 90 });
    expect("dormancyChange" in (await call(w, token, "GET", "/consent"))).toBe(false);
  });
});

describe("the signature on a reader", () => {
  it("names the mailbox the change was sent for, and its refusal", async () => {
    const { w, token, accountId, mailboxId } = await world();
    const echo = await call(w, token, "PATCH", "/consent/settings", { signatures: { [mailboxId]: "Anna" } });
    expect(echo.signatureChanges, "the signature was sent and said nothing").toEqual({ [mailboxId]: ASKED });
    await refuseNewest(w, accountId, "stale");
    expect((await call(w, token, "GET", "/consent")).signatureChanges)
      .toEqual({ [mailboxId]: { state: "refused", holder: HOLDER, refusal: "other" } });
  });

  it("a mailbox this install took over no longer says an old refusal", async () => {
    const { w, token, accountId, mailboxId } = await world();
    await call(w, token, "PATCH", "/consent/settings", { signatures: { [mailboxId]: "Anna" } });
    await refuseNewest(w, accountId, "invalid_payload");
    await w.db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, mailboxId));
    expect("signatureChanges" in (await call(w, token, "GET", "/consent")),
      "a refusal about a mailbox this install now organizes").toBe(false);
  });

  it("a mailbox this install organizes says nothing, beside one it only reads", async () => {
    const { w, token, accountId, mailboxId } = await world();
    const [own] = await w.db.insert(mailboxes).values({
      accountId, provider: "imap", address: "own@lichtgrat.example",
    }).returning();
    await call(w, token, "PATCH", "/consent/settings", { signatures: { [mailboxId]: "Anna" } });
    const echo = await call(w, token, "PATCH", "/consent/settings", { signatures: { [own!.id]: "Anna" } });
    expect(echo.signatureChanges).toEqual({ [mailboxId]: ASKED });
    expect(echo.signatures[own!.id]).toBe("Anna");
  });
});
