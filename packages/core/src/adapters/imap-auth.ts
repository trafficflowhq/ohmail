// The one place a stored credential becomes an `ImapConfig.auth`. Every host that opens a mailbox
// turns `(meta, secret)` into the auth an `ImapAdapter` connects with, and no site assembles it
// by hand: an OAuth2 mailbox stores a refresh token in `secret_enc`, and a site that does not
// branch on `meta.authType` would hand that token to imapflow as an IMAP LOGIN password — the
// user's refresh token, in clear, on the wire. So an unrecognised `authType` is a throw, never a
// default: a new provider is added here, in one visible diff, or it does not connect at all.
// Pure, no runtime imports, so `packages/services`' onboarding refusal can import it without
// dragging imapflow/nodemailer into the API bundle.
import type { ImapAuth } from "./imap-types.js";

/**
 * The non-secret half of a credential, as it sits in `mailbox_credentials.meta` (jsonb). Every
 * field is optional because the column is untyped at rest and a password row carries no `authType`
 * at all — its absence is what makes the password path a byte-for-byte no-op.
 */
export interface CredMetaAuth {
  user?: string;
  /** Absent or `"password"` ⇒ the historical path. `"oauth2"` ⇒ {@link ImapOAuthAuth}. */
  authType?: string;
  /** For `oauth2`: which token endpoint family. Today only `"microsoft"`. */
  provider?: string;
  /** For `oauth2`: the Azure AD tenant segment of the token endpoint (validated in the token client). */
  tenant?: string;
  /**
   * For `oauth2`: which application registration issued this refresh token — `"public"` or
   * `"confidential"`; absent means `"confidential"`, the only door older tokens came through. A
   * refresh token is bound to the client that obtained it: Microsoft refuses one presented by a
   * different `client_id`, and the failure is silent — `refreshAccessToken` maps a rejected
   * client to `OAuthProviderUnavailableError`, so the mailbox simply stops receiving mail an hour
   * after connecting. One self-hosted install can hold both kinds at once, so a host-wide setting
   * has no single right answer; the provenance travels with the credential.
   */
  clientKind?: string;
}

/**
 * Where an OAuth mailbox submits — the coordinates, with the product's defaults applied. An oauth
 * mailbox stores no `smtp` credential row: one refresh token covers both transports, so
 * host/port/secure live in the imap row's `meta.smtp`. Three sites resolve them (the send
 * adapter, the `SIZE` probe, the sync host's loader), and each once wrote the same three `??`
 * defaults by hand — a triplicated constant whose drift dials somebody else's default port. The
 * defaults are Exchange Online's submission endpoint on the STARTTLS port; `secure: false` is not
 * plaintext — `smtpTlsFloor` makes STARTTLS mandatory, which is what 587 speaks.
 */
export function oauthSmtpEndpoint(
  smtp: { host?: string; port?: number; secure?: boolean } | undefined,
): { host: string; port: number; secure: boolean } {
  return {
    host: smtp?.host ?? "smtp.office365.com",
    port: smtp?.port ?? 587,
    secure: smtp?.secure ?? false,
  };
}

/**
 * A HOST-PROVIDED factory that turns the stored refresh token + oauth params into the freshness
 * callback {@link ImapOAuthAuth} carries. The host binds it to a mailbox and to its own caching +
 * rotation-persist policy (worker: per-mailbox, long-lived; API: per-invocation); this module knows
 * none of that. Absent at a site means "this site does not do oauth", and an oauth row there throws
 * rather than falling back to a password interpretation of a refresh token.
 */
export type AccessTokenFetcherFactory = (
  input: {
    refreshToken: string; tenant: string; provider: string;
    /**
     * The DOOR this token came through — see {@link CredMetaAuth.clientKind}. Optional so every
     * existing caller compiles unchanged, and absent is read as `"confidential"` by the one
     * implementation, which is the door every pre-device-flow token was issued by.
     */
    clientKind?: string;
  },
) => () => Promise<string>;

/**
 * A per-process source of mailbox access tokens: the {@link AccessTokenFetcherFactory}
 * `buildImapAuth` calls for one mailbox, bound by a host to its own caching and rotation-persist
 * policy. It lives here, beside the factory type it returns, rather than in
 * `../oauth/microsoft.js`: this port is how a host that opens mailboxes names its token source,
 * so it belongs to the auth-assembly seam every host compiles. The Microsoft client that fills it
 * stays next door; a consumer of this module can be handed a provider without being able to
 * construct one.
 */
export interface OAuthTokenProvider {
  /** The {@link AccessTokenFetcherFactory} `buildImapAuth` calls for one mailbox. */
  forMailbox(mailboxId: string): AccessTokenFetcherFactory;
}

/**
 * An `authType` (or provider) this build cannot connect. NAMED and thrown — see the module header.
 *
 * `code` is a stable constant, not the offending value: it rides into logs through the class/code
 * grammar `log.ts` already enforces, and the offending `authType` string could in principle be
 * attacker-influenced via a mailbox row, so it is never the log token.
 */
export class UnsupportedAuthTypeError extends Error {
  readonly code = "OAUTH_UNSUPPORTED_AUTH_TYPE";
  constructor(public readonly authType: string) {
    super(`unsupported mailbox auth type: ${authType}`);
    this.name = "UnsupportedAuthTypeError";
  }
}

/**
 * `(meta, secret) → ImapConfig.auth`. The ONLY reader of `meta.authType`.
 *
 *  · absent / `"password"` → `{ user, pass: secret }`, exactly as every site wrote by hand before.
 *  · `"oauth2"` + `provider:"microsoft"` + a wired `makeFetcher` → `{ user, fetchAccessToken }`,
 *    where `secret` is the REFRESH TOKEN and never leaves as a password.
 *  · anything else — an unknown `authType`, an oauth2 row at a site with no token source, a
 *    provider we do not speak — THROWS {@link UnsupportedAuthTypeError}.
 */
export function buildImapAuth(
  meta: CredMetaAuth,
  secret: string,
  makeFetcher?: AccessTokenFetcherFactory,
): ImapAuth {
  const authType = meta.authType ?? "password";
  if (authType === "password") {
    return { user: meta.user ?? "", pass: secret };
  }
  if (authType === "oauth2") {
    if (meta.provider !== "microsoft") {
      throw new UnsupportedAuthTypeError(`oauth2:${meta.provider ?? "unknown-provider"}`);
    }
    if (!makeFetcher) {
      // An oauth2 row reached a site that has no token source wired. Refusing is the whole point:
      // the alternative (fall through to the password branch) is the refresh-token-as-password leak.
      throw new UnsupportedAuthTypeError("oauth2:no-token-source");
    }
    return {
      user: meta.user ?? "",
      fetchAccessToken: makeFetcher({
        refreshToken: secret,
        tenant: meta.tenant ?? "",
        provider: meta.provider,
        // Passed through UNINTERPRETED. This module does not know what the kinds mean — it only
        // knows the provenance belongs to the credential, so the factory that resolves a
        // registration is the thing that gets to see it. Dropping it here would make every
        // device-connected mailbox refresh against the confidential client.
        ...(meta.clientKind !== undefined ? { clientKind: meta.clientKind } : {}),
      }),
    };
  }
  throw new UnsupportedAuthTypeError(authType);
}
