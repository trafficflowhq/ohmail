import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  HttpAdapter, MutationRejectedError, OhmailEngine, IndexedDbMirrorStore,
  OUTBOX_BACKOFF_CAP_MS, type EngineAdapter,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * `Retry-After` FROM A REAL HEADER, and the clamp on the wait it names.
 *
 * The mechanism is present and has been for some time: `retryAfterMsOf` parses the header,
 * `MutationRejectedError` carries `retryAfterMs`, the outbox waits `min(header, cap)` and marks
 * the wait server-named. What nothing drove was either END of that chain.
 *
 *  · The PARSE was only ever exercised through a double that supplied the MODELLED FIELD
 *    (`outbox-bound.test.ts` hands `retryAfterMs: 2_000` to a fake). A fixture that fails where
 *    production parses measures the fixture: the adapter's own reading of a real `Response`
 *    header, in either RFC 9110 spelling, was untested — and a source census asserting every
 *    hand-built rejection *mentions* the field cannot see whether the value is right.
 *  · The CLAMP had no case at all. `min(header, cap)` is the only line standing between a
 *    server (or a proxy) naming a week and a queue that has stopped being a queue.
 */

const VERB = { kind: "tag_create", tagId: "t1", name: "later" } as const;

/** A 503 that names an interval, in whichever spelling the caller asks for. */
function busyWith(header: string | null): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ error: { code: "db_busy", message: "retry shortly", retryable: true } }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        ...(header === null ? {} : { "retry-after": header }),
      },
    },
  )) as unknown as typeof fetch;
}

async function rejectionFrom(header: string | null): Promise<MutationRejectedError> {
  const adapter = new HttpAdapter({ baseUrl: "", fetch: busyWith(header) });
  try {
    await adapter.mutate(VERB as never, { idempotencyKey: "k1" });
  } catch (err) {
    if (err instanceof MutationRejectedError) return err;
    throw err;
  }
  throw new Error("the adapter resolved a 503");
}

describe("the adapter reads Retry-After off the response", () => {
  it("the NUMERIC spelling — the one the API actually sends on db_busy", async () => {
    const err = await rejectionFrom("5");
    expect(err.status).toBe(503);
    expect(err.code).toBe("db_busy");
    // Seconds on the wire, milliseconds in the model. A unit error here is silent: the outbox
    // would wait 5 ms and hammer the instance that just refused it.
    expect(err.retryAfterMs).toBe(5_000);
  });

  it("the HTTP-DATE spelling — what a proxy in front of the API may rewrite it to", async () => {
    const when = new Date(Date.now() + 30_000);
    const err = await rejectionFrom(when.toUTCString());
    expect(err.retryAfterMs).not.toBeNull();
    // A second of slack for the clock between building the header and parsing it.
    expect(err.retryAfterMs!).toBeGreaterThan(28_000);
    expect(err.retryAfterMs!).toBeLessThanOrEqual(30_000);
  });

  it("a date in the PAST is zero, never negative — the server has said 'now'", async () => {
    const err = await rejectionFrom(new Date(Date.now() - 60_000).toUTCString());
    expect(err.retryAfterMs).toBe(0);
  });

  it("NO header is null, not zero — the two mean opposite things to the ceiling", async () => {
    // `null` spends the outbox's patience; `0` is a server-named wait that spends none. Reading
    // an absent header as 0 would make an ordinary 503 immortal in the queue.
    const err = await rejectionFrom(null);
    expect(err.retryAfterMs).toBeNull();
  });

  it("an UNPARSEABLE value is null rather than NaN", async () => {
    const err = await rejectionFrom("soon-ish");
    expect(err.retryAfterMs).toBeNull();
  });

  it("an empty header is null", async () => {
    const err = await rejectionFrom("   ");
    expect(err.retryAfterMs).toBeNull();
  });
});

/**
 * THE CLAMP IS MEASURED AT THE ENGINE, and the split is deliberate rather than convenient.
 *
 * `engine.ts` reads `rejection.retryAfterMs` — a MODELLED field — and the thing that produces it
 * is the adapter, whose reading of the real header the block above now measures. So a double
 * supplying that field here is production's shape at this seam, not a fixture that diverges from
 * it: the two halves meet at `retryAfterMs`, and each is driven on its own side of it.
 *
 * Driving `HttpAdapter` into a live engine instead would prove neither — its stubbed `fetch`
 * would have to answer `/sync` as well, and a 503 on the drain is a different code path.
 */
describe("the outbox waits min(header, cap)", () => {
  /** A clock the test moves by hand — the wait is time, so it has to be observable. */
  function clock(): { now: () => Date; advance: (ms: number) => void } {
    let t = Date.parse("2026-09-10T12:00:00.000Z");
    return { now: () => new Date(t), advance: (ms) => { t += ms; } };
  }

  /** A rig whose `mutate` refuses with a server-named interval, counting the attempts. */
  function busyRig(retryAfterMs: number): {
    adapter: EngineAdapter; attempts: () => number;
  } {
    const inner = new FixturesAdapter();
    let n = 0;
    return {
      attempts: () => n,
      adapter: {
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: () => inner.fetchBody(),
        sync: (p) => inner.sync(p),
        async mutate() {
          n += 1;
          throw new MutationRejectedError("database busy", {
            status: 503, code: "db_busy", retryable: true, retryAfterMs,
          });
        },
      },
    };
  }

  it("a wait NAMING A WEEK is clamped to the cap", async () => {
    const c = clock();
    const r = busyRig(7 * 24 * 3600 * 1000);
    const store = new IndexedDbMirrorStore({ owner: "acct-clamp", factory: new IDBFactory() });
    const engine = new OhmailEngine({ adapter: r.adapter, store, now: c.now });
    await engine.start();
    await engine.mutate(VERB as never);
    const first = r.attempts();
    expect(first).toBeGreaterThan(0);

    // JUST INSIDE the cap: honoured verbatim the record would wait six more days, so nothing may
    // dispatch here. This is the half that goes red when the clamp alone is removed.
    c.advance(OUTBOX_BACKOFF_CAP_MS - 1_000);
    await engine.syncOnce();
    expect(r.attempts()).toBe(first);

    // PAST the cap. Unclamped the record is still waiting; clamped, it goes again.
    c.advance(2_000);
    await engine.syncOnce();
    expect(r.attempts()).toBeGreaterThan(first);
    store.close();
  });

  it("a SHORT wait is honoured as itself, not rounded up to the cap", async () => {
    const c = clock();
    const r = busyRig(2_000);
    const store = new IndexedDbMirrorStore({ owner: "acct-short", factory: new IDBFactory() });
    const engine = new OhmailEngine({ adapter: r.adapter, store, now: c.now });
    await engine.start();
    await engine.mutate(VERB as never);
    const first = r.attempts();

    // The DISCRIMINATOR against a clamp that answers the cap for every interval: 3 s is longer
    // than the server's 2 s and far shorter than the hour, so a retry here proves the wait was
    // the server's number. Without it, `Math.min` replaced by the cap would stay green.
    c.advance(3_000);
    await engine.syncOnce();
    expect(r.attempts()).toBeGreaterThan(first);
    store.close();
  });

  it("and the server-named wait spends none of the give-up ceiling", async () => {
    // The property the clamp exists to preserve: a long pool outage must not abandon a verb.
    const c = clock();
    const r = busyRig(2_000);
    const store = new IndexedDbMirrorStore({ owner: "acct-patience", factory: new IDBFactory() });
    const engine = new OhmailEngine({ adapter: r.adapter, store, now: c.now });
    await engine.start();
    await engine.mutate(VERB as never);
    for (let i = 0; i < 30; i++) { c.advance(3_000); await engine.syncOnce(); }
    expect(r.attempts()).toBeGreaterThan(20);
    expect(engine.abandoned()).toHaveLength(0);
    store.close();
  });
});
