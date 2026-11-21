/**
 * ONE DOOR INTO THE PHONE'S STORE — measured on the composition a device runs.
 *
 * The device store is one serialized connection behind a drizzle sqlite-proxy, and that proxy
 * issues `begin`, the statements and `commit` as SEPARATE calls. `oneTransactionAtATime` queues
 * whole transactions; a statement issued straight on the handle is not in that queue, so it lands
 * between somebody else's `begin` and their `rollback` and is undone after its caller was told it
 * succeeded. The person sees the edit, reloads, and it is gone.
 *
 * The announcement half has the same root on the read side: the dialect's own contract says a
 * notification is "delivered when the transaction commits", and the SQLite arm delivered it at the
 * call, so a listener could be woken for a row that rolled back.
 *
 * ── THE FIXTURE'S ONE CONTRIBUTION IS THE YIELD ───────────────────────────────────────────
 *
 * `node:sqlite` is SYNCHRONOUS, so a double built straight onto it cannot express the interleaving
 * the device's asynchronous driver has: with no yield the hazard is unreachable here and this file
 * would be green against the shipped code. Awaiting a macrotask in every call is what makes the
 * queue load-bearing rather than decorative — the reason `phone-engine-boot.test.ts` gives for the
 * same fixture.
 *
 * ── IT RUNS UNDER THE SQLITE PROJECT, AND THE OTHER RUN SAYS SO ───────────────────────────
 *
 * The services are typed against the server twin and the device twin is substituted by
 * `test/vitest.sqlite.config.ts`; under the default project the first statement dies on
 * `gen_random_uuid`. So the default run gets a PREMISE CASE rather than a silent skip.
 */
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { snippets } from "@trafficflow/db";
import { dialect, onLocalNotify } from "@trafficflow/db/dialect";
import { dbFor, snippetsService, type ServiceContext } from "@trafficflow/services";
import { openPhoneStore, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import type { LocalDb } from "../src/db.js";

/* `node:sqlite` through `createRequire` for the reason the sibling suites state: this bundler's
   builtin list predates it, and a static import resolves the bare name to a package that is not
   there. */
const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

/** Fixed so a failure names the same row twice. The device twin stores ids as text. */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const SNIPPET = "22222222-2222-4222-8222-222222222222";

/** `node:sqlite` behind {@link PhoneSqlExecutor}, with a real yield in every call. */
function nodeExecutor(): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const statement = raw.prepare(sql);
        // The STATEMENT's columns, never the row object's keys: two columns of one name collapse
        // to a single key and positional mapping would then fill both slots from one value.
        const columns = (statement.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
        const objects = statement.all(...(params as unknown[])) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => { await yielded(); raw.prepare(sql).run(...(params as unknown[])); });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[]));
          raw.exec("COMMIT");
        } catch (err) {
          raw.exec("ROLLBACK");
          throw err;
        }
      });
    },
    async close(): Promise<void> { raw.close(); },
  };
}

let open: Awaited<ReturnType<typeof openPhoneStore>> | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

/** The device store, plus the service context a request's handler would build. */
async function phoneStore(): Promise<{ db: LocalDb; ctx: ServiceContext }> {
  open = await openPhoneStore(nodeExecutor());
  const db = open.db;
  const ctx: ServiceContext = {
    db: dbFor(db, ACCOUNT),
    accountId: ACCOUNT,
    userId: null,
    now: () => new Date(1_760_000_000_000),
    requestId: "phone-write-door",
  };
  return { db, ctx };
}

/** One snippet, as the person saved it before this request. */
async function seedSnippet(db: LocalDb): Promise<void> {
  await db.insert(snippets).values({
    id: SNIPPET, accountId: ACCOUNT, title: "original", body: "the text as saved before",
  });
}

/** Long enough for a statement dispatched and not awaited to reach the store. */
const settle = (ms = 60): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe("this file's premise, in the run that cannot exercise it", () => {
  it.runIf(!ON_DEVICE_STORE)("states it, so it cannot pass here by contributing nothing", () => {
    // Not a skip. If the default project ever gains the device substitution this fails and the
    // cases below should move here; if the expectation is unset it fails too.
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("a save while a sync transaction is open on the phone's store", () => {
  it("is not acknowledged unless it survives — the other transaction rolls back", async () => {
    const { db, ctx } = await phoneStore();
    await seedSnippet(db);

    // The sync transaction: open, hold, then fail. `started` fires after a real statement, so
    // `begin` has certainly reached the store before the save is dispatched.
    let started = (): void => {};
    let mayFail = (): void => {};
    const hasBegun = new Promise<void>((r) => { started = r; });
    const release = new Promise<void>((r) => { mayFail = r; });
    const sync = db.transaction(async (tx) => {
      await tx.update(snippets).set({ body: "what the sync was writing" })
        .where(eq(snippets.id, SNIPPET));
      started();
      await release;
      throw new Error("the sync failed");
    }).catch((err: unknown) => err);

    await hasBegun;
    // Dispatched, NOT awaited: through the queue this waits for the sync to settle, and awaiting
    // it here would deadlock against the release below.
    const acknowledged = snippetsService.update(ctx, SNIPPET, {
      title: "edited", body: "the text the person typed", shortcut: null,
    });
    await settle();
    mayFail();
    expect(await sync).toBeInstanceOf(Error);

    const ack = await acknowledged;
    const stored = await snippetsService.get(ctx, SNIPPET);
    // THE INVARIANT: what the person was told was saved is what the store holds.
    expect(stored.body, "the save was acknowledged and then rolled back under it").toBe(ack.body);
    expect(stored.title).toBe("edited");
  });

  it("saves and keeps an ordinary edit with nothing else in flight", async () => {
    const { db, ctx } = await phoneStore();
    await seedSnippet(db);

    const ack = await snippetsService.update(ctx, SNIPPET, {
      title: "edited", body: "the text the person typed", shortcut: "sig",
    });
    expect(ack.title).toBe("edited");
    const stored = await snippetsService.get(ctx, SNIPPET);
    expect(stored).toMatchObject({
      title: "edited", body: "the text the person typed", shortcut: "sig",
    });
  });
});

describe.runIf(ON_DEVICE_STORE)("an announcement made inside a transaction on the phone's store", () => {
  const CHANNEL = "phone_write_door_probe";

  it("reaches no listener when the transaction rolls back", async () => {
    const { db } = await phoneStore();
    const seen: string[] = [];
    const stop = onLocalNotify(CHANNEL, (p) => { seen.push(p); });
    try {
      const failed = await db.transaction(async (tx) => {
        await dialect(db).notify(tx, CHANNEL, "account:rolled-back");
        throw new Error("the transaction failed");
      }).catch((err: unknown) => err);
      expect(failed).toBeInstanceOf(Error);
      expect(seen, "a listener was woken for work that rolled back").toEqual([]);
    } finally {
      stop();
    }
  });

  it("reaches the listener once the transaction commits, and not before", async () => {
    const { db } = await phoneStore();
    const seen: string[] = [];
    const stop = onLocalNotify(CHANNEL, (p) => { seen.push(p); });
    try {
      await db.transaction(async (tx) => {
        await dialect(db).notify(tx, CHANNEL, "account:committed");
        expect(seen, "delivered before the transaction had committed").toEqual([]);
      });
      expect(seen).toEqual(["account:committed"]);
    } finally {
      stop();
    }
  });

  it("discards a savepoint's announcements and keeps the ones around it", async () => {
    // A nested `transaction` is a SAVEPOINT, and releasing one is not a commit. The outer's
    // announcements ride to commit; the rolled-back savepoint's are dropped.
    const { db } = await phoneStore();
    const seen: string[] = [];
    const stop = onLocalNotify(CHANNEL, (p) => { seen.push(p); });
    try {
      await db.transaction(async (tx) => {
        await dialect(db).notify(tx, CHANNEL, "outer:before");
        await tx.transaction(async (inner) => {
          await dialect(db).notify(inner, CHANNEL, "inner:dropped");
          throw new Error("the savepoint failed");
        }).catch(() => undefined);
        await dialect(db).notify(tx, CHANNEL, "outer:after");
      });
      expect(seen).toEqual(["outer:before", "outer:after"]);
    } finally {
      stop();
    }
  });
});
