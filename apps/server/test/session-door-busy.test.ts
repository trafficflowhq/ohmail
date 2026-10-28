import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  makeOwnedDb, makePooledDb, closePooledDbs, acquireCeilingHandle,
  WORKER_POOL_MAX, POOLED_MAX_CONNECTIONS, SESSION_ACQUIRE_TIMEOUT_MS, POOLED_ACQUIRE_TIMEOUT_MS,
} from "@trafficflow/db/cloud";
import { API_FAULT_RECORD_BUDGET_MS } from "@trafficflow/api";
import { createLogger } from "@trafficflow/core";
import { hostState, resetHostState } from "../../api-vercel/src/config.js";
import { handleApiRequest } from "../../api-vercel/src/handler.js";
import { buildDeps as buildManagedDeps, resetServices as resetManagedServices } from "../../api-vercel/src/deps.js";
import { loadHostConfig } from "../../api-vercel/src/config.js";
import { OWED_COPY_CLOUD, OWED_COPY_SELF_HOST } from "@trafficflow/services";
import { loadServerConfig } from "../src/config.js";
import { buildServerServices, oauthProviderFor } from "../src/deps.js";
import { handleServerRequest } from "../src/handler.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * A BUSY POOL ANSWERS THE SESSION DOOR IN FIVE SECONDS ON BOTH HOSTS. Every connection the host's
 * pool holds is given a statement the database never finishes; `GET /auth/session` then waits
 * behind them and must be refused at `SESSION_ACQUIRE_TIMEOUT_MS` with the busy sentence, on the
 * same pool (no connection of its own). The managed host is the control: same fixture, same answer.
 */

const KEK = "ab".repeat(32);
/* Interpolated: the push gate reads a literal `user:pw@127.0.0.1:${port}` as a credential at a real host. */
const HELD_ROLE = "held";
const SENTENCE = "the server's database connection was busy and this request could not be started; retry shortly";
/** Past the ceiling plus the fault record's budget, well short of the 15 s write ceiling. */
const ANSWER_WITHIN_MS = SESSION_ACQUIRE_TIMEOUT_MS + API_FAULT_RECORD_BUDGET_MS + 1_500;

/**
 * A Postgres that completes the startup handshake and then answers no statement: each connection's
 * first statement stays at its head, running, for ever. `fetch_types=false` keeps the driver from
 * asking for the type table first, so that first statement IS the head.
 */
async function heldPostgres() {
  const sockets = new Set<Socket>();
  const seen = { connections: 0, statements: 0 };
  const server = createServer((socket) => {
    sockets.add(socket);
    seen.connections++;
    let buf = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const header = started ? 5 : 4;
        if (buf.length < header) return;
        const len = started ? 1 + buf.readInt32BE(1) : buf.readInt32BE(0);
        if (buf.length < len) return;
        // One statement is a simple Query, or an extended batch ending in Sync.
        if (started && (buf[0] === 0x51 || buf[0] === 0x53)) seen.statements++;
        buf = buf.subarray(len);
        if (!started) {
          started = true;
          // AuthenticationOk, then ReadyForQuery (idle).
          socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `postgres://${HELD_ROLE}:unused@127.0.0.1:${port}/held?fetch_types=false`,
    seen,
    /** Resolves once `n` connections each run one statement — the pool is saturated. */
    async saturated(n: number): Promise<void> {
      const until = Date.now() + 3_000;
      while (seen.connections < n || seen.statements < n) {
        if (Date.now() > until) throw new Error(`pool not saturated: ${JSON.stringify(seen)} of ${n}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async close(): Promise<void> {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Answer = { status: number; retryAfter: string | null; setCookie: string[]; error: unknown; ms: number };

/** The door's answer, or null when none came inside {@link ANSWER_WITHIN_MS}. */
async function answerOf(call: () => Promise<Response>): Promise<Answer | null> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ANSWER_WITHIN_MS); });
  const res = await Promise.race([call(), late]).finally(() => clearTimeout(timer));
  if (!res) return null;
  const body = await res.json() as { error: unknown };
  return {
    status: res.status, retryAfter: res.headers.get("Retry-After"),
    setCookie: res.headers.getSetCookie(), error: body.error, ms: Date.now() - t0,
  };
}

const sessionRequest = (origin: string) => new Request(`${origin}/api/auth/session`, {
  headers: { authorization: "Bearer held-pool-probe" },
});

function expectBusyInFive(a: Answer | null): void {
  expect(a, "the door must answer before the write ceiling, not wait on the pool").not.toBeNull();
  expect(a!.status).toBe(503);
  expect(a!.error).toMatchObject({ code: "db_busy", message: SENTENCE });
  expect(a!.retryAfter).toBe("5");
  expect(a!.setCookie).toEqual([]);
  expect(a!.ms).toBeGreaterThanOrEqual(SESSION_ACQUIRE_TIMEOUT_MS - 50);
  expect(a!.ms).toBeLessThan(POOLED_ACQUIRE_TIMEOUT_MS);
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("the session door under a held pool", () => {
  it("the self-hosted server answers 503 db_busy at the 5 s ceiling, on its own pool", async () => {
    const pg = await heldPostgres();
    const cfg = loadServerConfig({
      OHMAIL_ORIGIN: "https://mail.example.com", DATABASE_URL: pg.url, [KEY_RING_V1]: KEK,
    } as NodeJS.ProcessEnv);
    const owned = makeOwnedDb(cfg.databaseUrl);
    // The fixture's sockets go first, so the pool ends at once instead of draining held statements.
    cleanups.push(async () => { await pg.close(); await owned.close(); });
    const rt = {
      cfg, db: owned.db, services: buildServerServices(cfg, owned.db), changeWake: null,
      oauth: oauthProviderFor(cfg, owned.db), onSetupTokenMinted: () => {},
      logger: createLogger({ service: "server", level: "error", sink: () => {} }),
      alertSinks: [], alertDb: null,
    };

    for (let i = 0; i < WORKER_POOL_MAX; i++) owned.db.execute(sql`select 1`).catch(() => {});
    await pg.saturated(WORKER_POOL_MAX);

    const a = await answerOf(() => handleServerRequest(sessionRequest("https://mail.example.com"), rt));
    expectBusyInFive(a);
    expect(pg.seen.connections, "the session handle is the process pool, not a second one").toBe(WORKER_POOL_MAX);
  }, 20_000);

  it("the managed host answers the same, from the same fixture (control)", async () => {
    const pg = await heldPostgres();
    resetManagedServices();
    resetHostState();
    const state = hostState({
      DATABASE_URL_POOLED: pg.url, [KEY_RING_V1]: KEK, TF_BUILD_VERSION: "held-pool",
    } as NodeJS.ProcessEnv);
    expect(state.ok, "the managed host must boot on the fixture").toBe(true);
    cleanups.push(async () => {
      await pg.close();
      await closePooledDbs();
      resetHostState();
      resetManagedServices();
    });

    const db = makePooledDb(pg.url);
    for (let i = 0; i < POOLED_MAX_CONNECTIONS; i++) db.execute(sql`select 1`).catch(() => {});
    await pg.saturated(POOLED_MAX_CONNECTIONS);

    const a = await answerOf(() => handleApiRequest(sessionRequest("https://api.ohmail.app")));
    expectBusyInFive(a);
    expect(pg.seen.connections).toBe(POOLED_MAX_CONNECTIONS);
  }, 20_000);

  it("the ceiling handle refuses a handle with no postgres.js pool behind it", () => {
    expect(() => acquireCeilingHandle({} as never, SESSION_ACQUIRE_TIMEOUT_MS))
      .toThrow("this handle has no postgres.js pool behind it");
    const owned = makeOwnedDb("postgres://held:unused@127.0.0.1:1/never_dialed");
    cleanups.push(() => owned.close());
    expect(acquireCeilingHandle(owned.db, SESSION_ACQUIRE_TIMEOUT_MS)).not.toBe(owned.db);
  });
});

describe("each host's send door keeps its owed Sent copies", () => {
  it("self-host keeps every letter's; the managed host only a letter's without files", () => {
    const cfg = loadServerConfig({
      OHMAIL_ORIGIN: "https://mail.example.com", DATABASE_URL: "postgres://held:unused@127.0.0.1:1/never_dialed", [KEY_RING_V1]: KEK,
    } as NodeJS.ProcessEnv);
    const owned = makeOwnedDb(cfg.databaseUrl);
    cleanups.push(() => owned.close());
    expect(buildServerServices(cfg, owned.db).sendKeepOwedCopy).toEqual(OWED_COPY_SELF_HOST);
    resetManagedServices();
    cleanups.push(() => resetManagedServices());
    const managed = buildManagedDeps(new Request("https://api.ohmail.app/drafts"), loadHostConfig({
      DATABASE_URL_POOLED: "postgres://held:unused@127.0.0.1:1/never_dialed", [KEY_RING_V1]: KEK,
    } as NodeJS.ProcessEnv));
    expect(managed.services?.sendKeepOwedCopy).toEqual(OWED_COPY_CLOUD);
    expect(OWED_COPY_CLOUD.files, "Cloud never writes attachment bytes down").toBe(false);
  });
});
