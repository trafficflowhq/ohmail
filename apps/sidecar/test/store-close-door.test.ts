import { sql } from "drizzle-orm";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORE_GENERATION_FILE, StoreCloseTimeoutError, closeAfterFailedStart, openLocalDb, type OpenLocalDb,
} from "../src/db.js";
import { inStoreLane } from "../src/store-lanes.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE CLOSE DOOR (`db.ts`'s `installCloseDoor`). PGlite 0.2's `close()` takes none of its own locks,
 * so a close issued under a running call sent Terminate and the call's next statement ran against a
 * shut-down backend, where it loops in WASM and holds the process for good. Every case here reads
 * the wire: the protocol messages PGlite sent, and whether any came after Terminate (`X`).
 */
type Proto = (m: Uint8Array, o?: unknown) => Promise<unknown>;

function wire(o: OpenLocalDb): { sent: string[]; afterTerminate: () => string[]; terminated: () => boolean } {
  const client = (o.db as unknown as { $client: { execProtocol: Proto } }).$client;
  const sent: string[] = [];
  const orig = client.execProtocol.bind(client);
  client.execProtocol = ((m: Uint8Array, opts?: unknown) => {
    sent.push(`${String.fromCharCode(m[0]!)}:${Buffer.from(m).toString("latin1").replace(/[^ -~]/g, ".").slice(5, 70)}`);
    return orig(m, opts);
  }) as Proto;
  const at = (): number => sent.findIndex((s) => s.startsWith("X:"));
  return {
    sent,
    terminated: () => at() >= 0,
    afterTerminate: () => (at() < 0 ? [] : sent.slice(at() + 1)),
  };
}

const dirs: string[] = [];
const holds: Array<() => void> = [];
afterEach(() => {
  for (const release of holds.splice(0)) release();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function open(opts: Parameters<typeof openLocalDb>[1] = {}): Promise<OpenLocalDb> {
  const dir = await freshDataDir("ohmail-close-door-");
  dirs.push(dir);
  return openLocalDb(dir, opts);
}

function hold(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  holds.push(release);
  return { gate, release };
}

const write = sql`insert into local_store_flush (id, flushed_at) values (1, now())
  on conflict (id) do update set flushed_at = excluded.flushed_at`;

describe("the local store's close waits for what it admitted", () => {
  it("a close under a held transaction lets it commit, and nothing reaches Postgres after Terminate", async () => {
    const o = await open();
    const w = wire(o);
    const h = hold();
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const tx = o.db.transaction(async (t) => {
      await t.execute(sql`select 1`);
      entered();
      await h.gate;
      await t.execute(write);
    }).then(() => "committed", (e: unknown) => `failed: ${String(e)}`);
    await inside;
    const closing = o.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.terminated(), "the close terminated under a transaction it had admitted").toBe(false);
    h.release();
    await closing;
    expect(await tx, "an admitted write did not complete").toBe("committed");
    expect(w.afterTerminate(), "statements reached a shut-down backend").toEqual([]);
    expect(w.terminated()).toBe(true);
  });

  it("the timed flush queued behind the last page runs before Terminate, in the quit order", async () => {
    // The desktop's quit: the mirror's last page settles (`mirror.stop()`), then the store closes.
    const o = await open({ logFlushIntervalMs: 20 });
    const w = wire(o);
    const h = hold();
    const page = inStoreLane("ingest", () => o.db.transaction(async (t) => {
      await t.execute(sql`select 1`);
      await h.gate;
      await t.execute(sql`select 2`);
    }));
    await new Promise((r) => setTimeout(r, 80)); // the flush fires and queues behind the page
    const quit = page.then(() => o.close());
    h.release();
    await quit;
    expect(w.afterTerminate(), "the flush ran against a shut-down backend").toEqual([]);
    // The flush's own transaction commits `on` (db.ts's STORE_FLUSH); without it this measured nothing.
    expect(w.sent.some((s) => s.includes("synchronous_commit = on")), "the flush never ran").toBe(true);
  });

  it("a write still queued for its lane when the close begins completes, never refused mid-flight", async () => {
    // A drain holds the connection, so a person's write waits in the scheduler's queue: the close
    // door stands in front of that queue, and a call that reached it before the close is admitted.
    const o = await open();
    const w = wire(o);
    const h = hold();
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const page = inStoreLane("ingest", () => o.db.transaction(async (t) => {
      await t.execute(sql`select 1`);
      entered();
      await h.gate;
    }));
    await inside;
    const press = o.db.execute(sql`select 'a press'`).then(() => "written", (e: unknown) => `refused: ${(e as Error).name}`);
    await new Promise((r) => setTimeout(r, 20));
    const closing = o.close();
    h.release();
    await page;
    expect(await press, "a write queued before the close was refused").toBe("written");
    await closing;
    expect(w.afterTerminate()).toEqual([]);
  });

  it("a hold that is never released ends the close at the bound, terminating nothing", async () => {
    const o = await open({ closeWaitMs: 200 });
    const w = wire(o);
    const h = hold();
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const tx = o.db.transaction(async (t) => {
      await t.execute(write);
      entered();
      await h.gate;
    }).then(() => "committed", (e: unknown) => `failed: ${String(e)}`);
    await inside;
    const began = Date.now();
    const verdict = await o.close().then(() => "closed", (e: unknown) => e);
    const took = Date.now() - began;
    expect(verdict, "a close returned with a transaction still running under it").not.toBe("closed");
    expect((verdict as Error).name).toBe("StoreCloseTimeoutError");
    // What the next launch gets back is what reached the log; relaxed rows since the last flush did not.
    expect((verdict as Error).message, "the timeout claims the whole log comes back")
      .toMatch(/recovers what was written to the log$/);
    expect(took, "the bound did not hold").toBeLessThan(2_000);
    expect(w.terminated(), "the timed-out close shut Postgres down under the call").toBe(false);
    const generation = JSON.parse(readFileSync(join(o.dataDir, STORE_GENERATION_FILE), "utf8")) as { open: boolean };
    expect(generation.open, "a store left running was recorded as closed").toBe(true);
    // Released, the call completes, and the next close waits again and finishes.
    h.release();
    expect(await tx).toBe("committed");
    await o.close();
    expect(w.afterTerminate()).toEqual([]);
  });

  it("a quit's own bound replaces the default, and a completed close says what it spent", async () => {
    // The default would wait 30 s here; the quit asks for 200 ms.
    const o = await open({ closeWaitMs: 30_000 });
    const h = hold();
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const tx = o.db.transaction(async (t) => { await t.execute(write); entered(); await h.gate; })
      .then(() => "committed", (e: unknown) => `failed: ${String(e)}`);
    await inside;
    const began = Date.now();
    const verdict = await o.close({ waitMs: 200 }).then(() => "closed", (e: unknown) => e);
    expect((verdict as Error).name, "the quit's bound was not the close's").toBe("StoreCloseTimeoutError");
    expect(Date.now() - began).toBeLessThan(2_000);
    h.release();
    expect(await tx).toBe("committed");
    const report = await o.close({ waitMs: 200 });
    expect(report, "a completed close reported nothing").toMatchObject({ waitedMs: expect.any(Number), terminateMs: expect.any(Number) });
    expect((report as { terminateMs: number }).terminateMs).toBeGreaterThan(0);
  });

  it("a call after the close began is refused unrun and by name, and said once", async () => {
    const lines: Array<{ event: string }> = [];
    const o = await open({ log: (event: string) => { lines.push({ event }); } });
    const w = wire(o);
    const h = hold();
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const tx = o.db.transaction(async (t) => { await t.execute(sql`select 1`); entered(); await h.gate; });
    await inside;
    const closing = o.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.terminated(), "the close terminated under a transaction it had admitted").toBe(false);
    const late = await Promise.all([
      o.db.execute(sql`select 'late one'`).then(() => "ran", (e: unknown) => e),
      o.db.execute(sql`select 'late two'`).then(() => "ran", (e: unknown) => e),
    ]);
    // Refused by the close door, and marked as the store's own on the way out (never the message's).
    for (const v of late) {
      expect((v as Error)?.name, "the refusal left the store unmarked").toBe("StoreStatementFaultError");
      expect(((v as Error).cause as Error)?.name, "a call arriving during the close was run").toBe("StoreClosingError");
    }
    h.release();
    await tx;
    await closing;
    expect(w.sent.some((s) => s.includes("late")), "a refused call reached the connection").toBe(false);
    expect(lines.filter((l) => l.event === "local_db_refused_closing"), "the refusal was not said exactly once").toHaveLength(1);
  });
});

describe("a failed start's close keeps the start's error (closeAfterFailedStart)", () => {
  it("a close that times out is said beside the cause, not in its place", async () => {
    const lines: string[] = [];
    const o = await open({ closeWaitMs: 100, log: (event: string) => { lines.push(event); } });
    const h = hold();
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const tx = o.db.transaction(async (t) => { await t.execute(sql`select 1`); entered(); await h.gate; });
    await inside;
    const cause = new Error("the assembly failed");
    const reported = await (async () => { try { throw cause; } catch (err) { await closeAfterFailedStart(o); throw err; } })()
      .then(() => "no error", (e: unknown) => e);
    expect(reported, "the close timeout replaced the start's own error").toBe(cause);
    expect(lines, "the timeout was not logged beside it").toContain("local_db_close_failed");
    h.release();
    await tx;
    await o.close();
  });

  it("any other close failure is still thrown", async () => {
    const other = new Error("terminate failed");
    const seen = await closeAfterFailedStart({ close: () => Promise.reject(other) }).then(() => "swallowed", (e: unknown) => e);
    expect(seen).toBe(other);
    const timedOut = new StoreCloseTimeoutError(1, 100);
    expect(await closeAfterFailedStart({ close: () => Promise.reject(timedOut) }).then(() => "kept beside", (e: unknown) => e))
      .toBe("kept beside");
  });
});

describe("a quit during a drain still ends", () => {
  /** A drain: page after page in the ingest lane, each one transaction, until told to stop. */
  function drain(o: OpenLocalDb): { stop: () => void; done: Promise<string> } {
    let stopped = false;
    const done = (async (): Promise<string> => {
      for (let page = 0; ; page++) {
        if (stopped) return `stopped after ${page}`;
        try {
          await inStoreLane("ingest", () => o.db.transaction(async (t) => {
            for (let i = 0; i < 12; i++) await t.execute(write);
          }));
        } catch (e) {
          // The close door's refusal, under the store's mark (see `markStoreStatements`).
          const refusal = (e as Error).name === "StoreStatementFaultError" ? (e as Error).cause as Error : e as Error;
          return refusal?.name === "StoreClosingError" ? "refused" : `failed: ${String(e)}`;
        }
      }
    })();
    return { stop: () => { stopped = true; }, done };
  }

  it("asked to stop first, it leaves and the close follows inside the grace", async () => {
    const o = await open({ logFlushIntervalMs: 5 });
    const w = wire(o);
    const d = drain(o);
    await new Promise((r) => setTimeout(r, 150));
    const began = Date.now();
    d.stop();
    expect(await d.done).toMatch(/^stopped after \d+$/);
    await o.close();
    expect(Date.now() - began, "the quit took past the shell's five-second grace").toBeLessThan(5_000);
    expect(w.afterTerminate()).toEqual([]);
  });

  it("never told, it is refused at its next page, and nothing it sends reaches a shut-down backend", async () => {
    const o = await open({ logFlushIntervalMs: 5 });
    const w = wire(o);
    const d = drain(o);
    await new Promise((r) => setTimeout(r, 150));
    const began = Date.now();
    await o.close();
    const ended = await d.done;
    expect(w.afterTerminate(), "the drain's page ran against a shut-down backend").toEqual([]);
    expect(ended, "the drain ran on past the close").toBe("refused");
    expect(Date.now() - began).toBeLessThan(5_000);
  });
});
