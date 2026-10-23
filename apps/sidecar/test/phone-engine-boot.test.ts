/**
 * THE ENGINE BOOTS IN A PHONE'S COMPOSITION AND ANSWERS — over SQLite, through the real seam.
 *
 * `startPhoneEngine` is the phone's `main.ts`: it opens the device store, hands it to the SAME
 * `createSidecar` the desktop composes, and returns `handle(req)` instead of a stdio frame stream.
 * This file drives it exactly as the app will, with the platform half swapped for `node:sqlite`
 * behind the same `PhoneSqlExecutor` contract expo-sqlite implements.
 *
 * ── "READY" IS AN ANSWER, NOT A RESOLVED PROMISE ──────────────────────────────────────────
 *
 * The proof of a booted engine is a REQUEST THAT COMES BACK, and the distinction is not pedantic.
 * The standalone spike's own finding was that "the process is alive" proves nothing about the
 * engine: the composition can resolve with a store that never migrated, an app with no routes, or
 * a session token nothing accepts, and every one of those is indistinguishable from a healthy boot
 * until the first request. So the first case here awaits `handle()` and reads the body.
 *
 * ── WHAT THIS FILE CANNOT PROVE, STATED SO NOBODY READS IT AS COVERAGE ────────────────────
 *
 * No socket is opened: the adapter is a double, so nothing here proves the transport, the claim
 * this phone writes, or the first sync. Those are the device criteria and they are measured on a
 * real build against a private mail server — this file's job is the composition, the refusals and
 * the store's transaction discipline, which are the parts a device run cannot isolate.
 *
 * ── IT LIVES IN `apps/sidecar/test`, NOT BESIDE THE APP, AND THAT WAS NOT THE FIRST GUESS ─
 *
 * `apps/sidecar/src/mobile.ts` is the module under test, so this is its package. It was written in
 * `apps/mobile/test` first and two of that app's own rules refused it, both correctly: the privacy
 * census forbids the string `trafficflow` anywhere under `apps/mobile` (the phone app is an
 * `@ohmail/*` client, and naming the server workspace there is the beginning of depending on it),
 * and the app's tsconfig cannot resolve those types because it has no such dependency. A test that
 * needed a dependency added to the phone app in order to be expressible was the wrong test in the
 * wrong place.
 *
 * The cost of moving it is worth stating: this package has no `typecheck` script, so nothing
 * typechecks this file. Its evidence is therefore that it RAN by name, that each mutation reddened
 * exactly one assertion, and an explicit `tsc --noEmit` recorded in the commit body.
 *
 * ── IT RUNS UNDER THE SQLITE PROJECT, AND THE OTHER RUN SAYS SO RATHER THAN SKIPPING ──────
 *
 * The services import their tables from the shared barrel and are typed against the SERVER's twin.
 * The device twin is substituted at the module the barrel itself reaches, and that substitution
 * lives in `vitest.sqlite.config.ts` — so under the default project this composition would run the
 * server's column types against a SQLite store. Measured, and it is not a subtle failure: the first
 * statement dies with `no such function: gen_random_uuid`, because the server twin's id columns
 * carry a Postgres default the other store has never heard of.
 *
 * So the default run gets a PREMISE CASE instead of a skip. It asserts that the substitution is
 * genuinely absent there — which fails if the default project ever starts substituting, and fails
 * if the expectation is unset — rather than quietly reporting nothing. A file that can silently
 * contribute nothing to a run is how a suite ends up green with the thing it tests unexercised.
 */
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  TRANSACTION_WAIT_MS,
  loggerOver,
  openPhoneStore,
  phoneOneClickPost,
  startPhoneEngine,
  startPhoneEngineFromSealed,
  type PhoneEngine,
  type PhoneSqlExecutor,
  type PhoneSqlRows,
} from "../src/mobile.js";
/* THE CONSTANT, imported rather than retyped. A guard that writes and reads a name it invented
   proves persistence for nothing the code uses — measured in this repository on a store key that
   was asserted under one spelling while the engine stamped another, green with the real key's
   persistence lost. */
import { SQLITE_MIGRATIONS_TABLE } from "@trafficflow/db/sqlite-migrate";
import { SQLITE_JOURNAL } from "@ohmail/db-mail/sqlite-journal";
import { WORKER_NET_TIMEOUTS } from "@trafficflow/core/adapters/imap";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import { startEngineVitals } from "../src/vitals.js";
import { loadRefusals, type ProviderRefusal } from "../../../packages/core/test/adapters/_providershape.js";

/* `node:sqlite` through `createRequire` for the reason the other suites state: this bundler's
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

interface Recorded {
  /** Every call, in the order it was DISPATCHED — the order assertion's evidence. */
  readonly calls: string[];
  /** Statement counts per `batch` call, so "a transaction is one call" is an assertion. */
  readonly batches: number[];
  closed: number;
}

/**
 * `node:sqlite` behind {@link PhoneSqlExecutor}, WITH A REAL YIELD IN EVERY CALL.
 *
 * The yield is the fixture's whole contribution beyond a handle, and it is the thing the ruling's
 * own amendment insists on: `node:sqlite`'s driver is SYNCHRONOUS, so a double built straight onto
 * it cannot express the hazard the device's asynchronous driver has — remove the serialization and
 * a synchronous double stays green while the device path loses an update. Awaiting a macrotask
 * before every statement makes the interleaving reachable here, so the queue below is exercised
 * rather than decorative.
 *
 * `path` defaults to memory, which is what every case that boots once wants. A case about the
 * SECOND launch has to name a file: a relaunch's whole question is what the first launch wrote
 * down, and an in-memory store answers it by having forgotten everything.
 */
function nodeExecutor(rec: Recorded, path = ":memory:"): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(path);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        rec.calls.push(`all:${sql.slice(0, 24)}`);
        await yielded();
        const statement = raw.prepare(sql);
        /* THE STATEMENT'S columns, not the row object's keys. Two columns of one name collapse to
           a single key in the driver's own answer, and positional mapping would then fill both
           slots from one value — a full-length row carrying the wrong data, which nothing errors
           on. This is the conversion the contract says belongs to the implementation. */
        const columns = (statement.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
        const objects = statement.all(...(params as unknown[])) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => {
        rec.calls.push(`run:${sql.slice(0, 24)}`);
        await yielded();
        raw.prepare(sql).run(...(params as unknown[]));
      });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        rec.calls.push(`batch(${statements.length})`);
        rec.batches.push(statements.length);
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
    async close(): Promise<void> {
      rec.closed += 1;
      raw.close();
    },
  };
}

const recorder = (): Recorded => ({ calls: [], batches: [], closed: 0 });

/** What the composition handed the adapter, and whether anything ever dialled it. */
interface Dialled {
  /** Every config the factory was built with, in order. */
  readonly configs: ImapConfig[];
  /** How many times something opened a connection. Nobody outside this file calls it. */
  connects: number;
}

/**
 * AN ADAPTER DOUBLE THAT RECORDS ITS OWN DIAL.
 *
 * `connect()` is the first thing the runtime awaits, so counting it is how "the engine started
 * itself" becomes an observation rather than a field read back off the object that wrote it. What
 * happens after it is deliberately not implemented: the launch then fails, the engine logs it and
 * arms the poll, and none of that is what these cases are about.
 *
 * ── AND UNTIL THIS SLICE THE FACTORY WAS BEING DROPPED ON THE FLOOR ───────────────────────
 *
 * `deps()` above has always passed an `adapterFactory`, and this file's banner says "no socket is
 * opened: the adapter is a double". The composition never forwarded it, so that sentence was
 * false — harmless only for as long as nothing in this composition started the engine, which is
 * exactly what changed. It is forwarded now, and these cases are what would notice if it stopped.
 */
function dialRecorder(rec: Dialled): (cfg: ImapConfig) => never {
  return ((cfg: ImapConfig) => {
    rec.configs.push(cfg);
    return {
      connect: async (): Promise<void> => { rec.connects += 1; },
      close: async (): Promise<void> => undefined,
    };
  }) as unknown as (cfg: ImapConfig) => never;
}

/** Give the launch a moment to reach the adapter. It is a `void` call, not an awaited one. */
async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** The minimum a phone must supply. Anything a case is about is overridden per case. */
function deps(exec: PhoneSqlExecutor, over: Record<string, unknown> = {}): Parameters<typeof startPhoneEngine>[0] {
  return {
    exec,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: "Pixel 9",
    installId: "install-marker-abc",
    /* No socket is opened anywhere in this file. The double is the same shape the sidecar's own
       boot suites use, and its presence is what routes the submission probe through a double too.
       It signs in, which Connect needs before it opens a mailbox, and no more. */
    adapterFactory: () => ({ connect: async () => undefined, close: async () => undefined }) as unknown as MailboxAdapter,
    ...over,
  } as Parameters<typeof startPhoneEngine>[0];
}

/**
 * WHICH STORE THIS RUN IS ABOUT, declared by the project rather than sniffed. Both projects set it,
 * so "no expectation" is a failure and never a state a run can be in.
 */
const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

let live: PhoneEngine | null = null;
afterEach(async () => {
  /* Closed in `afterEach` rather than per case: a failed assertion on a live engine would otherwise
     leave a store and a timer behind, and the suite's next file inherits them. */
  if (live) await live.stop().catch(() => undefined);
  live = null;
});

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    // Not a skip and not decoration. If the default project ever gains the device substitution,
    // this fails and the phone cases below should move here; if the expectation is unset, this
    // fails too, which is the state the two projects exist to make impossible.
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("the engine, composed for a phone", () => {
  it("carries the app's build commit as the engine's own build identity", async () => {
    /* The loop's version label on this door: a written-off message is read again by the next build
       only where the label changes (REVIEW-026-PHONE-ONE-MESSAGE-B L2). `/health` names it. */
    const sha = "0123456789abcdef0123456789abcdef01234567";
    live = await startPhoneEngine(deps(nodeExecutor(recorder()), { buildCommit: sha }));
    const health = await live.handle(
      new Request("http://sidecar/health", { headers: { authorization: `Bearer ${live.sessionToken}` } }),
    );
    expect(((await health.json()) as { buildCommit?: string }).buildCommit).toBe(sha);
  });

  it("boots over SQLite and ANSWERS a request — not merely resolves", async () => {
    const rec = recorder();
    const exec = nodeExecutor(rec);
    live = await startPhoneEngine(deps(exec));

    // A bearer exists and is per-launch. The in-app client sends this; a composition with an empty
    // one boots and then refuses every request it is given.
    expect(live.sessionToken.length).toBeGreaterThan(16);

    const res = await live.handle(
      new Request("http://sidecar/hello", { headers: { authorization: `Bearer ${live.sessionToken}` } }),
    );

    // THE ASSERTION THIS FILE EXISTS FOR. A 200 whose body is the engine's OWN payload means the
    // store migrated, the route table is mounted and the session was accepted — three things "the
    // promise resolved" does not distinguish between, and three things a 200 with an empty body
    // would not either.
    expect(res.status).toBe(200);
    const hello = (await res.json()) as { product?: string; flavor?: string };
    expect(hello.product).toBe("ohmail");
    // The local door's own flavor. A composition that had somehow come up as the hosted or the
    // desktop-host door would answer something else here.
    expect(hello.flavor).toBe("local");

    /**
     * AND `/health` AGREES WITH IT, which it did not when this file was written.
     *
     * Measured then: 503 `database_unreachable`, `dbLatencyMs: 0`, `dbProvider: null` — on a
     * composition that was serving mail through the very same store. The census statement reads
     * five Postgres catalogs, threw on this store, and the route's `catch` cannot tell "the query
     * could not run here" from "the database is gone". A person would have been shown a false
     * state about their own mail.
     *
     * Asserted BESIDE `/hello` rather than instead of it: the two answer different questions, and
     * the failure being guarded against is precisely the two disagreeing.
     */
    const health = await live.handle(
      new Request("http://sidecar/health", { headers: { authorization: `Bearer ${live.sessionToken}` } }),
    );
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok?: boolean; dbProvider?: string | null; schemaOk?: unknown };
    expect(body.ok).toBe(true);
    // NAMED, not null: on this arm there is no schema census in the body, so the provider is the
    // only field that says why — and null there reads as "this host does not know".
    expect(body.dbProvider).toBe("sqlite");
    // And the Postgres-catalog readings are ABSENT rather than reported as zero: `found: 0` against
    // an expectation would read as a broken schema on a store whose schema is fine.
    expect(body.schemaOk).toBeUndefined();

    // AND IT ANSWERED FROM THE DEVICE STORE, not from something that merely accepted statements.
    // The device migrator ran through this statement runner, so its own bookkeeping table exists and holds
    // the entries it applied. The SERVER's journal is adopted by the desktop's store module, which
    // this composition does not contain at all — so a store carrying the server's ledger instead
    // would mean the wrong module had opened it.
    const applied = await exec.all(`select count(*) as n from ${SQLITE_MIGRATIONS_TABLE}`, []);
    expect(applied.columns).toEqual(["n"]);
    expect(Number(applied.rows[0]?.[0] ?? 0)).toBeGreaterThan(0);
  }, 120_000);

  /**
   * THE TRANSACTION HAZARD, WATCHED — and the case that falsified an amendment.
   *
   * The ruling says to wrap a drain page in one `batch` transaction "through the runner's seam;
   * `drizzle-orm/sqlite-proxy` supports it (`sqlite-proxy/session.js:40`)". Measured here on the
   * real composition's boot: 132 runner calls, ONE `begin`, ONE `commit`, and ZERO `batch` calls.
   * Line 40 of that file is `transaction()`, which issues `begin`, the body and `commit` as
   * separate calls through the ORDINARY callback; the batch callback serves `db.batch([...])`,
   * which the services never call.
   *
   * So the hazard the amendment meant to close is live unless something else closes it, and what
   * closes it is `oneTransactionAtATime` in `mobile.ts` — a mutex on the HANDLE's `transaction`,
   * which is the only place with the caller's context. This case is that mutex watched doing
   * something, by the ORDER of the writes rather than by a flag.
   */
  it("serializes two overlapping transactions instead of letting the store refuse one", async () => {
    const rec = recorder();
    const exec = nodeExecutor(rec);
    /* THE HANDLE, not the statement runner — and the distinction is the whole case.
     *
     * The first version of this drove `exec.batch(...)` and stayed GREEN with the mutex removed,
     * because a direct `batch` call rides the EXECUTOR's queue and never reaches the handle's
     * `transaction` at all. It measured a second mechanism covering for the one under test. What
     * the engine actually calls is `db.transaction(...)`, so that is what this drives. */
    const opened = await openPhoneStore(exec);
    const db = opened.db as unknown as {
      transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void>;
    };

    /* Two transactions started in the SAME TICK, each holding open across an await — the shape
     * that interleaves. The BODIES do no SQL on purpose: drizzle issues `begin` before the body
     * and `commit` after it whatever the body does, so the interleaving under test is entirely in
     * those two statements and the case needs no schema and no `drizzle-orm` import (this app does
     * not depend on it, and a test must not add a dependency to make itself expressible). */
    const span: string[] = [];
    const tx = (who: string): Promise<void> =>
      db.transaction(async () => {
        span.push(`enter:${who}`);
        await new Promise((r) => setTimeout(r, 0));
        span.push(`exit:${who}`);
      });
    /* From HERE, so the migrator's own transaction (it wraps the journal in one) is not counted.
       Measured: without this the marker list is six entries and the case fails for a reason that
       has nothing to do with the mutex. */
    const before = rec.calls.length;
    const settled = await Promise.allSettled([tx("one"), tx("two")]);

    // Neither is REFUSED. Without the mutex the second `begin` lands inside the first
    // transaction and the store answers "cannot start a transaction within a transaction",
    // losing that writer's work.
    expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    // THE ORDER, not a flag: one transaction finishes before the other starts.
    expect(span).toEqual(["enter:one", "exit:one", "enter:two", "exit:two"]);

    // And the same fact read from the STORE's side, which is the half a flag could not fake: the
    // runner saw begin/commit, begin/commit — never two `begin`s before a `commit`.
    const markers = rec.calls
      .slice(before)
      .map((c) => c.replace(/^(all|run):/, "").trim().toLowerCase())
      .filter((c) => c.startsWith("begin") || c.startsWith("commit") || c.startsWith("rollback"));
    expect(markers).toEqual(["begin", "commit", "begin", "commit"]);

    await opened.close();
  }, 120_000);

  it("serializes overlapping work and preserves the ORDER of the writes", async () => {
    const rec = recorder();
    const exec = nodeExecutor(rec);
    live = await startPhoneEngine(deps(exec));
    const before = rec.calls.length;

    // Two callers in one tick, each with an await inside. Asserted by the ORDER of the recorded
    // calls rather than by a flag: with the queue removed, the driver's own yield interleaves them
    // and the two `run`s appear between the two `all`s.
    await Promise.all([
      exec.run("create table if not exists probe_a (v integer)", []),
      exec.run("create table if not exists probe_b (v integer)", []),
    ]);
    const after = rec.calls.slice(before);

    expect(after).toEqual([
      "run:create table if not exis",
      "run:create table if not exis",
    ]);
  }, 120_000);

  /**
   * A NESTED TRANSACTION EITHER WORKS OR REFUSES BY NAME. IT NEVER HANGS.
   *
   * Two shapes, and the difference is which object the inner transaction is opened on:
   *
   *  · on the TRANSACTION OBJECT, which the driver renders as a savepoint. It never reaches the
   *    mutex and must simply work — the ordinary nested case, and the positive control without
   *    which the case below would pass over a store that refused all nesting.
   *  · on the HANDLE, from inside a body. That queues behind a transaction that cannot finish
   *    until the inner one returns, which is a deadlock. A hang is the worst of the three possible
   *    outcomes: indistinguishable from a slow mail server, holding the store for every later
   *    caller, and naming nothing. So the wait is bounded and the refusal says what to look for.
   */
  it("admits a nested transaction opened on the transaction object", async () => {
    const rec = recorder();
    const exec = nodeExecutor(rec);
    const opened = await openPhoneStore(exec, 1_000);
    const db = opened.db as unknown as {
      transaction: (fn: (tx: { transaction: (f: () => Promise<void>) => Promise<void> }) => Promise<void>) => Promise<void>;
    };

    const span: string[] = [];
    await db.transaction(async (tx) => {
      span.push("outer");
      await tx.transaction(async () => { span.push("inner"); });
      span.push("outer-end");
    });

    expect(span).toEqual(["outer", "inner", "outer-end"]);
    // The driver's own spelling for a nested transaction, which is what makes it reach no mutex.
    const text = rec.calls.join(" ").toLowerCase();
    expect(text).toContain("savepoint");
    await opened.close();
  }, 120_000);

  it("refuses a transaction opened on the HANDLE from inside a body, by name and in bounded time", async () => {
    const rec = recorder();
    const exec = nodeExecutor(rec);
    /* One second rather than the shipped thirty: a guard that proved a bound by waiting it out
       would take half a minute to pass and nobody would run it. The seam exists for this and
       production passes nothing. */
    const opened = await openPhoneStore(exec, 1_000);
    const db = opened.db as unknown as {
      transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void>;
    };

    const started = Date.now();
    const outcome = await db
      .transaction(async () => {
        // The mistake under test: the HANDLE, from inside a body.
        await db.transaction(async () => undefined);
      })
      .then(() => "resolved", (e: unknown) => {
        // Marked as the store's own refusal (never the message's); the sentence is its cause.
        expect((e as Error).name).toBe("StoreStatementFaultError");
        return ((e as Error).cause as Error).message;
      });
    const elapsed = Date.now() - started;

    // NAMED: the message says which mistake this is and what to do instead, because the symptom
    // otherwise arrives as a store that has stopped answering.
    expect(outcome).toContain("one transaction at a time");
    expect(outcome).toContain("nested transaction must be");
    // BOUNDED: it came back. The generous ceiling is the point — this asserts "not a hang", not a
    // latency figure, so it cannot go flaky on a loaded machine.
    expect(elapsed).toBeLessThan(15_000);
    // And the shipped bound is the one production uses, not the test's.
    expect(TRANSACTION_WAIT_MS).toBeGreaterThan(5_000);
    await opened.close();
  }, 120_000);

  /**
   * ONE-CLICK UNSUBSCRIBE REFUSES BY NAME, AND NOTHING LEAVES THE DEVICE.
   *
   * Without this arm the tap reaches `node:http` — a thrower — and the person is shown a sentence
   * about a Node process instead of an answer about their mail. The refusal is a THROW rather than
   * a status because the service's own error path is what makes that correct: it records the
   * attempt as `failed`, does not retry it (at-most-once: nothing can tell whether the sender
   * received it), and re-throws.
   */
  it("refuses one-click unsubscribe by name, and sends nothing", async () => {
    const err = await phoneOneClickPost
      .post("https://sender.example/unsubscribe", ["93:..."])
      .then(() => null, (e: unknown) => e as Error);

    // NAMED, and named about the person's mail rather than about a module.
    expect(err?.message).toMatch(/not available on this phone yet/);
    expect(err?.message).toMatch(/Nothing was sent/);
    // It must not read like a transport fault, which is what would send somebody to their network.
    expect(err?.message).not.toMatch(/node:|Node process|ECONN|DNS/);
  });

  it("makes NO request when it refuses — asserted, not asserted-about", async () => {
    /* The control the refusal's own comment promises. `fetch` and the two HTTP builtins are the
       only ways anything could leave, so the global is replaced and counted: a future edit that
       "helpfully" wired a pass-through here would fail this case rather than quietly start posting
       to a sender-chosen address from inside somebody's home network. */
    const original = globalThis.fetch;
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = (): never => {
      calls += 1;
      throw new Error("no request may leave the device on this path");
    };
    try {
      await phoneOneClickPost.post("https://sender.example/unsubscribe", []).catch(() => undefined);
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
    expect(calls).toBe(0);
  });

  it("closes the store when it stops", async () => {
    const rec = recorder();
    const engine = await startPhoneEngine(deps(nodeExecutor(rec)));
    await engine.stop();
    expect(rec.closed).toBeGreaterThan(0);
  }, 120_000);

  describe("refusals — each names the thing that is wrong", () => {
    it("refuses a host-mode knob rather than disarming it silently", async () => {
      const rec = recorder();
      await expect(startPhoneEngine(deps(nodeExecutor(rec), { hostMode: true })))
        .rejects.toThrow(/no host door.*hostMode/s);
      // Nothing was composed: the refusal happens before the store is touched, so a caller that is
      // wrong about what kind of install it is has not written anything.
      expect(rec.calls).toEqual([]);
    });

    it("refuses every host-only knob, by name", async () => {
      for (const knob of ["hostOrigin", "hostPort", "hostAssetsDir", "lanBind"]) {
        const rec = recorder();
        await expect(startPhoneEngine(deps(nodeExecutor(rec), { [knob]: knob === "hostPort" ? 8028 : "x" })))
          .rejects.toThrow(new RegExp(knob));
      }
    });

    it("refuses an empty machineName — there is no hostname to fall back to", async () => {
      const rec = recorder();
      await expect(startPhoneEngine(deps(nodeExecutor(rec), { machineName: "  " })))
        .rejects.toThrow(/machineName is required/);
    });

    it("refuses an empty installId — the lease tells installs apart by it", async () => {
      const rec = recorder();
      await expect(startPhoneEngine(deps(nodeExecutor(rec), { installId: "" })))
        .rejects.toThrow(/installId is required/);
    });

    it("refuses a key ring entry that is not a key, and never echoes it", async () => {
      const rec = recorder();
      const secret = "NOT-A-KEY-BUT-SECRET";
      const err = await startPhoneEngine(deps(nodeExecutor(rec), { keks: { 1: secret } }))
        .then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toMatch(/version 1 is not a 32-byte key/);
      expect(`${err?.message} ${err?.stack ?? ""}`).not.toContain(secret);
    });

    it("ADMITS a well-formed key ring — the positive control for the refusals above", async () => {
      // Without this, every case in this block would pass over a composition that refused ALL key
      // rings, and a phone could never store a password at all.
      const rec = recorder();
      live = await startPhoneEngine(deps(nodeExecutor(rec), { keks: { 1: "a".repeat(64) } }));
      expect(live.sessionToken.length).toBeGreaterThan(16);
    }, 120_000);
  });
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE ENGINE STARTS ITSELF, ON A DEADLINE FIT FOR THE CONNECTION IT HOLDS
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `main.ts` launches the desktop's engine on the line after it builds it. This composition did
   * not, and exposed no way to — so a phone booted, answered its door, said it was organizing, and
   * synchronised nothing for ever with no diagnostic anywhere. Every component worked; the launch
   * was simply never made.
   */
  describe("the launch", () => {
    it("DIALS the mailbox with nobody outside calling anything", async () => {
      const dial: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(nodeExecutor(recorder()), { adapterFactory: dialRecorder(dial) }));
      // Nothing between these two lines. No `start`, no `wake`, no request.
      await settle();
      expect(dial.connects).toBeGreaterThan(0);
    }, 120_000);

    it("hands the adapter the persistent-connection deadline, not the serverless one", async () => {
      /* The engine's default profile documents itself as chosen against a sixty-second serverless
         invocation ceiling — 25 s for a socket opened, used and discarded inside one request. This
         connection is nothing like that: it is held while the app is in the foreground, and one
         fetch pass over a couple of hundred messages was measured at 42 s on a device. Under the
         serverless profile that pass is a dead socket, and what a person sees is a mailbox that
         never finishes opening. */
      const dial: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(nodeExecutor(recorder()), { adapterFactory: dialRecorder(dial) }));
      await settle();
      expect(dial.configs.length).toBeGreaterThan(0);
      expect(dial.configs[0]!.timeouts).toEqual(WORKER_NET_TIMEOUTS);
      // And it is a real profile with a real ceiling, not an empty object that happens to compare
      // equal to another empty object.
      expect(WORKER_NET_TIMEOUTS.socketMs).toBeGreaterThan(60_000);
    }, 120_000);

    it("lets a caller's own timeouts win — it is a default, not an override", async () => {
      // The positive control. Without it the case above would pass over a composition that ignored
      // whatever it was given and always wrote one profile.
      const mine = { ...WORKER_NET_TIMEOUTS, socketMs: 77_000 };
      const dial: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(nodeExecutor(recorder()), {
        adapterFactory: dialRecorder(dial),
        imap: {
          host: "imap.invalid", port: 993, secure: true,
          auth: { user: "a@b.test", pass: "pw-not-used-password-password" },
          timeouts: mine,
        },
      }));
      await settle();
      expect(dial.configs[0]!.timeouts).toEqual(mine);
    }, 120_000);
  });

  /**
   * ══ WHAT A RELAUNCH HAS TO GO ON — the credential the engine sealed for itself ════════════
   *
   * A phone that organizes its own mailbox is killed by its own operating system every day, and
   * the password was typed once on a form that no longer exists. So either the engine kept it or
   * nothing can open that mailbox again, and which of those is true decides the whole shape of the
   * app's relaunch path: a start that supplies a password it stored itself, or a start that
   * supplies none and lets the engine read its own row.
   *
   * `engine.ts` seals on first run behind `durableKey && envPass && !storedLogin()`, and
   * `resolveLogin()` reads the row back and decrypts it. Both of those are statements in a file;
   * these two cases are the measurement, over a store on DISK and two launches of the real
   * composition.
   *
   * THE SECOND CASE IS THE CONTROL and it is the one that decides the design. It supplies no
   * password at all — the shape the relaunch would use — and asserts the dial still carries the
   * one typed on the first launch. Without it, the first case is satisfied by a row nothing reads.
   */
  /**
   * THE ROSTER THE APP'S SETTINGS PANEL IS GATED ON — `GET /mailboxes`, over this door.
   *
   * The app reads it to answer "who organizes this mailbox", and the Settings "This phone" panel
   * and the More screen's banner both draw only behind a SUCCESSFUL read. On a device neither
   * appeared, and the first cause was the app's own envelope (`net/mailboxes.ts` looked for a bare
   * array while the route answers `{ items }`). This case is the other half of that question, asked
   * where it can be answered: does this door serve the route at all, and in that shape?
   */
  describe("the mailbox roster on this door", () => {
    it("answers 200 with `{ items }`, and the row carries the address the app matches on", async () => {
      live = await startPhoneEngine(deps(nodeExecutor(recorder()), {
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "roster@b.test", pass: "pw" } },
        address: "roster@b.test",
      }));
      const res = await live.handle(new Request("http://sidecar/mailboxes", {
        headers: { authorization: `Bearer ${live.sessionToken}` },
      }));
      expect(res.status, "the roster route did not answer on this door").toBe(200);
      const body = (await res.json()) as { items?: { id?: unknown; address?: unknown }[] };
      /* THE ENVELOPE, asserted rather than assumed: the app's reader was written against a bare
         array and answered "could not ask" for every door until it learned this name. */
      expect(Array.isArray(body.items), "the answer is not an `items` envelope").toBe(true);
      const row = body.items?.[0];
      /* `id` AND `address` are both required by the app's reader — a row missing either is dropped,
         which reads as an empty roster and draws nothing. */
      expect(typeof row?.id).toBe("string");
      expect(row?.address).toBe("roster@b.test");
    }, 120_000);
  });

  describe("the credential the engine seals for itself", () => {
    /** A key ring in the desktop's own spelling — `version -> 64 hex`. Nothing is sealed without one. */
    const RING = { 1: "a".repeat(64) };
    const ADDRESS = "sealed@b.test";
    const TYPED = "the-one-that-was-typed";

    /** A store on disk, so a second launch can read what the first one wrote. */
    function onDisk(): string {
      return join(mkdtempSync(join(tmpdir(), "ohmail-phone-sealed-")), "engine.db");
    }

    it("SEALS the typed password into its own store on the first launch", async () => {
      const file = onDisk();
      const exec = nodeExecutor(recorder(), file);
      const dial: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(exec, {
        adapterFactory: dialRecorder(dial),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      /* The first launch dials with what it was given — the premise of everything below, and a
         boot that dialled with nothing would make the row's contents unreadable as evidence. */
      expect(dial.configs[0]?.auth).toMatchObject({ user: ADDRESS, pass: TYPED });

      const rows = await exec.all(
        "select transport, secret_enc, key_version, meta from mailbox_credentials",
        [],
      );
      expect(rows.rows.length, "nothing was sealed at all").toBe(1);
      const [transport, secretEnc, keyVersion, meta] = rows.rows[0]!;
      expect(transport).toBe("imap");
      expect(keyVersion).toBe(1);
      /* ENCRYPTED, not merely present. A row holding the password in the clear would satisfy
         "there is a row" and would be a mailbox password on a device in plaintext. */
      expect(typeof secretEnc).toBe("string");
      expect(String(secretEnc)).not.toContain(TYPED);
      /* AND THE NON-SECRET COORDINATES RIDE WITH IT, which is the other half of what a relaunch
         needs: the app knows nothing about this mailbox's server, and the row is where it is
         written down. */
      const m = (typeof meta === "string" ? JSON.parse(meta) : meta) as Record<string, unknown>;
      expect(m).toMatchObject({ host: "imap.invalid", port: 993, secure: true, user: ADDRESS });
    }, 120_000);

    it("DIALS with it on the next launch, with no password supplied — the relaunch's whole premise", async () => {
      const file = onDisk();
      const first = nodeExecutor(recorder(), file);
      const firstDial: Dialled = { configs: [], connects: 0 };
      const opened = await startPhoneEngine(deps(first, {
        adapterFactory: dialRecorder(firstDial),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      await opened.stop();

      /* THE SECOND LAUNCH, and the only thing it is not given is the password. Same store, same
         ring, same coordinates — which is exactly what the app can reconstruct without holding a
         secret of its own. */
      const second = nodeExecutor(recorder(), file);
      const dial: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(second, {
        adapterFactory: dialRecorder(dial),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      expect(dial.configs.length, "the second launch never dialled").toBeGreaterThan(0);
      expect(dial.configs[0]?.auth).toMatchObject({ user: ADDRESS, pass: TYPED });
    }, 120_000);

    it("STARTS FROM THE SEALED ROW with no config at all — the relaunch, through its own entry", async () => {
      const file = onDisk();
      const first = nodeExecutor(recorder(), file);
      const opened = await startPhoneEngine(deps(first, {
        adapterFactory: dialRecorder({ configs: [], connects: 0 }),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      const firstAccount = opened.accountId;
      await opened.stop();

      /* NO `imap` AND NO `address`. This is everything a relaunch has: the store, the ring, the
         install's own id and a name for itself. */
      const second = nodeExecutor(recorder(), file);
      const dial: Dialled = { configs: [], connects: 0 };
      const started = await startPhoneEngineFromSealed({
        exec: second,
        machineName: "Pixel 9",
        installId: "install-marker-abc",
        keks: RING,
        adapterFactory: dialRecorder(dial),
      } as Parameters<typeof startPhoneEngineFromSealed>[0]);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      live = started.engine;
      await settle();
      /* THE COORDINATES CAME OFF THE ROW and the password came out of it — the two halves the app
         cannot supply. */
      expect(dial.configs[0]?.host).toBe("imap.invalid");
      expect(dial.configs[0]?.auth).toMatchObject({ user: ADDRESS, pass: TYPED });
      /* AND IT IS THE SAME MAILBOX. The app keys its mirror by this id, so an account that moved
         between launches would be a second copy of one mailbox on one phone. */
      expect(started.engine.accountId).toBe(firstAccount);
      expect(started.engine.address).toBe(ADDRESS);
    }, 120_000);

    it("answers no-credential on a store that has never been opened, and closes it", async () => {
      /* The refusal arm the app renders. Asserted WITH the close, because an engine that refused
         and kept the handle would hold this phone's only store open for a mailbox nobody can dial. */
      const rec = recorder();
      const started = await startPhoneEngineFromSealed({
        exec: nodeExecutor(rec),
        machineName: "Pixel 9",
        installId: "install-marker-abc",
        keks: RING,
        adapterFactory: dialRecorder({ configs: [], connects: 0 }),
      } as Parameters<typeof startPhoneEngineFromSealed>[0]);
      expect(started.kind).toBe("no-credential");
      expect(rec.closed, "the store was left open behind the refusal").toBe(1);
    }, 120_000);

    it("dials with NOTHING when the ring cannot open the row — the counterweight", async () => {
      /* The other arm of the same mechanism, and the reason the relaunch cannot simply assume:
         a store whose key ring changed reads as `unreadable`, and the engine dials with an empty
         password rather than with a guess. A relaunch that reported success here would be an app
         claiming to organize a mailbox it cannot log in to. */
      const file = onDisk();
      const first = nodeExecutor(recorder(), file);
      const opened = await startPhoneEngine(deps(first, {
        adapterFactory: dialRecorder({ configs: [], connects: 0 }),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      await opened.stop();

      const second = nodeExecutor(recorder(), file);
      const dial: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(second, {
        adapterFactory: dialRecorder(dial),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS } },
        address: ADDRESS,
        keks: { 1: "b".repeat(64) },
      }));
      await settle();
      /* Read through the union `ImapAuth` is: its oauth2 arm carries no `pass`, and this case is
         about the password one. `toMatchObject` cannot express "the field is empty". */
      const auth = dial.configs[0]?.auth as { pass?: string } | undefined;
      expect(auth?.pass ?? "").toBe("");
    }, 120_000);

    /**
     * ══ A REFUSED LAUNCH DOES NOT LEAVE THE PASSWORD IT SEALED ON THE WAY IN ═════════════════
     *
     * `attachLocal` seals at ATTACH, before anything dials, so the first press writes the row and
     * the dial is refused afterwards. What that left behind was unrecoverable from the form: the
     * store wins in `resolveLogin`, so a corrected password never reached the server; and a
     * corrected HOST made the row FOREIGN, which returns from the runtime's `start()` without
     * dialling at all and reported an opened mailbox. Measured on a release build — the Ohbox in
     * under six seconds with zero bytes reaching the mail server.
     */
    /** An adapter whose `connect()` is refused the way a mail server refuses a password. */
    function signInRefusing(): (cfg: ImapConfig) => MailboxAdapter {
      return ((cfg: ImapConfig) => ({
        connect: async (): Promise<void> => {
          /* imapflow's own published shape — the flag, not a message. The predicates this
             composition classifies with read exactly this, so a double that threw a chosen
             string would be satisfied by a fix that matched that string. */
          throw Object.assign(new Error("Authentication failed"), {
            authenticationFailed: true, host: cfg.host,
          });
        },
        close: async (): Promise<void> => undefined,
      })) as unknown as (cfg: ImapConfig) => MailboxAdapter;
    }

    /** How many `imap` credential rows this store holds. The row is the whole subject. */
    async function sealedRows(exec: PhoneSqlExecutor): Promise<number> {
      const rows = await exec.all(
        "select transport from mailbox_credentials where transport = 'imap'", [],
      );
      return rows.rows.length;
    }

    it("DISCARDS the seal when the server refuses the sign-in, and the next press dials the corrected one", async () => {
      const file = onDisk();
      const first = nodeExecutor(recorder(), file);
      await expect(startPhoneEngine(deps(first, {
        adapterFactory: signInRefusing(),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "wrong" } },
        address: ADDRESS,
        keks: RING,
      }))).rejects.toThrow(/Authentication failed/u);

      /* THE ROW IS THE ASSERTION. A refusal that stopped the engine and left the row behind is
         exactly the state a second press cannot get out of. Read through a FRESH handle on the
         same file: the refusal closes the store, which is the other half of what it owes. */
      expect(await sealedRows(nodeExecutor(recorder(), file)),
        "the refused launch left its own password sealed").toBe(0);

      /* AND THE CORRECTED PASSWORD REACHES THE SERVER, which is what a person pressing Connect
         again is doing. Read off the config the adapter was BUILT with, so it is the dial and not
         a field on the object that wrote it. */
      const second = nodeExecutor(recorder(), file);
      const dial: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(second, {
        adapterFactory: dialRecorder(dial),
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      /* THE CONNECT, not the factory call: `attachLocal` builds an adapter for every mailbox it
         attaches whether or not the login resolves, so counting factory calls would pass over a
         launch that dialled nothing. */
      expect(dial.connects, "the second press never opened a connection").toBeGreaterThan(0);
      expect(dial.configs[0]?.auth).toMatchObject({ user: ADDRESS, pass: TYPED });
    }, 120_000);

    /**
     * GOOGLE'S REFUSED SIGN-IN IS STAMPED WITH WHY. The rethrown error carries `authHint`, a closed
     * word the phone's door words in its own language; each corpus shape (`gmail.refusals.json`,
     * synthetic) is thrown the way imapflow throws it. Control: the same throw from another host.
     */
    it("stamps authHint on a Google host's refused sign-in, and nowhere else", async () => {
      const throwing = (r: ProviderRefusal) => ((cfg: ImapConfig) => ({
        connect: async (): Promise<void> => {
          throw Object.assign(new Error("Command failed"), {
            authenticationFailed: true, serverResponseCode: r.code ?? undefined, responseText: r.text, host: cfg.host,
          });
        },
        close: async (): Promise<void> => undefined,
      })) as unknown as (cfg: ImapConfig) => MailboxAdapter;
      for (const r of loadRefusals("gmail").refusals) {
        for (const [host, hint] of [["imap.gmail.com", r.hint], ["imap.invalid", undefined]] as const) {
          const err = await startPhoneEngine(deps(nodeExecutor(recorder(), onDisk()), {
            adapterFactory: throwing(r),
            imap: { host, port: 993, secure: true, auth: { user: ADDRESS, pass: "refused" } },
            address: ADDRESS,
            keks: RING,
          })).then(() => null, (e: unknown) => e as { authHint?: unknown; authenticationFailed?: unknown });
          expect(err?.authenticationFailed, `${r.case} on ${host}`).toBe(true);
          expect(err?.authHint, `${r.case} on ${host}`).toBe(hint);
        }
      }
    }, 120_000);

    it("REFUSES a supplied-password launch whose stored row it cannot use, rather than handing back an engine", async () => {
      /* THE HOST-CORRECTED ARM, which is the one that produced an Ohbox over a door that never
         authenticated: the row names the server the FIRST press was pointed at, `resolveLogin`
         answers `foreign-host` and offers nothing, and the runtime's `start()` returns having
         dialled nothing and reported no failure. */
      const file = onDisk();
      const first = nodeExecutor(recorder(), file);
      const opened = await startPhoneEngine(deps(first, {
        adapterFactory: dialRecorder({ configs: [], connects: 0 }),
        imap: { host: "first.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      await opened.stop();
      expect(await sealedRows(nodeExecutor(recorder(), file)),
        "the premise: the first launch sealed a row naming the first server").toBe(1);

      const second = nodeExecutor(recorder(), file);
      const dial: Dialled = { configs: [], connects: 0 };
      await expect(startPhoneEngine(deps(second, {
        adapterFactory: dialRecorder(dial),
        imap: { host: "second.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }))).rejects.toThrow(/press Connect again/u);
      /* NOTHING WAS DIALLED, which is the reading that makes the refusal the honest answer rather
         than a second opinion about a connection that happened. The CONNECT and not the factory
         call — see the case above: an adapter is built for every attach either way. */
      expect(dial.connects, "a launch that refused still opened a connection").toBe(0);
      expect(await sealedRows(nodeExecutor(recorder(), file)),
        "the row it could not use was left behind").toBe(0);

      /* AND THE PRESS AFTER IT WORKS, on the corrected server. A refusal a person cannot get past
         is worse than the state it replaced. */
      const third = nodeExecutor(recorder(), file);
      const good: Dialled = { configs: [], connects: 0 };
      live = await startPhoneEngine(deps(third, {
        adapterFactory: dialRecorder(good),
        imap: { host: "second.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: TYPED } },
        address: ADDRESS,
        keks: RING,
      }));
      await settle();
      expect(good.connects, "the press after the refusal never dialled").toBeGreaterThan(0);
      expect(good.configs[0]?.host).toBe("second.invalid");
      expect(good.configs[0]?.auth).toMatchObject({ user: ADDRESS, pass: TYPED });
    }, 120_000);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE PHONE'S ENGINE WRITES A LOG — `logSink`, and the hardened logger over it
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `StartPhoneEngine` had no channel the app could supply, so a phone's engine wrote nothing
   * anywhere: two `ReactNativeJS` lines in a whole release run, neither from the engine, and three
   * device-only defects that had to be read off a mail server's wire instead — the ones that never
   * reach the wire could not be read at all.
   *
   * The app supplies a SINK and this composition builds `createSidecarLog` over it, so the field
   * allowlist, the name-keyed redaction and `err` collapsing to a class all come from this package
   * rather than from the app. These cases assert the LINE, because that is what reaches `logcat`.
   */
  describe("the diagnostic sink a phone supplies", () => {
    it("writes the desktop's own line shape, through the hardened logger", async () => {
      const lines: string[] = [];
      live = await startPhoneEngine(deps(nodeExecutor(recorder()), {
        logSink: (line: string) => { lines.push(line); },
      }));
      await settle();

      expect(lines.length, "the engine wrote nothing at all").toBeGreaterThan(0);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      for (const line of parsed) {
        /* THE SHAPE `adb logcat` CARRIES, and the one the desktop writes to stderr. A sink that
           received a pretty-printed object would be unreadable by the same search. */
        expect(typeof line.ts).toBe("string");
        expect(line.service, "the line does not name this service").toBe("sidecar");
        expect(typeof line.event).toBe("string");
        expect(["info", "warn", "error"]).toContain(line.level);
      }
      /* The boot's own vocabulary, so this is not satisfied by any one line at all. */
      expect(parsed.map((l) => l.event)).toContain("boot_phases");
    }, 120_000);

    it("carries the SYNC LOOP's lines too — both faces of the one channel", async () => {
      /* `createSidecar` takes a `Diagnostic` AND a `Logger`, and the sync loop speaks the second.
         A sink wired to only one of them would carry the launch's lines and none of the ones that
         describe a write the mail server did not accept. `sync_uid_unanswered` is the worker's
         own `warn`, which only the `Logger` face can emit. */
      const lines: string[] = [];
      live = await startPhoneEngine(deps(nodeExecutor(recorder()), {
        adapterFactory: withheldUidMailbox(),
        logSink: (line: string) => { lines.push(line); },
      }));
      await settle(3000);

      const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
      expect(events, `the sync loop's lines did not reach the sink. Saw: ${JSON.stringify(events)}`)
        .toContain("sync_uid_unanswered");
    }, 120_000);

    it("keeps the mailbox PASSWORD out of every line — the reason it is a sink and not a logger", async () => {
      /* The whole argument for handing over a destination rather than a `Diagnostic`: the
         redaction is this package's. A refused sign-in is the path that has the password nearest
         to a log line, so it is the one this drives. */
      const lines: string[] = [];
      const secret = "sink-must-not-carry-this";
      await expect(startPhoneEngine(deps(nodeExecutor(recorder()), {
        adapterFactory: ((cfg: ImapConfig) => ({
          connect: async (): Promise<void> => {
            /* THE SERVER'S OWN ERROR, carrying the credential the way a driver does — which is
               what `describeError` has to discard. */
            throw Object.assign(new Error(`Authentication failed for ${secret}`), {
              authenticationFailed: true, host: cfg.host,
            });
          },
          close: async (): Promise<void> => undefined,
        })) as unknown as (cfg: ImapConfig) => MailboxAdapter,
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: secret } },
        keks: { 1: "a".repeat(64) },
        logSink: (line: string) => { lines.push(line); },
      }))).rejects.toThrow();

      expect(lines.length, "nothing was written, so this case measured nothing").toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, "a log line carries the mailbox password").not.toContain(secret);
      }
      /* AND THE REFUSAL IS ON THE RECORD, so the case above is not passed by a sink that dropped
         every line about the failure. */
      const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
      expect(events).toContain("mailbox_open_refused");
      expect(events).toContain("mailbox_open_seal_discarded");
    }, 120_000);
  });

  /**
   * THE STORE'S UPGRADE COUNTS ITSELF (FIX-026 row 95). The open ran the device migrator and threw
   * its answer away (`migrations: null`, `migrateMs: 0`), so `boot_phases` said nothing about a
   * slow relaunch. Mutation: `migrations: null` restored reddens the first and third cases.
   */
  describe("the store's upgrade, counted", () => {
    /** A file store brought up to the journal minus `owed`, the shape an app update leaves. */
    async function storeOwing(owed: number): Promise<string> {
      const path = join(mkdtempSync(join(tmpdir(), "ohmail-phone-upgrade-")), "engine.db");
      const older = await openPhoneStore(nodeExecutor(recorder(), path), 1_000, undefined,
        SQLITE_JOURNAL.slice(0, SQLITE_JOURNAL.length - owed));
      await older.close();
      return path;
    }

    it("returns the census of what this open owed, ran, and which entry paid", async () => {
      const path = await storeOwing(3);
      const heard: { applied: number; pending: number; fresh: boolean }[] = [];
      const opened = await openPhoneStore(nodeExecutor(recorder(), path), 1_000, (p) => { heard.push(p); });
      const tail = SQLITE_JOURNAL.slice(-3).map((e) => e.name);
      expect(opened.migrations, "the open ran the migrator and answered null").toEqual({
        pending: 3, applied: 3, slowest: expect.objectContaining({ migration: expect.any(String) }) as unknown,
      });
      expect(tail).toContain(opened.migrations!.slowest!.migration);
      expect(heard).toEqual([0, 1, 2].map((applied) => ({ applied, pending: 3, fresh: false })));
      expect(opened.timings.migrateMs).toBeGreaterThanOrEqual(0);
      await opened.close();
    }, 120_000);

    it("a fresh store is said to be fresh; an up-to-date one owes nothing and says nothing", async () => {
      const path = join(mkdtempSync(join(tmpdir(), "ohmail-phone-fresh-")), "engine.db");
      const heard: { fresh: boolean }[] = [];
      const first = await openPhoneStore(nodeExecutor(recorder(), path), 1_000, (p) => { heard.push(p); });
      expect(first.migrations?.pending).toBe(SQLITE_JOURNAL.length);
      expect(heard.every((p) => p.fresh)).toBe(true);
      await first.close();
      const again: unknown[] = [];
      const second = await openPhoneStore(nodeExecutor(recorder(), path), 1_000, (p) => { again.push(p); });
      expect(second.migrations).toEqual({ pending: 0, applied: 0, slowest: null });
      expect(again).toEqual([]);
      await second.close();
    }, 120_000);

    it("the boot line carries the census on a phone, as on a computer", async () => {
      const path = await storeOwing(2);
      const lines: string[] = [];
      live = await startPhoneEngine(deps(nodeExecutor(recorder(), path), {
        logSink: (line: string) => { lines.push(line); },
      }));
      await settle();
      const boot = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "boot_phases");
      expect(boot, "no boot_phases line").toBeDefined();
      expect(boot!.migrationsPending).toBe(2);
      expect(boot!.migrationsApplied).toBe(2);
      expect(SQLITE_JOURNAL.slice(-2).map((e) => e.name)).toContain(boot!.slowestMigration);
    }, 120_000);

    it("a failing entry refuses the open BY NAME", async () => {
      const path = await storeOwing(0);
      const bad = { ...SQLITE_JOURNAL[0]!, name: "9999_fix026_planted", statements: ["SELECT nope FROM nowhere"] };
      const exec = nodeExecutor(recorder(), path);
      const verdict = await openPhoneStore(exec, 1_000, undefined, [...SQLITE_JOURNAL, bad])
        .then(() => "opened", (e: unknown) => (e as Error).message);
      await exec.close();
      expect(verdict).toContain("the SQLite journal stopped at 9999_fix026_planted");
    }, 120_000);
  });

  /**
   * THE MEMORY SAMPLER SURVIVES A RUNTIME WITH NO MEMORY READING, AND SAYS SO.
   *
   * It called `process.memoryUsage()` unconditionally from the engine's boot. On a phone that is
   * `undefined is not a function`, and it took the launch down after a successful load, a
   * successful migration and a successful credential seal — an instrument stopping the engine it
   * exists to measure.
   */
  describe("the engine's memory sampler", () => {
    it("emits nulls and NAMES the absence rather than inventing a number", () => {
      const original = Object.getOwnPropertyDescriptor(process, "memoryUsage");
      const lines: { event: string; detail: Record<string, unknown> }[] = [];
      try {
        /* The phone's shape: the member is not there at all. DELETED rather than replaced with a
           thrower — production's "unavailable" is an absent member, and a present-and-throwing
           double would send the raw throw past the guard under test and measure a different arm. */
        delete (process as unknown as { memoryUsage?: unknown }).memoryUsage;
        const stop = startEngineVitals((event, detail) => lines.push({ event, detail }),
          // Required rather than optional so the absent case cannot exist; `0` is the phone
          // store's own answer, the contract's value for a runtime with no store heap.
          { storeBytes: () => 0 });
        stop();
      } finally {
        if (original) Object.defineProperty(process, "memoryUsage", original);
      }
      expect(typeof process.memoryUsage, "the descriptor was put back").toBe("function");

      expect(lines.map((l) => l.event)).toEqual(["engine_vitals"]);
      const detail = lines[0]!.detail;
      expect(detail.rss).toBeNull();
      expect(detail.heapUsed).toBeNull();
      expect(detail.external).toBeNull();
      // The field that makes a run of nulls readable. Without it this is indistinguishable from a
      // sampler that is broken, and the difference decides whether anybody investigates.
      expect(detail.memoryReading).toBe("unavailable_in_this_runtime");
      expect(typeof detail.uptimeMs).toBe("number");
    });

    it("reports a real reading where there IS one — the positive control", () => {
      const lines: { event: string; detail: Record<string, unknown> }[] = [];
      const stop = startEngineVitals((event, detail) => lines.push({ event, detail }),
        { storeBytes: () => 0 });
      stop();
      const detail = lines[0]!.detail;
      expect(detail.memoryReading).toBe("process");
      expect(typeof detail.rss).toBe("number");
      expect(detail.rss as number).toBeGreaterThan(0);
    });
  });
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SYNC LOOP'S DIAGNOSTICS REACH THE PHONE'S ONE SINK
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `SidecarConfig` carries two faces of the same channel: the `Diagnostic` this file's `deps()`
// supplies, and the `Logger` the shared sync loop writes through. This composition passed only the
// first, so `config.logger` was absent on a phone and every `log?.warn` / `log?.error` inside
// `@trafficflow/worker/sync` optional-chained into nothing. `apps/sidecar/test/
// sync-log-wiring.test.ts` guards the same seam on the DESKTOP door and states why it matters
// most here: a phone's database is on the person's own device and nobody reads it, so the log is
// the only witness that a write the mail server refused ever happened.
//
// The wiring case below is driven by an EFFECT and not by reading the config back: a mailbox that
// lists a UID and returns nothing for it makes `runSyncCycle` write `sync_uid_unanswered` at warn
// through that `Logger`, and the assertion is that the line arrives at the phone's sink.

type LeaseIoShape = {
  ensureMetaFolder(): Promise<void>;
  listClaims(): Promise<{ ref: number; raw: string }[]>;
  appendClaim(raw: string): Promise<void>;
  removeClaims(refs: readonly unknown[]): Promise<void>;
  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null;
};

/** The claim folder in memory, so this phone wins its own lease without a server. */
function memoryMetaFolder(): LeaseIoShape {
  let nextUid = 1;
  const claims: { ref: number; raw: string }[] = [];
  return {
    async ensureMetaFolder(): Promise<void> {},
    async listClaims() { return claims.map((c) => ({ ...c })); },
    async appendClaim(raw: string) { claims.push({ ref: nextUid++, raw }); },
    async removeClaims(refs: readonly unknown[]) {
      const gone = new Set(refs);
      for (let i = claims.length - 1; i >= 0; i -= 1) {
        if (gone.has(claims[i]!.ref)) claims.splice(i, 1);
      }
    },
    uidValidity: () => 4_100,
  };
}

/**
 * A MAILBOX THAT ANSWERS EVERYTHING AND WITHHOLDS ONE UID.
 *
 * `ChangeBatch.unanswered` is the set the adapter asked the server for and did not receive — RFC
 * 3501 permits a `UID FETCH` to return fewer messages than the set names, with no error and no
 * per-UID signal. The sync loop owes each one a durable failure row before any cursor moves, and
 * it says so at warn. Nothing else about this double is unusual: it is the shape
 * `sync-log-wiring.test.ts` uses, which is the shape the production adapter presents.
 */
function withheldUidMailbox(): (cfg: ImapConfig) => MailboxAdapter {
  const meta = memoryMetaFolder();
  return (() => ({
    leaseIo: () => meta,
    connect: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
    capabilities: async () => ({
      move: true, uidplus: true, condstore: true, qresync: false, idle: true,
      specialUse: true, sentFolder: null,
    }),
    ensureFolders: async (): Promise<void> => undefined,
    changesSince: async () => ({
      creates: [], moves: [], flagChanges: [], deletes: [],
      newCursor: { folders: {} },
      unanswered: [{ folder: "INBOX", uidValidity: "42", uid: 4242 }],
    }),
    move: async (locator: unknown) => locator,
    setFlags: async (): Promise<void> => undefined,
    scanSentRecipients: async () => [],
    watch: async () => async (): Promise<void> => undefined,
    send: async () => { throw new Error("this mailbox cannot send"); },
    fetchPart: async () => { throw new Error("this mailbox cannot fetchPart"); },
  })) as unknown as (cfg: ImapConfig) => MailboxAdapter;
}

describe("the `Logger` derived from the phone's Diagnostic", () => {
  it("carries a warn and an error through to the sink, with the level in the line", () => {
    const lines: { event: string; detail: Record<string, unknown> }[] = [];
    const logger = loggerOver((event, detail) => { lines.push({ event, detail: detail ?? {} }); });

    logger.warn("store_refused", { mailboxId: "m-1" });
    logger.error("reconcile_flag_no_locator", { messageId: "id-1" });

    expect(lines.map((l) => l.event)).toEqual(["store_refused", "reconcile_flag_no_locator"]);
    // THE SEVERITY SURVIVES. The `Diagnostic` re-derives a level from the event name, and neither
    // of these names ends in `_failed` / `_fatal` / `_unavailable` — so without this field a
    // warning and a routine line are indistinguishable at the sink.
    expect(lines[0]!.detail.level).toBe("warn");
    expect(lines[1]!.detail.level).toBe("error");
    expect(lines[0]!.detail.mailboxId).toBe("m-1");
    expect(lines[1]!.detail.messageId).toBe("id-1");
  });

  it("MERGES a child's bindings rather than replacing or dropping them", () => {
    // `withRequestId` calls `child({ requestId })` on whatever logger it is given
    // (`packages/api/src/middleware.ts:145`). A stub returning itself would discard the binding
    // silently, which is how a request id stops selecting a request's lines.
    const lines: Record<string, unknown>[] = [];
    const root = loggerOver((_event, detail) => { lines.push(detail ?? {}); });
    root.child({ mailboxId: "m-2" }).child({ requestId: "r-9" }).info("cycle_started", { pass: 3 });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.mailboxId).toBe("m-2");
    expect(lines[0]!.requestId).toBe("r-9");
    expect(lines[0]!.pass).toBe(3);
    // …and the root is untouched: a `child` that mutated its parent would leak one mailbox's
    // bindings onto every later line.
    root.info("cycle_started", {});
    expect(lines[1]!.mailboxId).toBeUndefined();
  });

  it("says `info` and emits nothing below it — the level is not decoration", () => {
    const lines: string[] = [];
    const logger = loggerOver((event) => { lines.push(event); });
    expect(logger.level).toBe("info");
    logger.debug("statement_dispatched", { sql: "select 1" });
    // A logger that names a filter and then writes past it is lying about its own level, and the
    // field is read by callers deciding whether to build an expensive detail object.
    expect(lines).toEqual([]);
    logger.info("cycle_started", {});
    expect(lines).toEqual(["cycle_started"]);
  });
});

describe.runIf(ON_DEVICE_STORE)("the sync loop can be heard on a phone", () => {
  it("reports a UID the server withheld — the line the composition used to drop", async () => {
    const lines: { event: string; detail: Record<string, unknown> }[] = [];
    live = await startPhoneEngine(deps(nodeExecutor(recorder()), {
      adapterFactory: withheldUidMailbox(),
      log: (event: string, detail: Record<string, unknown>) => { lines.push({ event, detail }); },
    }));
    // The engine starts itself; the launch is a `void` call, so the cycle needs a moment.
    await settle(3000);

    const line = lines.find((l) => l.event === "sync_uid_unanswered");
    expect(
      line,
      `the sync loop's diagnostics are dropped on this door — \`config.logger\` was absent. Saw: ${
        JSON.stringify(lines.map((l) => l.event))}`,
    ).toBeDefined();
    expect(line!.detail.level).toBe("warn");
    expect(line!.detail.folder).toBe("INBOX");
    expect(line!.detail.uid).toBe(4242);
    // A durable row was written before the line — that is the ordering the cursor rule depends on,
    // and `attempts` is the count that row came back with.
    expect(line!.detail.attempts).toBe(1);
  }, 120_000);

  it("says nothing of the kind when the mailbox withholds nothing — the counterweight", async () => {
    const lines: { event: string; detail: Record<string, unknown> }[] = [];
    const quiet = withheldUidMailbox();
    live = await startPhoneEngine(deps(nodeExecutor(recorder()), {
      adapterFactory: ((cfg: ImapConfig) => {
        const adapter = quiet(cfg) as unknown as Record<string, unknown>;
        // The same double with the one withheld UID removed. A door that warned on every cycle
        // would satisfy the case above and be useless.
        return { ...adapter, changesSince: async () => ({
          creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
        }) } as unknown as MailboxAdapter;
      }) as unknown as (cfg: ImapConfig) => MailboxAdapter,
      log: (event: string, detail: Record<string, unknown>) => { lines.push({ event, detail }); },
    }));
    await settle(3000);

    expect(lines.filter((l) => l.event === "sync_uid_unanswered")).toEqual([]);
  }, 120_000);
});

/*
 * THE PHONE'S SEARCH STATES NO INDEX PROGRESS. A phone runs no search backfill (`composition-passes.ts`): rows stored
 * without a document (every row a pre-0.24 phone holds) are searched the older way, complete, and nothing ever writes
 * one, so an answer carrying `indexed` read "Older mail is still being indexed" for ever. The same store
 * composed as the desktop, which does fill its index, keeps the progress (the case's control).
 */
describe.runIf(ON_DEVICE_STORE)("search on a phone", () => {
  it.each([["mobile", undefined], ["local", { done: 0, total: 2 }]] as const)(
    "composed as %s, a search over rows without a document answers indexed %j",
    async (organizerKind, indexed) => {
      const exec = nodeExecutor(recorder());
      live = await startPhoneEngine(deps(exec, { organizerKind }));
      const mailbox = String((await exec.all("select id from mailboxes limit 1", [])).rows[0]?.[0] ?? "");
      expect(mailbox, "the engine made no mailbox row").not.toBe("");
      for (const [n, subject] of [[1, "zzkingfisher report"], [2, "Invoice"]] as const) {
        const id = `00000000-0000-4000-8000-00000000000${n}`;
        await exec.run(
          "insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, native_locator) values (?, ?, ?, 'h', ?, ?, 'a@mail.example', ?, ?)",
          [id, live.accountId, mailbox, `fx:${id}`, subject, Date.now() - n * 60_000, JSON.stringify({ folder: "INBOX", ref: `1:${n}` })],
        );
        await exec.run("insert into message_bodies (message_id, text) values (?, ?)", [id, `body ${n}`]);
      }
      const res = await live.handle(new Request("http://sidecar/search?q=zzkingfisher", {
        headers: { authorization: `Bearer ${live.sessionToken}` },
      }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items?: { id: string }[]; indexed?: unknown };
      expect((body.items ?? []).map((i) => i.id), "the older way found nothing").toEqual(["00000000-0000-4000-8000-000000000001"]);
      expect(body.indexed).toEqual(indexed);
    },
    120_000,
  );
});
