import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";
import { mailboxes } from "@trafficflow/db";
import { eq } from "drizzle-orm";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const DAY = 24 * 60 * 60 * 1000;

/**
 * H1: a person's own verbs replayed after a day offline — open, then delete or
 * archive — reach each route's own answer. A floor refusing on any later change refused the second
 * of them `superseded` after the first one landed. Any `x-decided-at` header a client sends is ignored.
 */
describe("a person's own state verbs replayed in order past a day", () => {
  async function world(subject: string) {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const msg = await seedMessage(db, { accountId: s.accountId, subject });
    const send = (method: string, path: string, body: unknown, key: string, decidedAt: Date) => H(req(method, path, {
      bearer: s.token, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "idempotency-key": key, "x-decided-at": decidedAt.toISOString() },
    }), deps);
    return { msg, send };
  }
  const answer = async (r: Response) => `${r.status}:${(await r.json().catch(() => ({}))).error?.code ?? ""}`;

  it("open then delete, and open then archive: neither is refused superseded", async () => {
    const opened = new Date(Date.now() - DAY - 3_600_000);
    const later = new Date(opened.getTime() + 5_000);
    const a = await world("Invoice 41");
    expect((await a.send("PATCH", "/messages", { ids: [a.msg.id], unread: false }, "k-seen", opened)).status).toBe(200);
    const del = await answer(await a.send("DELETE", `/messages/${a.msg.id}`, undefined, "k-del", later));
    const b = await world("Invoice 43");
    expect((await b.send("PATCH", "/messages", { ids: [b.msg.id], unread: false }, "k-seen3", opened)).status).toBe(200);
    const mv = await answer(await b.send("POST", `/messages/${b.msg.id}/move`, { folder: "Archive" }, "k-mv3", later));
    // The routes' own answers in this fixture (no Trash folder; no Archive folder) — never `superseded`.
    expect({ del, mv }).toEqual({ del: "422:no_trash_folder", mv: "422:no_such_folder" });
  });
});

/**
 * ACCEPTANCE A, with the press age the client now sends: open then archive, open then delete, each
 * pair pressed a second apart and replayed at 25 h. Different fields, so neither floor refuses the
 * other; the absent-header arm above stays the deploy-window control.
 */
describe("the same pairs carrying their press ages", () => {
  async function world(subject: string) {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, accessExpiresAt: new Date(FIXED_NOW.getTime() + 30 * 60 * 60 * 1000) });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await db.update(mailboxes).set({ trashFolder: "INBOX.Trash" }).where(eq(mailboxes.id, mb));
    const msg = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, subject, folder: "INBOX" });
    const pressed = clock.now().getTime();
    clock.advance(DAY + 3_600_000);
    const send = (method: string, path: string, body: unknown, key: string, offsetMs: number) => H(req(method, path, {
      bearer: s.token, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "idempotency-key": key, "x-ohmail-press-age": String(clock.now().getTime() - pressed - offsetMs) },
    }), deps);
    return { msg, send };
  }

  it("open then delete, and open then archive: both land", async () => {
    const a = await world("Invoice 44");
    expect((await a.send("PATCH", "/messages", { ids: [a.msg.id], unread: false }, "k-seen", 0)).status).toBe(200);
    expect((await a.send("DELETE", `/messages/${a.msg.id}`, undefined, "k-del", 5_000)).status).toBe(200);
    const b = await world("Invoice 45");
    expect((await b.send("PATCH", "/messages", { ids: [b.msg.id], unread: false }, "k-seen", 0)).status).toBe(200);
    expect((await b.send("POST", `/messages/${b.msg.id}/move`, { folder: "ohmail/Receipts" }, "k-mv", 5_000)).status).toBe(200);
  });
});
