/**
 * WHAT THE WHOLE WORKER PEAKS AT WITH A FULL ROSTER ATTACHED — the real attach loop, not the memo
 * on its own.
 *
 *   sg docker -c "docker compose up -d greenmail"
 *   bash scripts/lane-db.sh "$PWD"; set -a; . ./.lane-db.env; set +a
 *   flock -n -E 75 /tmp/ohmail-greenmail.lock node --expose-gc --import tsx \
 *     apps/worker/test/rigs/known-set-worker-peak-rig.mjs --mailboxes N --inbox K --passes P
 *
 * `known-set-peak-rig.mjs` and `known-set-real-rows-rig.mjs` weigh the locator memos alone. This
 * one starts the REAL `startWorker` against a seeded lane database and a real IMAP server, so the
 * scan windows, the adapter's fetch buffers, the dead-letter ledgers and the postgres pool are in
 * the reading beside the memos. `process.memoryUsage()` is sampled throughout; the peak is the
 * largest sample, and a heap snapshot is written AT it so the composition is read rather than
 * guessed. Every figure is synthetic and the mailboxes are the rig's own.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import v8 from "node:v8";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const MAILBOXES = Number(arg("mailboxes", 4));
/** Messages appended to each mailbox's INBOX before the worker starts — real mail, really ingested. */
const INBOX = Number(arg("inbox", 25));
/** Roster passes to wait out after the first sync, so the reading spans more than one attach. */
const PASSES = Number(arg("passes", 3));
const POLL_MS = Number(arg("poll", 1500));
const SAMPLE_MS = Number(arg("sample", 250));
const SNAPSHOT = arg("snapshot", "");
const JSON_OUT = arg("json", "");
const BUDGET_MS = Number(arg("budget-ms", 20 * 60 * 1000));
/** The worker's own log on stderr, for a run that is diagnosing the rig rather than reading it. */
const VERBOSE = argv.includes("--verbose");

/**
 * THE SUITE'S SETUP FILE SETS THIS AND A BARE RIG DOES NOT. The worker refuses to dial a private
 * address unless it is told the run is a local one, so without it every mailbox here quarantines
 * `MailboxHostRefused`/`connect` against a GreenMail on loopback that answers this process fine —
 * the rig attaches nothing and reports a peak of a worker with no roster.
 */
process.env.TF_PROBE_ALLOW_PRIVATE ??= "1";

const url = process.env.PG_TEST_URL ?? process.env.DATABASE_URL ?? "";
if (!url) throw new Error("rig: source .lane-db.env first — this never runs on the shared box");
if (/trafficflow_test(\b|$)/.test(url)) throw new Error("rig: that is the SHARED box; run it on a lane database");

const { mailboxes: mailboxesTable, mailboxCredentials, messages, messageInstances } =
  await import("@trafficflow/db");
const { makeDb } = await import("@trafficflow/db/cloud");
const { StaticKeyProvider, createLogger } = await import("@trafficflow/core");
const { startWorker } = await import("../../src/index.ts");
const { processKnownSetBudget, WORKER_HEAP_MIB } = await import("../../src/known-set.ts");
const { greenmailPorts } = await import("../_greenmail-ports.ts");
const { ImapFlow } = await import("imapflow");
const { eq, sql: dsql } = await import("drizzle-orm");

const MIB = 1024 * 1024;
const mib = (b) => Math.round((b / MIB) * 100) / 100;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const ports = greenmailPorts();
const db = makeDb(url);

/** One mailbox's login. Its password never leaves this function and is never printed. */
function login() {
  return { user: `rig-${randomUUID()}@trafficflow.test`, pass: "rig-worker-password" };
}

function eml(from, subject, messageId) {
  return [`Message-ID: <${messageId}>`, `From: ${from}`, "To: rig@trafficflow.test",
    `Subject: ${subject}`, "Content-Type: text/plain", "", "body"].join("\r\n");
}

/** Seed one mailbox row, its encrypted credential and its consent, and fill its INBOX for real. */
async function seedMailbox(n) {
  const auth = login();
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxesTable).values({
    accountId, provider: "imap", address: auth.user,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 3600_000),
  }).returning();
  const enc = await KP.encrypt(auth.pass);
  await db.insert(mailboxCredentials).values({
    mailboxId: row.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: ports.imapHost, port: ports.imapPort, secure: false, user: auth.user },
  });
  const c = new ImapFlow({
    host: ports.imapHost, port: ports.imapPort, secure: false, auth, logger: false,
  });
  await c.connect();
  for (let i = 0; i < INBOX; i++) {
    await c.append("INBOX", eml(`sender${i % 7}@rig.invalid`, `rig ${n}-${i}`, `rig-${n}-${i}@rig.invalid`));
  }
  await c.logout();
  return { accountId, mailboxId: row.id };
}

/**
 * The samples, and the largest of them. TWO peaks are kept, because they are different questions:
 * the largest resident set, and the largest the locator memos ever were. A memo is dropped by
 * every write, so the sample that catches the process at its widest rarely catches the memos at
 * theirs, and reporting only the first would read the memo term as zero.
 */
const samples = [];
let peak = { rss: 0, heapUsed: 0, memoBytes: 0, warmMemos: 0, phase: "none" };
let memoPeak = { rss: 0, heapUsed: 0, memoBytes: -1, warmMemos: 0, phase: "none" };
let maxAttached = 0;
function sample(phase, attached = null) {
  const m = process.memoryUsage();
  if (attached !== null && attached > maxAttached) maxAttached = attached;
  const s = {
    at: Date.now(), phase, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal,
    external: m.external, arrayBuffers: m.arrayBuffers, attached,
    memoBytes: processKnownSetBudget.chargedBytes, warmMemos: processKnownSetBudget.warmCount,
  };
  samples.push(s);
  if (s.rss > peak.rss) peak = s;
  if (s.memoBytes > memoPeak.memoBytes) memoPeak = s;
  return s;
}

const started = Date.now();
const seeded = [];
let worker = null;
let timer = null;
try {
  sample("before-seed");
  for (let n = 0; n < MAILBOXES; n++) seeded.push(await seedMailbox(n));
  sample("seeded");

  timer = setInterval(() => sample("loop", worker ? worker.stats().mailboxes : null), SAMPLE_MS);
  worker = await startWorker({
    databaseUrl: url, keyProvider: KP, pollIntervalMs: POLL_MS, sentDomain: "trafficflow.test",
    logger: VERBOSE ? createLogger({ service: "worker", level: "debug", sink: (l) => console.error(l) }) : undefined,
  });
  sample("worker-started");

  /**
   * Wait for the roster to be whole and then for the ingest to settle — a peak read while half the
   * roster is still attaching is a reading of a different process. `stats().mailboxes` is the
   * worker's own count; the ingested total is read off the database rather than off a log line.
   */
  const want = MAILBOXES * INBOX;
  let ingested = 0;
  let rosterWholeAt = null;
  while (Date.now() - started < BUDGET_MS) {
    const [{ n }] = await db.select({ n: dsql`count(*)::int` }).from(messages);
    ingested = n;
    const attached = worker.stats().mailboxes;
    sample("waiting", attached);
    if (rosterWholeAt === null && attached >= MAILBOXES) rosterWholeAt = Date.now() - started;
    // The ingest is the settle signal; the roster is REPORTED rather than waited on for ever, so a
    // mailbox that never attaches costs the run a named zero instead of the whole budget.
    if (ingested >= want && rosterWholeAt !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  sample("ingest-settled", worker.stats().mailboxes);

  // The passes, so the reading spans more than one attach and every memo has been polled again.
  for (let p = 0; p < PASSES; p++) {
    await new Promise((r) => setTimeout(r, POLL_MS + 500));
    sample(`pass-${p + 1}`, worker.stats().mailboxes);
  }

  const [{ n: instances }] = await db.select({ n: dsql`count(*)::int` }).from(messageInstances);
  const peakSample = peak;
  if (SNAPSHOT) {
    // Its own step, with the worker still running and every memo still reachable: a snapshot taken
    // after the stop is a picture of a different heap.
    v8.writeHeapSnapshot(SNAPSHOT);
  }
  const out = {
    mailboxes: MAILBOXES, inboxPerMailbox: INBOX, passes: PASSES,
    rosterWhole: maxAttached >= MAILBOXES,
    attachedAtEnd: worker.stats().mailboxes, maxAttached, rosterWholeAfterMs: rosterWholeAt,
    accounts: worker.stats().accounts,
    ingestedMessages: ingested, projectionRows: instances,
    heapPinMib: WORKER_HEAP_MIB,
    peak: {
      phase: peakSample.phase,
      rssMib: mib(peakSample.rss), heapUsedMib: mib(peakSample.heapUsed),
      heapTotalMib: mib(peakSample.heapTotal), externalMib: mib(peakSample.external),
      arrayBuffersMib: mib(peakSample.arrayBuffers),
      memoMib: mib(peakSample.memoBytes), warmMemos: peakSample.warmMemos,
      memoShareOfHeapUsed: peakSample.heapUsed ? Math.round((peakSample.memoBytes / peakSample.heapUsed) * 1000) / 1000 : null,
    },
    memoPeak: {
      phase: memoPeak.phase, attached: memoPeak.attached,
      memoMib: mib(memoPeak.memoBytes), warmMemos: memoPeak.warmMemos,
      rssMib: mib(memoPeak.rss), heapUsedMib: mib(memoPeak.heapUsed),
    },
    heapUsedAgainstPin: Math.round((peak.heapUsed / (WORKER_HEAP_MIB * MIB)) * 1000) / 1000,
    rssAgainstPin: Math.round((peak.rss / (WORKER_HEAP_MIB * MIB)) * 1000) / 1000,
    samples: samples.length,
    snapshot: SNAPSHOT || null,
    elapsedMs: Date.now() - started,
  };
  console.log(JSON.stringify(out, null, 2));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ ...out, allSamples: samples }, null, 2));
} finally {
  if (timer) clearInterval(timer);
  if (worker) await worker.stop().catch(() => {});
  for (const s of seeded) {
    await db.delete(mailboxesTable).where(eq(mailboxesTable.id, s.mailboxId)).catch(() => {});
  }
  // A RIG EXITS. The worker's pool and the adapters' sockets keep the loop alive after `stop()`,
  // so without this the process prints its reading and then sits on the box lock it took — which
  // is how the first run of this rig held greenmail for four minutes past its own verdict and
  // reddened a neighbouring file with a leader lock nobody expected.
  setTimeout(() => process.exit(0), 250).unref();
  process.exitCode = 0;
}
