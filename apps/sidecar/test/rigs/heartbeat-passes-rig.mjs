/* WHERE AN IDLE DRAIN'S WORK GOES, PASS BY PASS. Every statement the one PGlite connection runs
 * during ONE drain over a SETTLED mailbox, in order, with its text and its duration — including
 * the statements issued inside a transaction, which the rig counts once as the transaction.
 * It prints; it asserts nothing. */
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createSidecar } from "../../src/engine.js";

const stream = [];
let recording = false;
let depth = 0;
const text = (sql) => String(typeof sql === "string" ? sql : JSON.stringify(sql)).replace(/\s+/g, " ");

function instrument(proto, tag) {
  for (const name of ["query", "exec"]) {
    const original = proto[name];
    if (typeof original !== "function" || original.__hbWrapped) continue;
    const wrapped = async function recorded(...args) {
      const t0 = performance.now();
      try { return await original.apply(this, args); }
      finally { if (recording) stream.push({ kind: name, via: tag, depth, sql: text(args[0]), ms: performance.now() - t0, at: site() }); }
    };
    wrapped.__hbWrapped = true;
    proto[name] = wrapped;
  }
}
instrument(PGlite.prototype, "conn");

/* WHO ASKED. The pass a statement belongs to is not readable from its SQL — two passes read the
 * same table — so every entry carries the first frame of OUR OWN source above the driver. */
const site = () => {
  const lines = (new Error().stack ?? "").split("\n").slice(2);
  const mine = lines.filter((l) => /apps\/(sidecar|worker)\/src|packages\/(services|db|core)\/src/.test(l) && !/heartbeat-passes-rig/.test(l));
  return mine.slice(0, 3).map((l) => l.replace(/^\s*at\s+/, "").replace(/.*\/(apps|packages)\//, "$1/").replace(/\)$/, "")).join(" <- ");
};

const originalTx = PGlite.prototype.transaction;
PGlite.prototype.transaction = async function recordedTx(cb, ...rest) {
  const t0 = performance.now();
  const txSite = site();
  const start = stream.length;
  try {
    return await originalTx.call(this, async (tx) => {
      instrument(Object.getPrototypeOf(tx), "tx");
      depth += 1;
      try { return await cb(tx); } finally { depth -= 1; }
    }, ...rest);
  } finally {
    if (recording) stream.splice(start, 0, { kind: "transaction", via: "conn", depth, sql: "BEGIN..COMMIT", ms: performance.now() - t0, opened: true, at: txSite });
  }
};

class MemoryMetaFolder {
  #nextUid = 1; #claims = [];
  async ensureMetaFolder() {}
  async listClaims() { return this.#claims.map((c) => ({ ...c })); }
  async appendClaim(raw) { this.#claims.push({ ref: this.#nextUid++, raw }); }
  async removeClaims(refs) { const gone = new Set(refs); for (let i = this.#claims.length - 1; i >= 0; i--) if (gone.has(this.#claims[i].ref)) this.#claims.splice(i, 1); }
}
class MemoryMailbox {
  meta = new MemoryMetaFolder(); deliver = [];
  add(n, tag) { for (let i = 0; i < n; i++) { const seq = this.deliver.length; this.deliver.push({ messageId: `hb-${tag}-${seq}@stranger.test`, subject: `HB ${tag} #${seq}` }); } }
  factory = () => {
    const mailbox = this;
    const empty = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    return {
      leaseIo() { return mailbox.meta; },
      async connect() {}, async close() {},
      async capabilities() { return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null }; },
      async ensureFolders() {},
      async changesSince(cursor) {
        const known = cursor.folders.INBOX?.known ?? [];
        const pending = mailbox.deliver.map((m, i) => ({ m, uid: 1000 + i })).filter(({ uid }) => !known.some((k) => k.uid === uid));
        if (pending.length === 0) return { ...empty };
        return { ...empty, hasBacklog: false, creates: pending.map(({ m, uid }) => ({
          type: "create", locator: { folder: "INBOX", ref: `1:${uid}` }, seen: false,
          raw: Buffer.from([`Message-ID: <${m.messageId}>`, "From: stranger@nowhere.test", "To: owner@trafficflow.test", `Subject: ${m.subject}`, "Content-Type: text/plain; charset=utf-8", "", "Hello."].join("\r\n")),
        })) };
      },
      async move(locator) { return locator; },
      async setFlags() {}, async scanSentRecipients() { return []; },
      async watch() { return async () => {}; },
      async send() { throw new Error("this mailbox cannot send"); },
      async fetchPart() { throw new Error("this mailbox cannot fetchPart"); },
    };
  };
}

const SEED = Number(process.env.HB_SEED ?? 2000);
const OUT = process.env.HB_OUT ?? "/tmp/hb-stream.json";
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "hb-rig-")));
const mailbox = new MemoryMailbox();
const sidecar = await createSidecar({
  dataDir, imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
  address: "owner@trafficflow.test", displayName: "This Mac", machineName: "HB rig",
  pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, adapterFactory: mailbox.factory,
});
mailbox.add(SEED, "seed");
const t0 = performance.now();
await sidecar.start();
console.log(`[hb] start() done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
let c = await sidecar.syncUntilQuiet();
console.log(`[hb] settling drain: ${c} cycles`);
c = await sidecar.syncUntilQuiet();
console.log(`[hb] confirming drain: ${c} cycles (must be the quiet shape)`);

recording = true;
const tIdle = performance.now();
const cycles = await sidecar.syncUntilQuiet();
const idleMs = performance.now() - tIdle;
recording = false;

const total = stream.reduce((a, s) => a + (s.kind === "transaction" ? 0 : s.ms), 0);
console.log(`\n[hb] THE IDLE DRAIN: ${cycles} cycles, ${idleMs.toFixed(1)} ms wall, ${stream.length} recorded entries, ${total.toFixed(1)} ms in statements`);
writeFileSync(OUT, JSON.stringify({ seed: SEED, cycles, idleMs, stream }, null, 1));
console.log(`[hb] stream written to ${OUT}`);
let i = 0;
for (const s of stream) console.log(`${String(i++).padStart(3)} ${s.ms.toFixed(1).padStart(7)} ms ${s.kind === "transaction" ? "[TX]" : "    "} ${s.sql.slice(0, 110)}\n      ASKED BY ${s.at}`);

/* AND THE POLLED LIST, the second half of the heartbeat: the window asks the same question again
 * and again while nothing changes, and this records what one such ask costs. */
const POLL = process.env.HB_POLL ?? "/messages?view=imbox&limit=20";
const call = (p) => sidecar.handle(new Request(`http://sidecar${p}`, { headers: { authorization: `Bearer ${sidecar.sessionToken}` } }));
await (await call(POLL)).arrayBuffer();          // warm, never measured
stream.length = 0;
recording = true;
const tPoll = performance.now();
const res = await call(POLL);
const bytes = Buffer.from(await res.arrayBuffer());
const pollMs = performance.now() - tPoll;
recording = false;
console.log(`\n[hb] ONE UNCHANGED POLL ${POLL}: status ${res.status}, ${bytes.length} bytes, ${pollMs.toFixed(1)} ms, ${stream.length} statements, ${stream.reduce((a, s) => a + (s.kind === "transaction" ? 0 : s.ms), 0).toFixed(1)} ms in statements`);
let j = 0;
for (const s of stream) console.log(`${String(j++).padStart(3)} ${s.ms.toFixed(1).padStart(7)} ms ${s.kind === "transaction" ? "[TX]" : "    "} ${s.sql.slice(0, 110)}\n      ASKED BY ${s.at}`);
writeFileSync(OUT.replace(/\.json$/, "-poll.json"), JSON.stringify({ poll: POLL, status: res.status, bytes: bytes.length, pollMs, stream }, null, 1));


/* IS THE CHANGE LOG A VALIDATOR FOR THIS LIST? The row's first-choice mechanism is a one-row
 * validator (`account_sync_state.next_seq`, which moves only when `allocateSeqRange` runs, which
 * runs only for a change_log row). This asks the question the other way round, which is the only
 * way a FALSE 304 shows itself: move something the list RENDERS by a write that records no change
 * row, and see whether the validator noticed. The write is the one
 * `completeFolderState` composes (packages/core/src/adapters/drizzle-repo.ts:1432 — `UPDATE
 * folder_state SET observed_folder = ...`), which the reconciler's `none` action takes on every
 * settle (packages/core/src/pipeline.ts:150-162) and which records nothing in `change_log`. */
const markNow = async () => {
  const r = await sidecar.db.execute(`select coalesce(max(seq)::text, 'empty') as m, (select coalesce(max(next_seq)::text,'none') from account_sync_state) as n from change_log`);
  const row = (r.rows ?? r)[0];
  return `${row.m ?? row[0]}/${row.n ?? row[1]}`;
};
const pollBytes = async () => Buffer.from(await (await call(POLL)).arrayBuffer());
const markBefore304 = await markNow();
const bytesBefore = await pollBytes();
/* EVERY ROW THE PAGE COULD HOLD, not the lowest id — the first attempt updated one row chosen by
 * id while the view orders by date, so it moved a message the page never showed and the arm read
 * "the write did not reach this list" for the rig's own reason. */
const moved = await sidecar.db.execute(`update folder_state set observed_folder = 'ohmail/Screened', reconcile_status = 'pending', updated_at = now()`);
console.log(`     (the write touched ${moved.affectedRows ?? (moved.rowCount ?? "?")} folder_state rows)`);
const markAfter304 = await markNow();
const bytesAfter = await pollBytes();
const same = bytesBefore.equals(bytesAfter);
console.log(`\n[hb] THE VALIDATOR CONTROL — one write of folder_state.observed_folder, the shape completeFolderState composes:`);
console.log(`     validator (max(change_log.seq)/max(next_seq)) BEFORE ${markBefore304}  AFTER ${markAfter304}  MOVED=${markBefore304 !== markAfter304}`);
console.log(`     the polled list's bytes ${bytesBefore.length} -> ${bytesAfter.length}, byte-identical=${same}`);
console.log(`     VERDICT: ${markBefore304 === markAfter304 && !same ? "A 304 ON THIS VALIDATOR WOULD BE FALSE — the list moved and the validator did not" : (markBefore304 !== markAfter304 ? "the validator moved with the write" : "this write does not reach this list — it says nothing about the other four tables the page reads")}`);


/* AND THE DELTA READER AT ITS OWN HORIZON — the poll a window makes when it is up to date. Its
 * cursor is taken from the route itself, never composed here, so the arm asks the question the
 * product asks. */
const boot = await (await call("/sync")).json();
let cur = boot.cursor;
for (let i = 0; i < 6 && boot.hasMore !== false; i++) {
  const more = await (await call(`/sync?since=${encodeURIComponent(cur)}`)).json();
  cur = more.cursor;
  if (!more.hasMore) break;
}
await (await call(`/sync?since=${encodeURIComponent(cur)}`)).arrayBuffer();   // warm
stream.length = 0;
recording = true;
const tSync = performance.now();
const syncRes = await call(`/sync?since=${encodeURIComponent(cur)}`);
const syncBytes = Buffer.from(await syncRes.arrayBuffer());
const syncMs = performance.now() - tSync;
recording = false;
const body = JSON.parse(syncBytes.toString("utf8"));
const empty = body.changes && [body.changes.creates, body.changes.updates, body.changes.moves, body.changes.deletes].every((a) => a.length === 0);
console.log(`\n[hb] ONE POLL AT THE HORIZON /sync?since=<cursor>: status ${syncRes.status}, empty=${empty}, hasMore=${body.hasMore}, ${syncBytes.length} bytes, ${syncMs.toFixed(1)} ms, ${stream.length} statements`);
let k = 0;
for (const s2 of stream) console.log(`${String(k++).padStart(3)} ${s2.ms.toFixed(1).padStart(7)} ms ${s2.kind === "transaction" ? "[TX]" : "    "} ${s2.sql.slice(0, 120)}`);

await sidecar.stop?.();
process.exit(0);
