import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * ═══ `GET /search?address=&direction=` — THE ADDRESS ARM'S HTTP SURFACE ═══════════════════
 *
 * Four things this door has to get right, and two of them are refusals:
 *
 *  1. IT IS AN EQUALITY. A substring of the address matches nothing. That is asserted from the
 *     substring side rather than only from the exact side, because the failure mode is not "no
 *     results" — it is somebody else's mail on screen under this person's name.
 *  2. EVERY DIRECTION IS ANSWERED, and says which it answered: `from` the sender, `to` To and
 *     Cc (mail 0154's recipient index), `any` the union.
 *  3. AN ABSENT OR UNKNOWN `direction` IS A 400, never a default. There is no direction this
 *     door can safely assume — see the route's own header.
 *  4. IT IS ACCOUNT-SCOPED, and that is not a formality here: a sender address is
 *     attacker-choosable, so anybody can cause a row bearing any `from_address` to exist in
 *     their own account. The scope is what keeps this from being a cross-account read.
 *
 * The POSITIVE CONTROL is first and is asserted by its effect (the seeded id comes back), because
 * every other case in this file asserts a refusal or an absence — and a guard whose every case
 * is a refusal has no evidence it admits the right person.
 */
describe("GET /search?address= — one correspondent, from the archive", () => {
  it("returns every message from the address, newest first, and nothing else", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    const older = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "First", fromAddress: "info@acme.test",
      date: new Date(FIXED_NOW.getTime() - 86_400_000),
    });
    const newer = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Second", fromAddress: "info@acme.test", date: FIXED_NOW,
    });
    const somebodyElse = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Unrelated", fromAddress: "bob@acme.test", date: FIXED_NOW,
    });

    const res = await H(req("GET", "/search?address=info@acme.test&direction=from", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    // NEWEST FIRST, and both of hers — the order is the view's and is asserted, not assumed.
    expect(body.items.map((m: { id: string }) => m.id)).toEqual([newer.id, older.id]);
    expect(body.items.map((m: { id: string }) => m.id)).not.toContain(somebodyElse.id);
    // `total` is over the whole archive in the answered direction, not over the page.
    expect(body.total).toBe(2);
    // The direction is ON THE WIRE. A client whose toggle says "All" receives these same rows
    // and can only label them honestly by reading this.
    expect(body.direction).toBe("from");
  });

  it("folds case on both sides — the stored spelling and the asked one", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    // Stored with capitals, as a sending server delivered it.
    const m = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Mixed", fromAddress: "Info@ACME.test", date: FIXED_NOW,
    });

    for (const asked of ["info@acme.test", "INFO@ACME.TEST", "Info@ACME.test"]) {
      const res = await H(
        req("GET", `/search?address=${encodeURIComponent(asked)}&direction=from`, { bearer: s.token }),
        deps,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.map((x: { id: string }) => x.id)).toEqual([m.id]);
    }
  });

  it("is an EQUALITY — a substring of the address matches nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Hers", fromAddress: "info@acme.test", date: FIXED_NOW,
    });

    // Every shape a `like '%…%'` would have matched: a prefix, a suffix, the local part, the
    // domain, and a longer address CONTAINING the seeded one.
    for (const near of [
      "info@acme.tes", "nfo@acme.test", "info", "acme.test", "info@acme.test.evil",
    ]) {
      const res = await H(
        req("GET", `/search?address=${encodeURIComponent(near)}&direction=from`, { bearer: s.token }),
        deps,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(0);
      expect(body.total).toBe(0);
    }
  });

  it("answers `to` and `any` from the recipients, with the direction echoed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const sent = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Hers", fromAddress: "info@acme.test", date: new Date(FIXED_NOW.getTime() - 3_600_000),
    });
    const toHer = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "To her", fromAddress: "bob@acme.test", date: FIXED_NOW,
    });
    await db.update(messages).set({ ccAddresses: [{ name: null, address: "Info@ACME.test" }] }).where(eq(messages.id, toHer.id));

    const ask = async (direction: string) => {
      const res = await H(req("GET", `/search?address=info@acme.test&direction=${direction}`, { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      return res.json() as Promise<{ items: Array<{ id: string }>; total: number; direction: string }>;
    };
    const to = await ask("to");
    expect(to.items.map((m) => m.id)).toEqual([toHer.id]);
    expect(to.total).toBe(1);
    expect(to.direction).toBe("to");
    const any = await ask("any");
    expect(any.items.map((m) => m.id)).toEqual([toHer.id, sent.id]);
    expect(any.total).toBe(2);
    expect(any.direction).toBe("any");
  });

  it("refuses an ABSENT direction, and an unknown one, rather than defaulting", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Hers", fromAddress: "info@acme.test", date: FIXED_NOW,
    });

    // Absent. Defaulting to `from` here would answer `direction=to`'s question — "mail I sent to
    // this person" — with mail they sent to ME, which is a different answer, not a partial one.
    const absent = await H(req("GET", "/search?address=info@acme.test", { bearer: s.token }), deps);
    expect(absent.status).toBe(400);
    expect((await absent.json()).error.code).toBe("validation_failed");

    // Unknown, and a near-miss a client could plausibly send.
    for (const bogus of ["From", "sender", "both", ""]) {
      const res = await H(
        req("GET", `/search?address=info@acme.test&direction=${encodeURIComponent(bogus)}`, { bearer: s.token }),
        deps,
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_failed");
    }
  });

  it("is ACCOUNT-SCOPED — another account's mail from the same address is not returned", async () => {
    // A sender address is attacker-choosable: anybody can cause a row with any `from_address` to
    // exist in their own account. So the scope is the whole security property of this door, and
    // it is asserted with the SAME address on both sides rather than with two different ones.
    const { db, deps } = await makeDeps();
    const mine = await seedSession(db, { now: FIXED_NOW });
    const theirs = await seedSession(db, { now: FIXED_NOW });
    const myBox = await seedMailbox(db, { accountId: mine.accountId });
    const theirBox = await seedMailbox(db, { accountId: theirs.accountId });

    const myRow = await seedMessage(db, {
      accountId: mine.accountId, mailboxId: myBox, folder: "INBOX",
      subject: "Mine", fromAddress: "info@acme.test", date: FIXED_NOW,
    });
    const theirRow = await seedMessage(db, {
      accountId: theirs.accountId, mailboxId: theirBox, folder: "INBOX",
      subject: "Theirs", fromAddress: "info@acme.test", date: FIXED_NOW,
    });

    const res = await H(req("GET", "/search?address=info@acme.test&direction=from", { bearer: mine.token }), deps);
    const body = await res.json();
    expect(body.items.map((m: { id: string }) => m.id)).toEqual([myRow.id]);
    expect(body.items.map((m: { id: string }) => m.id)).not.toContain(theirRow.id);
    expect(body.total).toBe(1);
  });

  it("an EMPTY address answers empty — not the rows whose From header is blank", async () => {
    // `messages.from_address` is `NOT NULL DEFAULT ''`, so a blank From is a real row. A caller
    // reaches this by handing the door an address it failed to parse, and the honest answer to
    // "show me everything from nobody" is nothing at all.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Headerless", fromAddress: "", date: FIXED_NOW,
    });

    for (const blank of ["", "%20%20"]) {
      const res = await H(req("GET", `/search?address=${blank}&direction=from`, { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(0);
      expect(body.total).toBe(0);
    }
  });

  it("`address` selects this arm even beside a `q` — it is a different question", async () => {
    // A caller that sends both gets the ADDRESS answer, which is the one it named a value for.
    // The alternative — `q` winning — would silently run a text search for a word the caller did
    // not ask about and return rows from other senders.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const hers = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Nothing in common", fromAddress: "info@acme.test", date: FIXED_NOW,
    });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "invoice", fromAddress: "bob@acme.test", date: FIXED_NOW,
    });

    const res = await H(
      req("GET", "/search?q=invoice&address=info@acme.test&direction=from", { bearer: s.token }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((m: { id: string }) => m.id)).toEqual([hers.id]);
    // The address answer's shape, not the text search's — no facets, and a direction.
    expect(body.direction).toBe("from");
    expect(body.facets).toBeUndefined();
  });

  it("requires a session — the arm is behind the default pipeline like the rest of /search", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/search?address=info@acme.test&direction=from"), deps);
    expect(res.status).toBe(401);
  });
});
