import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  changeLog, folderState, mailboxes, messages, messageStates, recordChange, rules, tags,
  type EntityType,
} from "@trafficflow/db";
import {
  COALESCE_SCAN_WINDOW, STALE_COALESCE_SPAN, SyncService,
  type ServiceContext, type SyncResponse,
} from "../src/index.js";
import { ClientMirror, flatten } from "./_apply-harness.js";

/**
 * THE BACKLOG DIET (INSTANT-ARCH §6.3 / §8 stage 3) — the coalesced stale read.
 *
 * The property under test is EQUIVALENCE: a mirror that resumes a stale cursor through
 * coalesced pages must converge to byte-identical state with a mirror that replayed every
 * change row — deletions during the span included — while the per-page cursor stays honest
 * (a kill between pages resumes and still converges) and `hasMore` never strands rows beyond
 * the scan window. Each test names the mutation it was watched red against.
 */

const svc = new SyncService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x.example" }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-08-29T00:00:00.000Z"), requestId: "r",
  };
  return { db, accountId, mailboxId: mb.id, ctx };
}

async function addMessage(db: Db, accountId: string, mailboxId: string, subject: string): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(), subject, fromAddress: "f@x.example",
  }).returning();
  await db.insert(folderState).values({
    messageId: m.id, accountId: m.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  return m.id;
}

const rec = (db: Db, accountId: string, entityType: EntityType, entityId: string,
  op: "create" | "update" | "move" | "delete", meta?: { from: string | null; to: string }) =>
  db.transaction((tx) => recordChange(tx as never, { accountId, entityType, entityId, op, meta }));

const seqCursor = (seq: number | bigint): string => Buffer.from(String(seq), "utf8").toString("base64url");

async function maxSeq(db: Db, accountId: string): Promise<bigint> {
  const rows = await db.select({ seq: changeLog.seq }).from(changeLog)
    .where(eq(changeLog.accountId, accountId)).orderBy(changeLog.seq);
  return rows.length ? rows[rows.length - 1]!.seq : 0n;
}

/** Drain from `since` to the horizon, applying page by page. Returns the pages served. */
async function drainInto(
  mirror: ClientMirror, ctx: ServiceContext, since: string, limit: number,
): Promise<SyncResponse[]> {
  const pages: SyncResponse[] = [];
  let cursor = since;
  let guard = 0;
  for (;;) {
    const page = await svc.getChanges(ctx, { since: cursor, limit });
    mirror.applyResponse(page);
    pages.push(page);
    cursor = page.cursor;
    if (!page.hasMore) return pages;
    if (++guard > 100) throw new Error("drain did not terminate");
  }
}

function snapshotObj(mirror: ClientMirror): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of [...mirror.snapshot().entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = v;
  return out;
}

describe("sync — the coalescing threshold (STALE_COALESCE_SPAN)", () => {
  /**
   * MUTATION-PROOFED: flipping the threshold comparison (coalescing small spans, or never
   * coalescing) turns exactly one of these two arms red — the small span stops carrying its
   * duplicate rows, or the large one starts carrying them.
   */
  it("a span at the threshold replays every row; one past it dedups", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const a = await addMessage(db, accountId, mailboxId, "a");
    // seq 1 = create; then exactly STALE_COALESCE_SPAN more changes to the same entity.
    await rec(db, accountId, "message", a, "create");
    for (let i = 0; i < STALE_COALESCE_SPAN; i++) await rec(db, accountId, "message", a, "update");

    // Resume from seq 1: span == STALE_COALESCE_SPAN ⇒ PLAIN path, every row on the wire.
    const plain = await svc.getChanges(ctx, { since: seqCursor(1), limit: 2000 });
    expect(flatten(plain)).toHaveLength(STALE_COALESCE_SPAN);

    // One more change: span == STALE_COALESCE_SPAN + 1 ⇒ coalesced, ONE row for the entity.
    await rec(db, accountId, "message", a, "update");
    const dieted = await svc.getChanges(ctx, { since: seqCursor(1), limit: 2000 });
    expect(flatten(dieted)).toHaveLength(1);
    expect(flatten(dieted)[0]!.seq).toBe(Number(await maxSeq(db, accountId)));
    expect(dieted.hasMore).toBe(false);
  }, 120_000);
});

describe("sync — coalesced resume ≡ full replay (the equivalence proof)", () => {
  /**
   * The stage-3 proof obligation: a warm mirror that sleeps through a busy span and resumes
   * through COALESCED pages converges to the SAME state as a mirror handed every intermediate
   * row — including entities DELETED during the span (they must not resurrect), created AND
   * deleted inside it (they must not appear), deleted AND re-created (they must appear), moved
   * (folder membership), read-state flips (message_state), and tag/rule churn.
   *
   * MUTATION-PROOFED (each watched red on 2026-08-29):
   *  · dropping delete rows from the coalesced page (op filter) → B lingers in the subject;
   *  · emitting oldest-per-entity instead of latest (asc in the DISTINCT ON) → A's folder
   *    regresses and D disappears (its create is emitted instead of its re-create);
   *  · committing the horizon as every page's cursor (the unapplied-horizon claim) → the
   *    kill-mid-drain arm converges MISSING the rows past the first page.
   */
  it("converges byte-identically, deletions and resurrections included", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();

    // ── The base state the sleeping mirror holds ─────────────────────────────────────────
    const a = await addMessage(db, accountId, mailboxId, "a");
    const b = await addMessage(db, accountId, mailboxId, "b");
    const d = await addMessage(db, accountId, mailboxId, "d");
    await rec(db, accountId, "message", a, "create");
    await rec(db, accountId, "message", b, "create");
    await rec(db, accountId, "message", d, "create");
    const [st] = await db.insert(messageStates).values({ accountId, messageId: a, state: "none" }).returning();
    await rec(db, accountId, "message_state", st.id, "create");
    const [rule] = await db.insert(rules).values({
      accountId, kind: "sender", match: "f@x.example", destination: "INBOX",
    }).returning();
    await rec(db, accountId, "rule", rule.id, "create");

    const subject = new ClientMirror();
    await drainInto(subject, ctx, "0", 2000); // the mirror is now current…
    const sleptAt = await maxSeq(db, accountId); // …and goes to sleep here.

    // ── The busy span (> STALE_COALESCE_SPAN rows) while the mirror sleeps ───────────────
    // A: moved to a folder, then read — folder membership and read-state must both land.
    await db.update(folderState).set({ desiredFolder: "ohmail/News" }).where(eq(folderState.messageId, a));
    await rec(db, accountId, "message", a, "move", { from: "INBOX", to: "ohmail/News" });
    await db.update(messageStates).set({ state: "reply_later" }).where(eq(messageStates.id, st.id));
    await rec(db, accountId, "message_state", st.id, "update");
    // B: deleted on the server — the tombstone must reach the subject through the diet.
    await rec(db, accountId, "message", b, "update");
    await db.delete(folderState).where(eq(folderState.messageId, b));
    await db.delete(messages).where(eq(messages.id, b));
    await rec(db, accountId, "message", b, "delete");
    // C: created AND deleted inside the span — must never appear.
    const c = await addMessage(db, accountId, mailboxId, "c");
    await rec(db, accountId, "message", c, "create");
    await db.delete(folderState).where(eq(folderState.messageId, c));
    await db.delete(messages).where(eq(messages.id, c));
    await rec(db, accountId, "message", c, "delete");
    // D: deleted, then re-created (a new row) — the RE-CREATE must win.
    await db.delete(folderState).where(eq(folderState.messageId, d));
    await db.delete(messages).where(eq(messages.id, d));
    await rec(db, accountId, "message", d, "delete");
    const d2 = await addMessage(db, accountId, mailboxId, "d2");
    await rec(db, accountId, "message", d2, "create");
    // The rule flips destination; a tag is created; then FILLER pushes the span past the
    // threshold — hundreds of updates to one entity, the exact shape coalescing eats.
    await db.update(rules).set({ destination: "ohmail/Feed" }).where(eq(rules.id, rule.id));
    await rec(db, accountId, "rule", rule.id, "update");
    const [tag] = await db.insert(tags).values({ accountId, name: "t", hue: 100 }).returning();
    await rec(db, accountId, "tag", tag.id, "create");
    for (let i = 0; i < STALE_COALESCE_SPAN + 20; i++) await rec(db, accountId, "message", a, "update");

    // ── The oracle: a full, uncompacted replay from zero (the bootstrap path never diets) ─
    const oracle = new ClientMirror();
    const oraclePages = await drainInto(oracle, ctx, "0", 400);
    const expected = snapshotObj(oracle);
    // The oracle really replayed row-per-row (no compaction on since=0).
    expect(oraclePages.reduce((n, p) => n + flatten(p).length, 0))
      .toBe(Number(await maxSeq(db, accountId)));

    // ── The subject resumes its stale cursor; the span is > threshold ⇒ coalesced ────────
    const pages = await drainInto(subject, ctx, seqCursor(sleptAt), 400);
    expect(snapshotObj(subject)).toEqual(expected);
    // …and the diet actually happened: far fewer rows than the span on the wire.
    const span = Number(await maxSeq(db, accountId)) - Number(sleptAt);
    const wired = pages.reduce((n, p) => n + flatten(p).length, 0);
    expect(span).toBeGreaterThan(STALE_COALESCE_SPAN);
    expect(wired).toBeLessThan(span / 10);

    // The specific claims, named (belt over the deep-equal):
    expect(subject.snapshot().has(`message:${b}`)).toBe(false);           // deleted in span
    expect(subject.snapshot().has(`message:${c}`)).toBe(false);           // born+died in span
    expect(subject.snapshot().has(`message:${d}`)).toBe(false);           // tombstoned…
    expect(subject.snapshot().has(`message:${d2}`)).toBe(true);           // …successor lives
    expect((subject.snapshot().get(`message:${a}`) as { folder: string }).folder).toBe("ohmail/News");
    expect((subject.snapshot().get(`message_state:${st.id}`) as { state: string }).state).toBe("reply_later");
    expect((subject.snapshot().get(`rule:${rule.id}`) as { destination: string }).destination).toBe("ohmail/Feed");
    expect(subject.snapshot().has(`tag:${tag.id}`)).toBe(true);
  }, 120_000);

  it("a kill between coalesced pages resumes from the committed cursor and still converges", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    // 40 distinct messages created, then churn on the FIRST 20 pushes the span past the
    // threshold — so the coalesced result (40 creates + churn tails) needs several pages at
    // limit 10, and the kill lands mid-walk.
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await addMessage(db, accountId, mailboxId, `m${i}`));
    const subject = new ClientMirror();
    await drainInto(subject, ctx, "0", 2000); // warm, empty-log mirror
    const sleptAt = await maxSeq(db, accountId);
    for (const id of ids) await rec(db, accountId, "message", id, "create");
    for (let round = 0; round < 30; round++) {
      for (let i = 0; i < 20; i++) await rec(db, accountId, "message", ids[i]!, "update");
    }

    // Page 1 only — then the "crash".
    const first = await svc.getChanges(ctx, { since: seqCursor(sleptAt), limit: 10 });
    subject.applyResponse(first);
    expect(first.hasMore).toBe(true);

    // A new session resumes from the durably committed cursor and drains to the horizon.
    await drainInto(subject, ctx, first.cursor, 10);

    const oracle = new ClientMirror();
    await drainInto(oracle, ctx, "0", 2000);
    expect(snapshotObj(subject)).toEqual(snapshotObj(oracle));
    expect(subject.snapshot().size).toBe(40);
  }, 120_000);
});

describe("sync — the scan window bounds one request, never the drain", () => {
  /**
   * A span larger than {@link COALESCE_SCAN_WINDOW} must be served in window-sized bites whose
   * cursors walk the whole span: entities whose ONLY change lies beyond the first window must
   * be absent from page 1 (the window bound is real) and present after the drain (nothing is
   * stranded). `hasMore` must say true on a short page whose window has span left beyond it —
   * MUTATION-PROOFED: restoring the plain `rows.length === limit` rule for coalesced pages
   * makes this drain stop after page 1 and the beyond-window assertions go red.
   *
   * The log rows are bulk-inserted (recordChange per row would be thousands of transactions); the read
   * path under test only ever reads `change_log` and the live tables, so hand-written seqs are
   * exactly as authoritative as allocated ones.
   */
  it("entities beyond the first window arrive on later pages", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const inWindow: string[] = [];
    for (let i = 0; i < 6; i++) inWindow.push(await addMessage(db, accountId, mailboxId, `w${i}`));
    const beyond: string[] = [];
    for (let i = 0; i < 3; i++) beyond.push(await addMessage(db, accountId, mailboxId, `x${i}`));

    // Seqs 1..W: churn over the six in-window messages (creates first, then updates).
    const rows: (typeof changeLog.$inferInsert)[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push({ accountId, seq: BigInt(i + 1), entityType: "message", entityId: inWindow[i]!, op: "create", meta: null });
    }
    for (let s = 7; s <= COALESCE_SCAN_WINDOW + 1; s++) {
      rows.push({ accountId, seq: BigInt(s), entityType: "message", entityId: inWindow[s % 6]!, op: "update", meta: null });
    }
    // Seqs W+1..W+3: the ONLY changes naming the beyond-window messages.
    for (let i = 0; i < 3; i++) {
      rows.push({ accountId, seq: BigInt(COALESCE_SCAN_WINDOW + 2 + i), entityType: "message", entityId: beyond[i]!, op: "create", meta: null });
    }
    for (let i = 0; i < rows.length; i += 4000) {
      await db.insert(changeLog).values(rows.slice(i, i + 4000));
    }

    const first = await svc.getChanges(ctx, { since: seqCursor(1), limit: 500 });
    const firstIds = new Set(flatten(first).map((c) => c.id));
    for (const id of beyond) expect(firstIds.has(id)).toBe(false); // the window bound is real
    expect(flatten(first).length).toBeLessThan(500);               // six distinct entities…
    expect(first.hasMore).toBe(true);                              // …but the span goes on

    const mirror = new ClientMirror();
    mirror.applyResponse(first);
    await drainInto(mirror, ctx, first.cursor, 500);
    for (const id of [...inWindow, ...beyond]) {
      expect(mirror.snapshot().has(`message:${id}`)).toBe(true);   // nothing stranded
    }
  }, 120_000);
});

describe("sync — coalesced pages keep parents ahead of their children", () => {
  /**
   * THE FK-GUARDED MIRROR'S CONTRACT. The desktop's relational mirror SKIPS a child row whose
   * parent is absent (`applyUpsert`: a `message_state` naming an unmirrored message), on the
   * plain path's standing guarantee that the parent's change carries a lower seq and lands
   * first. Latest-seq emission broke it: a message created in-window, its state written next,
   * the message updated hundreds of changes later emitted STATE-then-MESSAGE — and a page cut
   * between them committed the cursor past the state's only change, so the FK guard skipped a
   * row the feed would never send again. First-appearance order restores the guarantee across
   * cuts: `min(parent) ≤ parent's create < child's create ≤ min(child)`.
   *
   * MUTATION-PROOFED (2026-08-29): reverting the entity page's ORDER BY to latest-seq
   * (`max(seq)`) puts the state on page 1 ahead of its message and turns the first arm red.
   */
  it("a page cut between a state and its later-churned message delivers the MESSAGE first", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();

    // Seq 1: an unrelated change the sleeping mirror has already drained — the resume point.
    const before = await addMessage(db, accountId, mailboxId, "before");
    await rec(db, accountId, "message", before, "create");
    const subject = new ClientMirror();
    await drainInto(subject, ctx, "0", 2000);
    const sleptAt = await maxSeq(db, accountId);

    // In-window: M created (its create IS in the span), its state written one seq later, then
    // M churned past the threshold so latest-seq ordering would sort M AFTER its child.
    const m = await addMessage(db, accountId, mailboxId, "m");
    await rec(db, accountId, "message", m, "create");
    const [st] = await db.insert(messageStates).values({ accountId, messageId: m, state: "reply_later" }).returning();
    await rec(db, accountId, "message_state", st.id, "create");
    // A third in-window entity, so the entity page's SELECTION order matters: with only two,
    // both fit the lookahead window (limit + 1) and the emit-side first-seq sort would mask a
    // wrong selection order — the mutation run proved exactly that before this row existed.
    const x = await addMessage(db, accountId, mailboxId, "x");
    await rec(db, accountId, "message", x, "create");
    for (let i = 0; i < STALE_COALESCE_SPAN + 20; i++) await rec(db, accountId, "message", m, "update");

    // limit 1 forces the cut exactly between the two entities.
    const page1 = await svc.getChanges(ctx, { since: seqCursor(sleptAt), limit: 1 });
    const rows1 = flatten(page1);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]!.type, "the parent message must land before its state").toBe("message");
    expect(rows1[0]!.id).toBe(m);
    expect(page1.hasMore).toBe(true);

    // The drain behind the cut still delivers the child, and converges to the oracle.
    subject.applyResponse(page1);
    await drainInto(subject, ctx, page1.cursor, 1);
    const oracle = new ClientMirror();
    await drainInto(oracle, ctx, "0", 2000);
    expect(snapshotObj(subject)).toEqual(snapshotObj(oracle));
    expect(subject.snapshot().has(`message_state:${st.id}`)).toBe(true);
    expect(subject.snapshot().has(`message:${x}`)).toBe(true);
  }, 120_000);
});
