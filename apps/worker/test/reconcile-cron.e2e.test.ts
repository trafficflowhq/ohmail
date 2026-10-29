import { UNMETERED_STORAGE_CAP, commitChange, planChange } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { folderState, mailboxes, messageFailures, messageInstances, messages } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { workerHeartbeats } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { runReconcileCron } from "../src/reconcile-cron.js";
import { acquireLeaderLock, leaderLockKeyFor } from "../src/leader-lock.js";
import { cloudInstallId } from "../src/lease.js";
import { byMessageId, makeHarness, rawClient, emlOf, dbUrlFor } from "./_workerenv.js";
import { rigAppendDate } from "../../../test/support/rig-append-date.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * The backend PID(s) holding a given advisory lock — the thing a failover kills.
 *
 * Lifted from `lock-loss.e2e.test.ts`, which established both the query and that terminating the
 * lock session is how this repository reproduces a failover. Safe to aim at the leader key here
 * because the lock is EXCLUSIVE (so a holder that appears while the backstop is running is the
 * backstop's) and because `vitest.config.ts` sets `fileParallelism: false`, so no other suite is
 * contending for it.
 */
async function lockHolders(key: bigint): Promise<number[]> {
  const admin = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin<{ pid: number }[]>`
      SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((classid::bigint << 32) + objid::bigint) = ${key as unknown as number}`;
    return rows.map((r) => Number(r.pid));
  } finally { await admin.end({ timeout: 5 }); }
}

async function terminate(pids: readonly number[]): Promise<void> {
  const admin = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { for (const pid of pids) await admin`SELECT pg_terminate_backend(${pid})`; }
  finally { await admin.end({ timeout: 5 }); }
}

function cfgFrom(h: Awaited<ReturnType<typeof makeHarness>>) {
  return {
    databaseUrl: DB_URL, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
    imap: { host: h.cfg.host, port: h.cfg.port, secure: false, user: h.cfg.auth.user, pass: h.cfg.auth.pass },
    smtp: undefined, pollIntervalMs: 60000, sentDomain: "trafficflow.test",
  };
}

/** GreenMail's hierarchy delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`. */
const META_PATH = META_FOLDER.split("/").join(".");
const serverPath = (canonical: string): string => canonical.split("/").join(".");

type HarnessCfg = Awaited<ReturnType<typeof makeHarness>>["cfg"];

/**
 * A claim message, written to the REAL `ohmail/_meta` by a second IMAP client.
 *
 * Header text rather than a constructed object, and appended to the server rather than injected
 * into a fake: the lease IS IMAP state — the claim is a message, the folder path has to survive a
 * `.` delimiter, and the gate under test reads it with `FETCH`. A fixture that skipped any of
 * that would be testing a different mechanism from the one the invariant rests on.
 */
async function appendClaim(
  cfg: HarnessCfg,
  claim: { kind: string; installId: string; displayName: string; heartbeat?: Date },
): Promise<void> {
  const heartbeat = claim.heartbeat ?? new Date();
  const c = await rawClient(cfg);
  try {
    const list = await c.list();
    if (!list.some((f) => f.path === META_PATH)) await c.mailboxCreate(META_PATH);
    const raw = [
      "X-Ohmail-Lease: 1",
      `X-Ohmail-Organizer-Kind: ${claim.kind}`,
      `X-Ohmail-Install-Id: ${claim.installId}`,
      "X-Ohmail-Protocol: 1",
      `X-Ohmail-Heartbeat: ${heartbeat.toISOString()}`,
      `X-Ohmail-Claimed-At: ${new Date(heartbeat.getTime() - 3_600_000).toISOString()}`,
      `X-Ohmail-Display-Name: ${claim.displayName}`,
      `X-Ohmail-Nonce: n-${Math.random().toString(36).slice(2, 8)}`,
      "",
      "",
    ].join("\r\n");
    /* THE SERVER'S STAMP GOES WITH THE HEARTBEAT, and it has to: a real install that renewed two
       hours ago had its INTERNALDATE stamped two hours ago too. Appending a back-dated heartbeat
       and letting the server stamp NOW forges the one record an honest writer cannot produce — a
       clock two hours behind the server — and the gate reads exactly that pair to refuse such an
       install. Third argument is imapflow's flags, fourth its internal date; a renewal right now
       is stamped by the server itself (a back-dated one comes from rigAppendDate). */
    await c.append(META_PATH, raw, ["\\Seen"], claim.heartbeat);
  } finally {
    await c.logout();
  }
}

/**
 * Every claim in `ohmail/_meta`, read by a SECOND, INDEPENDENT IMAP client, coalesced by install
 * id (newest heartbeat wins).
 *
 * Coalesced because renewing is APPEND-then-EXPUNGE and an observer between the two steps
 * legitimately sees two claims from one organizer. Asking the code under test where it put
 * something proves nothing; organize-in-place means the server is the fact.
 */
async function claimInstallIds(cfg: HarnessCfg): Promise<string[]> {
  const c = await rawClient(cfg);
  try {
    const list = await c.list();
    if (!list.some((f) => f.path === META_PATH)) return [];
    const lock = await c.getMailboxLock(META_PATH);
    try {
      const newest = new Map<string, number>();
      for await (const m of c.fetch("1:*", { uid: true, headers: true })) {
        if (!m.headers) continue;
        const claim = parseClaim(m.headers.toString("utf8"));
        if (!claim || "malformed" in claim) continue;
        const at = claim.heartbeat.getTime();
        if (!newest.has(claim.installId) || at > newest.get(claim.installId)!) {
          newest.set(claim.installId, at);
        }
      }
      return [...newest.keys()].sort();
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/** Which watched folder physically holds this Message-ID on the SERVER, if any. */
async function folderHolding(cfg: HarnessCfg, messageId: string): Promise<string | null> {
  const c = await rawClient(cfg);
  try {
    for (const canonical of ["INBOX", "ohmail/News", "ohmail/Receipts", "ohmail/Screener", "ohmail/Screened"]) {
      const p = serverPath(canonical);
      const list = await c.list();
      if (!list.some((f) => f.path === p) && p !== "INBOX") continue;
      const lock = await c.getMailboxLock(p);
      try {
        const found = await c.search({ header: { "message-id": messageId } }, { uid: true });
        if (Array.isArray(found) && found.length > 0) return canonical;
      } finally {
        lock.release();
      }
    }
    return null;
  } finally {
    await c.logout();
  }
}

describe("cron reconciler backstop", () => {
  /* ── A SWEEP IS ASSERTED AS ITS WHOLE RESULT, NEVER AS THE BOOLEAN ─────────────────────────
   *
   * `runReconcileCron` answers `{ ran, reason }` over seven author-written reasons, and reading
   * `ran` alone collapses them in BOTH directions: a refusal case was satisfied by any of the
   * seven, so "skips when the leader lock is already held" passed on an unreadable lease; and a
   * must-run case failed as a bare `false`, which is how a red here was carried across three tips
   * with no cause. `worker-live` — another process on this database holds the shard's advisory
   * lock, which is the product working — and `stood-down` are not the same reading. */
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("runs a full sweep when no worker holds the lock", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "cron digest", messageId: "cr1@feed" }));
    await c.logout();

    const res = await runReconcileCron(cfgFrom(h));
    expect(res).toEqual({ ran: true });

    const rows = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "cr1@feed"));
    expect(rows).toHaveLength(1);
    expect((rows[0].nativeLocator as { folder: string }).folder).toBe("ohmail/News");
  }, 20000);

  it("stamps last_sync_at — the backstop is the ONLY syncer when it runs", async () => {
    // The gap an independent review caught in the first version of this writer: the stamp
    // lived only in the always-on worker's `cycle()`, excused as "the main loop restamps
    // within 60s". That reasoning is exactly false HERE — this cron runs precisely when the
    // always-on worker is absent, so there is no later loop. Unstamped, a successful sweep
    // leaves `last_sync_at` stale, `evaluateAlerts` keeps paging `sync_lag`, and the (i)
    // panel keeps saying "not synced yet" while mail is demonstrably flowing.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());

    const before = await h.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId));
    expect(before[0]!.lastSyncAt, "the harness must start unstamped or this proves nothing").toBeNull();

    const res = await runReconcileCron(cfgFrom(h));
    expect(res).toEqual({ ran: true });

    const after = await h.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId));
    expect(after[0]!.lastSyncAt).not.toBeNull();
  }, 20000);

  it("skips when the leader lock is already held", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const lock = await acquireLeaderLock(DB_URL);
    closers.push(() => lock!.release());

    const res = await runReconcileCron(cfgFrom(h));
    expect(res).toEqual({ ran: false, reason: "worker-live" });
  }, 20000);

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE ORGANIZER LEASE (SEC3-WORK-3)

     "Exactly one active organizer per mailbox, enforced by a lease in `ohmail/_meta` — the
     mailbox is the only medium a LOCAL install and Cloud share." The shard advisory lock this
     pass takes coordinates Cloud workers with each other and is INVISIBLE to a desktop install,
     so before this gate existed the backstop organized a mailbox the user had moved to their
     own Mac — no infrastructure failure required, just the ordinary dual-mode configuration.

     MUTATION WATCHED: delete the `if (!outcome.organize)` block in `reconcile-cron.ts` (the whole
     stand-down arm, so the pass falls through to `ensureFolders` + `runSyncCycle` exactly as it
     did before this slice). Both assertions below go red in the same run — `res.ran` is `true`,
     the message is ingested into `messages`, it is MOVED to `ohmail/News` on the server out from
     under the desktop, and a second `ohmail-cloud:production` claim appears in `_meta` beside the
     Mac's. That is the second organizer's write, observed.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("stands down — writing and mutating NOTHING — when a local install holds the lease", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "not ours", messageId: "sd1@feed" }));
    await c.logout();
    // The user's Mac, renewing right now. `local` does not outrank `cloud`, so this is arm 7 of
    // the decision table — "we lost, and the folder is still being renewed" — and not arm 5.
    await appendClaim(h.cfg, {
      kind: "local", installId: "the-owners-mac", displayName: "ohmail on Mila's Mac",
    });

    const res = await runReconcileCron(cfgFrom(h));

    // ACCOUNTED AS A STAND-DOWN, never an error: nobody failed, and a mailbox somebody else owns
    // is not this pass's to quarantine.
    expect(res).toEqual({ ran: false, reason: "stood-down" });

    // ZERO DATABASE WRITES about the mail itself.
    const rows = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "sd1@feed"));
    expect(rows, "the backstop ingested a mailbox a desktop install is organizing").toHaveLength(0);

    // ZERO IMAP MUTATIONS: the message the rule would have filed is still where the Mac left it.
    expect(await folderHolding(h.cfg, "sd1@feed")).toBe("INBOX");

    // AND NO SECOND CLAIM. `runLeaseGate` appends our claim only on an `organize` verdict, so the
    // folder holding exactly one install id is the proof that this process did not become an
    // organizer of a mailbox it does not own.
    expect(await claimInstallIds(h.cfg)).toEqual(["the-owners-mac"]);

    // The durable half, through the same fenced lifecycle write the always-on worker's stand-down
    // uses — so the row says WHY rather than merely that the mailbox stopped syncing.
    const [mb] = await h.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId));
    /* THE ROLE, NOT THE STATUS — and this is the new consumer of the same claim, not a weaker one.
     * Mail 0083 made a loser a READER rather than a corpse: `markMailboxStoodDown`
     * leaves `status` alone, writes NOTHING to `disabled_reason` ever again, and puts the whole
     * decision in `organizer_role` plus the holder columns. Asserting the old pair here would be
     * asserting a write that no longer has a writer, which is how this file went two days red
     * behind a mail server nothing could reach. `organized_by_kind` carries the half of
     * `organized_elsewhere:local` that names WHO, which is the half this case is about. */
    expect(mb!.organizerRole).toBe("reader");
    expect(mb!.organizedByKind).toBe("local");
    expect(mb!.organizedByName).toBe("ohmail on Mila's Mac");
    // Standing down is not failing.
    expect(mb!.errorCode).toBeNull();
    expect(mb!.lastSyncAt, "a stood-down sweep must not stamp a sync it did not do").toBeNull();
  }, 30000);

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE REGRESSION GUARD FOR OVER-FIXING

     The backstop is the recovery path for pending mutations when the always-on worker is not
     running, so a lease gate that also stood down on the mailboxes NOBODY organizes would close
     the finding by deleting the feature. Two grounds have to keep working, and both are arms of
     the decision table rather than exemptions bolted onto it:

       · an EMPTY `ohmail/_meta` — arm 4, "nobody has ever organized this mailbox" (covered by
         the first test in this file, which runs against a fresh harness);
       · THIS pass's own claim, however stale — arm 3, "continuing is not becoming". That is the
         situation the backstop exists for: the always-on worker died and left its claim behind.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("recovers a pending mutation on a mailbox whose only claim is a STALE Cloud one", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "owed", messageId: "rec1@feed" }));
    await c.logout();
    // The always-on worker's claim, last renewed two hours ago — i.e. the worker is gone. This is
    // the ONLY claim in the folder, so it is also the newest, and arm 3 answers `organize`.
    await appendClaim(h.cfg, {
      kind: "cloud", installId: cloudInstallId("production"), displayName: "ohmail Cloud",
      heartbeat: rigAppendDate(2 * 60 * 60 * 1000),
    });

    // First sweep: ingest and file, so there is a real message with a real locator to owe a move.
    expect(await runReconcileCron(cfgFrom(h))).toEqual({ ran: true });
    const [row] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "rec1@feed"));
    expect(row, "nothing to recover — the stale-Cloud-claim ground was refused").toBeDefined();
    expect(await folderHolding(h.cfg, "rec1@feed")).toBe("ohmail/News");

    // WHAT A SCREENER DECISION LEAVES BEHIND. The API never opens IMAP (the "Organize-in-place" invariant): it writes
    // the intent and returns, and somebody has to put it on the server. When the always-on worker
    // is absent, this pass is that somebody — which is the whole reason it exists.
    await h.db.update(folderState)
      .set({ desiredFolder: "ohmail/Receipts", reconcileStatus: "pending", lastSetBy: "us", nextAttemptAt: null })
      .where(eq(folderState.messageId, row!.id));

    const res = await runReconcileCron(cfgFrom(h));
    expect(res).toEqual({ ran: true });

    // ON THE SERVER, not in our own row: the mailbox is the master.
    expect(await folderHolding(h.cfg, "rec1@feed")).toBe("ohmail/Receipts");
    const [after] = await h.db.select().from(folderState).where(eq(folderState.messageId, row!.id));
    expect(after!.reconcileStatus).not.toBe("pending");
  }, 45000);

  it("respects the reconcile backoff — a deferred pending row is not attempted, and is not lost", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "deferred", messageId: "bo1@feed" }));
    await c.logout();

    expect(await runReconcileCron(cfgFrom(h))).toEqual({ ran: true });
    const [row] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "bo1@feed"));
    expect(await folderHolding(h.cfg, "bo1@feed")).toBe("ohmail/News");

    // A refusal already deferred this row. `listPendingFolderStates` filters
    // `next_attempt_at IS NULL OR <= now()`, and the backstop reads the SAME query the worker
    // does — so a due-filter that only the always-on loop honoured would let this pass hammer a
    // refusing provider once per tick, which is the head-of-line blocking mail 0058 removed.
    await h.db.update(folderState)
      .set({ desiredFolder: "ohmail/Receipts", reconcileStatus: "pending", lastSetBy: "us" })
      .where(eq(folderState.messageId, row!.id));
    // The deferral, written as the worker writes it (no desired folder), so mail 0163's
    // fresh-intent trigger keeps it.
    await h.db.update(folderState)
      .set({ attempts: 2, nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(folderState.messageId, row!.id));

    expect(await runReconcileCron(cfgFrom(h))).toEqual({ ran: true });
    expect(await folderHolding(h.cfg, "bo1@feed"), "the backstop moved a row that is not due").toBe("ohmail/News");

    // DEFERRAL IS ABOUT HOW OFTEN WE ASK, NEVER ABOUT WHETHER WE STILL OWE IT. The row must still
    // be pending and still name its destination, or "not attempted" would be indistinguishable
    // from "silently dropped".
    const [held] = await h.db.select().from(folderState).where(eq(folderState.messageId, row!.id));
    expect(held!.reconcileStatus).toBe("pending");
    expect(held!.desiredFolder).toBe("ohmail/Receipts");

    // …and when it comes due, the same pass applies it.
    await h.db.update(folderState).set({ nextAttemptAt: null })
      .where(eq(folderState.messageId, row!.id));
    expect(await runReconcileCron(cfgFrom(h))).toEqual({ ran: true });
    expect(await folderHolding(h.cfg, "bo1@feed")).toBe("ohmail/Receipts");
  }, 60000);

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE LEADER FENCE (SEC3-WORK-4)

     An earlier review fix threaded a fence through every mail-bearing write and every IMAP mutation of the sync
     loop, and `SyncDeps.fence` is a NO-OP when absent. This pass built its `SyncDeps` without one
     while `LeaderLock.lost` — which exists precisely to expose the loss — had no consumer at all.
     The sequence: the lock's dedicated session drops (a failover, a network break, a
     `pg_terminate_backend`), Postgres frees the advisory lock immediately, a standby worker takes
     it and attaches the same mailbox, and this pass keeps writing on its own pooled handle.

     The takeover is driven through `worker_heartbeats` rather than by killing a backend, because
     that is the DURABLE half of the fence and because `pg_terminate_backend` on a shared test
     Postgres takes other suites down with it. `shard_index` is the PRIMARY KEY, so one row per
     shard means "this row still names me" and "nobody has taken this shard from me" are the same
     statement — which is what makes the successor's claiming write refuse this pass.

     MUTATION WATCHED: drop `fence:` from the `SyncDeps` literal in `reconcile-cron.ts`. The
     assertions below go red — the sweep runs to completion (`ran: true`) and ingests the message
     beside the standby that now leads the shard.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("aborts at its next write when the shard is taken over mid-sweep", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "mid-sweep", messageId: "fn1@feed" }));
    await c.logout();

    // The standby takes the shard the moment this pass has announced itself as its leader — i.e.
    // inside the window between the heartbeat claim and the first fenced write, which is the
    // window the finding is about.
    let tookOver = false;
    const takeover = (async () => {
      for (let i = 0; i < 4000 && !tookOver; i++) {
        const claimed = await h.db.select().from(workerHeartbeats)
          .where(and(eq(workerHeartbeats.shardIndex, 0), eq(workerHeartbeats.leader, true)));
        if (claimed[0] && String(claimed[0].instanceId).startsWith("reconcile-cron:")) {
          await h.db.update(workerHeartbeats)
            .set({ instanceId: "standby-worker", leader: true, beatAt: new Date() })
            .where(eq(workerHeartbeats.shardIndex, 0));
          tookOver = true;
          return;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    const res = await runReconcileCron(cfgFrom(h));
    await takeover;

    expect(tookOver, "the takeover never landed — this run proves nothing about the fence").toBe(true);
    // NOT A FAILURE — a handover. Exiting 1 here would page a human for a routine failover.
    expect(res).toEqual({ ran: false, reason: "leadership-lost" });

    // NOTHING PARTIALLY APPLIED. The refused write group is a transaction, so the message is
    // either wholly ingested or not at all — and it must be not at all, because this process
    // stopped leading the shard before it committed.
    const rows = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "fn1@feed"));
    expect(rows, "a fenced-out sweep committed mail beside the new leader").toHaveLength(0);
    const [mb] = await h.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId));
    expect(mb!.lastSyncAt, "a fenced-out sweep stamped a sync it did not do").toBeNull();

    // The successor's claim is intact: `clearHeartbeat` is guarded on the surrendering instance
    // id, so this pass's teardown cannot clobber the worker that took the shard from it.
    const [beat] = await h.db.select().from(workerHeartbeats)
      .where(eq(workerHeartbeats.shardIndex, 0));
    expect(beat!.instanceId).toBe("standby-worker");
    expect(beat!.leader).toBe(true);
  }, 45000);

  it("aborts at its next write when the lock SESSION is terminated mid-sweep", async () => {
    // The other half of the fence, and the one `LeaderLock.lost` exists for. The advisory lock is
    // SESSION-scoped, so Postgres frees it the instant the connection drops and postgres.js then
    // silently RECONNECTS on the next query — into a session that does not hold it. Without a
    // consumer for `lost`, this pass would keep writing and mutating for the rest of its sweep on
    // a lock it no longer has.
    //
    // MUTATION WATCHED: replace `() => lockLost` with `() => false` in the `makeSyncWriteFence`
    // call. The sweep then runs to completion and `res.ran` is `true` with the message ingested —
    // the heartbeat half cannot catch this one, because no successor has claimed the shard yet.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "killed", messageId: "lk1@feed" }));
    await c.logout();

    let killed = false;
    const sweep = runReconcileCron(cfgFrom(h));
    for (let i = 0; i < 2000 && !killed; i++) {
      const holders = await lockHolders(leaderLockKeyFor(0));
      if (holders.length > 0) {
        expect(holders, "somebody else holds the leader lock — this run proves nothing").toHaveLength(1);
        await terminate(holders);
        killed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    const res = await sweep;

    expect(killed, "the lock session was never terminated").toBe(true);
    expect(res).toEqual({ ran: false, reason: "leadership-lost" });

    const rows = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "lk1@feed"));
    expect(rows, "the sweep committed mail after its lock was gone").toHaveLength(0);
    expect(await folderHolding(h.cfg, "lk1@feed"), "the sweep mutated IMAP after its lock was gone").toBe("INBOX");
    const [mb] = await h.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId));
    expect(mb!.lastSyncAt).toBeNull();
  }, 45000);

  it("surrenders its own heartbeat claim on the way out", async () => {
    // The claim is what makes the fence real, so it is also a thing that can be LEFT BEHIND: a
    // row still saying `leader = true` for a process that has exited makes `worker_down` wait out
    // the full staleness window before reporting a shard nothing is serving.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await h.db.delete(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, 0));

    expect(await runReconcileCron(cfgFrom(h))).toEqual({ ran: true });

    const [beat] = await h.db.select().from(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, 0));
    expect(beat, "the backstop never claimed the shard, so its fence was refusing every write").toBeDefined();
    expect(beat!.instanceId).toMatch(/^reconcile-cron:/);
    expect(beat!.leader, "the backstop left the shard looking led by a process that has exited").toBe(false);
  }, 30000);

  it("refuses to sweep a mailbox the account has disconnected", async () => {
    // `loadEnabledMailboxes` selects `status <> 'disabled'`, so the always-on worker never
    // attaches one; this pass takes its mailbox from the environment and therefore never asked.
    // A disabled row is either the user's own disconnect or a stand-down already recorded, and
    // sweeping it undoes the first and silently re-enters the second.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "disconnected", messageId: "dc1@feed" }));
    await c.logout();
    await h.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, h.mailboxId));

    const res = await runReconcileCron(cfgFrom(h));
    expect(res).toEqual({ ran: false, reason: "mailbox-disabled" });

    expect(await h.db.select().from(messages).where(byMessageId(h.mailboxId, "dc1@feed"))).toHaveLength(0);
    expect(await folderHolding(h.cfg, "dc1@feed")).toBe("INBOX");
    // It did not even reach the heartbeat claim, so nothing announced this shard as led.
    const [beat] = await h.db.select().from(workerHeartbeats)
      .where(and(eq(workerHeartbeats.shardIndex, 0), sql`${workerHeartbeats.instanceId} like 'reconcile-cron:%'`));
    expect(beat?.leader ?? false).toBe(false);
  }, 30000);

  /* ══ THE BLANK REPAIR'S MODE HOLDS ON THIS DOOR TOO ══════════════════════════════════════════
     The sweep's two cycles run the visit's passes, the blank repair among them, so the mode an
     operator set with OHMAIL_BLANK_REPAIR has to reach them: off and dry change nothing, and only
     apply (unset) puts back the letter an older build's blank carried into the Screener.
     MUTATION WATCHED: drop the `blankRepair` line from `reconcile-cron.ts`'s deps, and the off sweep
     moves the letter to INBOX. */
  it("honours OHMAIL_BLANK_REPAIR: off and dry change nothing, and apply returns the letter", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const screener = serverPath("ohmail/Screener");
    const c = await rawClient(h.cfg);
    let place = { uidValidity: "", uid: 0 };
    try {
      await c.append(screener, emlOf({ from: "anna@x.example", subject: "hidden by a blank", messageId: "bk1@x" }));
      const lock = await c.getMailboxLock(screener);
      try {
        const uids = await c.search({ all: true }, { uid: true }) as number[];
        place = { uidValidity: String((c.mailbox as { uidValidity: bigint }).uidValidity), uid: Math.max(...uids) };
      } finally { lock.release(); }
    } finally { await c.logout(); }
    // THE DAMAGE, as an older build stored it: the blank at the letter's place, filed there by ohmail.
    const blankId = await h.db.transaction(async (tx) => {
      const r = makeDrizzleRepo(tx as never);
      const plan = await planChange({
        type: "create", locator: { folder: "ohmail/Screener", ref: `${place.uidValidity}:${place.uid}` },
        raw: Buffer.from("\r\n"), seen: false,
      }, { repo: r, accountId: h.accountId, mailboxId: h.mailboxId, readerMode: false });
      return (await commitChange(plan, {
        storageCap: UNMETERED_STORAGE_CAP, repo: r, accountId: h.accountId, mailboxId: h.mailboxId,
      })).messageId;
    });
    await h.repo.upsertFolderState(blankId, { desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us" });
    const places = async () => (await h.db.select({ uid: messageInstances.uid }).from(messageInstances)
      .where(eq(messageInstances.messageId, blankId))).length;
    const owed = async () => (await h.db.select({ uid: messageFailures.uid }).from(messageFailures)
      .where(eq(messageFailures.mailboxId, h.mailboxId))).length;

    for (const mode of ["off", "dry"] as const) {
      expect(await runReconcileCron({ ...cfgFrom(h), blankRepair: mode }), mode).toEqual({ ran: true });
      expect(await folderHolding(h.cfg, "bk1@x"), `the ${mode} sweep moved the letter`).toBe("ohmail/Screener");
      expect(await places(), `the ${mode} sweep let go of the blank's place`).toBe(1);
      expect(await owed(), `the ${mode} sweep owed a re-read`).toBe(0);
    }
    // CONTROL: unset is apply, and the sweep puts the letter back where the blank took it from.
    expect(await runReconcileCron(cfgFrom(h))).toEqual({ ran: true });
    expect(await folderHolding(h.cfg, "bk1@x")).toBe("INBOX");
    expect(await places()).toBe(0);
  }, 60000);
});
