import fs, { appendFileSync, existsSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";

/**
 * A DISK THAT REFUSES THE STORE'S SYNCS, INSIDE A REAL ENGINE: `--import`ed by
 * `store-fatal-ends-the-engine.test.ts` into `src/main.ts` as the shell spawns it. Once the test's
 * trigger file exists it drives the engine's own store: one row acknowledged, then the shape, a
 * commit whose sync fails with an insert queued behind it, or a CHECKPOINT whose first sync fails
 * with an insert and an update admitted inside it. Every answer is appended synchronously, so an
 * engine that ends on the spot loses none of them.
 */

const SHAPE = process.env.STORE_FAULT_SHAPE;
const TRIGGER = process.env.STORE_FAULT_TRIGGER;
const OUT = process.env.STORE_FAULT_OUT;

interface Store {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  readonly closed: boolean;
}

const say = (line: string): void => { appendFileSync(OUT!, `${line}\n`); };
const eio = (): Error => Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", errno: -5, syscall: "fsync" });
const answer = (label: string, pending: Promise<unknown>): void => {
  pending.then(() => say(`ANSWERED ${label}`), (err: unknown) => say(`REFUSED ${label} ${(err as Error)?.name ?? "?"}`));
};

async function drive(store: Store): Promise<void> {
  const acct = String((await store.query("INSERT INTO accounts (name) VALUES ('fault') RETURNING id::text AS id")).rows[0]!.id);
  const rule = (match: string): Promise<unknown> => store.query(
    "INSERT INTO rules (account_id, kind, match, destination) VALUES ($1::uuid, 'sender', $2, 'Archive') RETURNING id",
    [acct, match],
  );
  await rule("kept@rig.invalid");
  say("ANSWERED kept");
  const f = fs as unknown as Record<string, unknown>;
  if (SHAPE === "commit") {
    f.fsyncSync = () => { throw eio(); };
    answer("failing commit", rule("failing@rig.invalid"));
    answer("queued insert", rule("queued@rig.invalid"));
  } else {
    f.fsyncSync = () => {
      f.fsyncSync = () => { throw eio(); };
      answer("queued insert", rule("queued@rig.invalid"));
      answer("queued update", store.query("UPDATE rules SET destination = 'Moved' WHERE match = 'kept@rig.invalid'"));
      say("QUEUED");
      throw eio();
    };
    answer("failing checkpoint", store.query("CHECKPOINT"));
  }
  say("ISSUED");
}

if (isMainThread && SHAPE && TRIGGER && OUT) {
  /* The engine's store is whichever PGlite reached Postgres last and is still open. */
  const seen = new Set<Store>();
  const proto = PGlite.prototype as unknown as { execProtocolRaw: (...args: unknown[]) => unknown };
  const raw = proto.execProtocolRaw;
  proto.execProtocolRaw = function (this: Store, ...args: unknown[]) {
    seen.add(this);
    return raw.apply(this, args);
  };
  const poll = setInterval(() => {
    if (!existsSync(TRIGGER)) return;
    clearInterval(poll);
    const store = [...seen].filter((pg) => !pg.closed).at(-1);
    if (store === undefined) { say("NO STORE"); return; }
    drive(store).catch((err: unknown) => say(`SETUP FAILED ${String((err as Error)?.stack ?? err)}`));
  }, 25);
  poll.unref();
}
