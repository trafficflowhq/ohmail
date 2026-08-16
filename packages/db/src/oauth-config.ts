/**
 * THE OAuth APPLICATION REGISTRATION STORE (cloud 0009) — one resolver, two hosts, one precedence
 * rule.
 *
 * The hosted deployment signs its Microsoft consent flow with an Entra application registration: a
 * client id, a confidential client secret, a tenant, the redirect URIs registered in Azure, and the
 * scopes. TWO processes read it and they must never disagree:
 *
 *   · `packages/api` — mints the authorize URL (`POST /mailboxes/oauth/microsoft/start`) and
 *     redeems the authorization code (the callback). It needs the id, the secret, the tenant and
 *     the redirect URI.
 *   · `apps/worker` — refreshes access tokens for every oauth mailbox, for ever. It needs the id,
 *     the secret and the default tenant.
 *
 * If those two resolve differently, the symptom is a mailbox that onboards successfully and then
 * quarantines on its first refresh — a failure with two plausible wrong explanations (a bad
 * consent, a dead token) and one true one nobody looks for. So the resolution is ONE function here,
 * called by both, and neither host re-derives it.
 *
 * ── THE PRECEDENCE RULE, AND WHY THERE IS NO FIELD-LEVEL FALLBACK ─────────────────────────
 *
 * A ROW WINS WHOLE, OR ENV WINS WHOLE. There is no interleaving, and that is a decision rather
 * than a simplification:
 *
 *  · A row that exists is the authority, INCLUDING when `enabled` is false. Falling back to env
 *    for a disabled row would make the console's off switch bypassable by an environment variable
 *    nobody looked at — the switch would read as a control and not be one.
 *  · A row with a NULL `client_secret_enc` does NOT borrow `MS_OAUTH_CLIENT_SECRET`. Mixing the two
 *    sources means "which secret is live?" has no answer an operator can read off one screen, and
 *    the answer matters most at exactly the moment it is hardest to get: a rotation that half
 *    landed. A registration is entered whole, and an incomplete row is reported as incomplete.
 *  · ENV is the BOOTSTRAP, not a peer. It is what makes the first deploy work with no row at all,
 *    and it is the way back in for an operator locked out of the console.
 *
 * {@link ResolvedOAuthConfig.source} publishes which of the three states answered, and the admin
 * console renders it, so the precedence is visible rather than inferred.
 *
 * ── NO KEY MATERIAL, AND NO `@trafficflow/core` IMPORT ────────────────────────────────────
 *
 * The client secret is a KEK envelope, so resolving one means decrypting. This module takes
 * {@link Decrypt} as a PARAMETER instead of importing a `KeyProvider`: `packages/db` does not
 * depend on `packages/core`, and adding that edge for one function would put the crypto module in
 * the import closure of every consumer of this package. Each host passes its own
 * `keyProvider.decrypt` bound — the API's per-invocation one, the worker's process one — which is
 * also what makes a fake trivial in a test.
 */
import { and, eq } from "drizzle-orm";
import { oauthProviderConfig } from "./schema-cloud.js";
import { mailboxCredentials } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/** `KeyProvider.decrypt`, as a parameter. See the module header for why this is not an import. */
export type Decrypt = (ciphertext: string, keyVersion: number) => Promise<string>;

/** The only provider this build speaks. Named so a second one is a diff a reviewer sees. */
export const MICROSOFT_PROVIDER = "microsoft";

/**
 * The environment variables that bootstrap the registration.
 *
 * Named as a constant rather than inlined because THREE places quote them: this resolver, the
 * worker's `loadConfig`, and the named refusal `MicrosoftTokenProvider` throws
 * (`OAuthConfigError.configVar`). An operator reading "MS_OAUTH_CLIENT_SECRET is not set" has to be
 * able to find the same string in the resolver that looked for it.
 */
export const MS_OAUTH_ENV = {
  clientId: "MS_OAUTH_CLIENT_ID",
  clientSecret: "MS_OAUTH_CLIENT_SECRET",
  tenant: "MS_OAUTH_TENANT",
  redirectUri: "MS_OAUTH_REDIRECT_URI",
} as const;

/**
 * ACCEPTED ALIASES, in the order they are tried. The `MS_OAUTH_*` names are CANONICAL and are what
 * documentation and refusals quote; the `MICROSOFT_*` names are accepted because that is what the
 * live deployment's environment already holds.
 *
 * Two names for one value is a smell and the alternative was worse: renaming the variables in the
 * platform's dashboards is a change nothing in this repository can verify, and a deployment where
 * the secret is present under a name the resolver does not read produces the single most misleading
 * failure this feature has — "Outlook is not configured", about a registration that is complete.
 * So the resolver reads both and the canonical name wins when both are set.
 *
 * ONE READER, so the two hosts cannot accept different sets: the worker's `loadConfig` and the API's
 * bootstrap both go through {@link msOAuthEnv}.
 */
export const MS_OAUTH_ENV_ALIASES: Readonly<Record<keyof typeof MS_OAUTH_ENV, readonly string[]>> = {
  clientId: [MS_OAUTH_ENV.clientId, "MICROSOFT_CLIENT_ID"],
  clientSecret: [MS_OAUTH_ENV.clientSecret, "MICROSOFT_CLIENT_SECRET"],
  tenant: [MS_OAUTH_ENV.tenant, "MICROSOFT_TENANT", "MICROSOFT_TENANT_ID"],
  redirectUri: [MS_OAUTH_ENV.redirectUri, "MICROSOFT_REDIRECT_URI"],
};

/**
 * The four bootstrap values out of an environment, canonical name first, aliases after.
 *
 * Exported because the WORKER reads the same environment for the same registration and must not
 * re-derive the alias list — a worker that accepted only `MS_OAUTH_CLIENT_SECRET` while the API
 * accepted `MICROSOFT_CLIENT_SECRET` is precisely the split-brain this module's header is about,
 * except arrived at through variable names instead of through precedence.
 */
export function msOAuthEnv(env: Record<string, string | undefined>): {
  clientId: string; clientSecret: string; tenant: string; redirectUri: string;
} {
  const pick = (key: keyof typeof MS_OAUTH_ENV): string => {
    for (const name of MS_OAUTH_ENV_ALIASES[key]) {
      const v = typeof env[name] === "string" ? env[name]!.trim() : "";
      if (v) return v;
    }
    return "";
  };
  return {
    clientId: pick("clientId"),
    clientSecret: pick("clientSecret"),
    tenant: pick("tenant"),
    redirectUri: pick("redirectUri"),
  };
}

/**
 * The default scope list a registration is created with — identity, mail, and `offline_access`.
 *
 * `openid` + `email` are here because the callback reads the mailbox address from the `id_token`'s
 * `preferred_username` / `email` claim and the user never types it: without them the ceremony
 * completes, the tokens are valid, and there is no address to store.
 *
 * The scope HOST is `outlook.office.com` — Microsoft's canonical resource identifier, and what the
 * Entra application registration lists. `outlook.office365.com` is the legacy alias; it is still the
 * IMAP HOSTNAME the dialler connects to, and the two are deliberately different strings. See
 * `MS_MAIL_SCOPE` in `packages/core/src/oauth/microsoft.ts`.
 *
 * This DUPLICATES `MS_AUTHORIZE_SCOPES` in that file rather than importing it, because
 * `packages/db` does not depend on `packages/core` and adding the edge for one array would put the
 * crypto module into every consumer's closure. `test/oauth-config.test.ts` asserts the
 * two lists are equal, so the copy cannot drift silently.
 */
export const MS_DEFAULT_SCOPES: readonly string[] = [
  "openid",
  "email",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
  "offline_access",
];

/** The row as stored. `clientSecretEnc` is a KEK envelope and NEVER leaves the server. */
export interface OAuthProviderConfigRow {
  provider: string;
  clientId: string | null;
  clientSecretEnc: string | null;
  clientSecretKeyVersion: number | null;
  tenant: string | null;
  redirectUris: string[];
  scopes: string[];
  enabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
  note: string | null;
}

/**
 * WHICH OF THE THREE STATES ANSWERED.
 *
 * `"db"` — a row exists and it is the whole answer. `"env"` — no row, and the environment carries a
 * usable registration. `"none"` — neither; the deployment cannot run an OAuth ceremony and the
 * routes say so instead of offering a consent screen that dead-ends.
 */
export type OAuthConfigSource = "db" | "env" | "none";

export interface ResolvedOAuthConfig {
  provider: string;
  clientId: string;
  /** PLAINTEXT, decrypted for this call only. Never logged, never returned to any client. */
  clientSecret: string;
  tenant: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  /**
   * Whether a ceremony may START. `false` for a disabled row, for an incomplete registration, and
   * for `source: "none"` — three different reasons, one refusal, and {@link ResolvedOAuthConfig.gap}
   * says which.
   */
  enabled: boolean;
  source: OAuthConfigSource;
  /**
   * WHY this cannot be used, or `null` when it can. A CODE from a closed set, never a sentence:
   * the copy belongs to whichever surface is refusing (the admin console names the missing field,
   * the webapp says the operator has not finished setting Outlook up).
   */
  gap: OAuthConfigGap | null;
}

/** The closed set of reasons a registration is unusable. */
export type OAuthConfigGap =
  /** Neither a row nor an environment registration. */
  | "not_configured"
  /** A row exists and the operator has switched it off. */
  | "disabled"
  | "client_id_missing"
  | "client_secret_missing"
  | "tenant_missing"
  /** No `https://` entry in `redirect_uris`, so the web ceremony has no callback to name. */
  | "redirect_uri_missing";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];

/** Read the stored registration, or `null`. The raw row — the secret is still an envelope. */
export async function readOAuthProviderConfig(
  tx: Tx, provider: string = MICROSOFT_PROVIDER,
): Promise<OAuthProviderConfigRow | null> {
  const [row] = await tx.select().from(oauthProviderConfig)
    .where(eq(oauthProviderConfig.provider, provider)).limit(1);
  if (!row) return null;
  return {
    provider: row.provider,
    clientId: row.clientId,
    clientSecretEnc: row.clientSecretEnc,
    clientSecretKeyVersion: row.clientSecretKeyVersion,
    tenant: row.tenant,
    redirectUris: arr(row.redirectUris),
    scopes: arr(row.scopes),
    enabled: row.enabled,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    note: row.note,
  };
}

export interface WriteOAuthProviderConfigInput {
  provider?: string;
  clientId?: string | null;
  /**
   * The ALREADY-ENCRYPTED secret, with its key version. Absent (`undefined`) means "leave whatever
   * is stored alone" — that is what makes the admin form's secret field WRITE-ONLY: saving the form
   * without retyping the secret must not blank it. An explicit `null` is a deliberate clear.
   *
   * The encryption happens in the CALLER, for the same reason {@link Decrypt} is a parameter.
   */
  clientSecret?: { ciphertext: string; keyVersion: number } | null;
  tenant?: string | null;
  redirectUris?: readonly string[];
  scopes?: readonly string[];
  enabled?: boolean;
  /** The `staff_users` id from the resolved staff session — the actor this row records. */
  updatedBy: string;
  note?: string | null;
  now: Date;
}

/**
 * Upsert the registration on `(provider)`.
 *
 * ── AN ABSENT FIELD IS "LEAVE IT ALONE", NOT "CLEAR IT" ───────────────────────────────────
 *
 * The console's form is partial by design: the secret is write-only, and an operator flipping
 * `enabled` is not restating the client id. So every field is optional and only the ones PRESENT
 * are written. The insert arm supplies the column defaults for whatever is absent; the update arm
 * touches nothing it was not given. Getting this backwards — assigning `undefined` wholesale — is
 * how "the operator toggled the switch" becomes "the operator erased the registration", which is
 * the identical defect `upsertCredOn` fixed for `mailbox_credentials.meta`.
 */
export async function writeOAuthProviderConfig(
  tx: Tx, input: WriteOAuthProviderConfigInput,
): Promise<void> {
  const provider = input.provider ?? MICROSOFT_PROVIDER;
  const set: Record<string, unknown> = { updatedAt: input.now, updatedBy: input.updatedBy };
  if (input.clientId !== undefined) set.clientId = input.clientId;
  if (input.tenant !== undefined) set.tenant = input.tenant;
  if (input.redirectUris !== undefined) set.redirectUris = [...input.redirectUris];
  if (input.scopes !== undefined) set.scopes = [...input.scopes];
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.note !== undefined) set.note = input.note;
  if (input.clientSecret !== undefined) {
    // Sealed together or cleared together — the CHECK the migration carries is not something to
    // rely on catching a caller; this is the writer that makes it true.
    set.clientSecretEnc = input.clientSecret ? input.clientSecret.ciphertext : null;
    set.clientSecretKeyVersion = input.clientSecret ? input.clientSecret.keyVersion : null;
  }
  await tx.insert(oauthProviderConfig)
    .values({
      provider,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.tenant !== undefined ? { tenant: input.tenant } : {}),
      ...(input.redirectUris !== undefined ? { redirectUris: [...input.redirectUris] } : {}),
      ...(input.scopes !== undefined ? { scopes: [...input.scopes] } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.clientSecret
        ? { clientSecretEnc: input.clientSecret.ciphertext, clientSecretKeyVersion: input.clientSecret.keyVersion }
        : {}),
      updatedAt: input.now,
      updatedBy: input.updatedBy,
    })
    .onConflictDoUpdate({ target: oauthProviderConfig.provider, set });
}

/** The four env-derived values, already picked by the HOST. See {@link msOAuthEnv}. */
export interface MsOAuthBootstrap {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
}

export interface ResolveOAuthConfigInput {
  tx: Tx;
  decrypt: Decrypt;
  /**
   * The ENV BOOTSTRAP, resolved by the host and passed in — never `process.env` read here.
   *
   * The same rule `AdminConfig` states: a route (or a store) that reaches into the environment makes
   * every test that exercises it depend on the runner's ambient variables, and makes a host unable
   * to say what it is configured with. `msOAuthEnv(env)` is how a host builds this.
   */
  bootstrap?: MsOAuthBootstrap;
  provider?: string;
}

/**
 * THE ONE RESOLVER. Row-or-env, whole, with the reason it cannot be used when it cannot.
 *
 * It NEVER throws for a configuration fault: an unusable registration is a state, not an
 * exception, and both call sites have to render it (the onboarding route as a 503 with a sentence,
 * the admin console as a form that says what is missing). It can still reject for a DATABASE
 * failure or a decrypt failure — those are faults of this process, not of the configuration, and a
 * refusal that swallowed a broken KEK would present as "Outlook is not set up" about a
 * registration that is perfectly complete.
 */
export async function resolveOAuthProviderConfig(
  input: ResolveOAuthConfigInput,
): Promise<ResolvedOAuthConfig> {
  const provider = input.provider ?? MICROSOFT_PROVIDER;
  const row = await readOAuthProviderConfig(input.tx, provider);

  if (!row) {
    const { clientId, clientSecret, tenant, redirectUri } =
      input.bootstrap ?? { clientId: "", clientSecret: "", tenant: "", redirectUri: "" };
    if (!clientId && !clientSecret && !tenant && !redirectUri) {
      return blank(provider, "none", "not_configured");
    }
    const base: ResolvedOAuthConfig = {
      provider,
      clientId,
      clientSecret,
      // `common` is the multi-tenant authority and the right default for a bootstrap that names no
      // tenant: it is what a personal or unknown-organisation account signs in through. It is still
      // validated against `MS_TENANT_RE` before it reaches a URL.
      tenant: tenant || "common",
      redirectUris: redirectUri ? [redirectUri] : [],
      scopes: MS_DEFAULT_SCOPES,
      enabled: false,
      source: "env",
      gap: null,
    };
    return { ...base, ...verdict(base) };
  }

  const clientSecret = row.clientSecretEnc && row.clientSecretKeyVersion != null
    ? await input.decrypt(row.clientSecretEnc, row.clientSecretKeyVersion)
    : "";
  const base: ResolvedOAuthConfig = {
    provider,
    clientId: str(row.clientId),
    clientSecret,
    tenant: str(row.tenant),
    redirectUris: row.redirectUris,
    scopes: row.scopes.length > 0 ? row.scopes : MS_DEFAULT_SCOPES,
    enabled: false,
    source: "db",
    gap: null,
  };
  // THE SWITCH IS CHECKED BEFORE COMPLETENESS, so a disabled registration reports `disabled` and
  // not `client_secret_missing`. An operator who turned it off is told that, rather than being sent
  // to look for a field they did not remove.
  if (!row.enabled) return { ...base, enabled: false, gap: "disabled" };
  return { ...base, ...verdict(base) };
}

/** The first `https://` redirect URI — the one the BROWSER ceremony uses. See {@link webRedirectUri}. */
export function webRedirectUri(cfg: Pick<ResolvedOAuthConfig, "redirectUris">): string | null {
  /*
   * WHY "the first https entry" AND NOT "the only entry".
   *
   * Azure holds every redirect URI the application may use, and this deployment will register two:
   * the hosted web callback, and a `http://localhost:<port>/…` loopback for the desktop flow. Both
   * belong in the operator's list — it is a record of what Azure has — so the browser ceremony
   * cannot simply take `[0]`, and it must not take a loopback URI (Microsoft would redirect the
   * consent back to a port on the user's machine, where the hosted callback is not listening).
   *
   * The selector is scheme-based rather than positional so the list can be reordered in the console
   * without changing which URI the web flow names. START and CALLBACK both call this, so the value
   * sent to `/authorize` and the value replayed at the token exchange are one expression — and
   * Microsoft requires those two to match EXACTLY, which is why this is a function and not a
   * convention two files follow.
   */
  for (const uri of cfg.redirectUris) if (uri.startsWith("https://")) return uri;
  return null;
}

function blank(provider: string, source: OAuthConfigSource, gap: OAuthConfigGap): ResolvedOAuthConfig {
  return {
    provider, clientId: "", clientSecret: "", tenant: "",
    redirectUris: [], scopes: MS_DEFAULT_SCOPES, enabled: false, source, gap,
  };
}

/** Completeness, in the order an operator fills the form in. First missing field wins. */
function verdict(c: ResolvedOAuthConfig): Pick<ResolvedOAuthConfig, "enabled" | "gap"> {
  if (!c.clientId) return { enabled: false, gap: "client_id_missing" };
  if (!c.clientSecret) return { enabled: false, gap: "client_secret_missing" };
  if (!c.tenant) return { enabled: false, gap: "tenant_missing" };
  if (!webRedirectUri(c)) return { enabled: false, gap: "redirect_uri_missing" };
  return { enabled: true, gap: null };
}

/**
 * PERSIST A ROTATED REFRESH TOKEN — the one write `UpdateSecretPort` makes, in one place.
 *
 * Microsoft may hand back a NEW refresh token on any refresh, and the old one may already be dead the
 * moment it does; a host that does not persist the new one keeps re-presenting a corpse and reports
 * it as `invalid_grant`, i.e. as the user's consent having expired. So both hosts wire this — the
 * always-on worker and the serverless API — and they wired it as two hand-written drizzle updates
 * until this function existed. Two copies of one credential write is one copy away from a predicate
 * that differs: the `transport = 'imap'` clause is what keeps a rotation from overwriting an
 * unrelated smtp row, and it is not the sort of thing to state twice.
 *
 * It targets the mailbox's OWN imap row and nothing else. The ciphertext is already encrypted by the
 * caller's own KeyProvider — this function holds no key material, exactly as {@link Decrypt} does not.
 */
export async function rotateMailboxOAuthSecret(
  tx: Tx,
  input: { mailboxId: string; ciphertext: string; keyVersion: number; now: Date },
): Promise<void> {
  await tx.update(mailboxCredentials)
    .set({ secretEnc: input.ciphertext, keyVersion: input.keyVersion, updatedAt: input.now })
    .where(and(
      eq(mailboxCredentials.mailboxId, input.mailboxId),
      eq(mailboxCredentials.transport, "imap"),
    ));
}
