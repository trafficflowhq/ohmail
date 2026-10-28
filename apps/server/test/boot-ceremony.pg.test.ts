import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { users } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { setupProdDatabase } from "@trafficflow/db/admin";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import {
  SETUP_ROLE_PREFIX, openAdmin, setupRole, sharedRoleGuard, sweepStaleRoles, type AdminSql,
} from "../../../packages/db/test/_setup-role.js";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { createLogger } from "@trafficflow/core";
import { totpNow, makeMailboxService, MailboxAllowanceError, ServiceError, type ServiceContext } from "@trafficflow/services";
import { loadServerConfig } from "../src/config.js";
import { buildServerServices, oauthProviderFor, type ServerRuntime } from "../src/deps.js";
import { handleServerRequest } from "../src/handler.js";
import { makeHttpServer } from "../src/http.js";
import { mintFirstRunSetupToken } from "../src/setup-token.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE FIRST-BOOT CEREMONY, END TO END, over a REAL SOCKET against REAL POSTGRES — the server slice's
 * acceptance in one file: boot (setupProdDatabase → mint → listen) → `/hello needsSetup:true` →
 * redeem the printed token → register (VERIFIED, the ownerless path) → enroll TOTP → sign in
 * (the cookies carry HttpOnly+SameSite=Strict+Secure and NO `Domain=`) → CSRF double-submit
 * mutation → TWO mailboxes with ZERO billing env (the guard, with the reverted-to-default
 * composition shown refusing in-suite) → the pairing-invited SECOND account, UNVERIFIED, adds a
 * mailbox too (obligation 4: `requireVerifiedForProduct: false` composed explicitly).
 *
 * The server is the REAL composition — `loadServerConfig` → `buildServerServices` →
 * `makeHttpServer(handleServerRequest)` — booted in the ruled order by the same exported pieces
 * `index.ts` sequences; the two test seams are the ones every mailbox-add test in this
 * repository uses: `ImapAdapter.prototype.connect/close` spied (the suite performs zero
 * external requests) and `TF_PROBE_ALLOW_PRIVATE=1` so the SSRF gate does not resolve DNS in a
 * sandbox that has none. The API-level point the webapp note defers to is also here: the
 * SERVER answers the mailbox adds — no client-side billing pre-check has any say.
 *
 * Sequential `it`s over shared state, deliberately: this is ONE ceremony, and each step's
 * precondition is the previous step's assertion.
 */
const PG_UP = await realPgAvailable();

/* Built and removed by the hooks below, which name the budgets that work costs. */
const box = throwawayDb("server_ceremony");
/** The server boots as a throwaway superuser, so setupProdDatabase's ALTER ROLE never lands on the shared role. */
const SETUP_ROLE = setupRole();
const guard = sharedRoleGuard();
let roleAdmin: AdminSql | undefined;
const dbUrl = (): string => SETUP_ROLE.urlFor(box.url);

const KEK = "ab".repeat(32);
const PW = "pw-correct-horse-battery";

let owned: OwnedDb;
let server: Server;
let port = 0;
let setupToken = "";
// Tokens the INVARIANT mints mid-life (never during the normal ceremony) — see the last test.
const midlifeMints: string[] = [];

const at = (path: string): string => `http://127.0.0.1:${port}${path}`;

interface Jar { cookie: string; csrf: string }

/** Parse a response's Set-Cookie lines into a request jar (tf_* values only). */
function jarOf(res: Response): Jar {
  const values: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const first = line.split(";")[0]!;
    const eq = first.indexOf("=");
    if (eq > 0) values[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return {
    cookie: Object.entries(values).map(([k, v]) => `${k}=${v}`).join("; "),
    csrf: values["tf_csrf"] ?? "",
  };
}

const post = (path: string, body: unknown, jar?: Jar, extra: Record<string, string> = {}): Promise<Response> =>
  fetch(at(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jar ? { cookie: jar.cookie, "x-csrf-token": jar.csrf } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });

/** The FIRST full sign-in's Set-Cookie lines — the cookie-attribute test's subject. */
let firstVerifySetCookies: string[] = [];

/** register (invite) → TOTP enroll+activate → login → totp verify ⇒ a FULL cookie session. */
async function signUpAndIn(email: string, inviteCode: string): Promise<{ full: Jar; verifyRes: Response }> {
  const reg = await post("/auth/register", { email, password: PW, displayName: "Fam", inviteCode });
  expect(reg.status).toBe(201);
  const enrollment = jarOf(reg);

  const enroll = await post("/auth/2fa/totp/enroll", {}, enrollment);
  expect(enroll.status).toBe(200);
  const { secret } = await enroll.json() as { secret: string };
  const activate = await post("/auth/2fa/totp/activate", { code: totpNow(secret, new Date()) }, enrollment);
  expect(activate.status).toBe(200);

  const login = await post("/auth/login", { email, password: PW });
  expect(login.status).toBe(200);
  const l = await login.json() as { status: string; loginToken: string };
  expect(l.status).toBe("twofa_required");
  // The NEXT time-step's code, deliberately: activate CONSUMED the current step (single-use
  // per timestep is the replay guard), and the ±1-step skew window makes step+1 verifiable
  // now — the same ceremony a human performs by waiting for the authenticator to tick.
  const verifyRes = await post("/auth/2fa/totp/verify", { loginToken: l.loginToken, code: totpNow(secret, new Date(Date.now() + 30_000)) });
  expect(verifyRes.status).toBe(200);
  if (firstVerifySetCookies.length === 0) firstVerifySetCookies = verifyRes.headers.getSetCookie();
  return { full: jarOf(verifyRes), verifyRes };
}

const mailboxBody = (address: string): unknown => ({
  provider: "imap",
  address,
  imap: { host: "imap.family.lan", port: 993, secure: true, user: address, pass: "app-password" },
});

describe.skipIf(!PG_UP)("the self-host server: boot → setup token → sign-in → two mailboxes", () => {
  beforeAll(async () => {
    // The seams every mailbox-add test uses: no socket leaves this process.
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined as never);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined as never);

    roleAdmin = openAdmin(PG_TEST_URL);
    await guard.start(roleAdmin);
    await sweepStaleRoles(roleAdmin, SETUP_ROLE_PREFIX, { log: (l) => process.stderr.write(`${l}\n`) });
    await SETUP_ROLE.create(roleAdmin);

    // ── BOOT, in the ruled order: config → setupProdDatabase → mint → listen ──
    const cfg = loadServerConfig({
      OHMAIL_ORIGIN: "http://localhost",
      DATABASE_URL: dbUrl(),
      [KEY_RING_V1]: KEK,
      TF_PROBE_ALLOW_PRIVATE: "1",
      TF_BUILD_VERSION: "ceremony-test",
    } as NodeJS.ProcessEnv);

    // The library half: BOTH journals under the migration advisory lock, pg_trgm + trigram
    // indexes, then the five-property verification — a throw here is a failed boot, correctly,
    // and the database it was building is dropped rather than left on the cluster.
    await box.create(async () => {
      // Owned by the setup role, so a killed run's database goes with its stale role in the sweep.
      await roleAdmin!.unsafe(`alter database "${box.name}" owner to ${SETUP_ROLE.name}`);
      return setupProdDatabase(cfg.databaseUrl);
    });

    owned = makeOwnedDb(cfg.databaseUrl);
    const minted = await mintFirstRunSetupToken(owned.db);
    expect(minted).not.toBeNull();
    setupToken = minted!.token;

    const rt: ServerRuntime = {
      cfg,
      db: owned.db,
      services: buildServerServices(cfg, owned.db),
      changeWake: null,        // the wake hub has its own pg suite; this ceremony polls nothing
      oauth: oauthProviderFor(cfg, owned.db),
      onSetupTokenMinted: (m) => { midlifeMints.push(m.token); },
      logger: createLogger({ service: "server", level: "error", sink: () => {} }),
      // No TF_ALERT_SECRET here: no pager, so no arms and no pass handle.
      alertSinks: [],
      alertDb: null,
    };
    server = makeHttpServer((req) => handleServerRequest(req, rt), {
      bodyMaxBytes: cfg.bodyMaxBytes,
      headersTimeoutMs: cfg.headersTimeoutMs,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
    await owned?.close();
    await box.drop();
    if (roleAdmin) {
      await SETUP_ROLE.drop(roleAdmin);
      await guard.check(roleAdmin);
      await roleAdmin.end({ timeout: 5 }).catch(() => {});
    }
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  afterEach(async () => { if (roleAdmin) await guard.check(roleAdmin); });

  let firstJar: Jar;
  let secondInviteToken = "";

  it("GET /hello answers the fresh-box truth: selfhost, needsSetup:true, pairing:true, no open signup", async () => {
    const res = await fetch(at("/hello"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      product: "ohmail",
      flavor: "selfhost",
      needsSetup: true,
      auth: { password: true, totp: true, webauthn: true, publicSignup: false },
      features: { sse: true, staging: false, ai: false, pairing: true },
    });
  });

  it("the printed setup token redeems into an invite code — and register starts the account VERIFIED", async () => {
    const redeem = await post("/pair/redeem", { grant: "invite", token: setupToken, email: "owner@family.example" });
    expect(redeem.status).toBe(200);
    const { invite } = await redeem.json() as { invite: { code: string; email: string } };
    expect(invite.email).toBe("owner@family.example");

    // A replay of the burned token is the one refusal every failure mode shares.
    const replay = await post("/pair/redeem", { grant: "invite", token: setupToken, email: "thief@family.example" });
    expect(replay.status).toBe(400);

    const { full } = await signUpAndIn("owner@family.example", invite.code);
    firstJar = full;

    // THE OWNERLESS PATH CONFERS: whoever read the boot log controls the box, so the first
    // account's address starts proven — measured in the database, not inferred from a flag.
    const rows = await owned.db.select({ v: users.emailVerifiedAt }).from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.v).not.toBeNull();

    // …and the ceremony flips the capability: the box no longer advertises first-run setup.
    const hello = await fetch(at("/hello"));
    expect((await hello.json() as { needsSetup: boolean }).needsSetup).toBe(false);
  });

  it("the session cookies carry the ruled attributes: HttpOnly, SameSite=Strict, Secure, NO Domain=", () => {
    // The lines the FIRST full sign-in's totp verify answered with, captured in signUpAndIn —
    // the authoritative Set-Cookie surface of this composition, over the real socket.
    const lines = firstVerifySetCookies;
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const byName = new Map(lines.map((line) => [line.split("=")[0]!, line]));
    for (const name of ["tf_session", "tf_refresh", "tf_csrf", "tf_resume"]) {
      expect(byName.has(name), `${name} must be minted`).toBe(true);
    }
    for (const [name, line] of byName) {
      expect(line, `${name} must be Secure`).toContain("Secure");
      expect(line, `${name} must be host-only — Domain= is the widening the merge forbade`).not.toContain("Domain=");
      if (name === "tf_resume") expect(line).toContain("SameSite=Lax");
      else expect(line).toContain("SameSite=Strict");
      if (name === "tf_session" || name === "tf_refresh" || name === "tf_resume") {
        expect(line, `${name} must be HttpOnly`).toContain("HttpOnly");
      }
    }
    expect(byName.get("tf_refresh")).toContain("Path=/auth/refresh");
  });

  it("the CSRF double-submit is live: no header 403, wrong header 403, matching header mutates", async () => {
    const noHeader = await fetch(at("/mailboxes"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: firstJar.cookie },
      body: JSON.stringify(mailboxBody("owner@family.example")),
    });
    expect(noHeader.status).toBe(403);

    const wrong = await post("/mailboxes", mailboxBody("owner@family.example"),
      { cookie: firstJar.cookie, csrf: "not-the-derivation" });
    expect(wrong.status).toBe(403);

    const right = await post("/mailboxes", mailboxBody("owner@family.example"), firstJar);
    expect(right.status).toBe(201);
  });

  it("a SECOND mailbox with ZERO billing env — the second-mailbox guard, from the server's own mouth (its API half)", async () => {
    const res = await post("/mailboxes", mailboxBody("owner-archive@family.example"), firstJar);
    expect(res.status).toBe(201);
    const dto = await res.json() as { id: string };
    expect(dto.id).toBeTruthy();
  });

  it("REVERTED TO THE BARREL DEFAULT, the same create REFUSES — the explicit allowance is load-bearing", async () => {
    // The mutation, held as a standing assertion: this process loaded the full services barrel
    // (routes did), which registered the hosted PAID gate as the default allowance. A mailbox
    // service constructed WITHOUT the explicit unmetered argument is exactly what apps/server
    // would be if deps.ts dropped it — and on a database with no subscription rows it refuses.
    const defaulted = makeMailboxService({ keyProvider: (await import("../src/config.js")).loadServerConfig({
      OHMAIL_ORIGIN: "http://localhost", DATABASE_URL: dbUrl(), [KEY_RING_V1]: KEK,
    } as NodeJS.ProcessEnv).keyProvider });
    const [{ accountId }] = await owned.db.select({ accountId: users.accountId }).from(users).limit(1);
    const ctx: ServiceContext = {
      db: owned.db as unknown as ServiceContext["db"],
      accountId, userId: null, now: () => new Date(), requestId: "f6-revert",
    };
    // THE REFUSAL MOVED CLASS WITH THE ENTITLEMENTS SEAM AND THE SUBJECT DID NOT: a mailbox
    // service built without the explicit reader still refuses this create; what changed is which
    // refusal it is. `MailboxAllowanceError` was the barrel-registered paid gate answering for a
    // database with no subscription rows; an ABSENT reader is now its own named state, because an
    // unmetered host says so and a host that forgot says nothing. The class check is negative as
    // well as positive — `MailboxAllowanceError` extends `ServiceError`, so the positive one alone
    // would still pass on the old answer.
    const refused = await defaulted.create(ctx, mailboxBody("f6@family.example") as never, {
      probe: async () => ({ verdict: "ok" }),
    } as never).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ServiceError);
    expect(refused).not.toBeInstanceOf(MailboxAllowanceError);
    expect((refused as ServiceError).httpStatus).toBe(500);
    expect((refused as ServiceError).message).toMatch(/no entitlements reader is configured/);
  });

  it("obligation 4: a pairing-invited account starts UNVERIFIED and still adds a mailbox", async () => {
    // The signed-in owner mints a family invite (step-up-gated; the TOTP sign-in carries it).
    const mint = await post("/pair", { grant: "invite", label: "for grandma" }, firstJar);
    expect(mint.status).toBe(200);
    secondInviteToken = (await mint.json() as { token: string }).token;

    const redeem = await post("/pair/redeem", { grant: "invite", token: secondInviteToken, email: "grandma@family.example" });
    expect(redeem.status).toBe(200);
    const { invite } = await redeem.json() as { invite: { code: string } };

    const { full } = await signUpAndIn("grandma@family.example", invite.code);

    // A USER-minted token confers nothing: the holder typed an address nothing was mailed to.
    const rows = await owned.db.select({ email: users.email, v: users.emailVerifiedAt }).from(users);
    const grandma = rows.find((r) => r.email === "grandma@family.example");
    expect(grandma).toBeTruthy();
    expect(grandma!.v).toBeNull();

    // …and the mailbox add — cost class "work", the first gate an absent-value composition
    // bricks — succeeds, because this root SAYS requireVerifiedForProduct: false. On a
    // mailerless box there would be no other way for this account to ever prove its address.
    const res = await post("/mailboxes", mailboxBody("grandma@family.example"), full);
    expect(res.status).toBe(201);
  });

  it("the setup-token invariant stayed a NO-OP through the whole ordinary ceremony", async () => {
    // Every /hello above ran the invariant enforcement; on a healthy lifecycle it must mint
    // nothing and revoke nothing (its two active arms — re-arm after last-account erasure,
    // revoke the restart residue — are pg-tested in setup-token.pg.test.ts). A mid-life mint
    // here would be the enforcement churning tokens during normal operation.
    const hello = await fetch(at("/hello"));
    expect(hello.status).toBe(200);
    expect(midlifeMints).toEqual([]);
  });

  it("signed out elsewhere: the refused refresh clears the jar with no cache clear; the purge answers alone", async () => {
    // Last, because it ends the first account's session. Chrome holds an answer carrying
    // Clear-Site-Data, cookie clears included, for a walk of its whole disk cache.
    expect((await post("/auth/refresh/logout", {}, firstJar)).status).toBe(204);
    const refused = await post("/auth/refresh", {}, firstJar);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("refresh_revoked");
    expect(refused.headers.getSetCookie().filter((c) => /Max-Age=0/.test(c)).map((c) => c.split("=")[0]).sort())
      .toEqual(["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"]);
    expect(refused.headers.get("clear-site-data"), "the refusal is held for a cache walk").toBeNull();

    const purge = await fetch(at("/auth/refresh"), { method: "POST", headers: { "x-ohmail-clear": "cache" } });
    expect(purge.status).toBe(202);
    expect(purge.headers.get("clear-site-data")).toBe('"cache"');
    expect(purge.headers.getSetCookie()).toEqual([]);
  });
});
