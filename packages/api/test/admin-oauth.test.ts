import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { staffUsers, staffSessions, oauthProviderConfig, staffRoleGrants } from "@trafficflow/db/cloud";
import { scryptHasher, generateToken, hashToken } from "@trafficflow/services";
import { eq } from "drizzle-orm";
import { makeDeps, FIXED_NOW } from "./helpers.js";

/**
 * `POST /admin/oauth/microsoft` + `/save` — THE ENTRA APPLICATION REGISTRATION SURFACE (cloud 0009).
 *
 * Three properties, each written to fail first:
 *
 *  1. **THE SECRET IS WRITE-ONLY.** No response body, from either route, may contain the plaintext
 *     client secret — asserted over the SERIALIZED JSON rather than field by field, because a
 *     field-by-field assertion only covers the fields somebody remembered to think of.
 *  2. **THE SHARED SECRET ALONE AUTHORISES NOTHING**, on the READ as much as on the write. An
 *     application registration is a credential's non-secret half and is not something the operator
 *     secret alone may enumerate. Mutation-watched: drop `resolveStaffSession` and this goes
 *     green-should-be-red.
 *  3. **A PARTIAL SAVE LEAVES WHAT IT DID NOT MENTION**, which is what makes the write-only field
 *     work at all: the console omits the secret unless somebody typed one, and an `undefined` that
 *     cleared the column would take the whole fleet's token refresh down at the next hour boundary.
 */

const app = createApp(apiRoutes);
const SECRET = "admin-console-internal-secret-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };
const CLIENT_SECRET_PLAINTEXT = "entra-client-secret-plaintext-fixture-token";
const CLIENT_ID = "26dd5904-19d1-495d-bc3c-67aa2da6f5e3";
const REDIRECT = "https://ohmail.app/api/mailboxes/oauth/microsoft/callback";
const NOTE = "rotated the Entra secret";

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

function post(path: string, body: unknown, opts: { bearer?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  return new Request(`https://api.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function seedStaffSession(deps: ApiDeps): Promise<string> {
  const [staff] = await deps.db.insert(staffUsers).values({
    email: `ops-${Math.random().toString(36).slice(2, 8)}@ohmail.app`,
    passwordHash: await scryptHasher.hash("staff-console-sign-in-password"),
  }).returning();
  // Cloud 0047: roles are read live; this fixture is an owner, as every existing staff member was.
  await deps.db.insert(staffRoleGrants).values({ staffUserId: (staff as { id: string }).id, role: "owner" });
  const token = generateToken(32);
  await deps.db.insert(staffSessions).values({
    staffUserId: (staff as { id: string }).id,
    tokenHash: hashToken(token),
    // Cloud 0036: a second factor proved just now, so this fixture's subject stays what it was.
    lastTwofaAt: FIXED_NOW,
    expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
  });
  return token;
}

async function deps0(): Promise<ApiDeps> {
  const { deps } = await makeDeps();
  return { ...deps, admin: ADMIN } as ApiDeps;
}

const read = (deps: ApiDeps, token: string) =>
  H(post("/admin/oauth/microsoft", { sessionToken: token }, { bearer: SECRET }), deps);

const save = (deps: ApiDeps, token: string, body: Record<string, unknown>) =>
  H(post("/admin/oauth/microsoft/save", { sessionToken: token, note: NOTE, ...body }, { bearer: SECRET }), deps);

describe("admin Entra registration — the surface only exists where it is configured", () => {
  it("404s on a host with no admin secret — not 401, which would advertise it", async () => {
    const { deps } = await makeDeps();
    const token = await seedStaffSession({ ...deps, admin: ADMIN } as ApiDeps);
    const res = await H(post("/admin/oauth/microsoft", { sessionToken: token }, { bearer: SECRET }), deps);
    expect(res.status).toBe(404);
  });
});

describe("admin Entra registration — the shared secret alone authorises nothing", () => {
  it("401 staff_session_required on the READ when only the secret is presented", async () => {
    const deps = await deps0();
    // A registration exists, so a leak would be a real leak rather than an empty object.
    await save(deps, await seedStaffSession(deps), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET_PLAINTEXT });

    const res = await H(post("/admin/oauth/microsoft", {}, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("staff_session_required");
  });

  it("401 on the SAVE when only the secret is presented, and nothing is written", async () => {
    const deps = await deps0();
    const res = await H(
      post("/admin/oauth/microsoft/save", { clientId: CLIENT_ID, note: NOTE }, { bearer: SECRET }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(await deps.db.select().from(oauthProviderConfig)).toHaveLength(0);
  });

  it("401 when the secret is WRONG, even with a live staff session", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    const res = await H(post("/admin/oauth/microsoft", { sessionToken: token }, { bearer: "not-the-secret" }), deps);
    expect(res.status).toBe(401);
  });
});

describe("admin Entra registration — the client secret is WRITE-ONLY", () => {
  it("appears in NO response body, and the read says only whether it is set", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);

    const saved = await save(deps, token, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET_PLAINTEXT,
      tenant: "common",
      redirectUris: [REDIRECT, "http://localhost"],
      enabled: true,
    });
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    // OVER THE WHOLE SERIALIZED BODY. A per-field assertion covers the fields somebody remembered;
    // this covers the ones they did not, including anything a future `...spread` drags in.
    expect(savedText).not.toContain(CLIENT_SECRET_PLAINTEXT);

    const got = await read(deps, token);
    const gotText = await got.text();
    expect(gotText).not.toContain(CLIENT_SECRET_PLAINTEXT);
    const body = JSON.parse(gotText) as {
      stored: { secretSet: boolean; clientId: string; enabled: boolean; note: string };
      effective: { source: string; enabled: boolean; gap: string | null; secretSet: boolean; webRedirectUri: string };
    };
    // NOT a masked value, NOT a prefix, NOT a length — all three leak, and a masked secret in a form
    // field is also how a save that did not retype it ends up writing the mask.
    expect(body.stored.secretSet).toBe(true);
    expect(body.stored.clientId).toBe(CLIENT_ID);
    expect(body.effective.source).toBe("db");
    expect(body.effective.enabled).toBe(true);
    expect(body.effective.gap).toBeNull();
    // The WEB ceremony's URI is the first `https://` entry — the loopback in the list is the desktop
    // flow's and must not be the one the browser is sent to.
    expect(body.effective.webRedirectUri).toBe(REDIRECT);

    // And it really is stored, encrypted, under a key version.
    const [row] = await deps.db.select().from(oauthProviderConfig)
      .where(eq(oauthProviderConfig.provider, "microsoft"));
    expect(row!.clientSecretEnc).not.toContain(CLIENT_SECRET_PLAINTEXT);
    expect(await deps.keyProvider.decrypt(row!.clientSecretEnc!, row!.clientSecretKeyVersion!))
      .toBe(CLIENT_SECRET_PLAINTEXT);
  });

  it("a save that omits the secret KEEPS it; an empty string is not a clear; null is", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    await save(deps, token, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET_PLAINTEXT, tenant: "common", redirectUris: [REDIRECT], enabled: true });

    // THE CONSOLE'S SECOND REQUEST: the operator flips the switch and retypes nothing.
    await save(deps, token, { enabled: false });
    const afterToggle = (await (await read(deps, token)).json()) as { stored: { secretSet: boolean; enabled: boolean; clientId: string } };
    expect(afterToggle.stored.enabled).toBe(false);
    expect(afterToggle.stored.secretSet, "a toggle must not erase the registration").toBe(true);
    expect(afterToggle.stored.clientId).toBe(CLIENT_ID);

    // A BROWSER SUBMITTING `""` for an untouched password field is normal, and must not erase a
    // working registration.
    await save(deps, token, { clientSecret: "" });
    expect(((await (await read(deps, token)).json()) as { stored: { secretSet: boolean } }).stored.secretSet)
      .toBe(true);

    // An EXPLICIT null is the one way to clear it, and it clears BOTH columns — the migration's
    // sealed-together CHECK would refuse anything else.
    await save(deps, token, { clientSecret: null });
    const cleared = (await (await read(deps, token)).json()) as {
      stored: { secretSet: boolean }; effective: { gap: string | null };
    };
    expect(cleared.stored.secretSet).toBe(false);
    // …and the effective verdict now names the SWITCH, because a disabled row is reported as disabled
    // before it is reported as incomplete: an operator who turned it off is told that, rather than
    // being sent to look for a field they did not remove.
    expect(cleared.effective.gap).toBe("disabled");
  });
});

describe("admin Entra registration — validation happens at the FORM, not at the URL builder", () => {
  it("refuses a tenant that could never become a token endpoint", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    for (const tenant of ["not-a-guid", "../evil", "common evil", "https://evil.example"]) {
      const res = await save(deps, token, { tenant });
      expect(res.status, tenant).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("tenant_invalid");
    }
    // The three reserved authorities and a GUID are accepted.
    for (const tenant of ["common", "organizations", "consumers", "72f988bf-86f1-41af-91ab-2d7cd011db47"]) {
      expect((await save(deps, token, { tenant })).status, tenant).toBe(200);
    }
  });

  it("refuses a redirect URI that is neither https nor loopback", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    for (const uri of ["http://evil.example/cb", "ftp://x/y", "javascript:alert(1)"]) {
      const res = await save(deps, token, { redirectUris: [uri] });
      expect(res.status, uri).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("redirect_uri_invalid");
    }
    // `http://localhost` is admitted — it is the desktop flow's loopback and belongs in the
    // operator's record of what Azure holds.
    expect((await save(deps, token, { redirectUris: [REDIRECT, "http://localhost"] })).status).toBe(200);
  });

  it("requires a note, so every change to the registration records why", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    const res = await H(
      post("/admin/oauth/microsoft/save", { sessionToken: token, clientId: CLIENT_ID, note: "x" }, { bearer: SECRET }),
      deps,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("note_required");
  });
});

describe("admin Entra registration — the read publishes the PRECEDENCE, not just the row", () => {
  it("reports `env` when there is no row, and `db` the moment there is one", async () => {
    const { deps: base } = await makeDeps();
    const deps = {
      ...base,
      admin: ADMIN,
      msOAuth: { clientId: "env-client", clientSecret: "env-secret", tenant: "common", redirectUri: REDIRECT },
    } as ApiDeps;
    const token = await seedStaffSession(deps);

    const envOnly = (await (await read(deps, token)).json()) as {
      stored: unknown; effective: { source: string; enabled: boolean; clientId: string };
    };
    expect(envOnly.stored).toBeNull();
    expect(envOnly.effective.source).toBe("env");
    expect(envOnly.effective.enabled).toBe(true);
    expect(envOnly.effective.clientId).toBe("env-client");

    // A ROW WINS WHOLE. Once it exists, env is not consulted for any field — so a row with no secret
    // does NOT borrow the environment's, and "which secret is live?" has one answer on one screen.
    await save(deps, token, { clientId: "db-client", tenant: "common", redirectUris: [REDIRECT], enabled: true });
    const withRow = (await (await read(deps, token)).json()) as {
      effective: { source: string; enabled: boolean; gap: string | null; clientId: string; secretSet: boolean };
    };
    expect(withRow.effective.source).toBe("db");
    expect(withRow.effective.clientId).toBe("db-client");
    expect(withRow.effective.secretSet).toBe(false);
    expect(withRow.effective.enabled).toBe(false);
    expect(withRow.effective.gap).toBe("client_secret_missing");
  });
});

/**
 * A READ THAT FAILS AFTER A COMMIT MAKES THE STATE UNKNOWN — IT NEVER MAKES THE WRITE UNTRUE.
 *
 * The save commits and then re-runs the read so the console renders the effective verdict. That
 * read threw into the wrapper's catch, which answered 503, which the console printed as "The save
 * failed on the server. Nothing was changed." — over a registration that had changed. The failure
 * is reachable without inventing one: the re-read decrypts the stored secret, so a host that
 * cannot decrypt it (the KEK drift this console has a verdict about) fails exactly here.
 */
describe("admin Entra registration — a committed write is never reported as a failure", () => {
  it("answers SAVED with the value unread, and the row really moved", async () => {
    const base = await deps0();
    const token = await seedStaffSession(base);
    await save(base, token, {
      clientId: CLIENT_ID, tenant: "common", redirectUris: [REDIRECT],
      clientSecret: CLIENT_SECRET_PLAINTEXT, enabled: true,
    });

    const blind = {
      ...base,
      keyProvider: {
        ...base.keyProvider,
        decrypt: () => { throw new Error("no key of that version on this host"); },
      },
    } as ApiDeps;
    const res = await save(blind, token, { clientId: "second-client-id", tenant: "common", redirectUris: [REDIRECT] });

    expect(res.status, "not a 503 — the write applied").toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, saved: true, reread: false });

    const [row] = await base.db.select().from(oauthProviderConfig);
    expect((row as { clientId: string }).clientId, "the commit stands").toBe("second-client-id");
  });

  it("a save that can read back says so — the flag is not always false", async () => {
    // The positive control. Without it the case above is satisfied by a route that never reads.
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    const res = await save(deps, token, { clientId: CLIENT_ID, tenant: "common", redirectUris: [REDIRECT] });
    expect(await res.json()).toMatchObject({ ok: true, saved: true, reread: true });
  });
});

/**
 * THE SUBMIT CARRIES THE REVISION IT WAS RENDERED FROM. Two operators with the panel open
 * otherwise overwrite each other's registration while each keeps their own secret, and neither is
 * told. Absent means the caller is not participating; `null` asserts there was no row.
 */
describe("admin Entra registration — a stale revision is refused", () => {
  const later = (deps: ApiDeps, ms: number): ApiDeps =>
    ({ ...deps, now: () => new Date(FIXED_NOW.getTime() + ms) }) as ApiDeps;

  it("refuses a submit whose revision the row has moved past", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    await save(deps, token, { clientId: CLIENT_ID, tenant: "common", redirectUris: [REDIRECT] });
    const first = (await (await read(deps, token)).json()) as { stored: { updatedAt: string } };

    // Somebody else saves.
    await save(later(deps, 60_000), token, { clientId: "somebody-elses-id", tenant: "common", redirectUris: [REDIRECT] });

    const stale = await save(later(deps, 120_000), token, {
      clientId: "my-stale-id", tenant: "common", redirectUris: [REDIRECT],
      expectedUpdatedAt: first.stored.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale_revision" } });

    const [row] = await deps.db.select().from(oauthProviderConfig);
    expect((row as { clientId: string }).clientId, "the newer registration survives").toBe("somebody-elses-id");
  });

  it("admits the revision the form was rendered from", async () => {
    // The positive control: a check that refuses everything would pass the case above.
    const deps = await deps0();
    const token = await seedStaffSession(deps);
    await save(deps, token, { clientId: CLIENT_ID, tenant: "common", redirectUris: [REDIRECT] });
    const current = (await (await read(deps, token)).json()) as { stored: { updatedAt: string } };

    const ok = await save(later(deps, 60_000), token, {
      clientId: "my-id", tenant: "common", redirectUris: [REDIRECT],
      expectedUpdatedAt: current.stored.updatedAt,
    });
    expect(ok.status).toBe(200);
  });

  it("a null revision is admitted with no row and refused once one exists", async () => {
    const deps = await deps0();
    const token = await seedStaffSession(deps);

    const first = await save(deps, token, {
      clientId: CLIENT_ID, tenant: "common", redirectUris: [REDIRECT], expectedUpdatedAt: null,
    });
    expect(first.status, "no row yet — null is the truth").toBe(200);

    const second = await save(later(deps, 60_000), token, {
      clientId: "other", tenant: "common", redirectUris: [REDIRECT], expectedUpdatedAt: null,
    });
    expect(second.status, "a row exists — null is now a stale claim").toBe(409);
  });
});
