/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHERE THE READERS HOLD THE STORE, PER STATEMENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The rig behind `store-lanes.ts` and behind the budgets the store-lanes case asserts (the
 * project's design notes). That case answers "did the cycle keep its share"; this answers "where did the share go",
 * which is the question the fix had to be chosen from.
 *
 * Every statement the ONE PGlite connection runs is recorded — when it was issued, when it came
 * back, and the LANE of the caller that issued it, taken from an `AsyncLocalStorage` this file
 * sets rather than guessed from the SQL text. Beside it an event-loop probe: the check and timer
 * phases, which is where the sync cycle's stream-based MIME parse settles and where eight polling
 * readers were measured to stop the loop dead for many seconds.
 *
 * Run:  node --import tsx apps/sidecar/test/rigs/a6-store-lanes-rig.mjs
 * Knobs: A6_SEED A6_CYCLE A6_READERS A6_BUDGET A6_WINDOW A6_VIEW A6_PROBE_VIEWS A6_TIMELINE_OUT
 *
 * NOT a test: it prints, asserts nothing, and takes about a minute. `.mjs` on purpose — a rig is
 * not typechecked by the sidecar's test ratchet and is not collected by vitest.
 *
 * It calls `sidecar.handle` DIRECTLY rather than over the stdio bridge, and that is the one place
 * it differs from that change: the async context a lane is named in does not survive a stream boundary, so
 * a bridged read would be attributed to nobody. The bridge's own cost is the to measure — which
 * is why its ratio reads higher than this rig's (a framed read costs more, so the readers land
 * fewer of them).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { messages } from "@trafficflow/db";
import { createSidecar } from "../../src/engine.js";
import { noteFirstPageServed } from "../../src/first-page-gate.js";
import { currentStoreLane } from "../../src/store-lanes.js";

const lane = new AsyncLocalStorage();
const timeline = [];
let recording = false;

const shape = (sql) => String(typeof sql === "string" ? sql : JSON.stringify(sql)).replace(/\s+/g, " ").slice(0, 90);

/* THE INSTRUMENT, on the PROTOTYPE: every handle this process opens is covered, including the one
   `openLocalDb` keeps to itself. Statements issued INSIDE a transaction go through the transaction's
   own object and are counted once, as the transaction. `sched` is the lane the scheduler charged,
   `u0`/`u1` the check-phase turns (counted by the probe below) when the statement ran. */
let turns = 0;
for (const [name, kind] of [["query", "query"], ["exec", "exec"], ["transaction", "transaction"]]) {
  const original = PGlite.prototype[name];
  PGlite.prototype[name] = async function scheduled(...args) {
    const l = lane.getStore() ?? "other";
    const sched = currentStoreLane();
    const t0 = performance.now();
    const u0 = turns;
    try {
      return await original.apply(this, args);
    } finally {
      if (recording) timeline.push({ lane: l, sched, kind, sql: kind === "transaction" ? "BEGIN..COMMIT" : shape(args[0]), t0, t1: performance.now(), u0, u1: turns });
    }
  };
}

/* EVENT-LOOP LAG, both phases. A chain of microtasks that never ends starves the CHECK and TIMER
   phases, and anything the cycle awaits there stops dead. `unref`'d, so the probe can never be the
   reason the process stays alive. */
let lagImmediate = 0;
let lagTimer = 0;
let lagOn = false;
const probeImmediate = () => {
  const t = performance.now();
  setImmediate(() => { turns++; if (lagOn) lagImmediate = Math.max(lagImmediate, performance.now() - t); probeImmediate(); }).unref?.();
};
const probeTimer = () => {
  const t = performance.now();
  setTimeout(() => { if (lagOn) lagTimer = Math.max(lagTimer, performance.now() - t); probeTimer(); }, 0).unref?.();
};
probeImmediate();
probeTimer();

// ── A CONTROLLABLE MAILBOX, THE own ────────────────────────────────────────────────────────
class MemoryMetaFolder {
  #nextUid = 1;
  #claims = [];
  async ensureMetaFolder() {}
  async listClaims() { return this.#claims.map((c) => ({ ...c })); }
  async appendClaim(raw) { this.#claims.push({ ref: this.#nextUid++, raw }); }
  async removeClaims(refs) {
    const gone = new Set(refs);
    for (let i = this.#claims.length - 1; i >= 0; i--) if (gone.has(this.#claims[i].ref)) this.#claims.splice(i, 1);
  }
}

class MemoryMailbox {
  meta = new MemoryMetaFolder();
  deliver = [];
  cyclesStarted = 0;
  cyclesFinished = 0;
  add(n, tag) {
    for (let i = 0; i < n; i++) {
      const seq = this.deliver.length;
      this.deliver.push({ messageId: `a6-${tag}-${seq}@stranger.test`, subject: `lanes ${tag} #${seq}` });
    }
  }
  factory = () => {
    const mailbox = this;
    const empty = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    return {
      leaseIo() { return mailbox.meta; },
      async connect() {},
      async close() {},
      async capabilities() {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders() {},
      async changesSince(cursor) {
        mailbox.cyclesStarted++;
        const known = cursor.folders.INBOX?.known ?? [];
        const pending = mailbox.deliver.map((m, i) => ({ m, uid: 1000 + i })).filter(({ uid }) => !known.some((k) => k.uid === uid));
        mailbox.cyclesFinished++;
        if (pending.length === 0) return { ...empty };
        return {
          ...empty,
          hasBacklog: false,
          creates: pending.map(({ m, uid }) => ({
            type: "create",
            locator: { folder: "INBOX", ref: `1:${uid}` },
            seen: false,
            raw: Buffer.from([
              `Message-ID: <${m.messageId}>`, "From: stranger@nowhere.test", "To: owner@trafficflow.test",
              `Subject: ${m.subject}`, "Content-Type: text/plain; charset=utf-8", "",
              "Hello — we have not met before.",
            ].join("\r\n")),
          })),
        };
      },
      async move(locator) { return locator; },
      async setFlags() {},
      async scanSentRecipients() { return []; },
      async watch() { return async () => {}; },
      async send() { throw new Error("this mailbox cannot send"); },
      async fetchPart() { throw new Error("this mailbox cannot fetchPart"); },
    };
  };
}

const worlds = [];

async function standUp() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "a6-rig-")));
  const mailbox = new MemoryMailbox();
  const sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
    address: "owner@trafficflow.test", displayName: "This Mac", machineName: "store-lanes rig",
    // Long enough that the poll timer never fires: every cycle here is one this file asked for.
    pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, adapterFactory: mailbox.factory,
  });
  const w = {
    sidecar, mailbox, dataDir,
    call: (p) => sidecar.handle(new Request(`http://sidecar${p}`, { headers: { authorization: `Bearer ${sidecar.sessionToken}` } })),
  };
  worlds.push(w);
  return w;
}

const ingestedCount = async (w) => (await w.sidecar.db.select({ id: messages.id }).from(messages)).length;
const tick = () => new Promise((r) => setImmediate(r));
const startedAt = performance.now();
const note = (m) => console.log(`[store-lanes rig +${((performance.now() - startedAt) / 1000).toFixed(1)}s] ${m}`);
const pct = (xs, q) => {
  const ys = [...xs].sort((a, b) => a - b);
  return (ys[Math.max(0, Math.ceil(q * ys.length) - 1)] ?? NaN).toFixed(1);
};

const SEED = Number(process.env.A6_SEED ?? 40);
const CYCLE = Number(process.env.A6_CYCLE ?? 250);
const READERS = Number(process.env.A6_READERS ?? 8);
const BUDGET = Number(process.env.A6_BUDGET ?? 2000);
const WINDOW_MS = Number(process.env.A6_WINDOW ?? 1500);
const VIEW = process.env.A6_VIEW ?? "imbox";
const PROBE_VIEWS = process.env.A6_PROBE_VIEWS === "1";

let windowStart = 0;

async function runArm(load) {
  note(`${load ? "loaded" : "quiet"} world standing up`);
  const w = await standUp();
  w.mailbox.add(SEED, "seed");
  await w.sidecar.start();
  // The one bootstrap read a client makes, and the first-page gate the stdio host releases on it:
  // without it every drain here waits out FIRST_PAGE_GRACE_MS, which is the whole window.
  await (await w.call("/sync/snapshot")).arrayBuffer();
  noteFirstPageServed();
  note(`${load ? "loaded" : "quiet"} seeded (${await ingestedCount(w)} in the mirror)`);
  w.mailbox.add(CYCLE, "cycle");

  let chatting = load;
  let issued = 0;
  let failed = 0;
  let answered = 0;
  let sameAsPrevious = 0;
  const lat = [];
  const chatter = load
    ? Array.from({ length: READERS }, async () => {
        let previous = "";
        while (chatting && issued < BUDGET) {
          issued++;
          const t0 = performance.now();
          try {
            const res = await lane.run("read", () => w.call(`/messages?view=${VIEW}&limit=20`));
            if (res.status !== 200) failed++;
            const digest = createHash("sha1").update(Buffer.from(await res.arrayBuffer())).digest("hex");
            answered++;
            if (digest === previous) sameAsPrevious++;
            previous = digest;
          } catch { failed++; }
          lat.push(performance.now() - t0);
        }
      })
    : [];

  timeline.length = 0;
  recording = true;
  lagOn = load;
  lagImmediate = 0;
  lagTimer = 0;
  const started = performance.now();
  windowStart = started;
  const sample = (async () => {
    while (performance.now() - started < WINDOW_MS) await tick();
    // Dated by when it RETURNS: under load the count queues too, and dating it by the request
    // would overstate the rate.
    const n = await lane.run("sample", () => ingestedCount(w));
    return { msgs: n - SEED, atMs: performance.now() - started };
  })().finally(() => { chatting = false; });
  await lane.run("ingest", () => w.sidecar.syncUntilQuiet());
  const whole = performance.now() - started;
  chatting = false;
  const s = await sample;
  await Promise.all(chatter);
  recording = false;
  lagOn = false;
  const arm = timeline.filter((x) => x.t0 >= started && x.t0 - started < s.atMs);
  if (load) note(`event-loop lag while the readers ran: setImmediate max ${lagImmediate.toFixed(0)} ms, setTimeout(0) max ${lagTimer.toFixed(0)} ms`);
  note(`${load ? "loaded" : "quiet"} drain done in ${whole.toFixed(0)} ms; ${await ingestedCount(w)} in the mirror`);
  if (!load) {
    // THE INTERACTION CONTROL: one reader, no cycle. The only reader figure comparable across two
    // builds — under a cycle the "before" build is fast because the cycle is locked out entirely.
    const idle = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await (await w.call(`/messages?view=${VIEW}&limit=20`)).arrayBuffer();
      idle.push(performance.now() - t0);
    }
    note(`idle-store read latency, one reader, no cycle: p50 ${pct(idle, 0.5)} ms  p95 ${pct(idle, 0.95)} ms`);
  }
  return { ...s, whole, issued, failed, answered, sameAsPrevious, lat, arm };
}

/* WHERE THE INGEST'S TIME WENT, per message ingested in the window: its own statements, the other
   lanes' statements that ran between two of its own, and what is left (neither on the store), with
   the check-phase turns those gaps spanned. The union of the other intervals, so a statement PGlite
   queued internally is not counted twice. */
function perMessage(arm, msgs) {
  const ing = arm.filter((x) => x.lane === "ingest").sort((a, b) => a.t0 - b.t0);
  const iv = arm.filter((x) => x.lane !== "ingest").map((x) => [x.t0, x.t1]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a0, a1] of iv) { const m = merged.at(-1); if (m && a0 <= m[1]) m[1] = Math.max(m[1], a1); else merged.push([a0, a1]); }
  let held = 0, other = 0, gap = 0, gapTurns = 0, others = 0;
  for (let i = 0; i < ing.length; i++) {
    held += ing[i].t1 - ing[i].t0;
    if (i === 0) continue;
    const a = ing[i - 1].t1, b = ing[i].t0;
    gap += Math.max(0, b - a);
    gapTurns += ing[i].u0 - ing[i - 1].u1;
    for (const [o0, o1] of merged) { const lo = Math.max(a, o0), hi = Math.min(b, o1); if (hi > lo) other += hi - lo; }
    others += arm.filter((x) => x.lane !== "ingest" && x.t0 >= a && x.t0 < b).length;
  }
  const per = (x) => (x / Math.max(1, msgs)).toFixed(1);
  return `ingest ${per(held)} ms, others' statements ${per(other)} ms (${per(others)} of them), neither ${per(gap - other)} ms, `
    + `${per(gapTurns)} check-phase turns between the ingest's statements`;
}

async function main() {
  if (PROBE_VIEWS) {
    const probe = await standUp();
    probe.mailbox.add(SEED, "seed");
    await probe.sidecar.start();
    const counts = {};
    for (const v of ["imbox", "feed", "paper_trail", "screened", "quarantine", "new_for_you", "previously_seen"]) {
      const res = await probe.call(`/messages?view=${v}&limit=20`);
      const body = await res.json();
      counts[v] = res.status === 200 ? (body.items?.length ?? -1) : -res.status;
    }
    note(`rows per view page (limit=20) over ${await ingestedCount(probe)} ingested: ${JSON.stringify(counts)}`);
  }

  const quiet = await runArm(false);
  const busy = await runArm(true);

  const qRate = quiet.msgs / quiet.atMs;
  const bRate = busy.msgs / busy.atMs;
  console.log(`\n[store-lanes rig] == ARMS ==  view=${VIEW} seed=${SEED} cycle=${CYCLE} readers=${READERS} window=${WINDOW_MS}ms`);
  console.log(`  quiet : ${quiet.msgs} msgs in ${quiet.atMs.toFixed(0)} ms (${(qRate * 1000).toFixed(1)} msg/s), whole cycle ${quiet.whole.toFixed(0)} ms`);
  console.log(`  loaded: ${busy.msgs} msgs in ${busy.atMs.toFixed(0)} ms (${(bRate * 1000).toFixed(1)} msg/s), whole cycle ${busy.whole.toFixed(0)} ms`);
  console.log(`  RETAINED: ${((bRate / qRate) * 100).toFixed(1)}%`);
  console.log(`  reads issued ${busy.issued} of a ${BUDGET} budget, failed ${busy.failed}, rate ${((busy.issued / busy.atMs) * 1000).toFixed(0)} reads/s`);
  console.log(`  reader latency p50 ${pct(busy.lat, 0.5)} ms  p95 ${pct(busy.lat, 0.95)} ms`);
  console.log(`  per message, quiet : ${perMessage(quiet.arm, quiet.msgs)}`);
  console.log(`  per message, loaded: ${perMessage(busy.arm, busy.msgs)}`);
  console.log(`  polls byte-identical to that reader's previous poll: ${busy.sameAsPrevious} of ${busy.answered} (${((busy.sameAsPrevious / Math.max(1, busy.answered)) * 100).toFixed(1)}%) - what a 304 could serve cheaply`);

  const win = busy.arm;
  const byLane = new Map();
  for (const s of win) {
    const k = `${s.lane}/${s.sched}`;
    const e = byLane.get(k) ?? { n: 0, ms: 0 };
    e.n++; e.ms += s.t1 - s.t0;
    byLane.set(k, e);
  }
  console.log("\n[store-lanes rig] == PER-LANE, over the loaded window ==");
  for (const [l, e] of [...byLane].sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${l.padEnd(20)} statements ${String(e.n).padStart(6)}   store time ${e.ms.toFixed(0).padStart(6)} ms   mean ${(e.ms / e.n).toFixed(2)} ms`);
  }
  const ing = win.filter((s) => s.lane === "ingest").sort((a, b) => a.t0 - b.t0);
  const gaps = [];
  for (let i = 1; i < ing.length; i++) gaps.push(ing[i].t0 - ing[i - 1].t1);
  console.log(`  ingest statements in the window: ${ing.length}; the wait BETWEEN them p50 ${pct(gaps, 0.5)} ms, p95 ${pct(gaps, 0.95)} ms, max ${pct(gaps, 1)} ms`);
  for (const s of ing.slice(0, 10)) console.log(`    +${(s.t0 - windowStart).toFixed(0).padStart(5)} ms  held ${(s.t1 - s.t0).toFixed(1).padStart(6)} ms  ${s.kind}  ${s.sql}`);

  const ckpt = win.filter((s) => /checkpoint/i.test(s.sql));
  console.log(`  CHECKPOINT statements in the loaded window: ${ckpt.length}${ckpt.map((s) => ` (${s.sched}, ${(s.t1 - s.t0).toFixed(1)} ms)`).join("")}`);
  const out = process.env.A6_TIMELINE_OUT;
  if (out) writeFileSync(out, win.map((s) => JSON.stringify({ ...s, t0: s.t0 - windowStart, t1: s.t1 - windowStart })).join("\n"));

  for (const w of worlds) {
    await w.sidecar.stop().catch(() => undefined);
    rmSync(w.dataDir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
