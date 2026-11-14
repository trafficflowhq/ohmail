import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { changeLog, folderState, idempotencyKeys, mailboxes, mailboxFolders, messages, messageTags, tags } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const HOUR = 60 * 60 * 1000;
const AGE = "x-ohmail-press-age";

/**
 * A press replayed after its 24 h idempotency record lands only where nothing NEWER decided the
 * field it sets. The client sends the press's AGE; the server's floor is its own clock minus it.
 * The absent header is today's behaviour (an older client), kept as the control beside each arm.
 */
async function world() {
  const { db, deps, clock } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, accessExpiresAt: new Date(FIXED_NOW.getTime() + 400 * HOUR) });
  const mb = await seedMailbox(db, { accountId: s.accountId });
  await db.update(mailboxes).set({ trashFolder: "INBOX.Trash" }).where(eq(mailboxes.id, mb));
  const m = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", observedFolder: "INBOX" });
  /** `at` is the instant the press was made on its device; the age is the clock now minus it. */
  const send = (method: string, path: string, body: unknown, key: string | null, at: Date | null) => {
    const headers: Record<string, string> = {};
    if (key !== null) headers["idempotency-key"] = key;
    if (at !== null) headers[AGE] = String(Math.max(0, clock.now().getTime() - at.getTime()));
    return H(req(method, path, {
      bearer: s.token, body: body === undefined ? undefined : JSON.stringify(body), headers,
    }), deps);
  };
  const placement = async () => (await db.select().from(folderState).where(eq(folderState.messageId, m.id)))[0];
  const changes = async () => (await db.select().from(changeLog)
    .where(and(eq(changeLog.accountId, s.accountId), eq(changeLog.entityId, m.id)))).length;
  const keys = async () => (await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId))).length;
  const t0 = new Date(clock.now().getTime());
  const at = (h: number) => new Date(t0.getTime() + h * HOUR);
  const to = (h: number) => clock.advance(at(h).getTime() - clock.now().getTime());
  return { db, deps, clock, s, mb, m, send, placement, changes, keys, at, to };
}

const code = async (r: Response) => (await r.json().catch(() => ({}))).error?.code ?? "";

describe("the press age: a move replayed past a day", () => {
  it("B: a move replayed at 25 h over a newer move is refused stale_press, and writes nothing", async () => {
    const w = await world();
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", w.at(0))).status).toBe(200);
    w.to(6);
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/News" }, "k-b", w.at(6))).status).toBe(200);
    w.to(25);
    const before = { placement: await w.placement(), changes: await w.changes(), keys: await w.keys() };
    const replay = await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", w.at(0));
    expect(replay.status).toBe(409);
    const body = await replay.json();
    expect(body.error.code).toBe("stale_press");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details?.current?.folder).toBe("ohmail/News");
    expect(await w.placement()).toEqual(before.placement);
    expect({ changes: await w.changes(), keys: await w.keys() }).toEqual({ changes: before.changes, keys: before.keys });
  });

  it("B control: the same replay inside the day answers the stored 200 and re-runs nothing", async () => {
    const w = await world();
    const first = await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", w.at(0));
    const firstJson = await first.json();
    w.to(1);
    const n = await w.changes();
    const replay = await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", w.at(0));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstJson);
    expect(await w.changes()).toBe(n);
  });

  it("the newer move is stamped with ITS press, so the older replay meets it whichever order they land", async () => {
    const w = await world();
    w.to(25);
    // The laptop's press at +6 h lands first, 19 h late; the phone's at time zero lands after it.
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/News" }, "k-b", w.at(6))).status).toBe(200);
    expect((await w.placement())!.decidedAt?.getTime()).toBe(w.at(6).getTime());
    expect(await code(await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", w.at(0)))).toBe("stale_press");
    expect((await w.placement())!.desiredFolder).toBe("ohmail/News");
  });

  it("H: a malformed age is 400; an absent one applies as today", async () => {
    const w = await world();
    // A year and a day, and 15-digit ages whose floor falls before year 1: 400, never a 500.
    for (const bad of ["-1", "1.5", "abc", "", "9".repeat(40), String(367 * 24 * HOUR), "100000000000000", "999999999999999"]) {
      const r = await H(req("POST", `/messages/${w.m.id}/move`, {
        bearer: w.s.token, body: JSON.stringify({ folder: "ohmail/News" }), headers: { [AGE]: bad },
      }), w.deps);
      expect([bad, r.status, await code(r)]).toEqual([bad, 400, "validation_failed"]);
    }
    w.to(6);
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/News" }, "k-b", w.at(6))).status).toBe(200);
    w.to(25);
    // An older client sends no age: the replay applies, as it always has.
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", null)).status).toBe(200);
    expect((await w.placement())!.desiredFolder).toBe("ohmail/Receipts");
  });

  it("a row decided before the column existed (NULL) admits the replay", async () => {
    const w = await world();
    await w.db.update(folderState).set({ desiredFolder: "ohmail/News" }).where(eq(folderState.messageId, w.m.id));
    w.to(25);
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", w.at(0))).status).toBe(200);
  });

  it("a move into a person's own folder replayed at 25 h over a newer move is refused stale_press, and writes nothing", async () => {
    const w = await world();
    await w.db.insert(mailboxFolders).values({ mailboxId: w.mb, accountId: w.s.accountId, folder: "Clients/Acme" });
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "Clients/Acme" }, "k-f", w.at(0))).status).toBe(200);
    w.to(6);
    expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/News" }, "k-n", w.at(6))).status).toBe(200);
    w.to(25);
    const before = { placement: await w.placement(), changes: await w.changes() };
    const replay = await w.send("POST", `/messages/${w.m.id}/move`, { folder: "Clients/Acme" }, "k-f", w.at(0));
    expect([replay.status, await code(replay)]).toEqual([409, "stale_press"]);
    expect({ placement: await w.placement(), changes: await w.changes() }).toEqual(before);
  });
});

describe("the press age: a delete replayed past a day", () => {
  it("C: a delete replayed at 25 h over a restore at +2 h is refused, and the message stays out of Trash", async () => {
    const w = await world();
    expect((await w.send("DELETE", `/messages/${w.m.id}`, undefined, "k-del", w.at(0))).status).toBe(200);
    w.to(2);
    expect((await w.send("POST", `/messages/${w.m.id}/restore`, undefined, "k-rs", w.at(2))).status).toBe(200);
    // The organizer carries the restore out and the passive read clears the tombstone.
    await w.db.update(folderState).set({ observedFolder: "INBOX", reconcileStatus: "reconciled" }).where(eq(folderState.messageId, w.m.id));
    await w.db.update(messages).set({ deletedAt: null }).where(eq(messages.id, w.m.id));
    w.to(25);
    const n = await w.changes();
    const replay = await w.send("DELETE", `/messages/${w.m.id}`, undefined, "k-del", w.at(0));
    expect([replay.status, await code(replay)]).toEqual([409, "stale_press"]);
    const [row] = await w.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, w.m.id));
    expect(row!.deletedAt).toBeNull();
    expect((await w.placement())!.desiredFolder).toBe("INBOX");
    expect(await w.changes()).toBe(n);
  });

  it("C control: the same delete replay inside the day answers the stored 200 and re-runs nothing", async () => {
    const w = await world();
    const first = await w.send("DELETE", `/messages/${w.m.id}`, undefined, "k-del", w.at(0));
    expect(first.status).toBe(200);
    w.to(1);
    const n = await w.changes();
    expect((await w.send("DELETE", `/messages/${w.m.id}`, undefined, "k-del", w.at(0))).status).toBe(200);
    expect(await w.changes()).toBe(n);
  });

  it("a restore replayed past a day over a newer move is refused", async () => {
    const w = await world();
    expect((await w.send("DELETE", `/messages/${w.m.id}`, undefined, "k-del", w.at(0))).status).toBe(200);
    expect((await w.send("POST", `/messages/${w.m.id}/restore`, undefined, "k-rs", w.at(0))).status).toBe(200);
    w.to(3);
    expect((await w.send("DELETE", `/messages/${w.m.id}`, undefined, "k-del2", w.at(3))).status).toBe(200);
    w.to(26);
    expect(await code(await w.send("POST", `/messages/${w.m.id}/restore`, undefined, "k-rs", w.at(0)))).toBe("stale_press");
    expect((await w.placement())!.desiredFolder).toBe("INBOX.Trash");
  });
});

describe("the press age: read state, triage and tags", () => {
  it("mark read replayed past a day refuses only the ids whose read state is newer", async () => {
    const w = await world();
    const other = await seedMessage(w.db, { accountId: w.s.accountId, mailboxId: w.mb, folder: "INBOX" });
    w.to(6);
    // Another device marked the first one unread again at +6 h.
    expect((await w.send("PATCH", `/messages/${w.m.id}`, { unread: true }, null, w.at(6))).status).toBe(200);
    w.to(25);
    const r = await w.send("PATCH", "/messages", { ids: [w.m.id, other.id], unread: false }, "k-seen", w.at(0));
    expect(r.status).toBe(200);
    const items = (await r.json()).items as Array<{ id: string; unread: boolean }>;
    expect(items.map((i) => [i.id, i.unread])).toEqual([[w.m.id, true], [other.id, false]]);
  });

  it("a single read patch past a day over a newer read decision is refused", async () => {
    const w = await world();
    w.to(6);
    expect((await w.send("PATCH", `/messages/${w.m.id}`, { unread: false }, null, w.at(6))).status).toBe(200);
    w.to(25);
    expect(await code(await w.send("PATCH", `/messages/${w.m.id}`, { unread: true }, null, w.at(0)))).toBe("stale_press");
    const [row] = await w.db.select({ unread: messages.unread }).from(messages).where(eq(messages.id, w.m.id));
    expect(row!.unread).toBe(false);
  });

  it("a triage replayed past a day over a newer triage is refused", async () => {
    const w = await world();
    w.to(6);
    expect((await w.send("POST", `/messages/${w.m.id}/triage`, { state: "set_aside" }, "k-t2", w.at(6))).status).toBe(200);
    w.to(25);
    expect(await code(await w.send("POST", `/messages/${w.m.id}/triage`, { state: "reply_later" }, "k-t1", w.at(0)))).toBe("stale_press");
  });

  it("I: a tag removal past a day over a later assignment is refused; an assignment over a present tag is a no-op", async () => {
    const w = await world();
    const [t] = await w.db.insert(tags).values({ accountId: w.s.accountId, name: "Work" }).returning();
    w.to(6);
    expect((await w.send("POST", `/messages/${w.m.id}/tags`, { tagId: t!.id, assigned: true }, null, w.at(6))).status).toBe(200);
    w.to(25);
    expect(await code(await w.send("POST", `/messages/${w.m.id}/tags`, { tagId: t!.id, assigned: false }, null, w.at(0)))).toBe("stale_press");
    expect(await w.db.select().from(messageTags).where(eq(messageTags.messageId, w.m.id))).toHaveLength(1);
    expect((await w.send("POST", `/messages/${w.m.id}/tags`, { tagId: t!.id, assigned: true }, null, w.at(0))).status).toBe(200);
    expect(await w.db.select().from(messageTags).where(eq(messageTags.messageId, w.m.id))).toHaveLength(1);
  });
});

describe("the press age compares only an aged press", () => {
  it("H3: an Undo pressed while the first move was on the wire lands — fresh presses go in arrival order, stamped with their floor", async () => {
    const w = await world();
    w.to(0);
    // A pressed at t, reaching the server at t+5 s (age 0); B, the Undo, pressed at t+3 s, sent at t+6 s.
    const t = w.clock.now().getTime();
    w.clock.advance(5_000);
    const a = await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", new Date(w.clock.now().getTime()));
    w.clock.advance(1_000);
    const b = await w.send("POST", `/messages/${w.m.id}/move`, { folder: "INBOX" }, "k-b", new Date(t + 3_000));
    expect([a.status, b.status]).toEqual([200, 200]);
    const fs = (await w.placement())!;
    expect([fs.desiredFolder, fs.decidedAt?.getTime()]).toEqual(["INBOX", t + 3_000]);
  });

  it("the threshold: 22 h over a newer decision lands as at base; 23 h is refused", async () => {
    for (const [hours, expected] of [[22, 200], [23, 409]] as const) {
      const w = await world();
      w.to(1);
      expect((await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/News" }, "k-b", w.at(1))).status).toBe(200);
      w.to(hours);
      const r = await w.send("POST", `/messages/${w.m.id}/move`, { folder: "ohmail/Receipts" }, "k-a", w.at(0));
      expect([hours, r.status]).toEqual([hours, expected]);
    }
  });
});
