import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { eq, sql } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { changeLog, messages } from "@trafficflow/db";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * A write answers `X-Sync-Seq`: the highest change_log seq it committed, which is the seq `/sync`
 * delivers that change at, so a client that applies the answer treats the delta at that seq as a
 * no-op. A same-key retry answers the same number; a write that commits no change answers none.
 * The header is set by `jsonResponse` (responses.ts), by hand on three 204s (drafts, tags,
 * mailboxes) and on replay by `storedResponse` (idempotency.ts).
 * Mutations that turn this red: drop the header in `jsonResponse`; replay `seq: undefined`; answer
 * seq+1 on the draft DELETE or seq-1 on the tag DELETE (no other test notices either).
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

type Delivered = { id: string; type: string; seq: number };
async function delivered(deps: ApiDeps, token: string): Promise<Delivered[]> {
  const res = await H(req("GET", "/sync?since=0", { bearer: token }), deps);
  expect(res.status).toBe(200);
  const b = await res.json();
  return [...b.changes.creates, ...b.changes.updates, ...b.changes.moves, ...b.changes.deletes];
}
const echoOf = (res: Response): number | null => {
  const raw = res.headers.get("x-sync-seq");
  return raw === null ? null : Number(raw);
};
type Db = Awaited<ReturnType<typeof makeDeps>>["db"];
async function lastSeq(db: Db, accountId: string): Promise<number> {
  const [r] = await db.select({ m: sql<string>`max(${changeLog.seq})` }).from(changeLog).where(eq(changeLog.accountId, accountId));
  return Number(r!.m);
}

describe("X-Sync-Seq is the seq /sync delivers the write at", () => {
  it("move (jsonResponse)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });
    const res = await H(req("POST", `/messages/${m.id}/move`, { bearer: s.token, body: JSON.stringify({ folder: "ohmail/News" }) }), deps);
    expect(res.status).toBe(200);
    const echo = echoOf(res);
    const mine = (await delivered(deps, s.token)).filter((c) => c.id === m.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(echo).toBe(Math.max(...mine.map((c) => c.seq)));
    expect(echo).toBe(await lastSeq(db, s.accountId));
  });

  it("batch read state: the LAST seq the batch committed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const a = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: true });
    const b = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: true });
    const res = await H(req("PATCH", "/messages", { bearer: s.token, body: JSON.stringify({ ids: [a.id, b.id], unread: false }) }), deps);
    expect(res.status).toBe(200);
    const echo = echoOf(res);
    const mine = (await delivered(deps, s.token)).filter((c) => c.id === a.id || c.id === b.id);
    expect(new Set(mine.map((c) => c.id)).size).toBe(2);
    expect(echo).toBe(Math.max(...mine.map((c) => c.seq)));
    expect(mine.every((c) => c.seq <= echo!)).toBe(true);
  });

  it("draft create and delete (the 204 builds its header by hand)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const created = await H(req("POST", "/drafts", { bearer: s.token, body: JSON.stringify({ mailboxId, subject: "Hello" }) }), deps);
    expect(created.status).toBe(201);
    const draft = await created.json();
    expect(echoOf(created)).toBe(await lastSeq(db, s.accountId));
    const del = await H(req("DELETE", `/drafts/${draft.id}`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);
    const echo = echoOf(del);
    const mine = (await delivered(deps, s.token)).filter((c) => c.id === draft.id);
    expect(echo).toBe(Math.max(...mine.map((c) => c.seq)));
    expect(echo).toBe(await lastSeq(db, s.accountId));
  });

  it("tag create, then delete (hand-built header)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const made = await H(req("POST", "/tags", { bearer: s.token, body: JSON.stringify({ name: "Invoices" }) }), deps);
    expect(made.status).toBe(201);
    const tag = await made.json();
    expect(echoOf(made)).toBe(await lastSeq(db, s.accountId));
    const gone = await H(req("DELETE", `/tags/${tag.id}`, { bearer: s.token }), deps);
    expect(gone.status).toBe(204);
    const mine = (await delivered(deps, s.token)).filter((c) => c.id === tag.id);
    expect(echoOf(gone)).toBe(Math.max(...mine.map((c) => c.seq)));
    expect(echoOf(gone)).toBe(await lastSeq(db, s.accountId));
  });

  it("a same-key retry answers the same seq and commits nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const body = JSON.stringify({ kind: "sender", match: "a@b.example", destination: "INBOX" });
    const first = await H(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "r1" }, body }), deps);
    expect(first.status).toBe(201);
    const before = await lastSeq(db, s.accountId);
    expect(echoOf(first)).toBe(before);
    const again = await H(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "r1" }, body }), deps);
    expect(echoOf(again)).toBe(echoOf(first));
    expect(await lastSeq(db, s.accountId)).toBe(before);
  });

  it("a write that commits no change answers no seq", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/kb", { bearer: s.token, body: JSON.stringify({ title: "Refunds", content: "30 days" }) }), deps);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-sync-seq")).toBeNull();
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    const refused = await H(req("POST", `/messages/${m.id}/move`, { bearer: s.token, body: JSON.stringify({ folder: "Nope" }) }), deps);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("x-sync-seq")).toBeNull();
    // A delete of a letter already gone from the server writes nothing and says so.
    const ghost = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await db.update(messages).set({ deletedAt: FIXED_NOW }).where(eq(messages.id, ghost.id));
    const before = await lastSeq(db, s.accountId);
    const gone = await H(req("DELETE", `/messages/${ghost.id}`, { bearer: s.token }), deps);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ id: ghost.id, alreadyGone: true });
    expect(gone.headers.get("x-sync-seq")).toBeNull();
    expect(await lastSeq(db, s.accountId)).toBe(before);
  });

  it("the header is spelled out in these four files only (a replay goes through jsonResponse)", () => {
    const src = resolve(__dirname, "../src");
    const files: string[] = [];
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(src);
    const writers = files.filter((f) => /["'`]x-sync-seq["'`]/i.test(withoutComments(readFileSync(f, "utf8"))))
      .map((f) => relative(src, f).split("\\").join("/")).sort();
    expect(writers).toEqual(["responses.ts", "routes/drafts.ts", "routes/mailboxes.ts", "routes/tags.ts"]);
  });
});
