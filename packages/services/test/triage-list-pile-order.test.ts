import type { MessageDTO } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { messages, messageStates } from "@trafficflow/db";
import { TriageService, ServiceError, encodeListCursor } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * `GET /triage?state=` lists a pile in the pile's own order, the one every client renders
 * (`triagePiles` in the client engine): Answer Later and Parked by arrival, newest first
 * (`sortAt ?? date`, id breaking a tie); Resurface by return time, soonest first, arrival breaking
 * a tie. It paged by message id, a third order. Ids are sorted before times are handed out, so the
 * id order differs from the expected one by construction.
 */

const svc = new TriageService();
const T = Date.parse("2026-09-20T10:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;

async function sixSortedIds() {
  const w = await makeCtx(new Date("2026-09-25T12:00:00Z"));
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", desired: "INBOX" }));
  ids.sort();
  const stamp = (id: string, date: number | null, arrivedAt: number | null) =>
    w.db.update(messages).set({
      date: date === null ? null : new Date(date), arrivedAt: arrivedAt === null ? null : new Date(arrivedAt),
    }).where(eq(messages.id, id));
  return { ...w, ids, stamp };
}

/** The client engine's `byDateDesc`, over the wire's fields. */
function clientOrder(items: MessageDTO[]): string[] {
  const t = (m: MessageDTO) => { const at = m.sortAt ?? m.date; return at ? Date.parse(at) : 0; };
  return [...items].sort((a, b) => (t(b) - t(a)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map((m) => m.id);
}

async function walk(run: (cursor?: string) => Promise<{ items: MessageDTO[]; nextCursor: string | null }>) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await run(cursor);
    seen.push(...r.items.map((m) => m.id));
    if (r.nextCursor === null) return seen;
    cursor = r.nextCursor;
  }
  throw new Error("the walk did not end");
}

describe("GET /triage lists each pile in its own order", () => {
  for (const state of ["reply_later", "set_aside"] as const) {
    it(`${state}: arrival newest first — the clamp, an undated arrival and a tie`, async () => {
      const { ctx, ids: [i0, i1, i2, i3, i4, i5], stamp } = await sixSortedIds();
      await stamp(i2!, T + 5 * H, T + 5 * H);
      await stamp(i0!, T - 40 * D, T + 4 * H);    // a header far from arrival: arrival decides
      await stamp(i5!, T + 3 * H, null);          // no recorded arrival: the header decides
      await stamp(i1!, T + 2.5 * H, T + 2 * H);   // within tolerance: the header decides
      await stamp(i4!, T + H, T + H);
      await stamp(i3!, T + H, T + H);             // a tie with i4: the larger id first
      for (const id of [i3, i0, i5, i2, i4, i1]) await svc.setState(ctx, id!, { state });

      const expected = [i2, i0, i5, i1, i4, i3];
      const page = await svc.listByState(ctx, state);
      expect(page.items.map((m) => m.id)).toEqual(expected);
      expect(page.items.map((m) => m.id)).toEqual(clientOrder(page.items));
      // One a page, so a page boundary falls inside the i4/i3 tie.
      expect(await walk((cursor) => svc.listByState(ctx, state, { cursor, limit: 1 }))).toEqual(expected);
    });
  }

  it("an undated row reads as the epoch: after every dated row, and the walk reaches it", async () => {
    const { ctx, ids: [k0, k1, k2], stamp } = await sixSortedIds();
    await stamp(k0!, null, null);
    await stamp(k1!, T, T);
    await stamp(k2!, T + H, T + H);
    for (const id of [k1, k0, k2]) await svc.setState(ctx, id!, { state: "reply_later" });
    expect(await walk((cursor) => svc.listByState(ctx, "reply_later", { cursor, limit: 1 }))).toEqual([k2, k1, k0]);
  });

  it("Reply Run reads Answer Later in the same order", async () => {
    const { ctx, ids: [i0, i1, i2], stamp } = await sixSortedIds();
    await stamp(i0!, T + H, T + H);
    await stamp(i1!, T + 3 * H, T + 3 * H);
    await stamp(i2!, T + 2 * H, T + 2 * H);
    for (const id of [i0, i2, i1]) await svc.setState(ctx, id!, { state: "reply_later" });
    expect((await svc.focusReply(ctx)).items.map((x) => x.message.id)).toEqual([i1, i2, i0]);
  });

  it("bubbled_up: soonest return first, arrival breaking a tie, no return last, across pages", async () => {
    const { db, ctx, ids: [j0, j1, j2, j3, j4, j5], stamp } = await sixSortedIds();
    const R = Date.parse("2026-10-01T08:00:00.000Z");
    await stamp(j1!, T + 3 * H, T + 3 * H);
    await stamp(j3!, T + H, T + H);
    await stamp(j4!, T + 2 * H, T + 2 * H);
    await stamp(j5!, T + 5 * H, T + 5 * H);
    const back = (id: string, at: number) => svc.bubbleUp(ctx, id, new Date(at).toISOString());
    await back(j0!, R + 3 * D);
    await back(j2!, R + 2 * D);
    await back(j3!, R + D);
    await back(j1!, R + D);                        // same return as j3, arrived later: first
    // No CHECK holds the column: a row with no return time reads as never, after every dated one.
    for (const id of [j4!, j5!]) {
      await back(id, R);
      await db.update(messageStates).set({ bubbleUpAt: null }).where(eq(messageStates.messageId, id));
    }

    const expected = [j1, j3, j2, j0, j5, j4];
    expect((await svc.listByState(ctx, "bubbled_up")).items.map((m) => m.id)).toEqual(expected);
    expect(await walk((cursor) => svc.listByState(ctx, "bubbled_up", { cursor, limit: 1 }))).toEqual(expected);
  });

  it("a cursor of another shape is refused, not read as a position", async () => {
    const { ctx, ids: [i0] } = await sixSortedIds();
    const bare = encodeListCursor(i0!);
    const arrival = encodeListCursor(`${T}:${i0!}`);
    for (const [state, cursor] of [["reply_later", bare], ["bubbled_up", bare], ["bubbled_up", arrival]] as const) {
      const err = await svc.listByState(ctx, state, { cursor }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject({ httpStatus: 400 });
    }
  });
});
