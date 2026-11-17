/**
 * THE MEMO READ OVER ROWS A REAL POSTGRES MINTED — two arms.
 *
 *   bash scripts/lane-db.sh "$PWD"
 *   set -a; . ./.lane-db.env; set +a
 *   node --expose-gc --max-old-space-size=8192 --import tsx \
 *        apps/worker/test/rigs/known-set-real-rows-rig.mjs --arm charge --mailboxes 8 --messages 20000
 *   node --expose-gc --max-old-space-size=8192 --import tsx \
 *        apps/worker/test/rigs/known-set-real-rows-rig.mjs --arm roster --mailboxes N --total M --skew 0.8 --cycles 5
 *
 * `known-set-peak-rig.mjs` builds its projections in JavaScript, so its strings are the ones a
 * template literal makes. What the memo actually holds are the strings postgres.js mints out of a
 * `DataRow` in text mode, and those are the only ones the budget's per-entry charge and its
 * admission decisions have to be true of. This rig seeds a lane database and reads through the
 * shape `listKnownLocators` returns.
 *
 * It runs on a LANE database (`.lane-db.env`) and refuses the shared box. The seed is synthetic and
 * is dropped at the end; no roster figure is written into this file.
 */
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const ARM = String(arg("arm", "charge"));
const MAILBOXES = Number(arg("mailboxes", 8));
const MESSAGES = Number(arg("messages", 20000));
/** The roster arm's TOTAL across the roster; the per-mailbox split is `rosterPlan`'s. */
const TOTAL = Number(arg("total", MAILBOXES * MESSAGES));
/**
 * The share of the roster's messages held by its heaviest fifth. 0 is a uniform split. A skew
 * matters because the budget is bytes, not mailboxes: the same roster total arranged as a few big
 * projections and many small ones evicts differently from an even one, and neither arrangement is
 * the one to size a bound on alone.
 */
const SKEW = Number(arg("skew", 0));
const CYCLES = Number(arg("cycles", 5));

if (has("check")) {
  // The plan is the only arithmetic here, so it is the only thing a check can be about: it sums to
  // the total it was given, it is as long as the roster, and a skew really does load the first
  // fifth. A check that only asserted the length would pass for a plan of zeroes.
  const fail = (m) => { console.error(`CHECK FAILED: ${m}`); process.exit(1); };
  // Arbitrary shapes, chosen so the remainder is non-zero and the fifth is not a whole number.
  const N = 23, T = 61111;
  const u = rosterPlan(N, T, 0);
  if (u.length !== N) fail("uniform plan is not the roster's length");
  if (u.reduce((a, b) => a + b, 0) !== T) fail("uniform plan does not sum to the total");
  if (Math.max(...u) - Math.min(...u) > 1) fail("uniform plan is not uniform");
  const s2 = rosterPlan(N, T, 0.8);
  if (s2.length !== N) fail("skewed plan is not the roster's length");
  if (s2.reduce((a, b) => a + b, 0) !== T) fail("skewed plan does not sum to the total");
  const heavyN = Math.max(1, Math.round(N / 5));
  const heavy = s2.slice(0, heavyN).reduce((a, b) => a + b, 0);
  if (!(heavy / T > 0.75 && heavy / T < 0.85)) fail("skewed plan does not load its first fifth");
  if (!(s2[0] > s2[N - 1] * 5)) fail("skewed plan's heavy mailbox is not heavier than its light one");
  console.log(JSON.stringify({ check: "ok", roster: u.length, heavyMailboxes: heavyN,
    skewedHeavyShare: Math.round((heavy / T) * 100) / 100 }));
  process.exit(0);
}


/** `scripts/lane-db.sh` writes `PG_TEST_URL`; `DATABASE_URL` is accepted for a hand-set run. */
const url = process.env.PG_TEST_URL ?? process.env.DATABASE_URL ?? "";
if (!url) throw new Error("rig: source .lane-db.env first — this never runs on the shared box");
if (/trafficflow_test(\b|$)/.test(url)) throw new Error("rig: that is the SHARED box; run it on a lane database");

const postgres = (await import("postgres")).default;
const { estimateRetainedBytes, KnownSetCache, KnownSetBudget, KNOWN_SET_BUDGET_BYTES } =
  await import("../../../../packages/organizer/src/known-set.ts");

const MIB = 1024 * 1024;
const mib = (b) => Math.round((b / MIB) * 100) / 100;
const collect = () => { global.gc(); global.gc(); };

/**
 * The per-mailbox message counts. Uniform spreads the remainder one row at a time so the plan sums
 * to the total exactly; a skew gives the heaviest fifth `SKEW` of the total and splits each half
 * evenly within itself. The heavy mailboxes come FIRST, so a round-robin meets them first.
 */
export function rosterPlan(mailboxes, total, skew) {
  const spread = (n, sum) => {
    const base = Math.floor(sum / n), rem = sum - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  };
  if (!skew) return spread(mailboxes, total);
  const heavy = Math.max(1, Math.round(mailboxes / 5));
  const light = mailboxes - heavy;
  const heavySum = Math.round(total * skew);
  if (light === 0) return spread(heavy, total);
  return [...spread(heavy, heavySum), ...spread(light, total - heavySum)];
}

const sql = postgres(url, { max: 4, onnotice: () => {} });

/** The rig's own table: the projection's five columns and nothing else it does not measure. */
const table = `rig_locators_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const FOLDERS = ["INBOX", "INBOX/Archive", "INBOX/Screener", "Sent", "INBOX/Later"];
const plan = ARM === "roster" ? rosterPlan(MAILBOXES, TOTAL, SKEW) : Array(MAILBOXES).fill(MESSAGES);

await sql.unsafe(`CREATE TABLE ${table} (
  mailbox_id text NOT NULL, folder text NOT NULL, uid integer NOT NULL,
  uidvalidity text NOT NULL, message_id_header text, seen boolean)`);

try {
  for (let mb = 0; mb < plan.length; mb++) {
    const rows = [];
    for (let i = 0; i < plan[mb]; i++) {
      rows.push({
        mailbox_id: `synthetic-mailbox-${mb}`,
        folder: FOLDERS[i % FOLDERS.length],
        uid: i + 1,
        uidvalidity: String(1700000000 + mb),
        message_id_header: `<${(i * 2654435761 % 4294967296).toString(16).padStart(8, "0")}.${mb}.synthetic@rig.invalid>`,
        seen: i % 3 === 0,
      });
      if (rows.length === 5000) { await sql`insert into ${sql(table)} ${sql(rows)}`; rows.length = 0; }
    }
    if (rows.length) await sql`insert into ${sql(table)} ${sql(rows)}`;
  }

  /** The read shaped exactly as `listKnownLocators` returns it, off the real driver. */
  let reads = 0;
  const read = async (mailboxId) => {
    reads++;
    const out = await sql`
      select folder, uid, uidvalidity, message_id_header, seen
      from ${sql(table)} where mailbox_id = ${mailboxId} order by uid`;
    return out.map((r) => ({
      folder: r.folder, uid: r.uid, uidValidity: r.uidvalidity,
      messageId: r.message_id_header, seen: r.seen,
    }));
  };

  if (ARM === "charge") {
    // THE UNBOUNDED ARM, so the per-entry charge is measured against rows nothing evicted.
    collect();
    const base = process.memoryUsage().heapUsed;
    const held = [];
    let charged = 0;
    const wide = new KnownSetBudget(Number.POSITIVE_INFINITY);
    for (let mb = 0; mb < MAILBOXES; mb++) {
      const id = `synthetic-mailbox-${mb}`;
      const cache = new KnownSetCache(id, wide);
      held.push(cache);
      const got = await cache.list(read, id);
      charged += estimateRetainedBytes(got);
      cache.coversInstance({ folder: got[0].folder, ref: `${got[0].uidValidity}:${got[0].uid}` });
    }
    collect();
    const peak = process.memoryUsage().heapUsed - base;
    console.log(JSON.stringify({
      arm: "charge", mailboxes: MAILBOXES, messages: MESSAGES,
      warmAtPeak: held.filter((c) => c.warm).length,
      retainedMib: mib(peak), chargedMib: mib(charged),
      measuredBytesPerEntry: Math.round(peak / (MAILBOXES * MESSAGES)),
      chargedBytesPerEntry: Math.round(charged / (MAILBOXES * MESSAGES)),
      // Over one means the budget charges MORE than the heap holds, which is the safe direction.
      chargeOverMeasured: Math.round((charged / peak) * 1000) / 1000,
    }, null, 2));
  } else {
    /**
     * THE ROSTER ARM. The deployed budget, one memo per mailbox, then `CYCLES` round-robin passes
     * the way the worker polls — `beginCycle` at the top of each mailbox's turn, which is what the
     * loop does. The hit rate is read off the MEMOS' own counters (`census().hits` and `dbReads`),
     * never a log line, and the attach pass is excluded from it: the attach read is a cold read
     * every design pays, and counting it would flatter or damn a policy for something it did not do.
     */
    const budget = new KnownSetBudget(KNOWN_SET_BUDGET_BYTES);
    const caches = plan.map((_, mb) => new KnownSetCache(`synthetic-mailbox-${mb}`, budget));
    for (const cache of caches) {
      cache.beginCycle();
      const got = await cache.list(read, cache.mailboxId);
      if (got.length) cache.coversInstance({ folder: got[0].folder, ref: `${got[0].uidValidity}:${got[0].uid}` });
    }
    collect();
    const attachedCharged = budget.chargedBytes;
    const warmAfterAttach = caches.filter((c) => c.warm).length;

    let hits = 0, dbReads = 0;
    const perCycle = [];
    for (let c = 0; c < CYCLES; c++) {
      let cycleHits = 0, cycleReads = 0;
      for (const cache of caches) {
        cache.beginCycle();
        await cache.list(read, cache.mailboxId);
        const census = cache.census();
        cycleHits += census.hits;
        cycleReads += census.dbReads;
      }
      hits += cycleHits; dbReads += cycleReads;
      perCycle.push({ cycle: c + 1, hits: cycleHits, dbReads: cycleReads, warm: caches.filter((x) => x.warm).length });
    }
    const opportunities = CYCLES * caches.length;
    console.log(JSON.stringify({
      arm: "roster", mailboxes: caches.length, total: plan.reduce((a, b) => a + b, 0),
      skew: SKEW, split: SKEW ? "skewed" : "uniform",
      heaviest: Math.max(...plan), lightest: Math.min(...plan),
      budgetMib: mib(KNOWN_SET_BUDGET_BYTES),
      chargedAfterAttachMib: mib(attachedCharged),
      chargedShareOfBudget: Math.round((attachedCharged / KNOWN_SET_BUDGET_BYTES) * 1000) / 1000,
      warmAfterAttach, warmAtEnd: caches.filter((c) => c.warm).length,
      cycles: CYCLES, opportunities, hits, dbReads,
      hitRate: Math.round((hits / opportunities) * 1000) / 1000,
      underBound: budget.chargedBytes <= budget.limitBytes,
      totalDatabaseReads: reads,
      perCycle,
    }, null, 2));
  }
} finally {
  await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  await sql.end({ timeout: 5 });
}
