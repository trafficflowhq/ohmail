import { describe, it, expect } from "vitest";
import { STAFF_DOOR_KEY } from "@trafficflow/db/cloud";
import { BINDER_SQL, flightsOf, type PgWireFlight, type PgWireStatement } from "@trafficflow/db/testing";
import { OWED, doorOf, namedBy, refusedOf, unmetOf } from "./support/wire-doors.js";

/**
 * THE DOORS' LISTS, held against statements written by hand. The two wire tests read every
 * statement the API and the organizer send through `namedBy` and `refusedOf`; a reader that misses
 * a table, or a list that admits too much, would let them pass on nothing. Each answer here is for
 * a statement whose tables and door this file states itself.
 */
const A = "11111111-1111-4111-8111-111111111111";
const DIGEST = "digest-of-a-token";

const sent = (text: string, burst: number, params: readonly string[] = []): PgWireStatement =>
  ({ text, burst, params: params.map((p) => Buffer.from(p)) });

/** One flight through the door `binder` names (`null`: outside any transaction), carrying `statements`. */
const flightOf = (binder: readonly [account: string, key: string] | null, ...statements: string[]): PgWireFlight[] =>
  flightsOf({ lines: [binder === null
    ? statements.map((s, i) => sent(s, i))
    : [sent("begin", 0), sent(BINDER_SQL, 0, binder), ...statements.map((s) => sent(s, 1)), sent("commit", 2)]] });

const refusals = (login: "api" | "worker", flights: PgWireFlight[], met = new Set<string>()): string[] =>
  refusedOf(login, flights, [DIGEST], met).map((r) => `${r.door} ${r.verb} ${r.table}`);

describe("namedBy reads the tables a statement names, and the one it writes", () => {
  it("reads a table where one stands: quoted or bare, after from, join, into and update", () => {
    expect(namedBy(`select "id" from "messages" left join "folder_state" on true where "messages"."id" = $1`))
      .toEqual({ reads: ["folder_state", "messages"], writes: null });
    expect(namedBy("select subject from messages where false")).toEqual({ reads: ["messages"], writes: null });
    expect(namedBy("SELECT 1 FROM public.accounts a WHERE a.id = $1")).toEqual({ reads: ["accounts"], writes: null });
    expect(namedBy(`select exists (select 1 from "mailboxes" where "mailboxes"."account_id" = "away_responders"."account_id") from "away_responders"`))
      .toEqual({ reads: ["away_responders", "mailboxes"], writes: null });
  });

  it("tells the table a statement writes: an insert's, an update's, a delete's, and none for a row lock", () => {
    expect(namedBy(`insert into "audit_log" ("id") values ($1)`)).toEqual({ reads: ["audit_log"], writes: "audit_log" });
    expect(namedBy(`update "drafts" set "status" = $1 where "drafts"."id" in (select "id" from "outbound_sends")`))
      .toEqual({ reads: ["drafts", "outbound_sends"], writes: "drafts" });
    expect(namedBy(`delete from "scheduled_send_files" where not exists (select 1 from "drafts")`))
      .toEqual({ reads: ["drafts", "scheduled_send_files"], writes: "scheduled_send_files" });
    // A row lock is a read: `for update` names no table, with or without the table it is of.
    expect(namedBy(`select "id" from "sessions" where "sessions"."id" = $1 for update`)).toEqual({ reads: ["sessions"], writes: null });
    expect(namedBy(`select "send_id" from "outbound_sent_copies" for update of "outbound_sent_copies" skip locked`))
      .toEqual({ reads: ["outbound_sent_copies"], writes: null });
    // An upsert writes the table it inserts into, and its `do update` names no other.
    expect(namedBy(`insert into "account_settings" ("account_id") values ($1) on conflict ("account_id") do update set "locale" = $2`))
      .toEqual({ reads: ["account_settings"], writes: "account_settings" });
  });

  it("answers only the store's own tables: a catalog, a function and a word that is no table name nothing", () => {
    expect(namedBy("select b.oid from pg_catalog.pg_type a left join pg_catalog.pg_type b on b.oid = a.typelem"))
      .toEqual({ reads: [], writes: null });
    expect(namedBy("select pg_backend_pid() as pid")).toEqual({ reads: [], writes: null });
    expect(namedBy(`select "messages_count" from generate_series(1, 2)`)).toEqual({ reads: [], writes: null });
  });
});

describe("doorOf tells the door a flight came through", () => {
  it("outside a transaction, an account, nothing, a token's digest, the staff door's word, and a key nobody named", () => {
    expect(doorOf(flightOf(null, "select 1")[0]!)).toBe("plain");
    expect(doorOf(flightOf([A, ""], "select 1")[0]!)).toBe("account");
    expect(doorOf(flightOf(["", ""], "select 1")[0]!)).toBe("nothing");
    expect(doorOf(flightOf(["", DIGEST], "select 1")[0]!, [DIGEST])).toBe("credential");
    expect(doorOf(flightOf(["", STAFF_DOOR_KEY], "select 1")[0]!, [DIGEST])).toBe("staff");
    expect(doorOf(flightOf(["", "another-word"], "select 1")[0]!, [DIGEST])).toBe("unknown-key");
    // A key beside an account is no door of the product's.
    expect(doorOf(flightOf([A, DIGEST], "select 1")[0]!, [DIGEST])).toBe("unknown-key");
  });
});

describe("refusedOf holds a statement against its door's list", () => {
  it("a flight that names an account reaches any table but the operators' own", () => {
    expect(refusals("api", flightOf([A, ""], `select 1 from "messages"`, `update "mailboxes" set "status" = $1`))).toEqual([]);
    expect(refusals("worker", flightOf([A, ""], `delete from "messages" where "id" = $1`))).toEqual([]);
    expect(refusals("api", flightOf([A, ""], `select 1 from "staff_users"`))).toEqual(["account read staff_users"]);
  });

  it("outside a transaction a statement names a table no account owns, or none", () => {
    expect(refusals("api", flightOf(null, "select 1", `insert into "api_faults" ("id") values ($1)`))).toEqual([]);
    expect(refusals("worker", flightOf(null, `select 1 from "worker_heartbeats"`))).toEqual([]);
    expect(refusals("api", flightOf(null, `select 1 from "contacts"`))).toEqual(["plain read contacts"]);
    expect(refusals("worker", flightOf(null, `update "contacts" set "name" = $1`))).toEqual(["plain write contacts"]);
  });

  it("the look-up by a token's digest reads the two tables that digest is compared on, and writes nothing", () => {
    expect(refusals("api", flightOf(["", DIGEST], `select 1 from "sessions"`, `select 1 from "erased_bearers"`))).toEqual([]);
    expect(refusals("api", flightOf(["", DIGEST], `update "sessions" set "last_seen_at" = $1`))).toEqual(["credential write sessions"]);
    expect(refusals("api", flightOf(["", DIGEST], `select 1 from "invites"`))).toEqual(["credential read invites"]);
    // A key no test presented is no door: whatever it carries is refused, a statement naming no table too.
    expect(refusals("api", flightOf(["", "another-word"], "select 1"))).toEqual(["unknown-key read "]);
  });

  it("the staff door reaches the operators' tables and the operations', and no customer's", () => {
    expect(refusals("api", flightOf(["", STAFF_DOOR_KEY], `select 1 from "staff_sessions"`, `insert into "staff_audit_events" ("id") values ($1)`,
      `update "auth_throttle" set "failures" = 0`))).toEqual([]);
    expect(refusals("api", flightOf(["", STAFF_DOOR_KEY], `select 1 from "contacts"`))).toEqual(["staff read contacts"]);
    // The worker has no staff door.
    expect(refusals("worker", flightOf(["", STAFF_DOOR_KEY], `select 1 from "staff_sessions"`))).toEqual(["staff read staff_sessions"]);
  });

  it("on the view that names no account the worker reads the tables it schedules from, prunes what is past, and writes no other", () => {
    expect(refusals("worker", flightOf(["", ""], `select 1 from "mailboxes" join "accounts" on true`, `select 1 from "pass_progress"`,
      `delete from "idempotency_keys" where "expires_at" <= $1`, `insert into "worker_heartbeats" ("shard_index") values ($1)`))).toEqual([]);
    expect(refusals("worker", flightOf(["", ""], `update "accounts" set "name" = $1`))).toEqual(["nothing write accounts"]);
    expect(refusals("worker", flightOf(["", ""], `select 1 from "contacts"`))).toEqual(["nothing read contacts"]);
    // The API has no such view: on a handle that names nothing it reaches the operations tables alone.
    expect(refusals("api", flightOf(["", ""], `select 1 from "contacts"`, `select 1 from "auth_throttle"`))).toEqual(["nothing read contacts"]);
  });

  it("an owed row admits exactly its login, door, table and verb, and is recorded as met", () => {
    const met = new Set<string>();
    // Owed: the worker's batch stamp writes `mailboxes` on the view that names no account.
    expect(refusals("worker", flightOf(["", ""], `update "mailboxes" set "last_sync_at" = $1`), met)).toEqual([]);
    expect([...met]).toEqual(["worker nothing write mailboxes"]);
    // The same statement through the API's handle that names nothing is another row's, and is owed too; a
    // table no row names is not admitted by its neighbour.
    expect(refusals("worker", flightOf(["", ""], `update "contacts" set "name" = $1`), met)).toEqual(["nothing write contacts"]);
    expect(met.size).toBe(1);
  });
});

describe("the owed list", () => {
  it("names each row once, and every row says where it is, why, and what takes it away", () => {
    const keys = OWED.map((r) => `${r.login} ${r.door} ${r.verb} ${r.table}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    for (const r of OWED) {
      expect(r.where.length, `${r.table}: where`).toBeGreaterThan(10);
      expect(r.why.length, `${r.table}: why`).toBeGreaterThan(10);
      expect(r.to.length, `${r.table}: to`).toBeGreaterThan(0);
      for (const task of r.to) expect(["walks", "keyed doors", "console", "lock"]).toContain(task);
    }
  });

  it("a row a wire test is said to meet, and did not, is answered as unmet", () => {
    const expected = OWED.filter((r) => r.metBy === "worker").map((r) => `${r.login} ${r.door} ${r.verb} ${r.table}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(unmetOf("worker", new Set())).toEqual(expected);
    expect(unmetOf("worker", new Set(expected))).toEqual([]);
    // What no test meets is never asked for.
    expect(unmetOf("worker", new Set(expected)).concat(unmetOf("server", new Set(OWED.filter((r) => r.metBy === "server")
      .map((r) => `${r.login} ${r.door} ${r.verb} ${r.table}`))))).toEqual([]);
  });
});
