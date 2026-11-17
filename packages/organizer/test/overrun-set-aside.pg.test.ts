import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messageFailures, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { ImapBoundExceeded, type ChangeBatch, type ImapCursor, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { DeadLetterLedger } from "../src/dead-letter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A CLOUD MAILBOX WITH ONE MESSAGE PAST A READ BOUND KEEPS SYNCING THE REST. The per-message
 * `body_overrun` is thrown out of `changesSince` before any `Change` exists, so the ingest boundary
 * never saw it, no row was written, and every re-attach fetched the same UID and breached again.
 * The pass stops at the breach and returns it; the cycle writes the set-aside row, commits, and
 * rethrows, and the next attachment's pass leaves that UID out. Real Postgres: the row is a CHECK-constrained code.
 */
const URL = pgTestUrl(import.meta.url);
const AVAILABLE = await realPgAvailable(URL);

const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}-${randomUUID()}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));

/** One attachment of the hosted worker: uid 1 breaches on every connection that asks for it. */
function attachment(counts: { overrunFetches: number }, named: boolean): MailboxAdapter {
  return {
    async changesSince(c: ImapCursor): Promise<ChangeBatch> {
      const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
      // The adapter's contract: a set-aside row at the live epoch is never fetched again.
      const aside = (c.setAside ?? []).some((a) => a.folder === "INBOX" && a.uidValidity === "4200" && a.uid === 1);
      if (!aside) {
        counts.overrunFetches++;
        const breach = new ImapBoundExceeded(
          "body_overrun", 1_048_576, 1_600_000, "INBOX", named ? { uidValidity: "4200", uid: 1 } : undefined,
        );
        // A breach naming its message stops the pass and returns; one naming none throws.
        if (!named) throw breach;
        return {
          creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: true,
          overrun: { folder: "INBOX", uidValidity: "4200", uid: 1, breach },
        } as unknown as ChangeBatch;
      }
      const creates = [2, 3].filter((u) => !known.has(u)).map((u) => ({
        type: "create" as const, locator: { folder: "INBOX", ref: `4200:${u}` }, seen: false, raw: eml(`ordinary-${u}`),
      }));
      return {
        creates, moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: { INBOX: { uidValidity: "4200", uidNext: 4, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
  } as unknown as MailboxAdapter;
}

describe.skipIf(!AVAILABLE)("a hosted mailbox with one message past a read bound (real Postgres)", () => {
  const sql = postgres(URL, { max: 3 });
  const db = brandDialect(drizzle(sql, { schema }), "pg");
  const repo = makeDrizzleRepo(db);
  beforeAll(async () => { await runMigrations(URL); }, 60_000);
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function seed(): Promise<{ accountId: string; mailboxId: string }> {
    const [acct] = await db.insert(accounts).values({ name: "overrun-pg" }).returning();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `ov-${randomUUID().slice(0, 8)}@tf.example` }).returning();
    return { accountId: acct!.id, mailboxId: mb!.id };
  }

  /** Three attachments in a row, as the worker re-attaches after a failed cycle. */
  async function threeCycles(named: boolean) {
    const ids = await seed();
    const counts = { overrunFetches: 0 };
    const deadLetters = new DeadLetterLedger();
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(await runSyncCycle({
        repo, adapter: attachment(counts, named), ...ids, storageCap: UNMETERED_STORAGE_CAP,
        writeAuthority: FIXTURE_LEASE, deadLetters, buildVersion: "build-one",
        role: "organizer", trustedAuthservIds: new Set<string>(),
      }).then(() => "served", (e: unknown) => (e instanceof ImapBoundExceeded ? "breach" : `threw:${String(e)}`)));
    }
    const failures = await db.select().from(messageFailures).where(eq(messageFailures.mailboxId, ids.mailboxId));
    const stored = await db.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, ids.mailboxId));
    return { counts, outcomes, failures, subjects: stored.map((r) => r.subject).sort() };
  }

  it("sets the message aside once on the first breach and syncs the rest", async () => {
    const r = await threeCycles(true);
    expect(r.outcomes).toEqual(["breach", "served", "served"]);
    expect(r.counts.overrunFetches, "a later attachment fetched the breaching message again").toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ folder: "INBOX", uid: 1, code: "mime_too_large", resolvedAt: null });
    expect(r.subjects).toEqual(["ordinary-2", "ordinary-3"]);
  });

  it("an overrun report carrying any other bound is not set aside: the door checks body_overrun", async () => {
    const ids = await seed();
    const breach = new ImapBoundExceeded("read_bytes", 10, 20, "INBOX", { uidValidity: "4200", uid: 1 });
    const adapter = {
      async changesSince(): Promise<ChangeBatch> {
        return {
          creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
          overrun: { folder: "INBOX", uidValidity: "4200", uid: 1, breach },
        } as unknown as ChangeBatch;
      },
    } as unknown as MailboxAdapter;
    const outcome = await runSyncCycle({
      repo, adapter, ...ids, storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE, deadLetters: new DeadLetterLedger(), buildVersion: "build-one",
        role: "organizer", trustedAuthservIds: new Set<string>(),
    }).then(() => "served", (e: unknown) => (e === breach ? "rethrown" : `threw:${String(e)}`));
    const failures = await db.select().from(messageFailures).where(eq(messageFailures.mailboxId, ids.mailboxId));
    expect(outcome).toBe("rethrown");
    expect(failures).toHaveLength(0);
  });

  it("CONTROL: a breach that names no message sets nothing aside, and every attachment breaches", async () => {
    const r = await threeCycles(false);
    expect(r.outcomes).toEqual(["breach", "breach", "breach"]);
    expect(r.failures).toHaveLength(0);
    expect(r.subjects).toEqual([]);
  });
});
