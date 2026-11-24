import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { folderState, idempotencyKeys, changeLog, mailboxes, mailboxFolders, folderOps } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedBody, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Collect change ids from a bootstrap /sync, partitioned by bucket + the raw move metas. */
async function syncBuckets(
  deps: ApiDeps, token: string,
): Promise<{ creates: string[]; updates: string[]; moves: Array<{ id: string; move: { from: string | null; to: string } }>; deletes: string[] }> {
  const res = await H(req("GET", "/sync?since=0", { bearer: token }), deps);
  const b = await res.json();
  return {
    creates: b.changes.creates.map((c: { id: string }) => c.id),
    updates: b.changes.updates.map((c: { id: string }) => c.id),
    moves: b.changes.moves.map((c: { id: string; move: { from: string | null; to: string } }) => ({ id: c.id, move: c.move })),
    deletes: b.changes.deletes.map((c: { id: string }) => c.id),
  };
}

const D = (n: number) => new Date(FIXED_NOW.getTime() - n * 1000);

describe("GET /messages — view partitions", () => {
  it("each view returns its folder partition; new_for_you/previously_seen split the Imbox by unread", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await (await import("./helpers.js")).seedMailbox(db, { accountId: s.accountId });

    const inboxUnread = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: true, date: D(1) });
    const inboxRead = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: false, date: D(2) });
    const feed = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "ohmail/News", date: D(3) });
    const paper = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "ohmail/Receipts", date: D(4) });
    const screened = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "ohmail/Screened", date: D(5) });
    const quarantine = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "ohmail/Quarantine", date: D(6) });

    const ids = async (view: string): Promise<string[]> => {
      const res = await H(req("GET", `/messages?view=${encodeURIComponent(view)}`, { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      return (await res.json()).items.map((m: { id: string }) => m.id);
    };

    expect((await ids("imbox")).sort()).toEqual([inboxUnread.id, inboxRead.id].sort());
    expect(await ids("feed")).toEqual([feed.id]);
    expect(await ids("paper_trail")).toEqual([paper.id]);
    expect(await ids("screened")).toEqual([screened.id]);
    expect(await ids("quarantine")).toEqual([quarantine.id]);
    expect(await ids("new_for_you")).toEqual([inboxUnread.id]);
    expect(await ids("previously_seen")).toEqual([inboxRead.id]);

    // MessageDTO.folder is materialized from folder_state.
    const feedRes = await H(req("GET", `/messages/${feed.id}`, { bearer: s.token }), deps);
    expect((await feedRes.json()).folder).toBe("ohmail/News");
  });

  it("unknown / missing view → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    expect((await H(req("GET", "/messages?view=bogus", { bearer: s.token }), deps)).status).toBe(400);
    expect((await H(req("GET", "/messages", { bearer: s.token }), deps)).status).toBe(400);
  });

  it("paginates with a working nextCursor", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await (await import("./helpers.js")).seedMailbox(db, { accountId: s.accountId });
    const seeded: string[] = [];
    for (let i = 0; i < 5; i++) {
      seeded.push((await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", date: D(i) })).id);
    }

    const page1 = await (await H(req("GET", "/messages?view=imbox&limit=2", { bearer: s.token }), deps)).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const collected = new Set<string>(page1.items.map((m: { id: string }) => m.id));
    let cursor: string | null = page1.nextCursor;
    while (cursor) {
      const p = await (await H(req(`GET`, `/messages?view=imbox&limit=2&cursor=${encodeURIComponent(cursor)}`, { bearer: s.token }), deps)).json();
      for (const m of p.items) collected.add(m.id);
      cursor = p.nextCursor;
    }
    expect(collected).toEqual(new Set(seeded));
  });
});

describe("GET /messages/:id + /body — IDOR", () => {
  it("happy path; cross-account id → 404 for both get and body", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const m = await seedMessage(db, { accountId: owner.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: m.id, text: "hello world", html: "<p>hi</p>", loadedRemoteContent: false });

    const got = await H(req("GET", `/messages/${m.id}`, { bearer: owner.token }), deps);
    expect(got.status).toBe(200);
    const body = await H(req("GET", `/messages/${m.id}/body`, { bearer: owner.token }), deps);
    expect(body.status).toBe(200);
    const bj = await body.json();
    expect(bj.text).toBe("hello world");
    expect(bj.messageId).toBe(m.id);

    // Cross-account → 404 (indistinguishable from missing).
    expect((await H(req("GET", `/messages/${m.id}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("GET", `/messages/${m.id}/body`, { bearer: other.token }), deps)).status).toBe(404);
  });
});

describe("PATCH /messages/:id", () => {
  it("unread flip persists + emits an update change (visible in /sync)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: true });

    const res = await H(req("PATCH", `/messages/${m.id}`, { bearer: s.token, body: JSON.stringify({ unread: false }) }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).unread).toBe(false);
    expect(res.headers.get("x-sync-seq")).toBeTruthy();
    expect((await syncBuckets(deps, s.token)).updates).toContain(m.id);
  });

  it("folder set emits a move change + sets folder_state pending toward the target", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });

    const res = await H(req("PATCH", `/messages/${m.id}`, { bearer: s.token, body: JSON.stringify({ folder: "ohmail/News" }) }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toBe("ohmail/News");

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m.id));
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" });

    const moves = (await syncBuckets(deps, s.token)).moves.find((mv) => mv.id === m.id);
    expect(moves?.move).toEqual({ from: "INBOX", to: "ohmail/News" });
  });

  it("invalid folder → 400; cross-account → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const m = await seedMessage(db, { accountId: owner.accountId, folder: "INBOX" });

    expect((await H(req("PATCH", `/messages/${m.id}`, { bearer: owner.token, body: JSON.stringify({ folder: "Nope" }) }), deps)).status).toBe(400);
    expect((await H(req("PATCH", `/messages/${m.id}`, { bearer: other.token, body: JSON.stringify({ unread: false }) }), deps)).status).toBe(404);
  });
});

describe("POST /messages/:id/move (defer + idempotency)", () => {
  it("sets folder_state {desired, pending, us}; emits a move change with meta{from,to}", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });

    const res = await H(req("POST", `/messages/${m.id}/move`, { bearer: s.token, body: JSON.stringify({ folder: "ohmail/News" }) }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toBe("ohmail/News");
    expect(res.headers.get("x-sync-seq")).toBeTruthy();

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m.id));
    // observedFolder preserved (the worker owns it) → the physical IMAP move is deferred.
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" });

    const mv = (await syncBuckets(deps, s.token)).moves.find((x) => x.id === m.id);
    expect(mv?.move).toEqual({ from: "INBOX", to: "ohmail/News" });
  });

  it("idempotent: same key+body → verbatim 200 with no duplicate change; different body → 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });
    const body = JSON.stringify({ folder: "ohmail/News" });

    const first = await H(req("POST", `/messages/${m.id}/move`, { bearer: s.token, headers: { "idempotency-key": "mv1" }, body }), deps);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    const firstSeq = first.headers.get("x-sync-seq");

    // Replay: verbatim body + seq, no second move change.
    const replay = await H(req("POST", `/messages/${m.id}/move`, { bearer: s.token, headers: { "idempotency-key": "mv1" }, body }), deps);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstJson);
    expect(replay.headers.get("x-sync-seq")).toBe(firstSeq);

    const moveChanges = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, s.accountId), eq(changeLog.entityId, m.id), eq(changeLog.op, "move")));
    expect(moveChanges).toHaveLength(1);
    const idem = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId));
    expect(idem).toHaveLength(1);

    // Same key, different body → 409.
    const conflict = await H(req("POST", `/messages/${m.id}/move`, {
      bearer: s.token, headers: { "idempotency-key": "mv1" }, body: JSON.stringify({ folder: "ohmail/Screened" }),
    }), deps);
    expect(conflict.status).toBe(409);
  });

  /**
   * ═══ A REPLAY OF ONE RESTORE INTENT IS ANSWERED AS APPLIED ═══════════════════════════════
   *
   * A restore's response can be lost after the transaction commits — a tab killed inside the
   * held window, a dropped connection — and the surface's durable journal then replays that one
   * intent. The message is no longer in Trash, because the write landed, so the state check
   * answered 409 `not_in_trash` and the surface said "Couldn't restore" about a restore this
   * server was already committed to. The route is `idempotent`-marked and the service claims the
   * key inside its own mutation transaction, so the replay is answered with the first response.
   *
   * A SECOND PRESS carries a NEW key and still meets that state check, which is the half that
   * keeps the 409 meaningful — asserted here, because a fix that answered every restore as
   * applied would satisfy the replay assertion on its own.
   */
  it("restore: a replayed intent replays the 200; a NEW press still meets the state check", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await db.update(mailboxes).set({ trashFolder: "INBOX.Trash" }).where(eq(mailboxes.id, mb));
    const m = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "ohmail/News", observedFolder: "ohmail/News",
    });

    // The delete puts it in Trash and records the origin — the state a restore acts on.
    expect((await H(req("DELETE", `/messages/${m.id}`, { bearer: s.token }), deps)).status).toBe(200);

    const first = await H(req("POST", `/messages/${m.id}/restore`, {
      bearer: s.token, headers: { "idempotency-key": "rs1" },
    }), deps);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson).toEqual({ restoreTo: "ohmail/News", pending: true });
    const firstSeq = first.headers.get("x-sync-seq");

    const replay = await H(req("POST", `/messages/${m.id}/restore`, {
      bearer: s.token, headers: { "idempotency-key": "rs1" },
    }), deps);
    expect(replay.status, "a replayed intent must not 409 about the state it just wrote").toBe(200);
    expect(await replay.json()).toEqual(firstJson);
    expect(replay.headers.get("x-sync-seq")).toBe(firstSeq);

    // ONE effect: the desired folder is the origin, the origin is spent, and no third move row.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m.id));
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", trashedFrom: null });
    const moves = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, s.accountId), eq(changeLog.entityId, m.id), eq(changeLog.op, "move"),
    ));
    // The delete records `op: "delete"`; the restore is the only `move` on this row.
    expect(moves, "the restore ran once — a re-executed replay would record a second").toHaveLength(1);

    // A new press is a new intent, and this message is not in Trash any more.
    const pressed = await H(req("POST", `/messages/${m.id}/restore`, {
      bearer: s.token, headers: { "idempotency-key": "rs2" },
    }), deps);
    expect(pressed.status).toBe(409);
    expect((await pressed.json()).error.code).toBe("not_in_trash");
  });

  it("a folder the mailbox does not list → 422 no_such_folder; a name that is no name → 400; cross-account → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const m = await seedMessage(db, { accountId: owner.accountId, folder: "INBOX" });

    const nope = await H(req("POST", `/messages/${m.id}/move`, { bearer: owner.token, body: JSON.stringify({ folder: "Nope" }) }), deps);
    expect([nope.status, (await nope.json()).error.code]).toEqual([422, "no_such_folder"]);
    for (const folder of [7, "", "a\u0000b"]) {
      expect((await H(req("POST", `/messages/${m.id}/move`, { bearer: owner.token, body: JSON.stringify({ folder }) }), deps)).status).toBe(400);
    }
    expect((await H(req("POST", `/messages/${m.id}/move`, { bearer: other.token, body: JSON.stringify({ folder: "ohmail/News" }) }), deps)).status).toBe(404);
  });
});

/**
 * A MOVE INTO ONE OF THE PERSON'S OWN FOLDERS, on the install that organizes the mailbox. The API
 * writes desired state and opens no mailbox; the folder is taken only when this mailbox lists it
 * and it is the person's own, and never while a folder command overlaps it.
 */
describe("POST /messages/:id/move into a person's own folder", () => {
  async function world() {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, {
      accountId: s.accountId, folders: ["Clients", "Clients/Acme", "Sent", "Trash", "INBOX"].map((folder) => ({ folder })),
    });
    await db.update(mailboxes).set({ sentFolder: "Sent", trashFolder: "Trash" }).where(eq(mailboxes.id, mailboxId));
    const m = await seedMessage(db, { accountId: s.accountId, mailboxId, folder: "INBOX", observedFolder: "INBOX" });
    const move = (body: unknown, key?: string, token = s.token) => H(req("POST", `/messages/${m.id}/move`, {
      bearer: token, body: JSON.stringify(body), ...(key ? { headers: { "idempotency-key": key } } : {}),
    }), deps);
    const placed = async () => (await db.select().from(folderState).where(eq(folderState.messageId, m.id)))[0];
    return { db, deps, s, mailboxId, m, move, placed };
  }

  it("a folder this mailbox lists: 200, the row answers it, desired written, observed kept, one move change", async () => {
    const w = await world();
    const res = await w.move({ folder: "Clients/Acme" });
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toBe("Clients/Acme");
    expect(res.headers.get("x-sync-seq")).toBeTruthy();
    expect(await w.placed()).toMatchObject({ desiredFolder: "Clients/Acme", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" });
    const mv = (await syncBuckets(w.deps, w.s.token)).moves.find((x) => x.id === w.m.id);
    expect(mv?.move).toEqual({ from: "INBOX", to: "Clients/Acme" });
  });

  it("replayed under one key: the stored answer and one move change; and back out to a place as today", async () => {
    const w = await world();
    const first = await w.move({ folder: "Clients" }, "mv-folder");
    const replay = await w.move({ folder: "Clients" }, "mv-folder");
    expect([first.status, replay.status]).toEqual([200, 200]);
    expect(await replay.json()).toEqual(await first.json());
    const moves = await w.db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.s.accountId), eq(changeLog.entityId, w.m.id), eq(changeLog.op, "move")));
    expect(moves).toHaveLength(1);
    expect((await w.move({ folder: "INBOX" })).status).toBe(200);
    expect((await w.placed())!.desiredFolder).toBe("INBOX");
  });

  it("refused before anything is written: not listed or not the person's own 422, busy 409, a rule's press or an odd from 400", async () => {
    const w = await world();
    const [clients] = await w.db.select().from(mailboxFolders).where(and(eq(mailboxFolders.mailboxId, w.mailboxId), eq(mailboxFolders.folder, "Clients")));
    await w.db.insert(folderOps).values({ accountId: w.s.accountId, mailboxId: w.mailboxId, folderId: clients!.id, op: "delete", toFolder: null });
    const cases: Array<[unknown, number, string]> = [
      [{ folder: "Clients/Gone" }, 422, "no_such_folder"],
      [{ folder: "clients/acme" }, 422, "no_such_folder"],
      [{ folder: "Sent" }, 422, "no_such_folder"],
      [{ folder: "Trash" }, 422, "no_such_folder"],
      [{ folder: "inbox" }, 422, "no_such_folder"],
      [{ folder: "ohmail/_meta" }, 422, "no_such_folder"],
      [{ folder: "Clients/Acme" }, 409, "conflict"],
      [{ folder: "Clients/Acme", pressRule: true }, 400, "validation_failed"],
      [{ folder: "Clients/Acme", from: "Clients" }, 400, "validation_failed"],
      [{ folder: "Clients\r\nX" }, 400, "validation_failed"],
    ];
    for (const [body, status, code] of cases) {
      const res = await w.move(body);
      const json = await res.json();
      expect([JSON.stringify(body), res.status, json.error?.code]).toEqual([JSON.stringify(body), status, code]);
      // The sentence never repeats the name it was handed.
      expect(String(json.error?.message)).not.toContain("Clients");
    }
    expect(await w.placed()).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
  });

  it("another account's folder answers exactly as a folder nobody has", async () => {
    const w = await world();
    const stranger = await seedSession(w.db, { now: FIXED_NOW, token: "stranger-tok" });
    await seedMailbox(w.db, { accountId: stranger.accountId, folders: [{ folder: "Theirs" }] });
    const theirs = await w.move({ folder: "Theirs" });
    const nobody = await w.move({ folder: "Nobody/Has/This" });
    expect([theirs.status, (await theirs.json()).error.code]).toEqual([nobody.status, (await nobody.json()).error.code]);
  });
});
