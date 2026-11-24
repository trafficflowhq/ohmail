import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  accounts, accountSettings, awayReplies, awayResponders, changeLog, drafts, flagState, folderState, mailboxCredentials, mailboxes,
  messageBodies, messages, outboundSends, outboundSentCopies, sessions, users, accountPass, writePassProgress,
} from "@trafficflow/db";
import { closePooledDbs, makePooledDb, staffRoleGrants, staffSessions, staffUsers } from "@trafficflow/db/cloud";
import { ensureSearchExtensions, runMigrations } from "@trafficflow/db/admin";
import {
  PG_TEST_URL, carries, flightsOf, keyEquals, realPgAvailable, recordPgWire, type PgWireFlight,
} from "@trafficflow/db/testing";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import { ALLOW_ANY_PROBE_HOST, createApp, apiRoutes, UNSUB_DRAIN_CRON_PATH } from "@trafficflow/api";
import { ScheduleService, dbFor, generateToken, hashToken } from "@trafficflow/services";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { PROCESS_DOOR, env, fixture, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { doorOf, namedBy, refusedOf, unmetOf } from "../../../test/support/wire-doors.js";

/**
 * THE BINDING AT EVERY DOOR OF THE API, READ OFF THE WIRE.
 *
 * Two people, A and B, and the program's own dispatch: every statement a request sends rides a
 * transaction whose first statement names the account of the request's own session, and no other.
 * The session's look-up names no account and carries the token's digest; a staff route names none
 * and carries the door's word; a clock's route walks on a handle that names none and each row it
 * works on rides that row's account. A statement outside any transaction names no table an account
 * owns. Read through `flightsOf` from the bytes the program's pool wrote.
 *
 * On both pools the API runs on: the self-hosted server's own pool (prepared statements), and the
 * managed service's pooled handle through a transaction pooler that keeps one backend
 * (`TF_POOLER_ADDRESS`, `host:port`, in front of the test database; `TF_REQUIRE_POOLER=1` makes its
 * absence a failure). Without a pooler the managed program dials the database itself and says so.
 *
 * WHAT ONE BACKEND SEES IN TURN. A and B take turns on one backend, through every way a request
 * ends: answered, refused inside its transaction, cancelled from outside, timed out on a lock, left
 * by its client, its connection cut. After each, a statement outside any transaction on that same
 * backend reads both of the binding's settings empty, and the next request names its own account.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

const POOLER = (process.env.TF_POOLER_ADDRESS ?? "").trim();
const POOLER_PORT = Number(POOLER.slice(POOLER.lastIndexOf(":") + 1));
const POOLER_UP = POOLER !== "" && await new Promise<boolean>((resolve) => {
  const s = net.connect({ host: POOLER.slice(0, POOLER.lastIndexOf(":")), port: POOLER_PORT });
  const done = (up: boolean): void => { s.destroy(); resolve(up); };
  s.setTimeout(2_000, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});
if (process.env.TF_REQUIRE_POOLER === "1" && !POOLER_UP) {
  throw new Error("TF_REQUIRE_POOLER=1 but no transaction pooler answers at TF_POOLER_ADDRESS");
}
if (PG_UP && !POOLER_UP) {
  process.stderr.write("binding-on-the-wire: no transaction pooler at TF_POOLER_ADDRESS; the managed program dials the database itself\n");
}

/**
 * The connection that last wrote to the pooler: what the cut-connection case ends. While a request
 * waits on a held row nothing else writes there, so it is that request's own connection.
 */
let lastToPooler: net.Socket | null = null;
if (POOLER_UP) {
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function (this: net.Socket, ...args: unknown[]): boolean {
    if (this.remotePort === POOLER_PORT) lastToPooler = this;
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as typeof write;
}

const KEK = "ab".repeat(32);
/** The clocks' and the console's shared words: stand-ins, assembled here. */
const CLOCK_WORD = fixture("clock", "a".repeat(30));
const CONSOLE_WORD = fixture("console", "b".repeat(30));
/** The Microsoft registration both programs refresh a mailbox's token with: stand-ins, assembled here. */
const MS_REGISTRATION = {
  MS_OAUTH_CLIENT_ID: fixture("wire", "registration"), MS_OAUTH_CLIENT_SECRET: fixture("registration", "c".repeat(30)),
  MS_OAUTH_TENANT: "common",
};

/** The connection name of the self-hosted program's own pool: its backends are counted by it. */
const SERVER_POOL = `wire-server-${randomUUID().slice(0, 8)}`;

const MINUTE = 60_000;
const NOTE = "provider outage cleared, release the backoff";

/** The test database under a connection name of this file's, at `at` when given (the pooler). */
const named = (name: string, at?: string): string => {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", name);
  if (at !== undefined) u.host = at;
  return u.toString();
};

/** Wait until the wire has been quiet for a moment: a flight's close is written after its answer. */
async function settled(): Promise<void> {
  let last = -1;
  for (;;) {
    const n = wire.read().flushes.length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 40));
  }
}

const rowsOf = <T>(answer: unknown): T[] => answer as unknown as T[];
type Handle = ReturnType<typeof makePooledDb>;

/**
 * Microsoft's token endpoint, stood in for: every refresh is answered with an access token and a
 * NEW refresh token, as Microsoft answers when it rotates one. `handedBack` keeps each new one.
 * Every other address is fetched as it would be.
 */
const handedBack: string[] = [];
const fetched = globalThis.fetch;
const tokenEndpoint: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).host !== "login.microsoftonline.com") return fetched(input, init);
  const next = `handed-back-${randomUUID()}`;
  handedBack.push(next);
  return new Response(JSON.stringify({ token_type: "Bearer", access_token: `access-${randomUUID()}`, refresh_token: next, expires_in: 3600 }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

/** A mail server that hangs up on whoever dials it: a dial here asks for its token, and then fails at once. */
const hangsUp = net.createServer((socket) => { socket.destroy(); });

interface Person { accountId: string; token: string; digest: string; mailboxId: string; letters: string[] }

/** One pool the API runs on, as this file drives it. */
interface Arm {
  readonly name: string;
  /** The program A's requests go through, and B's: one program, or two clients of one pooler. */
  readonly forA: Program;
  readonly forB: Program;
  /** The pool's own handle of A's program: a statement outside any transaction on its backend. */
  readonly own: Handle;
  /** Who reads the backend between two requests: the pool's own handle, or the pooler's second client. */
  readonly between: Handle;
  readonly origin: string;
  /** The program has a staff door. */
  readonly staffed: boolean;
  /** The pool reaches the database through the pooler: one backend for every client. */
  readonly pooled: boolean;
}

describe.skipIf(!PG_UP)("the binding at every door of the API, on the wire (the program, real Postgres)", () => {
  let seed: Handle;
  let holder: Handle;
  const people: Person[] = [];
  const arms: Arm[] = [];
  const programs: Program[] = [];
  let staffToken = "";
  /** The owed rows this file's journeys met ({@link unmetOf}). */
  const met = new Set<string>();
  /** The arms whose journeys ran to their end. */
  const walked = new Set<string>();
  const schedules = new ScheduleService();

  const A = (): Person => people[0]!;
  const B = (): Person => people[1]!;

  beforeAll(async () => {
    // Before a program is built: its token source keeps the `fetch` it was made with.
    vi.stubGlobal("fetch", tokenEndpoint);
    await new Promise<void>((resolve) => { hangsUp.listen(0, "127.0.0.1", resolve); });
    await runMigrations(PG_TEST_URL);
    seed = makePooledDb(named("wire-seed"));
    holder = makePooledDb(named("wire-holder"), { max: 1 });
    await ensureSearchExtensions(seed as never, { concurrently: false });
    const now = new Date();
    for (let p = 0; p < 2; p++) {
      const token = generateToken();
      const [acct] = await seed.insert(accounts).values({ name: `wire-${randomUUID().slice(0, 8)}` }).returning();
      const accountId = acct!.id;
      const [user] = await seed.insert(users).values({
        accountId, email: `wire-${randomUUID()}@wire.example`, displayName: "Wire", emailVerifiedAt: now,
      }).returning();
      await seed.insert(sessions).values({
        accountId, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(token),
        accessExpiresAt: new Date(now.getTime() + 60 * MINUTE), refreshExpiresAt: new Date(now.getTime() + 120 * MINUTE),
        lastTwofaAt: now,
      });
      // Connected and organized here, with no credential stored: a pass's dial reads for one and finds none.
      const [mb] = await seed.insert(mailboxes).values({
        accountId, provider: "imap", address: `wire-${randomUUID().slice(0, 8)}@wire.example`,
        organizerRole: "organizer", status: "connected",
      }).returning();
      // Away, with a reply owed to whoever writes: the away pass has a letter of each to answer.
      await seed.insert(awayResponders).values({
        accountId, enabled: true, body: "Back Monday.", audience: "screened_in", throttle: "always",
        enabledAt: new Date(now.getTime() - 60 * MINUTE), updatedAt: now,
      });
      const letters: string[] = [];
      for (let i = 0; i < 3; i++) {
        const [m] = await seed.insert(messages).values({
          accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `wire:${randomUUID()}`,
          subject: `heron sighting ${i}`, fromAddress: `watcher${i}@wire.example`, messageIdHeader: `<${randomUUID()}@wire.example>`,
          date: new Date(now.getTime() - i * 60 * MINUTE), unread: true, hasAttachments: false,
          nativeLocator: { folder: "INBOX", ref: `1:${i}` },
        }).returning();
        letters.push(m!.id);
        await seed.insert(messageBodies).values({ messageId: m!.id, accountId, text: `a heron by the lake, note ${i}`, headers: {} });
        await seed.insert(folderState).values({
          messageId: m!.id, accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
        });
        await upsertMessageSearch(seed as never, m!.id, {
          accountId, subject: `heron sighting ${i}`, from: { name: null, address: `watcher${i}@wire.example` }, to: [], cc: [],
          attachmentNames: [], bodyText: `a heron by the lake, note ${i}`, source: "text",
        });
      }
      await writePassProgress(seed, accountPass("search_index_backfill", accountId), { doneAt: now });
      people.push({ accountId, token, digest: hashToken(token), mailboxId: mb!.id, letters });
    }
    const [staff] = await seed.insert(staffUsers)
      .values({ email: `support-${randomUUID()}@wire.example`, passwordHash: "unused" }).returning();
    await seed.insert(staffRoleGrants).values({ staffUserId: staff!.id, role: "owner" });
    staffToken = generateToken(32);
    await seed.insert(staffSessions).values({
      staffUserId: staff!.id, tokenHash: hashToken(staffToken), createdAt: now, lastTwofaAt: now,
      expiresAt: new Date(now.getTime() + 60 * MINUTE),
    });

    const { logger } = recordingLogger();
    // The self-hosted server: one pool it owns, prepared statements.
    const server = buildProgram(loadSettings(env({
      DATABASE_URL: named(SERVER_POOL), OHMAIL_ORIGIN: "http://localhost", [KEY_RING_V1]: KEK, TF_ALERT_SECRET: CLOCK_WORD,
      // Its operator lets it dial a mail server on its own network: this file's, which hangs up.
      TF_PROBE_ALLOW_PRIVATE: "1", ...MS_REGISTRATION,
    }), PROCESS_DOOR), processInput(logger));
    programs.push(server);
    const own = server.runtime.db.request() as unknown as Handle;
    arms.push({
      name: "the server's own pool", forA: server, forB: server, own, between: own,
      origin: "http://localhost", staffed: false, pooled: false,
    });

    // The managed service: the pooled handle, a pool of one. Through the pooler a second program is
    // the pooler's second client, and both ride its one backend.
    const managed = (name: string): { program: Program; handle: Handle } => {
      const url = named(name, POOLER_UP ? POOLER : undefined);
      // The pool is built with the first handle asked of its address: one connection.
      const handle = makePooledDb(url, { max: 1 });
      const program = buildProgram(loadSettings(env({
        DATABASE_URL_POOLED: url, [KEY_RING_V1]: KEK, TF_AUTH_ORIGINS: "https://ohmail.app", TF_RP_ID: "ohmail.app",
        TF_ALERT_SECRET: CLOCK_WORD, TF_ADMIN_SECRET: CONSOLE_WORD, ...MS_REGISTRATION,
        // The staff role's own address: named, and dialed by no route this file drives.
        DATABASE_URL_ADMIN: named("wire-staff-role"),
      }), functionDoor()), functionInput(logger));
      programs.push(program);
      return { program, handle };
    };
    const first = managed("wire-managed-1");
    if (POOLER_UP) {
      const second = managed("wire-managed-2");
      arms.push({
        name: "the pooled handle, through the pooler", forA: first.program, forB: second.program, own: first.handle,
        between: second.handle, origin: "https://api.ohmail.app", staffed: true, pooled: true,
      });
    } else {
      arms.push({
        name: "the pooled handle, dialed directly", forA: first.program, forB: first.program, own: first.handle,
        between: first.handle, origin: "https://api.ohmail.app", staffed: true, pooled: false,
      });
    }
  }, 180_000);

  afterAll(async () => {
    const ids = people.map((p) => p.accountId);
    if (ids.length > 0) {
      const letters = people.flatMap((p) => p.letters);
      await seed.execute(sql`delete from message_search where account_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      await seed.delete(folderState).where(inArray(folderState.messageId, letters));
      await seed.delete(flagState).where(inArray(flagState.messageId, letters));
      await seed.delete(messageBodies).where(inArray(messageBodies.messageId, letters));
      await seed.delete(awayReplies).where(inArray(awayReplies.accountId, ids));
      await seed.delete(awayResponders).where(inArray(awayResponders.accountId, ids));
      await seed.delete(messages).where(inArray(messages.accountId, ids));
      await seed.delete(mailboxCredentials).where(inArray(mailboxCredentials.accountId, ids));
      await seed.delete(outboundSentCopies).where(inArray(outboundSentCopies.accountId, ids));
      await seed.delete(outboundSends).where(inArray(outboundSends.accountId, ids));
      await seed.delete(drafts).where(inArray(drafts.accountId, ids));
      await seed.delete(mailboxes).where(inArray(mailboxes.accountId, ids));
      await seed.delete(accountSettings).where(inArray(accountSettings.accountId, ids));
      await seed.delete(changeLog).where(inArray(changeLog.accountId, ids));
      await seed.delete(sessions).where(inArray(sessions.accountId, ids));
      await seed.delete(users).where(inArray(users.accountId, ids));
      await seed.delete(accounts).where(inArray(accounts.id, ids));
    }
    for (const p of programs) await p.close();
    await closePooledDbs();
    await new Promise<void>((resolve) => { hangsUp.close(() => resolve()); });
    vi.unstubAllGlobals();
  }, 60_000);

  // ── What a request wrote ─────────────────────────────────────────────────────────────────────

  interface Asked {
    readonly as?: Person;
    readonly bearer?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
    /** Called once the request is with the program: the wire was quiet before it, and is its own from here. */
    readonly sent?: () => void;
    /** Answered through {@link dialOpened}: for a program that dials no address on its own network. */
    readonly dialOpened?: boolean;
  }
  const requestOf = (arm: Arm, method: string, path: string, asked: Asked = {}): Request => {
    const bearer = asked.bearer ?? asked.as?.token;
    return new Request(`${arm.origin}${path}`, {
      method,
      headers: {
        ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
        ...(asked.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(asked.headers ?? {}),
      },
      ...(asked.body !== undefined ? { body: JSON.stringify(asked.body) } : {}),
      ...(asked.signal ? { signal: asked.signal } : {}),
    });
  };

  /**
   * `req` answered by the program's own container, routes and pool, with one port replaced: the
   * dial's host check, by one that clears this file's mail server. The managed service dials no
   * address on its own network, and this file dials no other.
   */
  const dialOpened = (program: Program, req: Request): Promise<Response> => {
    const deps = program.buildDeps(req);
    deps.services = Object.create(deps.services ?? null, { probeHostGuard: { value: ALLOW_ANY_PROBE_HOST } }) as typeof deps.services;
    return createApp(program.chosen.routes).handle(req, deps);
  };

  /**
   * One request through `program`, and the flights it wrote. Every statement is held against the
   * doors' lists ({@link refusedOf}): none may name what its door does not reach.
   */
  async function through(
    arm: Arm, program: Program, method: string, path: string, asked: Asked = {},
  ): Promise<{ status: number; text: string; flights: PgWireFlight[] }> {
    await settled();
    wire.start();
    const req = requestOf(arm, method, path, asked);
    const answering = asked.dialOpened ? dialOpened(program, req) : program.dispatch(req);
    asked.sent?.();
    const res = await answering;
    const text = await res.text();
    await settled();
    const flights = flightsOf(wire.read());
    const digests = [...people.map((p) => p.digest), ...(asked.bearer !== undefined ? [hashToken(asked.bearer)] : [])];
    expect(refusedOf("api", flights, digests, met), `${method} ${path}`).toEqual([]);
    return { status: res.status, text, flights };
  }

  /** The flights after the session's look-up: what the request did once it knew whose it was. */
  const afterTheLookUp = (flights: readonly PgWireFlight[], who: Person): PgWireFlight[] => {
    const at = flights.findIndex((f) => keyEquals(f, who.digest));
    expect(at, "the session's look-up").toBeGreaterThanOrEqual(0);
    // Before it, at most the driver's own catalog read on a connection it just dialed.
    for (const f of flights.slice(0, at)) expect(doorOf(f)).toBe("plain");
    return flights.slice(at + 1);
  };

  /** `who`'s request, answered: its look-up, then flights that name `who` and nobody else. */
  async function own(arm: Arm, who: Person, method = "GET", path = "/messages?view=imbox", body?: unknown): Promise<PgWireFlight[]> {
    const other = who === A() ? B() : A();
    const r = await through(arm, who === A() ? arm.forA : arm.forB, method, path, { as: who, ...(body !== undefined ? { body } : {}) });
    expect(r.status, r.text).toBe(200);
    const rest = afterTheLookUp(r.flights, who);
    expect(rest.length).toBeGreaterThan(0);
    for (const f of rest) {
      expect(f.account, "a flight of this request").toBe(who.accountId);
      expect(f.keyed).toBe(false);
      expect(carries(f, other.accountId)).toBe(false);
    }
    return rest;
  }

  /** The backend's own word between two requests: both settings read empty, outside any transaction. */
  async function leftNothing(arm: Arm): Promise<number> {
    await settled();
    const [row] = rowsOf<{ account: string | null; key: string | null; pid: number }>(await arm.between.execute(sql`
      select current_setting('ohmail.account', true) as account, current_setting('ohmail.key', true) as key, pg_backend_pid() as pid`));
    expect(row!.account ?? "").toBe("");
    expect(row!.key ?? "").toBe("");
    return row!.pid;
  }

  /** The backend A's program writes on. */
  async function backendOf(arm: Arm): Promise<number> {
    const [row] = rowsOf<{ pid: number }>(await arm.own.execute(sql`select pg_backend_pid() as pid`));
    return row!.pid;
  }

  /**
   * Run `during` while another connection holds `who`'s account row: a write of theirs waits on it
   * at its first statement, inside its transaction. `blocked()` answers once `pid` waits there.
   */
  async function whileHeld(
    who: Person, pid: number, during: (blocked: () => Promise<void>, by: Handle) => Promise<void>,
  ): Promise<void> {
    await (holder as unknown as { transaction: (fn: (tx: Handle) => Promise<void>) => Promise<void> }).transaction(async (tx) => {
      await tx.execute(sql`select id from accounts where id = ${who.accountId} for update`);
      const blocked = async (): Promise<void> => {
        const until = Date.now() + 15_000;
        for (;;) {
          const waiting = rowsOf<{ n: number }>(await tx.execute(
            sql`select count(*)::int as n from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'`));
          if (waiting[0]!.n > 0) return;
          if (Date.now() > until) throw new Error("the request never waited on the held row");
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      await during(blocked, tx);
    });
  }

  const unreadOf = async (letter: string): Promise<boolean> => {
    const [row] = await seed.select({ unread: messages.unread }).from(messages).where(eq(messages.id, letter));
    return row!.unread;
  };

  const inTurn = (flights: readonly PgWireFlight[]): string[] => {
    const turns: string[] = [];
    for (const f of flights) if (f.account !== null && turns.at(-1) !== f.account) turns.push(f.account);
    return turns;
  };

  /** Each arm is made in `beforeAll`: the cases find theirs by its place. */
  const ARMS = POOLER_UP
    ? ["the server's own pool", "the pooled handle, through the pooler"]
    : ["the server's own pool", "the pooled handle, dialed directly"];

  for (const [at, title] of ARMS.entries()) {
    describe(title, () => {
      const arm = (): Arm => arms[at]!;

      it("a request's statements ride its own session's account: the look-up keyed and alone, then one account", async () => {
        const a = A();
        // Twice first: the statements are prepared on the connection that answers.
        await own(arm(), a);
        await own(arm(), a);
        const r = await through(arm(), arm().forA, "GET", "/messages?view=imbox", { as: a });
        expect(r.status).toBe(200);
        // The look-up: one flight of its own, no account, the token's digest as its key, one wait.
        const lookUps = r.flights.filter((f) => f.keyed);
        expect(lookUps).toHaveLength(1);
        expect(lookUps[0]).toMatchObject({ door: "lone", account: null, bursts: 1, closed: "commit" });
        expect(keyEquals(lookUps[0]!, a.digest)).toBe(true);
        expect(keyEquals(lookUps[0]!, a.token)).toBe(false);
        expect(r.flights.indexOf(lookUps[0]!)).toBe(0);
        // Everything after it names A. Nothing is outside a flight, and nothing names B.
        const rest = r.flights.slice(1);
        expect(rest.length).toBeGreaterThan(0);
        expect(rest.map((f) => f.account)).toEqual(rest.map(() => a.accountId));
        expect(r.flights.filter((f) => f.door === "plain")).toEqual([]);
        expect(r.flights.some((f) => f.account === B().accountId || carries(f, B().accountId))).toBe(false);
      }, 60_000);

      it("a search page is one read-only transaction whose binder rides its first burst; a write names its account first", async () => {
        const a = A();
        const page = await own(arm(), a, "GET", "/search?q=heron&parts=page");
        const reads = page.filter((f) => f.door === "read");
        expect(reads).toHaveLength(1);
        // Begun read only, named, and reading before the database answered anything.
        expect(reads[0]!.ahead).toBeGreaterThanOrEqual(1);
        expect(reads[0]).toMatchObject({ account: a.accountId, closed: "commit" });

        const marked = await own(arm(), a, "PATCH", `/messages/${a.letters[1]}`, { unread: false });
        const writes = marked.filter((f) => f.door === "write");
        expect(writes).toHaveLength(1);
        // Door two: the body is written only after the start and the binding were answered.
        expect(writes[0]).toMatchObject({ account: a.accountId, ahead: 0, closed: "commit" });
        expect(writes[0]!.statements.length).toBeGreaterThan(1);
        expect(await unreadOf(a.letters[1]!)).toBe(false);
      }, 60_000);

      it("a request that names another account's ids is bound to its own session's account, and reaches nothing of the other", async () => {
        const [a, b] = [A(), B()];
        const loud = {
          cookie: `tf_owner=${b.accountId}`, "x-ohmail-account": b.accountId, "x-account-id": b.accountId, "x-tf-account": b.accountId,
        };
        const naming = `accountId=${b.accountId}&account=${b.accountId}&mailboxId=${b.mailboxId}`;
        const asks: Array<[string, string, unknown, number]> = [
          ["GET", `/messages/${b.letters[0]}?${naming}`, undefined, 404],
          ["GET", `/messages?view=imbox&${naming}`, undefined, 200],
          ["PATCH", `/messages/${b.letters[0]}?${naming}`, { unread: false, accountId: b.accountId, mailboxId: b.mailboxId }, 404],
        ];
        for (const [method, path, body, status] of asks) {
          const r = await through(arm(), arm().forA, method, path, { as: a, headers: loud, ...(body !== undefined ? { body } : {}) });
          expect(r.status, `${method} ${path}: ${r.text}`).toBe(status);
          const rest = afterTheLookUp(r.flights, a);
          expect(rest.length).toBeGreaterThan(0);
          // B's ids are words in a statement at most: every flight names A.
          expect(rest.map((f) => f.account)).toEqual(rest.map(() => a.accountId));
          expect(r.text).not.toContain(b.letters[0]);
          expect(r.text).not.toContain(b.mailboxId);
        }
        // B's letter is as it was.
        expect(await unreadOf(b.letters[0]!)).toBe(true);
      }, 60_000);

      it("two accounts in turn on one backend: each request names its own, and none leaves its binding behind", async () => {
        const [a, b] = [A(), B()];
        const x = arm();
        await own(x, a);
        await own(x, b);
        let pid = await backendOf(x);
        // The backend is the same one from here on where something holds it: the pooler its one
        // backend, the server's own pool a connection it never closes. The pooled handle dialed
        // directly closes an idle connection after a second, so there the backend is read each time.
        const held = x.pooled || !x.staffed;
        const nothingLeft = async (): Promise<void> => {
          const at = await leftNothing(x);
          if (held) expect(at).toBe(pid);
          else pid = at;
        };
        if (x.pooled) {
          // The pooler keeps one backend: its second client reads what the first one's requests left.
          await nothingLeft();
        } else {
          // One connection carries everything this program sends: its pool dialed no second one.
          const open = rowsOf<{ n: number }>(await seed.execute(
            sql`select count(*)::int as n from pg_stat_activity where application_name = ${SERVER_POOL}`));
          expect(open[0]!.n).toBe(1);
        }

        // Twelve rounds each: a prepared statement has taken its generic plan long before the last.
        for (let round = 0; round < 12; round++) {
          await own(x, a);
          await nothingLeft();
          await own(x, b);
          await nothingLeft();
        }

        // A token no session answers: its look-up rides its own digest, and nothing follows it.
        const stranger = generateToken();
        const nobody = await through(x, x.forA, "GET", "/messages?view=imbox", { bearer: stranger });
        expect(nobody.status).toBe(401);
        expect(nobody.flights.filter((f) => f.account !== null)).toEqual([]);
        expect(nobody.flights.filter((f) => f.keyed).map((f) => keyEquals(f, hashToken(stranger)))).toEqual([true]);
        await nothingLeft();
        await own(x, b);

        // Refused inside its transaction: A asks to change B's letter. Rolled back, under A.
        const refusedInside = await through(x, x.forA, "PATCH", `/messages/${b.letters[0]}`, { as: a, body: { unread: false } });
        expect(refusedInside.status).toBe(404);
        const undone = afterTheLookUp(refusedInside.flights, a).filter((f) => f.door === "write");
        expect(undone.map((f) => [f.account, f.closed])).toEqual([[a.accountId, "rollback"]]);
        await nothingLeft();
        await own(x, b);
        await nothingLeft();

        // Cancelled from a second connection while its write waits on a row another connection holds.
        const letter = a.letters[2]!;
        await whileHeld(a, pid, async (blocked, by) => {
          let sent = (): void => {};
          const dispatched = new Promise<void>((resolve) => { sent = resolve; });
          const asking = through(x, x.forA, "PATCH", `/messages/${letter}`, { as: a, body: { unread: false }, sent });
          await dispatched;
          await blocked();
          await by.execute(sql`select pg_cancel_backend(${pid})`);
          const cancelled = await asking;
          expect(cancelled.status).toBeGreaterThanOrEqual(500);
          const ended = afterTheLookUp(cancelled.flights, a).filter((f) => f.door === "write");
          expect(ended.map((f) => [f.account, f.closed])).toEqual([[a.accountId, "rollback"]]);
        });
        expect(await unreadOf(letter)).toBe(true);
        await nothingLeft();
        await own(x, b);
        await nothingLeft();

        // Timed out waiting on the same row: the backend gives the wait up by itself.
        await x.own.execute(sql`set lock_timeout = '300ms'`);
        try {
          await whileHeld(a, pid, async () => {
            const late = await through(x, x.forA, "PATCH", `/messages/${letter}`, { as: a, body: { unread: false } });
            expect(late.status).toBeGreaterThanOrEqual(500);
            const ended = afterTheLookUp(late.flights, a).filter((f) => f.door === "write");
            expect(ended.map((f) => [f.account, f.closed])).toEqual([[a.accountId, "rollback"]]);
          });
        } finally {
          await x.own.execute(sql`reset lock_timeout`);
        }
        expect(await unreadOf(letter)).toBe(true);
        await nothingLeft();
        await own(x, b);
        await nothingLeft();

        // Left by its client mid-write: nothing lets go of the transaction's connection. It runs
        // to its close, and only then does the backend serve the next request.
        const gone = new AbortController();
        let leaving: Promise<{ status: number; text: string; flights: PgWireFlight[] } | null> = Promise.resolve(null);
        await settled();
        wire.start();
        await whileHeld(a, pid, async (blocked) => {
          leaving = x.forA.dispatch(requestOf(x, "PATCH", `/messages/${letter}`, { as: a, body: { unread: false }, signal: gone.signal }))
            .then(async (res) => ({ status: res.status, text: await res.text(), flights: [] }), () => null);
          await blocked();
          gone.abort();
        });
        await leaving;
        await settled();
        const left = flightsOf(wire.read());
        const closing = afterTheLookUp(left, a).filter((f) => f.door === "write");
        expect(closing).toHaveLength(1);
        expect(closing[0]!.account).toBe(a.accountId);
        expect(closing[0]!.closed).not.toBeNull();
        await nothingLeft();
        await own(x, b);
        await nothingLeft();
        await seed.update(messages).set({ unread: true }).where(eq(messages.id, letter));

        if (x.pooled) {
          // The client's connection cut mid-transaction: the pooler ends that backend's transaction,
          // or the backend. Nothing of the cut write stands, and the next client starts clean.
          let cut: Promise<number> = Promise.resolve(0);
          await whileHeld(a, pid, async (blocked) => {
            cut = x.forA.dispatch(requestOf(x, "PATCH", `/messages/${letter}`, { as: a, body: { unread: false } }))
              .then(async (res) => { await res.text(); return res.status; });
            await blocked();
            lastToPooler!.destroy();
            expect(await cut).toBeGreaterThanOrEqual(500);
            // B is served while the row is still held: on a backend the cut transaction is not on.
            await own(x, b);
            await leftNothing(x);
          });
          // The cut backend is gone, and its write with it.
          const until = Date.now() + 15_000;
          for (;;) {
            const alive = rowsOf<{ n: number }>(await seed.execute(sql`select count(*)::int as n from pg_stat_activity where pid = ${pid}`));
            if (alive[0]!.n === 0) break;
            if (Date.now() > until) throw new Error("the cut connection's backend is still there");
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(await unreadOf(letter)).toBe(true);
          // The pool dials again and serves A as before.
          await own(x, a);
          await leftNothing(x);
          await own(x, b);
        }
      }, 180_000);

      it("a container handed to a second request is refused: the second person's request sends nothing", async () => {
        const [a, b] = [A(), B()];
        const x = arm();
        const app = createApp(apiRoutes);
        const first = requestOf(x, "GET", "/messages?view=imbox", { as: a });
        const container = x.forA.buildDeps(first);
        expect((await app.handle(first, container)).status).toBe(200);
        await settled();
        wire.start();
        const again = await app.handle(requestOf(x, "GET", "/messages?view=imbox", { as: b }), container);
        await again.text();
        await settled();
        expect(again.status).toBe(500);
        const flights = flightsOf(wire.read());
        expect(flights.filter((f) => f.account !== null)).toEqual([]);
        expect(flights.some((f) => carries(f, b.accountId) || keyEquals(f, b.digest))).toBe(false);
      }, 60_000);

      it("a clock's tick: the walk names no account, and due letters of A, B and A each ride their own", async () => {
        const [a, b] = [A(), B()];
        const now = Date.now();
        const due: Array<{ who: Person; draft: string }> = [];
        for (const [who, minutesAgo] of [[a, 3], [b, 2], [a, 1]] as const) {
          const at = new Date(now - minutesAgo * MINUTE);
          const made = new Date(at.getTime() - 5 * MINUTE);
          const [d] = await seed.insert(drafts).values({
            accountId: who.accountId, mailboxId: who.mailboxId, subject: "later", body: "words",
            to: [{ name: null, address: "you@example.com" }], status: "draft", createdAt: made, updatedAt: made,
          }).returning();
          await schedules.schedule(
            { db: dbFor(seed as never, who.accountId), accountId: who.accountId, userId: null, now: () => made, requestId: "seed" },
            d!.id, at.toISOString(),
          );
          due.push({ who, draft: d!.id });
        }
        // No mailbox here is signed in: each letter's dial reads its mailbox's credential, finds
        // none and sends nothing.
        const r = await through(arm(), arm().forA, "GET", "/internal/sends/scheduled/run", { bearer: CLOCK_WORD });
        expect(r.status, r.text).toBe(200);
        expect((JSON.parse(r.text) as { claimed: number }).claimed).toBeGreaterThanOrEqual(3);
        expect(r.flights.filter((f) => f.door === "plain")).toEqual([]);
        expect(r.flights.filter((f) => f.keyed)).toEqual([]);

        const mine = r.flights.filter((f) => f.account === a.accountId || f.account === b.accountId);
        expect(inTurn(mine)).toEqual([a.accountId, b.accountId, a.accountId]);
        // Each letter is named only in flights of its own account, or on the walk that claimed it.
        for (const { who, draft } of due) {
          const naming = r.flights.filter((f) => carries(f, draft));
          expect(naming.some((f) => f.account === who.accountId)).toBe(true);
          expect(naming.filter((f) => f.account !== null && f.account !== who.accountId)).toEqual([]);
        }
        // The walk names a letter only in the claim, beside every letter it claimed.
        for (const { draft } of due) {
          expect(r.flights.filter((f) => f.account === null && carries(f, draft) && !due.every((d) => carries(f, d.draft)))).toEqual([]);
        }
        // The dial's read of a mailbox's credential rides the letter's account, never the walk.
        const dials = mine.filter((f) => f.statements.some((s) => s.includes("\"mailbox_credentials\"")));
        expect(inTurn(dials)).toEqual([a.accountId, b.accountId, a.accountId]);
        expect(r.flights.filter((f) => f.account === null && f.statements.some((s) => s.includes("\"mailbox_credentials\"")))).toEqual([]);
      }, 60_000);

      it("a pass's dial reads a mailbox's credential under the account of the row it dials for, never on the walk", async () => {
        const [a, b] = [A(), B()];
        const now = Date.now();
        for (const who of [a, b]) {
          // A reservation stranded mid-send, for the reconciling pass.
          const at = new Date(now - 11 * MINUTE);
          const key = `stranded-${randomUUID().slice(0, 8)}`;
          const [d] = await seed.insert(drafts).values({
            accountId: who.accountId, mailboxId: who.mailboxId, subject: "the stranded one", body: "words",
            to: [{ name: null, address: "you@example.com" }], status: "sending", sendKey: key, createdAt: at, updatedAt: at,
          }).returning();
          await seed.insert(outboundSends).values({
            accountId: who.accountId, idempotencyKey: key, draftId: d!.id, mintedMessageId: `<${randomUUID()}@wire.example>`,
            status: "pending", createdAt: at,
          });
          // A delivered letter whose Sent copy is still owed, for the late pass.
          const minted = `<${randomUUID()}@wire.example>`;
          const [s] = await seed.insert(outboundSends).values({
            accountId: who.accountId, idempotencyKey: `owed-${randomUUID().slice(0, 8)}`, mintedMessageId: minted,
            providerMessageId: minted, status: "sent",
          }).returning();
          await seed.insert(outboundSentCopies).values({
            sendId: s!.id, accountId: who.accountId, mailboxId: who.mailboxId,
            rawB64: Buffer.from(`Message-ID: ${minted}\r\n\r\nhi\r\n`).toString("base64"), nextAttemptAt: new Date(now - MINUTE),
          });
        }
        for (const path of ["/internal/sends/reconcile/run", "/internal/sends/sent-copies/run", "/internal/away/run"]) {
          const r = await through(arm(), arm().forA, "GET", path, { bearer: CLOCK_WORD });
          expect(r.status, `${path}: ${r.text}`).toBe(200);
          const dials = r.flights.filter((f) => f.statements.some((s) => namedBy(s).reads.includes("mailbox_credentials")));
          // The credential of each of the two mailboxes is read, in a flight that names its own account.
          for (const [own, other] of [[a, b], [b, a]] as const) {
            const theirs = dials.filter((f) => carries(f, own.mailboxId));
            expect(theirs.length, `${path}: a dial for this mailbox`).toBeGreaterThan(0);
            expect(theirs.map((f) => f.account), path).toEqual(theirs.map(() => own.accountId));
            expect(theirs.some((f) => carries(f, other.mailboxId)), path).toBe(false);
          }
          expect(dials.filter((f) => f.account === null), path).toEqual([]);
        }
      }, 120_000);

      it("a Microsoft mailbox's new refresh token is written in a flight of its own that names the mailbox's account", async () => {
        const x = arm();
        const a = A();
        const keys = x.forA.runtime.cfg.keyRing.provider;
        const port = (hangsUp.address() as net.AddressInfo).port;
        // A mailbox of A's signed in through Microsoft: its stored secret is a refresh token.
        const [mb] = await seed.insert(mailboxes).values({
          accountId: a.accountId, provider: "imap", address: `wire-${randomUUID().slice(0, 8)}@wire.example`,
          organizerRole: "organizer", status: "connected",
        }).returning();
        const stored = await keys.encrypt(`stored-${randomUUID()}`);
        await seed.insert(mailboxCredentials).values({
          mailboxId: mb!.id, accountId: a.accountId, transport: "imap", secretEnc: stored.ciphertext, keyVersion: stored.keyVersion,
          meta: {
            authType: "oauth2", provider: "microsoft", tenant: "common", user: "wire@wire.example",
            host: "127.0.0.1", port, secure: true, smtp: { host: "127.0.0.1", port, secure: false },
          },
        });
        // One letter of that mailbox's, due: the sender's pass dials for it.
        const at = new Date(Date.now() - MINUTE);
        const made = new Date(at.getTime() - 5 * MINUTE);
        const [d] = await seed.insert(drafts).values({
          accountId: a.accountId, mailboxId: mb!.id, subject: "later", body: "words",
          to: [{ name: null, address: "you@example.com" }], status: "draft", createdAt: made, updatedAt: made,
        }).returning();
        await schedules.schedule(
          { db: dbFor(seed as never, a.accountId), accountId: a.accountId, userId: null, now: () => made, requestId: "seed" },
          d!.id, at.toISOString(),
        );
        try {
          const before = handedBack.length;
          // The dial asks Microsoft for an access token, is handed a new refresh token beside it, and
          // then finds nobody at the mail server.
          const r = await through(x, x.forA, "GET", "/internal/sends/scheduled/run", { bearer: CLOCK_WORD, dialOpened: x.staffed });
          expect(r.status, r.text).toBe(200);
          expect(handedBack.length - before, "one refresh, for this mailbox").toBe(1);

          // The new token is written once: one statement, in a flight of its own that names A.
          const writes = r.flights.filter((f) => f.statements.some((s) => namedBy(s).writes === "mailbox_credentials"));
          expect(writes.map((f) => [f.door, f.account, f.keyed, f.statements.length])).toEqual([["lone", a.accountId, false, 1]]);
          expect(carries(writes[0]!, mb!.id)).toBe(true);
          // And the credential's table is named nowhere but under A: not outside a flight, not on the walk.
          expect(r.flights.filter((f) => f.account !== a.accountId
            && f.statements.some((s) => namedBy(s).reads.includes("mailbox_credentials")))).toEqual([]);
          // The store keeps what Microsoft handed back: the token it replaced may already be dead.
          const [kept] = await seed.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb!.id));
          expect(await keys.decrypt(kept!.secretEnc, kept!.keyVersion)).toBe(handedBack.at(-1));
        } finally {
          // Signed out again, its letter a draft: no later tick and no other pass dials for it.
          await seed.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb!.id));
          await seed.update(drafts).set({ status: "draft" }).where(eq(drafts.id, d!.id));
        }
      }, 60_000);

      it("the other clocks' routes: every statement on their walk is one the lists admit", async () => {
        for (const path of [
          "/internal/sends/reconcile/run", "/internal/sends/sent-copies/run", "/internal/away/run", "/internal/sessions/reap",
          UNSUB_DRAIN_CRON_PATH, "/internal/mailboxes/smtp-size", "/internal/security-notices/run",
        ]) {
          const r = await through(arm(), arm().forA, "GET", path, { bearer: CLOCK_WORD });
          expect(r.status, `${path}: ${r.text}`).toBe(200);
          if (path === UNSUB_DRAIN_CRON_PATH) expect(r.flights, path).toEqual([]);
          expect(r.flights.filter((f) => f.keyed), path).toEqual([]);
          // What a pass does for one row names that row's account and no key; the rest is its walk.
          for (const f of r.flights) expect(["nothing", "account"], path).toContain(doorOf(f));
        }
        if (!arm().staffed) {
          // A server with one role reads its alert pass on the pool's own handle.
          const r = await through(arm(), arm().forA, "GET", "/internal/alerts/run", { bearer: CLOCK_WORD });
          expect(r.status, r.text).toBe(200);
          expect(r.flights.filter((f) => f.account !== null)).toEqual([]);
        }
        walked.add(title);
      }, 120_000);

      it("a staff route: the operators' tables ride the door's word and no account; the act rides the account its row names", async () => {
        const x = arm();
        if (!x.staffed) {
          // No staff door on a self-hosted server: the route does not exist, and nothing is sent.
          const none = await through(x, x.forA, "POST", "/admin/mailboxes/resync", {
            bearer: CONSOLE_WORD, body: { sessionToken: staffToken, mailboxId: A().mailboxId, note: NOTE },
          });
          expect(none.status).toBe(404);
          expect(none.flights).toEqual([]);
          return;
        }
        const a = A();
        // A mailbox id no row answers: the refusal's audit row is a flight of its own, at the door.
        const refused = await through(x, x.forA, "POST", "/admin/mailboxes/resync", {
          bearer: CONSOLE_WORD, body: { sessionToken: staffToken, mailboxId: randomUUID(), note: NOTE },
        });
        expect(refused.status).toBe(404);
        expect(refused.flights.filter((f) => f.door === "plain")).toEqual([]);
        expect(refused.flights.filter((f) => f.account !== null)).toEqual([]);
        expect(refused.flights.map((f) => doorOf(f))).toEqual(refused.flights.map(() => "staff"));
        const audits = refused.flights.filter((f) => f.statements.some((s) => s.includes("\"staff_audit_events\"")));
        expect(audits.map((f) => [f.door, f.statements.length])).toEqual([["lone", 1]]);
        expect(refused.flights.some((f) => f.statements.some((s) => s.includes("\"staff_sessions\"")))).toBe(true);

        // A mailbox of A's: the id finds its row at the door, and the act names the row's account.
        const acted = await through(x, x.forA, "POST", "/admin/mailboxes/resync", {
          bearer: CONSOLE_WORD, body: { sessionToken: staffToken, mailboxId: a.mailboxId, note: NOTE },
        });
        expect(acted.status, acted.text).toBe(200);
        expect(acted.flights.filter((f) => f.door === "plain")).toEqual([]);
        const bound = acted.flights.filter((f) => f.account !== null);
        expect(bound.map((f) => [f.door, f.account, f.keyed])).toEqual([["write", a.accountId, false]]);
        // Everything else is at the door, and the door's word never rides beside an account.
        for (const f of acted.flights) if (f.account === null) expect(doorOf(f)).toBe("staff");
        // The staff's own tables are named at the door alone; the one row of the act's own audit is owed.
        const staffTables = ["staff_sessions", "staff_users", "staff_role_grants", "staff_audit_log"];
        expect(bound.filter((f) => f.statements.some((s) => staffTables.some((t) => s.includes(`"${t}"`))))).toEqual([]);
      }, 60_000);
    });
  }

  it("every owed row this file can meet was met: the list holds nothing that is no longer true", () => {
    // Asked only of a whole run: a filtered one walks part of the doors.
    if (walked.size < ARMS.length) return;
    expect(unmetOf("server", met)).toEqual([]);
  });
});
