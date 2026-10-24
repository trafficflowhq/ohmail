/**
 * A SENT ROW'S WORDS ARE THE ACCOUNT'S RECORD OF WHAT WENT (REPRESS-WITH-EDITED-WORDS-SENDS-THE-EARLIER-ONES).
 * `update()` writes only where `status = 'draft' AND send_key IS NULL`. A sent row restated with its
 * own words answers 200 and writes nothing (an older client replaying a confirmed send after a kill);
 * different words answer 409 `draft_sent`; `sending`/`unverified` answer `send_recorded`. A save that
 * states the version it was made on is a current editor's, never a replay: 409 `draft_sent` even with
 * the same words. Mutations: the predicate back to `ne(status,'scheduled')` reddens control 4; dropping
 * the compare reddens the restatement; the stated version ignored reddens the stated restatement.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { changeLog, drafts, mailboxes } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { DraftsService } from "../src/index.js";
import { draftContentRevision } from "../src/draft-revision.js";
import type { ServiceContext } from "../src/index.js";

const svc = new DraftsService();

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "a@x-ch.example" }).returning();
  const now = new Date("2026-10-03T12:00:00Z");
  const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => now, requestId: "r" };
  return { db, ctx, A, mb: mb!.id };
}

const EARLIER = "Reply to Ada.";
const EDITED = "Reply to Ada, with the figures.";
const TO = [{ name: null, address: "ada@x-ch.example" }];

const answerOf = (p: Promise<unknown>) => p.then(
  () => ({ httpStatus: 200 as number | undefined, code: null as string | null }),
  (e: { httpStatus?: number; code?: string }) => ({ httpStatus: e.httpStatus, code: e.code ?? null }),
);

async function sentRow(status: "sent" | "sending" | "unverified" = "sent") {
  const s = await setup();
  const { draft } = await svc.create(s.ctx, { mailboxId: s.mb, subject: "Re: invoice", body: EARLIER, to: TO });
  await s.db.update(drafts).set({ status }).where(eq(drafts.id, draft.id));
  const changes = async () => (await s.db.select().from(changeLog)
    .where(and(eq(changeLog.accountId, s.A), eq(changeLog.entityId, draft.id)))).length;
  const read = async () => (await s.db.select().from(drafts).where(eq(drafts.id, draft.id)))[0]!;
  return { ...s, id: draft.id, changes, read };
}

describe("a content PUT on a sent draft", () => {
  it("control 4 — different words are refused 409 draft_sent and the sent words stand", async () => {
    const s = await sentRow();
    const answer = await answerOf(svc.update(s.ctx, s.id, { body: EDITED }));
    const row = await s.read();
    expect({ answer, row: { body: row.body, status: row.status } }, "a sent row's words were rewritten").toEqual({
      answer: { httpStatus: 409, code: "draft_sent" }, row: { body: EARLIER, status: "sent" },
    });
  });

  it("the stated restatement — the same words with the version they were made on answer 409 draft_sent and write nothing", async () => {
    const s = await sentRow();
    const before = await s.read();
    const changes = await s.changes();
    const answer = await answerOf(svc.update(s.ctx, s.id, {
      subject: "Re: invoice", body: EARLIER, to: TO, cc: [], bcc: [], mailboxId: s.mb,
    }, { ifContentRevision: draftContentRevision(before) }));
    expect({ answer, row: await s.read(), changes: await s.changes() })
      .toEqual({ answer: { httpStatus: 409, code: "draft_sent" }, row: before, changes });
  });

  it("the restatement — the same words, no version stated, answer 200, the row byte-equal and no change written", async () => {
    const s = await sentRow();
    const before = await s.read();
    const changes = await s.changes();
    const upd = await svc.update(s.ctx, s.id, {
      subject: "Re: invoice", body: EARLIER, to: TO, cc: [], bcc: [], mailboxId: s.mb,
    });
    expect(upd.seq).toBeNull();
    expect(upd.draft.status).toBe("sent");
    expect(upd.draft.body).toBe(EARLIER);
    expect(await s.read()).toEqual(before);
    expect(await s.changes(), "a restatement wrote a change").toBe(changes);
  });

  it("a mailbox move alone on a sent row is a different message: draft_sent", async () => {
    const s = await sentRow();
    const [mb2] = await s.db.insert(mailboxes).values({ accountId: s.A, provider: "imap", address: "a2@x-ch.example" }).returning();
    expect(await answerOf(svc.update(s.ctx, s.id, { mailboxId: mb2!.id }))).toEqual({ httpStatus: 409, code: "draft_sent" });
    expect((await s.read()).mailboxId).toBe(s.mb);
  });

  for (const status of ["sending", "unverified"] as const) {
    it(`a '${status}' row answers send_recorded and keeps its words`, async () => {
      const s = await sentRow(status);
      expect(await answerOf(svc.update(s.ctx, s.id, { body: EDITED }))).toEqual({ httpStatus: 409, code: "send_recorded" });
      expect((await s.read()).body).toBe(EARLIER);
    });
  }

  it("CONTROL: the same PUT on an ordinary draft is admitted and written", async () => {
    const s = await setup();
    const { draft, seq } = await svc.create(s.ctx, { mailboxId: s.mb, subject: "Re: invoice", body: EARLIER });
    const upd = await svc.update(s.ctx, draft.id, { body: EDITED });
    expect(upd.draft.body).toBe(EDITED);
    expect(upd.seq).toBeGreaterThan(seq);
    const [row] = await s.db.select({ body: drafts.body }).from(drafts).where(eq(drafts.id, draft.id));
    expect(row!.body).toBe(EDITED);
  });
});

/**
 * THE EDIT'S OWN REFUSALS, each raised by the EDIT whatever the row's state: on a sent row they still
 * answer their own code, never `draft_sent`, because `update()` validates the patch before it reads
 * the row. A resumed send reads exactly these as a refusal and every other answer as "retry under the
 * key" — the client's `EDIT_OWN_REFUSALS` is pinned to this list in the phone's suite.
 */
const EDIT_OWN = ["400 validation_failed", "413 draft_too_large", "413 payload_too_large"];

describe("the refusals a resumed send treats as the edit's own", () => {
  const status = async (p: Promise<unknown>) => {
    const a = await answerOf(p);
    return `${a.httpStatus} ${a.code}`;
  };
  it("each comes from the patch, on a sent row too", async () => {
    const s = await sentRow();
    const many = Array.from({ length: 501 }, (_, i) => ({ name: null, address: `r${i}@x-ch.example` }));
    const seen = new Set([
      await status(svc.update(s.ctx, s.id, { to: [{ address: 5 } as never] })),
      await status(svc.update(s.ctx, s.id, { body: "x".repeat(262_145) })),
      await status(svc.update(s.ctx, s.id, { to: many })),
      await status(svc.update(s.ctx, s.id, { inReplyToMessageId: randomUUID(), forwardOfMessageId: randomUUID() })),
    ]);
    expect([...seen].sort()).toEqual([...EDIT_OWN].sort());
    expect((await s.read()).body, "a refused edit wrote the row").toBe(EARLIER);
  });
});
