import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { folderState, mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/services";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

// The same KEK the test helper injects into the write-capable MailboxService, so
// the test can independently decrypt a raw `secret_enc` and prove the round-trip.
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);

const body = (o: unknown): string => JSON.stringify(o);

const IMAP = { host: "imap.example", port: 993, secure: true, user: "mila", pass: "s3cr3t-imap-password-password" };
const SMTP = { host: "smtp.example", port: 465, secure: true, user: "mila", pass: "s3cr3t-smtp-password-password" };

describe("mailbox mutations (create / update / delete)", () => {
  it("POST /mailboxes → 201; creds encrypted-at-rest + round-trip; no secret in the DTO", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const res = await H(req("POST", "/mailboxes", {
      bearer: s.token,
      headers: { "content-type": "application/json" },
      body: body({ provider: "imap", address: "mila@lichtgrat.example", displayName: "Personal", imap: IMAP, smtp: SMTP }),
    }), deps);

    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto.address).toBe("mila@lichtgrat.example");
    expect(dto.displayName).toBe("Personal");
    expect(dto.status).toBe("connected");
    expect(dto.authKind).toBe("password");
    // No credential leakage of any kind in the response body.
    const flat = JSON.stringify(dto);
    expect(flat).not.toContain("s3cr3t");
    expect(dto.imap).toBeUndefined();
    expect(dto.smtp).toBeUndefined();
    expect(dto.credentials).toBeUndefined();
    expect(dto.secretEnc).toBeUndefined();

    // Both transports persisted; the raw secret is NOT the plaintext but decrypts back to it.
    const rows = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, dto.id));
    expect(rows).toHaveLength(2);
    const imap = rows.find((r) => r.transport === "imap")!;
    expect(imap.secretEnc).not.toContain("s3cr3t-imap-password-password");
    expect(await KP.decrypt(imap.secretEnc, imap.keyVersion)).toBe("s3cr3t-imap-password-password");
    expect(imap.meta).toEqual({ host: "imap.example", port: 993, secure: true, user: "mila" });
    const smtp = rows.find((r) => r.transport === "smtp")!;
    expect(await KP.decrypt(smtp.secretEnc, smtp.keyVersion)).toBe("s3cr3t-smtp-password-password");
  });

  it("POST /mailboxes without an smtp block creates only the imap credential row", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("POST", "/mailboxes", {
      bearer: s.token,
      headers: { "content-type": "application/json" },
      body: body({ provider: "imap", address: "solo@lichtgrat.example", imap: IMAP }),
    }), deps);
    expect(res.status).toBe(201);
    const rows = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, (await res.json()).id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transport).toBe("imap");
  });

  it("PATCH /mailboxes/:id changes displayName and re-encrypts a new imap password", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const created = await H(req("POST", "/mailboxes", {
      bearer: s.token, headers: { "content-type": "application/json" },
      body: body({ provider: "imap", address: "mila@lichtgrat.example", imap: IMAP }),
    }), deps);
    const id = (await created.json()).id;
    const before = (await db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap"))))[0]!;

    const res = await H(req("PATCH", `/mailboxes/${id}`, {
      bearer: s.token, headers: { "content-type": "application/json" },
      body: body({ displayName: "Renamed", imap: { pass: "rotated-pass-password-password" } }),
    }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).displayName).toBe("Renamed");

    const after = (await db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap"))))[0]!;
    expect(after.secretEnc).not.toBe(before.secretEnc);           // re-encrypted
    expect(await KP.decrypt(after.secretEnc, after.keyVersion)).toBe("rotated-pass-password-password");
  });

  it("PATCH a cross-account mailbox → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok", lastTwofaAt: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok", lastTwofaAt: FIXED_NOW });
    const id = await seedMailbox(db, { accountId: owner.accountId });
    const res = await H(req("PATCH", `/mailboxes/${id}`, {
      bearer: other.token, headers: { "content-type": "application/json" }, body: body({ displayName: "x" }),
    }), deps);
    expect(res.status).toBe(404);
  });

  it("DELETE /mailboxes/:id → 204, status='disabled', creds gone, mailbox row kept (FK-safe)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const created = await H(req("POST", "/mailboxes", {
      bearer: s.token, headers: { "content-type": "application/json" },
      body: body({ provider: "imap", address: "mila@lichtgrat.example", imap: IMAP, smtp: SMTP }),
    }), deps);
    const id = (await created.json()).id;

    const res = await H(req("DELETE", `/mailboxes/${id}`, { bearer: s.token }), deps);
    expect(res.status).toBe(204);

    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
    expect(mb).toBeDefined();                       // NOT hard-deleted (messages FK)
    expect(mb!.status).toBe("disabled");            // soft-disabled
    const creds = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
    expect(creds).toHaveLength(0);                  // stops syncing
  });

  it("DELETE a cross-account mailbox → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok", lastTwofaAt: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok", lastTwofaAt: FIXED_NOW });
    const id = await seedMailbox(db, { accountId: owner.accountId });
    expect((await H(req("DELETE", `/mailboxes/${id}`, { bearer: other.token }), deps)).status).toBe(404);
  });
});

describe("mailbox mutations — step-up enforcement", () => {
  const create = (token: string) => req("POST", "/mailboxes", {
    bearer: token, headers: { "content-type": "application/json" },
    body: body({ provider: "imap", address: "mila@lichtgrat.example", imap: IMAP }),
  });

  it("a STALE (null lastTwofaAt) caller → 403 step_up_required on POST/PATCH/DELETE", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: null });
    const id = await seedMailbox(db, { accountId: s.accountId });

    expect((await H(create(s.token), deps)).status).toBe(403);
    expect((await H(req("PATCH", `/mailboxes/${id}`, {
      bearer: s.token, headers: { "content-type": "application/json" }, body: body({ displayName: "x" }),
    }), deps)).status).toBe(403);
    expect((await H(req("DELETE", `/mailboxes/${id}`, { bearer: s.token }), deps)).status).toBe(403);
  });

  it("a FRESH (recent lastTwofaAt) caller succeeds", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    expect((await H(create(s.token), deps)).status).toBe(201);
  });
});

/**
 * The plan limit at the HTTP layer. The refusal is a `ServiceError` subclass, so
 * `withErrorEnvelope` already maps it to `{ error: { code, message, details } }` — **no route
 * change was needed**, and that is worth asserting rather than assuming: a refusal that reached
 * the client as a 500 would be indistinguishable from a bug and would teach the UI nothing.
 */
describe("mailbox mutations — the plan limit, as the client sees it", () => {
  const create = (token: string, address: string) => req("POST", "/mailboxes", {
    bearer: token, headers: { "content-type": "application/json" },
    body: body({ provider: "imap", address, imap: IMAP }),
  });

  it("a metered host that permits NOTHING → 402, with the numbers the UI needs", async () => {
    const { db, deps, access } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    // `ok: true` with `canAddMailbox: false` — the port ADMITS the account and still forbids
    // another mailbox, which is the one refusal an upgrade would not fix and the reason
    // `not_permitted` exists beside the port's two words.
    access.metered({ mailboxes: 0, canAddMailbox: false });

    const res = await H(create(s.token, "first@lichtgrat.example"), deps);
    expect(res.status).toBe(402);
    const { error } = await res.json();
    expect(error.code).toBe("mailbox_not_permitted");
    expect(error.details).toMatchObject({
      reason: "not_permitted", accessReason: null, mailboxLimit: 0, mailboxCount: 0,
    });
    expect(await db.select().from(mailboxes)).toHaveLength(0);
  });

  it("an UNMETERED host admits — the default, and the whole of a self-host install", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    expect((await H(create(s.token, "selfhost@lichtgrat.example"), deps)).status).toBe(201);
    expect(await db.select().from(mailboxes)).toHaveLength(1);
  });

  it("solo: creates succeed up to the plan card's mailbox count, the next one is 409", async () => {
    // A LITERAL now, and not the plan card's number: the limit comes from whoever operates the
    // service, and this case's subject is that the gate counts up to whatever it was handed and
    // refuses the next one.
    const limit = 5;
    const { db, deps, access } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    access.metered({ mailboxes: limit });

    for (let i = 0; i < limit; i++) {
      expect((await H(create(s.token, `box${i}@lichtgrat.example`), deps)).status, `create #${i + 1}`).toBe(201);
    }

    const res = await H(create(s.token, "over@lichtgrat.example"), deps);
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe("mailbox_limit_reached");
    expect(error.details).toMatchObject({
      reason: "at_limit", mailboxLimit: limit, mailboxCount: limit,
    });
    expect(await db.select().from(mailboxes)).toHaveLength(limit);
  });

  it("a REFUSED account → 402 payment_required, distinct from being at the limit", async () => {
    const { db, deps, access } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    // The port's own word, and the one the shape of this case turns on: a refusal is not the
    // same answer as a full account, and 402 is not 409.
    access.refuse("payment_required");

    const res = await H(create(s.token, "dunned@lichtgrat.example"), deps);
    expect(res.status).toBe(402);
    const { error } = await res.json();
    expect(error.code).toBe("payment_required");
    // The distinction is the whole point of the taxonomy: an upgrade would not fix this one.
    expect(error.details).toMatchObject({ reason: "payment_required", accessReason: "payment_required" });
  });
});

describe("the waiting filings of a mailbox — read, Try again now, Leave them where they are", () => {
  const json = { "content-type": "application/json" };
  async function world(emailVerified = true) {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, emailVerified });
    const id = await seedMailbox(db, { accountId: s.accountId });
    const [m] = await db.insert(messages).values({
      accountId: s.accountId, mailboxId: id, dedupKey: "mid:<waits@example.test>", bodyHash: "waits",
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Receipts", observedFolder: "ohmail/Reads", lastSetBy: "us",
      updatedAt: new Date(FIXED_NOW.getTime() - 3_600_000), attempts: 1, lastErrorClass: "refused",
    });
    return { db, deps, s, id, messageId: m!.id };
  }

  it("GET answers counts and names, the presses answer 202 and 200 with the seq", async () => {
    const { deps, s, id } = await world();
    const read = await H(req("GET", `/mailboxes/${id}/filings`, { bearer: s.token }), deps);
    expect(read.status).toBe(200);
    const dto = await read.json();
    expect(dto.groups).toHaveLength(1);
    expect(dto.groups[0]).toMatchObject({ folder: "ohmail/Receipts", count: 1, at: "ohmail/Reads", reasons: [{ reason: "refused", count: 1 }] });
    const retry = await H(req("POST", `/mailboxes/${id}/filings/retry`, { bearer: s.token, headers: json, body: body({ folder: "ohmail/Receipts" }) }), deps);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ reset: 1, skipped: 0 });
    const leave = await H(req("POST", `/mailboxes/${id}/filings/leave`, {
      bearer: s.token, headers: json, body: body({ folder: "ohmail/Receipts", through: dto.groups[0].through }),
    }), deps);
    expect(leave.status).toBe(200);
    expect(await leave.json()).toEqual({ settled: 1, remaining: 0 });
    expect(Number(leave.headers.get("X-Sync-Seq"))).toBeGreaterThan(0);
  });

  it("400 on a bad body, 404 across accounts", async () => {
    const { db, deps, s, id } = await world();
    const bad = await H(req("POST", `/mailboxes/${id}/filings/leave`, { bearer: s.token, headers: json, body: body({ folder: "ohmail/Receipts" }) }), deps);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("validation_failed");
    expect((await H(req("POST", `/mailboxes/${id}/filings/retry`, { bearer: s.token, headers: json, body: body({ folder: 3 }) }), deps)).status).toBe(400);
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-filings" });
    expect((await H(req("GET", `/mailboxes/${id}/filings`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("POST", `/mailboxes/${id}/filings/retry`, { bearer: other.token, headers: json, body: body({ folder: "ohmail/Receipts" }) }), deps)).status).toBe(404);
  });

  it("an unverified account may read them and may not press", async () => {
    const { db, deps, s, id, messageId } = await world(false);
    expect((await H(req("GET", `/mailboxes/${id}/filings`, { bearer: s.token }), deps)).status).toBe(200);
    expect((await H(req("POST", `/mailboxes/${id}/filings/retry`, { bearer: s.token, headers: json, body: body({ folder: "ohmail/Receipts" }) }), deps)).status).toBe(403);
    expect((await H(req("POST", `/mailboxes/${id}/filings/leave`, {
      bearer: s.token, headers: json, body: body({ folder: "ohmail/Receipts", through: FIXED_NOW.toISOString() }),
    }), deps)).status).toBe(403);
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(r!.attempts).toBe(1);
  });
});
