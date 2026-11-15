import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, organizerRequests, accounts } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { makeDeps, seedMessage, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /organizer-requests` — WHAT WAITS ON THE ORGANIZER, one list for every surface (gap rows
 * NO-STANDING-LIST-OF-WHAT-WAITS-ON-THE-ORGANIZER and LB2-RULE-DELETE-204-HIDES-PENDING). This
 * account's rows only, the target projected per kind and never the stored payload; a refusal and
 * an ending are listed for a day, then dropped.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const HOUR = 3_600_000;

async function world() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "reader@shop.test", organizerRole: "reader",
    organizerState: "held", organizedByCapabilities: "requests,rules,moves,profile", organizedByKind: "local", organizedByName: "Laptop",
  }).returning();
  const add = async (over: Partial<typeof organizerRequests.$inferInsert> & { kind: string; payload: unknown }) => {
    const id = randomUUID();
    await db.insert(organizerRequests).values({
      id, accountId: s.accountId, mailboxId: mb!.id, decidedAt: new Date(FIXED_NOW.getTime() - HOUR), state: "sent", ...over,
    });
    return id;
  };
  const list = async () => {
    const res = await H(req("GET", "/organizer-requests", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    return (await res.json()).items as Array<Record<string, unknown>>;
  };
  return { db, deps, s, mb: mb!, add, list };
}

describe("GET /organizer-requests", () => {
  it("is on both route tables — Cloud and the desktop's own door serve one list", () => {
    const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
    expect(apiRoutes.map(key)).toContain("GET /organizer-requests");
    expect(localRoutes.map(key)).toContain("GET /organizer-requests");
  });

  it("lists a waiting rule removal with its key and who holds the mailbox", async () => {
    const w = await world();
    const id = await w.add({ kind: "rule.delete", payload: {
      key: { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null },
    } });
    expect(await w.list()).toEqual([expect.objectContaining({
      id, kind: "rule.delete", state: "sent", holder: { name: "Laptop" }, refusedReason: null,
      target: { rule: { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null } },
    })]);
  });

  it("a mixed account's removal answers 204 and its request to the other install is in the list", async () => {
    const w = await world();
    await w.db.insert(mailboxes).values({ accountId: w.s.accountId, provider: "imap", address: "own@shop.test" });
    const made = await H(req("POST", "/rules", { bearer: w.s.token, body: JSON.stringify({ kind: "sender", match: "ann@shop.example", destination: "ohmail/News" }) }), w.deps);
    const id = (await made.json()).id as string;
    expect((await H(req("DELETE", `/rules/${id}`, { bearer: w.s.token }), w.deps)).status).toBe(204);
    // The create travelled too (a mixed account writes here AND asks there); the removal is the row.
    expect((await w.list()).filter((i) => i.kind === "rule.delete")).toEqual([expect.objectContaining({
      kind: "rule.delete", holder: { name: "Laptop" }, target: expect.objectContaining({ rule: expect.objectContaining({ match: "ann@shop.example" }) }),
    })]);
  });

  it("a refusal is listed with its reason for a day, and an older one is not", async () => {
    const w = await world();
    const recent = await w.add({ kind: "rule.delete", state: "refused", refusedReason: "no_such_rule", resolvedAt: new Date(FIXED_NOW.getTime() - HOUR),
      payload: { key: { kind: "sender", match: "a@x.example", subjectContains: null, bodyContains: null } } });
    await w.add({ kind: "rule.delete", state: "refused", refusedReason: "no_such_rule", resolvedAt: new Date(FIXED_NOW.getTime() - 25 * HOUR),
      payload: { key: { kind: "sender", match: "b@x.example", subjectContains: null, bodyContains: null } } });
    const items = await w.list();
    expect(items.map((i) => i.id)).toEqual([recent]);
    expect(items[0]).toMatchObject({ state: "refused", refusedReason: "no_such_rule" });
  });

  it("an applied request is listed while recent, so a client holding it learns it is over", async () => {
    const w = await world();
    const done = await w.add({ kind: "rule.update", state: "applied", resolvedAt: new Date(FIXED_NOW.getTime() - HOUR),
      payload: { key: { kind: "sender", match: "a@x.example", subjectContains: null, bodyContains: null }, set: { destination: "receipts" } } });
    expect(await w.list()).toEqual([expect.objectContaining({ id: done, state: "applied", target: expect.objectContaining({ destination: "ohmail/Receipts" }) })]);
  });

  it("a settings change lists its field names and never the text it carries", async () => {
    const w = await world();
    await w.add({ kind: "profile.update", payload: { signature: "Kind regards, A. Secret" } });
    const items = await w.list();
    expect(items[0]!.target).toEqual({ fields: ["signature"] });
    expect(JSON.stringify(items), "the stored payload reached the wire").not.toContain("Secret");
  });

  it("a move names this install's own message by the key both share", async () => {
    const w = await world();
    const m = await seedMessage(w.db, { accountId: w.s.accountId, mailboxId: w.mb.id, dedupKey: "mid:k1@x" });
    await w.add({ kind: "message.move", payload: { dedupKey: "mid:k1@x", destination: "reads" } });
    expect((await w.list())[0]!.target).toEqual({ messageId: m!.id, folder: "ohmail/News" });
  });

  it("a move into a person's own folder names the message and the folder, refused or not; an unreadable folder is none", async () => {
    const w = await world();
    const m = await seedMessage(w.db, { accountId: w.s.accountId, mailboxId: w.mb.id, dedupKey: "mid:k2@x" });
    await w.add({ kind: "message.file", state: "refused", refusedReason: "no_such_folder", resolvedAt: new Date(FIXED_NOW.getTime() - HOUR),
      payload: { dedupKey: "mid:k2@x", folder: "Clients/Acme" } });
    await w.add({ kind: "message.file", payload: { dedupKey: "mid:k2@x", folder: "a\r\nb" } });
    const items = await w.list();
    expect(items.map((i) => [i.kind, i.target, i.refusedReason]).sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual([
      ["message.file", { messageId: m!.id, folder: "Clients/Acme" }, "no_such_folder"],
      ["message.file", { messageId: m!.id, folder: null }, null],
    ]);
  });

  it("another account's rows are never in the list (and the list is not empty for nothing)", async () => {
    const w = await world();
    const other = randomUUID();
    await w.db.insert(accounts).values({ id: other, name: "other" });
    const [omb] = await w.db.insert(mailboxes).values({ accountId: other, provider: "imap", address: "o@o.test" }).returning();
    await w.db.insert(organizerRequests).values({ id: randomUUID(), accountId: other, mailboxId: omb!.id, kind: "rule.delete",
      payload: { key: { kind: "sender", match: "z@z.example" } }, decidedAt: FIXED_NOW, state: "sent" });
    const mine = await w.add({ kind: "rule.delete", payload: { key: { kind: "sender", match: "a@x.example", subjectContains: null, bodyContains: null } } });
    expect((await w.list()).map((i) => i.id)).toEqual([mine]);
  });
});
