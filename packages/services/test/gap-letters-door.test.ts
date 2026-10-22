import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes } from "@trafficflow/db";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * THE GAP OFFER'S DOOR, WITH ITS TWO COUNTS (mail 0151, 0158). File stamps the press only while the
 * row offers exactly the pair the person was shown; a missing `strangers` reads as 0, so an older
 * client never screens letters it did not show. Leave closes the window and both counts. The door
 * writes the mailbox row only; the organizer's pass does the moving.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const svc = makeMailboxService({ installId: "install-here", lastOrganizerCycleAt: async () => null });

async function world(o: { letters: number | null; strangers: number | null; pressed?: boolean; role?: string }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `gld-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `gld-${accountId.slice(0, 8)}@example.test`,
    organizerRole: o.role ?? "organizer", gapSince: new Date("2026-10-09T10:00:00.000Z"),
    gapLetters: o.letters, gapStrangers: o.strangers, gapPressedAt: o.pressed ? NOW : null,
  }).returning();
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: "gld",
  };
  const row = async () => (await db.select({
    since: mailboxes.gapSince, letters: mailboxes.gapLetters, strangers: mailboxes.gapStrangers, pressed: mailboxes.gapPressedAt,
  }).from(mailboxes).where(eq(mailboxes.id, mb!.id)))[0]!;
  return { db, ctx, id: mb!.id, row };
}

describe("the gap offer's door reads both counts", () => {
  it("File for the pair shown stamps the press (202's outcome); a replay answers the same and writes nothing", async () => {
    const w = await world({ letters: 1, strangers: 2 });
    const r = await svc.answerGapLetters(w.ctx, w.id, { file: true, count: 1, strangers: 2 });
    expect(r.outcome).toBe("pressed");
    expect((await w.row()).pressed?.getTime()).toBe(NOW.getTime());
    const again = await svc.answerGapLetters(w.ctx, w.id, { file: true, count: 1, strangers: 2 });
    expect(again.outcome).toBe("pressed");
    expect(await w.db.select().from(folderState), "the door moved mail").toEqual([]);
  });

  it("a press without the stranger count, while there are strangers, is refused (409's outcome) and stamps nothing", async () => {
    const w = await world({ letters: 1, strangers: 2 });
    expect((await svc.answerGapLetters(w.ctx, w.id, { file: true, count: 1 })).outcome).toBe("changed");
    expect((await svc.answerGapLetters(w.ctx, w.id, { file: true, count: 1, strangers: 1 })).outcome).toBe("changed");
    expect((await svc.answerGapLetters(w.ctx, w.id, { file: true, count: 3 })).outcome).toBe("changed");
    expect((await w.row()).pressed, "a stale pair stamped a press").toBeNull();
    /* CONTROL: an offer with no strangers takes an older client's press, which sends none. */
    const older = await world({ letters: 1, strangers: 0 });
    expect((await svc.answerGapLetters(older.ctx, older.id, { file: true, count: 1 })).outcome).toBe("pressed");
  });

  it("a replay is the press only while both counts match it", async () => {
    const w = await world({ letters: 1, strangers: 2, pressed: true });
    expect((await svc.answerGapLetters(w.ctx, w.id, { file: true, count: 1, strangers: 2 })).outcome).toBe("pressed");
    expect((await svc.answerGapLetters(w.ctx, w.id, { file: true, count: 1, strangers: 0 })).outcome).toBe("changed");
  });

  it("Leave closes the window and both counts, and moves nothing", async () => {
    const w = await world({ letters: 0, strangers: 3 });
    const r = await svc.answerGapLetters(w.ctx, w.id, { file: false, count: 0 });
    expect(r.outcome).toBe("left");
    expect(await w.row()).toEqual({ since: null, letters: null, strangers: null, pressed: null });
    expect(r.mailbox).toMatchObject({ gapLetters: null, gapStrangers: null });
  });

  it("projects the stranger count beside the offer: K, 0 for an older build's NULL, null without an offer", async () => {
    const both = await world({ letters: 0, strangers: 3 });
    expect(await svc.get(both.ctx, both.id)).toMatchObject({ gapLetters: 0, gapStrangers: 3 });
    const older = await world({ letters: 2, strangers: null });
    expect(await svc.get(older.ctx, older.id)).toMatchObject({ gapLetters: 2, gapStrangers: 0 });
    const pressed = await world({ letters: 1, strangers: 2, pressed: true });
    expect(await svc.get(pressed.ctx, pressed.id)).toMatchObject({ gapLetters: null, gapStrangers: null });
    const reader = await world({ letters: 1, strangers: 2, role: "reader" });
    expect(await svc.get(reader.ctx, reader.id)).toMatchObject({ gapLetters: null, gapStrangers: null });
  });
});
