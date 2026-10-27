import { describe, it, expect, vi } from "vitest";
import {
  createApp, apiRoutes, ACCESS_REFUSED_MAY_REACH, ACCESS_REFUSED_MAY_REACH_ROUTES,
  accessRefusedMayReach, accessRouteClassOf, type ApiDeps, type CostClass, type Route,
} from "@trafficflow/api";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { UNMETERED, accountStorage, mailboxes, messages, type AccessVerdict, type EntitlementsPort } from "@trafficflow/db";
import { accountLifecycleNotices } from "@trafficflow/db/cloud";
import {
  spendOf, entitlementsPort as entitlementsPortOf,
} from "../src/routes/shared.js";
import { pipelineFor } from "../src/app.js";
import { withSpendGate } from "../src/middleware.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * THE ACCESS GATE, DRIVEN THROUGH THE ROUTE TABLE.
 *
 * The refusal rule reads `deps.session` and `route.cost`, and both are supplied by the PIPELINE.
 * A test that called the middleware directly would prove nothing about which stage fills them —
 * which is the defect the pairing-redeem route shipped for two rounds, a rule comparing an operand
 * the pipeline never populated on that door.
 */

/** A port whose every answer is stated by the test. Nothing here dials anything. */
function stubPort(over: Partial<EntitlementsPort> & { access?: EntitlementsPort["access"] } = {}): EntitlementsPort {
  const access = over.access ?? (async (): Promise<AccessVerdict> => ({
    ok: true, limits: { mailboxes: 5, storageBytes: 1_000, canAddMailbox: true, aiEnabled: true },
  }));
  return {
    access,
    accessOrFault: over.accessOrFault ?? access,
    spend: over.spend ?? (async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key })),
    release: over.release ?? (async () => "settled" as const),
    manageLink: over.manageLink ?? (async () => null),
    releaseAccount: over.releaseAccount ?? (async () => "none"),
  };
}

const refusing = (reason: "payment_required" | "suspended", manageUrl?: string): EntitlementsPort =>
  stubPort({ access: async () => ({ ok: false, reason, ...(manageUrl ? { manageUrl } : {}) }) });

/** The bag with an entitlements composition of the test's choosing. */
async function depsWith(entitlementsPort: unknown) {
  const made = await makeDeps();
  return {
    ...made,
    deps: {
      ...made.deps,
      services: { ...made.deps.services, entitlementsPort },
    } as ApiDeps,
  };
}

/**
 * `GET /account/access` — the limits the client reads, and the one arm the pipeline hides.
 *
 * The route's refusal branch is UNREACHABLE through its own door: `withSpendGate` answers 402
 * before the handler runs, so a refused account cannot arrive. That is exactly why it is driven
 * HERE, at the handler, with a refusing port — a branch nobody can watch fail is a branch the
 * next reader takes for a guarantee, and this one decides whether a refusal can be reported to
 * a client as "no limits at all".
 */
describe("GET /account/access answers limits, and never mistakes a refusal for freedom", () => {
  /** The handler, reached directly: the middleware is the thing being bypassed. */
  async function accessHandler() {
    const { accountRoutes } = await import("../src/routes/account.js");
    const r = accountRoutes.find((x) => x.method === "GET" && x.pattern === "/account/access");
    expect(r, "the route is gone from the table").toBeDefined();
    return r!;
  }

  it("a host with NO entitlements program answers `metered: false`", async () => {
    const { db, deps } = await depsWith(undefined);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const r = await accessHandler();
    const res = await r.handler(req("GET", "/account/access", { bearer: s.token }), deps, {});
    expect(await res.json()).toEqual({ metered: false });
  });

  it("an ALLOWED account answers its limits, `canAddMailbox` carried separately", async () => {
    // The two are not derivable from each other: an account may keep what it has and be
    // forbidden another, which is why the route passes both through rather than a number.
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({
        ok: true,
        limits: { mailboxes: 5, storageBytes: null, canAddMailbox: false, aiEnabled: true },
      }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const r = await accessHandler();
    const res = await r.handler(req("GET", "/account/access", { bearer: s.token }), deps, {});
    // `aiEnabled` is the THIRD answer and the same rule: a surface holding a stale "no AI
    // actions remain" asks this route whether that is still true, and the verdict's own field
    // was being read and dropped.
    expect(await res.json()).toEqual({
      metered: true, access: "open", canAddMailbox: false, mailboxes: 5, aiEnabled: true,
      exportPath: "/account/export",
    });
  });

  it("the OPEN arm names no account-page link, even when the program sends one", async () => {
    // The program's link is a live single-use page token minted per read; no client opens it (each
    // mints at the press), so it may not ride the answer every open read gets. The refused arm
    // still forwards it for the wall, below.
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({
        ok: true, limits: { mailboxes: 2, storageBytes: null, canAddMailbox: true, aiEnabled: true },
        manageUrl: "https://manage.example/manage?token=live",
        lifecycle: {
          state: "trialing", closedReason: null, trialEndsAt: "2026-09-30T20:00:00.000Z", graceUntil: null,
          closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false,
        },
      } as unknown as AccessVerdict),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const r = await accessHandler();
    const body = await (await r.handler(req("GET", "/account/access", { bearer: s.token }), deps, {})).json();
    expect(body.access).toBe("open");
    expect(body.lifecycle?.state).toBe("trialing");
    expect(Object.keys(body)).not.toContain("manageUrl");
  });

  it("asks the port FRESH — the wall re-reads on focus and must see a reopening, not a cached refusal", async () => {
    let opts: { fresh?: boolean } | undefined;
    const { db, deps } = await depsWith(stubPort({
      access: async (_a, o) => {
        opts = o;
        return { ok: true, limits: { mailboxes: 1, storageBytes: null, canAddMailbox: true, aiEnabled: true } };
      },
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const r = await accessHandler();
    await r.handler(req("GET", "/account/access", { bearer: s.token }), deps, {});
    expect(opts?.fresh).toBe(true);
  });

  it("carries aiEnabled FALSE too — the field is the verdict's, not a default", async () => {
    // The control on the line above: a test written against a port that only ever says `true`
    // cannot tell the field apart from a constant.
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({
        ok: true,
        limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: false },
      }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const r = await accessHandler();
    const res = await r.handler(req("GET", "/account/access", { bearer: s.token }), deps, {});
    expect((await res.json()).aiEnabled).toBe(false);
  });

  it("a METERED account with a cap reads its storage: bytes, cap and the letters emptied for space", async () => {
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({ ok: true, limits: { mailboxes: 5, storageBytes: 2_000_000_000, canAddMailbox: true, aiEnabled: true } }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    await db.insert(accountStorage).values({
      accountId: s.accountId, bytes: 1_868_000_000, huskedForSpace: 80_000,
      firstHuskedAt: new Date("2026-10-20T03:00:00.000Z"), lastHuskedAt: new Date("2026-07-27T03:00:00.000Z"),
      keptFrom: "2019-04-01", withheldOnArrival: 12,
    });
    const body = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect(body.storage).toEqual({
      usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 80_000,
      firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: "2019-04", withheldOnArrival: 12, upgrade: "plan",
      emptyingNow: true,
    });
  });

  it("…and whether the current cap is what empties text: at it, or a trim this week near it; never after a bigger plan", async () => {
    const DAY = 86_400_000;
    for (const [cap, bytes, lastAgo, now] of [
      [2_000_000_000, 1_868_000_000, DAY, true],
      [2_000_000_000, 2_000_000_000, null, true],
      // A bigger plan since the trim: 37% of the new cap, and 92% with no trim for a month.
      [5_000_000_000, 1_868_000_000, DAY, false],
      [5_000_000_000, 4_600_000_000, 30 * DAY, false],
      [2_000_000_000, 1_868_000_000, 8 * DAY, false],
    ] as const) {
      const { db, deps } = await depsWith(stubPort({
        access: async () => ({ ok: true, limits: { mailboxes: 5, storageBytes: cap, canAddMailbox: true, aiEnabled: true } }),
      }));
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      await db.insert(accountStorage).values({
        accountId: s.accountId, bytes: bytes, huskedForSpace: 80_000,
        lastHuskedAt: lastAgo === null ? null : new Date(FIXED_NOW.getTime() - lastAgo),
      });
      const body = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
      expect(body.storage.emptyingNow, `${cap} ${bytes} ${lastAgo}`).toBe(now);
    }
  });

  it("…and inside the trial's storage floor, the plan's own limit and when it applies again", async () => {
    for (const until of ["2026-08-08T12:00:00.000Z", null]) {
      const { db, deps } = await depsWith(stubPort({
        access: async () => ({
          ok: true, limits: { mailboxes: 1, storageBytes: 4_000_000_000, canAddMailbox: true, aiEnabled: true },
          trialStorage: { planBytesLimit: 2_000_000_000, until },
        }),
      }));
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const body = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
      expect(body.storage).toMatchObject({ limitBytes: 4_000_000_000, planLimitBytes: 2_000_000_000, limitDropsAt: until });
    }
    // A carry that does not lower the limit is no carry.
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({
        ok: true, limits: { mailboxes: 1, storageBytes: 4_000_000_000, canAddMailbox: true, aiEnabled: true },
        trialStorage: { planBytesLimit: 4_000_000_000, until: null },
      }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const body = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect("planLimitBytes" in body.storage).toBe(false);
  });

  it("…and after a lower limit, the previous one for 14 days, the plan's own and the date it applies", async () => {
    let limit = 10_000_000_000;
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({ ok: true, limits: { mailboxes: 5, storageBytes: limit, canAddMailbox: true, aiEnabled: true } }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    await db.insert(accountStorage).values({ accountId: s.accountId, bytes: 9_000_000_000 });
    const storage = async () => (await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json()).storage;
    expect(await storage()).toMatchObject({ limitBytes: 10_000_000_000, upgrade: "addon" });
    limit = 2_000_000_000;
    const held = await storage();
    expect(held).toMatchObject({
      limitBytes: 10_000_000_000, planLimitBytes: 2_000_000_000, upgrade: "plan", emptyingNow: false,
    });
    expect(Date.parse(held.limitDropsAt) - FIXED_NOW.getTime()).toBeGreaterThanOrEqual(14 * 86_400_000);
    expect(Date.parse(held.limitDropsAt) % 86_400_000, "the hold ends at 00:00 UTC").toBe(0);
    // A re-upgrade inside the window cancels it.
    limit = 10_000_000_000;
    expect("planLimitBytes" in await storage()).toBe(false);
  });

  it("…and what adds room: a bigger plan below the largest plan's limit, the storage add-on from it on", async () => {
    // Solo, a trial's 4 GB floor, Plus, Pro, Solo with one add-on.
    for (const [cap, upgrade] of [
      [2_000_000_000, "plan"], [4_000_000_000, "plan"], [5_000_000_000, "plan"], [10_000_000_000, "addon"], [12_000_000_000, "addon"],
    ] as const) {
      const { db, deps } = await depsWith(stubPort({
        access: async () => ({ ok: true, limits: { mailboxes: 5, storageBytes: cap, canAddMailbox: true, aiEnabled: true } }),
      }));
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const body = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
      expect(body.storage.upgrade, String(cap)).toBe(upgrade);
    }
  });

  it("…an account with no counter row yet reads zero, never an absent block", async () => {
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({ ok: true, limits: { mailboxes: 5, storageBytes: 5_000, canAddMailbox: true, aiEnabled: true } }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const body = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect(body.storage).toEqual({
      usedBytes: 0, limitBytes: 5_000, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null, withheldOnArrival: 0,
      upgrade: "plan", emptyingNow: false,
    });
  });

  it("no storage block without a cap, for a refused account, or on a host with no program", async () => {
    for (const port of [
      stubPort({ access: async () => ({ ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true } }) }),
      refusing("payment_required"),
      undefined,
    ]) {
      const { db, deps } = await depsWith(port);
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      await db.insert(accountStorage).values({ accountId: s.accountId, bytes: 10, huskedForSpace: 3 });
      const res = await H(req("GET", "/account/access", { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body)).not.toContain("storage");
    }
  });

  it("a REFUSAL is never reported as unmetered — the arm the middleware hides", async () => {
    // Driven at the handler on purpose. Reported as metered-and-forbidden: a refused account
    // told "no limits" would be handed a connect button by the very gate that reads this.
    const { db, deps } = await depsWith(refusing("payment_required"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const r = await accessHandler();
    const res = await r.handler(req("GET", "/account/access", { bearer: s.token }), deps, {});
    const body = await res.json();
    expect(body.metered, "a refusal was reported as a host with no program").toBe(true);
    expect(body.canAddMailbox).toBe(false);
    expect(body.access).toBe("refused");
  });

  it("`access` is the gate's own verdict, never a reading of the limits", async () => {
    // An open account at its mailbox limit and a refused one answer the same `canAddMailbox`;
    // only `access` tells them apart, and a wall lifts on it alone.
    const atLimit = await depsWith(stubPort({
      access: async () => ({
        ok: true, limits: { mailboxes: 0, storageBytes: null, canAddMailbox: false, aiEnabled: false },
      }),
    }));
    const r = await accessHandler();
    const a = await seedSession(atLimit.db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const open = await (await r.handler(req("GET", "/account/access", { bearer: a.token }), atLimit.deps, {})).json();
    const refused = await depsWith(refusing("suspended"));
    const b = await seedSession(refused.db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const shut = await (await r.handler(req("GET", "/account/access", { bearer: b.token }), refused.deps, {})).json();
    expect([open.canAddMailbox, shut.canAddMailbox]).toEqual([false, false]);
    expect([open.access, shut.access]).toEqual(["open", "refused"]);
  });

  it("…and through the ROUTE a refused account READS THE WALL — 200, with everything it renders", async () => {
    // The wall reading itself (`ACCESS_REFUSED_MAY_REACH_ROUTES`): a refused account reaches this
    // one read and gets the lifecycle, the manage link and the export path in one answer.
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({
        ok: false, reason: "payment_required", manageUrl: "https://manage.example/t",
        lifecycle: {
          state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
          closedAt: "2026-09-16T00:00:00.000Z", erasureAt: "2026-10-16T00:00:00.000Z",
          erasedAt: null, formerlyPaid: false,
        },
      }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/account/access", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metered).toBe(true);
    expect(body.access).toBe("refused");
    expect(body.canAddMailbox).toBe(false);
    expect(body.lifecycle?.state).toBe("closed");
    expect(body.lifecycle?.erasureAt).toBe("2026-10-16T00:00:00.000Z");
    expect(body.manageUrl).toBe("https://manage.example/t");
    expect(body.exportPath).toBe("/account/export");
  });

  it("…and the pairing-consent read stays reachable too — the shell's first question", async () => {
    const { db, deps } = await depsWith(refusing("payment_required"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect(res.status).not.toBe(402);
  });

  it("the FIRST open read after a closure answers caughtUp ONCE — the reopened notice's insert, no count", async () => {
    // The wall lifted: the port answers open WITH a lifecycle, the account holds a `closed`
    // notice from the nightly pass and released nothing (no marker). The read claims the
    // `reopened` row (an idempotent insert on a GET, named in the handler) anchored on the
    // closure, and says NO number: the worker has not run yet, so a count here would be the
    // free month's mail. The second read carries nothing.
    const openLifecycle = {
      state: "active" as const, closedReason: null, trialEndsAt: null, graceUntil: null,
      closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: true,
    };
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({
        ok: true,
        limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true },
        lifecycle: openLifecycle,
      }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const closedAt = new Date(FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    await db.insert(accountLifecycleNotices)
      .values({ accountId: s.accountId, kind: "closed", anchor: closedAt });
    const [mb] = await db.insert(mailboxes).values({
      accountId: s.accountId, provider: "imap", address: "reopen@wall.test",
    }).returning();
    const msg = (at: Date) => ({
      accountId: s.accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: randomUUID(),
      subject: "x", createdAt: at,
    });
    await db.insert(messages).values([
      msg(new Date(closedAt.getTime() - 1000)),          // before the closure — not counted
      msg(new Date(closedAt.getTime() + 1000)),
      msg(new Date(closedAt.getTime() + 2000)),
    ]);

    const first = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect(first.caughtUp).toEqual({ since: closedAt.toISOString() });

    const second = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect("caughtUp" in second, "the second read must carry no banner — the PK is the once").toBe(false);
  });

  it("no closure on record, or no lifecycle at all ⇒ no banner and no insert", async () => {
    const { db, deps } = await depsWith(stubPort());  // ok:true, NO lifecycle (an old plane)
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const body = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect("caughtUp" in body).toBe(false);
    expect(await db.select().from(accountLifecycleNotices)
      .where(eq(accountLifecycleNotices.accountId, s.accountId))).toHaveLength(0);
  });
});

/**
 * THE REOPENING DOOR (mail 0135, owner 2026-09-28): after paying, a person is in the paid product at
 * once. The open read clears the `account_closed` block and asks for every mailbox the WALL
 * released back as a `join` — never one the person released, never a role flip, never an IMAP
 * dial. PGlite here for the route's shape; the transaction on real Postgres is
 * `account-reopen.pg.test.ts`.
 */
describe("GET /account/access reopens what the wall closed", () => {
  const openLifecycle = {
    state: "active" as const, closedReason: null, trialEndsAt: null, graceUntil: null,
    closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: true,
  };
  const openPort = () => stubPort({
    access: async () => ({
      ok: true,
      limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true },
      lifecycle: openLifecycle,
    }),
  });
  const PARKED_AT = new Date(FIXED_NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
  const CONSENTED = new Date(FIXED_NOW.getTime() - 60 * 24 * 60 * 60 * 1000);

  async function seedClosedAccount(db: Awaited<ReturnType<typeof depsWith>>["db"]) {
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const blocked = { syncBlockedReason: "account_closed", syncBlockedSince: PARKED_AT } as const;
    const row = async (address: string, extra: Partial<typeof mailboxes.$inferInsert>) => {
      const [m] = await db.insert(mailboxes).values({
        accountId: s.accountId, provider: "imap", address, organizerRole: "reader",
        organizeConsentedAt: CONSENTED, ...blocked, ...extra,
      }).returning();
      return m!.id;
    };
    return {
      s,
      // The wall released this one: it comes back as a join.
      walled: await row("walled@wall.test", { organizerParkedAt: PARKED_AT, organizerReleasedAt: PARKED_AT }),
      // The person stopped this one before the wall: it stays a reader.
      stopped: await row("stopped@wall.test", { organizerReleasedAt: new Date(PARKED_AT.getTime() - 86_400_000) }),
      // Marked, but the person has since asked it to stop: the ask outranks the resume.
      asked: await row("asked@wall.test", { organizerParkedAt: PARKED_AT, releaseRequestedAt: FIXED_NOW }),
    };
  }
  const rowOf = async (db: Awaited<ReturnType<typeof depsWith>>["db"], id: string) =>
    (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

  it("clears account_closed, stamps a JOIN on the wall's release alone, rings the worker — and opens no IMAP", async () => {
    const { db, deps } = await depsWith(openPort());
    const w = await seedClosedAccount(db);
    const connect = vi.mocked(ImapAdapter.prototype.connect);
    const dialsBefore = connect.mock.calls.length;

    const res = await H(req("GET", "/account/access", { bearer: w.s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).access).toBe("open");

    const walled = await rowOf(db, w.walled);
    expect(walled.syncBlockedReason).toBeNull();
    expect(walled.syncBlockedSince).toBeNull();
    expect(walled.takeoverAuthorizedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
    expect(walled.takeoverIntent).toBe("join");
    expect(walled.syncRequestedAt?.toISOString(), "the kick is rung").toBe(FIXED_NOW.toISOString());
    expect(walled.organizerRole, "the gate promotes, never this door").toBe("reader");
    expect(walled.organizerParkedAt, "the marker stays until the stamp is spent").not.toBeNull();

    const stopped = await rowOf(db, w.stopped);
    expect(stopped.syncBlockedReason, "the block is cleared for every row").toBeNull();
    expect(stopped.takeoverAuthorizedAt, "a mailbox the person stopped is never asked back").toBeNull();
    expect((await rowOf(db, w.asked)).takeoverAuthorizedAt, "a standing stop outranks the resume").toBeNull();
    expect(connect.mock.calls.length, "the API never opens IMAP to organize").toBe(dialsBefore);
  });

  it("a second read writes nothing: the stamp it wrote stands unchanged", async () => {
    const { db, deps, clock } = await depsWith(openPort());
    const w = await seedClosedAccount(db);
    await H(req("GET", "/account/access", { bearer: w.s.token }), deps);
    const first = await rowOf(db, w.walled);
    clock.advance(60_000);
    await H(req("GET", "/account/access", { bearer: w.s.token }), deps);
    const second = await rowOf(db, w.walled);
    expect(second.takeoverAuthorizedAt?.toISOString()).toBe(first.takeoverAuthorizedAt?.toISOString());
    expect(second.syncRequestedAt?.toISOString()).toBe(first.syncRequestedAt?.toISOString());
  });

  it("a REFUSED read writes nothing — the block stands and nothing is asked back", async () => {
    const { db, deps } = await depsWith(refusing("payment_required"));
    const w = await seedClosedAccount(db);
    const res = await H(req("GET", "/account/access", { bearer: w.s.token }), deps);
    expect((await res.json()).access).toBe("refused");
    const walled = await rowOf(db, w.walled);
    expect(walled.syncBlockedReason).toBe("account_closed");
    expect(walled.takeoverAuthorizedAt).toBeNull();
  });

  it("the banner anchors on the PARK, and the reopening it answered starts no second one", async () => {
    const { db, deps } = await depsWith(openPort());
    const w = await seedClosedAccount(db);
    const closedAt = new Date(FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    await db.insert(accountLifecycleNotices).values({ accountId: w.s.accountId, kind: "closed", anchor: closedAt });

    const first = await (await H(req("GET", "/account/access", { bearer: w.s.token }), deps)).json();
    expect(first.caughtUp, "since the wall stood the mailboxes down, not the trial's end")
      .toEqual({ since: PARKED_AT.toISOString() });

    // The worker's promotion spends the marker; the closure's own notice is still on record.
    await db.update(mailboxes).set({ organizerParkedAt: null }).where(eq(mailboxes.accountId, w.s.accountId));
    const second = await (await H(req("GET", "/account/access", { bearer: w.s.token }), deps)).json();
    expect("caughtUp" in second, "one banner per reopening").toBe(false);
  });

  it("a READER-ONLY account closed inside one night is anchored on its block, read before the clear", async () => {
    // No park (the wall releases organizers only) and no closed notice (the nightly pass never
    // ran): the `account_closed` block is the closure's one fact, and the route must read the
    // catch-up BEFORE the reopening clears it.
    const { db, deps } = await depsWith(openPort());
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const [mb] = await db.insert(mailboxes).values({
      accountId: s.accountId, provider: "imap", address: "reader@wall.test", organizerRole: "reader",
      organizeConsentedAt: CONSENTED, syncBlockedReason: "account_closed", syncBlockedSince: PARKED_AT,
    }).returning();
    const first = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect(first.caughtUp).toEqual({ since: PARKED_AT.toISOString() });
    expect((await rowOf(db, mb!.id)).syncBlockedReason, "the reopening still clears the block").toBeNull();
    const second = await (await H(req("GET", "/account/access", { bearer: s.token }), deps)).json();
    expect("caughtUp" in second, "one banner per reopening").toBe(false);
  });
});

describe("a refused account meets 402 at a product door", () => {
  it("answers 402 subscription_required with the reason, and says nothing is gone", async () => {
    const { db, deps } = await depsWith(refusing("payment_required"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const res = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("subscription_required");
    expect(body.error.details).toEqual({ reason: "payment_required", exportPath: "/account/export" });
    // The one thing the sentence must contain, because a refusal that reads as data loss is the
    // failure this screen exists to prevent.
    expect(body.error.message).toMatch(/kept/);
    expect(body.error.message).toMatch(/nothing has been deleted/i);
  });

  it("passes the manage URL through when the port supplies one, and omits the key when not", async () => {
    const { db, deps } = await depsWith(refusing("suspended", "https://manage.example/t"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
    expect((await res.json()).error.details).toEqual({
      reason: "suspended", manageUrl: "https://manage.example/t", exportPath: "/account/export",
    });

    const bare = await depsWith(refusing("suspended"));
    const s2 = await seedSession(bare.db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res2 = await H(req("GET", "/mailboxes", { bearer: s2.token }), bare.deps);
    expect((await res2.json()).error.details)
      .toEqual({ reason: "suspended", exportPath: "/account/export" });
  });

  it("carries the lifecycle block in the details when the verdict has one — the wall's dates", async () => {
    const lifecycle = {
      state: "closed" as const, closedReason: "unpaid" as const, trialEndsAt: null,
      graceUntil: null, closedAt: "2026-09-10T00:00:00.000Z",
      erasureAt: "2026-12-09T00:00:00.000Z", erasedAt: null, formerlyPaid: true,
    };
    const { db, deps } = await depsWith(stubPort({
      access: async () => ({ ok: false, reason: "payment_required", lifecycle }),
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
    expect(res.status).toBe(402);
    expect((await res.json()).error.details).toEqual({
      reason: "payment_required", lifecycle, exportPath: "/account/export",
    });
  });

  it("refuses a WRITE door too, not just a read", async () => {
    const { db, deps } = await depsWith(refusing("payment_required"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("POST", "/threads/merge", { bearer: s.token, body: "{}" }), deps);
    expect(res.status).toBe(402);
  });
});

describe("the doors a refused account keeps", () => {
  /* A lock with no way out is a trap. Each of these is driven through the route table with the
   * SAME refusing port, so the exemption is the pipeline's and not the handler's. */
  it("signing out works", async () => {
    const { db, deps } = await depsWith(refusing("payment_required"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("POST", "/auth/logout", { bearer: s.token }), deps);
    expect(res.status).not.toBe(402);
  });

  it("reading the session works", async () => {
    const { db, deps } = await depsWith(refusing("payment_required"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/auth/session", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
  });

  it("ERASURE works — Art. 17 is a right, and a payment does not gate it", async () => {
    const { db, deps } = await depsWith(refusing("payment_required"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("DELETE", "/account", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).erased).toBe(true);
  });

  it("the manage-link door works — the way back to paying is not behind the lock", async () => {
    const { db, deps } = await depsWith(refusing("payment_required", "https://manage.example/t"));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("POST", "/account/manage-link", { bearer: s.token }), deps);
    // Not 402: this route is the exemption. It answers 404 here because THIS stub's `manageLink`
    // is `null` — the point is which status it does NOT answer.
    expect(res.status).not.toBe(402);
  });
});

describe("the positive control — an ordinary account is admitted", () => {
  /* Without this, every case above passes for a gate that refuses everybody, and the product
   * would be unusable for every paying customer with the suite green. */
  it("a permitted verdict reaches the handler", async () => {
    const { db, deps } = await depsWith(stubPort());
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
  });

  it("an UNMETERED host never refuses, and asks nobody", async () => {
    const { db, deps } = await depsWith(UNMETERED);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    expect((await H(req("GET", "/mailboxes", { bearer: s.token }), deps)).status).toBe(200);
  });

  it("a host that declared NOTHING never refuses either — absence is not a verdict", async () => {
    // Absent and unmetered are different facts, and this is the one they share: neither refuses.
    // Refusing on an absent declaration would lock every account out of an unfinished composition.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    expect(deps.services?.entitlementsPort).toBeUndefined();
    expect((await H(req("GET", "/mailboxes", { bearer: s.token }), deps)).status).toBe(200);
  });

  it("a FAULT is never a refusal — the port's own contract, honoured at the route", async () => {
    // The client never rejects, but a hand-written port could. A throw out of `access` must not
    // become a 402 demanding money from a customer whose only problem is our outage.
    const { db, deps } = await depsWith(stubPort({
      access: async () => { throw new Error("program unreachable"); },
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
    expect(res.status).not.toBe(402);
  });
});

describe("POST /account/manage-link", () => {
  it("answers the port's URL for the SESSION's account, never a body's", async () => {
    let asked: string | null = null;
    const { db, deps } = await depsWith(stubPort({
      manageLink: async (accountId) => { asked = accountId; return { url: "https://manage.example/abc" }; },
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const res = await H(req("POST", "/account/manage-link", {
      // A body naming ANOTHER account, so the assertion below is about which one the handler read.
      bearer: s.token, body: JSON.stringify({ accountId: "00000000-0000-4000-8000-000000000000" }),
    }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://manage.example/abc" });
    expect(asked).toBe(s.accountId);
  });

  it("404s when the port answers no URL — no such program, or no such account", async () => {
    const { db, deps } = await depsWith(stubPort({ manageLink: async () => null }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("POST", "/account/manage-link", { bearer: s.token }), deps);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("no_manage_surface");
  });

  it("404s on an unmetered host — it operates no such page at all", async () => {
    const { db, deps } = await depsWith(UNMETERED);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    expect((await H(req("POST", "/account/manage-link", { bearer: s.token }), deps)).status).toBe(404);
  });

  it("requires a session", async () => {
    const { deps } = await depsWith(stubPort());
    expect((await H(req("POST", "/account/manage-link"), deps)).status).toBe(401);
  });
});

/**
 * THE RETURN FROM A CHECKOUT (mail 0135): the web asks the program to apply the payment at once
 * rather than wait for its webhook. The account is always the SESSION's — a session id is a
 * capability the program checks against it — and the one body field is bounded before any dial.
 */
describe("POST /account/checkout/confirm", () => {
  const SESSION_ID = "cs_test_a1B2c3D4e5";
  const confirming = (outcome: Awaited<ReturnType<NonNullable<EntitlementsPort["confirmReturn"]>>>) => {
    const asked: Array<[string, string]> = [];
    const port: EntitlementsPort = {
      ...stubPort(),
      confirmReturn: async (accountId, sessionId) => { asked.push([accountId, sessionId]); return outcome; },
    };
    return { port, asked };
  };
  const post = (token: string, body: unknown) =>
    req("POST", "/account/checkout/confirm", { bearer: token, body: JSON.stringify(body) });

  it("relays the SESSION's account and the body's session id, and answers the program's state", async () => {
    for (const outcome of ["confirmed", "pending"] as const) {
      const c = confirming(outcome);
      const { db, deps } = await depsWith(c.port);
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const res = await H(post(s.token, { sessionId: SESSION_ID, accountId: "00000000-0000-4000-8000-000000000000" }), deps);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: outcome });
      expect(c.asked, "a body naming another account is ignored").toEqual([[s.accountId, SESSION_ID]]);
    }
  });

  it("is reachable while the account is refused — the wall is up when a person pays", async () => {
    const port: EntitlementsPort = {
      ...refusing("payment_required"), confirmReturn: async () => "confirmed",
    };
    const { db, deps } = await depsWith(port);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    expect((await H(post(s.token, { sessionId: SESSION_ID }), deps)).status).toBe(200);
  });

  it("refuses a session id that is not a bounded token, before anything is dialled", async () => {
    const c = confirming("confirmed");
    const { db, deps } = await depsWith(c.port);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    for (const sessionId of [undefined, "", "cs test", "cs_test_'--", 42, "x".repeat(256)]) {
      const res = await H(post(s.token, { sessionId }), deps);
      expect(res.status, JSON.stringify(sessionId)).toBe(400);
    }
    expect((await H(post(s.token, { sessionId: "x".repeat(255) }), deps)).status, "the bound admits its own edge").toBe(200);
    expect(c.asked).toHaveLength(1);
  });

  it("an unknown session is 404, no answer is 503, and a program without the door is 404", async () => {
    for (const [outcome, status] of [["not_found", 404], ["fault", 503]] as const) {
      const { db, deps } = await depsWith(confirming(outcome).port);
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      expect((await H(post(s.token, { sessionId: SESSION_ID }), deps)).status).toBe(status);
    }
    for (const composition of [stubPort(), UNMETERED]) {
      const { db, deps } = await depsWith(composition);
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      expect((await H(post(s.token, { sessionId: SESSION_ID }), deps)).status).toBe(404);
    }
  });

  it("requires a session", async () => {
    const { deps } = await depsWith(confirming("confirmed").port);
    expect((await H(req("POST", "/account/checkout/confirm", { body: JSON.stringify({ sessionId: SESSION_ID }) }), deps)).status)
      .toBe(401);
  });
});

describe("THE ROUTE CENSUS — every route is classified for the lock", () => {
  const routes = apiRoutes;

  it("the route table is non-empty, so the census below is not vacuous", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("the open set is exactly the classes named plus the one route named", () => {
    const open = routes.filter((r) => accessRefusedMayReach(r));
    const byClass = routes.filter((r) => ACCESS_REFUSED_MAY_REACH.has(r.cost));
    const byName = open.filter((r) => !ACCESS_REFUSED_MAY_REACH.has(r.cost));
    expect(byName.map((r) => `${r.method.toUpperCase()} ${r.pattern}`).sort())
      .toEqual([...ACCESS_REFUSED_MAY_REACH_ROUTES].sort());
    expect(open.length).toBe(byClass.length + byName.length);
  });

  it("the four doors the lock must leave open are all open", () => {
    // Named individually, because "the ceremony class is open" is a statement about a class and
    // these are the four sentences the lock screen's own promise is made of.
    const open = (method: string, pattern: string): boolean => {
      const r = routes.find((x) => x.method.toUpperCase() === method && x.pattern === pattern);
      expect(r, `${method} ${pattern} is not in the route table`).toBeDefined();
      return accessRefusedMayReach(r!);
    };
    expect(open("POST", "/auth/logout")).toBe(true);      // sign out
    expect(open("GET", "/auth/session")).toBe(true);      // who am I
    expect(open("DELETE", "/account")).toBe(true);        // Art. 17
    expect(open("POST", "/account/manage-link")).toBe(true); // the way back to paying
  });

  it("the manage-link route is `paid`, so it is open DESPITE its class and not because of it", () => {
    const r = routes.find((x) => x.pattern === "/account/manage-link");
    expect(r!.cost).toBe("paid");
    expect(ACCESS_REFUSED_MAY_REACH.has(r!.cost)).toBe(false);
  });

  it("the product doors are NOT open — the census would be vacuous if everything were", () => {
    for (const pattern of ["/mailboxes", "/threads/merge", "/messages/:id/move"]) {
      const r = routes.find((x) => x.pattern === pattern);
      expect(r, pattern).toBeDefined();
      expect(accessRefusedMayReach(r!), pattern).toBe(false);
    }
  });

  it("an unrecognised cost class is REFUSED, never admitted", () => {
    // A cast, a JavaScript caller, a synthetic route in an un-typechecked file. "Closed" here is
    // the lock screen, which is reachable and reversible — the safe direction.
    expect(accessRefusedMayReach({ method: "GET", pattern: "/x", cost: undefined })).toBe(false);
    expect(accessRefusedMayReach({ method: "GET", pattern: "/x", cost: "nonsense" })).toBe(false);
  });
});

/**
 * A READ ROUTE MAY ANSWER ON A HELD ALLOW (2026-09-25). The gate asks the port with `staleAllow`
 * for a GET whose class writes nothing, and without it for everything else. The classification is
 * derived from the route's own method and `cost`, and the census below reads every route the gate
 * runs on, so a route nobody classed is refused here by name.
 */
describe("the access arm: a READ route may answer on a held allow, nothing else may", () => {
  const ALLOW: AccessVerdict = {
    ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true },
  };
  /** The options the GATE asked with — the first call, before any handler reads the port. */
  async function gateAsked(method: string, path: string, body?: string): Promise<unknown> {
    const asked: unknown[] = [];
    const { db, deps } = await depsWith(stubPort({
      access: async (_a, o) => { asked.push(o); return ALLOW; },
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    await H(req(method, path, { bearer: s.token, ...(body !== undefined ? { body } : {}) }), deps);
    expect(asked.length, `${method} ${path} never reached the access arm`).toBeGreaterThan(0);
    return asked[0];
  }

  it("a GET read route asks with staleAllow", async () => {
    expect(await gateAsked("GET", "/mailboxes")).toEqual({ staleAllow: true });
    expect(await gateAsked("GET", "/search?q=x")).toEqual({ staleAllow: true });
  });

  it("a write, and a GET that holds a connection, ask without it", async () => {
    expect(await gateAsked("POST", "/threads/merge", "{}")).toBeUndefined();
    expect(await gateAsked("GET", `/mailboxes/${randomUUID()}/organizer`)).toBeUndefined();
  });

  it("an UNCLASSED route waits like a write — the gate never guesses read", async () => {
    const asked: unknown[] = [];
    const { db, deps } = await depsWith(stubPort({
      access: async (_a, o) => { asked.push(o); return ALLOW; },
    }));
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const synthetic: Route = {
      method: "GET", pattern: "/unclassed", relay: false, cost: "nonsense" as CostClass,
      handler: async () => new Response("{}", { status: 200 }),
    };
    await createApp([synthetic]).handle(
      req("GET", "/unclassed", { bearer: s.token }), { ...deps, session: null, idempotency: null });
    expect(asked).toEqual([undefined]);
  });

  it("THE CENSUS — every route behind withSpendGate is classed read or write, none unclassed", () => {
    const key = (r: Route): string => `${r.method.toUpperCase()} ${r.pattern}`;
    const gated = apiRoutes.filter((r) => pipelineFor(r).includes(withSpendGate));
    expect(gated.length).toBeGreaterThan(100);
    expect(gated.filter((r) => accessRouteClassOf(r) === null).map(key)).toEqual([]);
    const reads = gated.filter((r) => accessRouteClassOf(r) === "read").map(key).sort();
    expect(reads).toEqual(gated
      .filter((r) => r.method.toUpperCase() === "GET" && r.cost === "read").map(key).sort());
    expect(reads.length, "no read route: the census would be vacuous").toBeGreaterThan(10);
    expect(gated.length - reads.length, "no write route: likewise").toBeGreaterThan(10);
    expect(reads.filter((k) => !k.startsWith("GET ")), "a non-GET is never a read").toEqual([]);
  });

  it("an unrecognised class or method is UNCLASSED, never read", () => {
    expect(accessRouteClassOf({ method: "GET", cost: undefined })).toBeNull();
    expect(accessRouteClassOf({ method: "GET", cost: "nonsense" })).toBeNull();
    expect(accessRouteClassOf({ method: "GET", cost: "toString" })).toBeNull();
    expect(accessRouteClassOf({ method: undefined, cost: "read" })).toBeNull();
    // The positive control, and the write half of each class.
    expect(accessRouteClassOf({ method: "get", cost: "read" })).toBe("read");
    for (const cost of ["unauthenticated", "ceremony", "work", "connection", "paid"]) {
      expect(accessRouteClassOf({ method: "GET", cost }), cost).toBe("write");
    }
    expect(accessRouteClassOf({ method: "POST", cost: "read" })).toBe("write");
  });
});

/**
 * `spendOf` — WHO CHARGES AN AI ACTION HERE, and the collapse that is right for this one question.
 *
 * `accessFor` must keep UNMETERED and an unfinished composition APART: refusing on an unfinished
 * one would lock every account out of an install whose operator simply has no entitlements
 * program. A spend site has no such distinction to make — in both cases the answer is "run the
 * model, charge nothing" — so `spendOf` answers `undefined` for both, and each call site's
 * existing absent-gate arm is what that reaches.
 */
describe("spendOf — the spend half, or nobody", () => {
  it("a PORT is handed straight through", async () => {
    const { deps } = await depsWith(stubPort({}));
    expect(spendOf(deps)).toBe(deps.services?.entitlementsPort);
  });

  it("UNMETERED answers nobody — a declared free tier charges nothing and asks nothing", async () => {
    const { deps } = await depsWith(UNMETERED);
    expect(spendOf(deps)).toBeUndefined();
  });

  it("an unfinished composition answers nobody too, and that collapse is deliberate", async () => {
    const { deps } = await makeDeps();
    expect(deps.services?.entitlementsPort).toBeUndefined();
    expect(spendOf(deps as ApiDeps)).toBeUndefined();
    // …while `entitlementsPort` — the accessor the manage-link surface uses — keeps them apart by
    // answering `null` for both and letting THAT caller decide, which is the distinction the
    // member exists to hold.
    expect(entitlementsPortOf(deps as ApiDeps)).toBeNull();
  });
});
