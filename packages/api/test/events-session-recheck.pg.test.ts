import { perRequest } from "./helpers.js";
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { accounts, sessions, users } from "@trafficflow/db";
import { authEvents, closePooledDbs, makeOwnedDb, makePooledDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { generateToken, hashToken, makeAuthService, makeTestAuthDeps, type Db } from "@trafficflow/services";

/**
 * THE SESSION RECHECK ON THE PRODUCTION DRIVER. The route decodes its `exists` strictly — anything
 * but a boolean `true` ends the stream — and PGlite cannot say what postgres.js hands back. On both
 * handle shapes (the managed host's pooled `prepare: false` one and the self-hosted server's own), a
 * live session's stream stays open and the one signed out mid-stream ends within two polls. Scoped
 * to the accounts this file creates; removed afterwards.
 */

const PG_UP = await realPgAvailable();
const app = createApp(apiRoutes);
const POLL_MS = 200;
const SSE: SseConfig = { heartbeatMs: 3_600_000, pollMs: POLL_MS, lifetimeMs: 60_000 };
const owned = PG_UP ? makeOwnedDb(PG_TEST_URL) : null;
const made: string[] = [];

afterAll(async () => {
  if (!owned) return;
  if (made.length > 0) {
    // Child rows first: `users.account_id` takes no cascade, and the hosted logout writes an audit row.
    await owned.db.delete(authEvents).where(inArray(authEvents.accountId, made));
    await owned.db.delete(sessions).where(inArray(sessions.accountId, made));
    await owned.db.delete(users).where(inArray(users.accountId, made));
    await owned.db.delete(accounts).where(inArray(accounts.id, made));
  }
  await owned.close();
  await closePooledDbs();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function depsOn(db: Db): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  // A request's container on `db`'s pool, its handle as a host mints a request's.
  return perRequest({
    ...({
      now: () => new Date(), requestId: `pg-${randomUUID()}`, session: null, idempotency: null,
      authConfig: authDeps.config, keyProvider: authDeps.keyProvider,
      services: { auth: makeAuthService(authDeps) },
    } as unknown as Omit<ApiDeps, "db">),
    db,
  });
}

/** One verified user with two live sessions; returns their bearer tokens. */
async function seedPair(db: Db): Promise<{ subject: string; twin: string }> {
  const [a] = await db.insert(accounts).values({ name: "events-recheck" }).returning();
  made.push(a!.id);
  const [u] = await db.insert(users).values({
    accountId: a!.id, email: `recheck-${randomUUID().slice(0, 8)}@events.test`, emailVerifiedAt: new Date(),
  }).returning();
  const token = async (): Promise<string> => {
    const t = generateToken();
    await db.insert(sessions).values({
      accountId: a!.id, userId: u!.id, familyId: randomUUID(), accessTokenHash: hashToken(t),
      accessExpiresAt: new Date(Date.now() + 60 * 60_000), refreshExpiresAt: new Date(Date.now() + 2 * 60 * 60_000),
    });
    return t;
  };
  return { subject: await token(), twin: await token() };
}

/** Read a stream into a string until it ends or `ms` passes; report whether it ended. */
async function readFor(res: Response, ms: number): Promise<{ ended: boolean; text: string }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let ended = false;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { ended = true; return; }
      text += dec.decode(value, { stream: true });
    }
  })().catch(() => undefined);
  await Promise.race([pump, sleep(ms)]);
  // Read at the deadline: the cancel below ends the pump too, and that end is ours, not the server's.
  const endedInTime = ended;
  if (!endedInTime) await reader.cancel().catch(() => undefined);
  await pump;
  return { ended: endedInTime, text };
}

describe.skipIf(!PG_UP)("GET /events over real Postgres: the session recheck", () => {
  for (const shape of ["pooled (managed host)", "owned (self-hosted server)"] as const) {
    it(`${shape}: a signed-out session's stream ends within two polls; a live one stays open`, async () => {
      const db = (shape.startsWith("pooled") ? makePooledDb(PG_TEST_URL, { max: 4 }) : owned!.db) as unknown as Db;
      const deps = depsOn(db);
      const { subject, twin } = await seedPair(owned!.db as unknown as Db);
      const ended = await app.handle(new Request("http://localhost/events", { headers: { authorization: `Bearer ${subject}` } }), { ...deps, sse: SSE });
      const live = await app.handle(new Request("http://localhost/events", { headers: { authorization: `Bearer ${twin}` } }), { ...deps, sse: SSE });
      expect([ended.status, live.status]).toEqual([200, 200]);
      await sleep(POLL_MS + 50);
      const out = await app.handle(new Request("http://localhost/auth/logout", {
        method: "POST", headers: { authorization: `Bearer ${subject}`, "content-type": "application/json" }, body: "{}",
      }), { ...deps });
      expect(out.status).toBe(204);
      const [a, b] = await Promise.all([readFor(ended, 2 * POLL_MS), readFor(live, 4 * POLL_MS)]);
      expect(a.ended, "the signed-out session's stream outlived it by two poll intervals").toBe(true);
      expect(b.ended, "a live session's stream was closed: the driver's answer did not decode as true").toBe(false);
      expect(b.text.startsWith("retry: 3000\n\n")).toBe(true);
    }, 30_000);
  }
});
