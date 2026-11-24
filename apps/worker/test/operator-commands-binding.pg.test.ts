import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, threads } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { carries, flightsOf, recordPgWire, type PgWireFlight } from "@trafficflow/db/testing";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { doorOf, namedBy, refusedOf } from "../../../test/support/wire-doors.js";

/**
 * THE OPERATOR'S COMMANDS, READ OFF THE WIRE.
 *
 * Six repairs an operator runs by hand against the organizer's database. Three are told one
 * mailbox; three walk every account. Each is run here as it is run by hand, its own file with its
 * own arguments, against a store that holds two accounts, A and B. Everything it wrote to the
 * database is read through `flightsOf`:
 *
 * - the row that says whose the work is (the mailbox's, or each account's own) is read in a
 *   transaction that names no account;
 * - everything else rides a transaction that names the account that row names, and never carries
 *   the other account's ids;
 * - no statement outside a transaction names a table an account owns.
 *
 * A command that ran on the pool's own handle would, where rows are locked by account, find
 * nothing to repair and report a clean run.
 */
const wire = recordPgWire();
let DB = "";

interface Owned { accountId: string; mailboxId: string; threadId: string }

/** A command's own file, run by importing it afresh: literal paths, one per command. */
const COMMANDS = {
  "run-blank-repair": () => import("../src/run-blank-repair.js"),
  "run-junk-sweep": () => import("../src/run-junk-sweep.js"),
  "run-redacted-restore": () => import("../src/run-redacted-restore.js"),
  "run-sender-name-backfill": () => import("../src/run-sender-name-backfill.js"),
  "run-thread-join-heal": () => import("../src/run-thread-join-heal.js"),
  "run-thread-subject-heal": () => import("../src/run-thread-subject-heal.js"),
} as const;

/** How a command ended when it ended itself. */
class Exited extends Error {
  constructor(readonly code: number) { super(`the command exited ${code}`); }
}

/** Wait until the wire has been quiet for a moment. */
async function settled(): Promise<void> {
  let last = -1;
  for (;;) {
    const n = wire.read().flushes.length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 60));
  }
}

/**
 * Run one command as an operator does: its arguments, the database's address and the key ring in
 * its environment. Answers every flight it wrote, what it printed, and how it ended.
 */
async function run(command: keyof typeof COMMANDS, args: readonly string[]): Promise<{ flights: PgWireFlight[]; said: string; exit: number }> {
  const argv = process.argv;
  const said: string[] = [];
  const say = (...parts: unknown[]): void => { said.push(parts.map(String).join(" ")); };
  vi.stubEnv("TF_DB_URL", DB);
  vi.stubEnv(KEY_RING_V1, "ab".repeat(32));
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Exited(code ?? 0); }) as never);
  const out = vi.spyOn(console, "log").mockImplementation(say);
  const err = vi.spyOn(console, "error").mockImplementation(say);
  process.argv = [argv[0]!, `${command}.ts`, ...args];
  vi.resetModules();
  await settled();
  wire.start();
  let code = 0;
  try {
    await COMMANDS[command]();
  } catch (e) {
    if (!(e instanceof Exited)) throw e;
    code = e.code;
  } finally {
    process.argv = argv;
    exit.mockRestore();
    out.mockRestore();
    err.mockRestore();
    vi.unstubAllEnvs();
  }
  await settled();
  return { flights: flightsOf(wire.read()), said: said.join("\n"), exit: code };
}

/** The tables each flight's statements name, flight by flight. */
const tablesOf = (flights: readonly PgWireFlight[]): string[][] =>
  flights.map((f) => [...new Set(f.statements.flatMap((s) => namedBy(s).reads))].sort());

describe("the operator's commands bind what they repair to its account (their own files, real Postgres)", () => {
  let seed: OwnedDb;
  let db: OwnedDb["db"];
  let a: Owned;
  let b: Owned;

  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_operator");
    seed = makeOwnedDb(DB);
    db = seed.db;
  }, 120_000);

  beforeEach(async () => {
    await truncateAll(DB);
    const made: Owned[] = [];
    for (let i = 0; i < 2; i++) {
      const [acct] = await db.insert(accounts).values({ name: `operator-${randomUUID().slice(0, 8)}` }).returning();
      const [mb] = await db.insert(mailboxes)
        .values({ accountId: acct!.id, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
      // A conversation whose stored name still carries a forward's prefix: what the name heal renames.
      const [t] = await db.insert(threads).values({
        accountId: acct!.id, subject: `WG: the quarterly figures ${i}`, rootMessageIdHeader: `${randomUUID()}@trafficflow.test`,
      }).returning();
      made.push({ accountId: acct!.id, mailboxId: mb!.id, threadId: t!.id });
    }
    [a, b] = made as [Owned, Owned];
  }, ISOLATED_DB_RESET_BUDGET_MS);

  afterAll(async () => { await seed.close(); });

  /** Nothing the command wrote is outside what the organizer's doors admit, and nothing is of what they still owe. */
  const admitted = (flights: readonly PgWireFlight[]): void => {
    const owed = new Set<string>();
    expect(refusedOf("worker", flights, [], owed)).toEqual([]);
    expect([...owed]).toEqual([]);
  };

  /**
   * A command told one mailbox: the mailbox's row is read once, in a flight that names no account;
   * every flight that names an account names the one that row carries; nothing carries B's ids.
   */
  const forItsMailbox = (flights: readonly PgWireFlight[]): PgWireFlight[] => {
    admitted(flights);
    const unnamed = flights.filter((f) => doorOf(f) === "nothing");
    expect(tablesOf(unnamed)).toEqual([["mailboxes"]]);
    expect(carries(unnamed[0]!, a.mailboxId)).toBe(true);
    const named = flights.filter((f) => f.account !== null);
    expect(named.map((f) => f.account)).toEqual(named.map(() => a.accountId));
    expect(flights.some((f) => carries(f, b.mailboxId) || carries(f, b.accountId) || f.account === b.accountId)).toBe(false);
    return named;
  };

  it("the blank repair, told A's mailbox: the row on the view that names none, its count of blank letters under A", async () => {
    const r = await run("run-blank-repair", ["--mailbox", a.mailboxId]);
    expect(r.exit, r.said).toBe(0);
    expect(r.said).toContain("DRY RUN");
    const named = forItsMailbox(r.flights);
    expect(named.length).toBeGreaterThan(0);
    expect(named.some((f) => carries(f, a.mailboxId))).toBe(true);
  }, 60_000);

  it("the restore of redacted bodies, told A's mailbox: its count of bodies under A", async () => {
    const r = await run("run-redacted-restore", ["--mailbox", a.mailboxId]);
    expect(r.exit, r.said).toBe(0);
    expect(r.said).toContain("still-redacted bodies: 0");
    const named = forItsMailbox(r.flights);
    expect(tablesOf(named)).toEqual([["message_bodies", "messages"]]);
    expect(carries(named[0]!, a.mailboxId)).toBe(true);
  }, 60_000);

  it("the sweep to Junk, told A's mailbox: the mailbox's credential is read under A", async () => {
    // No credential is stored here: the command reads for one, finds none and stops before it dials.
    const r = await run("run-junk-sweep", ["--mailbox", a.mailboxId]);
    expect(r.exit, r.said).toBe(2);
    expect(r.said).toContain("no imap credentials for this mailbox");
    const named = forItsMailbox(r.flights);
    expect(tablesOf(named)).toEqual([["mailbox_credentials"]]);
    expect(carries(named[0]!, a.mailboxId)).toBe(true);
  }, 60_000);

  it("a mailbox id no row answers binds nothing: one look on the view that names none, and no flight names an account", async () => {
    for (const command of ["run-blank-repair", "run-redacted-restore", "run-junk-sweep"] as const) {
      const r = await run(command, ["--mailbox", randomUUID()]);
      expect(r.exit, `${command}: ${r.said}`).toBe(2);
      expect(r.said, command).toContain("no mailbox");
      admitted(r.flights);
      expect(tablesOf(r.flights.filter((f) => doorOf(f) === "nothing")), command).toEqual([["mailboxes"]]);
      expect(r.flights.filter((f) => f.account !== null), command).toEqual([]);
    }
  }, 120_000);

  /**
   * A command that walks every account: the accounts are read once, in a flight that names none;
   * every other statement rides a flight that names A or B; each account is worked on.
   */
  const perAccount = (flights: readonly PgWireFlight[]): PgWireFlight[] => {
    admitted(flights);
    expect(tablesOf(flights.filter((f) => doorOf(f) === "nothing"))).toEqual([["accounts"]]);
    const named = flights.filter((f) => f.account !== null);
    expect(new Set(named.map((f) => f.account))).toEqual(new Set([a.accountId, b.accountId]));
    return named;
  };

  it("the thread-name heal renames A's conversation under A and B's under B", async () => {
    const dry = await run("run-thread-subject-heal", []);
    expect(dry.exit, dry.said).toBe(0);
    expect(dry.said).toContain("DRY RUN — would heal 2 thread names");
    perAccount(dry.flights);

    const r = await run("run-thread-subject-heal", ["--apply"]);
    expect(r.exit, r.said).toBe(0);
    expect(r.said).toContain("healed 2 thread names");
    const named = perAccount(r.flights);
    // Each conversation is named only in flights of its own account, and is written there.
    for (const [own, other] of [[a, b], [b, a]] as const) {
      const theirs = named.filter((f) => carries(f, own.threadId));
      expect(theirs.map((f) => f.account)).toEqual(theirs.map(() => own.accountId));
      expect(theirs.some((f) => f.door === "write" && f.statements.some((s) => namedBy(s).writes === "threads"))).toBe(true);
      expect(theirs.some((f) => carries(f, other.threadId))).toBe(false);
      const [row] = await db.select({ subject: threads.subject }).from(threads).where(eq(threads.id, own.threadId));
      expect(row!.subject).toMatch(/^the quarterly figures \d$/);
    }
  }, 120_000);

  it("the conversation heal looks for split conversations in A under A and in B under B", async () => {
    const r = await run("run-thread-join-heal", []);
    expect(r.exit, r.said).toBe(0);
    expect(r.said).toContain("DRY RUN — would merge 0 split threads");
    const named = perAccount(r.flights);
    // The search for conversations under one name is asked once for each account, of that account's own.
    for (const who of [a, b]) {
      const theirs = named.filter((f) => f.account === who.accountId && f.statements.some((s) => namedBy(s).reads.includes("threads")));
      expect(theirs.length).toBeGreaterThan(0);
      expect(theirs.every((f) => carries(f, who.accountId))).toBe(true);
    }
  }, 60_000);

  it("the sender-name backfill reads A's letters under A and B's under B", async () => {
    const r = await run("run-sender-name-backfill", ["--max=50"]);
    expect(r.exit, r.said).toBe(0);
    expect(r.said).toContain("DRY RUN — would backfill 0 messages");
    const named = perAccount(r.flights);
    for (const who of [a, b]) {
      const theirs = named.filter((f) => f.account === who.accountId);
      expect(tablesOf(theirs)).toEqual(theirs.map(() => ["message_bodies", "messages"]));
      expect(theirs.every((f) => carries(f, who.accountId))).toBe(true);
    }
  }, 60_000);
});
