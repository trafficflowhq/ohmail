import { silentLogger } from "@trafficflow/core";
import {
  readOAuthProviderConfig, writeOAuthProviderConfig, resolveOAuthProviderConfig,
  webRedirectUri, MICROSOFT_PROVIDER, MS_DEFAULT_SCOPES,
} from "@trafficflow/db/cloud";
import { MS_TENANT_RE } from "@trafficflow/core";
import { resolveStaffSession, type StaffIdentity } from "./admin-staff.js";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import type { ApiDeps } from "../deps.js";
import type { Handler, Route } from "../router.js";

/**
 * `POST /admin/oauth/microsoft` (read) and `/save` (write) — THE ENTRA APPLICATION REGISTRATION,
 * managed from the console instead of only from an environment variable.
 *
 * ══ WHY IT IS AN ADMIN SURFACE AT ALL ══════════════════════════════════════════════════════
 *
 * An Entra client secret has an expiry Azure chooses (six months, a year, two). When it lapses,
 * EVERY oauth mailbox in the fleet stops refreshing — the worker's classifier is careful to call
 * that a `connect` failure and not an `auth` one, so nothing is quarantined, but nothing syncs
 * either. The remedy is to paste a new secret. Behind an environment variable that means a redeploy
 * of two applications, coordinated, by somebody with deploy rights; and a rotation that half landed
 * (the API redeployed, the worker not yet) is a deployment where onboarding works and refresh does
 * not. The registration is a fact about the deployment, not about a build, so it lives in a row.
 *
 * ENV REMAINS THE BOOTSTRAP — `resolveOAuthProviderConfig` prefers the row and falls back to
 * `MS_OAUTH_*` (accepting the `MICROSOFT_*` aliases) — which is what makes the first deploy work
 * with no row and what leaves a way in for an operator locked out of the console. The precedence
 * rule lives in ONE function and neither this file nor the worker re-derives it.
 *
 * ══ THE SAME TWO CREDENTIALS IN SERIES AS EVERY OTHER ADMIN WRITE ══════════════════════════
 *
 * `TF_ADMIN_SECRET` (constant-time compared) proves the request came through the console's
 * server-side proxy; a live `staff_sessions` row proves WHICH PERSON. The secret alone is 401, and
 * that refusal is the mutation-watched guard — exactly as `admin-actions.ts` documents. Every staff
 * session is minted only behind the TOTP wall, so the second factor is structural here rather than
 * re-checked. This applies to the READ as much as to the write: an application registration is a
 * credential's non-secret half, and it is not something the shared secret alone may enumerate.
 *
 * Both run on `deps.db`, the runtime connection, never on `deps.adminDb` — the content-blind console
 * role holds no write grant by construction and holds no SELECT on this table. That is deliberate
 * rather than an omission: adding one would mean the blind role could read a client id and a tenant,
 * and the boot attestation would have to be widened for a screen that gets its data through this
 * route anyway.
 *
 * ══ THE SECRET IS WRITE-ONLY. THERE IS NO CODE PATH THAT RETURNS IT ════════════════════════
 *
 * The read projects `secretSet: boolean`. Not a masked value, not a prefix, not a length — those all
 * leak, and a masked secret in a form field is also how a save that did not retype it ends up
 * writing the mask. `writeOAuthProviderConfig` treats an ABSENT secret as "leave it alone", so the
 * console's form can be saved repeatedly without touching it, and an explicit `clientSecret: null`
 * is the only way to clear it.
 *
 * A suite asserts the plaintext appears nowhere in either response body, over the SERIALIZED
 * JSON rather than by naming the fields — a field-by-field assertion only covers the fields
 * somebody remembered.
 */

/** A note shorter than this is refused, the same floor `admin-actions.ts` enforces. */
const MIN_NOTE_LENGTH = 8;

/** How many redirect URIs / scopes a save may carry. A form, not a bulk import. */
const MAX_LIST = 12;
const MAX_FIELD = 512;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const list = (v: unknown): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= MAX_FIELD)
    .slice(0, MAX_LIST);
};

type StaffRun = (
  body: Record<string, unknown>,
  staff: StaffIdentity,
  deps: ApiDeps,
) => Promise<{ status: number; body: unknown }>;

/**
 * The wrapper: unarmed ⇒ 404, shared secret ⇒ 401, live staff session ⇒ 401, JSON body, `no-store`.
 *
 * A THIRD copy of this shape now exists in `admin-actions.ts` (`staffWriteRoute`,
 * `staffMailboxWriteRoute`) and here, and that is worth naming rather than leaving to be noticed:
 * the three differ only in which id they validate, and merging them is owed. It is not done in this
 * change because the merge touches the two routes the staff-write mutation guards are written against, and a
 * refactor that moves those checks in the same diff as a new auth surface is a refactor whose
 * guards nobody watched fail.
 */
function staffConfigRoute(name: string, run: StaffRun): Handler {
  return async (req, deps) => {
    const cfg = deps.admin;
    const log = (deps.logger ?? silentLogger).child({ route: `/admin/oauth/${name}` });
    if (!cfg || cfg.secret.trim().length === 0) return json(404, { error: { code: "not_found" } });

    if (!presentsSecret(req, cfg.secret)) {
      log.warn("admin_oauth_unauthorized", {});
      return json(401, { error: { code: "unauthorized" } });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: { code: "bad_request" } });
    }

    const staff = await resolveStaffSession(deps.db, str(body.sessionToken) || undefined, deps.now());
    if (!staff) {
      log.warn("admin_oauth_no_staff_session", {});
      return json(401, { error: { code: "staff_session_required" } });
    }

    try {
      const out = await run(body, staff, deps);
      return json(out.status, out.body);
    } catch (err) {
      // `raw`: nothing above this catches. The error is logged as a STRING and the body it came from
      // is not — a save carries the plaintext client secret, so an `err` object echoed with its
      // request context would be the one place this file could leak it.
      log.error("admin_oauth_failed", { err: String(err) });
      return json(503, { error: { code: "admin_oauth_failed" } });
    }
  };
}

/**
 * WHAT THE CONSOLE IS TOLD. Everything except the secret.
 *
 * Both halves are reported and they answer different questions: the ROW is what the operator typed,
 * and the RESOLVED verdict is what the product will actually do — which differ whenever the row is
 * incomplete, disabled, or absent with env carrying the values. A screen that showed only the row
 * would say "configured" about a deployment whose flow refuses, and a screen that showed only the
 * verdict could not tell an operator which field to fill in.
 */
async function readConfig(
  _body: Record<string, unknown>, _staff: StaffIdentity, deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const row = await readOAuthProviderConfig(deps.db, MICROSOFT_PROVIDER);
  const resolved = await resolveOAuthProviderConfig({
    tx: deps.db,
    decrypt: (ct, kv) => deps.keyProvider.decrypt(ct, kv),
    bootstrap: deps.msOAuth,
    provider: MICROSOFT_PROVIDER,
  });
  return {
    status: 200,
    body: {
      ok: true,
      provider: MICROSOFT_PROVIDER,
      /** `null` ⇒ no row at all; env is the only possible source. */
      stored: row
        ? {
          clientId: row.clientId,
          tenant: row.tenant,
          redirectUris: row.redirectUris,
          scopes: row.scopes,
          enabled: row.enabled,
          // THE ONLY THING SAID ABOUT THE SECRET, ever. See the file header.
          secretSet: row.clientSecretEnc != null,
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: row.updatedBy,
          note: row.note,
        }
        : null,
      effective: {
        source: resolved.source,
        enabled: resolved.enabled,
        gap: resolved.gap,
        clientId: resolved.clientId,
        tenant: resolved.tenant,
        redirectUris: resolved.redirectUris,
        scopes: resolved.scopes,
        secretSet: resolved.clientSecret.length > 0,
        /** Which of the registered URIs the browser ceremony will name. */
        webRedirectUri: webRedirectUri(resolved),
      },
      defaults: { scopes: MS_DEFAULT_SCOPES },
      at: deps.now().toISOString(),
    },
  };
}

async function saveConfig(
  body: Record<string, unknown>, staff: StaffIdentity, deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const note = str(body.note).trim();
  if (note.length < MIN_NOTE_LENGTH) return { status: 400, body: { error: { code: "note_required" } } };

  const clientId = body.clientId === undefined ? undefined : str(body.clientId).trim().slice(0, MAX_FIELD);
  const tenant = body.tenant === undefined ? undefined : str(body.tenant).trim().slice(0, MAX_FIELD);
  // VALIDATED BEFORE IT IS STORED, not when it is first interpolated into a URL. A tenant that fails
  // `MS_TENANT_RE` is refused here so the operator finds out at the form rather than discovering it
  // as a 503 on somebody else's connect — the derivation in `packages/core` still refuses it too,
  // and that check stays because this one is not the only writer a row could ever have.
  if (tenant !== undefined && tenant.length > 0 && !MS_TENANT_RE.test(tenant)) {
    return { status: 400, body: { error: { code: "tenant_invalid" } } };
  }

  const redirectUris = list(body.redirectUris);
  if (redirectUris) {
    // A redirect URI is a URL the browser will be sent to and, at the exchange, a value replayed to
    // Microsoft. `https://` is required for the web ceremony; `http://localhost` is admitted because
    // that is the desktop flow's loopback and the operator's list is a record of what Azure holds.
    // Anything else — another scheme, a plain-http remote host — is refused rather than stored to be
    // silently skipped by `webRedirectUri`.
    for (const uri of redirectUris) {
      const okHttps = uri.startsWith("https://");
      const okLoopback = uri.startsWith("http://localhost") || uri.startsWith("http://127.0.0.1");
      if (!okHttps && !okLoopback) {
        return { status: 400, body: { error: { code: "redirect_uri_invalid" } } };
      }
    }
  }

  /**
   * THE SECRET. Encrypted here and never held anywhere else.
   *
   * Three cases and they are distinguished by JS's own two absences, which is worth stating because
   * a reader will suspect a bug: `undefined` (the key is not in the body) means LEAVE IT ALONE, and
   * that is what makes the form's write-only field work — the console omits the key unless somebody
   * typed something. `null` is an explicit clear. A non-empty string is a new secret. An EMPTY
   * string is treated as `undefined`, because a form that submits `""` for an untouched password
   * field is the normal browser behaviour and must not erase a working registration.
   */
  let clientSecret: { ciphertext: string; keyVersion: number } | null | undefined;
  if (body.clientSecret === null) {
    clientSecret = null;
  } else if (typeof body.clientSecret === "string" && body.clientSecret.trim().length > 0) {
    const enc = await deps.keyProvider.encrypt(body.clientSecret.trim());
    clientSecret = { ciphertext: enc.ciphertext, keyVersion: enc.keyVersion };
  }

  await writeOAuthProviderConfig(deps.db, {
    provider: MICROSOFT_PROVIDER,
    ...(clientId !== undefined ? { clientId } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
    ...(redirectUris !== undefined ? { redirectUris } : {}),
    ...(list(body.scopes) !== undefined ? { scopes: list(body.scopes)! } : {}),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    updatedBy: staff.staffId,
    note,
    now: deps.now(),
  });

  // The read is re-run so the console renders the EFFECTIVE verdict after the write rather than
  // echoing what it just sent — which is how a form comes to show `enabled: true` beside a
  // registration the resolver refuses for a missing field.
  const after = await readConfig({}, staff, deps);
  return {
    status: 200,
    body: { ...(after.body as Record<string, unknown>), action: "admin.oauth.microsoft.save", actor: staff.email },
  };
}

/**
 * `public + anonymous + raw` and `cost: "unauthenticated"`, exactly as the other admin routes and
 * for the same reason: ANONYMOUS_PIPELINE resolves no customer session, so there is no account whose
 * verification state could be confused with anything. The authority is the shared secret plus, inside
 * the handler, a live `staff_sessions` row.
 *
 * BOTH ARE POST, INCLUDING THE READ, and that is a transport fact rather than a REST opinion: the
 * staff session token rides in the BODY (the console's proxy forwards the HttpOnly cookie there,
 * the same transport `/admin/staff/totp/begin` and `POST /admin/staff/whoami` already use), and a
 * GET has no body to put it in. The alternative — the token in a header or a query parameter — puts
 * a live session credential into access logs.
 */
const OPTIONS = { public: true, anonymous: true, raw: true } as const;
const COST = "unauthenticated" as const;

export const adminOAuthRoutes: Route[] = [
  { method: "POST", pattern: "/admin/oauth/microsoft", cost: COST, options: OPTIONS, handler: staffConfigRoute("microsoft", readConfig) },
  { method: "POST", pattern: "/admin/oauth/microsoft/save", cost: COST, options: OPTIONS, handler: staffConfigRoute("microsoft/save", saveConfig) },
];
