import { describe, it, expect } from "vitest";
import { createApp, apiRoutes } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /screener/waiting/count?mailboxId=` — the waiting senders with held mail in one mailbox,
 * the first-run decide step's count (R20-03). A malformed id is 400, another account's mailbox 404.
 */
const app = createApp(apiRoutes);
const RECENT = new Date(FIXED_NOW.getTime() - 86_400_000);

describe("GET /screener/waiting/count", () => {
  it("answers each mailbox's own waiting senders", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const work = await seedMailbox(db, { accountId: s.accountId, address: "work@fixture.example" });
    const home = await seedMailbox(db, { accountId: s.accountId, address: "home@fixture.example" });
    for (const from of ["one@stranger.example", "two@stranger.example"]) {
      await seedMessage(db, { accountId: s.accountId, mailboxId: work, folder: "ohmail/Screener", fromAddress: from, date: RECENT });
    }
    await seedMessage(db, { accountId: s.accountId, mailboxId: home, folder: "ohmail/Screener", fromAddress: "three@stranger.example", date: RECENT });

    const at = async (id: string) => app.handle(req("GET", `/screener/waiting/count?mailboxId=${id}`, { bearer: s.token }), deps);
    const w = await at(work);
    expect(w.status).toBe(200);
    expect(await w.json()).toEqual({ senders: 2 });
    expect(await (await at(home)).json()).toEqual({ senders: 1 });
  });

  it("400 for a malformed id, 404 for another account's mailbox", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    const theirs = await seedMailbox(db, { accountId: other.accountId, address: "theirs@fixture.example" });
    const bad = await app.handle(req("GET", "/screener/waiting/count?mailboxId=nope", { bearer: s.token }), deps);
    expect(bad.status).toBe(400);
    const foreign = await app.handle(req("GET", `/screener/waiting/count?mailboxId=${theirs}`, { bearer: s.token }), deps);
    expect(foreign.status).toBe(404);
  });
});
