import { perRequest } from "./helpers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { accounts, users, sessions } from "@trafficflow/db";
import { loginTokens } from "@trafficflow/db/cloud";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  hashToken, generateToken, makeTestAuthDeps, makeAuthService,
  syncService, pushService, makeMailboxService, rulesService, messageService, threadService,
  makeScreenerService, makeApprovalService, triageService, searchService, makePrivacyService,
  contactsService, snippetsService, notifyRulesService, awayResponderService, attachmentsService,
  kbService, tagsService, draftsService, draftingService, sendService, workflowsService, proposalsService,
  type Db,
} from "@trafficflow/services";

/**
 * THE DESKTOP HANDOFF, AGAINST REAL POSTGRES — the two claims PGlite structurally cannot judge.
 *
 *  1. **SINGLE-USE UNDER CONCURRENCY.** `claimDesktopLink` burns the code with ONE
 *     `UPDATE … WHERE consumed_at IS NULL … RETURNING`, so the row lock decides the race and
 *     exactly one caller gets a session. The defect this shape exists to prevent —
 *     SELECT, check `consumed_at`, then UPDATE — passes every sequential test ever written and
 *     hands N simultaneous presentations N sessions. PGlite is a single connection and can
 *     never interleave two claims, so the sequential guard in `desktop-link.test.ts` is
 *     necessary and is not this. `consumeEmailVerification` was fixed for the identical reason
 *     and has the identical guard in `mail-concurrency.pg.test.ts`.
 *
 *     Twelve simultaneous claims, from SEPARATE CONNECTIONS — one `Promise.all` over one
 *     connection would serialize in the driver and prove nothing.
 *
 *  2. **HASH AT REST.** Asserted by scanning `login_tokens` for the code's plaintext with a
 *     query the database evaluates, over every column that could hold it, rather than by
 *     reading one field the test already knows the name of. A future column that started
 *     carrying the raw value would pass a field-by-field check written today.
 *
 * `describe.skipIf` on a missing Postgres, and `TF_REQUIRE_PG=1` (i.e. `pnpm test:pg`) makes
 * `realPgAvailable()` throw instead — so CI cannot silently skip this file.
 */
const PG_UP = await realPgAvailable();

const FIXED_NOW = new Date("2026-08-09T12:00:00.000Z");
const app = createApp(apiRoutes);

/** A real-Postgres `ApiDeps` on its OWN connection — separate connections are what make a race. */
function depsOn(db: Db): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return perRequest({
    db,
    now: () => FIXED_NOW,
    requestId: `pg-${randomUUID()}`,
    session: null,
    authConfig: authDeps.config,
    keyProvider: authDeps.keyProvider,
    services: {
      auth: makeAuthService(authDeps),
      sync: syncService,
      push: pushService,
      mailbox: makeMailboxService({ keyProvider: authDeps.keyProvider }),
      rules: rulesService,
      message: messageService,
      thread: threadService,
      screener: makeScreenerService({}),
      approval: makeApprovalService({}),
      triage: triageService,
      search: searchService,
      privacy: makePrivacyService({
        remote: { async fetch() { return { status: 200, contentType: "image/gif", body: new Uint8Array() }; } },
        resolver: { async resolve() { return ["93.184.216.34"]; } },
      }),
      contacts: contactsService,
      snippets: snippetsService,
      notify: notifyRulesService,
      away: awayResponderService,
      attachments: attachmentsService,
      kb: kbService,
      tags: tagsService,
      drafts: draftsService,
      drafting: draftingService,
      sends: sendService,
      workflows: workflowsService,
      proposals: proposalsService,
    },
  });
}

describe.skipIf(!PG_UP)("the desktop handoff code is single-use against real Postgres", () => {
  /** One connection per concurrent claimant, plus one for the fixtures. */
  const FANOUT = 12;
  let owned: OwnedDb[] = [];
  let dbs: Db[] = [];
  let fixture: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = Array.from({ length: FANOUT + 1 }, () => makeOwnedDb(PG_TEST_URL));
    dbs = owned.map((o) => o.db as unknown as Db);
    fixture = dbs[FANOUT]!;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(owned.map((o) => o.close()));
  });

  /** An account with a full, step-up-cleared session — what the settings pane mints from. */
  async function seed(): Promise<{ token: string; userId: string; accountId: string }> {
    const token = generateToken();
    const [acct] = await fixture.insert(accounts).values({ name: `link-${randomUUID()}` }).returning();
    const [user] = await fixture.insert(users)
      .values({
        accountId: acct!.id, email: `l-${randomUUID()}@example.com`, displayName: "L",
        emailVerifiedAt: FIXED_NOW,
      }).returning();
    await fixture.insert(sessions).values({
      accountId: acct!.id,
      userId: user!.id,
      familyId: randomUUID(),
      accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000),
      lastTwofaAt: FIXED_NOW,
    });
    return { token, userId: user!.id, accountId: acct!.id };
  }

  const mint = async (bearer: string, body: Record<string, unknown> = {}): Promise<string> => {
    const res = await app.handle(new Request("http://localhost/auth/desktop-link", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }), depsOn(fixture));
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json() as { code: string }).code;
  };

  /**
   * A PKCE pair, computed here rather than with the service's `hashToken` — see the same helper
   * in `desktop-link.test.ts`. The encoding is a wire contract a second implementation has to
   * reproduce, so it is spelled out instead of borrowed.
   */
  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString("base64url");
    return {
      verifier,
      challenge: createHash("sha256").update(verifier, "utf8").digest("base64url"),
    };
  };

  /**
   * A CLIENT ADDRESS NOTHING ELSE HAS EVER USED, and this is not tidiness.
   *
   * The claim's limiter is `reserveIpSlot`, which writes `auth_throttle` keyed on the address's
   * hash and rolls the window against `ctx.now()` — and `ctx.now()` here is FIXED. So a literal
   * address accumulates failures in a database that is not reset between runs, in a window that
   * can never roll, and the eleventh run of this file answers 429 to every claim. Measured: the
   * fixed-address version passed, then failed on a later run with two 429s and no diagnostic
   * connecting it to the runs before — which reads exactly like a flake in the subject under
   * test rather than a fixture that poisoned itself.
   *
   * A fresh random address per call means the limiter is never the reason a claim is refused,
   * which is what these tests want: the subject is the burn, not the counter. The counter has
   * its own guard in `desktop-link.test.ts`, where PGlite gives it a clean table every time.
   */
  const freshIp = (): string =>
    `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}-${randomUUID()}`;

  const claimWith = (db: Db, body: unknown, ip: string = freshIp()): Promise<Response> =>
    app.handle(new Request("http://localhost/auth/desktop-claim", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vercel-forwarded-for": ip },
      body: JSON.stringify(body),
    }), depsOn(db));

  const claimOn = (db: Db, code: string, ip: string = freshIp()): Promise<Response> =>
    claimWith(db, { code }, ip);

  it("TWELVE simultaneous claims of one code produce exactly ONE session", async () => {
    const { token, userId } = await seed();
    const code = await mint(token);

    // A DIFFERENT, FRESH address per claimant — see {@link freshIp}. The per-IP slot claim is
    // not the subject here, and twelve requests sharing one would trip it at the eleventh, which
    // would "pass" this test for entirely the wrong reason and go on passing after the burn
    // stopped being atomic.
    const results = await Promise.all(dbs.slice(0, FANOUT).map((db) => claimOn(db, code)));

    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 400);
    expect(ok, `statuses: ${results.map((r) => r.status).join(",")}`).toHaveLength(1);
    expect(refused).toHaveLength(FANOUT - 1);

    // The database's own count, which is the fact the status codes are only evidence for: a
    // handler that answered one 200 and eleven 400s while establishing twelve sessions would
    // pass the assertions above and be the exact defect.
    const live = await fixture.select().from(sessions).where(eq(sessions.userId, userId));
    expect(live).toHaveLength(2);       // the seeded browser session + the one claimant

    const rows = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
  }, 60_000);

  it("TWO SIMULTANEOUS MINTS leave exactly ONE live code — the supersede is a lock, not a sequence", async () => {
    const { token, userId } = await seed();

    // Delete-then-insert is not a supersede under READ COMMITTED: both deletes see the other's
    // row as absent, both inserts land, and the user is told the old code is dead while it is
    // still a live way into their mail. `FOR UPDATE` on the user's row is what makes the second
    // mint's delete run after the first mint's insert is visible. A double-click is enough to
    // reach this, and PGlite — one connection — cannot interleave two mints at all.
    const mintOn = (db: Db): Promise<Response> =>
      app.handle(new Request("http://localhost/auth/desktop-link", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      }), depsOn(db));

    const [a, b] = await Promise.all([mintOn(dbs[0]!), mintOn(dbs[1]!)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const codes = [
      (await a.json() as { code: string }).code,
      (await b.json() as { code: string }).code,
    ];
    expect(codes[0]).not.toBe(codes[1]);

    const rows = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(rows, `two concurrent mints left ${rows.length} live codes`).toHaveLength(1);

    // …and it is one of the two that were handed out, not a row from somewhere else. Exactly one
    // of the codes still claims; the other is gone.
    const claimed = await Promise.all(codes.map((c, i) => claimOn(dbs[i]!, c)));
    expect(claimed.filter((r) => r.status === 200)).toHaveLength(1);
    expect(claimed.filter((r) => r.status === 400)).toHaveLength(1);
  }, 30_000);

  it("A BOUND CODE: twelve simultaneous claims with the right verifier still produce ONE session", async () => {
    const { token, userId } = await seed();
    const { verifier, challenge } = pkce();
    const code = await mint(token, { challenge });

    // The binding is one more conjunct of the SAME `UPDATE … WHERE … RETURNING`, which is the
    // whole reason it is written that way. The alternative anybody would reach for first — read
    // the row, compare the digest here, then burn it — reintroduces the read-modify-write this
    // file's first test exists to forbid, and it does so INVISIBLY: every sequential test passes,
    // because the defect needs two claims in flight at once and PGlite has one connection.
    //
    // Twelve claimants, each on its own connection, all holding the correct verifier. Exactly one
    // session, or the binding was bolted on outside the atomic statement.
    const results = await Promise.all(
      dbs.slice(0, FANOUT).map((db) => claimWith(db, { code, verifier })),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok, `statuses: ${results.map((r) => r.status).join(",")}`).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(FANOUT - 1);

    const live = await fixture.select().from(sessions).where(eq(sessions.userId, userId));
    expect(live).toHaveLength(2);       // the seeded browser session + the one claimant
    const rows = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
  }, 60_000);

  it("A BOUND CODE SURVIVES a burst of claims that cannot satisfy the binding", async () => {
    const { token, userId } = await seed();
    const { verifier, challenge } = pkce();
    const code = await mint(token, { challenge });

    // What a scheme interceptor can actually do: it holds the code and no verifier. Six attempts
    // with the field ABSENT and six with a wrong value, all at once, from separate connections.
    // None may burn the code — the predicate is on the UPDATE, so a claim that cannot satisfy the
    // binding matches no row — and the person's own app must still be able to use it afterwards.
    const attempts = await Promise.all(dbs.slice(0, FANOUT).map((db, i) => (
      i % 2 === 0
        ? claimWith(db, { code })
        : claimWith(db, { code, verifier: pkce().verifier })
    )));
    expect(attempts.map((r) => r.status).filter((s) => s !== 400)).toEqual([]);

    const before = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(before[0]!.consumedAt, "a failed binding burned the code").toBeNull();
    expect((await claimWith(dbs[0]!, { code, verifier })).status).toBe(200);
    expect(await fixture.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(2);
  }, 60_000);

  it("an UNBOUND code claimed WITH a verifier present is refused by the UPDATE, and NOT burned", async () => {
    const { token, userId } = await seed();
    // Minted with NO challenge — the retype flow — so `challenge_hash IS NULL`.
    const code = await mint(token);
    const before = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(before[0]!.challengeHash).toBeNull();

    // The login-CSRF injection direction (SEC2-AUTH-DEEPLINK-INJECT), judged by the atomic
    // `UPDATE … WHERE … RETURNING` rather than by application code: an attacker's unbound code
    // delivered to a victim whose install is holding a verifier. The verifier-present arm is an
    // EXACT `challenge_hash = digest` match, which no unbound (NULL) row can satisfy, so the claim
    // matches no row, establishes no session, and — the predicate being on the UPDATE — leaves the
    // code live for the retype client that never sends a verifier.
    const injected = await claimWith(dbs[0]!, { code, verifier: pkce().verifier });
    expect(injected.status, await injected.clone().text()).toBe(400);
    const after = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(after[0]!.consumedAt, "an injected verifier burned an unbound code").toBeNull();
    expect(await fixture.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
    // Still claimable as what it was minted — unbound, no verifier.
    expect((await claimOn(dbs[0]!, code)).status).toBe(200);
  }, 30_000);

  it("the VERIFIER's plaintext appears in NO column of login_tokens", async () => {
    const { token, userId } = await seed();
    const { verifier, challenge } = pkce();
    await mint(token, { challenge });

    // The same whole-row search the code gets below, aimed at the value that must never be
    // written down: the challenge is public and IS stored, the verifier is the secret half and
    // lives only in the process that invented it. A column that started carrying it would pass a
    // field-by-field check written today.
    const [hit] = await fixture.execute(sql`
      select count(*)::int as n from login_tokens
      where user_id = ${userId}::uuid and login_tokens::text like ${`%${verifier}%`}
    `) as unknown as Array<{ n: number }>;
    expect(hit!.n, "the raw PKCE verifier is stored somewhere in login_tokens").toBe(0);

    // …and the CHALLENGE is there verbatim, so the search above is looking at a row that exists
    // and the binding is checkable by a reader of the table.
    const rows = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(rows[0]!.challengeHash).toBe(challenge);
  }, 30_000);

  it("the code's plaintext appears in NO column of login_tokens", async () => {
    const { token, userId } = await seed();
    const code = await mint(token);

    // Every column, cast to text and concatenated, searched by Postgres. Deliberately not
    // `expect(row.tokenHash).not.toBe(code)`: that is an assertion about the one field whose
    // name is already known, and the risk is a field somebody adds later.
    const [hit] = await fixture.execute(sql`
      select count(*)::int as n from login_tokens
      where user_id = ${userId}::uuid and login_tokens::text like ${`%${code}%`}
    `) as unknown as Array<{ n: number }>;
    expect(hit!.n, "the raw handoff code is stored somewhere in login_tokens").toBe(0);

    // …and the digest IS there, so the search above is looking at a row that exists.
    const rows = await fixture.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(code));
  }, 30_000);
});
