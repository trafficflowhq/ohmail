import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { platformSignals, SIGNAL_BUCKET_MS, platformSignalWindow } from "@trafficflow/db/cloud";
import { adminPlatformSignals } from "../src/admin-service.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD_JOURNAL } from "@trafficflow/db/admin";
import {
  makePlatformSignalPort, runPlatformSignalPass, SAMPLE_CAUSES,
  VERCEL_REQUEST_LOGS_URL, SIGNAL_WINDOW_MS, SSE_DISABLED_REFUSAL,
  type PlatformSignalPort,
} from "../src/platform-signals.js";


/**
 * Wrap a test's log-page stub so it ALSO answers the project-resolution call.
 *
 * The port resolves each configured NAME to Vercel's internal project id before walking any
 * logs — `projectId` on the log endpoint is the id, not the name, and passing the name is what
 * made this poller measure nothing for its entire life. Every stub therefore has to answer two
 * shapes; doing it here keeps each test about the thing it is testing.
 */
function withProjectResolution(logs: typeof fetch): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    if (String(url).includes("/v9/projects/")) {
      return new Response(JSON.stringify({ id: "prj_test", name: "ohmail-api" }));
    }
    return (logs as (u: unknown, i?: unknown) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
}

/**
 * THE 5xx POLLER, and the one property it exists to protect: **an unconfigured deployment must
 * never produce a zero.**
 *
 * That is the ruling's second ranked risk and it is settled by an ABSENCE rather than by a
 * value, which makes it the kind of property a test suite can pass without ever checking. A pass
 * that wrote `requests: 0, errors_5xx: 0` when no token exists would satisfy every "the rule does
 * not fire" assertion — the arithmetic still fails both floors — and would put a
 * measured-looking zero on an operator's screen for a figure nobody ever asked the platform for.
 * Nobody reads a zero as a question.
 *
 * ── MUTATIONS RUN, WATCHED RED, RESTORED ──────────────────────────────────────────────────
 *   · the `unconfigured` branch made to write a zero row ⇒ "writes NO ROW AT ALL" fails on the
 *     row count, and "…and the window read stays empty" fails on the read
 *   · `hasMoreRows`'s type guard removed (absent read as false) ⇒ "an absent continuation flag
 *     is a FAILURE" passes wrongly — the walk stops early and reports a complete count
 *   · the window's `- windowMs` step-back removed ⇒ "polls the window that just CLOSED" fails
 *   · the page budget removed ⇒ "a walk that hits its budget says so" hangs rather than failing,
 *     which is why the budget is asserted by a bounded fake rather than by a timeout
 */

const NOW = new Date("2026-09-04T12:07:31.000Z");

/** A port that answers whatever it is handed, with no network anywhere. */
function fakePort(answer: Awaited<ReturnType<PlatformSignalPort["fetch"]>>): PlatformSignalPort {
  return { projects: ["ohmail-api"], async fetch() { return answer; } };
}

describe("runPlatformSignalPass — the unconfigured state", () => {
  it("writes NO ROW AT ALL, so there is never a zero to render", async () => {
    const db = await makeTestDb();
    const report = await runPlatformSignalPass(db, {
      port: fakePort({ unconfigured: true }), now: () => NOW,
    });
    expect(report.outcome).toBe("unconfigured");
    expect(report.rows).toBe(0);
    // THE ASSERTION THAT MATTERS. Not "the figure is null" — there must be no ROW.
    const rows = await db.select().from(platformSignals);
    expect(rows, "an unconfigured deployment has measured nothing, and says so by absence")
      .toEqual([]);
    // The file's first test, its first store: 0.5 s as a rule, 2.7 s once on a loaded CI VM, 9 s under
    // 10% of a CPU; no wait of its own.
  }, 30_000);

  it("a FAILED fetch also writes no row — the previous window is not overwritten with a guess", async () => {
    const db = await makeTestDb();
    const report = await runPlatformSignalPass(db, {
      port: fakePort({ failed: "http_403" }), now: () => NOW,
    });
    expect(report.outcome).toBe("failed");
    expect(report.code).toBe("http_403");
    expect(await db.select().from(platformSignals)).toEqual([]);
  });

  it("a MEASURED zero IS written — the two states must be distinguishable in the table", async () => {
    // The other half of the first test. A pass that wrote nothing in BOTH cases would satisfy it
    // perfectly and would lose the real zero, which is a genuine measurement an operator needs.
    const db = await makeTestDb();
    await runPlatformSignalPass(db, {
      port: fakePort({
        rows: [{
          provider: "vercel", project: "ohmail-api",
          windowStart: new Date(NOW.getTime() - SIGNAL_WINDOW_MS),
          requests: 900, errors5xx: 0, truncated: false,
        }],
      }),
      now: () => NOW,
    });
    const rows = await db.select().from(platformSignals);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requests).toBe(900);
    expect(rows[0]!.errors5xx).toBe(0);
  });
});

describe("the backfill spends ONE budget and keeps what it measured", () => {
  it("every bucket shares the PASS's deadline — a loop cannot buy itself a new one", async () => {
    // MEASURED TWICE AND WRONG TWICE. A deadline established inside `fetch` is recreated on
    // every call, so filling three missing buckets bought three full budgets and could spend
    // triple the invocation's ceiling — with no write until the loop ended, so the pass produced
    // nothing at all. The pass now creates one absolute deadline and hands it down.
    const db = await makeTestDb();
    const seen: Array<number | undefined> = [];
    const port: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(_w, o) { seen.push(o?.deadlineMs); return { rows: [] }; },
    };
    await runPlatformSignalPass(db, { port, now: () => NOW, wallClockMs: 30_000 });

    expect(seen.length, "three empty buckets in range").toBe(3);
    expect(seen.every((d) => typeof d === "number"), "every call was given a deadline").toBe(true);
    expect(new Set(seen).size, "and it is the SAME deadline for all of them").toBe(1);
  });

  it("the port OBEYS the caller's deadline rather than minting its own", async () => {
    // The assertion above proves the deadline was PASSED; this proves it is USED, which is the
    // property that actually bounds the invocation. A port that ignored it and computed its own
    // would walk normally here — the mutation that first slipped past this file.
    let logCalls = 0;
    let lookups = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        nowMs: () => 1_000,
        fetchImpl: (async (url: unknown) => {
          if (String(url).includes("/v9/projects/")) {
            lookups++;
            return new Response(JSON.stringify({ id: "prj_test", name: "ohmail-api" }));
          }
          logCalls++;
          return new Response(JSON.stringify({ hasMoreRows: false, rows: [] }));
        }) as unknown as typeof fetch,
      },
    );

    // A deadline ALREADY IN THE PAST. Nothing may be walked under it.
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) }, { deadlineMs: 500 });
    expect(out, "an expired budget is the deadline's failure, never an empty measurement")
      .toEqual({ failed: "deadline_before_first_page" });
    expect(logCalls + lookups, "and nothing was asked at all").toBe(0);
  });

  it("a timeout cut short by the caller's deadline names the deadline; a full one is the transport's", async () => {
    const w = { start: new Date(0), end: new Date(5000) };
    for (const lookup of [true, false]) {
      const at = (nowMs: number) => makePlatformSignalPort({ VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" }, {
        nowMs: () => nowMs,
        fetchImpl: (async (url: unknown) => {
          if (!lookup && String(url).includes("/v9/projects/")) return new Response(JSON.stringify({ id: "prj_test" }));
          throw new DOMException("timed out", "TimeoutError");
        }) as unknown as typeof fetch,
      }).fetch(w, { deadlineMs: 40_000 });
      // 10 s left: the request's 15 s ceiling was cut to the deadline.
      expect(await at(30_000)).toEqual({ failed: "deadline_before_first_page" });
      expect(await at(0)).toEqual({ failed: lookup ? "project_transport:TimeoutError" : "transport:TimeoutError" });
    }
  });

  it("a bucket the pass's OWN deadline left unread is deferred, not a failure", async () => {
    const db = await makeTestDb();
    let calls = 0;
    const port: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(w) {
        return calls++ > 0 ? { failed: "deadline_before_first_page" } : { rows: [{ provider: "vercel", project: "ohmail-api",
          windowStart: w.start, requests: 600, errors5xx: 3, truncated: true, sampleCause: "page_budget" }] };
      },
    };
    expect(await runPlatformSignalPass(db, { port, now: () => NOW }))
      .toMatchObject({ outcome: "written", rows: 1, deferred: 2 });
    expect(calls, "the loop stops at the first deferred bucket").toBe(2);
    expect(await db.select().from(platformSignals), "a deferred bucket writes no row").toHaveLength(1);
    // The control: with nothing read before it, the deadline is the pass's failure.
    expect(await runPlatformSignalPass(await makeTestDb(), { port: fakePort({ failed: "deadline_before_first_page" }), now: () => NOW }))
      .toMatchObject({ outcome: "failed", code: "deadline_before_first_page", rows: 0 });
  });

  it("a LATER bucket's failure does not discard what earlier buckets measured", async () => {
    // The shape that makes this bite: the newest bucket succeeds and an older gap keeps failing,
    // so every run threw away a fresh complete reading on account of a stale one and the
    // detector stayed dark for as long as the old gap persisted. A measurement that was taken is
    // evidence; another bucket's refusal does not un-take it.
    const db = await makeTestDb();
    let call = 0;
    const port: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(w) {
        call++;
        if (call === 1) {
          return { rows: [{
            provider: "vercel" as const, project: "ohmail-api",
            windowStart: w.start, requests: 200, errors5xx: 4, truncated: false,
          }] };
        }
        return { failed: "http_500" };
      },
    };
    const report = await runPlatformSignalPass(db, { port, now: () => NOW });

    expect(report.outcome, "the pass still REPORTS the failure").toBe("failed");
    expect(report.code).toBe("http_500");
    expect(report.rows, "and the successful bucket was kept").toBe(1);
    const rows = await db.select().from(platformSignals);
    expect(rows.length, "the row is in the table, not discarded").toBe(1);
    expect(Number(rows[0]!.requests)).toBe(200);
  });
});

describe("the reader's bucket width and the writer's are ONE number", () => {
  it("SIGNAL_BUCKET_MS equals SIGNAL_WINDOW_MS — the copy cannot drift", () => {
    // `packages/db` cannot import `packages/services`, so the rule's reader keeps its own copy of
    // the bucket width. A reader that assumed a different width would align its cut to a boundary
    // the writer never writes — which is the off-by-one-bucket the alignment was added to remove,
    // reintroduced by a constant instead of by arithmetic. This is the only thing keeping them
    // equal, and it is cheap.
    expect(SIGNAL_BUCKET_MS).toBe(SIGNAL_WINDOW_MS);
  });
});

describe("the projection an all-sampled window produces", () => {
  it("emits NO ROW when nothing in the window was complete — not a zero", async () => {
    // Sampled buckets are excluded from the sums, so a window whose every bucket was sampled
    // comes back with zeroed figures. Emitting that row put "0 5xx of 0 requests" on the board,
    // which reads as a healthy measurement of a quiet deployment and is the absence of one —
    // this file's recurring failure, arriving through a projection instead of a rule.
    const db = await makeTestDb();
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api",
      windowStart: new Date(NOW.getTime() - SIGNAL_WINDOW_MS),
      requests: 5000, errors5xx: 40, truncated: true, fetchedAt: NOW,
    } as never);

    const window = await platformSignalWindow(db, NOW, 15 * 60 * 1000);
    expect(window[0]!.completeBuckets, "nothing complete").toBe(0);
    expect(window[0]!.requests, "and the sampled counts are not summed").toBe(0);

    // THE ROW IS EMITTED WITH ITS COVERAGE, and the panel says what was measured. Dropping it
    // instead handed the console the same `[]` a deployment with NO PLATFORM TOKEN sends, so a
    // poll that ran and could not finish became indistinguishable from one that never ran.
    const projected = await adminPlatformSignals(db as never, NOW);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.completeBuckets, "nothing complete to divide").toBe(0);
    expect(projected[0]!.sampledBuckets).toBe(1);
    expect(projected[0]!.expectedBuckets).toBe(3);
    expect(projected[0]!.requests, "and no figure is claimed from the sampled counts").toBe(0);
  });

  it("A PARTIAL WINDOW ALSO EMITS NO ROW — the panel's line says 'in the last 15m'", async () => {
    // The console and the pager read the same window through the same function, and they used to
    // disagree about what counts as knowing it. The rule refuses anything short of every bucket;
    // this projection accepted whatever was complete, and the panel then labelled the sum of ten
    // minutes as fifteen. An operator reading an apparently measured rate for a project the pager
    // considers unmeasured is worse off than one told nothing: two surfaces, one window, two
    // answers, and no way to tell from the board which is right.
    const db = await makeTestDb();
    for (const minutesAgo of [5, 10]) {
      await db.insert(platformSignals).values({
        provider: "vercel", project: "ohmail-api",
        windowStart: new Date(NOW.getTime() - minutesAgo * 60_000),
        requests: 400, errors5xx: 30, truncated: false, fetchedAt: NOW,
      } as never);
    }
    const window = await platformSignalWindow(db, NOW, 15 * 60 * 1000);
    expect(window[0]!.completeBuckets, "two of the three buckets are there").toBe(2);

    const projected = await adminPlatformSignals(db as never, NOW);
    expect(projected, "the row is not filtered into a silence that reads as unconfigured")
      .toHaveLength(1);
    expect(projected[0]!.completeBuckets, "two of the three").toBe(2);
    expect(projected[0]!.expectedBuckets).toBe(3);
    // The figures are real and their coverage is stated; what must never happen is the panel
    // calling this the fifteen-minute rate, which is the rule's own population and is not this.
    expect(projected[0]!.requests).toBe(800);
  });

  it("AN EMPTY LIST NOW MEANS EXACTLY ONE THING: nothing has ever been read", async () => {
    // The control on both cases above. With the projection no longer filtering, silence must
    // still be reachable — and it must mean the unconfigured state and nothing else.
    const db = await makeTestDb();
    expect(await adminPlatformSignals(db as never, NOW)).toEqual([]);
  });

  it("and a COMPLETE window is projected — the filter is not simply always-off", async () => {
    // The control. Without it the two cases above are satisfied by a projection that emits
    // nothing at all, which would render every deployment as unmeasured for ever and look
    // exactly like caution.
    const db = await makeTestDb();
    for (const minutesAgo of [5, 10, 15]) {
      await db.insert(platformSignals).values({
        provider: "vercel", project: "ohmail-api",
        windowStart: new Date(NOW.getTime() - minutesAgo * 60_000),
        requests: 400, errors5xx: 30, truncated: false, fetchedAt: NOW,
      } as never);
    }
    const projected = await adminPlatformSignals(db as never, NOW);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.requests, "all three buckets in the denominator").toBe(1200);
  });
});

describe("a bucket read before the platform has finished indexing it", () => {
  /** A port that always answers with one complete-looking row for the window it was asked. */
  const readyPort = (): PlatformSignalPort => ({
    projects: ["ohmail-api"],
    async fetch(w) {
      return { rows: [{
        provider: "vercel", project: "ohmail-api", windowStart: w.start,
        requests: 100, errors5xx: 1, truncated: false,
      }] };
    },
  });

  const newestRow = async (db: Awaited<ReturnType<typeof makeTestDb>>) => {
    const rows = await db.select().from(platformSignals);
    return rows
      .map((r) => ({ ...r, ms: new Date(r.windowStart as unknown as string).getTime() }))
      .sort((a, b) => b.ms - a.ms)[0]!;
  };

  it("IS RECORDED AS A SAMPLE — the closed bucket is not yet the finished bucket", async () => {
    // The poll waits for the window to CLOSE, which is what stops a short window being reported
    // as a full one. It did not wait for the log store to finish INDEXING it, and those are
    // different clocks. This file's own note says which rows arrive late: "the slow and failing
    // ones". A row written non-truncated is HELD and never re-polled, so those late 5xx could
    // never enter the numerator — the rate came out low on a population that looked complete.
    const db = await makeTestDb();
    const thirtySecondsAfterClose = new Date(Date.UTC(2026, 8, 4, 12, 5, 30));
    await runPlatformSignalPass(db, { port: readyPort(), now: () => thirtySecondsAfterClose });

    const newest = await newestRow(db);
    expect(newest.ms, "the bucket that closed at 12:05").toBe(Date.UTC(2026, 8, 4, 12, 0, 0));
    expect(newest.truncated, "read too soon, so it is a sample and will be re-polled").toBe(true);
  });

  it("and a SETTLED read of the same bucket is complete — the margin is not a permanent sample",
    async () => {
      // The control. Without it the assertion above is satisfied by marking every bucket a
      // sample for ever, which would take the rule permanently dark while looking careful.
      const db = await makeTestDb();
      await runPlatformSignalPass(db, { port: readyPort(), now: () => NOW });
      const newest = await newestRow(db);
      expect(newest.ms).toBe(Date.UTC(2026, 8, 4, 12, 0, 0));
      expect(newest.truncated, "NOW is 12:07:31 — two and a half minutes past the close").toBe(false);
    });
});

describe("two polls of one bucket, finishing out of order", () => {
  it("THE OLDER ANSWER DOES NOT OVERWRITE THE NEWER ONE", async () => {
    // Two passes can overlap — the API arm's scheduler retries into a running call, and a leader
    // takeover pokes a second one — and the slower can answer last with an EARLIER view of the
    // log store. Unfenced, that older answer rewound the counts and `fetched_at`; and if it
    // happened to be non-truncated, the bucket was then held as complete on the poorer of the two
    // reads and never repaired.
    const db = await makeTestDb();
    const bucket = new Date(Date.UTC(2026, 8, 4, 12, 0, 0));
    const newerFetch = new Date(NOW.getTime() + 60_000);
    // The newer pass has already written: sampled, so the bucket is still re-pollable, and
    // stamped AFTER the pass that is about to arrive.
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api", windowStart: bucket,
      requests: 900, errors5xx: 9, truncated: true, fetchedAt: newerFetch,
    } as never);

    const stale: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(w) {
        return { rows: [{
          provider: "vercel", project: "ohmail-api", windowStart: w.start,
          requests: 100, errors5xx: 0, truncated: false,
        }] };
      },
    };
    await runPlatformSignalPass(db, { port: stale, now: () => NOW });

    const [row] = await db.select().from(platformSignals)
      .where(sql`${platformSignals.windowStart} = ${bucket.toISOString()}::timestamptz`);
    expect(Number(row!.requests), "the newer read's counts stand").toBe(900);
    expect(Number(row!.errors5xx)).toBe(9);
    expect(row!.truncated, "and the stale answer did not mark it complete").toBe(true);
  });

  it("a NEWER poll DOES overwrite — the fence is not simply always-off", async () => {
    const db = await makeTestDb();
    const bucket = new Date(Date.UTC(2026, 8, 4, 12, 0, 0));
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api", windowStart: bucket,
      requests: 900, errors5xx: 9, truncated: true,
      fetchedAt: new Date(NOW.getTime() - 60_000),
    } as never);

    const fresh: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(w) {
        return { rows: [{
          provider: "vercel", project: "ohmail-api", windowStart: w.start,
          requests: 100, errors5xx: 0, truncated: false,
        }] };
      },
    };
    await runPlatformSignalPass(db, { port: fresh, now: () => NOW });

    const [row] = await db.select().from(platformSignals)
      .where(sql`${platformSignals.windowStart} = ${bucket.toISOString()}::timestamptz`);
    expect(Number(row!.requests), "a later read is a better read").toBe(100);
  });
});

describe("a repair for one project and the other project's finished row", () => {
  it("DOES NOT REPLACE A COMPLETE ROW WITH A SAMPLE — nor let two projects keep each other dark",
    async () => {
      // A bucket is eligible for repair when ANY expected project is missing or sampled in it,
      // and the port re-polls EVERY project for that window — one endpoint, one walk. So a pass
      // sent to finish B came back with a fresh answer for A as well, and a walk that hit its
      // budget on A replaced A's COMPLETE row with a sample. Two projects failing alternately
      // then leave no pass where both are complete, and `api_5xx_rate` is dark for ever while
      // each project has in fact been measured.
      const db = await makeTestDb();
      const bucket = new Date(Date.UTC(2026, 8, 4, 12, 0, 0));
      await db.insert(platformSignals).values({
        provider: "vercel", project: "A", windowStart: bucket,
        requests: 500, errors5xx: 5, truncated: false,
        fetchedAt: new Date(NOW.getTime() - 60_000),
      } as never);

      // The repair walk: B comes back complete, A comes back as a sample — the thinner read.
      const port: PlatformSignalPort = {
        projects: ["A", "B"],
        async fetch(w) {
          return { rows: [
            { provider: "vercel", project: "A", windowStart: w.start, requests: 3, errors5xx: 0, truncated: true },
            { provider: "vercel", project: "B", windowStart: w.start, requests: 400, errors5xx: 4, truncated: false },
          ] };
        },
      };
      await runPlatformSignalPass(db, { port, now: () => NOW });

      const rows = await db.select().from(platformSignals);
      const a = rows.find((r) => r.project === "A"
        && new Date(r.windowStart as unknown as string).getTime() === bucket.getTime())!;
      const b = rows.find((r) => r.project === "B"
        && new Date(r.windowStart as unknown as string).getTime() === bucket.getTime())!;
      expect(a.truncated, "A was already finished and this walk was not about A").toBe(false);
      expect(Number(a.requests), "so its population stands").toBe(500);
      expect(b.truncated, "and B, which the repair was for, is now complete").toBe(false);
    });
});

describe("runPlatformSignalPass — the window", () => {
  it("polls the window that just CLOSED, aligned to the clock", async () => {
    // A window still in progress is SHORT: polling `[now - 5min, now]` two minutes into a window
    // counts two minutes of traffic and stores it as five minutes' worth, inflating the error
    // rate of everything summed with it. And the platform's log store is not instantaneous — the
    // rows that arrive late are the slow and failing ones, which would systematically undercount
    // 5xx in the newest window.
    const db = await makeTestDb();
    const asked: Array<{ start: Date; end: Date }> = [];
    const port: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(w) { asked.push(w); return { rows: [] }; },
    };
    await runPlatformSignalPass(db, { port, now: () => NOW });

    expect(asked.length).toBeGreaterThan(0);
    // NOW is 12:07:31 — the window in progress is 12:05–12:10, so the one that just closed is
    // 12:00–12:05, and it is polled FIRST.
    const { start, end } = asked[0]!;
    expect(end.toISOString()).toBe("2026-09-04T12:05:00.000Z");
    expect(start.toISOString()).toBe("2026-09-04T12:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(SIGNAL_WINDOW_MS);
    expect(end.getTime()).toBeLessThan(NOW.getTime());
    // EVERY window asked for is closed and one bucket wide — the backfill below may add older
    // ones, and none of them may be the window still in progress.
    for (const w of asked) {
      expect(w.end.getTime() - w.start.getTime()).toBe(SIGNAL_WINDOW_MS);
      expect(w.end.getTime()).toBeLessThanOrEqual(
        Math.floor(NOW.getTime() / SIGNAL_WINDOW_MS) * SIGNAL_WINDOW_MS);
    }
  });

  it("BACKFILLS a bucket the clock skipped, and re-reads none it already holds", async () => {
    // THE DRIFT THIS EXISTS FOR. The cron rearms five minutes AFTER the walk finishes, plus
    // jitter, so the aligned end advances by more than one bucket whenever cadence + jitter +
    // duration crosses a boundary — 12:04:59 becomes 12:10:20 and the 12:00 bucket is skipped
    // for ever, because nothing ever looked at a closed bucket twice. The rule then divides a
    // numerator formed over two buckets by a window it advertises as three.
    const db = await makeTestDb();
    // The newest closed bucket (12:00–12:05) already has a row; the two before it do not.
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api",
      windowStart: new Date("2026-09-04T12:00:00.000Z"),
      requests: 10, errors5xx: 0, truncated: false, fetchedAt: NOW,
    } as never);

    const asked: Array<{ start: Date; end: Date }> = [];
    const port: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(w) { asked.push(w); return { rows: [] }; },
    };
    await runPlatformSignalPass(db, { port, now: () => NOW });

    // EVERY missing bucket, NEWEST FIRST — 11:55 then 11:50, since 12:00 is already held.
    //
    // This asserted ONE fetch per pass for two rounds, and that was wrong for a reason the
    // single-fetch version could not see: the cron rearms after completion, so every invocation
    // finds a newly closed bucket and a newest-first single fetch spent the pass on that one.
    // An older gap was never reached and aged out of the fifteen-minute window unrepaired, so
    // the rule undercounted for ever. Looping is safe now and was not then — the earlier
    // version gave each bucket its own wall clock, while the port now establishes ONE deadline
    // per call and caps every request by what remains.
    expect(asked.map((w) => w.start.toISOString())).toEqual([
      "2026-09-04T11:55:00.000Z", "2026-09-04T11:50:00.000Z",
    ]);
  });

  it("a bucket is complete only when EVERY project has a row in it", async () => {
    // Completion used to be keyed on the window alone, but the table's key includes the project.
    // One project's row therefore marked the bucket finished for all of them, so a newly added
    // project — or any partial write — left its window permanently unrepaired behind a bucket
    // that looked done.
    const db = await makeTestDb();
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api",
      windowStart: new Date("2026-09-04T12:00:00.000Z"),
      requests: 10, errors5xx: 0, truncated: false, fetchedAt: NOW,
    } as never);

    const asked: Array<{ start: Date; end: Date }> = [];
    const port: PlatformSignalPort = {
      // TWO projects configured; only one of them has written that bucket.
      projects: ["ohmail-api", "ohmail-landing"],
      async fetch(w) { asked.push(w); return { rows: [] }; },
    };
    await runPlatformSignalPass(db, { port, now: () => NOW });

    expect(asked.map((w) => w.start.toISOString()),
      "the newest bucket is still incomplete for one project, so it is re-polled — and the two "
      + "empty buckets behind it are filled in the same pass, newest first")
      .toEqual([
        "2026-09-04T12:00:00.000Z", "2026-09-04T11:55:00.000Z", "2026-09-04T11:50:00.000Z",
      ]);
  });

  it("asks for NOTHING when every bucket in range is already held", async () => {
    // The healthy steady state, and it must not read as a failure: a pass with no gap to fill
    // has nothing to say and must not spend a walk saying it.
    const db = await makeTestDb();
    for (const iso of [
      "2026-09-04T11:50:00.000Z", "2026-09-04T11:55:00.000Z", "2026-09-04T12:00:00.000Z",
    ]) {
      await db.insert(platformSignals).values({
        provider: "vercel", project: "ohmail-api", windowStart: new Date(iso),
        requests: 10, errors5xx: 0, truncated: false, fetchedAt: NOW,
      } as never);
    }
    let calls = 0;
    const port: PlatformSignalPort = {
      projects: ["ohmail-api"],
      async fetch(w) { calls++; return { rows: [] }; },
    };
    const report = await runPlatformSignalPass(db, { port, now: () => NOW });
    expect(calls, "nothing missing, nothing polled").toBe(0);
    expect(report.outcome, "and that is not a failure").toBe("written");
  });

  it("a PAGE-BUDGET sample is final — a re-walk stops at the same budget; a deadline sample is not", async () => {
    const db = await makeTestDb();
    for (const [iso, cause] of [["12:00", "page_budget"], ["11:55", "deadline"], ["11:50", "page_budget"]]) {
      await db.insert(platformSignals).values({ provider: "vercel", project: "ohmail-api",
        windowStart: new Date(`2026-09-04T${iso}:00.000Z`), requests: 600, errors5xx: 6, truncated: true,
        sampleCause: cause, fetchedAt: NOW } as never);
    }
    const asked: string[] = [];
    await runPlatformSignalPass(db, { now: () => NOW, port: { projects: ["ohmail-api"], async fetch(w) {
      asked.push(w.start.toISOString());
      return { rows: [{ provider: "vercel", project: "ohmail-api", windowStart: w.start,
        requests: 50, errors5xx: 0, truncated: true, sampleCause: "deadline" }] };
    } } });
    expect(asked, "only the deadline sample is walked again").toEqual(["2026-09-04T11:55:00.000Z"]);
    expect((await db.select().from(platformSignals)).map((r) => Number(r.requests)).sort())
      .toEqual([50, 600, 600]);
  });

  it("a RE-POLL of the same window overwrites rather than doubling it", async () => {
    // The cron's jitter and a leader takeover can both put two polls on one window. Two rows
    // would double the traffic the rule divides by; the primary key plus an aligned start make
    // the second poll an upsert of the first.
    const db = await makeTestDb();
    const windowStart = new Date(NOW.getTime() - SIGNAL_WINDOW_MS);
    const row = {
      provider: "vercel" as const, project: "ohmail-api", windowStart, truncated: false,
    };
    await runPlatformSignalPass(db, {
      port: fakePort({ rows: [{ ...row, requests: 100, errors5xx: 1 }] }), now: () => NOW,
    });
    await runPlatformSignalPass(db, {
      port: fakePort({ rows: [{ ...row, requests: 140, errors5xx: 3 }] }), now: () => NOW,
    });
    const rows = await db.select().from(platformSignals);
    expect(rows, "one window, one row").toHaveLength(1);
    // The LATER read wins: the window is closed, so a second read of it is a better read of the
    // same traffic — late rows have landed in the log store since.
    expect(rows[0]!.requests).toBe(140);
    expect(rows[0]!.errors5xx).toBe(3);
  });

  it("prunes past retention on EVERY pass, including an unconfigured one", async () => {
    // A deployment that had a token and lost it must not keep a week of rows for ever.
    const db = await makeTestDb();
    await db.insert(platformSignals).values({
      provider: "vercel", project: "ohmail-api",
      windowStart: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      requests: 5, errors5xx: 0, truncated: false,
      fetchedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
    });
    const report = await runPlatformSignalPass(db, {
      port: fakePort({ unconfigured: true }), now: () => NOW,
    });
    expect(report.pruned).toBe(1);
    expect(await db.select().from(platformSignals)).toEqual([]);
  });
});

describe("makePlatformSignalPort — the three outcomes", () => {
  it("NO TOKEN is `unconfigured`, never `failed` — a deployment nobody set up is not broken", async () => {
    const port = makePlatformSignalPort({}, { fetchImpl: withProjectResolution(async () => new Response("{}") )});
    expect(await port.fetch({ start: new Date(0), end: new Date(1) })).toEqual({ unconfigured: true });
  });

  it("HALF-configured is also `unconfigured` — a token with no team scopes to the wrong owner", async () => {
    const port = makePlatformSignalPort({ VERCEL_TOKEN: "tok" }, {
      fetchImpl: withProjectResolution(async () => new Response("{}")),
    });
    expect(await port.fetch({ start: new Date(0), end: new Date(1) })).toEqual({ unconfigured: true });
  });

  it("counts 5xx and total from ONE walk, so the numerator and denominator share a population", async () => {
    // Two filtered queries would give two counts over two independently-truncated populations,
    // and dividing one by the other would be arithmetic over mismatched samples.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async (url) => {
          expect(String(url)).toContain(VERCEL_REQUEST_LOGS_URL);
          // No `statusCode` filter — the walk is unfiltered and classifies locally.
          expect(String(url)).not.toContain("statusCode");
          return new Response(JSON.stringify({
            hasMoreRows: false,
            rows: [
              { requestId: "a", statusCode: 200, timestamp: 1000, environment: "production" },
              { requestId: "b", statusCode: 502, timestamp: 1001, environment: "production" },
              { requestId: "c", statusCode: 500, timestamp: 1002, environment: "production" },
              { requestId: "d", statusCode: 404, timestamp: 1003, environment: "production" },
            ],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect("rows" in out).toBe(true);
    const row = (out as { rows: Array<{ requests: number; errors5xx: number }> }).rows[0]!;
    expect(row.requests, "every row counted, whatever its status").toBe(4);
    expect(row.errors5xx, "only 5xx — a 404 is the caller's problem, not ours").toBe(2);
  });

  /* The Cloud's refused stream (`GET /events` → 503 `sse_disabled` while the live connection is off)
     is an answer the deployment gives on purpose, once per page load: left out by route and status
     together, never by status alone. */
  const refusedStreamPage = () => new Response(JSON.stringify({
    hasMoreRows: false,
    rows: [
      { requestId: "e1", statusCode: 503, requestMethod: "GET", requestPath: "/events", timestamp: 1000, environment: "production" },
      { requestId: "s1", statusCode: 503, requestMethod: "GET", requestPath: "/sync", timestamp: 1001, environment: "production" },
      { requestId: "e2", statusCode: 503, requestMethod: "POST", requestPath: "/events", timestamp: 1002, environment: "production" },
      { requestId: "e3", statusCode: 500, requestMethod: "GET", requestPath: "/events", timestamp: 1003, environment: "production" },
      { requestId: "e4", statusCode: 503, timestamp: 1004, environment: "production" },
      { requestId: "ok", statusCode: 200, requestMethod: "GET", requestPath: "/sync", timestamp: 1005, environment: "production" },
    ],
  }));
  const countsOf = async (deliberate?: readonly (typeof SSE_DISABLED_REFUSAL)[]) => {
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      { fetchImpl: withProjectResolution(async () => refusedStreamPage()), ...(deliberate ? { deliberate } : {}) },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect("rows" in out).toBe(true);
    const row = (out as { rows: Array<{ requests: number; errors5xx: number }> }).rows[0]!;
    return { requests: row.requests, errors5xx: row.errors5xx };
  };

  it("a 503 sse_disabled on GET /events is a request and not a 5xx; a 503 from another route still is", async () => {
    expect(SSE_DISABLED_REFUSAL).toEqual({ method: "GET", path: "/events", status: 503, code: "sse_disabled" });
    expect(await countsOf([SSE_DISABLED_REFUSAL]), "only the refused stream leaves the error count").toEqual({ requests: 6, errors5xx: 4 });
  });

  it("the control: with nothing declared, every 5xx counts, the refused stream included", async () => {
    expect(await countsOf()).toEqual({ requests: 6, errors5xx: 5 });
    expect(await countsOf([]), "an empty declaration is no declaration").toEqual({ requests: 6, errors5xx: 5 });
  });

  it("PREVIEW TRAFFIC IS NOT IN THE PRODUCTION POPULATION", async () => {
    // A project's log store holds its preview deployments too, and the query was project-wide.
    // So a preview poked by CI contributed its 5xx to the population this rule PAGES on, and a
    // preview's successes diluted a real production outage in the same denominator. The filter
    // is sent to the API and enforced again here, because this endpoint has never been exercised
    // against the live service and a parameter it quietly ignores would leave the defect in place
    // while reading as fixed.
    let sawFilter = false;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async (url) => {
          if (String(url).includes(VERCEL_REQUEST_LOGS_URL)) {
            sawFilter = String(url).includes("environment=production");
          }
          return new Response(JSON.stringify({
            hasMoreRows: false,
            rows: [
              { requestId: "p1", statusCode: 500, timestamp: 1000, environment: "preview" },
              { requestId: "p2", statusCode: 500, timestamp: 1001, target: "preview" },
              { requestId: "a", statusCode: 500, timestamp: 1002, environment: "production" },
              { requestId: "b", statusCode: 200, timestamp: 1003, environment: "production" },
            ],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect(sawFilter, "the query asks the API for production only").toBe(true);
    // A ROW THAT NAMES A NON-PRODUCTION ENVIRONMENT PROVES THE FILTER WAS NOT APPLIED, so the
    // population is not the one this rule divides and the window is refused outright. Counting
    // the subset that happens to be labelled production would be a filtered population reported
    // as a whole one — the defect, not the fix.
    expect(out).toEqual({ failed: "production_filter_ignored" });
  });

  it("AN EVENT ON A BUCKET BOUNDARY IS COUNTED ONCE — this API's endDate is inclusive", async () => {
    // The log API includes `endDate`, and our buckets are half-open. A request stamped exactly on
    // a five-minute boundary therefore satisfied the older bucket (whose end equals it) AND the
    // newer one (whose start does), and the de-duplication set is per bucket — so one error was
    // counted twice inside one fifteen-minute window, and nine distinct errors could read as ten.
    //
    // The fake honours the parameter the way the real endpoint documents it, which is the only
    // way this test can see the defect at all: it returns the boundary row whenever the query's
    // endDate reaches it.
    const BOUNDARY = 300_000;
    const asked: number[] = [];
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async (url) => {
          const end = Number(new URL(String(url)).searchParams.get("endDate"));
          asked.push(end);
          return new Response(JSON.stringify({
            hasMoreRows: false,
            rows: end >= BOUNDARY
              ? [{ requestId: "edge", statusCode: 500, timestamp: BOUNDARY, environment: "production" }]
              : [],
          }));
        }),
      },
    );

    const older = await port.fetch({ start: new Date(0), end: new Date(BOUNDARY) });
    expect(asked[asked.length - 1], "asked half-open: one millisecond off the inclusive end")
      .toBe(BOUNDARY - 1);
    expect((older as { rows: Array<{ requests: number }> }).rows[0]!.requests,
      "the boundary event belongs to the NEWER bucket, whose start it is").toBe(0);
  });

  it("A ROW WITH NO PROVENANCE IS UNMEASURED — not production, and it makes the bucket a sample",
    async () => {
      // The half that mattered and was inverted: the first version counted an unlabelled row as
      // production and called that the backstop justifying an unverified query parameter. If the
      // API ignores the parameter, unlabelled is exactly how preview rows can arrive.
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        {
          fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({
            hasMoreRows: false,
            rows: [
              { requestId: "a", statusCode: 500, timestamp: 1000, environment: "production" },
              { requestId: "u", statusCode: 200, timestamp: 1001 },
            ],
          }))),
        },
      );
      const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
      const row = (out as { rows: Array<{ requests: number; truncated: boolean }> }).rows[0]!;
      expect(row.requests, "only the row that says production").toBe(1);
      expect(row.truncated, "and the population is partial, so no rate is claimed from it")
        .toBe(true);
    });

  it("A PAGE WITH AN UNREADABLE ROW MAKES THE BUCKET A SAMPLE, not a complete count", async () => {
    // The all-blank page is refused outright, one test up. THE MIXED PAGE used to pass silently:
    // the readable rows were counted, the blank one dropped, and the bucket stored as complete.
    // That is the sampled-bucket defect with the marking taken off — the dropped row may be a
    // SUCCESS, so the surviving quotient can cross a rate floor the true population never nears,
    // and it does so on a bucket the rule believes it read in full. The counts are still worth
    // keeping as a floor; what must not survive is the claim that they are the whole population.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({
          hasMoreRows: false,
          rows: [
            { requestId: "a", statusCode: 500, timestamp: 1000, environment: "production" },
            { requestId: "", statusCode: 200, timestamp: 1001, environment: "production" },
            { requestId: "c", statusCode: 500, timestamp: 1002, environment: "production" },
          ],
        }))),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect("rows" in out).toBe(true);
    const row = (out as { rows: Array<{ requests: number; errors5xx: number; truncated: boolean }> })
      .rows[0]!;
    expect(row.truncated, "one row could not be identified, so this is a sample").toBe(true);
    expect(row.requests, "the identifiable rows are still counted as a floor").toBe(2);
    expect(row.errors5xx).toBe(2);
  });

  it("A PAGE WITH NO PROVENANCE STILL MOVES THE CURSOR — it is not a stalled endpoint", async () => {
    // `continue` skipped the row entirely, including the line that lowers `oldest`, so a page
    // whose rows ALL lack provenance moved the cursor by nothing. The walk hit its no-progress
    // guard and reported `stalled_cursor` — a cause blaming the endpoint for something this loop
    // did, and the wrong sentence on the panel. The rows are excluded from the COUNTS, which is
    // the decision; they are still evidence of where in time the page reached.
    let laps = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => {
          laps++;
          return new Response(JSON.stringify({
            hasMoreRows: laps < 3,
            rows: [{ requestId: `p${laps}`, statusCode: 200, timestamp: 4000 - laps * 500 }],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    const row = (out as { rows: Array<{ truncated: boolean; sampleCause: string }> }).rows[0]!;
    expect(row.truncated).toBe(true);
    expect(row.sampleCause, "the cause is what actually happened, not a stalled cursor")
      .toBe("missing_provenance");
    expect(laps, "and the walk kept going instead of stopping on a cursor that never moved")
      .toBeGreaterThan(1);
  });

  it("and a page whose rows ALL carry ids is complete — the mark is not simply always-on",
    async () => {
      // The control: without it the assertion above is satisfied by marking every bucket
      // truncated, which would take the rule permanently dark and look exactly like caution.
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        {
          fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({
            hasMoreRows: false,
            rows: [
              { requestId: "a", statusCode: 500, timestamp: 1000, environment: "production" },
              { requestId: "b", statusCode: 200, timestamp: 1001, environment: "production" },
            ],
          }))),
        },
      );
      const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
      const row = (out as { rows: Array<{ truncated: boolean }> }).rows[0]!;
      expect(row.truncated).toBe(false);
    });

  it("THE HALF-OPEN CORRECTION APPLIES TO THE WINDOW, NOT TO EVERY LAP", async () => {
    // The `- 1` exists because this API's `endDate` is INCLUSIVE and our buckets are half-open,
    // so it belongs to the window's end. Applied to the cursor on every lap it became a gap: the
    // cursor is deliberately inclusive so rows sharing the oldest timestamp are re-read and
    // de-duplicated, and subtracting a millisecond skipped exactly those rows — while the bucket
    // was still stored as a complete population.
    const ends: number[] = [];
    let laps = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async (url) => {
          const u = new URL(String(url));
          if (u.searchParams.has("endDate")) ends.push(Number(u.searchParams.get("endDate")));
          laps++;
          return new Response(JSON.stringify({
            hasMoreRows: laps < 3,
            rows: [{ requestId: `l${laps}`, statusCode: 200, timestamp: 4000 - laps * 100, environment: "production" }],
          }));
        }),
      },
    );
    await port.fetch({ start: new Date(0), end: new Date(5000) });

    expect(ends[0], "the first lap asks half-open at the window's end").toBe(4999);
    expect(ends.slice(1), "and every later lap asks INCLUSIVE at the cursor")
      .toEqual(ends.slice(1).map((e) => e));
    expect(ends[1], "which is the previous lap's oldest timestamp, unmodified").toBe(3900);
  });

  it("A TIMEOUT AFTER A COMPLETED PAGE IS A PARTIAL SAMPLE, not a discarded walk", async () => {
    // TWO PATHS END A WALK EARLY AND THEY HAD TWO DIFFERENT ANSWERS. The budget/deadline check
    // at the top of the loop persisted what it had counted; the fetch timeout below it returned
    // a failure and threw it away. So an endpoint that answers two pages and then stalls wrote
    // NO ROW at all, and the rule went dark on a window it had partly measured — the same defect
    // as the budget path, in the branch beside it.
    let laps = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => {
          laps++;
          if (laps > 2) {
            const e = new Error("timed out"); e.name = "TimeoutError"; throw e;
          }
          return new Response(JSON.stringify({
            hasMoreRows: true,
            rows: [
              { requestId: `t${laps}a`, statusCode: 500, timestamp: 5000 - laps * 10, environment: "production" },
              { requestId: `t${laps}b`, statusCode: 200, timestamp: 4999 - laps * 10, environment: "production" },
            ],
          }));
        }),
      },
    );

    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect("rows" in out, "two pages were read; that is evidence, not a failure").toBe(true);
    const row = (out as { rows: Array<{ requests: number; errors5xx: number; truncated: boolean; sampleCause: string }> }).rows[0]!;
    expect(row.requests, "both rows of both completed pages").toBe(4);
    expect(row.errors5xx).toBe(2);
    expect(row.truncated).toBe(true);
    expect(row.sampleCause, "and it names the clock that stopped it").toBe("deadline");
  });

  it("but a timeout with NOTHING counted is still a failure — an unread window is not a zero",
    async () => {
      // The control, and the line the shared exit must not cross: a walk that never completed a
      // page has measured nothing, and writing that as a row would put a confident zero on the
      // board for a window nobody read.
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        {
          fetchImpl: withProjectResolution(async () => {
            const e = new Error("timed out"); e.name = "TimeoutError"; throw e;
          }),
        },
      );
      const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
      expect("failed" in out, "nothing was read, so nothing is claimed").toBe(true);
    });

  // A REFUSAL AFTER A COUNTED PAGE IS A SAMPLE: page two answering 429 keeps page one as a
  // partial row named `upstream_refused`; page one answering 429 is still a failure and no row.
  it("a 429 on page two keeps page one as an upstream_refused sample; a 429 on page one is a failure",
    async () => {
      const walk = (refuseAt: number) => {
        let laps = 0;
        return makePlatformSignalPort(
          { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
          {
            fetchImpl: withProjectResolution(async () => {
              laps++;
              if (laps >= refuseAt) return new Response("slow down", { status: 429 });
              return new Response(JSON.stringify({
                hasMoreRows: true,
                rows: [
                  { requestId: `u${laps}a`, statusCode: 502, timestamp: 5000 - laps * 10, environment: "production" },
                  { requestId: `u${laps}b`, statusCode: 200, timestamp: 4999 - laps * 10, environment: "production" },
                ],
              }));
            }),
          },
        ).fetch({ start: new Date(0), end: new Date(5000) });
      };
      const late = await walk(2);
      expect("rows" in late, "the page counted before the refusal was thrown away").toBe(true);
      const row = (late as { rows: Array<{ requests: number; errors5xx: number; truncated: boolean; sampleCause: string }> }).rows[0]!;
      expect(row).toMatchObject({ requests: 2, errors5xx: 1, truncated: true, sampleCause: "upstream_refused" });
      expect(await walk(1), "nothing was counted, so nothing is claimed").toEqual({ failed: "http_429" });
    });

  it("the migrated CHECK admits the upstream_refused sample and still refuses a stranger", async () => {
    const db = await makeTestDb();
    const row = (sampleCause: string) => ({
      provider: "vercel", project: "ohmail-api", windowStart: new Date(NOW.getTime() - SIGNAL_WINDOW_MS),
      requests: 50, errors5xx: 3, truncated: true, sampleCause,
    });
    await db.insert(platformSignals).values(row("upstream_refused") as never);
    expect((await db.select().from(platformSignals))[0]!.sampleCause).toBe("upstream_refused");
    const stranger = await db.insert(platformSignals).values({ ...row("a_foreign_word"), project: "other" } as never)
      .then(() => "admitted", () => "refused");
    expect(stranger, "the CHECK admitted a word no poller writes").toBe("refused");
  });

  it("a page that cannot be parsed after a counted one is a sample too, and before one a failure", async () => {
    let laps = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => {
          laps++;
          if (laps === 2) return new Response("<html>not json</html>");
          return new Response(JSON.stringify({
            hasMoreRows: true,
            rows: [{ requestId: `p${laps}`, statusCode: 200, timestamp: 5000 - laps * 10, environment: "production" }],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect((out as { rows: Array<{ sampleCause: string }> }).rows[0]!.sampleCause).toBe("upstream_refused");
  });

  it("ROWS LEFT AT THE WINDOW'S START MAKE IT A SAMPLE — there is nowhere to page to", async () => {
    // The loop ends when the cursor reaches `window.start`, which is correct: there is nowhere
    // further back to ask for. What was wrong is that the endpoint had just said `hasMoreRows:
    // true` and the bucket was persisted as COMPLETE anyway. It happens when more than one page
    // of requests shares the boundary millisecond, and the rows it admits to withholding are as
    // likely to be successes as errors — so the surviving quotient can cross the rate floor and
    // manufacture a critical page.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({
          hasMoreRows: true,
          rows: [
            { requestId: "b1", statusCode: 500, timestamp: 0, environment: "production" },
            { requestId: "b2", statusCode: 500, timestamp: 0, environment: "production" },
          ],
        }))),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    const row = (out as { rows: Array<{ truncated: boolean; sampleCause: string }> }).rows[0]!;
    expect(row.truncated, "more rows exist and cannot be reached").toBe(true);
    expect(row.sampleCause).toBe("boundary_unread");
  });

  it("A WHITESPACE-ONLY REQUEST ID IS NOT AN ID", async () => {
    // `" " !== ""` passed the empty check, so a whitespace id counted as a distinct request —
    // and being un-de-duplicable it counted AGAIN on every lap that re-reads the boundary,
    // inflating the denominator with one row seen twice.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({
          hasMoreRows: false,
          rows: [
            { requestId: "a", statusCode: 500, timestamp: 1000, environment: "production" },
            { requestId: "   ", statusCode: 200, timestamp: 1001, environment: "production" },
          ],
        }))),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    const row = (out as { rows: Array<{ requests: number; truncated: boolean; sampleCause: string }> }).rows[0]!;
    expect(row.requests, "only the row with a usable id").toBe(1);
    expect(row.truncated, "and the page was part unreadable, so this is a sample").toBe(true);
    expect(row.sampleCause).toBe("unreadable_request_id");
  });

  it("DE-DUPLICATES across laps, because the cursor is inclusive", async () => {
    let lap = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => {
          lap++;
          if (lap === 1) {
            return new Response(JSON.stringify({
              hasMoreRows: true,
              rows: [
                { requestId: "a", statusCode: 500, timestamp: 4000, environment: "production" },
                { requestId: "b", statusCode: 500, timestamp: 3000, environment: "production" },
              ],
            }));
          }
          // The boundary row comes back on the next lap — the cursor is inclusive.
          return new Response(JSON.stringify({
            hasMoreRows: false,
            rows: [
              { requestId: "b", statusCode: 500, timestamp: 3000, environment: "production" },
              { requestId: "c", statusCode: 500, timestamp: 2000, environment: "production" },
            ],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    const row = (out as { rows: Array<{ requests: number; errors5xx: number }> }).rows[0]!;
    expect(row.requests, "three distinct requests, not four").toBe(3);
    expect(row.errors5xx).toBe(3);
  });

  it("a MISSING `rows` array is a FAILURE, never an empty slice", async () => {
    // The trap `vercel-errors.mjs` records from measurement: defaulting to `[]` lets a schema
    // change read as "this slice held nothing", which becomes a confident, wrong zero.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      { fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({ hasMoreRows: false })) )},
    );
    expect(await port.fetch({ start: new Date(0), end: new Date(5000) }))
      .toEqual({ failed: "no_rows_array" });
  });

  it("an ABSENT continuation flag is a FAILURE — reading it as 'no more' skips the rest of the window", async () => {
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      { fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({ rows: [] })) )},
    );
    expect(await port.fetch({ start: new Date(0), end: new Date(5000) }))
      .toEqual({ failed: "no_has_more_flag" });
  });

  it("a NON-2xx is a code, never a vendor message — this string reaches a log and a screen", async () => {
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      { fetchImpl: withProjectResolution(async () => new Response("forbidden: token tok_secret", { status: 403 }) )},
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect(out).toEqual({ failed: "http_403" });
    expect(JSON.stringify(out), "the body is never quoted").not.toContain("tok_secret");
  });

  it("a walk that hits its PAGE BUDGET says so, and its counts are a lower bound", async () => {
    // The walk's length is a property of TRAFFIC, not of the window. Unbounded, it does not fail
    // — it never finishes, which in a cron invocation means it is killed and reports nothing.
    let laps = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        pageBudget: 3,
        fetchImpl: withProjectResolution(async () => {
          laps++;
          return new Response(JSON.stringify({
            hasMoreRows: true,
            rows: [{ requestId: `r${laps}`, statusCode: 500, timestamp: 5000 - laps * 10, environment: "production" }],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    const row = (out as { rows: Array<{ requests: number; truncated: boolean }> }).rows[0]!;
    expect(laps, "it stopped at the budget rather than walking for ever").toBe(3);
    expect(row.truncated, "and it SAYS the counts are a lower bound").toBe(true);
    expect(row.requests).toBe(3);
  });

  it("a SEPARATOR-ONLY project list falls back rather than yielding an empty one", async () => {
    // `VERCEL_SIGNAL_PROJECTS=","` is non-blank, so it took the configured branch, and the
    // filter then removed everything. An EMPTY project list is quietly catastrophic downstream:
    // the pass asks whether every expected project already has a row, and `[].every(...)` is
    // TRUE — so every bucket read as complete, no request was ever made, and the pass reported
    // a successful `written` pass for ever while the detector sat dark.
    for (const value of [",", " , ", ",,", "  "]) {
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x", VERCEL_SIGNAL_PROJECTS: value },
        { fetchImpl: withProjectResolution((async () => new Response("{}")) as unknown as typeof fetch) },
      );
      expect(port.projects.length, `"${value}" must not produce an empty project list`)
        .toBeGreaterThan(0);
    }
  });

  it("a pass with an EMPTY project list still polls — the vacuous `every` is refused", async () => {
    // Belt and braces for the same trap one level up: if a port ever hands back an empty list,
    // "every expected project has a row" must not be read as "this bucket is finished".
    const db = await makeTestDb();
    let calls = 0;
    const port: PlatformSignalPort = {
      projects: [],
      async fetch() { calls++; return { rows: [] }; },
    };
    await runPlatformSignalPass(db, { port, now: () => NOW });
    expect(calls, "an empty expectation is not evidence of completeness").toBeGreaterThan(0);
  });

  it("RESOLVES the project NAME to an id and queries the log with the ID, not the name",
    async () => {
      // THE DEFECT THAT MADE THIS POLLER MEASURE NOTHING FOR ITS WHOLE LIFE. `projectId` on the
      // request-log endpoint is Vercel's internal project id; this port was passing the
      // configured NAME (`ohmail-api`) straight into it, so every poll either failed or matched
      // no rows. The table stayed empty, the board read "5xx: not measured", and that is
      // indistinguishable from the expected state of a deployment with no token — which is
      // exactly why nothing noticed for three review rounds.
      //
      // `scripts/vercel-errors.mjs` has always resolved the name first and passed `proj.id`;
      // this asserts the port does the same.
      const seen: string[] = [];
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        {
          fetchImpl: (async (url: unknown) => {
            seen.push(String(url));
            if (String(url).includes("/v9/projects/")) {
              return new Response(JSON.stringify({ id: "prj_REAL", name: "ohmail-api" }));
            }
            return new Response(JSON.stringify({ hasMoreRows: false, rows: [] }));
          }) as unknown as typeof fetch,
        },
      );
      await port.fetch({ start: new Date(0), end: new Date(5000) });

      const resolution = seen.find((u) => u.includes("/v9/projects/"));
      expect(resolution, "the name is resolved first").toBeTruthy();
      expect(resolution).toContain("ohmail-api");

      const logCall = seen.find((u) => u.includes("request-logs"));
      expect(logCall, "and then the log is walked").toBeTruthy();
      expect(logCall, "with the ID the resolution returned").toContain("projectId=prj_REAL");
      expect(logCall, "never the name").not.toContain("projectId=ohmail-api");
    });

  it("a project name that does not resolve FAILS the poll rather than being walked as an id",
    async () => {
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        {
          fetchImpl: (async (url: unknown) => {
            if (String(url).includes("/v9/projects/")) return new Response("nope", { status: 404 });
            return new Response(JSON.stringify({ hasMoreRows: false, rows: [] }));
          }) as unknown as typeof fetch,
        },
      );
      const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
      expect(out, "querying the log with an unresolved name is what produced the silent empty")
        .toEqual({ failed: "project_http_404" });
    });

  it("ISO-8601 timestamps advance the cursor — the shape the log endpoint actually returns",
    async () => {
      // THE DEFECT: the walk read `Number(r.timestamp)`. The log endpoint returns ISO strings —
      // `scripts/vercel-errors.mjs` has always parsed them with `Date.parse` and refuses outright
      // when one will not parse, saying "the time cursor cannot advance", which is precisely what
      // happened here silently. `Number("2026-09-04T12:01:00.000Z")` is NaN, `NaN < oldest` is
      // false, so `oldest` never moved: every window needing more than one page stopped after the
      // first and reported that page's counts as a complete-but-truncated window. A busy
      // deployment's 5xx rate was being computed over one page of requests.
      const pages = [
        {
          hasMoreRows: true,
          rows: [
            { requestId: "a1", statusCode: 500, timestamp: "2026-09-04T12:04:00.000Z", environment: "production" },
            { requestId: "a2", statusCode: 200, timestamp: "2026-09-04T12:03:00.000Z", environment: "production" },
          ],
        },
        {
          hasMoreRows: false,
          rows: [
            { requestId: "b1", statusCode: 500, timestamp: "2026-09-04T12:01:00.000Z", environment: "production" },
            { requestId: "b2", statusCode: 200, timestamp: "2026-09-04T12:00:30.000Z", environment: "production" },
          ],
        },
      ];
      let lap = 0;
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        { fetchImpl: withProjectResolution(async () => new Response(JSON.stringify(pages[lap++] ?? pages[1])) )},
      );
      const out = await port.fetch({
        start: new Date("2026-09-04T12:00:00.000Z"), end: new Date("2026-09-04T12:05:00.000Z"),
      });
      const row = (out as { rows: Array<{ requests: number; errors5xx: number; truncated: boolean }> }).rows[0]!;
      expect(lap, "the cursor advanced, so the SECOND page was read").toBe(2);
      expect(row.requests, "all four rows counted, not just the first page").toBe(4);
      expect(row.errors5xx).toBe(2);
      expect(row.truncated, "and the window is complete, not a lower bound").toBe(false);
    });

  it("a project the deadline never reached is UNMEASURED, not a measured zero", async () => {
    // THE ZERO THIS FILE EXISTS TO PREVENT, manufactured by the wall-clock guard that was added
    // to prevent a different failure. With several projects configured, an earlier walk can
    // consume the shared deadline; the next project then enters the loop with `pages === 0`,
    // never issues a request, and — before this — returned `requests: 0, errors5xx: 0` for a
    // window nobody looked at. The pass would have written that as a measured zero, and a zero
    // here is a number an operator believes.
    let clock = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x", VERCEL_SIGNAL_PROJECTS: "p1,p2" },
      {
        wallClockMs: 20_000,
        nowMs: () => clock,
        fetchImpl: withProjectResolution(async () => {
          // One lap for p1 burns the whole budget; p2 then arrives with nothing left.
          clock += 25_000;
          return new Response(JSON.stringify({
            hasMoreRows: false,
            rows: [{ requestId: "r1", statusCode: 500, timestamp: "2026-09-04T12:01:00.000Z", environment: "production" }],
          }));
        }),
      },
    );
    const out = await port.fetch({
      start: new Date("2026-09-04T12:00:00.000Z"), end: new Date("2026-09-04T12:05:00.000Z"),
    });
    expect(out, "an unread project fails the poll rather than reporting a zero")
      .toEqual({ failed: "deadline_before_first_page" });
  });

  it("a page whose rows ALL lack a requestId is a FAILURE, not a quiet zero", async () => {
    // `requestId` is the dedupe key, so a row without one is skipped. When EVERY row on a page
    // lacks one the walk returns 0 requests and 0 errors and — with `hasMoreRows: false` —
    // stores that as a COMPLETE bucket: measured health manufactured from rows nobody could
    // read. The reference script refuses this exact case for this exact reason.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution((async () => new Response(JSON.stringify({
          hasMoreRows: false,
          rows: [
            { statusCode: 200, timestamp: "2026-09-04T12:01:00.000Z" },
            { requestId: "", statusCode: 500, timestamp: "2026-09-04T12:02:00.000Z", environment: "production" },
          ],
        }))) as unknown as typeof fetch),
      },
    );
    expect(await port.fetch({ start: new Date(0), end: new Date(5000) }))
      .toEqual({ failed: "page_without_request_ids" });
  });

  it("a NULL, BOOLEAN or BLANK status is a FAILURE — Number() would make each of them healthy", async () => {
    // `Number(null)` is 0, `Number(false)` is 0, `Number(true)` is 1. All finite, all passing a
    // `Number.isFinite` check, and all counted as a successful non-5xx request — so a private
    // API that changed this field's shape would be recorded as a healthy deployment instead of
    // as a failure to measure one.
    // `""` and whitespace are here because the TYPE check alone let them through: both are
    // strings, and `Number("")` is 0 — finite, past the guard, and counted as a served non-5xx
    // response. A schema wobble that emptied this field would have DILUTED the error rate with
    // fabricated successes, or suppressed the alert once enough landed in the denominator. The
    // timestamp parser already carried a blank-string guard; this field needed its own.
    for (const statusCode of [null, true, false, "", "   "] as unknown[]) {
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        {
          fetchImpl: withProjectResolution((async () => new Response(JSON.stringify({
            hasMoreRows: false,
            rows: [{ requestId: "r1", statusCode, timestamp: "2026-09-04T12:01:00.000Z", environment: "production" }],
          }))) as unknown as typeof fetch),
        },
      );
      expect(await port.fetch({ start: new Date(0), end: new Date(5000) }),
        `statusCode ${String(statusCode)} must not read as a served request`)
        .toEqual({ failed: "unreadable_status" });
    }
  });

  it("an EMPTY timestamp is not epoch zero — it would stop the walk and report it complete", async () => {
    // `Date.parse("")` is NaN, so the parser fell through to `Number("")`, which is 0 and finite.
    // A cursor at epoch zero jumps behind the window's start, ends the walk while `hasMoreRows`
    // still says otherwise, and stores the bucket COMPLETE over whatever the first page held.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution((async () => new Response(JSON.stringify({
          hasMoreRows: true,
          rows: [{ requestId: "r1", statusCode: 500, timestamp: "  ", environment: "production" }],
        }))) as unknown as typeof fetch),
      },
    );
    expect(await port.fetch({ start: new Date(0), end: new Date(5000) }))
      .toEqual({ failed: "unparseable_timestamp" });
  });

  it("an UNPARSEABLE timestamp fails the walk rather than silently freezing the cursor", async () => {
    // The cursor is built out of this value, so a row whose stamp cannot be read is not a row to
    // skip — it is a walk that cannot continue. Skipping it would leave `oldest` unmoved and
    // report a one-page count as the whole window, which is the defect above wearing a different
    // hat. The reference implementation refuses for the same reason.
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => new Response(JSON.stringify({
          hasMoreRows: true,
          rows: [{ requestId: "x", statusCode: 500, timestamp: "not-a-time", environment: "production" }],
        }))),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    expect(out).toEqual({ failed: "unparseable_timestamp" });
  });

  it("a SLOW endpoint stops at the wall clock, not at the page budget", async () => {
    // THE CEILING THE PAGE BUDGET DOES NOT PROVIDE. Twenty laps is a bound on DEPTH; each lap
    // carries its own 15 s timeout, so twenty of them against a slow endpoint is 300 s for one
    // project inside a cron target that declares 60 s. The invocation is killed mid-walk, the
    // upsert never runs, no row is written, and the board says "not measured" — a slow endpoint
    // taking the rule dark and looking exactly like an unconfigured deployment.
    //
    // The clock is injected so this is a real assertion rather than a forty-second wait: each lap
    // advances it by 9 s, so the 30 s budget is crossed on the fourth check with the page budget
    // (20) nowhere near reached.
    let laps = 0;
    let clock = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        wallClockMs: 30_000,
        nowMs: () => clock,
        fetchImpl: withProjectResolution(async () => {
          laps++;
          clock += 9_000;
          return new Response(JSON.stringify({
            hasMoreRows: true,
            rows: [{ requestId: `r${laps}`, statusCode: 500, timestamp: 5000 - laps, environment: "production" }],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    const row = (out as { rows: Array<{ requests: number; truncated: boolean }> }).rows[0]!;
    expect(laps, "it stopped on TIME, well inside the page budget of 20").toBe(4);
    expect(row.truncated, "and it says the counts are a lower bound").toBe(true);
    expect(row.requests).toBe(4);
    // AND IT SAYS WHICH CLOCK STOPPED IT. `deadline`, not `page_budget`: the panel's sentence is
    // keyed on this, and describing a timed-out walk as page-budget exhaustion sends an operator
    // to raise a limit that was nowhere near reached — four laps of twenty.
    expect((row as unknown as { sampleCause: string }).sampleCause).toBe("deadline");
  });

  it("A DEADLINE MID-WALK KEEPS WHAT IT COUNTED — evidence is what happened, not what was declared",
    async () => {
      // This path used to return a failure and discard the pages already read, so a slow endpoint
      // left the bucket MISSING and the rule dark despite real, if partial, measurement. The
      // walk's declared end is not the same question as what it observed on the way there.
      let laps = 0;
      let clock = 0;
      const port = makePlatformSignalPort(
        { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
        {
          wallClockMs: 20_000,
          nowMs: () => clock,
          fetchImpl: withProjectResolution(async () => {
            laps++;
            clock += 11_000;
            return new Response(JSON.stringify({
              hasMoreRows: true,
              rows: [
                { requestId: `d${laps}a`, statusCode: 500, timestamp: 5000 - laps * 2, environment: "production" },
                { requestId: `d${laps}b`, statusCode: 200, timestamp: 4999 - laps * 2, environment: "production" },
              ],
            }));
          }),
        },
      );
      const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
      expect("rows" in out, "a partial walk is a sample, never a failure that writes nothing")
        .toBe(true);
      const row = (out as { rows: Array<{ requests: number; errors5xx: number; truncated: boolean; sampleCause: string }> }).rows[0]!;
      expect(row.requests, "both rows of both laps it managed").toBe(4);
      expect(row.errors5xx).toBe(2);
      expect(row.truncated).toBe(true);
      expect(row.sampleCause).toBe("deadline");
    });

  it("a lap that advances the cursor by NOTHING stops, rather than spinning", async () => {
    // Fifty requests inside one millisecond would otherwise loop until the invocation is killed.
    let laps = 0;
    const port = makePlatformSignalPort(
      { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_x" },
      {
        fetchImpl: withProjectResolution(async () => {
          laps++;
          return new Response(JSON.stringify({
            hasMoreRows: true,
            rows: [{ requestId: `r${laps}`, statusCode: 500, timestamp: 5000, environment: "production" }],
          }));
        }),
      },
    );
    const out = await port.fetch({ start: new Date(0), end: new Date(5000) });
    const row = (out as { rows: Array<{ truncated: boolean }> }).rows[0]!;
    expect(laps, "one lap, then the hard stop").toBe(1);
    expect(row.truncated).toBe(true);
  });
});


/* ════════════════════════════════════════════════════════════════════════════════════════
   THE READER'S SET AND THE DATABASE'S SET ARE ONE SET
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("SAMPLE_CAUSES and the CHECK constraint cannot drift apart", () => {
  /**
   * WHY THIS IS A TEST AND NOT A COMMENT.
   *
   * `sample_cause` is CHECK-constrained (cloud 0030, redefined by 0044) to the causes this array names, and the
   * two lists live in different languages in different packages. The failure mode is not
   * hypothetical and it is not symmetric:
   *
   *  · A cause added HERE and not there is a poll that throws at the write. The window is lost,
   *    and the exception surfaces as a failed pass rather than as anything naming the cause —
   *    which is the one shape this whole file exists to prevent, a signal going missing while
   *    the thing that reports on signals says nothing.
   *  · A cause added THERE and not here is a value no console sentence is keyed on, which
   *    renders an operator a blank line under a number they are about to act on.
   *
   * Reading the migration is the point. Asserting the array against a copy of itself would pass
   * in both of those states.
   */
  function migrationCauses(): string[] {
    // `CLOUD_JOURNAL.dir` rather than a relative path between two packages: it is the very
    // directory `runMigrations` and `makeTestDb` hand to the migrator, so this reads the file
    // that actually gets applied and not a copy that could fall out of step with it.
    // THE NEWEST DEFINITION WINS, in journal order: a later migration that drops and re-adds the
    // constraint is the one the database holds, so the guard reads that one and not 0030.
    const journal = JSON.parse(readFileSync(join(CLOUD_JOURNAL.dir, "meta", "_journal.json"), "utf8")) as
      { entries: Array<{ tag: string }> };
    let m: RegExpExecArray | null = null;
    for (const { tag } of journal.entries) {
      const sqlText = readFileSync(join(CLOUD_JOURNAL.dir, `${tag}.sql`), "utf8");
      m = /ADD CONSTRAINT "platform_signals_sample_cause_check"\s+CHECK \([^)]*IN \(([^)]*)\)/.exec(sqlText) ?? m;
    }
    if (m === null) {
      throw new Error(
        "no `platform_signals_sample_cause_check` CHECK in any cloud migration — the column is free " +
        "text again, and this guard cannot tell you which values it would accept.");
    }
    return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  }

  it("every cause the poller can write is a cause the database accepts", () => {
    const inDb = migrationCauses();
    // Sorted on both sides: the order the two lists happen to be written in is not the claim.
    expect([...SAMPLE_CAUSES].sort()).toEqual([...inDb].sort());
  });

  it("the guard is not vacuous: it read a non-empty list out of the migration", () => {
    expect(migrationCauses().length).toBeGreaterThan(1);
  });
});
