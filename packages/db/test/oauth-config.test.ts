import { describe, it, expect } from "vitest";
import { managedAddress } from "../../../test/support/fixture-credentials.js";
import { makeTestDb } from "../src/testing.js";
import { oauthProviderConfig } from "../src/schema-cloud.js";
import {
  resolveOAuthProviderConfig, writeOAuthProviderConfig, webRedirectUri,
  msOAuthEnv, MS_OAUTH_ENV, MS_OAUTH_ENV_ALIASES, MS_DEFAULT_SCOPES,
} from "../src/oauth-config.js";
import { MS_AUTHORIZE_SCOPES } from "@trafficflow/core";
import { accounts } from "../src/schema.js";
import { staffUsers } from "../src/schema-cloud.js";
import type { Db } from "../src/client.js";

/**
 * THE ONE RESOLVER, and the properties that make "one resolver" worth anything (cloud 0009).
 *
 * The API's onboarding routes and the always-on worker both read the Entra application registration.
 * If they resolve differently the symptom is a mailbox that ONBOARDS and then never refreshes — a
 * failure with two plausible wrong explanations (a bad consent, a dead token) and one true one
 * nobody looks for. So the precedence lives in one function, and these are its rules:
 *
 *  · A ROW WINS WHOLE. Including when `enabled` is false — otherwise the console's off switch is
 *    bypassable by an environment variable nobody looked at.
 *  · NO FIELD-LEVEL FALLBACK. A row with no secret does not borrow the environment's, because
 *    "which secret is live?" must have one answer on one screen, and it matters most during a
 *    rotation that half landed.
 *  · ENV IS THE BOOTSTRAP, and it accepts BOTH the canonical `MS_OAUTH_*` names and the
 *    `MICROSOFT_*` aliases the live deployment holds — read through ONE function, so the API and the
 *    worker cannot accept different sets.
 */

/** No key material here: the store takes `decrypt` as a parameter, so a fake is one line. */
const fakeDecrypt = async (ct: string, kv: number): Promise<string> => `plain(${ct}@${kv})`;

const STAFF = "00000000-0000-4000-8000-000000000001";
const REDIRECT = "https://ohmail.app/api/mailboxes/oauth/microsoft/callback";
const NOW = new Date("2026-08-10T12:00:00.000Z");

async function db0(): Promise<Db> {
  const db = await makeTestDb();
  await db.insert(accounts).values({ id: "00000000-0000-4000-8000-0000000000aa", name: "acme" });
  await db.insert(staffUsers).values({ id: STAFF, email: managedAddress("fixture.ops"), passwordHash: "x" });
  return db;
}

describe("cloud 0009 — the env bootstrap accepts both spellings, canonical first", () => {
  it("reads MS_OAUTH_* and falls back to MICROSOFT_*", async () => {
    expect(msOAuthEnv({ MS_OAUTH_CLIENT_ID: "canon", MICROSOFT_CLIENT_ID: "alias" }).clientId).toBe("canon");
    // THE ALIAS IS WHY THIS FUNCTION EXISTS. The live environment holds `MICROSOFT_CLIENT_SECRET`,
    // and a resolver that read only the canonical name would report "Outlook is not configured"
    // about a registration that is complete — the single most misleading failure this feature has.
    expect(msOAuthEnv({ MICROSOFT_CLIENT_ID: "alias" }).clientId).toBe("alias");
    expect(msOAuthEnv({ MICROSOFT_CLIENT_SECRET: "s" }).clientSecret).toBe("s");
    expect(msOAuthEnv({ MICROSOFT_TENANT: "common" }).tenant).toBe("common");
    expect(msOAuthEnv({ MICROSOFT_TENANT_ID: "common" }).tenant).toBe("common");
    expect(msOAuthEnv({ MICROSOFT_REDIRECT_URI: REDIRECT }).redirectUri).toBe(REDIRECT);
    // An EMPTY canonical value does not shadow a set alias: `MS_OAUTH_CLIENT_ID=""` in a dashboard
    // is a variable somebody cleared, not a decision to have no client id.
    expect(msOAuthEnv({ MS_OAUTH_CLIENT_ID: "  ", MICROSOFT_CLIENT_ID: "alias" }).clientId).toBe("alias");
    // Values are trimmed — a trailing newline pasted out of a dashboard is invisible and fatal.
    expect(msOAuthEnv({ MS_OAUTH_CLIENT_SECRET: " ms-client-fixture-token\n" }).clientSecret).toBe("ms-client-fixture-token");
  });

  it("the canonical name is the FIRST alias for every field, so refusals quote a name that is read", () => {
    for (const key of Object.keys(MS_OAUTH_ENV) as (keyof typeof MS_OAUTH_ENV)[]) {
      expect(MS_OAUTH_ENV_ALIASES[key][0]).toBe(MS_OAUTH_ENV[key]);
    }
  });
});

describe("cloud 0009 — the default scope list", () => {
  it("EQUALS core's MS_AUTHORIZE_SCOPES — the copy cannot drift silently", () => {
    // `packages/db` does not depend on `packages/core`, so the list is duplicated rather than
    // imported. THIS is what makes the duplication safe, and without it a scope change in one file
    // would leave the config store's default naming resources the registration does not grant.
    expect([...MS_DEFAULT_SCOPES]).toEqual([...MS_AUTHORIZE_SCOPES]);
  });

  it("carries openid + email + offline_access, and the office.com scope host", () => {
    expect(MS_DEFAULT_SCOPES).toContain("openid");
    expect(MS_DEFAULT_SCOPES).toContain("email");
    expect(MS_DEFAULT_SCOPES).toContain("offline_access");
    // The SCOPE host is the Entra registration's resource identifier. The IMAP host
    // (`outlook.office365.com`) is a different string on purpose and must not appear here.
    expect(MS_DEFAULT_SCOPES.join(" ")).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(MS_DEFAULT_SCOPES.join(" ")).not.toContain("outlook.office365.com");
  });
});

describe("cloud 0009 — the precedence rule", () => {
  it("no row and no env ⇒ `none` / not_configured, and it does NOT throw", async () => {
    const db = await db0();
    const r = await resolveOAuthProviderConfig({ tx: db, decrypt: fakeDecrypt });
    // A STATE, not an exception: both call sites have to render it (a 503 with a sentence, a form
    // that says what is missing), and a resolver that threw would make an unconfigured deployment
    // indistinguishable from a broken one.
    expect(r.source).toBe("none");
    expect(r.gap).toBe("not_configured");
    expect(r.enabled).toBe(false);
  });

  it("env alone is usable, and reports itself as `env`", async () => {
    const db = await db0();
    const r = await resolveOAuthProviderConfig({
      tx: db, decrypt: fakeDecrypt,
      bootstrap: { clientId: "c", clientSecret: "s", tenant: "common", redirectUri: REDIRECT },
    });
    expect(r.source).toBe("env");
    expect(r.enabled).toBe(true);
    expect(r.gap).toBeNull();
    expect(r.scopes).toEqual(MS_DEFAULT_SCOPES);
    expect(webRedirectUri(r)).toBe(REDIRECT);
  });

  it("env with no tenant defaults to `common` — the multi-tenant authority", async () => {
    const db = await db0();
    const r = await resolveOAuthProviderConfig({
      tx: db, decrypt: fakeDecrypt,
      bootstrap: { clientId: "c", clientSecret: "s", tenant: "", redirectUri: REDIRECT },
    });
    expect(r.tenant).toBe("common");
    expect(r.enabled).toBe(true);
  });

  it("A DISABLED ROW REFUSES, and does not fall back to env", async () => {
    const db = await db0();
    await writeOAuthProviderConfig(db, {
      clientId: "db-client",
      tenant: "common",
      redirectUris: [REDIRECT],
      clientSecret: { ciphertext: "ct", keyVersion: 2 },
      enabled: false,
      updatedBy: STAFF,
      note: "paused",
      now: NOW,
    });
    const r = await resolveOAuthProviderConfig({
      tx: db, decrypt: fakeDecrypt,
      // Env is fully configured and must NOT rescue the disabled row. An off switch an environment
      // variable can bypass is not a switch — it is a control that reads as one and is not.
      bootstrap: { clientId: "env-client", clientSecret: "env-secret", tenant: "common", redirectUri: REDIRECT },
    });
    expect(r.source).toBe("db");
    expect(r.gap).toBe("disabled");
    expect(r.enabled).toBe(false);
    expect(r.clientId).toBe("db-client");
  });

  it("A ROW WITH NO SECRET does not borrow the environment's", async () => {
    const db = await db0();
    await writeOAuthProviderConfig(db, {
      clientId: "db-client", tenant: "common", redirectUris: [REDIRECT], enabled: true,
      updatedBy: STAFF, note: "half entered", now: NOW,
    });
    const r = await resolveOAuthProviderConfig({
      tx: db, decrypt: fakeDecrypt,
      bootstrap: { clientId: "env-client", clientSecret: "env-secret", tenant: "common", redirectUri: REDIRECT },
    });
    expect(r.source).toBe("db");
    expect(r.clientSecret).toBe("");
    expect(r.gap).toBe("client_secret_missing");
    expect(r.enabled).toBe(false);
  });

  it("decrypts the stored secret through the injected `decrypt`, and nowhere else", async () => {
    const db = await db0();
    await writeOAuthProviderConfig(db, {
      clientId: "db-client", tenant: "common", redirectUris: [REDIRECT], enabled: true,
      clientSecret: { ciphertext: "CIPHER", keyVersion: 7 },
      updatedBy: STAFF, note: "first save", now: NOW,
    });
    const r = await resolveOAuthProviderConfig({ tx: db, decrypt: fakeDecrypt });
    expect(r.clientSecret).toBe("plain(CIPHER@7)");
    expect(r.enabled).toBe(true);
    // The stored value is the CIPHERTEXT — the resolver is the only thing that ever opens it.
    const [row] = await db.select().from(oauthProviderConfig);
    expect(row!.clientSecretEnc).toBe("CIPHER");
  });

  it("reports the first MISSING field in the order an operator fills the form in", async () => {
    const db = await db0();
    const cases: Array<[Partial<Parameters<typeof writeOAuthProviderConfig>[1]>, string]> = [
      [{ enabled: true }, "client_id_missing"],
      [{ enabled: true, clientId: "c" }, "client_secret_missing"],
      [{ enabled: true, clientId: "c", clientSecret: { ciphertext: "ct", keyVersion: 1 } }, "tenant_missing"],
      [{ enabled: true, clientId: "c", clientSecret: { ciphertext: "ct", keyVersion: 1 }, tenant: "common" }, "redirect_uri_missing"],
    ];
    for (const [patch, gap] of cases) {
      await db.delete(oauthProviderConfig);
      await writeOAuthProviderConfig(db, {
        clientId: null, tenant: null, redirectUris: [], clientSecret: null, enabled: false,
        ...patch, updatedBy: STAFF, note: "n", now: NOW,
      } as Parameters<typeof writeOAuthProviderConfig>[1]);
      const r = await resolveOAuthProviderConfig({ tx: db, decrypt: fakeDecrypt });
      expect(r.gap, JSON.stringify(patch)).toBe(gap);
      expect(r.enabled).toBe(false);
    }
  });
});

describe("cloud 0009 — which redirect URI the BROWSER ceremony uses", () => {
  it("the first https entry, so a loopback URI can sit in the list without changing it", () => {
    // Azure holds both: the hosted web callback, and a loopback for the desktop flow. Taking `[0]`
    // would send a browser consent back to a port on the user's machine as soon as an operator
    // reordered the list.
    expect(webRedirectUri({ redirectUris: ["http://localhost", REDIRECT] })).toBe(REDIRECT);
    expect(webRedirectUri({ redirectUris: [REDIRECT, "http://localhost"] })).toBe(REDIRECT);
    expect(webRedirectUri({ redirectUris: ["http://localhost"] })).toBeNull();
    expect(webRedirectUri({ redirectUris: [] })).toBeNull();
  });
});
