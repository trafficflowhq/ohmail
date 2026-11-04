/**
 * A burst of letters against the REAL worker, beside a second mailbox whose visit is slow: each
 * letter timed from its APPEND to its row, then one Mark-read timed to \Seen on the server.
 *   bash scripts/lane-db.sh "$PWD"; bash scripts/lane-greenmail.sh .
 *   set -a; . ./.lane-greenmail.env; set +a   (the database is read from .lane-db.env itself)
 *   node --import tsx apps/worker/test/rigs/burst-latency-rig.mjs --burst 20 --gap-ms 1500 --slow-delay-ms 1500
 * S dials through a proxy holding every server chunk `--slow-delay-ms` (a slow provider); 0 leaves
 * S out and is the control. A FRESH lane database: the worker serves 64 mailboxes and a database
 * other suites filled pushes the rig's two past the cap. Every mailbox and letter is the rig's own.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const BURST = Number(arg("burst", 20));
const GAP_MS = Number(arg("gap-ms", 1500));
const SLOW_DELAY_MS = Number(arg("slow-delay-ms", 1500));
const POLL_MS = Number(arg("poll", 60_000));
const BUDGET_MS = Number(arg("budget-ms", 10 * 60 * 1000));
const JSON_OUT = arg("json", "");
const VERBOSE = argv.includes("--verbose");
/** Quiet before the read is made, so it is not served by a visit already running for the burst. */
const SEEN_AFTER_MS = Number(arg("seen-after-ms", 15_000));

process.env.TF_PROBE_ALLOW_PRIVATE ??= "1";

/**
 * THE ONE DATABASE: `PG_TEST_URL` read from this checkout's own `.lane-db.env`, and nothing else.
 * The rig starts a real worker and inserts mailboxes, so a fallback to whatever URL the shell
 * carries could write into any database. Every other URL in the environment is refused BY NAME;
 * no value is ever printed. `--check-url` stops after this decision (its control).
 */
function laneUrl() {
  const file = fileURLToPath(new URL("../../../../.lane-db.env", import.meta.url));
  if (!existsSync(file)) throw new Error(`rig: REFUSED — no .lane-db.env at the checkout root; run: bash scripts/lane-db.sh "$PWD"`);
  const line = readFileSync(file, "utf8").split("\n").find((l) => /^\s*PG_TEST_URL=/.test(l));
  const fromFile = line ? line.replace(/^\s*PG_TEST_URL=/, "").trim().replace(/^["']|["']$/g, "") : "";
  if (!fromFile) throw new Error("rig: REFUSED — .lane-db.env names no PG_TEST_URL");
  if (!/\/trafficflow_l_[0-9a-f]+(\?|$)/.test(fromFile)) throw new Error("rig: REFUSED — .lane-db.env's PG_TEST_URL is not a lane database");
  for (const name of ["PG_TEST_URL", "DATABASE_URL"]) {
    const v = process.env[name];
    if (v !== undefined && v !== fromFile) throw new Error(`rig: REFUSED — ${name} in the environment is not this checkout's lane database; unset it`);
  }
  return fromFile;
}
const url = laneUrl();
if (argv.includes("--check-url")) { console.log(`URL_OK lane=${url.replace(/^.*\/(trafficflow_l_[0-9a-f]+).*$/, "$1")}`); process.exit(0); }

const { mailboxes: mailboxesTable, mailboxCredentials, messages } = await import("@trafficflow/db");
const { makeDb } = await import("@trafficflow/db/cloud");
const { StaticKeyProvider, createLogger } = await import("@trafficflow/core");
const { startWorker } = await import("../../src/index.ts");
const { greenmailPorts } = await import("../_greenmail-ports.ts");
const { ImapFlow } = await import("imapflow");
const { MessageService } = await import("@trafficflow/services");
const { eq, and, inArray } = await import("drizzle-orm");

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9));
const ports = greenmailPorts();
const db = makeDb(url);
const t0 = Date.now();
const rel = (t) => (t === null ? null : Math.round((t - t0) / 100) / 10);

/** The slow provider: every chunk the server sends is held `delay` ms, in order. */
function slowProxy(delay) {
  return new Promise((resolve) => {
    const srv = net.createServer((client) => {
      const upstream = net.connect(ports.imapPort, ports.imapHost);
      let releaseAt = 0;
      upstream.on("data", (chunk) => {
        releaseAt = Math.max(Date.now() + delay, releaseAt);
        setTimeout(() => { if (!client.destroyed) client.write(chunk); }, releaseAt - Date.now());
      });
      client.on("data", (c) => { if (!upstream.destroyed) upstream.write(c); });
      const end = () => { client.destroy(); upstream.destroy(); };
      client.on("close", end); upstream.on("close", end);
      client.on("error", end); upstream.on("error", end);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function eml(subject, messageId) {
  return [`Message-ID: <${messageId}>`, "From: burst@rig.invalid", "To: rig@trafficflow.test",
    `Subject: ${subject}`, "Content-Type: text/plain", "", "body"].join("\r\n");
}

/**
 * How many of `ids` (Message-ID headers) A's server holds with \Seen, in ANY folder — the
 * organizer files new mail out of INBOX, so an INBOX-only read answers 0 for ever. Read by an
 * independent client.
 */
async function seenOnServer(auth, ids) {
  const c = new ImapFlow({ host: ports.imapHost, port: ports.imapPort, secure: false, auth, logger: false });
  await c.connect();
  let n = 0;
  try {
    for (const f of await c.list()) {
      if (f.flags?.has?.("\\Noselect")) continue;
      const lock = await c.getMailboxLock(f.path);
      try {
        const uids = await c.search({ seen: true }, { uid: true });
        if (!Array.isArray(uids) || uids.length === 0) continue;
        for await (const m of c.fetch(uids.join(","), { envelope: true }, { uid: true })) {
          if (ids.has(String(m.envelope?.messageId ?? "").replace(/^<|>$/g, ""))) n++;
        }
      } finally { lock.release(); }
    }
    return n;
  } finally { await c.logout(); }
}

async function seed(host, port, inbox) {
  const auth = { user: `rig-${randomUUID()}@trafficflow.test`, pass: "rig-worker-password" };
  const [row] = await db.insert(mailboxesTable).values({
    accountId: randomUUID(), provider: "imap", address: auth.user,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 3600_000),
  }).returning();
  const enc = await KP.encrypt(auth.pass);
  await db.insert(mailboxCredentials).values({
    mailboxId: row.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host, port, secure: false, user: auth.user },
  });
  const c = new ImapFlow({ host: ports.imapHost, port: ports.imapPort, secure: false, auth, logger: false });
  await c.connect();
  for (let i = 0; i < inbox; i++) await c.append("INBOX", eml(`seed ${i}`, `seed-${row.id}-${i}@rig.invalid`));
  await c.logout();
  return { mailboxId: row.id, auth };
}

async function rowsOf(mailboxId) {
  return db.select({ messageId: messages.messageIdHeader }).from(messages).where(eq(messages.mailboxId, mailboxId));
}

const wakes = [];
const logger = createLogger({
  service: "worker", level: "info",
  sink: (line) => {
    if (VERBOSE) console.error(line);
    try {
      const j = JSON.parse(line);
      if (j.event === "wake_admitted") wakes.push({ at: rel(Date.now()), latencyMs: j.wakeLatencyMs, mailbox: j.mailboxId });
      if (j.event === "cycle_phases") wakes.push({ at: rel(Date.now()), cycle: true, rotationMs: j.rotationMs });
    } catch { /* not a JSON line */ }
  },
});

let proxy = null;
let worker = null;
const seeded = [];
try {
  const a = await seed(ports.imapHost, ports.imapPort, 3);
  seeded.push(a);
  if (SLOW_DELAY_MS > 0) {
    proxy = await slowProxy(SLOW_DELAY_MS);
    seeded.push(await seed("127.0.0.1", proxy.address().port, 3));
  }
  worker = await startWorker({
    databaseUrl: url, keyProvider: KP, pollIntervalMs: POLL_MS, sentDomain: "trafficflow.test", logger,
  });
  // A's first sync, and S attached: the burst is measured against a settled roster.
  while ((await rowsOf(a.mailboxId)).length < 3 || worker.stats().mailboxes < seeded.length) {
    if (Date.now() - t0 > BUDGET_MS) throw new Error("rig: the roster never settled");
    await new Promise((r) => setTimeout(r, 250));
  }
  const settledAt = rel(Date.now());
  // Let one poll-driven pass begin, so the burst lands INSIDE a pass the slow mailbox holds open
  // (the production shape) rather than on an idle queue.
  await new Promise((r) => setTimeout(r, 2_000));

  const sender = new ImapFlow({ host: ports.imapHost, port: ports.imapPort, secure: false, auth: a.auth, logger: false });
  await sender.connect();
  const letters = [];
  // The reader runs FROM THE FIRST APPEND, beside the sender: a letter's landing is read while
  // the burst is still arriving, never after it.
  const wanted = new Map();
  let reading = true;
  const reader = (async () => {
    while (reading || [...wanted.values()].some((l) => l.landedAt === null)) {
      if (Date.now() - t0 > BUDGET_MS) break;
      const keys = [...wanted.keys()];
      if (keys.length > 0) {
        const rows = await db.select({ messageId: messages.messageIdHeader }).from(messages)
          .where(and(eq(messages.mailboxId, a.mailboxId), inArray(messages.messageIdHeader, keys.map((k) => `<${k}>`).concat(keys))));
        const now = Date.now();
        for (const r of rows) {
          const l = wanted.get(String(r.messageId).replace(/^<|>$/g, ""));
          if (l && l.landedAt === null) l.landedAt = now;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  for (let i = 0; i < BURST; i++) {
    const id = `burst-${i}-${randomUUID()}@rig.invalid`;
    await sender.append("INBOX", eml(`burst ${i}`, id));
    const l = { i, id, appendedAt: Date.now(), landedAt: null };
    letters.push(l);
    wanted.set(id, l);
    if (i < BURST - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  await sender.logout();

  reading = false;
  await reader;
  // THE READ, as the web makes it: one Mark-read over every burst letter through the service the
  // API calls, then the time until A's server holds \Seen on all of them.
  const seen = { marked: 0, markedAtS: null, allSeenAtS: null, waitMs: null };
  if (letters.every((l) => l.landedAt !== null)) {
    await new Promise((r) => setTimeout(r, SEEN_AFTER_MS));
    const rows = await db.select({ id: messages.id, accountId: messages.accountId }).from(messages)
      .where(and(eq(messages.mailboxId, a.mailboxId), inArray(messages.messageIdHeader, letters.map((l) => `<${l.id}>`).concat(letters.map((l) => l.id)))));
    const ctx = { db, accountId: rows[0].accountId, userId: null, now: () => new Date(), requestId: randomUUID() };
    await new MessageService().markSeen(ctx, { ids: rows.map((r) => r.id), unread: false });
    const markedAt = Date.now();
    seen.marked = rows.length; seen.markedAtS = rel(markedAt);
    const ids = new Set(letters.map((l) => l.id));
    while (Date.now() - t0 < BUDGET_MS) {
      const n = await seenOnServer(a.auth, ids);
      if (VERBOSE) console.error(`seen ${n}/${ids.size} at ${rel(Date.now())}s`);
      if (n >= ids.size) { seen.allSeenAtS = rel(Date.now()); seen.waitMs = Date.now() - markedAt; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const lat = letters.map((l) => (l.landedAt === null ? null : l.landedAt - l.appendedAt));
  const done = lat.filter((x) => x !== null).sort((x, y) => x - y);
  const out = {
    burst: BURST, gapMs: GAP_MS, slowDelayMs: SLOW_DELAY_MS, pollMs: POLL_MS, settledAtS: settledAt,
    landed: done.length, never: lat.filter((x) => x === null).length,
    over30s: lat.filter((x) => x === null || x > 30_000).length,
    p50Ms: done[Math.floor(done.length / 2)] ?? null, maxMs: done[done.length - 1] ?? null,
    perLetter: letters.map((l) => ({ i: l.i, appendedAtS: rel(l.appendedAt), landedAtS: rel(l.landedAt), waitMs: l.landedAt === null ? null : l.landedAt - l.appendedAt })),
    seen,
    aWakes: wakes.filter((w) => w.mailbox === a.mailboxId).map((w) => ({ at: w.at, latencyMs: w.latencyMs })),
    cycles: wakes.filter((w) => w.cycle),
  };
  console.log(JSON.stringify(out, null, 2));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
} finally {
  if (worker) await worker.stop().catch(() => {});
  if (proxy) proxy.close();
  for (const s of seeded) await db.delete(mailboxesTable).where(eq(mailboxesTable.id, s.mailboxId)).catch(() => {});
  setTimeout(() => process.exit(0), 250).unref();
  process.exitCode = 0;
}
