import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, messages as messagesTbl, rules as rulesTbl, contacts as contactsTbl } from "@trafficflow/db";
import { makeDb, closeDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import type { InsertMessageInput } from "../../src/index.js";
import { randomUUID } from "node:crypto";
import { pgTestUrl } from "@trafficflow/db/testing";

const URL = pgTestUrl(import.meta.url);
const ACCT = randomUUID(); // fresh account per run → idempotent against the persistent test DB

describe("DrizzleRepo (RepoPort + WorkerRepo, real Postgres)", () => {
  let db!: ReturnType<typeof makeDb>;
  let mailboxId!: string;

  beforeAll(async () => {
    await runMigrations(URL);
    db = makeDb(URL);
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: ACCT, provider: "imap", address: "mila@lichtgrat.example" }).returning();
    mailboxId = mb.id;
    await db.insert(rulesTbl).values({ accountId: ACCT, kind: "sender", match: "a@b.example", destination: "INBOX", priority: 5 });
    await db.insert(contactsTbl).values({ accountId: ACCT, address: "a@b.example" });
  });
  afterAll(async () => { await closeDb(); });

  it("inserts idempotently, dedups, upserts folder state, updates locator, reads rules/senders/cursors", async () => {
    const repo = makeDrizzleRepo(db);

    const input: InsertMessageInput = { senderCheck: null,
      accountId: ACCT, mailboxId,
      canonical: { messageIdHeader: "abc@x", bodyHash: "bh" },
      dedupKey: "mid:abc@x", subject: "Hi", fromAddress: "a@b.example", date: null,
      nativeLocator: { folder: "INBOX", ref: "10:5" },
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    };

    const inserted = await repo.insertMessage(input);
    expect(inserted.id).toBeTruthy();
    expect(inserted.nativeLocator).toEqual({ folder: "INBOX", ref: "10:5" });

    // idempotent re-insert of the same dedup key returns the same row (no duplicate)
    const again = await repo.insertMessage(input);
    expect(again.id).toBe(inserted.id);

    const found = await repo.findByDedupKey(mailboxId, "mid:abc@x");
    expect(found?.id).toBe(inserted.id);
    expect(found?.nativeLocator).toEqual({ folder: "INBOX", ref: "10:5" });

    await repo.upsertFolderState(inserted.id, { desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });
    await repo.upsertFolderState(inserted.id, { desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });
    const fs = await repo.getFolderState(inserted.id);
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });

    await repo.updateLocator(inserted.id, { folder: "ohmail/News", ref: "20:9" });
    expect((await repo.findByDedupKey(mailboxId, "mid:abc@x"))?.nativeLocator).toEqual({ folder: "ohmail/News", ref: "20:9" });

    expect((await repo.listRules(ACCT)).map((r) => r.match)).toContain("a@b.example");
    expect((await repo.knownSenders(ACCT)).addresses.has("a@b.example")).toBe(true);

    await repo.upsertMailboxFolder(mailboxId, "INBOX", { uidValidity: "10", uidNext: 6, highestModseq: "42" });
    await repo.upsertMailboxFolder(mailboxId, "INBOX", { uidValidity: "10", uidNext: 7, highestModseq: "43" });
    const folders = await repo.getMailboxFolders(mailboxId);
    expect(folders.find((f) => f.folder === "INBOX")).toMatchObject({ uidValidity: "10", uidNext: 7, highestModseq: "43" });

    // THE EPOCH IS PART OF THE ENTRY, and the new consumer is `buildCursor` (apps/worker/src/
    // sync.ts), which filters the known-set by it. Handing the adapter a bare `uid: 9` let a
    // message under a LATER uidvalidity that reused the number 9 be treated as already known, so
    // its body was never fetched — CODEX-X1H finding 2. The locator above is `20:9`, so `"20"` is
    // the only answer that keeps this entry usable.
    const known = await repo.listKnownLocators(mailboxId);
    expect(known).toContainEqual({ folder: "ohmail/News", uid: 9, uidValidity: "20", messageId: "abc@x", seen: false });

    // ── THE SEEN BASELINE FOLLOWS OBSERVATION, NOT DESIRE ────────────────────────────────────
    //
    // `seen` is what the no-CONDSTORE flag fallback diffs the server against (`KnownEntry.seen`),
    // so it must state what the server was last SEEN holding and nothing else. Three sources, in
    // order of authority:
    //  · no flag row → the read state ingest derived from the server's own flags (`!unread`) —
    //    this is every message read in another client before it was ever ingested here;
    const seenOf = async (uid: number) => (await repo.listKnownLocators(mailboxId)).find((k) => k.uid === uid)?.seen;
    await db.update(messagesTbl).set({ unread: false }).where(eq(messagesTbl.id, inserted.id));
    expect(await seenOf(9)).toBe(true);
    await db.update(messagesTbl).set({ unread: true }).where(eq(messagesTbl.id, inserted.id));
    //  · a flag row whose write is still in flight → `observed_seen`, NOT `desired_seen`: a
    //    baseline that read desire would report the user's own pending write back as an external
    //    change the moment the server echoed it;
    await repo.upsertFlagState(inserted.id, { desiredSeen: true, observedSeen: false, lastSetBy: "us" });
    expect(await seenOf(9)).toBe(false);
    //  · a flag row after the reconciler pushed and observed → the observation.
    await repo.upsertFlagState(inserted.id, { desiredSeen: true, observedSeen: true, lastSetBy: "us" });
    expect(await seenOf(9)).toBe(true);

    // folder_state is still pending (desired Feed != observed INBOX) → listed
    const pending = await repo.listPendingFolderStates(mailboxId);
    expect(pending[0]).toMatchObject({ messageId: inserted.id, desiredFolder: "ohmail/News", lastSetBy: "us" });
    expect(pending[0].nativeLocator).toEqual({ folder: "ohmail/News", ref: "20:9" });

    // once desired === observed the derived status flips to reconciled and it drops out of pending
    await repo.upsertFolderState(inserted.id, { desiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us" });
    expect(await repo.listPendingFolderStates(mailboxId)).toHaveLength(0);

    // `audit_log.action` is a closed set. This used to write `test.audit` — a word no writer in
    // the tree uses — and the column took it, which is the hole `auditAction` closes.
    await repo.recordAudit(ACCT, "reconcile.move", { a: 1 }, { b: 2 });
    await expect(repo.recordAudit(ACCT, "test.audit", { a: 1 }, { b: 2 }))
      .rejects.toThrow(/not a member/);
  });
});
