import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, inArray } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, attachments, auditLog, changeLog, mailboxes, messageBodies, messages,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { HTML_TRUNCATION_MARKER } from "@trafficflow/core/mail";
import {
  runAttachmentFlagBackfill, planAttachmentFlagBackfill,
} from "../src/attachment-flag-backfill.js";
import { runInlineCidBackfill, planInlineCidBackfill } from "../src/inline-cid-backfill.js";
import { main as cliMain } from "../src/inline-cid-backfill-cli.js";
import { AttachmentsService } from "../src/attachments-service.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * a part the stored html references by `cid:` is inline on every row, old and new.
 * `.pg.test.ts` for the reasons `attachment-flag-backfill.pg.test.ts` gives: `FOR UPDATE`, the
 * advisory lock and EvalPlanQual are no-ops on single-connection PGlite. The last case is the
 * two backfills' shared lock, driven in a fixed order through this file's own backend.
 */

const AVAILABLE = await realPgAvailable();

interface World { accountId: string; mailboxId: string }
interface Part { cid?: string | null; inline?: boolean; name?: string }
interface Body { html?: string | null; withheld?: string; none?: true }

describe.skipIf(!AVAILABLE)("the inline-cid backfill", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Db;
  }, 120_000);

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `at5-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `at5-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /**
   * One message as a pre-rule ingest stored it: the body, its parts, and the pair counting every
   * `inline = false` part (or `stored` when a case needs a stale pair).
   */
  async function seed(
    w: World, body: Body, parts: Part[],
    opts: { id?: string; stored?: { has: boolean; count: number } } = {},
  ): Promise<{ id: string; partIds: string[] }> {
    const files = parts.filter((p) => p.inline !== true).length;
    const [m] = await db.insert(messages).values({
      ...(opts.id ? { id: opts.id } : {}),
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `at5:${randomUUID()}`, subject: "s", fromAddress: "sender@example.test",
      nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
      hasAttachments: opts.stored?.has ?? files > 0,
      attachmentCount: opts.stored?.count ?? files,
    }).returning();
    if (!body.none) {
      await db.insert(messageBodies).values({
        messageId: m!.id, accountId: m!.accountId, text: "", html: body.html ?? null, withheldReason: body.withheld ?? null,
      });
    }
    const partIds: string[] = [];
    for (const [i, p] of parts.entries()) {
      const [a] = await db.insert(attachments).values({
        accountId: w.accountId, messageId: m!.id,
        filename: p.name ?? `logo${i}.png`,
        contentType: p.name?.endsWith(".pdf") ? "application/pdf" : "image/png",
        sizeBytes: 1024, partId: String(i + 2),
        contentId: p.cid === undefined ? null : p.cid,
        inline: p.inline === true,
      }).returning();
      partIds.push(a!.id);
    }
    return { id: m!.id, partIds };
  }

  const img = (cid: string) => `<p>hi</p><img src="cid:${cid}" alt="">`;

  const pairOf = async (id: string) => {
    const [r] = await db.select({ has: messages.hasAttachments, count: messages.attachmentCount })
      .from(messages).where(eq(messages.id, id));
    return { has: r!.has, count: r!.count };
  };
  const inlineOf = async (ids: string[]) =>
    (await db.select({ id: attachments.id, inline: attachments.inline })
      .from(attachments).where(inArray(attachments.id, ids)))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((r) => r.inline);
  const changesFor = async (accountId: string, ids: string[]) =>
    db.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId), inArray(changeLog.entityId, ids),
    ));
  const auditsFor = async (accountId: string) =>
    db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
  const planFor = async (w: World) =>
    (await planInlineCidBackfill(db)).filter((r) => r.mailboxId === w.mailboxId);

  /* ── THE HEADLINE CASE ─────────────────────────────────────────────────────────────────── */

  it("promotes a referenced logo stored as a file, clears the paperclip, ONE message/update", async () => {
    const w = await newWorld();
    const m = await seed(w, { html: img("logo@corp") }, [{ cid: "logo@corp" }]);
    expect(await pairOf(m.id)).toEqual({ has: true, count: 1 });

    const r = await runInlineCidBackfill({ db, mailboxId: w.mailboxId });

    expect(r).toMatchObject({ examined: 1, corrected: 1, promoted: 1, truncated: false });
    expect(await inlineOf(m.partIds)).toEqual([true]);
    expect(await pairOf(m.id)).toEqual({ has: false, count: 0 });
    const changes = await changesFor(w.accountId, [m.id]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entityType: "message", entityId: m.id, op: "update" });
  });

  it("keeps the paperclip for the real file beside a referenced logo: 2 -> 1", async () => {
    const w = await newWorld();
    const m = await seed(w, { html: img("logo@corp") }, [
      { cid: "logo@corp" }, { name: "invoice.pdf" },
    ]);
    await runInlineCidBackfill({ db, mailboxId: w.mailboxId });
    expect(await inlineOf(m.partIds)).toEqual([true, false]);
    expect(await pairOf(m.id)).toEqual({ has: true, count: 1 });
  });

  it("the three readings on ONE message: the paperclip, the Files list, the strip's tag", async () => {
    const w = await newWorld();
    const m = await seed(w, { html: img("logo@corp") }, [{ cid: "logo@corp" }, { name: "invoice.pdf" }]);
    const ctx: ServiceContext = {
      db, accountId: w.accountId, userId: null, now: () => new Date(), requestId: "at5",
    };
    const svc = new AttachmentsService();
    const filesBefore = (await svc.listFiles(ctx, { type: "all" })).items.map((f) => f.id);
    expect(filesBefore.sort()).toEqual([...m.partIds].sort());

    await runInlineCidBackfill({ db, mailboxId: w.mailboxId });

    // The paperclip (the pair the message DTO carries) drops by the flipped part.
    expect(await pairOf(m.id)).toEqual({ has: true, count: 1 });
    // The account Files list (`inline = false`) no longer holds the picture.
    expect((await svc.listFiles(ctx, { type: "all" })).items.map((f) => f.id)).toEqual([m.partIds[1]]);
    // The reader strip still lists it, as an inline part — the tile it tags "embedded".
    const strip = await svc.listForMessage(ctx, m.id);
    expect(strip.map((a) => [a.id, a.inline]).sort()).toEqual(
      [[m.partIds[0], true], [m.partIds[1], false]].sort(),
    );
  });

  it("promotes every referenced part across the UPDATE's slices", async () => {
    const w = await newWorld();
    const cids = ["a@x", "b@x", "c@x"];
    const m = await seed(w, { html: cids.map(img).join("") }, cids.map((cid) => ({ cid })));
    const r = await runInlineCidBackfill({ db, mailboxId: w.mailboxId, flipChunk: 2 });
    expect(r).toMatchObject({ corrected: 1, promoted: 3 });
    expect(await inlineOf(m.partIds)).toEqual([true, true, true]);
    expect(await pairOf(m.id)).toEqual({ has: false, count: 0 });
  });

  /* ── WHAT STAYS A FILE ─────────────────────────────────────────────────────────────────── */

  it("an unreferenced cid part and an empty content id stay files — no write at all", async () => {
    const w = await newWorld();
    const unref = await seed(w, { html: img("other@corp") }, [{ cid: "logo@corp" }]);
    const empty = await seed(w, { html: '<img src="cid:">' }, [{ cid: "" }]);

    const r = await runInlineCidBackfill({ db, mailboxId: w.mailboxId });

    // The empty id is not even a candidate: `cid:` alone would match every reference.
    expect(r).toMatchObject({ examined: 1, corrected: 0, promoted: 0 });
    expect(await inlineOf([...unref.partIds, ...empty.partIds])).toEqual([false, false]);
    expect(await pairOf(unref.id)).toEqual({ has: true, count: 1 });
    expect(await changesFor(w.accountId, [unref.id, empty.id])).toHaveLength(0);
    expect(await auditsFor(w.accountId)).toHaveLength(0);
  });

  it("a related part already inline is not a candidate", async () => {
    const w = await newWorld();
    await seed(w, { html: img("r@corp") }, [{ cid: "r@corp", inline: true }]);
    expect(await runInlineCidBackfill({ db, mailboxId: w.mailboxId }))
      .toMatchObject({ examined: 0, corrected: 0 });
  });

  it("the three unreadable bodies are counted by name and left files", async () => {
    const w = await newWorld();
    const husk = await seed(w, { withheld: "storage_cap" }, [{ cid: "a@x" }]);
    const none = await seed(w, { none: true }, [{ cid: "b@x" }]);
    const noHtml = await seed(w, { html: null }, [{ cid: "c@x" }]);
    // Cut at the cap with the reference past the cut: the stored half cannot say.
    const cut = await seed(w, { html: `<p>long</p>${HTML_TRUNCATION_MARKER}` }, [{ cid: "d@x" }]);
    // Cut, but the reference survived the cut: that one IS read.
    const cutRef = await seed(w, { html: `${img("e@x")}${HTML_TRUNCATION_MARKER}` }, [{ cid: "e@x" }]);

    expect(await planFor(w)).toEqual([{
      mailboxId: w.mailboxId, parts: 5, referenced: 1, notReferenced: 0,
      noBodyOrWithheld: 2, noHtmlStored: 1, truncatedNotReferenced: 1, messagesToCorrect: 1,
    }]);

    const r = await runInlineCidBackfill({ db, mailboxId: w.mailboxId });
    expect(r).toMatchObject({ examined: 5, corrected: 1, promoted: 1 });
    expect(await inlineOf([...husk.partIds, ...none.partIds, ...noHtml.partIds, ...cut.partIds]))
      .toEqual([false, false, false, false]);
    expect(await inlineOf(cutRef.partIds)).toEqual([true]);
  });

  /* ── PLAN, APPLY, PLAN ─────────────────────────────────────────────────────────────────── */

  it("plan writes nothing; after apply it reads REFERENCED 0", async () => {
    const w = await newWorld();
    await seed(w, { html: img("a@x") }, [{ cid: "a@x" }, { name: "f.pdf" }]);
    await seed(w, { html: img("z@x") }, [{ cid: "b@x" }]);

    expect(await planFor(w)).toEqual([{
      mailboxId: w.mailboxId, parts: 2, referenced: 1, notReferenced: 1,
      noBodyOrWithheld: 0, noHtmlStored: 0, truncatedNotReferenced: 0, messagesToCorrect: 1,
    }]);
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId)))
      .toHaveLength(0);

    await runInlineCidBackfill({ db, mailboxId: w.mailboxId });
    expect(await planFor(w)).toEqual([{
      mailboxId: w.mailboxId, parts: 1, referenced: 0, notReferenced: 1,
      noBodyOrWithheld: 0, noHtmlStored: 0, truncatedNotReferenced: 0, messagesToCorrect: 0,
    }]);
  });

  it("is idempotent: a second apply examines the same rows and writes nothing", async () => {
    const w = await newWorld();
    const a = await seed(w, { html: img("a@x") }, [{ cid: "a@x" }]);
    const b = await seed(w, { html: img("z@x") }, [{ cid: "b@x" }]);

    const first = await runInlineCidBackfill({ db, mailboxId: w.mailboxId });
    expect(first).toMatchObject({ examined: 2, corrected: 1 });
    const changes = (await changesFor(w.accountId, [a.id, b.id])).length;
    const audits = (await auditsFor(w.accountId)).length;

    const second = await runInlineCidBackfill({ db, mailboxId: w.mailboxId });
    // The set does not drain — the unreferenced part stays a file, so it is examined again.
    expect(second).toMatchObject({ examined: 1, corrected: 0, promoted: 0, truncated: false });
    expect(await changesFor(w.accountId, [a.id, b.id])).toHaveLength(changes);
    expect(await auditsFor(w.accountId)).toHaveLength(audits);
  });

  it("records an inverse carrying the flipped parts and the PRIOR pair, plus one receipt", async () => {
    const w = await newWorld();
    const m = await seed(w, { html: `${img("a@x")}${img("b@x")}` }, [
      { cid: "a@x" }, { cid: "b@x" }, { name: "f.pdf" },
    ]);
    await runInlineCidBackfill({ db, mailboxId: w.mailboxId });

    const rows = await auditsFor(w.accountId);
    const perRow = rows.filter((r) => r.action === "inline_cid_backfill_row");
    const summary = rows.filter((r) => r.action === "inline_cid_backfill");
    expect(perRow).toHaveLength(1);
    expect(perRow[0]!.inverse).toEqual({
      messageId: m.id, inlineFalse: [m.partIds[0], m.partIds[1]].sort(),
      hasAttachments: true, attachmentCount: 3,
    });
    expect(perRow[0]!.payload).toMatchObject({ hasAttachments: true, attachmentCount: 1 });
    expect(summary).toHaveLength(1);
    expect(summary[0]!.inverse).toBeNull();
  });

  /* ── THE TWO BACKFILLS AGREE ───────────────────────────────────────────────────────────── */

  it("the paperclip plan reads 0/0 on every row this pass touched, in both orders", async () => {
    const shapes = async (w: World) => [
      await seed(w, { html: img("a@x") }, [{ cid: "a@x" }]),
      await seed(w, { html: img("b@x") }, [{ cid: "b@x" }, { name: "f.pdf" }]),
      // A stale pair the paperclip owns: a related part counted as a file at ingest.
      await seed(w, { html: img("c@x") }, [{ cid: "c@x" }, { cid: "r@x", inline: true }],
        { stored: { has: true, count: 2 } }),
    ];
    const paperclipFor = async (w: World) =>
      (await planAttachmentFlagBackfill(db)).filter((r) => r.mailboxId === w.mailboxId);

    const first = await newWorld();
    const ids1 = await shapes(first);
    await runAttachmentFlagBackfill({ db, mailboxId: first.mailboxId });
    await runInlineCidBackfill({ db, mailboxId: first.mailboxId });
    for (const r of await paperclipFor(first)) expect(r).toMatchObject({ inlineOnly: 0, miscounted: 0 });

    const second = await newWorld();
    const ids2 = await shapes(second);
    await runInlineCidBackfill({ db, mailboxId: second.mailboxId });
    for (const r of await paperclipFor(second)) expect(r).toMatchObject({ inlineOnly: 0, miscounted: 0 });
    expect(await runAttachmentFlagBackfill({ db, mailboxId: second.mailboxId }))
      .toMatchObject({ examined: 0 });

    for (const [a, b] of ids1.map((m, i) => [m, ids2[i]!] as const)) {
      expect(await pairOf(a.id)).toEqual(await pairOf(b.id));
    }
    expect(await pairOf(ids1[1]!.id)).toEqual({ has: true, count: 1 });
  });

  /* ── RESUMING PAST A TRUNCATED RUN ─────────────────────────────────────────────────────── */

  it("a truncated run names its last id and --after resumes past it", async () => {
    const w = await newWorld();
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort();
    for (const id of ids) await seed(w, { html: img("a@x") }, [{ cid: "a@x" }], { id });

    const partial = await runInlineCidBackfill({ db, mailboxId: w.mailboxId, batch: 1, maxPages: 2 });
    expect(partial).toMatchObject({ truncated: true, examined: 2, corrected: 2 });
    expect(partial.lastExaminedId).toBe(ids[1]);

    const rest = await runInlineCidBackfill({
      db, mailboxId: w.mailboxId, afterId: partial.lastExaminedId!,
    });
    expect(rest).toMatchObject({ truncated: false, examined: 3, corrected: 3 });
  });

  it("plan --mailbox counts that mailbox alone, in the library and at the command", async () => {
    const a = await newWorld();
    const b = await newWorld();
    await seed(a, { html: img("a@x") }, [{ cid: "a@x" }]);
    await seed(b, { html: img("a@x") }, [{ cid: "a@x" }]);

    expect((await planInlineCidBackfill(db, { mailboxId: a.mailboxId })).map((r) => r.mailboxId))
      .toEqual([a.mailboxId]);

    const saved = process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL;
    process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL = PG_TEST_URL;
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
    try {
      expect(await cliMain(["plan", "--mailbox", a.mailboxId])).toBe(0);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL;
      else process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL = saved;
    }
    const printed = out.join("\n");
    expect(printed).toContain(a.mailboxId);
    expect(printed).not.toContain(b.mailboxId);
  });

  it("--mailbox confines the pass to one mailbox", async () => {
    const a = await newWorld();
    const b = await newWorld();
    const inA = await seed(a, { html: img("a@x") }, [{ cid: "a@x" }]);
    const inB = await seed(b, { html: img("a@x") }, [{ cid: "a@x" }]);
    await runInlineCidBackfill({ db, mailboxId: a.mailboxId });
    expect(await inlineOf(inA.partIds)).toEqual([true]);
    expect(await inlineOf(inB.partIds)).toEqual([false]);
  });

  /* ── CONCURRENCY ───────────────────────────────────────────────────────────────────────── */

  it("two concurrent applies correct each message ONCE", async () => {
    const w = await newWorld();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await seed(w, { html: img("a@x") }, [{ cid: "a@x" }])).id);

    const [x, y] = await Promise.all([
      runInlineCidBackfill({ db, mailboxId: w.mailboxId, batch: 4 }),
      runInlineCidBackfill({ db, mailboxId: w.mailboxId, batch: 4 }),
    ]);

    expect(x.corrected + y.corrected).toBe(12);
    const changes = await changesFor(w.accountId, ids);
    expect(changes).toHaveLength(12);
    expect(new Set(changes.map((c) => Number(c.seq))).size).toBe(12);
    expect((await auditsFor(w.accountId)).filter((r) => r.action === "inline_cid_backfill_row"))
      .toHaveLength(12);
  });

  /**
   * THE SHARED LOCK, in a fixed order, with a REAL inline page: it takes the lock, flips the logo,
   * writes the pair 1 and holds before its commit. The paperclip apply starts on its own backend
   * and is seen WAITING before that page commits. Without the lock in EITHER pass, the paperclip
   * waits on the row instead, re-reads it under EvalPlanQual with its count still at the statement
   * snapshot, and writes 2 back over the inline pass's 1.
   */
  it("the paperclip waits on the shared lock and does not write a recount back", async () => {
    const w = await newWorld();
    const m = await seed(w, { html: `${img("m@x")}${img("r@x")}` }, [
      { cid: "m@x" }, { name: "f.pdf" }, { cid: "r@x", inline: true },
    ], { stored: { has: true, count: 3 } });

    const app = `at5-twin-${randomUUID().slice(0, 8)}`;
    const p = postgres(PG_TEST_URL, { max: 2, onnotice: () => {}, connection: { application_name: app } });
    const pdb = brandDialect(drizzle(p, { schema }), "pg") as unknown as Db;
    try {
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      let ready!: () => void;
      const held = new Promise<void>((res) => { ready = res; });
      let pages = 0;
      const inline = runInlineCidBackfill({
        db, mailboxId: w.mailboxId,
        afterPageWrites: async () => { if (pages++ === 0) { ready(); await gate; } },
      });
      await held;

      const run = runAttachmentFlagBackfill({ db: pdb, mailboxId: w.mailboxId });
      let waiting = 0;
      for (let i = 0; i < 200 && waiting === 0; i++) {
        const [row] = await sql`select count(*)::int as n from pg_stat_activity
          where application_name = ${app} and wait_event_type = 'Lock'`;
        waiting = row!.n as number;
        if (waiting === 0) await new Promise((res) => setTimeout(res, 50));
      }
      expect(waiting, "the paperclip apply never reached a lock wait").toBe(1);

      release();
      expect(await inline).toMatchObject({ corrected: 1, promoted: 1 });
      await run;
      expect(await pairOf(m.id)).toEqual({ has: true, count: 1 });
    } finally {
      await p.end({ timeout: 5 });
    }
  });
});

describe("the command", () => {
  it("refuses without its own URL variable, by name", async () => {
    const saved = process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL;
    delete process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL;
    try {
      await expect(cliMain(["plan"])).rejects.toThrow(/OHMAIL_INLINE_CID_BACKFILL_DB_URL/);
    } finally {
      if (saved !== undefined) process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL = saved;
    }
  });

  it("--after needs a value", async () => {
    await expect(cliMain(["apply", "--after"])).rejects.toThrow(/--after needs a value/);
  });
});
