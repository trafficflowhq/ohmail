import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  accounts, accountSettings, changeLog, flagState, folderState, mailboxes, messageBodies, messages, refreshTokens, sessions, users,
  accountPass, writePassProgress,
} from "@trafficflow/db";
import { closePooledDbs, makeOwnedDb, makePooledDb, POOLED_MAX_CONNECTIONS, SESSION_ACQUIRE_TIMEOUT_MS } from "@trafficflow/db/cloud";
import { ensureSearchExtensions, runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import { generateToken, hashToken } from "@trafficflow/services";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { PROCESS_DOOR, env, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * WHAT A REQUEST WAITS ON THE DATABASE, ON BOTH POOLS THE API RUNS ON: the self-hosted server's own
 * pool (one Postgres it owns, prepared statements) and the managed service's pooled handle (no
 * prepared statements, one flush). The journeys a person makes most — the list, a letter and its
 * body, a search page, marking a letter read — through the program's own dispatch, counted off the
 * protocol bytes. A burst is what the API wrote before it heard back: a wait. Each journey runs
 * twice first, so its statements are prepared on the connection that answers it.
 *
 * The numbers are ceilings, recorded on the handle as it was before the account's binding; a change
 * of the handle may lower a row and may raise none.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();
const KEK = "ab".repeat(32);

type Pool = "owned" | "pooled";
type Journey = "list" | "letter" | "body" | "search" | "markRead";

/**
 * Bursts each journey takes, by pool. Before the binding the self-hosted pool paid a describe before
 * every statement with a parameter (list 6, letter 4, body 6, search 6, mark-read 24); the pooled
 * handle sent each in one flush (3, 2, 3, 3, 14). Now a statement on the request's bound handle is
 * one flight on both pools (begin, the binder, the statement, commit, written before any answer),
 * a search page is one read-only flight, and a write is one flight whose body follows its start.
 * A write on the managed pool also asks whether the address is proven, in one flight that names
 * the session's account (mark-read 14 → 15): the account lock shows a user's row only to its own
 * account, and the keyed look-up learns the account only from its answer.
 */
const BURSTS: Record<Pool, Record<Journey, number>> = {
  owned: { list: 4, letter: 3, body: 4, search: 4, markRead: 14 },
  pooled: { list: 3, letter: 2, body: 3, search: 3, markRead: 15 },
};

/** Wait until the wire has been quiet for a moment: work a response leaves behind is its own. */
async function settled(): Promise<void> {
  let last = -1;
  for (;;) {
    const n = wire.read().flushes.length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe.skipIf(!PG_UP)("the waits of a request on both pools (the program, real Postgres)", () => {
  const programs = {} as Record<Pool, Program>;
  let token = "";
  let refreshToken = "";
  let accountId = "";
  const ids: string[] = [];
  let flip = false;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    const seed = makePooledDb(PG_TEST_URL);
    await ensureSearchExtensions(seed as never, { concurrently: false });
    const now = new Date();
    token = generateToken();
    const [acct] = await seed.insert(accounts).values({ name: `rt2-${randomUUID().slice(0, 8)}` }).returning();
    accountId = acct!.id;
    const [user] = await seed.insert(users).values({
      accountId, email: `rt2-${randomUUID()}@rt.example`, displayName: "RT", emailVerifiedAt: now,
    }).returning();
    await seed.insert(sessions).values({
      accountId, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
      lastTwofaAt: now,
    });
    const [session] = await seed.insert(sessions).values({
      accountId, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(generateToken()),
      accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
      lastTwofaAt: now,
    }).returning();
    refreshToken = generateToken();
    await seed.insert(refreshTokens).values({
      accountId, userId: user!.id, sessionId: session!.id, familyId: session!.familyId,
      tokenHash: hashToken(refreshToken), expiresAt: session!.refreshExpiresAt, createdAt: now,
    });
    const [mb] = await seed.insert(mailboxes).values({
      accountId, provider: "imap", address: `rt2-${randomUUID().slice(0, 8)}@rt.example`,
    }).returning();
    for (let i = 0; i < 6; i++) {
      const [m] = await seed.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `rt2:${randomUUID()}`,
        subject: `heron sighting ${i}`, fromAddress: `watcher${i}@rt.example`,
        date: new Date(now.getTime() - i * 3_600_000), unread: true, hasAttachments: false,
        nativeLocator: { folder: "INBOX", ref: `1:${i}` },
      }).returning();
      ids.push(m!.id);
      await seed.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: `a heron by the lake, note ${i}` });
      await seed.insert(folderState).values({ messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
      await upsertMessageSearch(seed as never, m!.id, {
        accountId, subject: `heron sighting ${i}`, from: { name: null, address: `watcher${i}@rt.example` }, to: [], cc: [],
        attachmentNames: [], bodyText: `a heron by the lake, note ${i}`, source: "text",
      });
    }
    await writePassProgress(seed, accountPass("search_index_backfill", accountId), { doneAt: now });

    const { logger } = recordingLogger();
    programs.owned = buildProgram(loadSettings(env({
      DATABASE_URL: PG_TEST_URL, OHMAIL_ORIGIN: "http://localhost", [KEY_RING_V1]: KEK,
    }), PROCESS_DOOR), processInput(logger));
    programs.pooled = buildProgram(loadSettings(env({
      DATABASE_URL_POOLED: PG_TEST_URL, [KEY_RING_V1]: KEK, TF_AUTH_ORIGINS: "https://ohmail.app", TF_RP_ID: "ohmail.app",
    }), functionDoor()), functionInput(logger));
  }, 120_000);

  afterAll(async () => {
    const seed = makePooledDb(PG_TEST_URL);
    if (accountId !== "") {
      await seed.execute(sql`delete from message_search where account_id = ${accountId}`);
      await seed.delete(folderState).where(inArray(folderState.messageId, ids));
      await seed.delete(flagState).where(inArray(flagState.messageId, ids));
      await seed.delete(messageBodies).where(inArray(messageBodies.messageId, ids));
      await seed.delete(messages).where(eq(messages.accountId, accountId));
      await seed.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
      await seed.delete(accountSettings).where(eq(accountSettings.accountId, accountId));
      await seed.delete(changeLog).where(eq(changeLog.accountId, accountId));
      await seed.delete(refreshTokens).where(eq(refreshTokens.accountId, accountId));
      await seed.delete(sessions).where(eq(sessions.accountId, accountId));
      await seed.delete(users).where(eq(users.accountId, accountId));
      await seed.delete(accounts).where(eq(accounts.id, accountId));
    }
    for (const p of Object.values(programs)) await p?.close();
    await closePooledDbs();
  }, 60_000);

  const origin = (pool: Pool): string => (pool === "owned" ? "http://localhost" : "https://api.ohmail.app");

  const journeys: Array<[Journey, () => { method: string; path: string; body?: () => string }]> = [
    ["list", () => ({ method: "GET", path: "/messages?view=imbox" })],
    ["letter", () => ({ method: "GET", path: `/messages/${ids[0]}` })],
    ["body", () => ({ method: "GET", path: `/messages/${ids[0]}/body` })],
    ["search", () => ({ method: "GET", path: "/search?q=heron&parts=page" })],
    // A write each time: the letter turns read and unread in turn.
    ["markRead", () => ({ method: "PATCH", path: `/messages/${ids[1]}`, body: () => JSON.stringify({ unread: (flip = !flip) }) })],
  ];

  async function counted(pool: Pool, journey: () => { method: string; path: string; body?: () => string }) {
    const send = async (): Promise<number> => {
      const j = journey();
      const res = await programs[pool].dispatch(new Request(`${origin(pool)}${j.path}`, {
        method: j.method,
        headers: { authorization: `Bearer ${token}`, ...(j.body ? { "content-type": "application/json" } : {}) },
        ...(j.body ? { body: j.body() } : {}),
      }));
      await res.text();
      return res.status;
    };
    await send();
    await send();
    await settled();
    wire.start();
    const status = await send();
    await settled();
    const r = wire.read();
    return { status, statements: r.statements, roundTrips: r.roundTrips, bursts: r.bursts, shape: r.burstShapes.join(" | ") };
  }

  it("the recorder reads two statements written before an answer as one burst, and an awaited pair as two", async () => {
    // A pool of one under its own name: two statements without a parameter go out on its one connection together.
    const url = new URL(PG_TEST_URL);
    url.searchParams.set("application_name", "tf-recorder-self-check");
    const one = makePooledDb(url.toString(), { max: 1 });
    await one.execute(sql`select 1`);
    wire.start();
    await Promise.all([one.execute(sql`select 1 as a`), one.execute(sql`select 2 as b`)]);
    expect(wire.read().bursts).toBe(1);
    wire.start();
    await one.execute(sql`select 1 as a`);
    await one.execute(sql`select 2 as b`);
    expect(wire.read().bursts).toBe(2);
  });

  it("marks a letter read while every managed read connection is occupied", async () => {
    const readPool = programs.pooled.runtime.db.request();
    const blocker = makeOwnedDb(PG_TEST_URL);
    const lock = 402815;
    const holders: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await blocker.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${lock})`);
        for (let i = 0; i < POOLED_MAX_CONNECTIONS; i++) {
          const holder = Promise.resolve(readPool.execute(sql`select pg_advisory_xact_lock_shared(${lock})`));
          void holder.catch(() => {});
          holders.push(holder);
        }
        const until = Date.now() + 5_000;
        for (;;) {
          const [count] = await tx.execute<{ waiting: number }>(sql`
            select count(*)::int as waiting from pg_locks
            where locktype = 'advisory' and objid = ${lock} and not granted`);
          if (count?.waiting === POOLED_MAX_CONNECTIONS) break;
          if (Date.now() >= until) throw new Error("the read connections never filled");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        response = programs.pooled.dispatch(new Request(`${origin("pooled")}/messages/${ids[2]}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ unread: false }),
        }));
        const limit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000); });
        const answer = await Promise.race([response, limit]);
        expect(answer?.status, "the write waited for a connection held by a read").toBe(200);
        expect(await answer!.json()).toMatchObject({ unread: false });
      });
    } finally {
      clearTimeout(timer);
      await Promise.allSettled(holders);
      await response;
      await blocker.close();
    }
  }, 20_000);

  it("rotates a session while another write holds a managed write connection", async () => {
    const program = programs.pooled;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const holder = program.runtime.db.request(true).transaction(async (tx) => {
      await tx.update(messages).set({ unread: false }).where(eq(messages.id, ids[4]!));
      started();
      await held;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refresh: Promise<Response> | undefined;
    try {
      await Promise.race([writing, holder]);
      refresh = program.dispatch(new Request(`${origin("pooled")}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      }));
      const limit = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SESSION_ACQUIRE_TIMEOUT_MS);
      });
      const answer = await Promise.race([refresh, limit]);
      expect(answer?.status, "refresh must rotate before the write releases its connection").toBe(200);
      expect(typeof (await answer!.json()).tokens?.accessToken).toBe("string");
    } finally {
      clearTimeout(timer);
      release();
      await holder;
      await refresh;
    }
  }, 20_000);

  for (const pool of ["owned", "pooled"] as const) {
    for (const [name, journey] of journeys) {
      it(`${pool} · ${name}: no more bursts than the record`, async () => {
        const r = await counted(pool, journey);
        console.log(`round-trips-both-pools ${pool} ${name}: status=${r.status} statements=${r.statements} `
          + `round_trips=${r.roundTrips} bursts=${r.bursts} shape=${r.shape}`);
        expect(r.status, r.shape).toBeLessThan(400);
        expect(r.statements, r.shape).toBeGreaterThan(0);
        expect(r.bursts, r.shape).toBeLessThanOrEqual(BURSTS[pool][name]);
      }, 60_000);
    }
  }
});
