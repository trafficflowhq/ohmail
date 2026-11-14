import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { mailboxes, mailboxCredentials, contacts, messages, folderState, routingDecisions } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { ImapAdapter, type ImapConfig, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  META_FOLDER, parseClaim, type LeaseIo, type RawClaimMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import { startWorker } from "../src/index.js";
import { imapCfg, rawClient, emlOf, ORGANIZER_CONSENT } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * TWO WORLDS, ONE MAILBOX — THE WORKER LEVEL. The deliverable this slice exists for.
 *
 * `packages/core/test/adapters/organizer-lease.imap.test.ts` already proves the ENGINE decides
 * correctly against a real IMAP server, and it proved that while `grep -rn runLeaseGate
 * apps/worker/src apps/sidecar/src` answered **0**. An adapter-level test cannot see the gap that
 * mattered: the worker never called it, and two real mailboxes were organized by Cloud with no
 * claim in `ohmail/_meta` at all. So the assertion here is about `startWorker`, not about
 * `decideLease`.
 *
 * ── THE SHAPE, AND WHY EACH PIECE IS REAL ─────────────────────────────────────────────────
 *
 * Two Cloud deployments: two independently migrated Postgres databases, two `startWorker`
 * processes, two organizer install ids — and ONE GreenMail user, i.e. one physical mailbox, whose
 * credentials are seeded into both. That is the production shape of the thing this prevents: two
 * organizers that cannot see each other's database and can only meet in the mailbox.
 *
 * GreenMail rather than a fake, because the lease is IMAP state: the claim is a message, the
 * renew is APPEND-then-EXPUNGE, and the folder path has to survive a `.` hierarchy delimiter.
 * Two Postgres databases rather than PGlite, because the stand-down is a fenced UPDATE and this
 * repository has had three production bugs that PGlite answered green.
 *
 * ── THE NEGATIVE CONTROL IS IN THIS FILE, AND IT IS WHY THE REST IS EVIDENCE ──────────────
 *
 * "Exactly one world ingested the message" is indistinguishable from "only one world ever ran"
 * unless the same scenario can be shown producing TWO. The control blinds world B's lease — a
 * real `ImapAdapter` in every respect except that `leaseIo()` hands back a private, empty
 * `_meta` — and asserts both databases then ingest the same physical message. Nothing about the
 * production path is switched off by a flag; the control changes what the ADAPTER can see, which
 * is exactly the "no shared medium" world the lease exists to rule out.
 */

let DB_A = "";
let DB_B = "";

type Db = ReturnType<typeof makeDb>;
type Cfg = ReturnType<typeof imapCfg>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 11));

/** A short staleness window, so a stale-claim case does not need a ten-minute test. */
const STALE_MS = 60_000;

async function seedWorld(url: string, cfg: Cfg): Promise<{ db: Db; accountId: string; mailboxId: string }> {
  const db = makeDb(url);
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: cfg.auth.user, ...ORGANIZER_CONSENT }).returning();
  await db.insert(contacts).values({ accountId, address: "anna@x.example" });
  const enc = await KP.encrypt(cfg.auth.pass);
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: cfg.host, port: cfg.port, secure: false, user: cfg.auth.user },
  });
  return { db, accountId, mailboxId: mb!.id };
}

async function appendTo(cfg: Cfg, subject: string, messageId: string): Promise<void> {
  const c = await rawClient(cfg);
  await c.append("INBOX", emlOf({ from: "anna@x.example", subject, messageId }));
  await c.logout();
}

async function countMessages(db: Db, mailboxId: string): Promise<number> {
  return (await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length;
}

/**
 * How many ROUTING DECISIONS this world made about this mailbox's mail.
 *
 * `folder_state`, not `routing_decisions`. The latter is written only on the AI branch
 * (`pipeline.ts`, `if (p.ai && routing)`), and these workers run rules-only — the shipped floor,
 * and the configuration the project's design notes calls the shippable scope. `folder_state` is the
 * desired-folder row the pipeline writes for EVERY ingested message, which is precisely "this
 * organizer decided where this message goes". Counting the AI table here would have made every
 * assertion below read zero and pass for the wrong reason, which is how a guard becomes
 * decoration. Both counters are checked anyway, so a future run with a classifier still bites.
 */
async function countDecisions(db: Db, mailboxId: string): Promise<number> {
  const ids = (await db.select({ id: messages.id }).from(messages)
    .where(eq(messages.mailboxId, mailboxId))).map((r) => r.id);
  if (ids.length === 0) return 0;
  return (await db.select().from(folderState).where(inArray(folderState.messageId, ids))).length;
}

async function countAiDecisions(db: Db, accountId: string): Promise<number> {
  return (await db.select().from(routingDecisions).where(eq(routingDecisions.accountId, accountId))).length;
}

/**
 * Every claim in `ohmail/_meta`, read by a SECOND, INDEPENDENT IMAP client.
 *
 * Asking the code under test where it put something proves nothing — organize-in-place means the
 * server is the fact. This is the acceptance criterion's own instrument: "a second IMAP client
 * sees exactly ONE fresh `cloud` claim".
 */
async function claimsOnServer(cfg: Cfg): Promise<Array<{ installId: string; kind: string; displayName: string }>> {
  const c = await rawClient(cfg);
  try {
    const list = await c.list();
    // GreenMail's hierarchy delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`.
    const path = META_FOLDER.split("/").join(".");
    if (!list.some((f) => f.path === path)) return [];
    const lock = await c.getMailboxLock(path);
    try {
      // COALESCED BY INSTALL ID, newest heartbeat wins — the same thing every reader of this
      // folder does, and here it is the difference between a test and a flake. Renewing is
      // APPEND-then-EXPUNGE (IMAP has no in-place update), so an observer that reads between the
      // two steps legitimately sees TWO claims from ONE organizer. Asserting a raw count would
      // fail once every few hundred runs and look exactly like a dual-organizer bug.
      const newest = new Map<string, { installId: string; kind: string; displayName: string; at: number }>();
      for await (const m of c.fetch("1:*", { uid: true, headers: true })) {
        if (!m.headers) continue;
        const claim = parseClaim(m.headers.toString("utf8"));
        if (!claim || "malformed" in claim) continue;
        const prior = newest.get(claim.installId);
        if (!prior || claim.heartbeat.getTime() > prior.at) {
          newest.set(claim.installId, {
            installId: claim.installId, kind: claim.kind, displayName: claim.displayName,
            at: claim.heartbeat.getTime(),
          });
        }
      }
      return [...newest.values()].map(({ installId, kind, displayName }) => ({ installId, kind, displayName }));
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/**
 * WHERE THE MESSAGE PHYSICALLY IS, read by a SECOND, INDEPENDENT IMAP client — and, beside it,
 * every folder on the server.
 *
 * Organize-in-place means the mailbox is the fact, so "the loser moved nothing" is a statement
 * about the SERVER and cannot be made from either database. Both halves are returned because a
 * reader that created the `ohmail/*` tree without moving anything into it has still written to
 * somebody else's mailbox.
 */
async function serverState(cfg: Cfg, messageId: string): Promise<{ folders: string[]; holding: string[] }> {
  const c = await rawClient(cfg);
  try {
    const folders = (await c.list()).map((f) => f.path).sort();
    const holding: string[] = [];
    for (const path of folders) {
      /* THE LOCK IS INSIDE THE TRY, and that is the whole care this loop needs: a `\Noselect`
         parent (GreenMail lists `ohmail` beside `ohmail.Screener`) makes `getMailboxLock` itself
         throw `Command failed`, and a lock acquired outside the try escapes as a test error that
         says nothing about the mailbox. A folder this client cannot select holds nothing it can
         see, which is the honest answer for a placement question. */
      let lock: Awaited<ReturnType<typeof c.getMailboxLock>> | undefined;
      try {
        lock = await c.getMailboxLock(path);
        const found = await c.search({ header: { "message-id": messageId } }, { uid: true });
        if (Array.isArray(found) && found.length > 0) holding.push(path);
      } catch {
        // Not selectable, or not searchable: it is not where the message is.
      } finally {
        lock?.release();
      }
    }
    return { folders, holding: holding.sort() };
  } finally {
    await c.logout();
  }
}

async function waitFor(pred: () => Promise<boolean>, ms = 20_000, step = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/**
 * A `LeaseIo` WHOSE `listClaims()` FAILS — the 2026-08-03 shape, injected (mail 0029).
 *
 * ── WHY `listClaims` AND NOT `ensureMetaFolder` ────────────────────────────────────────────
 *
 * This is the fault that actually happened, reproduced rather than invented. `ohmail/_meta` existed
 * and was EMPTY, the read issued `FETCH 1:*`, and Dovecot refused it — while GreenMail tolerates
 * exactly that command, which is why the adapter suite was green throughout. The fix is in that change;
 * what this class exercises is the OTHER half, which no fix to the FETCH can address: for 32
 * minutes the worker knew the answer and the mailbox's row said `connected`, `error_code = NULL`,
 * and nothing else.
 *
 * ── AND WHY THE ERROR CARRIES `serverResponseCode: "SECRETPASSWORD123"` ────────────────────
 *
 * Because the observability half of this slice is a privacy question before it is a usability one.
 * imapflow builds `serverResponseCode` by uppercasing the SERVER's own bracket atom (`tools.js`,
 * `getStatusCode`), so a provider answering `* NO [SECRETPASSWORD123] …` hands us an
 * attacker-chosen string wearing an identifier's clothes — it passes any grammar, which is the
 * finding that closed `error_detail` by MEMBERSHIP instead. The byte assertions below are what make
 * "the new `op` / `causeClass` fields do not reopen it" evidence rather than intent, and
 * `Invalid messageset` stands in for the error MESSAGE, which on a LOGIN refusal echoes the
 * credential.
 */
class DeadMeta implements LeaseIo {
  /** Flip to `false` to let the mailbox recover — the arm that proves the clear exists. */
  dead = true;
  private nextUid = 1;
  private readonly held: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> { /* the folder is fine; it is the READ that fails */ }
  async listClaims(): Promise<RawClaimMessage[]> {
    if (this.dead) {
      throw Object.assign(new Error("Error in IMAP command FETCH: Invalid messageset"),
        { serverResponseCode: "SECRETPASSWORD123" });
    }
    return this.held.map((m) => ({ ...m }));
  }
  async appendClaim(raw: string): Promise<void> { this.held.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.held.length - 1; i >= 0; i--) if (gone.has(this.held[i]!.ref)) this.held.splice(i, 1);
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

/** A private, empty `ohmail/_meta` — the "no shared medium" world, for the control ONLY. */
class BlindMeta implements LeaseIo {
  private nextUid = 1;
  private readonly held: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> { /* nothing to create: it is not on a server */ }
  async listClaims(): Promise<RawClaimMessage[]> { return this.held.map((m) => ({ ...m })); }
  async appendClaim(raw: string): Promise<void> { this.held.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.held.length - 1; i >= 0; i--) if (gone.has(this.held[i]!.ref)) this.held.splice(i, 1);
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

/**
 * A REAL `ImapAdapter` whose lease looks at a private folder instead of the server's.
 *
 * Everything the pipeline touches — connect, `changesSince`, `move`, `setFlags` — is the real
 * adapter against the real GreenMail mailbox. Only the lease is blinded, which is what makes the
 * control a control: it does not disable the gate, it removes the shared medium the gate reads.
 */
function blindLeaseFactory(): (cfg: ImapConfig, ctx: { onConnectionError: (e: unknown) => void }) => MailboxAdapter {
  return leaseIoFactory(new BlindMeta());
}

/** The same Proxy, over any injected `LeaseIo` — one shared `io`, so a test can revive it. */
function leaseIoFactory(
  io: LeaseIo,
): (cfg: ImapConfig, ctx: { onConnectionError: (e: unknown) => void }) => MailboxAdapter {
  return (cfg, ctx) => {
    const real = new ImapAdapter(cfg, { onConnectionError: ctx.onConnectionError });
    return new Proxy(real, {
      get(target, prop, _recv) {
        if (prop === "leaseIo") return () => io;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as MailboxAdapter;
  };
}

describe("the organizer lease, at the worker", () => {
  beforeAll(async () => {
    DB_A = await prepareIsolatedDb("trafficflow_worker_lease_a");
    DB_B = await prepareIsolatedDb("trafficflow_worker_lease_b");
  }, 120_000);

  beforeEach(async () => {
    await truncateAll(DB_A);
    await truncateAll(DB_B);
  }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("the loser becomes a reader: keeps its copy, moves and decides nothing on the server", async () => {
    const cfg = imapCfg();                                   // ONE physical mailbox
    const a = await seedWorld(DB_A, cfg);
    const b = await seedWorld(DB_B, cfg);
    await appendTo(cfg, "one message, two organizers", "lease-1@x");

    const workerA = await startWorker({
      databaseUrl: DB_A, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      organizer: { installId: "cloud-world-a", displayName: "World A", staleAfterMs: STALE_MS },
    });
    closers.push(() => workerA.stop());

    // A is the incumbent BEFORE B exists. Sequenced rather than raced on purpose: this is a
    // lease with conflict detection, not a mutex, so a genuine dead heat is allowed to overlap
    // for one cycle. What must be impossible is STEADY-STATE dual organizing, and that is what
    // the rest of this test asserts.
    expect(await waitFor(async () => (await countMessages(a.db, a.mailboxId)) === 1),
      "world A must ingest the message before B is started").toBe(true);

    /* WHAT THE MAILBOX LOOKS LIKE WHEN EXACTLY ONE ORGANIZER HAS TOUCHED IT. Captured here, before
       B exists, because the whole claim below is that B leaves it identical. */
    const afterA = await serverState(cfg, "lease-1@x");
    expect(afterA.holding, "world A must have filed the message somewhere on the server")
      .toHaveLength(1);

    const workerB = await startWorker({
      databaseUrl: DB_B, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      organizer: { installId: "cloud-world-b", displayName: "World B", staleAfterMs: STALE_MS },
    });
    closers.push(() => workerB.stop());

    /* ── THE STAND-DOWN IS DURABLE, AND IT NAMES ITS WINNER ────────────────────────────────
     *
     * THE ROLE, NOT THE STATUS, and the ruling says which in its own words: on the stand-down
     * `markMailboxStoodDown` *"writes role reader + the winner's holder columns, voids the stamp,
     * `closeStoodDownAppointments`; row, credentials, mirror kept"* (the symmetric-takeover
     * ruling). `status` therefore stays `connected` and `disabled_reason` gains no writer at all.
     *
     * This block waited for `disabled` and then read that column — the pre-0083 shape, in which a
     * loser left the roster. It could not say so while nothing could reach the mail server.
     */
    const stoodDown = await waitFor(async () => {
      const [row] = await b.db.select().from(mailboxes).where(eq(mailboxes.id, b.mailboxId));
      return row?.organizerRole === "reader";
    });
    expect(stoodDown, "world B must stand down to a reader").toBe(true);

    const [bRow] = await b.db.select().from(mailboxes).where(eq(mailboxes.id, b.mailboxId));
    expect(bRow!.organizerRole).toBe("reader");
    // The WINNER'S holder columns — the banner names who took it, not merely that something did.
    expect(bRow!.organizedByKind).toBe("cloud");
    expect(bRow!.organizedByName).toBe("World A");
    // "row, credentials, mirror kept": a loser is another mail client on the mailbox, not a corpse.
    expect(bRow!.status).toBe("connected");
    // "voids the stamp" — becoming an organizer again is a new becoming and needs a new press.
    expect(bRow!.takeoverAuthorizedAt).toBeNull();
    // Standing down is NOT failing: the failure columns must be clear, or Settings would render
    // "organized elsewhere" beside a stale "the mailbox rejected the password".
    expect(bRow!.errorCode).toBeNull();
    expect(bRow!.errorDetail).toBeNull();
    expect(bRow!.failedAt).toBeNull();

    /* ── AND IT IS STRUCTURAL: B WRITES NOTHING TO THE MAILBOX ─────────────────────────────
     *
     * The claim is what the reader does NOT do, and a MESSAGE COUNT is no longer part of it. Under
     * the ruling the loser keeps *"row, credentials, mirror"* and reads the mailbox from now on, so
     * B's own copy MAY grow — that is the product difference 0083 shipped, not a leak. This block
     * asserted `countMessages(b) === 0` and, once the row assertions above were corrected, that is
     * the line the file failed on: a reader had mirrored the message, exactly as designed.
     *
     * What must be zero is every write that leaves this process. Counters, not "its move happened
     * to fail"; several poll intervals to be wrong in.
     */
    await new Promise((r) => setTimeout(r, 3000));
    /* `folder_state` ROWS ARE NOT THE TEST — `last_set_by` IS.
     *
     * `countDecisions` counts `folder_state`, one row per ingested message, and its docblock calls
     * that "this organizer decided where this message goes". For a reader it is not: the reader arm
     * of `planChange` (`pipeline.ts:915`) keeps the ARRIVAL folder, marks the plan `passive`, and
     * `commitChange` writes the row `last_set_by: 'external'` — *"a reader adopts. It does not
     * decide."* So a mirroring reader legitimately has rows here, and `=== 0` would forbid the
     * mirror the ruling says it keeps. The discriminator is the column: `'us'` is a placement THIS
     * install chose and would carry to the server; `'external'` and `'peer'` are both notes of where
     * the mail already was. Not one of B's may say `'us'`.
     *
     * ── AND THE ASSERTION NOW SAYS THAT, INSTEAD OF A PROXY FOR IT ──────────────────────────
     *
     * This read `filter((r) => r.lastSetBy !== "external")`, which was a stand-in for "did B decide
     * anything" back when a reader could only ever write `'external'`. A reader in a folder ohmail
     * ORGANIZES now writes `'peer'` — another install of this account placed it and B merely
     * watched (`pipeline.ts#readerAdoption`) — so the proxy started reporting B's own honest
     * adoption as a decision. The claim in the sentence above was always the right one; it is now
     * the code as well, and the exact values are asserted beside it rather than a negation, so a
     * future value cannot slip through by not being the one spelled here.
     */
    const bFolderState = await b.db.select({ id: messages.id, lastSetBy: folderState.lastSetBy })
      .from(folderState)
      .innerJoin(messages, eq(folderState.messageId, messages.id))
      .where(eq(messages.mailboxId, b.mailboxId));
    expect(bFolderState.filter((r) => r.lastSetBy === "us"),
      "world B chose a placement for mail it does not organize").toEqual([]);
    // …and what it DID write, exactly: a mirroring reader's rows, none of them ours. Asserted as a
    // set rather than as "not us" so a third state cannot appear here unnoticed.
    expect([...new Set(bFolderState.map((r) => r.lastSetBy))].sort())
      .toEqual(bFolderState.length === 0 ? [] : ["peer"]);
    expect(await countAiDecisions(b.db, b.accountId)).toBe(0);

    /* AND THE SERVER IS UNTOUCHED BY B — the half no database can answer. Same folder tree, and the
       message still in the one folder A filed it into. A reader that created the `ohmail/*` tree
       without moving anything into it has still written to somebody else's mailbox, so the folder
       list is compared as well as the placement. */
    const afterB = await serverState(cfg, "lease-1@x");
    expect(afterB.holding, "world B moved mail on a server it does not organize").toEqual(afterA.holding);
    expect(afterB.folders, "world B changed the folder tree of a mailbox it does not organize")
      .toEqual(afterA.folders);

    // ── AND STANDING DOWN IS NOT A DEGRADED WORKER (HEALTH-REASON) ────────────────────────────────
    //
    // The ruling, at the worker that made the hand-off, in the exact window that oscillated on the
    // production probe. B stood the mailbox down on its first roster pass and the NEXT pass is a
    // roster interval away, so right now the row is `disabled` while the mailbox is still in this
    // process's duty: expected 1, connected 0. That subtraction is what used to read `degraded`,
    // and it was wrong — B serves nothing because A is organizing the mailbox, which is the
    // dual-mode invariant (exactly one active organizer) working, not failing. The error would
    // have been one per stood-down mailbox and would grow with every desktop install.
    //
    // The breakdown still ACCOUNTS for it. Silence would be its own defect: the mailbox is
    // genuinely unserved by this worker, and `standDown` says so while keeping it out of the
    // calculus. `causes.unserved` is the same count with the hand-off removed — that is the
    // number the verdict ranks, and it is zero.
    const bStats = workerB.stats();
    expect(bStats.degraded, "standing down for another organizer was called a fault").toBe(false);
    /* AND THE MAILBOX IS SERVED — by a READER, which is why `unserved` is now EMPTY rather than
     * `{ total: 1, standDown: 1 }`. That pair was the pre-0083 arithmetic: a loser left the roster,
     * so the process expected one mailbox and connected none, and `standDown` existed to keep that
     * subtraction out of `degraded`. Under the ruling the loser *"keeps its login and its poll
     * timer"* and stays in this worker's duty, so there is nothing to account for and nothing to
     * exempt. `degraded` false is still the claim that matters and it is asserted above; these
     * three say the accounting reached it by serving the mailbox rather than by forgiving a hole.
     */
    expect(bStats.unserved).toMatchObject({ total: 0, standDown: 0, leaseUnreadable: 0, unaccounted: 0 });
    expect(bStats.causes.unserved, "a legitimate hand-off reached the degraded calculus").toBe(0);
    expect(bStats.mailboxes, "the reader left this worker's roster instead of reading the mailbox").toBe(1);

    // EXACTLY ONE routing decision for the message, across both worlds.
    expect(await countDecisions(a.db, a.mailboxId)).toBe(1);

    // A is untouched — the incumbent does not notice the challenger.
    const [aRow] = await a.db.select().from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
    expect(aRow!.status).toBe("connected");
    expect(aRow!.disabledReason).toBeNull();

    // ── A SECOND IMAP CLIENT SEES EXACTLY ONE FRESH `cloud` CLAIM ─────────────────────────
    const claims = await claimsOnServer(cfg);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.installId).toBe("cloud-world-a");
    expect(claims[0]!.kind).toBe("cloud");
    expect(claims[0]!.displayName).toBe("World A");
  }, 90_000);

  it("NEGATIVE CONTROL: blind the lease and the SAME scenario produces two organizers", async () => {
    // Without this, the assertion above cannot be told apart from a run in which world B never
    // had a chance to organize anything. Here it does, and the result is exactly the defect the
    // lease exists to prevent: one physical message, ingested and decided TWICE.
    const cfg = imapCfg();
    const a = await seedWorld(DB_A, cfg);
    const b = await seedWorld(DB_B, cfg);
    await appendTo(cfg, "one message, no shared medium", "lease-2@x");

    const workerA = await startWorker({
      databaseUrl: DB_A, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      organizer: { installId: "cloud-world-a", displayName: "World A", staleAfterMs: STALE_MS },
      adapterFactory: blindLeaseFactory(),
    });
    closers.push(() => workerA.stop());
    expect(await waitFor(async () => (await countMessages(a.db, a.mailboxId)) === 1)).toBe(true);

    const workerB = await startWorker({
      databaseUrl: DB_B, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      organizer: { installId: "cloud-world-b", displayName: "World B", staleAfterMs: STALE_MS },
      adapterFactory: blindLeaseFactory(),
    });
    closers.push(() => workerB.stop());

    expect(await waitFor(async () => (await countMessages(b.db, b.mailboxId)) === 1),
      "with no shared lease, world B must ALSO ingest the message").toBe(true);

    // TWO decisions on one message — the state the first test proves impossible.
    expect(await countDecisions(a.db, a.mailboxId)).toBe(1);
    expect(await countDecisions(b.db, b.mailboxId)).toBe(1);
    const [bRow] = await b.db.select().from(mailboxes).where(eq(mailboxes.id, b.mailboxId));
    expect(bRow!.status).toBe("connected");
    expect(bRow!.disabledReason).toBeNull();

    // …and nothing reached the real `ohmail/_meta`, which is what "blinded" means here.
    expect(await claimsOnServer(cfg)).toEqual([]);
  }, 90_000);

  it("own-role resumption: a RESTART re-claims its own lease instead of standing itself down", async () => {
    // The failure this rules out is not hypothetical, it is the one a per-process install id
    // produces: the incoming worker reads the outgoing one's fresh claim as FOREIGN, falls
    // through to the `available` arm, and DISABLES a mailbox that was being served perfectly.
    // On a Railway rolling deploy that would take a customer's mail offline on the very deploy
    // that introduced the safety mechanism.
    const cfg = imapCfg();
    const a = await seedWorld(DB_A, cfg);
    await appendTo(cfg, "before the restart", "lease-3@x");

    const first = await startWorker({
      databaseUrl: DB_A, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      organizer: { installId: "ohmail-cloud:test", displayName: "Cloud", staleAfterMs: STALE_MS },
    });
    expect(await waitFor(async () => (await countMessages(a.db, a.mailboxId)) === 1)).toBe(true);
    await first.stop();

    // The claim SURVIVES the stop — a clean shutdown must not release it, or a deploy would hand
    // the mailbox to whatever else is listening for the length of the restart.
    expect((await claimsOnServer(cfg)).map((c) => c.installId)).toEqual(["ohmail-cloud:test"]);

    const second = await startWorker({
      databaseUrl: DB_A, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      organizer: { installId: "ohmail-cloud:test", displayName: "Cloud", staleAfterMs: STALE_MS },
    });
    closers.push(() => second.stop());

    await appendTo(cfg, "after the restart", "lease-4@x");
    expect(await waitFor(async () => (await countMessages(a.db, a.mailboxId)) === 2),
      "the restarted worker must keep organizing").toBe(true);

    const [row] = await a.db.select().from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
    expect(row!.status).toBe("connected");
    expect(row!.disabledReason).toBeNull();
    // Still exactly one claim: the renew is append-then-expunge, so a restart must not leave the
    // folder accumulating one message per launch.
    expect(await claimsOnServer(cfg)).toHaveLength(1);
  }, 90_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  MAIL 0029 — A WORKER THAT CANNOT SERVE A MAILBOX SAYS SO ON THE ROW
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The other half of the 2026-08-03 incident, and the reason it belongs in THIS file rather than a
   * unit test: the defect was never in a function, it was in the seam between a catch arm and a
   * row. `attach_lease_unavailable` fired correctly, once every thirty seconds, for thirty-two
   * minutes; `mailboxes` said `connected` throughout; and no test could see the gap because every
   * test asserted the behaviour of the arm.
   *
   * So the assertion here is about `startWorker` against real Postgres and a real IMAP server, with
   * the fault injected at the ONE place it occurred — `LeaseIo.listClaims` — and the row read back
   * with an independent query. Five properties, each of which has its own mutation recorded in the
   * slice notes.
   */
  it("a mailbox whose lease cannot be READ ends up `connected` AND explained on its row", async () => {
    const cfg = imapCfg();
    const a = await seedWorld(DB_A, cfg);
    await appendTo(cfg, "the mailbox nobody could prove was ours", "lease-blocked@x");

    const meta = new DeadMeta();
    const lines: string[] = [];
    // A REAL logger with a captured sink, not a spy: the redaction contract is a property of the
    // BYTES handed to the sink, and `log.ts` says so in as many words — `sanitize()`'s return value
    // is not what reaches a drain. Asserting anything earlier in that pipeline would be asserting
    // the wrong thing.
    const logger = createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) });

    // A grace long enough that the "still clean" window below is not a race, and a roster interval
    // short enough that several passes fit inside it. The grace is what makes this a DURATION rather
    // than a pass count — see `DEFAULT_SYNC_BLOCK_GRACE_MS`.
    const GRACE_MS = 6_000;
    const worker = await startWorker({
      databaseUrl: DB_A, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
      organizer: { installId: "cloud-world-a", displayName: "World A", staleAfterMs: STALE_MS },
      adapterFactory: leaseIoFactory(meta),
      rosterIntervalMs: 500,
      syncBlockGraceMs: GRACE_MS,
      logger,
    });
    closers.push(() => worker.stop());

    const rowOf = async (): Promise<typeof mailboxes.$inferSelect> =>
      (await a.db.select().from(mailboxes).where(eq(mailboxes.id, a.mailboxId)))[0]!;

    // ── 1 · THE ARM FIRES, AND WITHIN THE GRACE THE ROW IS STILL CLEAN ────────────────────
    //
    // The grace exists so a rolling deploy, a leader handoff or one slow first `ensureFolders` does
    // not stamp a reason onto a mailbox that is about to attach perfectly well. `t0` is taken from
    // the arm's own log line, so the window below is measured from the first observation rather
    // than from the test's own clock.
    expect(await waitFor(async () => lines.some((l) => l.includes("attach_lease_unavailable")), 30_000),
      "the lease-unavailable arm never fired — the fault injection missed").toBe(true);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(Date.now() - t0, "the machine was too slow for this window to mean anything")
      .toBeLessThan(GRACE_MS);
    const duringGrace = await rowOf();
    expect(duringGrace.syncBlockedReason,
      "a reason was written INSIDE the grace — a deploy handover would stamp every mailbox").toBeNull();
    expect(duringGrace.syncBlockedSince).toBeNull();

    // ── 2 · AND PAST THE GRACE, THE ROW EXPLAINS ITSELF ──────────────────────────────────
    expect(await waitFor(async () => (await rowOf()).syncBlockedReason !== null, 30_000),
      "the row NEVER said why the mailbox was not syncing — this is the defect, restored").toBe(true);

    const blocked = await rowOf();
    expect(blocked.syncBlockedReason).toBe("lease_unreadable");
    expect(blocked.syncBlockedSince).not.toBeNull();

    // ── 3 · IT IS NOT A FAILURE, AND THE STATUS PROVES IT ────────────────────────────────
    //
    // `status='error'` would put the mailbox into the retry rotation behind an exponential backoff
    // and tell the account's own user their mailbox is broken — about a fault that is OURS. "An
    // infrastructure fault can never quarantine a mailbox" is maintained BY CLASS at four catch
    // sites; this is what proves the new write did not undo it.
    expect(blocked.status, "an infrastructure fault QUARANTINED the mailbox").toBe("connected");
    expect(blocked.errorCode).toBeNull();
    expect(blocked.errorDetail).toBeNull();
    expect(blocked.failedAt).toBeNull();
    expect(blocked.retryCount, "the mailbox earned a retry backoff for OUR fault").toBe(0);
    // Nothing was organized: the gate refused, so the pipeline never ran.
    expect(await countMessages(a.db, a.mailboxId)).toBe(0);
    expect(await countDecisions(a.db, a.mailboxId)).toBe(0);

    // ── 4 · `sync_blocked_since` DOES NOT MOVE ──────────────────────────────────────────
    //
    // The write repeats on EVERY roster pass — that is what converges the row when another writer
    // clears it while the block is still in force — so `coalesce(sync_blocked_since, now)` is the
    // only thing making the column answer "since when" instead of "as of the last pass". Without it
    // a three-day block reports "just now", for ever, which is the same uselessness as saying
    // nothing.
    const firstSince = blocked.syncBlockedSince!.toISOString();
    await new Promise((r) => setTimeout(r, 2_500));    // ≥ 4 further roster passes at 500 ms
    expect((await rowOf()).syncBlockedSince!.toISOString(),
      "sync_blocked_since MOVED — every pass restarted the clock").toBe(firstSince);

    // ── 5 · THE BYTES: THE OPERATION TRAVELS, THE SERVER'S STRINGS DO NOT ────────────────
    const bytes = lines.join("\n");
    expect(bytes, "`op` never reached the log — 'the lease could not be read' is four faults")
      .toContain('"op":"list_claims"');
    expect(bytes, "the wrapper class was the whole record; the cause was dropped")
      .toContain('"causeClass"');
    // The two that may NEVER travel. `serverResponseCode` is an atom the SERVER chose, so it passes
    // any grammar and may only reach `error_detail`, where MEMBERSHIP is tested; the message is the
    // channel that echoes a login argument on a LOGIN refusal.
    expect(bytes, "an attacker-chosen serverResponseCode reached the log drain")
      .not.toContain("SECRETPASSWORD123");
    expect(bytes, "the driver's error MESSAGE reached the log drain")
      .not.toContain("Invalid messageset");

    // ── 6 · AND IT CLEARS ON RECOVERY, WITH `status` NEVER HAVING MOVED ─────────────────
    //
    // THE TRAP THIS ARM EXISTS FOR. `attach` ends with
    // `if (mb.status !== "connected") await markRecovered(mb)` — and in this whole scenario `status`
    // IS `connected`, so `markRecovered` never runs. A clear that lived inside it would never fire,
    // and the mailbox would carry `lease_unreadable` for the life of the process while syncing
    // perfectly. The clear is its own call, conditioned on the row this pass actually read.
    meta.dead = false;
    expect(await waitFor(async () => (await rowOf()).syncBlockedReason === null, 30_000),
      "the block was never cleared — a recovered mailbox still claims it is not syncing").toBe(true);

    const recovered = await rowOf();
    expect(recovered.syncBlockedSince).toBeNull();
    expect(recovered.status, "the status moved — it should never have left `connected`").toBe("connected");
    expect(recovered.errorCode).toBeNull();
    // The positive control for the whole test: this mailbox really was serviceable all along, so a
    // "clean row" above cannot be explained by a worker that was never going to attach it.
    expect(await waitFor(async () => (await countMessages(a.db, a.mailboxId)) === 1, 30_000),
      "the mailbox never synced even after recovery — the block was not the only problem").toBe(true);
  }, 120_000);
});
