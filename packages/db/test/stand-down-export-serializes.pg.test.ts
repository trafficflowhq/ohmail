import { accountOfMessage } from "../src/parent-account.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts, folderState, mailboxes, messages, organizerRequests, threads,
  exportPendingMovesOnStandDown, assertOrganizerRole, type Tx,
} from "../src/index.js";
import { schema } from "../src/cloud.js";
import { runMigrations } from "../src/admin.js";
import { pgTestUrl } from "../src/testing.js";
import { brandDialect, dialect } from "../src/dialect/index.js";

/**
 * ═══ THE HANDOVER CANNOT MISS AN INTENT THAT WAS ADMITTED ═══════════════════════════════════
 *
 * ── THE SEQUENCE, WHICH IS THE WHOLE REASON THIS FILE IS ON REAL POSTGRES ───────────────────
 *
 * Another install takes the mailbox. Until this host's next lease poll its `organizer_role` still
 * reads `organizer`, so a paired device's forwarded move passes the role check and is recorded as
 * a local `folder_state` intent. The stand-down then hands the pending intents over and demotes
 * the row — and a move that COMMITS BETWEEN the handover's read and the demotion is neither
 * exported nor performable: the near side shows a move that never reaches the mail server.
 *
 * The closing mechanism is two row locks that already existed on one side. `assertOrganizerRole`
 * takes `FOR SHARE` on the mailbox row inside the transaction that records the move;
 * `exportPendingMovesOnStandDown` now takes `FOR UPDATE` on that row as its FIRST statement, and
 * the demotion rides the same transaction. So the handover waits for a move in flight and sees
 * it, and a move arriving afterwards waits for the demotion and is refused.
 *
 * **That is a claim about two concurrent transactions, and PGlite cannot make it.** It is one
 * backend with one connection: the second transaction never runs while the first is open, so both
 * arms of this file pass there whether the lock is present or not — the exact class CLAUDE.md
 * names ("PGlite green means nothing for transactional code"). Two real connections are the test.
 *
 * Mutation-checked, watched red and restored: `.for("update")` removed from the handover's mailbox
 * read → `expected { exported: 0 } to deeply equal { exported: 1 }`. The WAIT is unchanged by that
 * mutation (the demotion's own `UPDATE` blocks on the same row), which is why the count and not
 * the wait is the assertion that discriminates — see the comment at the wait.
 */

const URL = pgTestUrl(import.meta.url);
/* THREE, not two: the blocked handover holds one for the length of the wait, the in-flight move
   holds a second, and the assertions read through a third. With `max: 2` the reader would queue
   behind the very transaction it is asking about, which reads as a hang rather than a verdict. */
const client = postgres(URL, { max: 3 });
/* BRANDED, like every other Postgres fixture here: `assertOrganizerRole` asks the handle which
   store it is on, and an unbranded one has no answer. */
const db = brandDialect(drizzle(client, { schema }), "pg");
const tx = db as unknown as Tx;

beforeAll(async () => { await runMigrations(URL); });
afterAll(async () => { await client.end({ timeout: 5 }); });

interface World { accountId: string; mailboxId: string; messageId: string; dedupKey: string }

async function world(): Promise<World> {
  const accountId = randomUUID();
  await tx.insert(accounts).values({ id: accountId, name: "stand-down-lock" });
  const [mb] = await tx.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@example.invalid`,
    organizerRole: "organizer",
  }).returning({ id: mailboxes.id });
  const [th] = await tx.insert(threads).values({ accountId, subject: "s" })
    .returning({ id: threads.id });
  const dedupKey = randomUUID().replace(/-/g, "");
  const [msg] = await tx.insert(messages).values({
    accountId, mailboxId: mb!.id, threadId: th!.id, dedupKey,
    messageIdHeader: `<${dedupKey}@example.invalid>`, bodyHash: randomUUID(),
    nativeLocator: { folder: "ohmail/Screener", uidvalidity: "1", uid: 4 },
  }).returning({ id: messages.id });
  return { accountId, mailboxId: mb!.id, messageId: msg!.id, dedupKey };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe("the stand-down handover serializes against a forwarded move in flight", () => {
  it("blocks until the in-flight move commits, and then exports it", async () => {
    const w = await world();

    /* THE MOVE, HELD OPEN. This is the forwarded-move door's own shape: `assertOrganizerRole`
       inside the writing transaction (which is where its `FOR SHARE` becomes a lock that lives
       until COMMIT), then the `folder_state` write, then the commit. Held open here so the
       handover below has something to wait for. */
    let releaseMove = (): void => undefined;
    const moveHeld = new Promise<void>((resolve) => { releaseMove = resolve; });
    let moveCommitted = false;
    const move = db.transaction(async (mtx) => {
      await assertOrganizerRole(mtx as unknown as Tx, dialect(db), w.accountId, w.mailboxId);
      await mtx.insert(folderState).values({
        messageId: w.messageId, accountId: accountOfMessage(w.messageId), desiredFolder: "ohmail/News", observedFolder: "ohmail/Screener",
        lastSetBy: "us", reconcileStatus: "pending", conflict: false,
      });
      await moveHeld;
    }).then(() => { moveCommitted = true; });

    // The share lock is taken by now; nothing has committed.
    await sleep(150);
    expect(moveCommitted, "the move is deliberately still open").toBe(false);

    let handedOver = false;
    const handover = db.transaction(async (stx) => {
      const r = await exportPendingMovesOnStandDown(stx as unknown as Tx, {
        accountId: w.accountId, mailboxId: w.mailboxId, now: new Date("2026-09-10T10:00:00.000Z"),
        mintId: () => randomUUID(),
      });
      // THE DEMOTION, IN THE SAME TRANSACTION — what both callers do, and what makes the pair
      // atomic. Its own `UPDATE` needs the exclusive lock the read above already holds.
      await stx.update(mailboxes).set({ organizerRole: "reader" })
        .where(eq(mailboxes.id, w.mailboxId));
      return r;
    }).then((r) => { handedOver = true; return r; });

    /* IT IS STILL WAITING — AND THIS IS NOT THE DISCRIMINATOR, WHICH IS WORTH SAYING.
       Measured under the mutation: with the `FOR UPDATE` removed the handover STILL waits here,
       because the demotion's own `UPDATE` needs the exclusive lock the in-flight move's
       `FOR SHARE` is holding. So this line is satisfied by either lock and measures the pair
       rather than the part; it is kept because a handover that did NOT wait at all would mean
       neither lock was taken. The property under test is the `exported: 1` below, which is
       `exported: 0` the moment the read stops taking the lock. */
    await sleep(300);
    expect(handedOver, "neither lock was taken — nothing waited for the move at all").toBe(false);

    releaseMove();
    await move;
    const r = await handover;
    expect(r).toEqual({ exported: 1, already: 0, unmappable: 0 });

    const rows = await tx.select().from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, w.mailboxId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ dedupKey: w.dedupKey, destination: "reads" });
  });

  it("a move arriving AFTER the demotion is refused rather than recorded", async () => {
    /* THE OTHER HALF, and it is what makes "exported or refused" a pair rather than one arm.
       A door that arrived a moment later blocks on the exclusive lock, then re-reads the role the
       committed transaction demoted — and refuses. Nothing is admitted after the handover, so
       there is nothing left for a second handover to find. */
    const w = await world();

    await db.transaction(async (stx) => {
      await exportPendingMovesOnStandDown(stx as unknown as Tx, {
        accountId: w.accountId, mailboxId: w.mailboxId, now: new Date("2026-09-10T10:00:00.000Z"),
        mintId: () => randomUUID(),
      });
      await stx.update(mailboxes).set({ organizerRole: "reader" })
        .where(eq(mailboxes.id, w.mailboxId));
    });

    /* THE NAME, READ OFF THE CAUGHT VALUE. `toThrow(<string>)` matches the MESSAGE, and this
       error's message is a sentence for a person; asserting a one-word verdict here also keeps a
       failure from pretty-printing a live connection handle, which is how a `.rejects` assertion
       takes the worker down with it. */
    const refusal = await db.transaction(async (mtx) => {
      await assertOrganizerRole(mtx as unknown as Tx, dialect(db), w.accountId, w.mailboxId);
      await mtx.insert(folderState).values({
        messageId: w.messageId, accountId: accountOfMessage(w.messageId), desiredFolder: "ohmail/News", observedFolder: "ohmail/Screener",
        lastSetBy: "us", reconcileStatus: "pending", conflict: false,
      });
      return "admitted";
    }).catch((err: unknown) => (err instanceof Error ? err.name : "not-an-error"));
    expect(refusal).toBe("OrganizedElsewhereError");

    expect(await tx.select().from(folderState).where(eq(folderState.messageId, w.messageId)))
      .toHaveLength(0);
  });
});
