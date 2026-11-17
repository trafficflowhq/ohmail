import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, flightsOf, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { calendarPool, inConnection, passDb } from "@ohmail/organizer/calendar-sync";
import { bindWorker } from "../src/start/bind.js";
import { makeAwayReplySweep } from "../src/away-reply-sweep.js";

/**
 * THE WORKER'S VIEWS ON THE WIRE. What is read through `roster` rides transactions that name no
 * account; what is done through `forAccount(id)`, the repository's calls included, rides
 * transactions that name that account and no other. A pass that walks accounts itself is handed
 * the way to each one's handle, and a calendar turn binds the connection's own account over the
 * roster's view. Read off the bytes the worker's own kind of pool wrote.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

describe.skipIf(!PG_UP)("the worker's handles name their account on the wire (real Postgres)", () => {
  let owned: OwnedDb;
  const A = randomUUID();
  const B = randomUUID();
  const mailboxOf = new Map<string, string>();

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    for (const accountId of [A, B]) {
      const [mb] = await owned.db.insert(mailboxes).values({
        accountId, provider: "imap", address: `bind-${randomUUID().slice(0, 8)}@worker.test`,
      }).returning();
      mailboxOf.set(accountId, mb!.id);
    }
  }, 120_000);

  afterAll(async () => {
    await owned.db.delete(mailboxes).where(inArray(mailboxes.accountId, [A, B]));
    await owned.close();
  });

  const written = async (run: () => Promise<unknown>) => {
    wire.start();
    await run();
    return flightsOf(wire.read());
  };

  it("a read through the roster's view names no account; one through an account's names that account", async () => {
    const binding = bindWorker(owned.db);
    const flights = await written(async () => {
      await binding.roster.select({ id: mailboxes.id }).from(mailboxes).where(inArray(mailboxes.accountId, [A, B]));
      await binding.forAccount(A).db.execute(sql`select 1`);
      await binding.forAccount(B).db.execute(sql`select 1`);
      await binding.forAccount(A).db.execute(sql`select 1`);
    });
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    expect(flights.map((f) => f.account)).toEqual([null, A, B, A]);
    expect(flights.every((f) => !f.keyed)).toBe(true);
  });

  it("an account's repository reads under that account", async () => {
    const binding = bindWorker(owned.db);
    const flights = await written(async () => {
      await binding.forAccount(B).repo.getMailboxSpecialFolders(mailboxOf.get(B)!);
      await binding.forAccount(A).repo.getMailboxSpecialFolders(mailboxOf.get(A)!);
    });
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    expect(flights.map((f) => f.account)).toEqual([B, A]);
    expect(flights.every((f) => f.statements.some((s) => s.includes('"mailboxes"')))).toBe(true);
  });

  it("the away-reply sweep is handed the way to each account's handle, and walks each under its own", async () => {
    const binding = bindWorker(owned.db);
    const asked: string[] = [];
    const flights = await written(() => makeAwayReplySweep().runOnce((accountId) => {
      asked.push(accountId);
      return binding.forAccount(accountId).db as never;
    }, [A, B, A]));
    expect(asked).toEqual([A, B, A]);
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    const turns: Array<string | null> = [];
    for (const f of flights) if (turns.at(-1) !== f.account) turns.push(f.account);
    expect(turns).toEqual([A, B, A]);
  });

  it("a calendar turn binds the connection's account over the roster's view", async () => {
    const binding = bindWorker(owned.db);
    const pool = calendarPool(binding.roster as never);
    const flights = await written(async () => {
      // No such connection: the turn opens its transaction, finds nothing and writes nothing.
      expect(await inConnection(passDb(pool, A), { accountId: A, id: randomUUID() }, async () => "held")).toBe("gone");
      expect(await inConnection(passDb(pool, B), { accountId: B, id: randomUUID() }, async () => "held")).toBe("gone");
    });
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    expect(flights.map((f) => f.account)).toEqual([A, B]);
  });

  it("a calendar turn's handle is refused for what is no account id", () => {
    const pool = calendarPool(bindWorker(owned.db).roster as never);
    expect(() => passDb(pool, "")).toThrow(expect.objectContaining({ code: "binding_refused" }));
    expect(() => passDb(pool, "a-channel-id")).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });
});
