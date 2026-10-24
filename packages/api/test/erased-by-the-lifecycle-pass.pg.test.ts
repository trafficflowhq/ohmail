import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, refreshTokens, sessions, users } from "@trafficflow/db";
import { accountLifecycleNotices, makeOwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { AccessLifecycle } from "@trafficflow/db";
import { createApp, apiRoutes, ACCOUNT_HEADER, ERASED_ANSWER_HEADER, type ApiDeps } from "@trafficflow/api";
import {
  eraseOneDueAccount, generateToken, hashToken, makeAuthService, makeTestAuthDeps, runAccountLifecyclePass, type Db,
} from "@trafficflow/services";

/**
 * THE LIFECYCLE'S ERASURE IS HEARD LIKE `DELETE /account`, ON REAL POSTGRES. Nobody is present
 * when the nightly pass erases an account past its retention, so every device learns it from the
 * session door: the pass runs `deleteAccount`, which keeps the live token hashes before it deletes
 * the sessions, and a declared read or refresh then answers `410 account_erased` naming the
 * account. Scoped to the account this file creates; removed afterwards.
 */

const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const app = createApp(apiRoutes);
const owned = PG_UP ? makeOwnedDb(PG_TEST_URL) : null;
const made: string[] = [];

afterAll(async () => {
  if (!owned) return;
  // `accounts` survives an erasure; its own row takes the kept hashes with it (cascade).
  for (const id of made) await owned.db.delete(accounts).where(eq(accounts.id, id));
  await owned.close();
});

function depsOn(db: Db): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return {
    db, now: () => NOW, requestId: `pg-${randomUUID()}`, session: null,
    authConfig: authDeps.config, keyProvider: authDeps.keyProvider,
    services: { auth: makeAuthService(authDeps) },
  } as unknown as ApiDeps;
}

const DECLARED = { [ERASED_ANSWER_HEADER]: "account_erased" };

async function codeOf(res: Response): Promise<string | null> {
  try { return ((await res.clone().json()) as { error?: { code?: string } }).error?.code ?? null; } catch { return null; }
}

/** An account past its retention, with a paired device's live access and refresh token. */
async function seedDevice(db: Db): Promise<{ accountId: string; access: string; refresh: string }> {
  const [a] = await db.insert(accounts).values({ name: "erased-by-the-pass" }).returning();
  made.push(a!.id);
  const [u] = await db.insert(users).values({ accountId: a!.id, email: `pass-${randomUUID().slice(0, 8)}@erase.test` }).returning();
  const access = generateToken();
  const refresh = generateToken();
  const familyId = randomUUID();
  const [s] = await db.insert(sessions).values({
    accountId: a!.id, userId: u!.id, familyId, accessTokenHash: hashToken(access),
    accessExpiresAt: new Date(NOW.getTime() + 10 * 60_000), refreshExpiresAt: new Date(NOW.getTime() + 30 * DAY),
  }).returning();
  await db.insert(refreshTokens).values({
    accountId: a!.id, userId: u!.id, sessionId: s!.id, familyId,
    tokenHash: hashToken(refresh), expiresAt: new Date(NOW.getTime() + 30 * DAY),
  });
  return { accountId: a!.id, access, refresh };
}

function pastRetention(): AccessLifecycle {
  return {
    state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
    closedAt: new Date(NOW.getTime() - 32 * DAY).toISOString(),
    erasureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    erasedAt: null, formerlyPaid: false,
    lifecycleEpoch: new Date(NOW.getTime() - 60 * DAY).toISOString(),
  };
}

describe.skipIf(!PG_UP)("an account erased by the lifecycle pass, read from its paired device", () => {
  it("the declared read and the refresh answer 410 account_erased naming the account", async () => {
    const db = owned!.db as unknown as Db;
    const device = await seedDevice(db);
    const lifecycle = pastRetention();
    // The week's warning went out on time; the erasure door holds an account without one.
    const warnedAt = new Date(Date.parse(lifecycle.erasureAt!) - 7 * DAY);
    await db.insert(accountLifecycleNotices).values({
      accountId: device.accountId, kind: "erasure_week", anchor: new Date(lifecycle.erasureAt!),
      sentAt: warnedAt, deliveredAt: warnedAt,
    });
    const deps = {
      port: {
        accessOrFault: async (id: string) => (id === device.accountId
          ? { ok: false, reason: "payment_required", lifecycle }
          : { ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true } }),
        releaseAccount: async () => "cancelled",
      },
      mail: null,
      now: () => NOW,
    };
    // The sweep names the account due; the erase door, one account per call, erases it.
    const result = await runAccountLifecyclePass(db as never, deps as never);
    expect(result.erasureDue, "the pass did not find the account due").toContain(device.accountId);
    expect(await eraseOneDueAccount(db as never, deps as never, device.accountId)).toBe("erased");
    const [row] = await db.select().from(accounts).where(eq(accounts.id, device.accountId));
    expect(row!.erasedAt).not.toBeNull();

    const read = await app.handle(new Request("http://localhost/sync?limit=50", {
      headers: { authorization: `Bearer ${device.access}`, ...DECLARED },
    }), depsOn(db));
    expect(`${read.status} ${await codeOf(read)} ${read.headers.get(ACCOUNT_HEADER)}`)
      .toBe(`410 account_erased ${device.accountId}`);

    const refresh = await app.handle(new Request("http://localhost/auth/refresh", {
      method: "POST", headers: { "content-type": "application/json", ...DECLARED },
      body: JSON.stringify({ refreshToken: device.refresh }),
    }), depsOn(db));
    expect(`${refresh.status} ${await codeOf(refresh)} ${refresh.headers.get(ACCOUNT_HEADER)}`)
      .toBe(`410 account_erased ${device.accountId}`);

    // CONTROL: undeclared, the same device keeps the 401 it always had and is named nothing.
    const undeclared = await app.handle(new Request("http://localhost/sync?limit=50", {
      headers: { authorization: `Bearer ${device.access}` },
    }), depsOn(db));
    expect(`${undeclared.status} ${undeclared.headers.get(ACCOUNT_HEADER)}`).toBe("401 null");
  });
});
