import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, mailboxFolders, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { MAX_RAW_MESSAGE_BYTES, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ImapCursor, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { DeadLetterLedger } from "../src/dead-letter.js";
import { makeHarness, rawClient, emlOf, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A POISON MESSAGE IN THE MIDDLE OF A BATCH — a critical review finding
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The suite already had a parse-failure test and a batch-ingest test. Neither COMPOSED them, which
 * is exactly why the Critical survived thousands of tests: the wedge is not in the parser and not in the
 * batch, it is in what the loop does when one member of a batch throws. Before that change the `for` loop
 * exited, no folder cursor advanced, nothing recorded that the message had failed and nothing
 * declared it consumed — so the next cycle selected the same message, threw again, and **every
 * message behind it was never processed.**
 *
 * The poison is REAL, not a stub: the adapter hands back a body over `MAX_RAW_MESSAGE_BYTES`, so
 * `normalizeMime` inside the real `planChange` raises the real `MimeTooLargeError`. That is one of
 * the three poison classes fixed on 2026-08-03 — the point of this file is that the NEXT one costs
 * a logged skip instead of a mailbox-wide outage.
 *
 * Real Postgres, because the claim is about what commits: PGlite has been blind to three
 * production bugs in this repo.
 */

const OVERSIZE = Buffer.alloc(MAX_RAW_MESSAGE_BYTES + 1);

/** Hand `changesSince` back unchanged, except that ONE message's body is unparseable. */
function poisonBody(inner: MailboxAdapter, victimMid: string, seen: { offered: number }): MailboxAdapter {
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
              return { ...ch, raw: OVERSIZE };
            }),
          };
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/**
 * Throw a chosen error out of `planChange`'s identity lookup, for ONE message only.
 *
 * `victimKey` is the LEGACY `mid:` key, and it still names the victim after that change slice 2 because
 * `planChange` performs a DUAL-KEY lookup: `fp1:<fingerprint>` first, then `mid:`/`body:` for the
 * pre-slice population. A brand-new message misses the first and reaches the second, so the fault
 * fires exactly once per attempt — which is what `seen.hits` counts.
 *
 * The `fp1:` key deliberately is NOT used here even though it is the one production writes: it is a
 * sha256 over every field a sender chooses, so naming it in a test would mean either hardcoding a
 * hash (stale the moment any input changes) or re-deriving the pipeline's own computation, and
 * neither says "this message, and only this message" as plainly as its Message-ID does.
 */
function faultOn(inner: WorkerRepo, victimKey: string, makeErr: () => unknown, seen: { hits: number }): WorkerRepo {
  return new Proxy(inner, {
    get(t, prop, recv) {
      if (prop === "findByDedupKey") {
        return async (mailboxId: string, key: string) => {
          if (key === victimKey) { seen.hits++; throw makeErr(); }
          return (t as WorkerRepo).findByDedupKey(mailboxId, key);
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as WorkerRepo;
}

describe("one poison message in the middle of a batch (GreenMail + Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  /** Three messages from a KNOWN contact, so nothing is moved and every UID stays in INBOX. */
  async function seedThree(cfg: ReturnType<typeof import("./_workerenv.js").imapCfg>): Promise<void> {
    const c = await rawClient(cfg);
    for (const mid of ["a1@x.example", "p1@x.example", "b1@x.example"]) {
      await c.append("INBOX", emlOf({ from: "anna@x.example", subject: mid, messageId: mid }));
    }
    await c.logout();
  }

  const midsIn = async (h: { db: unknown; mailboxId: string }): Promise<string[]> => {
    const db = h.db as import("@trafficflow/db").Db;
    const rows = await db.select({ mid: messages.messageIdHeader })
      .from(messages).where(eq(messages.mailboxId, h.mailboxId));
    return rows.map((r) => r.mid ?? "").sort();
  };

  const inboxCursor = async (h: { db: unknown; mailboxId: string }) => {
    const db = h.db as import("@trafficflow/db").Db;
    const [row] = await db.select().from(mailboxFolders)
      .where(and(eq(mailboxFolders.mailboxId, h.mailboxId), eq(mailboxFolders.folder, "INBOX")));
    return row;
  };

  it("commits the messages either side of it, records it, and crosses the cursor", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await seedThree(h.cfg);

    const seen = { offered: 0 };
    const deadLetters = new DeadLetterLedger();
    const deps = {
      repo: h.repo, adapter: poisonBody(h.adapter, "p1@x.example", seen),
      accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE, deadLetters,
    };

    // ONE cycle. Before that change this resolved with only the messages BEFORE the poison committed and
    // no cursor at all; the mailbox then re-read the same batch for ever.
    await expect(runSyncCycle(deps)).resolves.toEqual({ hasBacklog: false, owesFiling: false });

    // BOTH neighbours ingested — the assertion the wedge failed. Order-independent on purpose:
    // the adapter enumerates newest-first, so "the one after the poison" is not a fixed message.
    expect(await midsIn(h)).toEqual(["a1@x.example", "b1@x.example"]);

    // The poison is recorded, terminally, keyed by folder + epoch + UID and carrying a closed-set
    // code. Nothing in the record is content.
    const failed = deadLetters.entries();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ folder: "INBOX", code: "mime_too_large", terminal: true, attempts: 1 });
    expect(failed[0]!.uid).toBeGreaterThan(0);
    expect(failed[0]!.uidValidity).not.toBe("0");
    expect(deadLetters.skipped).toBe(1);

    // THE CURSOR CROSSED IT. `uidnext` is the server's next UID, so it is past all three.
    const cursor = await inboxCursor(h);
    expect(cursor).toBeTruthy();
    expect(Number(cursor!.uidnext)).toBeGreaterThan(failed[0]!.uid);
    expect(String(cursor!.uidvalidity)).toBe(failed[0]!.uidValidity);

    // Durable, content-free evidence.
    const audits = await h.db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, h.accountId), eq(auditLog.action, "sync.message_skipped")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ folder: "INBOX", uid: failed[0]!.uid, code: "mime_too_large" });
    expect(JSON.stringify(audits[0]!.payload)).not.toContain("p1@x.example");

    // A SECOND CYCLE MUST NOT RE-FETCH IT. The skipped UID joined the known-set, so the adapter
    // never asks for the body again — without that, a poison message costs one full body fetch per
    // cycle for ever, and at the batch cap it sets `hasBacklog` and the worker re-kicks in a loop.
    const offeredAfterFirst = seen.offered;
    expect(offeredAfterFirst).toBe(1);
    await expect(runSyncCycle(deps)).resolves.toEqual({ hasBacklog: false, owesFiling: false });
    expect(seen.offered).toBe(offeredAfterFirst);
    expect(await midsIn(h)).toEqual(["a1@x.example", "b1@x.example"]);
  }, 40000);

  it("a restart does not re-fetch it, and does not re-wedge", async () => {
    // ── THIS ASSERTION WAS INVERTED BY mail 0041, AND THE OLD FORM IS WORTH RECORDING ────────
    //
    // It used to read `expect(seen.offered).toBe(2)` under the comment "A fresh ledger IS a restart:
    // the record is process-local by design (the durable table is owed), so the UID leaves the
    // known-set and is offered once more." Both halves were true and the design they described was a
    // mail-loss defect: for the SENT folder, whose cursor is a UID watermark, "offered once more"
    // was false and nothing else could ever notice
    // (`apps/worker/test/sent-loss.pg.test.ts`).
    //
    // The durable table landed, `runSyncCycle` hydrates the ledger from it, and the UID now stays in
    // the known-set across a restart — so its body is NOT pulled again, in this folder or any other.
    // Recovery is the targeted retry, not an accidental re-offer.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await seedThree(h.cfg);

    const seen = { offered: 0 };
    const adapter = poisonBody(h.adapter, "p1@x.example", seen);
    const base = {
      repo: h.repo, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      // Pinned, so the version arm of the retry's due predicate cannot fire and this test measures
      // the RESTART and nothing else.
      buildVersion: "same-build",
    };

    await runSyncCycle({ ...base, deadLetters: new DeadLetterLedger() });
    const afterRestart = new DeadLetterLedger();
    await expect(runSyncCycle({ ...base, deadLetters: afterRestart })).resolves.toBeTruthy();
    expect(seen.offered, "the main batch must not re-fetch a written-off body after a restart").toBe(1);
    // The record SURVIVED the restart — which is the property the old assertion's absence was hiding.
    expect(afterRestart.skipped).toBe(1);
    expect(afterRestart.entries()[0]).toMatchObject({ code: "mime_too_large", terminal: true });
    expect(await midsIn(h)).toEqual(["a1@x.example", "b1@x.example"]);
    // …and the cursor is still past it, so a restart is not a re-wedge.
    expect(Number((await inboxCursor(h))!.uidnext)).toBeGreaterThan(afterRestart.entries()[0]!.uid);
  }, 40000);

  it("an UNCLASSIFIED failure defers first: the batch continues, the cursor does not", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await seedThree(h.cfg);

    const hit = { hits: 0 };
    const deadLetters = new DeadLetterLedger();
    const deps = {
      repo: faultOn(h.repo, "mid:p1@x.example", () => new Error("synthetic ingest defect"), hit),
      adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE, deadLetters,
    };

    // Cycle 1: the neighbours commit (the wedge is gone) but the failure is NOT written off, so
    // INBOX's cursor is withheld and the cycle still FAILS — the mailbox's existing failure
    // counting and quarantine cadence are untouched.
    await expect(runSyncCycle(deps)).rejects.toThrow("synthetic ingest defect");
    expect(await midsIn(h)).toEqual(["a1@x.example", "b1@x.example"]);
    expect(await inboxCursor(h)).toBeUndefined();
    expect(deadLetters.entries()[0]).toMatchObject({ code: "unclassified", attempts: 1, terminal: false });

    // Cycle 2: the second attempt exhausts the budget, the item is written off, and the mailbox is
    // unblocked — a bounded delay instead of an indefinite outage.
    await expect(runSyncCycle(deps)).resolves.toBeTruthy();
    expect(hit.hits).toBe(2);
    expect(deadLetters.entries()[0]).toMatchObject({ attempts: 2, terminal: true });
    expect(Number((await inboxCursor(h))!.uidnext)).toBeGreaterThan(0);
  }, 40000);

  it("a DATABASE fault is never written off — it fails the cycle and holds the cursor", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await seedThree(h.cfg);

    const hit = { hits: 0 };
    const deadLetters = new DeadLetterLedger();
    const diskFull = () => Object.assign(new Error("could not extend file: No space left"), { code: "53100" });
    const deps = {
      repo: faultOn(h.repo, "mid:p1@x.example", diskFull, hit),
      adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE, deadLetters,
    };

    // Three cycles. A shared-storage incident must NEVER exhaust a per-message attempt budget:
    // that is how "the database was full for two minutes" becomes "these messages were discarded".
    for (let i = 0; i < 3; i++) await expect(runSyncCycle(deps)).rejects.toThrow("No space left");
    expect(deadLetters.entries()).toHaveLength(0);
    expect(deadLetters.skipped).toBe(0);
    expect(await inboxCursor(h)).toBeUndefined();
    expect(hit.hits).toBe(3);
  }, 40000);
});
