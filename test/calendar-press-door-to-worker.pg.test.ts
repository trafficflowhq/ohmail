/**
 * A PERSON'S PRESS, FROM THE DOOR TO THE PROVIDER, on a real Postgres. The services' door records the
 * act in one transaction, whose change rings the worker's bell at its commit, and pulls the act's
 * connection due in a second one just after it. The worker's runner, its bell and the change log's
 * hub run here at their shipped times; the provider is a scripted one, and nothing is dialled. A root
 * test, because it holds the door and the worker's passes together, and neither imports the other.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CalendarEventAct } from "@ohmail/wire";
import { CHANGE_LOG_CHANNEL, calConnections, changeWakePayload } from "@trafficflow/db";
import { makeChangeWakeHub } from "@trafficflow/db/cloud";
import { PG_TEST_URL } from "@trafficflow/db/testing";
import type { ServiceContext } from "@trafficflow/services";
import { CALENDAR_BUILDERS, recordCalendarWrite } from "@trafficflow/services/calendar";
import {
  CALENDAR_RING_GAP_MS, CALENDAR_RING_SETTLE_MS, CALENDAR_TICK_MS, ROSTER_LIMIT, calendarPool, loadDueConnections,
} from "../packages/organizer/src/calendar/index.js";
import { calendarSyncPass } from "../packages/organizer/src/calendar/sync-pass.js";
import { calendarWriteDrain } from "../packages/organizer/src/calendar/write-drain.js";
import { accountShardFilter } from "../apps/worker/src/mailboxes.js";
import { startCalendarRunner } from "../apps/worker/src/start/calendar.js";
import {
  AVAILABLE, Secret, ZONES, capturedLog, depsFor, openWorld, providersOf, scriptedReader, scriptedWriter, sealCredential,
  seedConnection, silentHttp, single, upsert, type World,
} from "../packages/organizer/test/_calendar-world.js";

/** The roster is held to this file's own accounts by the worker's shard rule: each is a shard of its own among a million. */
const SHARDS = 1_000_003;
const never = new AbortController().signal;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An event as a device holds it: its id, and its record's `updatedAt`, which an act names as the copy it was made on. */
interface StoredEvent {
  readonly id: string;
  readonly base: string;
}

describe.skipIf(!AVAILABLE)("a press, from the door to the provider", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(10); }, 120_000);
  afterAll(async () => { await w?.close(); });

  const ctx = (accountId: string): ServiceContext => ({
    db: w.db as unknown as ServiceContext["db"], accountId, userId: null, now: () => new Date(), requestId: `cp-${randomUUID().slice(0, 8)}`,
  });
  const retitle = (e: StoredEvent, title: string): CalendarEventAct =>
    ({ kind: "calendar_event_update", eventId: e.id, base: e.base, scope: { kind: "record" }, change: { title } });
  const writesOf = async (accountId: string): Promise<{ key: string; state: string }[]> =>
    w.sql<{ key: string; state: string }[]>`select idempotency_key as key, state from cal_writes
      where account_id = ${accountId} order by created_at, idempotency_key`;
  const said = (err: unknown): string => `threw ${String(err).slice(0, 200)}`;
  const tally = (xs: readonly string[]) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));

  /** A CalDAV connection whose provider holds `events` events, read once by a turn of its own, its writes carried out by the drain. */
  async function connectionOf(accountId: string | null, tag: string, events: number) {
    const items = Array.from({ length: events }, (_, i) => upsert(`/${tag}/${i + 1}.ics`, '"v1"', single(`${tag}-u${i + 1}`, 18, `Event ${i + 1}`)));
    const reader = scriptedReader("caldav", {
      calendars: [{ id: `cal-${tag}`, name: "Studio", color: null, writable: true, byToken: true, zone: null }],
      readings: new Map([["", [{ items }]], ["t1", [{ items: [] }]]]), endToken: () => "t1",
    });
    const credential = { kind: "basic" as const, user: "mila", password: new Secret(`pw-${randomUUID().slice(0, 8)}`) };
    const serverUrl = `http://127.0.0.1:1/${tag}/`;
    let seeded: { readonly accountId: string; readonly connectionId: string };
    if (accountId === null) seeded = await seedConnection(w, { provider: "caldav", credential, serverUrl });
    else {
      const [row] = await w.db.insert(calConnections).values({ accountId, provider: "caldav", label: tag, status: "active", serverUrl })
        .returning({ id: calConnections.id });
      await sealCredential(w, accountId, row!.id, credential, null);
      seeded = { accountId, connectionId: row!.id };
    }
    const drain = calendarWriteDrain({ clock: { now: () => Date.now() }, zones: ZONES, log: capturedLog().log });
    const deps = depsFor(w, providersOf({ caldav: { reader, writer: scriptedWriter("caldav"), http: silentHttp() } }), { drainWrites: drain });
    const due = { accountId: seeded.accountId, id: seeded.connectionId, provider: "caldav", status: "active" as const };
    const c = {
      ...seeded, deps,
      turn: () => calendarSyncPass(deps, due, never),
      stored: async (): Promise<StoredEvent[]> => {
        const rows = await w.sql<{ id: string }[]>`select e.id from cal_events e
          join cal_calendars k on k.id = e.calendar_id and k.account_id = e.account_id
          where e.account_id = ${seeded.accountId} and k.connection_id = ${seeded.connectionId} order by e.provider_id`;
        const records = await CALENDAR_BUILDERS.calendar_event(w.db as unknown as ServiceContext["db"], seeded.accountId, rows.map((r) => r.id));
        return rows.map((r) => ({ id: r.id, base: records.get(r.id)!.updatedAt }));
      },
    };
    expect((await c.turn()).kind).toBe("synced");
    expect((await c.stored()).length).toBe(events);
    return c;
  }

  it("carries out a press made while the bell is idle at once: the read its act's ring starts finds the connection its wake pulled due", async () => {
    const tag = `b1-${randomUUID().slice(0, 6)}`;
    const c = await connectionOf(null, tag, 6);
    const events = await c.stored();
    const [own] = await w.sql<{ shard: number }[]>`select ((hashtext(${c.accountId}::text) % ${SHARDS}) + ${SHARDS}) % ${SHARDS} as shard`;
    const pool = calendarPool(w.db);
    const hub = makeChangeWakeHub(PG_TEST_URL);
    let reads = 0;
    let lastReadAt = 0;
    const runner = startCalendarRunner({
      roster: async (now, except) => {
        const due = await loadDueConnections(pool, now, ROSTER_LIMIT, (column) => accountShardFilter({ shards: SHARDS, shardIndex: Number(own!.shard) }, column), except);
        reads += 1;
        lastReadAt = performance.now();
        return due;
      },
      turn: (d, signal) => calendarSyncPass(c.deps, d, signal),
      lanes: 1, floorMs: CALENDAR_TICK_MS, gapMs: CALENDAR_RING_GAP_MS, settleMs: CALENDAR_RING_SETTLE_MS,
      // The change log's own signal, of this account alone: another file's writes ring nobody here.
      source: { subscribeAll: (onWake) => hub.subscribeAll((accountId, seq) => { if (accountId === c.accountId) onWake(accountId, seq); }) },
      isStopped: () => false, now: () => Date.now(), log: capturedLog().log,
    });
    const stateOf = async (key: string): Promise<string | undefined> =>
      (await w.sql<{ state: string }[]>`select state from cal_writes where account_id = ${c.accountId} and idempotency_key = ${key}`)[0]?.state;
    try {
      // The hub listens once its connection is up: the account's own signal until the bell has read the roster.
      for (let n = 0; reads === 0; n++) {
        if (n > 200) throw new Error("the change log's signal never reached the bell");
        await w.sql`select pg_notify(${CHANGE_LOG_CHANNEL}, ${changeWakePayload(c.accountId, 0n)})`;
        await sleep(50);
      }
      const carried: number[] = [];
      for (const [i, e] of events.entries()) {
        // The bell idle: no read in flight, and the gap since the last one long passed.
        for (let left = 1; left > 0;) {
          left = lastReadAt + CALENDAR_RING_GAP_MS + 500 - performance.now();
          if (left > 0) await sleep(left);
        }
        const key = `${tag}-${i}`;
        const pressedAt = performance.now();
        expect((await recordCalendarWrite(ctx(c.accountId), key, retitle(e, `Press ${i}`))).answer.write!.state).toBe("pending");
        while ((await stateOf(key)) !== "applied") {
          if (performance.now() - pressedAt > CALENDAR_TICK_MS + 5_000) throw new Error(`press ${i} was not carried out; before it: ${carried.join(", ")} ms`);
          await sleep(10);
        }
        carried.push(Math.round(performance.now() - pressedAt));
      }
      console.info(`a press made while the bell is idle, carried out after (ms): ${carried.join(", ")}`);
      expect(carried.filter((ms) => ms >= 1_000), `carried out after ${carried.join(", ")} ms`).toEqual([]);
    } finally {
      runner.stop();
      await runner.settled();
      await hub.end();
    }
  }, 200_000);

  it("records every press made at once on two connections of one account while their turns run beside them, and carries every one out", async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await connectionOf(null, `d2a-${tag}`, 3);
    const b = await connectionOf(a.accountId, `d2b-${tag}`, 3);
    const pressed: string[] = [];
    const turns: string[] = [];
    for (let r = 0; r < 5; r++) {
      const events = [...await a.stored(), ...await b.stored()];
      const presses = Promise.allSettled(events.map((e, i) => recordCalendarWrite(ctx(a.accountId), `d2-${tag}-${r}-${i}`, retitle(e, `Round ${r}`))));
      const beside = Promise.allSettled([a, b].map(async (c) => {
        const kinds: string[] = [];
        for (let n = 0; n < 3; n++) kinds.push((await c.turn()).kind);
        return kinds.every((k) => k === "synced") ? "synced" : kinds.join(",");
      }));
      const [p, t] = await Promise.all([presses, beside]);
      pressed.push(...p.map((x) => (x.status === "fulfilled" ? x.value.answer.write!.state : said(x.reason))));
      turns.push(...t.map((x) => (x.status === "fulfilled" ? x.value : said(x.reason))));
      // What is still owed is carried out before the next round, so that every round presses on the copy the store holds.
      for (let n = 0; n < 8 && (await writesOf(a.accountId)).some((x) => x.state === "pending"); n++) {
        await a.turn();
        await b.turn();
      }
    }
    expect({ pressed: tally(pressed), turns: tally(turns), rows: tally((await writesOf(a.accountId)).map((x) => x.state)) })
      .toEqual({ pressed: { pending: 30 }, turns: { synced: 10 }, rows: { applied: 30 } });
  }, 120_000);
});
