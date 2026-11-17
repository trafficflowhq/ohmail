/**
 * WHAT THE WORKER RETAINS IN LOCATOR MEMOS WHILE N MAILBOXES ARE ATTACHED — read from the heap at
 * the PEAK of the attach pass, not from the size the pass settles on.
 *
 *   node --expose-gc --max-old-space-size=8192 \
 *        apps/worker/test/rigs/known-set-peak-rig.mjs \
 *        --mailboxes 16 --messages 100000 [--bound <bytes>] [--snapshot <path>] [--json <path>]
 *
 * A rig, not a test: it reports mebibytes, and a megabyte assertion inside a suite is a flake.
 * Run it from the repo root. It drives the REAL `KnownSetCache` through `tsx`, one instance per
 * synthetic mailbox, exactly as `index.ts` builds one per attachment.
 *
 * THE ROWS ARE HANDED OVER AND DROPPED. `makeRows` builds each mailbox's projection fresh and the
 * rig keeps no reference to it, so the memo is the sole retainer of those objects — which is the
 * production shape (postgres.js mints them per read) and the only arrangement in which the heap
 * figure is the memo's own. Keeping the corpus alive would charge the memo 8 bytes an entry for
 * its array spine and report a bound that holds for nothing.
 *
 * THE PEAK IS WHERE ALL N ARE WARM. The reading is taken with every memo still attached and
 * before any drop, because a bound enforced at the end of a multi-mailbox pass is no bound during
 * one. Two forced collects first, so a transient is told apart from a retainer.
 *
 * Every figure is SYNTHETIC: generated projections of a stated shape, never anybody's mail.
 */
import { writeFileSync } from "node:fs";
import v8 from "node:v8";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

const MAILBOXES = Number(arg("mailboxes", 16));
const MESSAGES = Number(arg("messages", 100000));
/**
 * `default` takes the process budget the worker deploys with; a number is that many bytes; `inf`
 * removes the bound, which is the arm this fix's before/after is read against — the SAME code path
 * with the budget taken away, rather than a different revision.
 */
const BOUND_ARG = String(arg("bound", "default"));
const SNAPSHOT = arg("snapshot", "");
const JSON_OUT = arg("json", "");
/** Build each memo's membership index too — the state an attachment reaches after one cycle. */
const INDEX = arg("index", "1") !== "0";
/**
 * Extra polls over the whole roster after the attach pass, round-robin the way the worker polls.
 * It is what says whether a mailbox inside the budget still hits its memo: hits over hits plus
 * database reads, which the bound may not take to zero.
 */
const CYCLES = Number(arg("cycles", 0));

const { KnownSetCache, KnownSetBudget, KNOWN_SET_BUDGET_BYTES, processKnownSetBudget } =
  await import("../../../../packages/organizer/src/known-set.ts");

const MIB = 1024 * 1024;
const mib = (b) => Math.round((b / MIB) * 100) / 100;
const heap = () => process.memoryUsage().heapUsed;
const collect = () => { global.gc(); global.gc(); };

/**
 * One synthetic mailbox's projection. The shapes are the ones `listKnownLocators` returns: an IMAP
 * folder path, a UID, the folder's UIDVALIDITY as text, a Message-ID (RFC 5322) and the read-state
 * baseline. Sizes are typical rather than favourable — a shorter Message-ID would flatter the
 * memo, which is the wrong direction for a bound.
 */
const FOLDERS = ["INBOX", "INBOX/Archive", "INBOX/Screener", "Sent", "INBOX/Later"];
function makeRows(n, mb) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      folder: FOLDERS[i % FOLDERS.length],
      uid: i + 1,
      uidValidity: String(1700000000 + mb),
      messageId: `<${(i * 2654435761 % 4294967296).toString(16).padStart(8, "0")}.${mb}.synthetic@rig.invalid>`,
      seen: i % 3 === 0,
    };
  }
  return rows;
}

collect();
const baseline = heap();

/** The memos, held exactly as the worker's `runtimes` map holds them: all attached at once. */
const attached = [];
const BOUND = BOUND_ARG === "default" ? null
  : BOUND_ARG === "inf" ? Number.POSITIVE_INFINITY
  : Number(BOUND_ARG);
const budget = BOUND === null ? undefined : new KnownSetBudget(BOUND);
/** What the reading is judged against: the deployed budget when the rig passed none. */
const effective = budget ?? processKnownSetBudget;
const limit = budget ? budget.limitBytes : KNOWN_SET_BUDGET_BYTES;
const steps = [];

for (let mb = 0; mb < MAILBOXES; mb++) {
  const id = `synthetic-mailbox-${String(mb).padStart(3, "0")}`;
  const cache = budget ? new KnownSetCache(id, budget) : new KnownSetCache(id);
  attached.push(cache);
  // The read-through. `makeRows` is called INSIDE the argument so the rig never names the array.
  const got = await cache.list(async () => makeRows(MESSAGES, mb), id);
  if (INDEX) cache.coversInstance({ folder: got[0].folder, ref: `${got[0].uidValidity}:${got[0].uid}` });
  steps.push({ mailbox: mb + 1, warm: attached.filter((c) => c.warm).length });
}

/**
 * THE POLLS, after the attach pass and BEFORE the reading, because a poll that re-admits an evicted
 * memo is part of what the process holds at its peak. Each mailbox is served the rows it would be
 * served; a memo still warm answers from memory and never calls this.
 */
let polls = 0;
for (let c = 0; c < CYCLES; c++) {
  for (let mb = 0; mb < MAILBOXES; mb++) {
    const cache = attached[mb];
    cache.beginCycle();
    await cache.list(async () => { polls++; return makeRows(MESSAGES, mb); }, cache.mailboxId);
  }
}

// THE PEAK: every memo attached, nothing dropped, two collects so what is left is retained.
collect();
const peak = heap() - baseline;
const warmAtPeak = attached.filter((c) => c.warm).length;

const out = {
  mailboxes: MAILBOXES, messages: MESSAGES, index: INDEX,
  bound: BOUND_ARG,
  boundBytes: Number.isFinite(limit) ? limit : null,
  boundMib: Number.isFinite(limit) ? mib(limit) : null,
  retainedBytes: peak, retainedMib: mib(peak),
  perMailboxMib: mib(peak / MAILBOXES),
  bytesPerLocator: Math.round(peak / (MAILBOXES * MESSAGES)),
  warmAtPeak,
  cycles: CYCLES,
  // Over the polling cycles only: reads that reached the database, and the share served from
  // memory. `null` when the rig was not asked to poll.
  pollReads: CYCLES ? polls : null,
  pollHitRate: CYCLES ? Math.round((1 - polls / (CYCLES * MAILBOXES)) * 1000) / 1000 : null,
  underBound: Number.isFinite(limit) ? peak <= limit : null,
  chargedBytes: effective.chargedBytes,
  chargedMib: mib(effective.chargedBytes),
};
console.log(JSON.stringify(out, null, 2));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
if (SNAPSHOT) {
  // ITS OWN STEP at the peak, with every memo still reachable: a snapshot taken after a drop is a
  // picture of a different heap.
  v8.writeHeapSnapshot(SNAPSHOT);
  console.log(JSON.stringify({ snapshot: SNAPSHOT, warmAtPeak }));
}
// Keep the memos alive past the reading, or the JS engine may collect them before the snapshot is written.
if (attached.length !== MAILBOXES) throw new Error("rig: memos were collected before the reading");
