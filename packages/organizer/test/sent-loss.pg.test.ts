import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mailboxFolders, messageFailures, messageInstances, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { MAX_RAW_MESSAGE_BYTES, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import { WATCHED_FOLDERS, type ImapCursor, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { DeadLetterLedger } from "../src/dead-letter.js";
import { makeHarness, rawClient, repoWithFailingMethod, DB_URL } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ONE PLACE THIS DESIGN LOST A MESSAGE RATHER THAN DELAYING IT — mail 0041
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `dead-letter.ts` named the residual in its own words before this slice: the ledger was
 * process-local, so "a restart re-attempts every skipped UID once". For the five enumerated folders
 * that is a feature — the known-set diff re-offers them anyway, so a deploy carrying a parser fix
 * ingests them with nobody doing anything. The Sent folder's cursor is a UID WATERMARK, and steady
 * state is `UID FETCH <uidNext>:*`, so a skipped UID the watermark has crossed is never enumerated
 * again — and `own_copy` mail legitimately produces no `messages` row, so nothing else in the system
 * could notice.
 *
 * The first test is THE REPRODUCTION, and it is written so that it passes on the pre-0041 code and
 * on this one: it asserts the properties that must hold either way (the neighbour ingests, the
 * watermark advances, the mailbox never wedges) plus the one that distinguishes them (a restart, and
 * then a new build, and does the message arrive).
 *
 * Real IMAP and real Postgres, because the claim spans the adapter's watermark arithmetic, the
 * ingest loop's skip decision, a durable table and what actually commits. PGlite has been blind to
 * three production bugs in this repository and could host none of this.
 */

const AVAILABLE = await realPgAvailable(DB_URL);
const OVERSIZE = Buffer.alloc(MAX_RAW_MESSAGE_BYTES + 1);
const CANONICAL = new Set<string>(WATCHED_FOLDERS);

/** Hand `changesSince` back unchanged, except that ONE message's body is unparseable. */
function poisonBody(
  inner: MailboxAdapter, victimMid: string, seen: { offered: number }, live: { on: boolean },
): MailboxAdapter {
  return new Proxy(inner, {
    get(t, prop, recv) {
      if (prop === "changesSince") {
        return async (c: ImapCursor) => {
          const batch = await (t as MailboxAdapter).changesSince(c);
          return {
            ...batch,
            creates: batch.creates.map((ch) => {
              if (!ch.raw || !Buffer.from(ch.raw).includes(`<${victimMid}>`)) return ch;
              seen.offered++;
              return live.on ? { ...ch, raw: OVERSIZE } : ch;
            }),
          };
        };
      }
      // `fetchByUid` — the TARGETED retry. Poisoned by the same switch, and counted separately,
      // because "the retry asked for it" and "the batch offered it" are different claims.
      if (prop === "fetchByUid") {
        return async (folder: string, uids: readonly number[], opts?: { maxBytes?: number }) => {
          const found = await (t as MailboxAdapter).fetchByUid!(folder, uids, opts);
          if (!live.on) return found;
          return {
            ...found,
            creates: found.creates.map((ch) =>
              ch.raw && Buffer.from(ch.raw).includes(`<${victimMid}>`) ? { ...ch, raw: OVERSIZE } : ch),
          };
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

function eml(o: { from: string; to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8", "", "body text",
  ].join("\r\n");
}

describe.skipIf(!AVAILABLE)("a poison message in SENT (GreenMail + real Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  type Harness = Awaited<ReturnType<typeof makeHarness>>;

  const rowFor = async (h: Harness, mid: string) =>
    h.db.select().from(messages)
      .where(and(eq(messages.mailboxId, h.mailboxId), eq(messages.messageIdHeader, mid)));

  const sentCursor = async (h: Harness) => {
    const rows = await h.db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, h.mailboxId));
    return rows.find((f) => !CANONICAL.has(f.folder));
  };

  const failures = async (h: Harness) =>
    h.db.select().from(messageFailures).where(eq(messageFailures.mailboxId, h.mailboxId));

  async function seedSent(h: Harness, mids: readonly string[]): Promise<void> {
    const c = await rawClient(h.cfg);
    await c.mailboxCreate("Sent");
    for (const mid of mids) {
      await c.append("Sent", eml({
        from: h.cfg.auth.user, to: "anna@x.example", subject: mid, messageId: mid,
      }));
    }
    await c.logout();
  }

  it("the watermark crosses it, a restart is survived, and the next BUILD recovers it", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const victim = `lost-${randomUUID()}@trafficflow.test`;
    const neighbour = `kept-${randomUUID()}@trafficflow.test`;
    await seedSent(h, [victim, neighbour]);

    const seen = { offered: 0 };
    const live = { on: true };
    const adapter = poisonBody(h.adapter, victim, seen, live);
    const base = {
      repo: h.repo, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      buildVersion: "build-one",
    };

    // ── CYCLE 1: the victim is written off, the neighbour commits, the watermark advances ────
    const first = new DeadLetterLedger();
    await expect(runSyncCycle({ ...base, deadLetters: first })).resolves.toEqual({ hasBacklog: false, owesFiling: false });
    expect(seen.offered).toBe(1);
    expect(first.skipped).toBe(1);
    const skipped = first.entries()[0]!;
    expect(skipped).toMatchObject({ code: "mime_too_large", terminal: true });
    expect(await rowFor(h, neighbour)).toHaveLength(1);
    expect(await rowFor(h, victim)).toHaveLength(0);

    const cursor = await sentCursor(h);
    expect(cursor, "the Sent cursor must exist for the watermark claim to mean anything").toBeDefined();
    expect(cursor!.folder.toLowerCase()).toContain("sent");
    // THE WATERMARK IS PAST IT, and it must stay that way: a design that held the watermark below a
    // skipped UID would re-fetch the poison body on every cycle for ever.
    expect(Number(cursor!.uidnext)).toBeGreaterThan(skipped.uid);

    // ── THE DURABLE RECORD. This is what did not exist, and its absence WAS the loss ─────────
    const owed = await failures(h);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      folder: cursor!.folder, uid: skipped.uid, code: "mime_too_large", attempts: 1,
      attemptedVersion: "build-one", resolvedAt: null,
    });
    expect(String(owed[0]!.uidvalidity)).toBe(skipped.uidValidity);
    // Deterministic in the bytes ⇒ NO clock-retry. Only a new build can change the answer, so an
    // hourly probe would re-download a 64 MiB body to refuse it for the same reason as last time.
    expect(owed[0]!.nextAttemptAt).toBeNull();
    // CONTENT-FREE, and this is the "Account isolation is absolute, and it binds staff too" invariant assertion rather than a tidiness one: the row's every
    // text-bearing column is checked, so a column carrying a subject or a Message-ID would fail here
    // rather than in a review.
    for (const [k, v] of Object.entries(owed[0]!)) {
      if (typeof v === "string") expect(v, `column ${k}`).not.toContain(victim.split("@")[0]!);
    }

    // ── A RESTART, ON THE SAME BUILD: nothing is re-fetched and nothing is lost ──────────────
    //
    // A fresh ledger IS a restart. Before that change the UID left the known-set here and the Sent
    // watermark had already crossed it, so it was gone. Now the ledger is hydrated from the table:
    // the UID is still known (so the main batch does not re-fetch its body) and still owed (so the
    // record survives).
    const afterRestart = new DeadLetterLedger();
    await expect(runSyncCycle({ ...base, deadLetters: afterRestart })).resolves.toBeTruthy();
    expect(seen.offered, "the main batch must not re-offer a UID the watermark has crossed").toBe(1);
    expect(afterRestart.entries()).toHaveLength(1);
    expect(afterRestart.entries()[0]).toMatchObject({ uid: skipped.uid, terminal: true });
    // The version arm is DISARMED on the same build: one probe per build, not one per cycle.
    expect((await failures(h))[0]!.attempts).toBe(1);

    // ── AND THE BUILD THAT CAN PARSE IT ARRIVES ──────────────────────────────────────────────
    //
    // `live.on = false` is the parser fix; `buildVersion` is the deploy that carries it. Before 0041
    // this changed nothing at all — the message was behind the watermark and no amount of correct
    // code reached it.
    live.on = false;
    await expect(runSyncCycle({
      ...base, buildVersion: "build-two", deadLetters: new DeadLetterLedger(),
    })).resolves.toBeTruthy();

    const recovered = await rowFor(h, victim);
    expect(recovered, "the message the user actually sent is back in their view").toHaveLength(1);
    const closed = await failures(h);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.resolvedAt).not.toBeNull();
    expect(closed[0]!.attempts).toBe(2);

    // It is the USER'S OWN mail: read, and outside the six canonical folders, exactly as a Sent
    // message ingested the ordinary way is. A retry that produced a different shape would be a
    // second ingest path with its own bugs.
    expect(recovered[0]!.unread).toBe(false);
    expect(CANONICAL.has((recovered[0]!.nativeLocator as { folder: string }).folder)).toBe(false);

    // ── AND IT IS NOT RETRIED AGAIN, ON THIS BUILD OR THE NEXT ───────────────────────────────
    for (const v of ["build-two", "build-three"]) {
      await expect(runSyncCycle({
        ...base, buildVersion: v, deadLetters: new DeadLetterLedger(),
      })).resolves.toBeTruthy();
    }
    expect(await rowFor(h, victim)).toHaveLength(1);
    expect((await failures(h))[0]!.attempts).toBe(2);
    // ONE physical instance for the recovered message — the idempotency claim, at the locator level.
    const inst = await h.db.select().from(messageInstances)
      .where(and(eq(messageInstances.mailboxId, h.mailboxId), eq(messageInstances.messageId, recovered[0]!.id)));
    expect(inst).toHaveLength(1);
  }, 90000);

  it("a retry that succeeds but cannot be resolved converges — no second message", async () => {
    // The crash-replay shape. The claim is committed and the message is committed; the process dies
    // before `resolveMessageFailure`. The row stays owed, the next cycle re-reads the same UID, and
    // `planChange`'s dual-key lookup has to answer `duplicate` rather than ingesting again.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const victim = `replay-${randomUUID()}@trafficflow.test`;
    await seedSent(h, [victim]);

    const seen = { offered: 0 };
    const live = { on: true };
    const adapter = poisonBody(h.adapter, victim, seen, live);
    const base = { repo: h.repo, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    await runSyncCycle({ ...base, buildVersion: "v1", deadLetters: new DeadLetterLedger() });
    expect(await failures(h)).toHaveLength(1);

    // The fix ships, and the resolve write is made to fail — the crash window, simulated at the one
    // statement that closes the record.
    live.on = false;
    let resolves = 0;
    const brokenResolve = repoWithFailingMethod(h.repo, "resolveMessageFailure", () => {
      resolves++; throw new Error("died before the record was closed");
    });
    await expect(runSyncCycle({
      ...base, repo: brokenResolve, buildVersion: "v2", deadLetters: new DeadLetterLedger(),
    })).resolves.toBeTruthy();
    expect(resolves).toBe(1);
    expect(await rowFor(h, victim)).toHaveLength(1);
    // Still owed, because the close failed. That is the SAFE direction.
    expect((await failures(h))[0]!.resolvedAt).toBeNull();

    // The replay. A second ingest of the same bytes must converge, not duplicate.
    await expect(runSyncCycle({
      ...base, buildVersion: "v3", deadLetters: new DeadLetterLedger(),
    })).resolves.toBeTruthy();
    expect(await rowFor(h, victim)).toHaveLength(1);
    expect((await failures(h))[0]!.resolvedAt).not.toBeNull();
  }, 90000);

  it("fetchByUid answers for EVERY named UID — ingestable, oversize, absent", async () => {
    // The adapter contract the retry pass depends on. The caller closes a durable record per UID, so
    // "the server returned fewer messages than I asked about" is not an answer it can act on: RFC 3501
    // lets a `UID FETCH` simply return less, with no error and no per-UID signal. Hence three
    // disjoint buckets whose union is the request.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const small = `small-${randomUUID()}@trafficflow.test`;
    const big = `big-${randomUUID()}@trafficflow.test`;
    const c = await rawClient(h.cfg);
    await c.mailboxCreate("Sent");
    await c.append("Sent", eml({ from: h.cfg.auth.user, to: "anna@x.example", subject: small, messageId: small }));
    await c.append("Sent", [
      `Message-ID: <${big}>`, `From: ${h.cfg.auth.user}`, "To: anna@x.example", `Subject: ${big}`,
      "Content-Type: text/plain; charset=utf-8", "", "x".repeat(4096),
    ].join("\r\n"));
    const uids: number[] = [];
    const lock = await c.getMailboxLock("Sent");
    try {
      for (const mid of [small, big]) {
        const r = await c.search({ header: { "message-id": mid } }, { uid: true });
        uids.push((Array.isArray(r) ? r : [])[0]!);
      }
    } finally { lock.release(); }
    await c.logout();

    // 2 KiB is below the 4 KiB body and above the small one — so the ceiling is what separates them,
    // not the order they were appended in. `absent` gets a UID the mailbox has never issued.
    const absentUid = Math.max(...uids) + 5000;
    const found = await h.adapter.fetchByUid("Sent", [...uids, absentUid], { maxBytes: 2048 });

    expect(found.uidValidity).not.toBe("0");
    expect(found.creates.map((ch) => Buffer.from(ch.raw!).includes(`<${small}>`))).toEqual([true]);
    expect(found.oversize, "the big message must be refused from RFC822.SIZE, unfetched").toEqual([uids[1]]);
    expect(found.absent).toEqual([absentUid]);
    // The union IS the request — nothing named is silently unaccounted for.
    const answered = [
      ...found.creates.map((ch) => Number(ch.locator.ref.split(":")[1])),
      ...found.oversize, ...found.absent,
    ].sort((a, b) => a - b);
    expect(answered).toEqual([...uids, absentUid].sort((a, b) => a - b));
    // The user's OWN mail: the Sent stamp is applied by the same resolution `changesSince` uses, so a
    // retried reply routes through `own_copy` rather than arriving as inbound mail.
    expect(found.creates[0]!.ownAuthored).toBe(true);
  }, 60000);

  it("REFUSES TO SKIP when the durable record cannot be written — the cursor is held", async () => {
    // THE SAFETY PROPERTY OF THE WHOLE SLICE. The cursor may cross a UID only once its row is
    // committed; a write that failed and was swallowed would advance the Sent watermark over mail
    // nothing would ever enumerate again — the original defect, reachable through a database hiccup
    // instead of through a restart. So the terminal decision is REVOKED, the folder is deferred, and
    // the cycle fails.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const victim = `unrecordable-${randomUUID()}@trafficflow.test`;
    await seedSent(h, [victim]);

    const live = { on: true };
    const adapter = poisonBody(h.adapter, victim, { offered: 0 }, live);
    let writes = 0;
    const brokenRecord = repoWithFailingMethod(h.repo, "recordMessageFailure", () => {
      writes++; throw new Error("could not write the failure record");
    });
    const ledger = new DeadLetterLedger();

    await expect(runSyncCycle({
      repo: brokenRecord, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      buildVersion: "v1", deadLetters: ledger,
    })).rejects.toThrow("could not write the failure record");
    expect(writes).toBe(1);

    // The decision was TAKEN BACK: the UID is not terminal, so it does not join the known-set and
    // nothing pretends it has been dealt with.
    expect(ledger.entries()[0]).toMatchObject({ terminal: false });
    expect(ledger.skipped).toBe(0);
    // And no cursor was written for the Sent folder at all, so the watermark is still below it.
    expect(await sentCursor(h)).toBeUndefined();

    // The mailbox is not wedged for ever, which is the other half of the contract: once the write
    // can happen, the skip sticks and the cursor moves on.
    await expect(runSyncCycle({
      repo: h.repo, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      buildVersion: "v1", deadLetters: ledger,
    })).resolves.toBeTruthy();
    expect((await failures(h))).toHaveLength(1);
    expect(Number((await sentCursor(h))!.uidnext)).toBeGreaterThan((await failures(h))[0]!.uid);
  }, 90000);

  it("a record whose EPOCH no longer matches is voided, and its UID is NOT re-ingested", async () => {
    // A UID number means nothing outside the epoch that issued it. A folder that resets its
    // UIDVALIDITY commonly re-allocates from low numbers, so re-reading a stale record's UID would
    // ingest whatever message the server has RENUMBERED onto that number — a different message
    // entirely — and would then close the record as though the original had arrived.
    //
    // Voiding the record loses nothing in the real case: a UIDVALIDITY change makes the adapter emit
    // every prior UID as a delete and re-enumerate the whole folder, so the original message is
    // offered again as an ordinary unknown UID.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const victim = `epoch-${randomUUID()}@trafficflow.test`;
    await seedSent(h, [victim]);

    const live = { on: true };
    const adapter = poisonBody(h.adapter, victim, { offered: 0 }, live);
    const base = { repo: h.repo, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // Cycle 1 writes the record for the real epoch, and the watermark crosses the UID.
    await runSyncCycle({ ...base, buildVersion: "v1", deadLetters: new DeadLetterLedger() });
    const [owed] = await failures(h);
    expect(owed).toBeDefined();
    expect(await rowFor(h, victim)).toHaveLength(0);

    // Now the record's epoch is not the one the server is reporting. Rewritten rather than provoked,
    // because forcing a real UIDVALIDITY reset would ALSO re-enumerate the folder and hide the
    // decision under test.
    await h.db.update(messageFailures)
      .set({ uidvalidity: 999_999_999n })
      .where(eq(messageFailures.id, owed!.id));

    // The parser fix ships. The record is due — and must be REFUSED anyway.
    live.on = false;
    await runSyncCycle({ ...base, buildVersion: "v2", deadLetters: new DeadLetterLedger() });

    const closed = await failures(h);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.resolvedAt, "a void record must be closed, not carried for ever").not.toBeNull();
    // THE ASSERTION THE GUARD EXISTS FOR: nothing was ingested at that UID. Remove the epoch check
    // and this message arrives under a record that was never about it.
    expect(
      await rowFor(h, victim),
      "a UID was re-ingested under an epoch the record does not name",
    ).toHaveLength(0);
    expect(await h.db.select().from(messageInstances)
      .where(eq(messageInstances.mailboxId, h.mailboxId))).toHaveLength(0);
  }, 90000);

  it("a message that keeps failing escalates, and never stops the mailbox", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const victim = `stuck-${randomUUID()}@trafficflow.test`;
    const neighbour = `fine-${randomUUID()}@trafficflow.test`;
    await seedSent(h, [victim, neighbour]);

    const seen = { offered: 0 };
    const live = { on: true };
    const adapter = poisonBody(h.adapter, victim, seen, live);
    const base = { repo: h.repo, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // Three builds, none of which can read it. The poison here is injected AFTER the fetch (the
    // proxy substitutes the body), so this exercises the re-record path and not the `RFC822.SIZE`
    // pre-check — that one is covered directly against the adapter in the case below, because a
    // 64 MiB message on the server is not something to append to a test mailbox.
    const ledger = new DeadLetterLedger();
    for (const v of ["v1", "v2", "v3"]) {
      await expect(runSyncCycle({ ...base, buildVersion: v, deadLetters: ledger }))
        .resolves.toEqual({ hasBacklog: false, owesFiling: false });
    }

    const owed = await failures(h);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.attempts).toBeGreaterThanOrEqual(3);
    expect(owed[0]!.resolvedAt).toBeNull();
    // OPERATOR-VISIBLE. `/health` publishes this sum across attached mailboxes; it is a count and
    // never a coordinate.
    expect(ledger.escalated).toBe(1);

    // …and the mailbox is entirely healthy throughout: the neighbour is in, the watermark is past
    // both, and no cycle ever failed.
    expect(await rowFor(h, neighbour)).toHaveLength(1);
    expect(Number((await sentCursor(h))!.uidnext)).toBeGreaterThan(owed[0]!.uid);
  }, 90000);
});
