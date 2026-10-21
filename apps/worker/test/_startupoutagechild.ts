/**
 * THE CHILD PROCESS OF `driver-startup-outage.test.ts`: a connection that dies while postgres.js is
 * still opening it. Every (re)connect sends the driver's own array-types query (`fetch_types`, which
 * every pool here keeps on) or, under `target_session_attrs`, its state check, while the statement that
 * waits for the connection is held aside. Unpatched, a close in that window kept the dead socket's query
 * as the connection's current one: a refused redial then rejected it with nobody listening, and the
 * crash contract exited 1 (driver-write-race.pg.test.ts, twice in CI). The redial itself must back off
 * (with none, a database that closes every attempt is dialled hundreds of times a second), and a FATAL
 * the server sends that query before closing must fail the waiting statement with the server's code.
 *
 * The contract is mounted on the real `process` with no exemption, as `_writeracechild.ts` does, and
 * the database is a fake Postgres on loopback that trusts every startup (AuthenticationOk). One child
 * per scenario; each arm prints one NDJSON `scenario_result`, and the logger's lines go out as well.
 * Nothing here asserts.
 */
import net from "node:net";
import { createRequire } from "node:module";
import postgresEsm from "postgres";
import { createLogger } from "@trafficflow/core";
import { installCrashHandlers } from "../src/entry.js";
import { withPgSocket } from "../../../packages/db/src/pg-socket.js";

type Postgres = typeof postgresEsm;
type Sql = ReturnType<Postgres>;
type Build = "esm" | "cjs";
type Sock = "pg" | "plain";

const SCENARIO = process.argv[2] ?? "";
const BUILDS: Record<Build, Postgres> = {
  esm: postgresEsm,
  cjs: createRequire(import.meta.url)("postgres") as Postgres,
};

const log = createLogger({ service: "worker", sink: (line) => { process.stdout.write(line + "\n"); } });
installCrashHandlers({ log: () => log, exit: (code) => { process.exit(code); } });

// ── The wire: just enough of protocol 3 for a startup, the types query and `select 1`.
const msg = (type: string, body: Buffer): Buffer => {
  const b = Buffer.alloc(5 + body.length);
  b.write(type, 0);
  b.writeInt32BE(4 + body.length, 1);
  body.copy(b, 5);
  return b;
};
const i32 = (...n: number[]): Buffer => {
  const b = Buffer.alloc(4 * n.length);
  n.forEach((v, k) => b.writeInt32BE(v, 4 * k));
  return b;
};
const i16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; };
const cstr = (s: string): Buffer => Buffer.from(s + "\0");
const field = (name: string, oid: number): Buffer => Buffer.concat([cstr(name), i32(0), i16(0), i32(oid), i16(4), i32(-1), i16(0)]);
const Z = msg("Z", Buffer.from("I"));
const READY = Buffer.concat([msg("R", i32(0)), msg("K", i32(1, 2)), Z]);
const TYPES = Buffer.concat([msg("1", Buffer.alloc(0)), msg("2", Buffer.alloc(0)),
  msg("T", Buffer.concat([i16(2), field("oid", 26), field("typarray", 26)])), msg("C", cstr("SELECT 0")), Z]);
const ONE = Buffer.concat([msg("1", Buffer.alloc(0)), msg("2", Buffer.alloc(0)),
  msg("T", Buffer.concat([i16(1), field("x", 23)])), msg("D", Buffer.concat([i16(1), i32(1), Buffer.from("1")])),
  msg("C", cstr("SELECT 1")), Z]);
/** The state check's two result sets (a simple query): a writable primary. */
const STATE = Buffer.concat([
  msg("T", Buffer.concat([i16(1), field("transaction_read_only", 25)])), msg("D", Buffer.concat([i16(1), i32(3), Buffer.from("off")])),
  msg("C", cstr("SHOW")),
  msg("T", Buffer.concat([i16(1), field("pg_is_in_recovery", 16)])), msg("D", Buffer.concat([i16(1), i32(1), Buffer.from("f")])),
  msg("C", cstr("SELECT 1")), Z]);
const fatal = (code: string, text: string): Buffer => msg("E", Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${text}\0\0`));

const TYPES_SQL = Buffer.from("pg_catalog.pg_type");
const STATE_SQL = Buffer.from("transaction_read_only");
const SELECT_SQL = Buffer.from("select 1");

interface Script {
  /** Answer a new connection's startup: READY, or these bytes and a close (none: a bare close). */
  startup?: (dial: number) => "ready" | Buffer;
  /** A statement arrived; return true when the script handled it. */
  statement?: (buf: Buffer, s: net.Socket, server: net.Server) => boolean;
}

class FakePg {
  dials = 0;
  port = 0;
  private readonly server: net.Server;
  constructor(script: Script) {
    this.server = net.createServer((s) => {
      const dial = ++this.dials;
      let started = false;
      s.on("error", () => { /* the driver's side may vanish */ });
      s.on("data", (buf: Buffer) => {
        if (!started) {
          started = true;
          const answer = script.startup?.(dial) ?? "ready";
          if (answer === "ready") s.write(READY);
          else s.end(answer);
          return;
        }
        if (script.statement?.(buf, s, this.server)) return;
        if (buf.includes(TYPES_SQL)) s.write(TYPES);
        else if (buf.includes(STATE_SQL)) s.write(STATE);
        else if (buf.includes(SELECT_SQL)) s.write(ONE);
      });
    });
  }
  async listen(): Promise<this> {
    await new Promise<void>((r) => { this.server.listen(0, "127.0.0.1", r); });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
    return this;
  }
  close(): void { this.server.close(); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
/** A statement's outcome, never a rejection: its value, or the error's code. */
function ask(sql: Sql): Promise<string> {
  return sql`select 1 as x`.then(
    (rows) => String((rows[0] as { x?: unknown } | undefined)?.x),
    (e: unknown) => String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e),
  );
}
/** `p`'s outcome, or "still-pending" when it has not settled within `ms`. */
const within = (p: Promise<string>, ms: number): Promise<string> =>
  Promise.race([p, sleep(ms).then(() => "still-pending")]);
/** A statement's outcome: its value, or the error's code; "still-pending" when it never settled. */
async function outcome(sql: Sql, guardMs: number): Promise<string> {
  return within(ask(sql), guardMs);
}
/** A statement started now, with a look at its outcome so far ("pending") before it is awaited. */
function start(sql: Sql): { done: Promise<string>; now: () => string } {
  let seen = "pending";
  const done = ask(sql).then((v) => (seen = v));
  return { done, now: () => seen };
}
/** Resolves once `cond` holds, or after `ms`. */
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
}

function open(build: Build, sock: Sock, port: number, extra: Record<string, unknown> = {}): Sql {
  const options = { host: "127.0.0.1", port, user: "u", database: "d", max: 1, onnotice: () => {}, ...extra };
  return BUILDS[build](sock === "pg" ? withPgSocket(options) : options);
}

/** Cut the connection on the first statement matching `on`; `refuse` closes the listener first. */
function cutOnce(on: Buffer, refuse: boolean): Script["statement"] {
  let cut = false;
  return (buf, s, server) => {
    if (cut || !buf.includes(on)) return false;
    cut = true;
    if (refuse) server.close();
    s.destroy();
    return true;
  };
}

interface Result { dials: number; first: string; second?: string; [more: string]: unknown }

/** Both builds the package ships, each through `withPgSocket` and through a plain socket. */
const ALL: Array<[Build, Sock]> = [["esm", "pg"], ["cjs", "pg"], ["esm", "plain"], ["cjs", "plain"]];

/** An outage window: long enough for an unbacked redial loop to show in the dial count. */
const WINDOW_MS = 1_000;
/** How long a statement may take to settle on a loaded host (a starved child took over 1 s). */
const SETTLE_MS = 10_000;

/**
 * `concurrent`: the arms run side by side, each on its own fake server and its own pool (nothing is
 * shared but the event loop), so a scenario that waits out a window costs one window, not four.
 */
const SCENARIOS: Record<string, { arms: Array<[Build, Sock]>; concurrent?: boolean; run: (build: Build, sock: Sock) => Promise<Result> }> = {
  // The CI sighting: the types query is cut and the redial is refused.
  refused: {
    arms: [["esm", "pg"], ["cjs", "pg"], ["esm", "plain"], ["cjs", "plain"]],
    async run(build, sock) {
      const pg = await new FakePg({ statement: cutOnce(TYPES_SQL, true) }).listen();
      const sql = open(build, sock, pg.port);
      const first = await outcome(sql, 5_000);
      await sleep(100);
      return { dials: pg.dials, first };
    },
  },
  // The cut, then a database that answers "starting up" to every startup until it recovers: 300 ms
  // after the waiting statement settled (or its guard ran out), so a redial loop has time to show.
  "starting-up": {
    arms: [["esm", "pg"], ["cjs", "pg"]],
    async run(build, sock) {
      let cut = false;
      let recovered = false;
      const pg = await new FakePg({
        startup: () => (cut && !recovered ? fatal("57P03", "the database system is starting up") : "ready"),
        statement: (buf, s) => {
          if (cut || !buf.includes(TYPES_SQL)) return false;
          cut = true;
          s.destroy();
          return true;
        },
      }).listen();
      const sql = open(build, sock, pg.port);
      const first = await outcome(sql, SETTLE_MS);
      await sleep(300);
      const dials = pg.dials;
      recovered = true;
      const second = await outcome(sql, 5_000);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials, first, second };
    },
  },
  // A statement answered FATAL and a close; the next one, on a healthy redial, must not inherit it.
  "fatal-close": {
    arms: [["esm", "pg"], ["cjs", "pg"]],
    async run(build, sock) {
      let fataled = false;
      const pg = await new FakePg({
        statement: (buf, s) => {
          if (fataled || !buf.includes(SELECT_SQL)) return false;
          fataled = true;
          s.end(fatal("57P01", "terminating connection due to administrator command"));
          return true;
        },
      }).listen();
      const sql = open(build, sock, pg.port, { backoff: () => 0 });
      const first = await outcome(sql, 5_000);
      const second = await outcome(sql, 5_000);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials: pg.dials, first, second };
    },
  },
  // `target_session_attrs`: the driver's state check is cut and the redial is refused.
  "state-probe": {
    arms: [["esm", "pg"], ["cjs", "pg"]],
    async run(build, sock) {
      const pg = await new FakePg({ statement: cutOnce(STATE_SQL, true) }).listen();
      const sql = open(build, sock, pg.port, { target_session_attrs: "read-write" });
      const first = await outcome(sql, 5_000);
      await sleep(100);
      return { dials: pg.dials, first };
    },
  },
  // `target_session_attrs`: the state check is cut, then a healthy database answers it. The dead
  // socket's check must not be the redial's current query: answered there with the startup's empty
  // result, it threw, and the waiting statement failed with a TypeError.
  "state-control": {
    arms: [["esm", "pg"], ["cjs", "pg"]],
    async run(build, sock) {
      const pg = await new FakePg({ statement: cutOnce(STATE_SQL, false) }).listen();
      const sql = open(build, sock, pg.port, { target_session_attrs: "read-write" });
      const first = await outcome(sql, 5_000);
      await sleep(100);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials: pg.dials, first };
    },
  },
  // The cut, then a healthy database: the waiting statement answers on the second dial.
  control: {
    arms: [["esm", "pg"], ["cjs", "pg"]],
    async run(build, sock) {
      const pg = await new FakePg({ statement: cutOnce(TYPES_SQL, false) }).listen();
      const sql = open(build, sock, pg.port);
      const first = await outcome(sql, 5_000);
      await sleep(100);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials: pg.dials, first };
    },
  },
  // Every startup completes and every types query is answered FATAL and a close: 57P01 (a database
  // shutting down) while the first statement waits, 08P01 while the second does. Each must fail with
  // the server's own code on its own dial, and nothing redials once they have; then a healthy database.
  "fatal-types": {
    arms: ALL,
    concurrent: true,
    async run(build, sock) {
      let code = "57P01";
      let down = true;
      const pg = await new FakePg({
        statement: (buf, s) => {
          if (!down || !buf.includes(TYPES_SQL)) return false;
          s.end(fatal(code, code === "57P01" ? "terminating connection due to administrator command" : "server conn crashed?"));
          return true;
        },
      }).listen();
      const sql = open(build, sock, pg.port);
      const first = await outcome(sql, SETTLE_MS);
      const firstDials = pg.dials;
      code = "08P01";
      const second = await outcome(sql, SETTLE_MS);
      await sleep(300);
      const dials = pg.dials;
      down = false;
      const third = await outcome(sql, SETTLE_MS);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials, firstDials, first, second, third };
    },
  },
  // A pooler whose database went away: it still completes every startup itself, then answers each
  // connection's first statement FATAL 08P01 (as a connection pooler does) and closes. Healthy at
  // first; the dial count covers at least one window from the moment it goes down.
  "pooler-down": {
    arms: ALL,
    concurrent: true,
    async run(build, sock) {
      let down = false;
      const pg = await new FakePg({
        statement: (buf, s) => {
          if (!down || !(buf.includes(TYPES_SQL) || buf.includes(SELECT_SQL))) return false;
          s.end(fatal("08P01", "server conn crashed?"));
          return true;
        },
      }).listen();
      const sql = open(build, sock, pg.port);
      const healthy = await outcome(sql, SETTLE_MS);
      down = true;
      const before = pg.dials;
      const since = Date.now();
      const first = await outcome(sql, SETTLE_MS);
      const second = await outcome(sql, SETTLE_MS);
      await sleep(Math.max(0, WINDOW_MS - (Date.now() - since)));
      const dials = pg.dials - before;
      down = false;
      const third = await outcome(sql, SETTLE_MS);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials, healthy, first, second, third };
    },
  },
  // A database that closes every connection on its startup packet, with no error, then recovers: the
  // waiting statement waits, redialled with backoff, and answers. The window opens at the first dial
  // (a starved child once made none in its first second), and the database stays down until at least
  // one redial, so the outage is always waited through.
  "close-startup": {
    arms: ALL,
    concurrent: true,
    async run(build, sock) {
      let down = true;
      const pg = await new FakePg({ startup: () => (down ? Buffer.alloc(0) : "ready") }).listen();
      const sql = open(build, sock, pg.port);
      const q = start(sql);
      await until(() => pg.dials >= 1, SETTLE_MS);
      await sleep(WINDOW_MS);
      const dials = pg.dials;
      await until(() => pg.dials >= 2, SETTLE_MS);
      const redials = pg.dials - 1;
      const during = q.now();
      down = false;
      const first = await within(q.done, 15_000);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials, redials, during, first };
    },
  },
  // The same with every startup completing and the driver's types query met by a bare close.
  "close-types": {
    arms: ALL,
    concurrent: true,
    async run(build, sock) {
      let down = true;
      const pg = await new FakePg({
        statement: (buf, s) => {
          if (!down || !buf.includes(TYPES_SQL)) return false;
          s.end();
          return true;
        },
      }).listen();
      const sql = open(build, sock, pg.port);
      const q = start(sql);
      await until(() => pg.dials >= 1, SETTLE_MS);
      await sleep(WINDOW_MS);
      const dials = pg.dials;
      await until(() => pg.dials >= 2, SETTLE_MS);
      const redials = pg.dials - 1;
      const during = q.now();
      down = false;
      const first = await within(q.done, 15_000);
      await sql.end({ timeout: 1 });
      pg.close();
      return { dials, redials, during, first };
    },
  },
  // The harness itself: an unhandled rejection must reach the contract and exit 1.
  probe: {
    arms: [["esm", "pg"]],
    async run() {
      void Promise.reject(Object.assign(new Error("probe"), { code: "EPROBE" }));
      await sleep(500);
      return { dials: 0, first: "survived" };
    },
  },
};

async function main(): Promise<void> {
  const scenario = SCENARIOS[SCENARIO];
  if (!scenario) { process.stdout.write(JSON.stringify({ event: "unknown_scenario", scenario: SCENARIO }) + "\n"); process.exit(2); }
  const report = (build: Build, sock: Sock, r: Result): void => {
    process.stdout.write(JSON.stringify({ event: "scenario_result", scenario: SCENARIO, build, sock, ...r }) + "\n");
  };
  if (scenario.concurrent) {
    const rs = await Promise.all(scenario.arms.map(([build, sock]) => scenario.run(build, sock)));
    scenario.arms.forEach(([build, sock], i) => { report(build, sock, rs[i]!); });
  } else {
    for (const [build, sock] of scenario.arms) report(build, sock, await scenario.run(build, sock));
  }
  process.exit(0);
}

void main();
