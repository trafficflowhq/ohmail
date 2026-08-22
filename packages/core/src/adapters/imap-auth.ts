// THE ONE PLACE A STORED CREDENTIAL BECOMES AN `ImapConfig.auth`.
//
// Every host that opens a mailbox — the worker, the API's send + attachment dialers, the add-time
// probe, the desktop sidecar — reads a `mailbox_credentials` row (or a request body) and has to
// turn `(meta, secret)` into the `auth` an `ImapAdapter` connects with. Before this they each wrote
// their own `auth: { user, pass }`, which was correct for the only shape that existed. It is a
// LOADED GUN the moment a second shape exists:
//
//   an OAuth2 mailbox stores a REFRESH TOKEN in `secret_enc`. A site that does not branch on
//   `meta.authType` decrypts it and hands it to imapflow as an IMAP LOGIN password — i.e. it sends
//   the user's refresh token, in clear, as a password to Microsoft. That is the single deadliest
//   failure this whole feature can produce, and the defence is that NO site assembles `auth` by
//   hand: they all call this, and this is the only thing that reads `authType`.
//
// So the contract is deliberately unforgiving: an `authType` this function does not recognise is a
// THROW, not a default. A new provider must be added HERE, in one diff a reviewer can see, or it
// does not connect at all. Fail-closed, because the failure of failing-open is a credential on the
// wire.
//
// No runtime imports: this is pure, and stays importable by `packages/services`' onboarding refusal
// without dragging `imapflow`/`nodemailer` into the API bundle — the same rule `imap-types.ts` keeps.
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
}

/**
 * WHERE AN OAUTH MAILBOX SUBMITS — the coordinates, with the product's defaults applied.
 *
 * An oauth mailbox stores NO `smtp` credential row: one refresh token covers both transports, so
 * the submission host/port/secure live in the imap row's `meta.smtp` and the secret does not
 * repeat. Three sites resolve them — the send adapter, the `SIZE` probe on the API host, and the
 * sync host's credential loader — and each of them wrote the same three `??` defaults by hand.
 * That is a triplicated constant with a sharp failure: a mailbox whose meta carries no submission
 * block would, at the site that drifted, be dialled on somebody else's default port.
 *
 * It lives beside {@link buildImapAuth} because it answers the other half of the same question —
 * that function says WHAT to present, this says WHERE — and because this module is pure, so the
 * services package's onboarding refusal can reach it without pulling nodemailer into the bundle.
 *
 * The defaults are Exchange Online's submission endpoint on the STARTTLS port, which is the only
 * provider `buildImapAuth` will assemble an oauth auth for at all (`provider: "microsoft"`, and
 * anything else throws there). `secure: false` is not plaintext: `smtpTlsFloor` turns it into a
 * MANDATORY STARTTLS, which is what 587 speaks.
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
  input: { refreshToken: string; tenant: string; provider: string },
) => () => Promise<string>;

/**
 * A per-process (or per-invocation) source of mailbox access tokens: the {@link
 * AccessTokenFetcherFactory} `buildImapAuth` calls for one mailbox, bound by a host to its own
 * caching and rotation-persist policy.
 *
 * It lives HERE, beside the factory type it returns, rather than in `../oauth/microsoft.js` where
 * its one implementation does: this port is how a host that opens mailboxes NAMES its token source,
 * so it belongs to the auth-assembly seam every host compiles — including one built from the mail
 * half alone. The Microsoft client that fills it stays next door, and a consumer of this module can
 * be handed a provider without being able to construct one.
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
      fetchAccessToken: makeFetcher({ refreshToken: secret, tenant: meta.tenant ?? "", provider: meta.provider }),
    };
  }
  throw new UnsupportedAuthTypeError(authType);
}
