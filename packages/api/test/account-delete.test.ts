import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { accounts, mailboxCredentials, mailboxes, messages, users } from "@trafficflow/db";
import {
  UNMETERED_ACCESS, type EntitlementsPort, type ReleaseOutcome,
} from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { authThrottle, creditRefundObligations } from "@trafficflow/db/cloud";
import { throttleKeysFor } from "@trafficflow/services";
import {
  makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW,
  setCookieMap,
} from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * `DELETE /account` — the HTTP half of Art. 17 erasure. The erasure itself is
 * covered exhaustively in `packages/services/test/account-deletion.test.ts`
 * (including the catalog sweep that fails when a new account-scoped table appears);
 * what is asserted here is the ROUTE: that it exists, that it is step-up gated, and
 * that a caller cannot reach anyone else's account through it.
 */
describe("DELETE /account", () => {
  it("erases the caller's account and reports what went", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX" });

    const res = await H(req("DELETE", "/account", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.erased).toBe(true);
    expect(body.usersErased).toBeGreaterThanOrEqual(1);
    expect(body.tables.messages).toBe(1);

    expect(await db.select().from(users).where(eq(users.accountId, s.accountId))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.accountId, s.accountId))).toHaveLength(0);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.accountId, s.accountId))).toHaveLength(0);
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);

    // The account row survives as a pseudonymous subject, blank.
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, s.accountId));
    expect(acct).toBeDefined();
    expect(acct!.name).toBe("");
  });

  it("is step-up gated — a session without a recent second factor cannot erase", async () => {
    const { db, deps } = await makeDeps();
    // A session that authenticated long ago: valid for reads, not for this.
    const stale = new Date(FIXED_NOW.getTime() - 1000 * 60 * 60 * 24);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: stale });

    const res = await H(req("DELETE", "/account", { bearer: s.token }), deps);
    expect(res.status).toBe(403);
    expect(await db.select().from(users).where(eq(users.accountId, s.accountId))).toHaveLength(1);
  });

  it("requires a session at all", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("DELETE", "/account"), deps);
    expect(res.status).toBe(401);
  });

  /**
   * The session that authorised the erasure must not survive it.
   *
   * This is what the deletion screen promises out loud ("you are signed out on every
   * device"), so it is pinned here rather than left to `resolveSession`'s INNER JOIN being
   * noticed by the next reader. It also has a second job: `Set-Cookie` clearing the three
   * cookies. `tf_session` is `HttpOnly`, so no client can clear it — a browser that kept
   * presenting an inert token would burn an edge invocation and a cross-host session fetch
   * on every visit to `/` (the gate) until the TTL expired.
   */
  it("kills the session it was called with, and clears the cookies", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const res = await H(req("DELETE", "/account", { bearer: s.token }), deps);
    expect(res.status).toBe(200);

    const cookies = setCookieMap(res);
    // `tf_resume` included: erasure must not leave a marker that keeps routing the browser
    // to a resume splash for an account that no longer exists.
    //
    // `tf_owner` for the same reason and a sharper one: it is the account id the web client
    // opens a local mail mirror from BEFORE it asks who is signed in. Left behind after an
    // erasure it would name a database, and an account, that no longer exist.
    expect(Object.keys(cookies).sort()).toEqual(["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"]);
    for (const raw of res.headers.getSetCookie()) expect(raw).toMatch(/Max-Age=0/);

    // The token is not merely expired-looking: nothing resolves it any more.
    const after = await H(req("GET", "/auth/session", { bearer: s.token }), deps);
    expect(after.status).toBe(401);
  });

  /**
   * The sign-in throttle names a person by a keyed hash of their address, which no join builds in
   * SQL: the route hands the erasure the keyer. The rows are the sign-in door's own, from a
   * refused password.
   */
  it("takes the sign-in throttle's rows for the person's address, and leaves another person's", async () => {
    const { db, deps } = await makeDeps();
    const mine = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const theirs = await seedSession(db, { now: FIXED_NOW });
    const keys = throttleKeysFor(deps.keyProvider);
    const hashOf = async (userId: string): Promise<string> => {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      const refused = await H(req("POST", "/auth/login", {
        body: JSON.stringify({ email: u!.email, password: "not the password" }),
      }), deps);
      expect(refused.status).toBe(401);
      return keys.address(u!.email.trim().toLowerCase());
    };
    const naming = async (hash: string): Promise<number> =>
      (await db.select({ key: authThrottle.key }).from(authThrottle)).filter((r) => r.key.includes(hash)).length;
    const mineHash = await hashOf(mine.userId);
    const theirsHash = await hashOf(theirs.userId);
    expect(await naming(mineHash), "the refused sign-in wrote no row to erase").toBeGreaterThan(0);
    const theirsBefore = await naming(theirsHash);
    expect(theirsBefore).toBeGreaterThan(0);

    expect((await H(req("DELETE", "/account", { bearer: mine.token }), deps)).status).toBe(200);
    expect(await naming(mineHash), "a throttle row still names the erased person's address").toBe(0);
    expect(await naming(theirsHash), "another person's throttle rows went").toBe(theirsBefore);
  });

  /**
   * THE MONEY. Erasure stops the charge through the entitlements port, OUTSIDE the erasure
   * transaction, and erases regardless of the answer. Before that existed a customer who deleted
   * their account kept being charged, with no session left to cancel with.
   *
   * The ORDER is the property, and so is the direction of every failure: a fault in the money
   * path answers `cancel_failed` and the erasure still happens. Art. 17 is not a favour.
   */
  describe("stopping the money", () => {
    /** A port that answers one outcome, or throws — the two shapes the route must survive. */
    const portStub = (outcome: ReleaseOutcome | "throw", log: string[]): EntitlementsPort => ({
      async access() { return UNMETERED_ACCESS; },
      async accessOrFault() { return UNMETERED_ACCESS; },
      async spend() { return { verdict: "fault" }; },
      async release(): Promise<"settled"> { /* nothing to release in these cases */ return "settled"; },
      async manageLink() { return null; },
      async releaseAccount(accountId: string) {
        log.push(`release:${accountId.length === 36 ? "uuid" : accountId}`);
        if (outcome === "throw") throw new Error("the entitlements program is unreachable");
        return outcome;
      },
    });

    it("is stopped BEFORE the erasure, and the outcome is reported", async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const log: string[] = [];
      const d = {
        ...deps,
        services: { ...deps.services, entitlementsPort: portStub("cancelled", log) },
      };

      const res = await H(req("DELETE", "/account", { bearer: s.token }), d as ApiDeps);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.subscription).toBe("cancelled");
      // The control for the unmetered case below: a host with a billing program keeps billing
      // records, and says a refund still owed is kept too.
      expect(body.retained).toBe("billing records and any refund still owed to you, under a pseudonymous account id");
      expect(log).toEqual(["release:uuid"]);
      expect(await db.select().from(users).where(eq(users.accountId, s.accountId))).toHaveLength(0);
    });

    it("a fault does NOT block the erasure — Art. 17 is not a favour", async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const d = {
        ...deps,
        services: { ...deps.services, entitlementsPort: portStub("throw", []) },
      };

      // `releaseAccount` is documented never to throw. This stub throws ANYWAY, because the
      // property being asserted is the ROUTE's: a rejection inside the money path must not
      // become a 500 in front of `deleteAccount` — that would be an Art. 17 erasure refused by
      // a payment integration.
      const res = await H(req("DELETE", "/account", { bearer: s.token }), d as ApiDeps);
      expect(res.status).toBe(200);
      expect((await res.json()).subscription).toBe("cancel_failed");
      expect(await db.select().from(users).where(eq(users.accountId, s.accountId))).toHaveLength(0);
    });

    it("an UNMETERED host reports `none` and still erases", async () => {
      // The self-host and standalone state: there is nothing to stop, and `none` is the truth.
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      expect(deps.services?.entitlementsPort).toBeUndefined();

      const res = await H(req("DELETE", "/account", { bearer: s.token }), deps);
      const body = await res.json();
      expect(body.subscription).toBe("none");
      // What it keeps is what the erasure leaves on a server with no billing: no billing record to name.
      expect(body.retained).toMatch(/account row/);
      expect(body.retained).not.toMatch(/bill|credit|subscri|stripe|payment|ledger/i);
      expect(await db.select().from(users).where(eq(users.accountId, s.accountId))).toHaveLength(0);
    });

    /** One pending and one settled refund obligation for the account. */
    async function owe(db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string) {
      await db.insert(creditRefundObligations).values([
        { accountId, action: "draft", attemptKey: "ak-p", attempt: "at-p", reason: "drafter_failed", meta: { n: 1 } },
        { accountId, action: "draft", attemptKey: "ak-s", attempt: "at-s", reason: "drafter_failed", settledAt: FIXED_NOW },
      ]);
    }
    const left = async (db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string) =>
      (await db.select().from(creditRefundObligations).where(eq(creditRefundObligations.accountId, accountId)))
        .map((r) => [r.attempt, r.meta]);

    it("a metered host keeps a refund still owed, pseudonymised, and reports it", async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      await owe(db, s.accountId);
      const d = { ...deps, services: { ...deps.services, entitlementsPort: portStub("cancelled", []) } };

      const res = await H(req("DELETE", "/account", { bearer: s.token }), d as ApiDeps);
      const body = await res.json();
      expect(body.retainedPending).toBe(1);
      expect(await left(db, s.accountId)).toEqual([["at-p", null]]);
    });

    it("an UNMETERED host keeps no debt: nothing drains it there, so it goes with the rest", async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      await owe(db, s.accountId);
      expect(deps.services?.entitlementsPort).toBeUndefined();

      const res = await H(req("DELETE", "/account", { bearer: s.token }), deps);
      const body = await res.json();
      expect(body.retainedPending).toBe(0);
      expect(body.tables.credit_refund_obligations).toBe(2);
      expect(await left(db, s.accountId)).toEqual([]);
    });

    /**
     * THE ERASURE FAILS AFTER THE RELEASE. The erasure's own transaction is made to reject once with a
     * database error code, the way a real one arrives from the driver. The answer must carry what the
     * release already did, say whether a retry can succeed, and clear nothing: the session that
     * pressed delete is the one the retry needs.
     */
    async function failingErasure(code: string | undefined) {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const holder = db as unknown as { transaction: (...a: unknown[]) => unknown };
      const real = holder.transaction;
      let opened = 0;
      Object.defineProperty(holder, "transaction", {
        configurable: true, writable: true,
        value: (...a: unknown[]) => {
          opened += 1;
          if (opened === 1) return Promise.reject(Object.assign(new Error("the erasure's transaction failed"), code === undefined ? {} : { code }));
          return (real as (...x: unknown[]) => unknown).apply(holder, a);
        },
      });
      const d = { ...deps, services: { ...deps.services, entitlementsPort: portStub("cancelled", []) } };
      const res = await H(req("DELETE", "/account", { bearer: s.token }), d as ApiDeps);
      Object.defineProperty(holder, "transaction", { configurable: true, writable: true, value: real });
      const after = await H(req("GET", "/auth/session", { bearer: s.token }), d as ApiDeps);
      return { db, s, res, opened, after };
    }

    for (const code of ["40P01", "55P03", "57014"]) {
      it(`a ${code} answers 503 erasure_contended with the release outcome, retryable, and no cookie`, async () => {
        const { db, s, res, opened, after } = await failingErasure(code);
        expect(opened, "the erasure was the request's one transaction").toBe(1);
        expect(res.status).toBe(503);
        const body = await res.json() as { error: { code: string; details?: { subscription?: string }; retryable?: boolean } };
        expect(body.error.code).toBe("erasure_contended");
        expect(body.error.details?.subscription).toBe("cancelled");
        expect(body.error.retryable).toBe(true);
        expect(res.headers.getSetCookie(), "no cookie is cleared on a failure").toEqual([]);
        expect(after.status, "the session that pressed delete still resolves").toBe(200);
        expect(await db.select().from(users).where(eq(users.accountId, s.accountId))).toHaveLength(1);
      });
    }

    it("any other failure answers 500 erasure_failed with the same outcome and no cookie", async () => {
      const { res, after } = await failingErasure(undefined);
      expect(res.status).toBe(500);
      const body = await res.json() as { error: { code: string; details?: { subscription?: string }; retryable?: boolean } };
      expect(body.error.code).toBe("erasure_failed");
      expect(body.error.details?.subscription).toBe("cancelled");
      expect(body.error.retryable).toBeUndefined();
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(after.status).toBe(200);
    });

    /**
     * AN ANSWER LOST AFTER THE COMMIT WENT OUT. The connection breaks after the erasure's commit
     * was sent, so its caller sees a failure for an erasure that may have landed. The route asks
     * the account row before it says "not deleted": a stamp is a committed erasure, and its receipt
     * is answered; a read that cannot be made says the outcome is unconfirmed, never "not deleted".
     */
    async function lostAnswer(o: { commits: boolean; readFails: boolean }) {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const holder = db as unknown as { transaction: (...a: unknown[]) => unknown; select: (...a: unknown[]) => unknown };
      const real = holder.transaction;
      const realSelect = holder.select;
      const lost = Object.assign(new Error("write CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" });
      let opened = 0; let readArmed = false;
      Object.defineProperty(holder, "transaction", {
        configurable: true, writable: true,
        value: (...a: unknown[]) => {
          opened += 1;
          if (opened !== 1) return (real as (...x: unknown[]) => unknown).apply(holder, a);
          readArmed = o.readFails;
          return o.commits
            ? (real as (...x: unknown[]) => Promise<unknown>).apply(holder, a).then(() => Promise.reject(lost))
            : Promise.reject(lost);
        },
      });
      Object.defineProperty(holder, "select", {
        configurable: true, writable: true,
        value: (...a: unknown[]) => {
          if (readArmed) { readArmed = false; throw new Error("the connection is gone"); }
          return (realSelect as (...x: unknown[]) => unknown).apply(holder, a);
        },
      });
      const d = { ...deps, services: { ...deps.services, entitlementsPort: portStub("cancelled", []) } };
      const res = await H(req("DELETE", "/account", { bearer: s.token }), d as ApiDeps);
      Object.defineProperty(holder, "transaction", { configurable: true, writable: true, value: real });
      Object.defineProperty(holder, "select", { configurable: true, writable: true, value: realSelect });
      const after = await H(req("GET", "/auth/session", { bearer: s.token }), d as ApiDeps);
      const usersLeft = (await db.select().from(users).where(eq(users.accountId, s.accountId))).length;
      return { res, after, usersLeft };
    }

    it("a commit whose answer was lost answers the receipt: the read finds the stamp", async () => {
      const { res, after, usersLeft } = await lostAnswer({ commits: true, readFails: false });
      expect(res.status).toBe(200);
      const body = await res.json() as { erased?: boolean; subscription?: string; usersErased?: number; tables?: unknown };
      expect([body.erased, body.subscription, body.usersErased, body.tables]).toEqual([true, "cancelled", undefined, undefined]);
      expect(res.headers.getSetCookie().length, "the receipt clears the cookies, as the ordinary one does").toBeGreaterThan(0);
      expect([usersLeft, after.status]).toEqual([0, 401]);
    });

    it("an outcome no read can settle answers 503 erasure_unconfirmed, never 'not deleted', and no cookie", async () => {
      const { res, after, usersLeft } = await lostAnswer({ commits: false, readFails: true });
      expect(res.status).toBe(503);
      const body = await res.json() as { error: { code: string; message: string; details?: { subscription?: string }; retryable?: boolean } };
      expect([body.error.code, body.error.details?.subscription, body.error.retryable]).toEqual(["erasure_unconfirmed", "cancelled", undefined]);
      expect(body.error.message).not.toMatch(/could not be deleted|not deleted/);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect([usersLeft, after.status]).toEqual([1, 200]);
    });

    it("CONTROL: a lost answer whose read finds no stamp is the known failure, 500 erasure_failed", async () => {
      const { res, usersLeft } = await lostAnswer({ commits: false, readFails: false });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("erasure_failed");
      expect(usersLeft).toBe(1);
    });

    it("CONTROL: the 200 does clear the cookies, so the 5xx's empty list is a reading", async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const d = { ...deps, services: { ...deps.services, entitlementsPort: portStub("cancelled", []) } };
      const res = await H(req("DELETE", "/account", { bearer: s.token }), d as ApiDeps);
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
    });
  });
});
