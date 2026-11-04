import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { eq, sql } from "drizzle-orm";
import { localRoutes } from "@trafficflow/api/local";
import { accounts, mailboxCredentials, mailboxes, sessions } from "@trafficflow/db";
import { localAiRoutes } from "../src/ai-routes.js";
import { localAutoSuggestRoutes } from "../src/auto-suggest-routes.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { hostPairRoutes } from "../src/host-pair-routes.js";
import { localLanRoutes } from "../src/lan-routes.js";
import { ENDED_BEARER_EXITS } from "../src/launch-bearer.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { SEARCH_INDEX_ROUTE } from "../src/search-index-door.js";
import {
  WINDOW_CONSENT_READ_FAILED_ROUTE, WINDOW_SEARCH_PHASES_ROUTE, WINDOW_SYNC_FAILED_ROUTE,
} from "../src/window-report.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE LOCAL ACTION DOORS RECORD THEIR ARRIVAL, NOT ONLY THEIR VERDICT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on a released build: the first `Organize here instead` press produced NO engine event
 * at all, and a second one minutes later was authorized in 789 ms. The engine was alive
 * throughout — 59 drains in the window — and the mailbox held no claim, so nothing about the
 * state explained the first press going nowhere. Nothing could: with only a verdict logged, "the
 * press never reached the door" and "the door took it and dropped it" leave identical evidence,
 * which is a condition nobody can watch fail in the one place a takeover is decided.
 *
 * ── THE REFUSED PATH IS THE SUBJECT, NOT AN AFTERTHOUGHT ──────────────────────────────────
 *
 * A verdict-only log already covers the accepted path. What it never covered is a request the
 * door answered and said nothing about — the shared 401 and the takeover's own 400 — so those
 * are the two cases the row was filed for and the two this file leans on.
 */

class MemoryMetaFolder implements LeaseIo {
  private claims: RawClaimMessage[] = [];
  private nextUid = 1;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/** The mailbox address this install holds. Asserted ABSENT from every line these doors write. */
const ADDRESS = "owner@trafficflow.test";

function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}

interface Line {
  event: string; method?: string; route?: string; mailboxId?: string; status?: number;
}

describe("the local action doors' receipt", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  interface Booted {
    sidecar: Sidecar;
    lines: Line[];
    raw: string[];
    seen: (event: string) => Line[];
    /** Only the two events this file is about, in the order they were written. */
    trail: () => Line[];
  }

  async function boot(): Promise<Booted> {
    const dir = await freshDataDir("ohmail-receipt-");
    const lines: Line[] = [];
    const raw: string[] = [];
    const logger = createSidecarLogger({
      sink: (line) => { raw.push(line); lines.push(JSON.parse(line) as Line); },
    });
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: ADDRESS, pass: "mailbox-unreached-password" },
      },
      address: ADDRESS,
      machineName: "receipt host",
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      log: diagnosticFor(logger),
      logger,
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    });
    return {
      sidecar, lines, raw,
      seen: (event) => lines.filter((l) => l.event === event),
      trail: () => lines.filter(
        (l) => l.event === "local_action_received" || l.event === "local_action_refused"),
    };
  }

  const ID = "3f1c1f0e-0000-4000-8000-000000000001";

  /** Every action door, with the pattern its receipt must name. The connections GET is not one. */
  const DOORS: Array<[method: string, path: string, route: string, mailboxId: string]> = [
    ["POST", "/local/mailboxes", "/local/mailboxes", ""],
    ["POST", "/local/mailboxes/probe", "/local/mailboxes/probe", ""],
    ["POST", `/local/mailboxes/${ID}/organize`, "/local/mailboxes/:id/organize", ID],
    ["PATCH", `/local/mailboxes/${ID}`, "/local/mailboxes/:id", ID],
    ["PATCH", `/local/mailboxes/${ID}/name`, "/local/mailboxes/:id/name", ID],
    ["DELETE", `/local/mailboxes/${ID}`, "/local/mailboxes/:id", ID],
    ["DELETE", "/local/stored-login", "/local/stored-login", ""],
    ["POST", "/local/organizer/takeover", "/local/organizer/takeover", ""],
  ];

  it("EVERY action door records its arrival, and the pattern and method identify which", async () => {
    const b = await boot();

    for (const [method, path] of DOORS) {
      await b.sidecar.handle(new Request(`http://local${path}`, { method }));
    }

    const got = b.seen("local_action_received");
    expect(
      got.map((l) => [l.method, l.route, l.mailboxId]),
      "a door took a request and recorded nothing, so a dropped press cannot be told from one "
      + "that never arrived",
    ).toEqual(DOORS.map(([method, , route, mailboxId]) => [method, route, mailboxId]));
  });

  it("THE SHARED 401 CARRIES A VERDICT — the refusal that used to answer in silence", async () => {
    const b = await boot();

    // No bearer at all: the block's FIRST branch, which is why the receipt is above it.
    const res = await b.sidecar.handle(
      new Request("http://local/local/organizer/takeover", { method: "POST" }));

    expect(res.status).toBe(401);
    expect(
      b.trail().map((l) => [l.event, l.status ?? null]),
      "the door answered 401 and the log shows an arrival with no outcome — which is the state "
      + "a receipt on its own would leave",
    ).toEqual([
      ["local_action_received", null],
      ["local_action_refused", 401],
    ]);
  });

  it("THE TAKEOVER'S OWN 400 CARRIES ONE TOO — a press that named no mailbox", async () => {
    const b = await boot();

    const res = await b.sidecar.handle(new Request("http://local/local/organizer/takeover", {
      method: "POST",
      headers: { authorization: `Bearer ${b.sidecar.sessionToken}` },
    }));

    expect(res.status).toBe(400);
    expect(b.trail().map((l) => [l.event, l.route, l.status ?? null])).toEqual([
      ["local_action_received", "/local/organizer/takeover", null],
      ["local_action_refused", "/local/organizer/takeover", 400],
    ]);
  });

  it("an ACCEPTED action is a receipt then the door's own verdict, in that order", async () => {
    // The positive control. Without it every assertion above is satisfied by a door that refuses
    // everything, and the product would be unusable with this file green.
    const b = await boot();

    const res = await b.sidecar.handle(new Request("http://local/local/organizer/takeover", {
      method: "POST",
      headers: {
        authorization: `Bearer ${b.sidecar.sessionToken}`, "content-type": "application/json",
      },
      body: JSON.stringify({ mailboxId: b.sidecar.world.mailboxId }),
    }));

    expect(res.status, "the ordinary press was refused").toBe(200);
    const order = b.lines
      .map((l) => l.event)
      .filter((e) => e === "local_action_received" || e === "local_action_refused"
        || e === "organizer_takeover_authorized");
    expect(order).toEqual(["local_action_received", "organizer_takeover_authorized"]);
  });

  it("THE CONNECTIONS READ IS NOT AN ACTION — a receipt there would be four lines a minute", async () => {
    // Settings asks it on a timer, so an unconditional receipt is noise for as long as the pane
    // is open — the thing this instrument exists to make readable rather than to add to. What
    // that route needs is a rate floor, which belongs with the route and not here.
    const b = await boot();

    await b.sidecar.handle(new Request("http://local/local/mailboxes/connections", {
      method: "GET", headers: { authorization: `Bearer ${b.sidecar.sessionToken}` },
    }));

    expect(b.trail(), "the liveness read is being recorded as an action").toEqual([]);
  });

  it("no line these doors write carries the mailbox address", async () => {
    const b = await boot();

    for (const [method, path] of DOORS) {
      await b.sidecar.handle(new Request(`http://local${path}`, { method }));
    }

    expect(b.seen("local_action_received").length, "nothing was recorded, so this proves nothing")
      .toBe(DOORS.length);
    expect(b.raw.join("\n")).not.toContain(ADDRESS);
    expect(b.raw.join("\n")).not.toContain("imap.invalid");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WAY OUT OF A BROKEN SESSION NEVER DEPENDS ON THE BROKEN THING
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Leave the app open for a day. The launch bearer is minted at boot, cannot be refreshed, and
 * expires — so every route answers 401, no mail arrives, and SIGN OUT answered 401 with them.
 * The one action a person takes to end a broken session was the one action that needed it; the
 * only way out was a restart nothing told them about.
 *
 * The token's life is NOT extended: this is the sign-out door alone opening on this install's
 * own expired bearer, and every other door refusing at the same minute it always did — but
 * refusing BY NAME, so the pane that polls them can say what happened instead of "Can't check
 * the mail server right now".
 *
 * WATCH THEM FAIL (edit `engine.ts`, watch, restore):
 *  · drop `localSignOutMatch ?` from the `core` line → the sign-out case reddens with 401, which
 *    is the defect;
 *  · answer the shared `unauthorized` body for an expired bearer → the naming case reddens and
 *    the pane goes back to its silence.
 */
describe("a launch bearer that has expired", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  const HOUR = 60 * 60 * 1000;
  let clock = Date.now();
  let events: string[] = [];

  async function boot(): Promise<Sidecar> {
    const dir = await freshDataDir("ohmail-expired-launch-");
    clock = Date.now();
    events = [];
    const logger = createSidecarLogger({
      sink: (line) => { events.push((JSON.parse(line) as Line).event); },
    });
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: ADDRESS, pass: "mailbox-unreached-password" },
      },
      address: ADDRESS,
      machineName: "the machine left open for a day",
      now: () => new Date(clock),
      log: diagnosticFor(logger),
      logger,
      /* A KEY RING, so the launch SEALS the password it was handed: without one nothing is
         stored and the sign-out would have nothing to remove — a green case for no reason. */
      keks: { 1: Buffer.alloc(32, 7) },
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    });
    return sidecar;
  }

  /* A DAY PASSES WITH EVERY RENEWAL REFUSED, which is how the HOLDER ends on its own clock: the
     store refuses the one write that moves the expiry and takes every other. The holder decides
     before any door reads the row, so aging the row alone left it admitting. The row stays
     unrevoked and this install's own; only the engine's clock moves. */
  const age = async (s: Sidecar): Promise<void> => {
    await s.db.execute(sql.raw(`CREATE FUNCTION refuse_launch_renewal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.access_expires_at IS DISTINCT FROM OLD.access_expires_at THEN
          RAISE EXCEPTION 'the store refused the renewal';
        END IF;
        RETURN NEW;
      END $$`));
    await s.db.execute(sql.raw(`CREATE TRIGGER refuse_launch_renewal BEFORE UPDATE ON sessions
      FOR EACH ROW EXECUTE FUNCTION refuse_launch_renewal()`));
    clock += 25 * HOUR;
  };

  /** The holder's own verdict, read where every other route meets it. */
  const holderRefuses = async (s: Sidecar): Promise<void> => {
    const res = await ask(s, "GET", "/local/mailboxes/connections", s.sessionToken);
    expect(`${res.status} ${(await res.json()).error?.code}`, "the holder still admits: the rig "
      + "aged nothing it decides on").toBe("401 launch_session_expired");
  };

  const ask = (s: Sidecar, method: string, path: string, bearer: string): Promise<Response> =>
    s.handle(new Request(`http://local${path}`, {
      method, headers: { authorization: `Bearer ${bearer}` },
    }));

  it("SIGNS OUT on an expired bearer, and the password is actually gone", async () => {
    const s = await boot();
    expect((await s.db.select().from(mailboxCredentials)).length,
      "the rig sealed no password, so the sign-out has nothing to prove").toBe(1);
    await age(s);
    await holderRefuses(s);
    expect(events, "the renewal was never refused, so the holder did not end on its clock")
      .toContain("launch_bearer_renew_failed");
    const [row] = await s.db.select().from(sessions).where(eq(sessions.accountId, s.world.accountId));
    expect(row!.revokedAt, "the row was revoked, which is not the state under test").toBeNull();
    expect(row!.accessExpiresAt.getTime()).toBeLessThan(clock);

    const res = await ask(s, "DELETE", "/local/stored-login", s.sessionToken);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ cleared: true });
    expect((await s.db.select().from(mailboxCredentials)).length,
      "the door answered success and left the sealed password on the disk").toBe(0);
  });

  it("EVERY OTHER DOOR STILL REFUSES — the clock is not relaxed, only this one door", async () => {
    const s = await boot();
    await age(s);

    const res = await ask(s, "GET", "/local/mailboxes/connections", s.sessionToken);

    expect(res.status).toBe(401);
    /* AND IT SAYS WHICH REFUSAL THIS IS. The pane rendered a bare 401 as "Can't check the mail
       server right now" — a silence that reads as no new mail, for a state with a remedy. */
    expect((await res.json()).error.code).toBe("launch_session_expired");
  });

  it("POSITIVE CONTROL — a LIVE bearer signs out exactly as it always did", async () => {
    const s = await boot();

    const res = await ask(s, "DELETE", "/local/stored-login", s.sessionToken);

    expect(res.status, await res.clone().text()).toBe(200);
    expect((await s.db.select().from(mailboxCredentials)).length).toBe(0);
  });

  it("A BEARER THIS INSTALL DOES NOT KNOW is refused, and is not an expiry", async () => {
    const s = await boot();
    await age(s);

    /* The negative: absence is not expiry, and a stranger's token must not open the one door
       that erases somebody's password. */
    const res = await ask(s, "DELETE", "/local/stored-login", "not-a-token-this-install-minted");

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
    expect((await s.db.select().from(mailboxCredentials)).length,
      "an unrecognised bearer erased this install's password").toBe(1);
  });

  it("A REVOKED session reaches the way out, and its door still refuses it", async () => {
    const s = await boot();
    await s.db.update(sessions).set({ revokedAt: new Date(clock) })
      .where(eq(sessions.accountId, s.world.accountId));
    // Past the half-life, so the holder's renewal finds the row revoked and ends.
    clock += 13 * HOUR;
    await holderRefuses(s);

    const res = await ask(s, "DELETE", "/local/stored-login", s.sessionToken);

    /* `unauthorized`, the DOOR's answer: the pre-check let it through and the door's own question
       (`resolveExpiredLaunchSession`) relaxes the clock alone, never a revocation. */
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
    expect((await s.db.select().from(mailboxCredentials)).length,
      "a revoked bearer erased this install's password").toBe(1);
  });

  /** Every route this engine serves on `handle`, with a uuid for each path parameter. */
  const everyRoute = (): Array<[method: string, path: string]> => {
    const ID = "3f1c1f0e-0000-4000-8000-000000000002";
    const tables = [
      localRoutes, hostPairRoutes, localLanRoutes(() => null), localAiRoutes({} as never),
      localAutoSuggestRoutes({ db: {} as never, accountId: "", ai: {} as never, now: () => new Date() }),
    ];
    const pairs: Array<[string, string]> = tables.flat()
      .map((r) => [r.method, r.pattern.replace(/:[A-Za-z_]+/g, ID)]);
    for (const [method, path] of [
      ["POST", "/local/mailboxes"], ["POST", "/local/mailboxes/probe"],
      ["GET", "/local/mailboxes/connections"], ["POST", `/local/mailboxes/${ID}/organize`],
      ["PATCH", `/local/mailboxes/${ID}`], ["PATCH", `/local/mailboxes/${ID}/name`], ["DELETE", `/local/mailboxes/${ID}`],
      ["POST", "/local/organizer/takeover"], ["DELETE", "/local/stored-login"],
      ["POST", WINDOW_SYNC_FAILED_ROUTE], ["POST", WINDOW_SEARCH_PHASES_ROUTE],
      ["POST", WINDOW_CONSENT_READ_FAILED_ROUTE], ["GET", SEARCH_INDEX_ROUTE],
      // The near misses of the one way out: another verb, another spelling of the path.
      ["GET", "/local/stored-login"], ["POST", "/local/stored-login"],
      ["DELETE", "/local/stored-login/"], ["DELETE", "/local/stored-login/x"],
      ["DELETE", "/LOCAL/STORED-LOGIN"], ["DELETE", "/local/stored-logins"],
    ] as const) pairs.push([method, path]);
    return [...new Map(pairs.map((p) => [p.join(" "), p] as const)).values()];
  };

  it("THE WAYS OUT ARE EXACTLY THE NAMED ROUTES — every other route refuses an ended bearer", async () => {
    expect(ENDED_BEARER_EXITS, "the allow-list grew or shrank; name the route and its door")
      .toEqual([{ method: "DELETE", path: "/local/stored-login" }]);
    const s = await boot();
    await age(s);
    const routes = everyRoute();
    expect(routes.length, "the census walked almost nothing").toBeGreaterThan(100);

    const reached: string[] = [];
    for (const [method, path] of routes) {
      const res = await ask(s, method, path, s.sessionToken);
      let code: string | undefined;
      if (res.status === 401) {
        code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      } else {
        await res.body?.cancel();
      }
      if (code !== "launch_session_expired") reached.push(`${method} ${path}`);
    }

    expect(reached.sort()).toEqual(ENDED_BEARER_EXITS.map((e) => `${e.method} ${e.path}`).sort());
  });
});

describe("the sender name door", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(): Promise<{ s: Sidecar; dials: () => number }> {
    const dir = await freshDataDir("ohmail-sender-name-");
    let dials = 0;
    const inner = quietMailbox();
    const s = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "mailbox-unreached-password" } },
      address: ADDRESS,
      machineName: "sender name host",
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: (cfg) => { dials += 1; return inner(cfg); },
    });
    cleanups.push(async () => {
      await s.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    });
    return { s, dials: () => dials };
  }

  const name = (s: Sidecar, id: string, body: unknown, bearer: string | null = s.sessionToken): Promise<Response> =>
    s.handle(new Request(`http://local/local/mailboxes/${id}/name`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify(body),
    }));
  const stored = async (s: Sidecar, id: string): Promise<string | null> =>
    (await s.db.select({ n: mailboxes.displayName }).from(mailboxes).where(eq(mailboxes.id, id)))[0]?.n ?? null;

  it("writes the name, and blank clears it, with no second dial of the mailbox", async () => {
    const { s, dials } = await boot();
    const id = s.world.mailboxId!;
    const before = dials();
    const res = await name(s, id, { displayName: "  Ada   Lovelace " });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { displayName: string | null }).displayName).toBe("Ada Lovelace");
    expect(await stored(s, id)).toBe("Ada Lovelace");
    expect((await name(s, id, { displayName: "  " })).status).toBe(200);
    expect(await stored(s, id)).toBeNull();
    expect(dials(), "the name change re-attached the mailbox").toBe(before);
  });

  it("refuses a long name, a control character, another account's mailbox and a missing bearer", async () => {
    const { s } = await boot();
    const id = s.world.mailboxId!;
    expect((await name(s, id, { displayName: "x".repeat(101) })).status).toBe(400);
    expect((await name(s, id, { displayName: "Eve\r\nBcc: x@evil.test" })).status).toBe(400);
    expect((await name(s, id, { displayName: 7 })).status).toBe(400);
    expect((await name(s, id, { displayName: "Ada" }, null)).status).toBe(401);
    const [other] = await s.db.insert(accounts).values({ name: "another" }).returning({ id: accounts.id });
    const [theirs] = await s.db.insert(mailboxes).values({ accountId: other!.id, provider: "imap", address: "them@trafficflow.test" })
      .returning({ id: mailboxes.id });
    expect((await name(s, theirs!.id, { displayName: "Mine now" })).status).toBe(404);
    expect(await stored(s, theirs!.id)).toBeNull();
    expect(await stored(s, id)).toBeNull();
  });
});
