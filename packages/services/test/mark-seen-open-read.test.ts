import { describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { messages, threads } from "@trafficflow/db";
import { MessageService, ServiceError, TriageService, type ServiceContext } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";
import { OPEN_READ_SHAPES } from "../../client-engine/test/fixtures/open-read-shapes.js";

/**
 * THE OPEN READ, AT THE SERVER (owner 2026-10-07, narrowing 2026-09-18). `PATCH /messages` with
 * `openRead: true` stamps `open_read_at` on the rows THAT WERE UNREAD, only when every id is one
 * conversation, at the same instant as `last_read_at`/`updated_at`. A read over several
 * conversations still lands and stamps nothing — placement never refuses a read. Every unread
 * clears the stamp: the batch, the single PATCH. PGlite here; the transaction and the replay on real
 * Postgres are `mark-seen-open-read.pg.test.ts`.
 */

const t0 = Date.UTC(2031, 0, 1, 0, 0, 0);
function tickingCtx(base: ServiceContext): ServiceContext {
  let n = 0;
  return { ...base, now: () => new Date(t0 + (n += 1000)) };
}
const ms = (d: Date | null | undefined): number | null | undefined => (d == null ? d : d.getTime());

type Db = Awaited<ReturnType<typeof makeCtx>>["db"];
type Row = typeof messages.$inferSelect & { openReadAt?: Date | null };

async function seedShape(
  db: Db, accountId: string, mailboxId: string,
  rows: ReadonlyArray<{ label: string; thread: string; arrived: string; unread: boolean }>,
): Promise<Map<string, string>> {
  const threadIds = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const r of rows) {
    if (!threadIds.has(r.thread)) {
      const [t] = await db.insert(threads).values({ accountId, subject: r.thread }).returning();
      threadIds.set(r.thread, t!.id);
    }
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", unread: r.unread, date: new Date(r.arrived) });
    await db.update(messages).set({ threadId: threadIds.get(r.thread)! }).where(inArray(messages.id, [id]));
    ids.set(r.label, id);
  }
  return ids;
}

async function rowsOf(db: Db, ids: Map<string, string>): Promise<Map<string, Row>> {
  const all = (await db.select().from(messages).where(inArray(messages.id, [...ids.values()]))) as Row[];
  const byId = new Map(all.map((r) => [r.id, r]));
  return new Map([...ids].map(([label, id]) => [label, byId.get(id)!]));
}

const PRESS = OPEN_READ_SHAPES.find((s) => s.name.startsWith("the press:"))!;
const TWO_CONVERSATIONS = OPEN_READ_SHAPES.find((s) => s.name.startsWith("two conversations:"))!;

describe("markSeen stamps the open read on the rows that were unread, in one conversation", () => {
  it("one conversation, two of three unread: exactly those two take open_read_at = last_read_at = updated_at", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    await new MessageService().markSeen(t, { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true });
    const rows = await rowsOf(db, ids);
    for (const label of ["a1", "a2"]) {
      const r = rows.get(label)!;
      expect(r.openReadAt, `${label} was unread`).toBeInstanceOf(Date);
      expect(ms(r.openReadAt)).toBe(ms(r.lastReadAt));
      expect(ms(r.openReadAt)).toBe(ms(r.updatedAt));
    }
    // MUTATION WATCHED: drop the `wasUnread` filter and the read member is restamped here.
    expect(rows.get("a3")!.openReadAt ?? null, "a3 was already read").toBeNull();
  });

  it("two conversations: the read lands (200), nothing is stamped", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const ids = await seedShape(db, accountId, mailboxId, TWO_CONVERSATIONS.rows);
    await new MessageService().markSeen(tickingCtx(ctx), { ids: TWO_CONVERSATIONS.ids.map((l) => ids.get(l)!), unread: false, openRead: true });
    const rows = await rowsOf(db, ids);
    for (const r of rows.values()) {
      expect(r.unread).toBe(false);
      expect(r.openReadAt, "a read over two conversations places nothing").toBeNull();
    }
  });

  it("openRead with unread:true, or a non-boolean openRead, is a 400 and writes nothing", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    const svc = new MessageService();
    const all = PRESS.ids.map((l) => ids.get(l)!);
    for (const body of [{ ids: all, unread: true, openRead: true }, { ids: all, unread: false, openRead: "yes" }]) {
      const err = await svc.markSeen(ctx, body).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).httpStatus).toBe(400);
    }
    expect((await rowsOf(db, ids)).get("a1")!.unread, "a refused body wrote nothing").toBe(true);
  });

  it("a second execution stamps nothing: a read row is never restamped", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    const body = { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true };
    const svc = new MessageService();
    await svc.markSeen(t, body);
    const first = ms((await rowsOf(db, ids)).get("a1")!.openReadAt);
    expect(first).toEqual(expect.any(Number));
    await svc.markSeen(t, body);
    expect(ms((await rowsOf(db, ids)).get("a1")!.openReadAt)).toBe(first);
  });

  it("every unread clears it: the batch nulls both stamps, the single PATCH nulls it", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    const svc = new MessageService();
    const all = PRESS.ids.map((l) => ids.get(l)!);
    await svc.markSeen(t, { ids: all, unread: false, openRead: true });
    expect((await rowsOf(db, ids)).get("a1")!.openReadAt).toBeInstanceOf(Date);
    await svc.markSeen(t, { ids: [ids.get("a1")!], unread: true });
    const a1 = (await rowsOf(db, ids)).get("a1")!;
    expect(a1.lastReadAt).toBeNull();
    expect(a1.openReadAt, "the batch's unread").toBeNull();

    expect((await rowsOf(db, ids)).get("a2")!.openReadAt).toBeInstanceOf(Date);
    await svc.patch(t, ids.get("a2")!, { unread: true });
    expect((await rowsOf(db, ids)).get("a2")!.openReadAt, "the single PATCH's unread").toBeNull();
  });

  it("the durable case's server half: the answer's DTO carries openReadAt (absent ⇒ every reload files at arrival)", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    const { items } = await new MessageService().markSeen(
      tickingCtx(ctx), { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true },
    );
    const byId = new Map(items.map((m) => [m.id, m as { openReadAt?: string | null }]));
    expect(byId.get(ids.get("a1")!)!.openReadAt).toEqual(expect.any(String));
    expect(byId.get(ids.get("a3")!)!.openReadAt).toBeNull();
  });
});

describe("parity, the server's half: the shapes stamp what the engine paints", () => {
  for (const shape of OPEN_READ_SHAPES) {
    it(shape.name, async () => {
      const { db, accountId, mailboxId, ctx } = await makeCtx();
      const t = tickingCtx(ctx);
      const ids = await seedShape(db, accountId, mailboxId, shape.rows);
      const svc = new MessageService();
      // A row the shape starts stamped takes its stamp the only way there is: an open read of it.
      for (const r of shape.rows.filter((x) => x.openReadAt !== undefined)) {
        await svc.markSeen(t, { ids: [ids.get(r.label)!], unread: true });
        await svc.markSeen(t, { ids: [ids.get(r.label)!], unread: false, openRead: true });
      }
      const before = await rowsOf(db, ids);
      await svc.markSeen(t, {
        ids: shape.ids.map((l) => ids.get(l)!), unread: shape.unread, ...(shape.serverFlag ? { openRead: true } : {}),
      });
      const after = await rowsOf(db, ids);
      const stamped = [...after].filter(([l, r]) => r.openReadAt != null && ms(r.openReadAt) !== ms(before.get(l)!.openReadAt))
        .map(([l]) => l).sort();
      const cleared = [...after].filter(([l, r]) => before.get(l)!.openReadAt != null && r.openReadAt == null)
        .map(([l]) => l).sort();
      expect(stamped).toEqual([...shape.stamped].sort());
      expect(cleared).toEqual([...shape.cleared].sort());
    });
  }
});

describe("H1 a park or a pin ends the open read; LOW 6 a parked member is never stamped", () => {
  for (const state of ["reply_later", "set_aside", "muted", "resurfaced"] as const) {
    it(`setState ${state} clears open_read_at; none afterwards leaves it cleared`, async () => {
      const { db, accountId, mailboxId, ctx } = await makeCtx();
      const t = tickingCtx(ctx);
      const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
      await new MessageService().markSeen(t, { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true });
      expect((await rowsOf(db, ids)).get("a1")!.openReadAt, "the premise: stamped").toBeInstanceOf(Date);
      const triage = new TriageService();
      await triage.setState(t, ids.get("a1")!, { state });
      expect((await rowsOf(db, ids)).get("a1")!.openReadAt, `${state} kept the open read`).toBeNull();
      await triage.setState(t, ids.get("a1")!, { state: "none" });
      expect((await rowsOf(db, ids)).get("a1")!.openReadAt).toBeNull();
      // A sibling never parked keeps its stamp: the clear is the row's own.
      expect((await rowsOf(db, ids)).get("a2")!.openReadAt).toBeInstanceOf(Date);
    });
  }

  it("bubbled_up (a scheduled return) clears it too", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    await new MessageService().markSeen(t, { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true });
    await new TriageService().setState(t, ids.get("a2")!, { state: "bubbled_up", bubbleUpAt: "2031-02-01T00:00:00.000Z" });
    expect((await rowsOf(db, ids)).get("a2")!.openReadAt).toBeNull();
  });

  it("an open read over the conversation stamps no member that is parked or pinned", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    const triage = new TriageService();
    await triage.setState(t, ids.get("a1")!, { state: "reply_later" });
    await triage.setState(t, ids.get("a3")!, { state: "resurfaced" });
    await new MessageService().markSeen(t, { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true, via: "glance" });
    const rows = await rowsOf(db, ids);
    expect(rows.get("a1")!.unread, "the parked member is read").toBe(false);
    expect(rows.get("a1")!.openReadAt, "a parked member was stamped").toBeNull();
    expect(rows.get("a2")!.openReadAt, "the unparked unread member is stamped").toBeInstanceOf(Date);
  });
});

/**
 * UNDO PUTS BACK THE PLACE IN EARLIER. The Undo of a press on a row in Earlier sends `none` with the
 * open read the row held before the press; the server restores it and skips the un-park reset. Every
 * other `none` (no field) still files at arrival: the H1 arms above are its controls.
 */
describe("Undo restores the open read the press ended", () => {
  const PRESSES = [
    { state: "set_aside" }, { state: "reply_later" }, { state: "muted" }, { state: "resurfaced" },
    { state: "bubbled_up", bubbleUpAt: "2031-02-01T00:00:00.000Z" },
  ] as const;
  for (const press of PRESSES) {
    it(`${press.state}, then Undo: open_read_at is the press-time instant, last_read_at unchanged`, async () => {
      const { db, accountId, mailboxId, ctx } = await makeCtx();
      const t = tickingCtx(ctx);
      const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
      await new MessageService().markSeen(t, { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true });
      const before = (await rowsOf(db, ids)).get("a1")!;
      expect(before.openReadAt, "the premise: stamped").toBeInstanceOf(Date);
      const triage = new TriageService();
      await triage.setState(t, ids.get("a1")!, press);
      expect((await rowsOf(db, ids)).get("a1")!.openReadAt, "the press ended the open read").toBeNull();
      await triage.setState(t, ids.get("a1")!, { state: "none", restoreOpenReadAt: before.openReadAt!.toISOString() });
      const after = (await rowsOf(db, ids)).get("a1")!;
      expect(ms(after.openReadAt)).toBe(ms(before.openReadAt));
      expect(ms(after.lastReadAt), "the un-park reset ran beside the restore").toBe(ms(before.lastReadAt));
    });
  }

  it("bounds: a future instant is stored as now, an unread row and a newer open read are left alone", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    const svc = new MessageService();
    await svc.markSeen(t, { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true });
    const triage = new TriageService();
    const at = new Date(t0 + 60_000);
    await triage.setState(t, ids.get("a1")!, { state: "set_aside" });
    await triage.setState({ ...t, now: () => at }, ids.get("a1")!, { state: "none", restoreOpenReadAt: "2099-01-01T00:00:00.000Z" });
    expect(ms((await rowsOf(db, ids)).get("a1")!.openReadAt), "a future instant").toBe(at.getTime());

    await triage.setState(t, ids.get("a1")!, { state: "set_aside" });
    await svc.markSeen(t, { ids: [ids.get("a1")!], unread: true });
    await triage.setState(t, ids.get("a1")!, { state: "none", restoreOpenReadAt: new Date(t0).toISOString() });
    expect((await rowsOf(db, ids)).get("a1")!.openReadAt, "an unread row took a stamp").toBeNull();

    const kept = ms((await rowsOf(db, ids)).get("a2")!.openReadAt);
    await triage.setState(t, ids.get("a2")!, { state: "none", restoreOpenReadAt: new Date(t0 - 86_400_000).toISOString() });
    expect(ms((await rowsOf(db, ids)).get("a2")!.openReadAt), "an open read was replaced").toBe(kept);
  });

  it("the field with a pile state, or a malformed one, is a 400 and writes nothing", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const ids = await seedShape(db, accountId, mailboxId, PRESS.rows);
    await new MessageService().markSeen(t, { ids: PRESS.ids.map((l) => ids.get(l)!), unread: false, openRead: true });
    const triage = new TriageService();
    await triage.setState(t, ids.get("a1")!, { state: "set_aside" });
    for (const body of [
      { state: "reply_later", restoreOpenReadAt: new Date(t0).toISOString() },
      { state: "none", restoreOpenReadAt: "not a date" },
      { state: "none", restoreOpenReadAt: 42 },
    ]) {
      const err = await triage.setState(t, ids.get("a1")!, body as never).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).httpStatus).toBe(400);
    }
    expect((await rowsOf(db, ids)).get("a1")!.openReadAt, "a refused body wrote the stamp").toBeNull();
    const err = await triage.setState(t, ids.get("a1")!, { state: "none", restoreOpenReadAt: null } as never).then(() => null, (e: unknown) => e);
    expect(err, "null is an ordinary un-park").toBeNull();
  });
});
