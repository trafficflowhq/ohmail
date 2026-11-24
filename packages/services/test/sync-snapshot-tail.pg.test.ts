import type { SnapshotResponse } from "@ohmail/wire";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import {
  approvals, drafts, mailboxes, messages, messageStates, messageTags, routingDecisions, tags,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { SNAPSHOT_FIRST_PAGE_MESSAGES, SNAPSHOT_WINDOW, syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * TAGGED MAIL BELOW THE SNAPSHOT WINDOW STILL REACHES THE MIRROR.
 *
 * A tag is cross-cutting and people tag OLD mail. The bootstrap snapshot is windowed
 * ({@link SNAPSHOT_WINDOW} = 90d/5000), so on a large mailbox a tagged message older than the
 * window fell off the end of the windowed walk — and the delta could never recover it, because its
 * `message_tags` change sits below the cursor the client adopts after bootstrap. The tag rail
 * showed the tag; opening the tag showed nothing. The fix is the LABELED TAIL: once the window is
 * satisfied the drain keeps paging, restricted to messages that own a `message_tags` row.
 *
 * ── AND THE SECOND ADMISSION KEY: A PARK ─────────────────────────────────────────────────────
 *
 * A PARKED message below the window is unreachable the same way and costs more: "comes back on
 * Friday" is a promise, and its `message_states` change also sits below the post-bootstrap cursor.
 * The client held the record without the mail and titled a pile entry with a raw identifier; from
 * the other side it held the mail carrying the fact on its own row and stood it in the main list
 * wearing its "Back <day>" chip. So the tail admits a message owning a `message_states` row other
 * than `none` as well. The WINDOW is unchanged — `SNAPSHOT_WINDOW` still reads 90d/5000 — and the
 * tail stays bounded by tagged-plus-parked mail rather than by the size of the mailbox.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST ─────────────────────────────────────────────────────────
 *
 * The window only CLOSES after `minRows` (5000) messages have been emitted, so nothing below it
 * exists to drop until the mailbox is genuinely large. Standing up 5000+ rows and paging them is a
 * real-Postgres exercise; PGlite would be too slow to be worth running in the suite, and the bug
 * is not about a race — it is about volume — so a small-fixture version could not exhibit it.
 *
 * ── MUTATION-WATCHED ─────────────────────────────────────────────────────────────────────────
 *
 * Replacing the tail transition in `sync-service.ts#getSnapshot` (`keysetOf("tail")` → `null`, the
 * pre-fix behaviour) turns every assertion below red: 0 of the labeled messages arrive and the
 * drain stops at 5000. The park arm is watched on its own two deciding lines: `false` ANDed into
 * its EXISTS drops all 40 parked messages, and widening `ne(state, "none")` leaks all 25 released
 * rows into the tail. Convergence-under-replay is not re-proven here — tail pages are
 * `op:"create"` at `seq = asOfSeq` like every other page, so the client's older-or-equal seq guard
 * makes replay a no-op, which the apply-harness tests already pin.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;

// Comfortably past the 90-day recency floor: the whole mailbox is "old", so the window closes on
// the VOLUME floor alone and the boundary is deterministic — exactly `minRows` messages emitted.
const OLDEST_ANCHOR = NOW.getTime() - 100 * DAY;

const FILLER = 5000;          // windowed: emitted by the volume floor, positions 1..5000
const LABELED = 1200;         // the tail: tagged mail below the window (spans >1 page at limit 1000)
const PARKED = 40;            // the tail's second key: parked mail below the window, untagged
const RELEASED = 25;          // below the window with a `none` row — the resting state, never admitted
const UNLABELED_BELOW = 800;  // below the window, untagged and unparked — must never be read by the tail
const LIMIT = 1000;

/**
 * WHERE THE WINDOW'S VOLUME FLOOR IS ACTUALLY MET — at a PAGE BOUNDARY, never mid-page.
 *
 * The walk keeps taking pages while `emitted < minRows`, so the window ends on the first boundary
 * at or past the floor and overshoots by whatever the page in flight carried. Page 1 is a viewport
 * ({@link SNAPSHOT_FIRST_PAGE_MESSAGES}) and every later page is the caller's limit, so the
 * boundaries are 50, 1050, 2050 … and the floor of 5000 is crossed at 5050. This used to be exactly
 * 5000 because the fixture's FILLER and LIMIT divided evenly, which made the overshoot invisible
 * and let these cases assert geometry as though it were the claim.
 */
function windowEmitted(limit: number): number {
  let emitted = Math.min(SNAPSHOT_FIRST_PAGE_MESSAGES, limit);
  while (emitted < SNAPSHOT_WINDOW.minRows) emitted += limit;
  return emitted;
}

/** Comfortably past the 90-day window from NOW: a park's horizon does not have to be inside it. */
const BACK_ON = new Date(NOW.getTime() + 200 * DAY);

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "f3-tail",
});

const idsOf = (r: SnapshotResponse): string[] =>
  r.changes.filter((c) => c.type === "message").map((c) => c.id);

/** Drain the whole snapshot; return every message id in delivery order plus the cursors seen. */
async function drainMessages(accountId: string): Promise<{ ids: string[]; cursors: string[] }> {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; ; guard += 1) {
    const page = await syncService.getSnapshot(ctx(accountId), {
      limit: LIMIT, ...(cursor ? { cursor } : {}),
    });
    ids.push(...idsOf(page));
    if (page.nextCursor === null) return { ids, cursors };
    cursor = page.nextCursor;
    cursors.push(cursor);
    if (guard > 100) throw new Error("snapshot drain did not terminate");
  }
}

/** Bulk-insert `n` messages at strictly descending dates from `startOffset`, return their ids
 *  NEWEST-FIRST. No folder_state: the DTO falls back to the native locator, and this test asserts
 *  on ids, not folders. */
async function insertMessages(
  accountId: string, mailboxId: string, n: number, startOffset: number, tag: string,
): Promise<string[]> {
  const ids: string[] = [];
  const BATCH = 1000;
  for (let base = 0; base < n; base += BATCH) {
    const rows = [];
    for (let i = base; i < Math.min(base + BATCH, n); i += 1) {
      rows.push({
        id: randomUUID(),
        accountId, mailboxId, bodyHash: "h", dedupKey: `f3:${tag}:${String(i)}`,
        subject: `${tag}-${String(i)}`, fromAddress: "anna@x.example",
        // Strictly descending: index 0 is the newest of this block.
        date: new Date(OLDEST_ANCHOR - (startOffset + i) * 1000),
      });
    }
    await db.insert(messages).values(rows);
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

describe.skipIf(!PG_UP)("the snapshot's tail: tagged and parked mail below the window (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 6 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("delivers every tagged and every parked message below the window, and nothing else past it", async () => {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `f3-${accountId}@tf.example`,
    }).returning();
    const mailboxId = mb!.id;

    // Newest → oldest: FILLER (windowed) · LABELED and PARKED (the tail's two keys) · RELEASED
    // (a `none` row) · UNLABELED_BELOW (below, and neither tagged nor parked).
    const filler = await insertMessages(accountId, mailboxId, FILLER, 0, "fill");
    const labeled = await insertMessages(accountId, mailboxId, LABELED, FILLER, "tag");
    const parked = await insertMessages(accountId, mailboxId, PARKED, FILLER + LABELED, "park");
    const released = await insertMessages(
      accountId, mailboxId, RELEASED, FILLER + LABELED + PARKED, "free",
    );
    const belowUntagged = await insertMessages(
      accountId, mailboxId, UNLABELED_BELOW, FILLER + LABELED + PARKED + RELEASED, "cold",
    );

    // Parked with a horizon BEYOND the window — the case the second key exists for. Untagged, so
    // nothing but the park can admit them.
    await db.insert(messageStates).values(parked.map((messageId) => ({
      accountId, messageId, state: "bubbled_up" as const, bubbleUpAt: BACK_ON,
      setAt: NOW, updatedAt: NOW,
    })));
    // Released mail keeps its row at the resting state. `none` must not admit, or the tail would
    // re-deliver every message anybody has ever parked and released.
    await db.insert(messageStates).values(released.map((messageId) => ({
      accountId, messageId, state: "none" as const, setAt: NOW, updatedAt: NOW,
    })));

    const [tagRow] = await db.insert(tags).values({
      accountId, name: "Invoices", hue: "moss",
    }).returning();
    for (let base = 0; base < labeled.length; base += 1000) {
      await db.insert(messageTags).values(
        labeled.slice(base, base + 1000).map((messageId) => ({
          accountId, messageId, tagId: tagRow!.id,
        })),
      );
    }

    const { ids, cursors } = await drainMessages(accountId);

    // No message is delivered twice across the window→tail boundary.
    expect(new Set(ids).size, "a message was delivered more than once").toBe(ids.length);

    const delivered = new Set(ids);
    // 1. THE BUG: every tagged message below the window arrives. Red pre-fix — the drain stopped
    //    at the window and delivered none of them.
    const missingLabeled = labeled.filter((id) => !delivered.has(id));
    expect(missingLabeled, `${missingLabeled.length} tagged message(s) below the window were dropped`)
      .toEqual([]);
    // 2. THE CAP: the tail is bounded by tagged-mail count, not mailbox size. An untagged row below
    //    the window is never read.
    const leaked = belowUntagged.filter((id) => delivered.has(id));
    expect(leaked, `${leaked.length} untagged below-window row(s) leaked into the tail`).toEqual([]);
    // 3. THE SECOND KEY: every parked message below the window arrives, on the park alone —
    //    none of these carries a tag, and every horizon is past the window.
    const missingParked = parked.filter((id) => !delivered.has(id));
    expect(missingParked, `${missingParked.length} parked message(s) below the window were dropped`)
      .toEqual([]);
    // 4. AND `none` DOES NOT ADMIT: a released row is history like any other below-window mail.
    const releasedLeak = released.filter((id) => delivered.has(id));
    expect(releasedLeak, `${releasedLeak.length} released below-window row(s) leaked into the tail`)
      .toEqual([]);
    // 5. And the windowed portion is intact: exactly the 5000 filler, nothing more, nothing less.
    expect(filler.every((id) => delivered.has(id)), "a windowed message went missing").toBe(true);
    expect(ids.length, "delivered = window + tail, not the whole mailbox")
      .toBe(FILLER + LABELED + PARKED);

    // 4. THE TAIL PAGES BY KEYSET. It opened (a cursor carries phase "tail"), the labeled block
    //    spanning >1 page at this limit proves the continuation walks rather than re-reading, and
    //    the labeled ids arrive newest-first — the same (date desc, id desc) order as the window.
    const tailCursors = cursors.filter((c) => svcDecodePhase(c) === "tail");
    expect(tailCursors.length, "the labeled tail never opened").toBeGreaterThanOrEqual(1);
    expect(LABELED, "test misconfigured: the tail must exceed one page to prove it walks")
      .toBeGreaterThan(LIMIT);
    const deliveredLabeled = ids.filter((id) => new Set(labeled).has(id));
    expect(deliveredLabeled, "the tail did not deliver the tagged mail newest-first").toEqual(labeled);
  }, 180_000);

  /**
   * THE SECOND THING THE TAIL HAS TO CARRY — a pending approval or routing decision below the
   * window.
   *
   * Keying a message's children to its parent's page closed a real hole (the client was handed
   * actionable state for messages it never received) and opened this one: a pending row whose
   * message the window excludes was delivered to NOBODY, and the cursor moved past its change for
   * ever. Settled rows are deliberately NOT carried — an approved approval below the window is
   * history — so both states are driven here; a rule whose contrary state is unreachable is a rule
   * nobody can watch fail.
   */
  it("carries a below-window message with a PENDING child, and leaves a settled one behind", async () => {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `f3p-${accountId}@tf.example`,
    }).returning();
    const mailboxId = mb!.id;

    const BLOCK = 30;
    const filler = await insertMessages(accountId, mailboxId, FILLER, 0, "fill");
    let at = FILLER;
    const block = async (tag: string): Promise<string[]> => {
      const out = await insertMessages(accountId, mailboxId, BLOCK, at, tag);
      at += BLOCK;
      return out;
    };
    const pendingApproval = await block("pa");
    const settledApproval = await block("sa");
    const pendingDecision = await block("pd");
    const autoDecision = await block("ad");
    const cold = await block("cold");

    const approvalRows = (ids: string[], status: string) => ids.map((messageId) => ({
      accountId, messageId, kind: "routing", action: "move", status,
    }));
    await db.insert(approvals).values(approvalRows(pendingApproval, "pending"));
    await db.insert(approvals).values(approvalRows(settledApproval, "approved"));

    const decisionRows = (ids: string[], status: string) => ids.map((messageId) => ({
      accountId, messageId, inputProvenance: "rule", destination: "INBOX", status,
    }));
    await db.insert(routingDecisions).values(decisionRows(pendingDecision, "pending_approval"));
    await db.insert(routingDecisions).values(decisionRows(autoDecision, "auto_applied"));

    const ids: string[] = [];
    const approvalIds: string[] = [];
    const decisionIds: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getSnapshot(ctx(accountId), {
        limit: LIMIT, ...(cursor ? { cursor } : {}),
      });
      ids.push(...idsOf(page));
      for (const c of page.changes) {
        if (c.type === "approval") approvalIds.push(c.id);
        if (c.type === "routing_decision") decisionIds.push(c.id);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      if (guard > 100) throw new Error("snapshot drain did not terminate");
    }

    const delivered = new Set(ids);
    // THE CLAIM: an action somebody is waiting to take reaches the mirror.
    expect(pendingApproval.filter((id) => !delivered.has(id)),
      "a message owning a PENDING approval was left below the window").toEqual([]);
    expect(pendingDecision.filter((id) => !delivered.has(id)),
      "a message owning a PENDING routing decision was left below the window").toEqual([]);
    // …and its CHILD rides with it, which is the half that makes the parent worth delivering.
    /* WHAT THE WINDOW'S PAGE IN FLIGHT PULLED IN, before any tail claim is asked.
       The floor is read at a page boundary, so the window ends at {@link windowEmitted} and
       carries that many rows — the first of them below the window. These messages arrive by the
       WINDOW and not by the tail, so every bound below is about the ones OUTSIDE this set.
       In insertion order, because that is the order the newest-first walk reaches them in. */
    const belowWindow = [...pendingApproval, ...settledApproval, ...pendingDecision,
      ...autoDecision, ...cold];
    const OVERSHOOT = windowEmitted(LIMIT) - FILLER;
    const byTheWindow = new Set(belowWindow.slice(0, OVERSHOOT));
    const inOvershoot = (block2: string[]): string[] => block2.filter((id) => byTheWindow.has(id));

    // …and its CHILD rides with it. DERIVED: every pending one, plus any settled one the page in
    // flight happened to carry — a child rides with its message whatever brought the message.
    expect(approvalIds.length)
      .toBe(pendingApproval.length + inOvershoot(settledApproval).length);
    expect(decisionIds.length)
      .toBe(pendingDecision.length + inOvershoot(autoDecision).length);

    // THE BOUND, unchanged as a CLAIM: the TAIL is not "everything below the window". What the
    // window's own page in flight carried is not the tail reaching, so it is excluded by name
    // rather than by widening the assertion.
    for (const [name, block2] of [["settled approval", settledApproval],
      ["auto-applied decision", autoDecision], ["nothing at all", cold]] as const) {
      expect(block2.filter((id) => delivered.has(id) && !byTheWindow.has(id)),
        `a below-window message owning ${name} leaked into the tail`).toEqual([]);
    }
    expect(ids.length, "delivered = the window it actually emitted + what the tail still owed")
      .toBe(windowEmitted(LIMIT)
        + pendingApproval.filter((id) => !byTheWindow.has(id)).length
        + pendingDecision.filter((id) => !byTheWindow.has(id)).length);
    expect(filler.every((id) => delivered.has(id)), "a windowed message went missing").toBe(true);
  }, 180_000);

  /**
   * AND A MESSAGE A DRAFT ANSWERS. Drafts ride every page and their reply targets did not: a reply
   * to mail below the window arrived without the message it answers, and the change that could
   * bring it sits below the cursor the client adopts. The client pins such a message; the tail
   * now carries it.
   */
  it("carries a below-window message a draft replies to, and leaves the rest behind", async () => {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `f3d-${accountId}@tf.example`,
    }).returning();
    const mailboxId = mb!.id;
    const OVERSHOOT = windowEmitted(LIMIT) - FILLER;
    const filler = await insertMessages(accountId, mailboxId, FILLER, 0, "fill");
    // Below the window, and first: whatever the window's page in flight carries comes from here.
    await insertMessages(accountId, mailboxId, OVERSHOOT + 10, FILLER, "pad");
    const answered = await insertMessages(accountId, mailboxId, 30, FILLER + OVERSHOOT + 10, "ans");
    const cold = await insertMessages(accountId, mailboxId, 30, FILLER + OVERSHOOT + 40, "cold");
    await db.insert(drafts).values(answered.map((inReplyToMessageId, i) => ({
      accountId, mailboxId, inReplyToMessageId, subject: `re ${i}`, body: "a reply", status: "draft" as const,
    })));

    const { ids } = await drainMessages(accountId);
    const delivered = new Set(ids);
    expect(answered.filter((id) => !delivered.has(id)),
      "a message a draft answers was left below the window").toEqual([]);
    expect(cold.filter((id) => delivered.has(id)), "an unanswered below-window message leaked into the tail")
      .toEqual([]);
    expect(filler.every((id) => delivered.has(id)), "a windowed message went missing").toBe(true);
  }, 180_000);

  /** …AND A MESSAGE A DRAFT FORWARDS: a kept forward opens only where its original is. */
  it("carries a below-window message a draft forwards, and leaves the rest behind", async () => {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `f3f-${accountId}@tf.example`,
    }).returning();
    const mailboxId = mb!.id;
    const OVERSHOOT = windowEmitted(LIMIT) - FILLER;
    const filler = await insertMessages(accountId, mailboxId, FILLER, 0, "fill");
    await insertMessages(accountId, mailboxId, OVERSHOOT + 10, FILLER, "pad");
    const forwarded = await insertMessages(accountId, mailboxId, 30, FILLER + OVERSHOOT + 10, "fwd");
    const cold = await insertMessages(accountId, mailboxId, 30, FILLER + OVERSHOOT + 40, "cold");
    await db.insert(drafts).values(forwarded.map((forwardOfMessageId, i) => ({
      accountId, mailboxId, forwardOfMessageId, subject: `fwd ${i}`, body: "see below", status: "draft" as const,
    })));

    const { ids } = await drainMessages(accountId);
    const delivered = new Set(ids);
    expect(forwarded.filter((id) => !delivered.has(id)),
      "a message a draft forwards was left below the window").toEqual([]);
    expect(cold.filter((id) => delivered.has(id)), "an unforwarded below-window message leaked into the tail")
      .toEqual([]);
    expect(filler.every((id) => delivered.has(id)), "a windowed message went missing").toBe(true);
  }, 180_000);
});

/** Decode a snapshot cursor far enough to read its phase — the wire shape is `SyncService`'s. */
function svcDecodePhase(cursor: string): string | undefined {
  const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { p?: string };
  return raw.p;
}
