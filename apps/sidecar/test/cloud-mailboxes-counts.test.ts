import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState, messageBodies } from "@trafficflow/db";
import type { ServiceContext } from "@trafficflow/services/mail";
import { matchReadRoute } from "../src/cloud-read.js";

/**
 * ═══ THE IMPORT'S NUMERATOR ON THE CLOUD-MIRROR DOOR ═══════════════════════════════════════
 *
 * The progress sentence asks `GET /mailboxes?counts=1` while an import is open and reads
 * `messageCount` as what this install has pulled. `cloud-read.ts` ignored the query, so the field
 * arrived ABSENT and the numerator fell to the renderer's windowed row count. The denominator is
 * somebody else's — `cloud-engine.ts` decorates `hostedMessageCount` onto these same rows — and
 * the two must stay distinct: one store answering both halves compares the mirror against itself.
 * Driven through `matchReadRoute`, as `cloud-search-sort.test.ts` drives it.
 */

const ACCOUNT = randomUUID();
const NOW = new Date("2026-09-16T12:00:00.000Z");

type Row = { id: string; messageCount?: number; initialImportCompletedAt: string | null };

/** Resolve and invoke the read table's `/mailboxes`, exactly as the stdio host does. */
async function listMailboxes(ctx: ServiceContext, query: string): Promise<Row[]> {
  const url = `http://sidecar/mailboxes${query}`;
  const hit = matchReadRoute("GET", new URL(url).pathname);
  if (!hit) throw new Error("no /mailboxes route in READ_ROUTES");
  const res = await hit.route.handler(new Request(url), ctx, hit.params);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Row[] }).items;
}

const corpus = async (
  held: number,
  empties = 0,
): Promise<{ ctx: ServiceContext; filled: string; empty: string | null }> => {
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId: ACCOUNT, provider: "imap", address: "me@ohmail.test" })
    .returning();
  let empty: string | null = null;
  if (empties > 0) {
    const [other] = await db.insert(mailboxes)
      .values({ accountId: ACCOUNT, provider: "imap", address: "spare@ohmail.test" })
      .returning();
    empty = other!.id;
  }
  for (let i = 0; i < held; i += 1) {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: ACCOUNT, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(),
      dedupKey: dedup, subject: `heron ${i}`, fromAddress: "sender@example.test",
      date: new Date(NOW.getTime() - i * 60_000),
      nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "the heron stood in the shallows" });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  }
  const ctx: ServiceContext = {
    db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "fix-0192-sidecar",
  };
  return { ctx, filled: mb!.id, empty };
};

describe("the Cloud-mirror door answers the import's count", () => {
  it("?counts=1 carries this mirror's own message count", async () => {
    // THE GUARD. Dropping the query — the handler's shape before this lane — leaves the field
    // absent and this reads `undefined`.
    const { ctx, filled } = await corpus(7);
    const items = await listMailboxes(ctx, "?counts=1");
    expect(items.find((m) => m.id === filled)?.messageCount).toBe(7);
  });

  it("an empty mailbox answers 0, not an absence — the count was asked for", async () => {
    // `0` and `undefined` are two different facts on this wire and the strip reads them
    // differently: absent is "nobody asked", zero is "this mailbox holds nothing".
    const { ctx, empty } = await corpus(3, 1);
    const items = await listMailboxes(ctx, "?counts=1");
    expect(items.find((m) => m.id === empty)?.messageCount).toBe(0);
  });

  /**
   * THE DRIVE THAT CLOSES `IMPORT-EPISODE-MAY-NOT-RE-LATCH-AFTER-A-RELAUNCH-MID-IMPORT`.
   *
   * The row's worry is a relaunch part-way through a pull leaving the strip with no latched
   * episode and therefore nothing to say. It cannot happen on this door, and the reason is a
   * piece of DATA rather than a rule about time: `cloud-mirror.ts`'s `mailboxRow` deliberately
   * does not copy the hosted `initialImportCompletedAt`, and `sync-stamp.ts` writes this mirror's
   * OWN stamp once, when a pass drains with no backlog. So mid-replay the field is null, which is
   * what the shell's import floor and its counts gate both read — neither needs the episode.
   */
  it("mid-replay the mirror's own import stamp is null — the floor's evidence, not the episode's",
    async () => {
      const { ctx, filled } = await corpus(7);
      const items = await listMailboxes(ctx, "?counts=1");
      const row = items.find((m) => m.id === filled);
      expect(row?.initialImportCompletedAt).toBeNull();
      // And the two halves travel together: a floor with no numerator beside it is the defect
      // this lane's other half fixes.
      expect(row?.messageCount).toBe(7);
    });

  it("the ordinary poll pays no aggregate — absent, never 0", async () => {
    const { ctx, filled } = await corpus(7);
    for (const q of ["", "?counts=0", "?counts=false", "?counts=true"]) {
      const items = await listMailboxes(ctx, q);
      // `=== "1"` exactly, as the hosted route spells it: every other spelling is OFF, so a
      // caller reaching for `?counts=0` cannot turn the `count(*)` on by accident.
      expect(items.find((m) => m.id === filled)?.messageCount, `query ${q || "(none)"}`)
        .toBeUndefined();
    }
  });
});
