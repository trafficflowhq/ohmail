import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  accounts, bindDb, bindingOf, drafts, mailboxes, outboundSends, users,
  type AccessVerdict, type EntitlementsPort,
} from "@trafficflow/db";
import {
  closePooledDbs, makePooledDb, staffRoleGrants, staffSessions, staffUsers, STAFF_DOOR_KEY,
} from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import {
  PG_TEST_URL, flightsOf, keyEquals, realPgAvailable, recordPgWire, type PgWireFlight,
} from "@trafficflow/db/testing";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import {
  ScheduleService, dbFor, generateToken, hashToken, makeTestAuthDeps, type Db,
} from "@trafficflow/services";

/**
 * THE DOORS WITHOUT A SESSION, ON THE WIRE: a staff route and a clock's route.
 *
 * Neither has a customer's session, and each still names what its statements run for. A staff
 * route reads its own tables through the staff door (no account, the door's word); when it acts
 * on a customer's account, the id the operator typed finds a row at the door and the act rides
 * transactions that name the account that row carries. A clock's route walks on a handle that
 * names nothing, and each row its pass works on rides the row's own account.
 *
 * Read off the bytes a pool of one wrote, the request's handle minted as a host mints it.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

const SECRET = "door-binding-console-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };
const app = createApp(apiRoutes);
const NOW = new Date("2026-10-18T09:00:00.000Z");
const MINUTE = 60_000;

const OPEN: AccessVerdict = { ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true } };
const port: EntitlementsPort = {
  access: async () => OPEN, accessOrFault: async () => OPEN,
  spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
  release: async () => "settled" as const, manageLink: async () => null, releaseAccount: async () => "none",
};

const names = (f: PgWireFlight, table: string): boolean => f.statements.some((s) => s.includes(`"${table}"`));
/** The flights that carry the staff door's word. */
const atTheDoor = (flights: readonly PgWireFlight[]): PgWireFlight[] => flights.filter((f) => keyEquals(f, STAFF_DOOR_KEY));

describe.skipIf(!PG_UP)("the doors without a session name what they run for (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  const authDeps = makeTestAuthDeps({});
  const A = { accountId: "", mailboxId: "", parkedId: "" };
  const B = { accountId: "", mailboxId: "" };
  let staffId = "";
  let token = "";

  /** What the staff mailer was handed, and what it answers. */
  const mailed: Array<string | null | undefined> = [];
  let mailAnswer: { status: string; reason?: string } = { status: "sent" };

  /** A request's container as a host builds it: the handle minted bound to nothing. */
  const depsOf = (): ApiDeps => ({
    db: bindDb(pool, { account: null }) as unknown as Db, now: () => NOW, requestId: randomUUID(),
    session: null, idempotency: null,
    authConfig: authDeps.config, keyProvider: authDeps.keyProvider, admin: ADMIN,
    alerts: { secret: SECRET },
    services: {
      entitlementsPort: port,
      customerMail: {
        sendBillingLink: async (ctx: { db: unknown }) => { mailed.push(bindingOf(ctx.db)?.account); return mailAnswer; },
      },
    },
  }) as unknown as ApiDeps;

  /** One request through the route table, and the flights it wrote. */
  const through = async (req: Request): Promise<{ res: Response; flights: PgWireFlight[] }> => {
    const deps = depsOf();
    wire.start();
    const res = await app.handle(req, deps);
    return { res, flights: flightsOf(wire.read()) };
  };
  const staffPost = (path: string, body: Record<string, unknown>): Request => new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionToken: token, ...body }),
  });

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    for (const world of [A, B]) {
      const [a] = await pool.insert(accounts).values({ name: `door-${randomUUID().slice(0, 8)}` }).returning();
      world.accountId = a!.id;
      await pool.insert(users).values({ accountId: a!.id, email: `owner-${randomUUID()}@door.example` });
      const [mb] = await pool.insert(mailboxes).values({
        accountId: a!.id, provider: "imap", address: `box-${randomUUID().slice(0, 8)}@door.example`,
      }).returning();
      world.mailboxId = mb!.id;
    }
    const [parked] = await pool.insert(mailboxes).values({
      accountId: A.accountId, provider: "imap", address: `parked-${randomUUID().slice(0, 8)}@door.example`,
      status: "error", errorCode: "auth", retryCount: 4, retryAfter: new Date(NOW.getTime() + 15 * MINUTE),
    }).returning();
    A.parkedId = parked!.id;
    const [staff] = await pool.insert(staffUsers)
      .values({ email: `support-${randomUUID()}@door.example`, passwordHash: "unused" }).returning();
    staffId = staff!.id;
    await pool.insert(staffRoleGrants).values({ staffUserId: staffId, role: "owner" });
    token = generateToken(32);
    await pool.insert(staffSessions).values({
      staffUserId: staffId, tokenHash: hashToken(token), createdAt: NOW, lastTwofaAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60 * MINUTE),
    });
  }, 120_000);

  afterAll(async () => {
    // The staff's rows and the audit trails stay: both trails are append-only. The letters go, so
    // no later pass on this database finds one of this file's to claim.
    const ids = [A.accountId, B.accountId].filter((id) => id !== "");
    if (ids.length > 0) {
      await pool.delete(outboundSends).where(inArray(outboundSends.accountId, ids));
      await pool.delete(drafts).where(inArray(drafts.accountId, ids));
    }
    await closePooledDbs();
  });

  describe("a staff act on a mailbox", () => {
    it("the staff session is read at the door; the release rides the account the mailbox's row carries", async () => {
      const { res, flights } = await through(staffPost("/admin/mailboxes/resync", {
        mailboxId: A.parkedId, note: "provider outage cleared, release the backoff",
      }));
      expect(res.status).toBe(200);
      expect(flights.filter((f) => f.door === "plain")).toEqual([]);

      // At the door: the session's look-up, and the one read that finds the mailbox's row.
      const door = atTheDoor(flights);
      expect(door.every((f) => f.account === null)).toBe(true);
      expect(door.some((f) => names(f, "staff_sessions"))).toBe(true);
      expect(door.filter((f) => names(f, "mailboxes")).map((f) => f.door)).toEqual(["lone"]);

      // The release: one transaction, and it names A. No flight names another account.
      const bound = flights.filter((f) => f.account !== null);
      expect(new Set(bound.map((f) => f.account))).toEqual(new Set([A.accountId]));
      expect(bound.every((f) => !f.keyed)).toBe(true);
      const release = bound.filter((f) => f.door === "write");
      expect(release).toHaveLength(1);
      expect(names(release[0]!, "mailboxes")).toBe(true);
      expect(names(release[0]!, "audit_log")).toBe(true);

      const [row] = await pool.select({ retryAfter: mailboxes.retryAfter }).from(mailboxes).where(eq(mailboxes.id, A.parkedId));
      expect(row!.retryAfter).toBeNull();
    });

    it("a mailbox id no row answers binds nothing: no flight names an account, and the refusal is recorded at the door", async () => {
      const { res, flights } = await through(staffPost("/admin/mailboxes/resync", {
        mailboxId: randomUUID(), note: "provider outage cleared, release the backoff",
      }));
      expect(res.status).toBe(404);
      expect(flights.filter((f) => f.account !== null)).toEqual([]);
      // The refused event is a flight of its own, with the door's word.
      const recorded = atTheDoor(flights).filter((f) => names(f, "staff_audit_events"));
      expect(recorded.map((f) => [f.door, f.statements.length])).toEqual([["lone", 1]]);
    });
  });

  describe("a staff act on an account", () => {
    it("the billing link: the id in the path finds the account's row at the door, and the claim and the mail run for that row", async () => {
      mailed.length = 0;
      mailAnswer = { status: "sent" };
      const { res, flights } = await through(staffPost(`/admin/accounts/${A.accountId.toUpperCase()}/billing-link`, {
        reasonCode: "customer_request",
      }));
      expect(res.status).toBe(200);
      expect(flights.filter((f) => f.door === "plain")).toEqual([]);

      expect(atTheDoor(flights).filter((f) => names(f, "accounts")).map((f) => [f.door, f.account])).toEqual([["lone", null]]);
      const bound = flights.filter((f) => f.account !== null);
      expect(new Set(bound.map((f) => f.account))).toEqual(new Set([A.accountId]));
      const claim = bound.filter((f) => f.door === "write");
      expect(claim).toHaveLength(1);
      expect(names(claim[0]!, "account_lifecycle_notices")).toBe(true);
      // The mailer was handed the handle of the account the row carries.
      expect(mailed).toEqual([A.accountId]);
    });

    it("a mail the mailer declined: the claim is handed back under the same account", async () => {
      mailed.length = 0;
      mailAnswer = { status: "skipped", reason: "mailer_disabled" };
      const { res, flights } = await through(staffPost(`/admin/accounts/${A.accountId}/billing-link`, {
        reasonCode: "customer_request",
      }));
      expect(res.status).toBe(503);
      const bound = flights.filter((f) => f.account !== null);
      expect(new Set(bound.map((f) => f.account))).toEqual(new Set([A.accountId]));
      // Two transactions for A: the claim, and the hand-back that takes it away again.
      expect(bound.filter((f) => f.door === "write")).toHaveLength(2);
      expect(mailed).toEqual([A.accountId]);
      mailAnswer = { status: "sent" };
    });

    it("an account id no row answers binds nothing, and the refusal is recorded at the door", async () => {
      mailed.length = 0;
      const { res, flights } = await through(staffPost(`/admin/accounts/${randomUUID()}/billing-link`, {
        reasonCode: "customer_request",
      }));
      expect(res.status).toBe(404);
      expect(flights.filter((f) => f.account !== null)).toEqual([]);
      expect(atTheDoor(flights).filter((f) => names(f, "staff_audit_events")).map((f) => f.door)).toEqual(["lone"]);
      expect(mailed).toEqual([]);
    });
  });

  describe("a clock's route", () => {
    it("the sender's pass: the walk names no account and no key, and each due letter rides its own account, its dial too", async () => {
      const schedules = new ScheduleService();
      for (const [world, minutesAgo] of [[B, 3], [A, 2], [B, 1]] as const) {
        const at = new Date(NOW.getTime() - minutesAgo * MINUTE);
        const made = new Date(at.getTime() - 5 * MINUTE);
        const [d] = await pool.insert(drafts).values({
          accountId: world.accountId, mailboxId: world.mailboxId, subject: "later", body: "words",
          to: [{ name: null, address: "you@example.com" }], status: "draft", createdAt: made, updatedAt: made,
        }).returning();
        await schedules.schedule(
          { db: dbFor(pool as unknown as Db, world.accountId), accountId: world.accountId, userId: null, now: () => made, requestId: "seed" },
          d!.id, at.toISOString(),
        );
      }
      // No mailbox here is signed in: each letter's dial reads the mailbox's credential, finds none
      // and sends nothing. The read is the dial's own, made through the route's real adapter door.
      const { res, flights } = await through(new Request("https://api.test/internal/sends/scheduled/run", {
        headers: { authorization: `Bearer ${SECRET}` },
      }));
      expect(res.status).toBe(200);
      // The pass claims every due letter of the store, another file's leftovers too: this file's three are among them.
      expect((await res.json() as { claimed: number }).claimed).toBeGreaterThanOrEqual(3);

      expect(flights.filter((f) => f.door === "plain")).toEqual([]);
      expect(flights.filter((f) => f.keyed)).toEqual([]);
      const mine = flights.filter((f) => f.account === A.accountId || f.account === B.accountId);
      const inTurn = (of: readonly PgWireFlight[]): string[] => {
        const turns: string[] = [];
        for (const f of of) if (turns.at(-1) !== f.account) turns.push(f.account!);
        return turns;
      };
      expect(inTurn(mine)).toEqual([B.accountId, A.accountId, B.accountId]);
      // The dial's read of a mailbox's credential rides the account of the letter it is for, never the walk.
      const dials = flights.filter((f) => names(f, "mailbox_credentials"));
      expect(dials.every((f) => f.account !== null)).toBe(true);
      expect(inTurn(dials.filter((f) => mine.includes(f)))).toEqual([B.accountId, A.accountId, B.accountId]);
      // The claim flips rows of both accounts in one transaction that names neither.
      expect(flights.filter((f) => f.account === null && f.door === "write").some((f) => names(f, "drafts"))).toBe(true);
    });
  });
});
