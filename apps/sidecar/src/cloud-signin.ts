import { createHash, randomBytes } from "node:crypto";

import type { CloudTokens } from "./cloud-auth.js";
import type { Diagnostic } from "./log.js";

/**
 * Signing in to the hosted account, from a Cloud-mode install with no session yet. Cloud mode used
 * to require a token pair already in the environment; there is nowhere else, so this turns an email,
 * password and code into the pair the mirror pulls with. A second path is a code from the browser:
 * it signs in at `ohmail.app`, mints a one-use handoff code, and this exchanges it at
 * `POST /auth/desktop-claim`. Handing that code back over the `ohmail://` scheme is unsafe, so this
 * invents a VERIFIER (32 random bytes) kept in memory and publishes only `sha256(verifier)` as the
 * CHALLENGE — the account binds the code to the digest and refuses a caller that cannot produce it.
 * The verifier is never a body or log field and dies with the process; the retype path is unchanged.
 */

/** Why a sign-in did not produce a session. `code` is for the surface; `message` is for a person. */
export class CloudSignInError extends Error {
  readonly code: string;
  /** What this install should answer its own caller with. */
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "CloudSignInError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Two shapes, and `handoffCode` selects between them: the PASSWORD path (`{email, password, totp}`,
 * the two-step hosted sign-in, still the default) and the BROWSER path (`{handoffCode}` alone — the
 * person signed in on ohmail.app, that page minted a one-use code, and they retyped it here; one
 * request, no password in this process at any point). Every field is optional because this arrives
 * as JSON over the bridge and a type is not a validation — {@link cloudSignIn} decides which branch
 * it is on and refuses a request that satisfies neither.
 */
export interface CloudSignInRequest {
  email?: string;
  password?: string;
  /** The six digits from the authenticator app. */
  totp?: string;
  /** The code shown by `ohmail.app/link-desktop`. Present ⇒ the other three are not read. */
  handoffCode?: string;
}

/** The platform-qualified kinds a desktop install may declare itself as, on either door. */
export type DesktopDeviceKind = "desktop-linux" | "desktop-macos" | "desktop-windows";

/**
 * What THIS process is, in the hosted vocabulary — from the platform Node reports, which is a
 * fact about the running binary rather than anything a caller could claim. `null` for a
 * platform the vocabulary has no word for (a BSD, an exotic build): the declaration is then
 * OMITTED and the hosted side keeps its legacy reading, exactly as an old install's claim does
 * — an honest silence, never a guessed kind.
 */
export function desktopDeviceKind(platform: string): DesktopDeviceKind | null {
  switch (platform) {
    case "linux": return "desktop-linux";
    case "darwin": return "desktop-macos";
    case "win32": return "desktop-windows";
    default: return null;
  }
}

export interface CloudSignInOptions {
  /** e.g. `https://api.ohmail.app`. A trailing slash is trimmed. */
  baseUrl: string;
  /** Injected for tests; production dials the real hosted API. */
  fetchImpl?: typeof fetch;
  log?: Diagnostic;
  /**
   * The kind this install declares on both sign-in paths: `kind` beside the code on
   * `POST /auth/desktop-claim`, and beside the six digits on `POST /auth/2fa/totp/verify` — so the
   * account's device list can say WHICH install a session is. ON THE OPTIONS and not the request,
   * the verifier's placement rule: the request is JSON from the bridge, and what this process runs
   * on is not a caller's to assert. Composed from {@link desktopDeviceKind}(process.platform);
   * absent (an unrecognized platform, an older engine) omits the field and the host reads the sign-in
   * as it read every one before the vocabulary existed.
   */
  deviceKind?: DesktopDeviceKind;
  /**
   * The PKCE verifier this install is holding, if it minted one before opening the browser. ON THE
   * OPTIONS and not the request, and that placement is the whole rule: the request is JSON from the
   * bridge, the options are composed by the engine from its own memory. Putting the verifier on the
   * request shape would let any caller reaching `POST /cloud/signin` name the verifier a code is
   * claimed with — the capability the binding exists to withhold from whoever intercepted the scheme.
   * Absent is not a lesser call: it is the retype flow, where the code was minted unbound.
   */
  verifier?: string;
}

/**
 * A PKCE pair: the secret this process keeps, and the commitment it is willing to publish.
 *
 * `verifier` is 32 bytes from the platform CSPRNG, base64url — 43 characters, the same length and
 * alphabet the challenge has, which is a coincidence of SHA-256 also being 32 bytes and not a
 * relationship between them. `challenge` is `base64url(sha256(utf8(verifier)))`, and the encoding
 * is PINNED rather than incidental: the hosted side compares it against a digest it computes the
 * same way over the same string, so a hex digest, a padded base64 or a hash of the DECODED bytes
 * would each produce a well-formed value that can never match.
 */
export interface DesktopLinkPair {
  readonly verifier: string;
  readonly challenge: string;
}

/**
 * The commitment for a verifier — the digest, and nothing else about it.
 *
 * Exported because it is the half of the contract most likely to drift, and the drift is silent:
 * every wrong encoding still produces 43-ish characters of plausible-looking text, and the only
 * symptom is a handoff that is refused with the same sentence an expired code gets. It is
 * asserted directly against the hosted side's own `hashToken`.
 */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** A fresh pair. The caller keeps `verifier` and publishes `challenge`; see the file header. */
export function newDesktopLinkPair(): DesktopLinkPair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

/**
 * The token pair a `Set-Cookie` set carries, or null when the response set no session cookies.
 *
 * Exported because it is the half of the wire most likely to drift: a change to the cookie names or
 * to their contents breaks sign-in and nothing else would notice, so it is asserted directly.
 */
export function tokensFromSetCookie(cookies: readonly string[]): CloudTokens | null {
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  let issued: Pick<CloudTokens, "expiresIn"> = {};
  for (const cookie of cookies) {
    const [pair = "", ...attrs] = cookie.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "") continue;
    if (name === "tf_session") {
      accessToken = value;
      // The access cookie lives exactly as long as the access token: its Max-Age IS the window.
      const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a))?.slice("max-age=".length);
      issued = windowOf({ expiresIn: maxAge !== undefined && /^\d+$/.test(maxAge) ? Number(maxAge) : undefined });
    } else if (name === "tf_refresh") refreshToken = value;
  }
  return accessToken && refreshToken ? { accessToken, refreshToken, ...issued } : null;
}

/** The access window a pair came with, kept beside it (never sealed) so the first renewal is scheduled. */
function windowOf(wire: { expiresIn?: unknown }): Pick<CloudTokens, "expiresIn"> {
  const s = wire.expiresIn;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? { expiresIn: s } : {};
}

/** The token pair a session response carries, from whichever of the two places holds it. */
function tokensFromResponse(body: unknown, res: Response): CloudTokens | null {
  const wire = (body as { tokens?: { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown } } | null)?.tokens;
  if (typeof wire?.accessToken === "string" && typeof wire?.refreshToken === "string") {
    return { accessToken: wire.accessToken, refreshToken: wire.refreshToken, ...windowOf(wire) };
  }
  return tokensFromSetCookie(res.headers.getSetCookie());
}

/** Parse a JSON body, tolerating a response that carried none. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Whose account a token pair belongs to — asked of the hosted service, never of the caller. A
 * sign-in body names an address, but that is an INPUT (typed into a field, and not sent at all on
 * the browser path) and is no evidence of which account the pair opens. The mirror-owner decision
 * may not rest on an input, so it rests on one authenticated read of `GET /auth/session`, composed
 * by the account from the row the access token resolves to. FAIL CLOSED: this returns an address or
 * throws rather than "unknown", because its caller decides whether to activate over a mirror already
 * holding mail — an unconfirmed identity that fell through as a match would be a leak via a network
 * blip. Cheap (once per sign-in) and deliberately NOT on the launch path.
 */
export async function cloudIdentity(opts: CloudSignInOptions, tokens: CloudTokens): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const unconfirmed = (): CloudSignInError =>
    new CloudSignInError(
      "identity_unconfirmed",
      502,
      "the hosted service would not say which account this sign-in belongs to, so this install " +
        "cannot tell whether the mail it already holds is yours",
    );

  let res: Response;
  try {
    res = await fetchImpl(`${base}/auth/session`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
  } catch (err) {
    // The ADDRESS is not a log field here for the reason it is not one in `enforceMirrorOwner`:
    // which account an install is signing in as is the identifying fact the sidecar log census
    // exists to keep off the line. That the identity could not be resolved is the whole of it.
    opts.log?.("cloud_identity_unresolved", { err, reason: "the hosted service could not be reached" });
    throw unconfirmed();
  }
  if (!res.ok) {
    opts.log?.("cloud_identity_unresolved", { status: res.status, reason: "the hosted service refused the read" });
    throw unconfirmed();
  }
  const body = await readJson(res);
  const email = trimmed((body as { user?: { email?: unknown } } | null)?.user?.email);
  if (!email) {
    opts.log?.("cloud_identity_unresolved", { status: res.status, reason: "the answer carried no address" });
    throw unconfirmed();
  }
  return email;
}

/**
 * Sign in to the hosted account and return the pair the mirror pulls with.
 *
 * Throws {@link CloudSignInError} for every refusal, with a `status` this install can answer its own
 * caller with — a wrong password is 401 here because it was 401 there, and a hosted service that is
 * unreachable is 502 because this install is the one reporting it.
 */
export async function cloudSignIn(
  opts: CloudSignInOptions,
  req: CloudSignInRequest,
): Promise<CloudTokens> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const email = trimmed(req.email);
  const password = typeof req.password === "string" ? req.password : "";
  const code = trimmed(req.totp);
  const handoff = trimmed(req.handoffCode);

  const post = async (path: string, body: unknown, step: string): Promise<Response> => {
    try {
      return await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      opts.log?.("cloud_signin_failed", { err, reason: `the hosted service could not be reached at ${step}` });
      throw new CloudSignInError("cloud_unreachable", 502, "the hosted service could not be reached");
    }
  };

  // ── THE BROWSER PATH — one request, and no password in this process at any point ──────────
  //
  // Taken FIRST, so a body carrying a handoff code is never also treated as a password attempt.
  // The code is worth a session for about two minutes and only once, so there is nothing here
  // to seal, retry or remember: the pair comes back in the body, exactly as the native branch
  // of `POST /auth/refresh` answers, and the caller seals it the way it seals every other pair.
  if (handoff) {
    // THE FIELD IS OMITTED RATHER THAN SENT EMPTY when this install holds no verifier. The hosted
    // side reads an absent verifier as the real predicate "this code was minted unbound", and an
    // empty string is not that — it is a claim to hold the verifier for the digest of "", which is
    // a challenge somebody could deliberately mint. Two shapes, and the difference is a refusal.
    // `kind` follows the same rule: present when the engine knows its platform, omitted rather
    // than guessed when it does not (the hosted side then keeps the legacy "macos" reading).
    const verifier = trimmed(opts.verifier);
    const res = await post(
      "/auth/desktop-claim",
      {
        code: handoff,
        ...(verifier ? { verifier } : {}),
        ...(opts.deviceKind ? { kind: opts.deviceKind } : {}),
      },
      "claim",
    );
    const body = await readJson(res);
    if (!res.ok) {
      opts.log?.("cloud_signin_refused", { status: res.status, reason: "the hosted service refused the code" });
      // 429 is kept as 429 rather than folded into the refusal: "too many tries, wait a bit" and
      // "that code is not valid" are different things to do next, and a person who has just
      // retyped a code four times is precisely the person who needs to be told which.
      if (res.status === 429) {
        throw new CloudSignInError(
          "rate_limited", 429,
          "too many attempts from this connection; give it a few minutes and try again",
        );
      }
      throw new CloudSignInError(
        res.status === 400 || res.status === 401 ? "invalid_handoff_code" : "hosted_refused",
        res.status === 400 || res.status === 401 ? 401 : 502,
        res.status === 400 || res.status === 401
          ? "that code was not accepted; codes work once and expire after a couple of minutes, " +
            "so ask the browser for a fresh one"
          : `the hosted service answered HTTP ${res.status} to the code`,
      );
    }
    const tokens = tokensFromResponse(body, res);
    if (!tokens) {
      throw new CloudSignInError(
        "no_session_returned", 502,
        "the hosted service accepted the code and returned no session",
      );
    }
    return tokens;
  }

  // Refused HERE rather than by the hosted service, because an empty password is a login attempt
  // that counts against a lockout on some deployments and buys nothing.
  if (!email || !password || !code) {
    throw new CloudSignInError(
      "invalid_request",
      400,
      "signing in needs the address, the password and the current six-digit code",
    );
  }

  const loginRes = await post("/auth/login", { email, password }, "login");
  const loginBody = await readJson(loginRes);
  if (!loginRes.ok) {
    opts.log?.("cloud_signin_refused", { status: loginRes.status, reason: "the hosted service refused the login" });
    throw new CloudSignInError(
      loginRes.status === 401 || loginRes.status === 400 ? "invalid_credentials" : "hosted_refused",
      loginRes.status === 401 || loginRes.status === 400 ? 401 : 502,
      loginRes.status === 401 || loginRes.status === 400
        ? "that address and password were not accepted"
        : `the hosted service answered HTTP ${loginRes.status} to the login`,
    );
  }

  const status = trimmed((loginBody as { status?: unknown } | null)?.status);
  if (status === "enrollment") {
    // A registered account with no second factor yet. Enrolling one is a browser ceremony — it
    // shows a QR code — and pretending otherwise here would be a half-built enrollment surface
    // inside a mail engine.
    throw new CloudSignInError(
      "enrollment_required",
      409,
      "this account has no authenticator set up yet; finish that on the web and sign in here afterwards",
    );
  }
  const loginToken = trimmed((loginBody as { loginToken?: unknown } | null)?.loginToken);
  if (status !== "twofa_required" || !loginToken) {
    throw new CloudSignInError(
      "unsupported_login_result",
      502,
      "the hosted service answered the login with something this install does not understand",
    );
  }

  // THE FIELD IS `loginToken`. `challengeToken` is the name everybody reaches for and it is not
  // this one; a wrong name here answers 400 and reads exactly like a wrong code.
  // `kind` is this install's platform declaration — what turns the password path's session from
  // a deviceless row nobody can attribute into a named device the account can list, revoke and
  // be paged about. Omitted when unknown; an older hosted service ignores the extra field.
  const verifyRes = await post(
    "/auth/2fa/totp/verify",
    { loginToken, code, ...(opts.deviceKind ? { kind: opts.deviceKind } : {}) },
    "verify",
  );
  const verifyBody = await readJson(verifyRes);
  if (!verifyRes.ok) {
    opts.log?.("cloud_signin_refused", { status: verifyRes.status, reason: "the hosted service refused the code" });
    throw new CloudSignInError(
      verifyRes.status === 401 || verifyRes.status === 400 ? "invalid_code" : "hosted_refused",
      verifyRes.status === 401 || verifyRes.status === 400 ? 401 : 502,
      verifyRes.status === 401 || verifyRes.status === 400
        ? "that code was not accepted; codes last thirty seconds, so try the current one"
        : `the hosted service answered HTTP ${verifyRes.status} to the code`,
    );
  }

  const tokens = tokensFromResponse(verifyBody, verifyRes);
  if (!tokens) {
    throw new CloudSignInError(
      "no_session_returned",
      502,
      "the hosted service accepted the code and returned no session",
    );
  }
  return tokens;
}

/**
 * Redeeming a pairing code printed by another machine's desktop — the third way in, structurally
 * simplest (one request, one single-use token, a bearer pair back). Its own function because its two
 * facts are not the sign-in's. `kind` is REQUIRED here (the sign-in paths only prefer it): an absent
 * kind defaults to `"web"` on the host, so a desktop that omitted it appears in the Devices pane as a
 * browser — a false state where a person decides what to revoke — so a platform this build has no
 * word for is REFUSED rather than mislabelled. The account is asked of the host and recorded so a
 * LATER answer naming a different account can be refused (a reinstall at the same address is a
 * different world). `null` is kept DISTINCT, and {@link accountIsForeign} refuses only on disagreement.
 */
export interface PairRedeemResult {
  tokens: CloudTokens;
  /** The account the host named, or null when it named none. Never a guess. */
  accountId: string | null;
}

/** The header a host names the account in. One spelling, matching `packages/api/src/app.ts`. */
export const ACCOUNT_HEADER = "x-ohmail-account";

export interface PairRedeemOptions extends CloudSignInOptions {
  /** REQUIRED, unlike on the sign-in paths — see the header. */
  deviceKind: DesktopDeviceKind;
}

export async function redeemPairingToken(
  opts: PairRedeemOptions,
  token: string,
): Promise<PairRedeemResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const code = trimmed(token);
  if (!code) {
    throw new CloudSignInError("invalid_request", 400, "that pairing code is empty");
  }
  /* PRESENT AND A KNOWN KIND. The type says so and a type is not a validation: this arrives from
     an engine that composed it from `process.platform`, and a platform the vocabulary has no word
     for produces `null` there. Refused here rather than sent, for the header's reason. */
  if (!opts.deviceKind) {
    throw new CloudSignInError(
      "unsupported_platform",
      409,
      "this build cannot tell the other computer what kind of machine this is, and pairing " +
        "without that would list it there as a browser",
    );
  }

  let res: Response;
  try {
    res = await fetchImpl(`${base}/pair/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: "device-pair", token: code, kind: opts.deviceKind }),
    });
  } catch (err) {
    opts.log?.("cloud_pair_redeem_failed", {
      err,
      reason: "the paired computer could not be reached while redeeming the code",
    });
    throw new CloudSignInError("host_unreachable", 502, "that computer could not be reached");
  }

  const body = await readJson(res);
  if (!res.ok) {
    // The STATUS and nothing else. Which code was presented and whose account refused it are the
    // identifying facts the sidecar log census keeps off the line.
    opts.log?.("cloud_pair_redeem_refused", { status: res.status, reason: "the paired computer refused the code" });
    /* 409 IS ITS OWN ANSWER AND NOT A BAD CODE. The host refuses a credential belonging to
       another account with `session_conflict`, and telling somebody to ask for a fresh code would
       send them round a loop that cannot end. */
    if (res.status === 409) {
      throw new CloudSignInError(
        "pair_refused",
        409,
        "that computer refused the code because it belongs to a different account",
      );
    }
    if (res.status === 429) {
      throw new CloudSignInError(
        "rate_limited", 429,
        "too many attempts from this connection; give it a few minutes and try again",
      );
    }
    throw new CloudSignInError(
      res.status === 400 || res.status === 401 ? "invalid_pair_code" : "host_refused",
      res.status === 400 || res.status === 401 ? 401 : 502,
      res.status === 400 || res.status === 401
        ? "that pairing code was not accepted; codes work once, so print a fresh one from that " +
          "computer's Settings → Devices"
        : `that computer answered HTTP ${res.status} to the code`,
    );
  }

  /* THE BODY ONLY. A pairing redeem answers `{grant, tokens}` and never a cookie — the host's door
     is composed `allowCookieAuth: false` — so the cookie fallback the sign-in paths need would be
     reading for a transport this door does not have. Asking for it anyway would quietly accept a
     session established the one way this ceremony refuses. */
  const wire = (body as { tokens?: { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown } } | null)?.tokens;
  if (typeof wire?.accessToken !== "string" || typeof wire?.refreshToken !== "string") {
    throw new CloudSignInError(
      "no_session_returned", 502,
      "that computer accepted the code and returned no session",
    );
  }
  const named = trimmed(res.headers.get(ACCOUNT_HEADER));
  return {
    tokens: { accessToken: wire.accessToken, refreshToken: wire.refreshToken, ...windowOf(wire) },
    accountId: named === "" ? null : named,
  };
}

// ── Signing in by confirming in the browser ───────────────────────────────────────────────────

/**
 * The browser-approval door. The engine asks the hosted service for a request committed to a PKCE
 * challenge, the person confirms it on ohmail.app, and the engine polls the claim with the
 * verifier it kept in memory. A busy server is a wait, never a refusal: the request retries on the
 * server's `Retry-After`, and a busy or unreachable poll reads as still pending. A 404 means the
 * hosted service predates the door, and the window falls back to the code path by name.
 */
interface ApprovalRequestOptions extends CloudSignInOptions {
  /** This computer's name as the page will show it; the engine passes its own hostname. */
  label: string;
  /** Injected for tests; the retry waits otherwise. */
  sleep?: (ms: number) => Promise<void>;
}

/** What the window gets back: the id it puts in the page's URL and the request's lifetime. */
interface ApprovalStart {
  approvalId: string;
  expiresIn: number;
}

/** One poll's answer: still waiting (and for how long), or the pair. */
type ApprovalPoll =
  | { status: "pending"; retryAfterMs: number; note?: "busy" | "unreachable" }
  | { status: "approved"; tokens: CloudTokens };

/** The request asks at most this many times while the server answers busy. */
export const APPROVAL_BUSY_ATTEMPTS = 4;
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clampWait = (ms: number): number => Math.min(8_000, Math.max(500, ms));

/** The server's `Retry-After` seconds as a wait, bounded, or the fallback. */
function retryAfterMs(res: Response, fallback: number): number {
  const secs = Number(res.headers.get("retry-after"));
  return clampWait(Number.isFinite(secs) && secs > 0 ? secs * 1000 : fallback);
}

/** Our envelope's busy answer, the same test the web client applies. */
async function busyAnswer(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const body = (await readJson(res.clone())) as { error?: { code?: unknown } } | null;
  return body?.error?.code === "db_busy";
}

const notOffered = (): CloudSignInError => new CloudSignInError(
  "approval_not_offered", 409,
  "Your ohmail Cloud does not offer browser approval yet. Type a code instead.",
);

/** Ask for an approval request. Retries a busy server on its own `Retry-After`, bounded. */
export async function requestDesktopApproval(
  opts: ApprovalRequestOptions, challenge: string,
): Promise<ApprovalStart> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const body = JSON.stringify({
    challenge, label: opts.label, ...(opts.deviceKind ? { kind: opts.deviceKind } : {}),
  });
  for (let attempt = 1; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/auth/desktop-approval`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
    } catch (err) {
      opts.log?.("cloud_signin_failed", { err, reason: "the hosted service could not be reached at approval" });
      throw new CloudSignInError("cloud_unreachable", 502, "the hosted service could not be reached");
    }
    if (await busyAnswer(res)) {
      if (attempt >= APPROVAL_BUSY_ATTEMPTS) {
        throw new CloudSignInError("db_busy", 503, "The ohmail server is busy. Try again in a moment.");
      }
      await sleep(retryAfterMs(res, 2_000));
      continue;
    }
    const answer = await readJson(res);
    if (res.status === 404) throw notOffered();
    if (res.status === 429) {
      throw new CloudSignInError(
        "rate_limited", 429, "too many attempts from this connection; give it a few minutes and try again",
      );
    }
    const approvalId = trimmed((answer as { approvalId?: unknown } | null)?.approvalId);
    const expiresIn = Number((answer as { expiresIn?: unknown } | null)?.expiresIn);
    if (!res.ok || !APPROVAL_ID.test(approvalId) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      opts.log?.("cloud_signin_refused", { status: res.status, reason: "the hosted service refused the approval request" });
      throw new CloudSignInError("hosted_refused", 502, `the hosted service answered HTTP ${res.status} to the approval request`);
    }
    return { approvalId, expiresIn };
  }
}

/** The claim's refusals, in the sentences the window shows. */
const APPROVAL_REFUSALS: Readonly<Record<string, string>> = {
  approval_expired: "This request has expired. Start again from your computer.",
  approval_used: "This request was already used.",
  approval_denied: "This request was declined in the browser.",
  invalid_approval: "This request cannot be completed from here. Start again from your computer.",
};

/** One poll of the claim. Needs the verifier on the options; never throws for a wait. */
export async function pollDesktopApproval(
  opts: CloudSignInOptions, approvalId: string,
): Promise<ApprovalPoll> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const verifier = trimmed(opts.verifier);
  if (!verifier || !APPROVAL_ID.test(approvalId)) {
    throw new CloudSignInError("approval_expired", 410, APPROVAL_REFUSALS.approval_expired!);
  }
  let res: Response;
  try {
    res = await fetchImpl(`${base}/auth/desktop-approval/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId, verifier, ...(opts.deviceKind ? { kind: opts.deviceKind } : {}) }),
    });
  } catch {
    return { status: "pending", retryAfterMs: 2_000, note: "unreachable" };
  }
  if (await busyAnswer(res)) return { status: "pending", retryAfterMs: retryAfterMs(res, 2_000), note: "busy" };
  const answer = await readJson(res);
  if (res.status === 202) {
    const wait = Number((answer as { retryAfterMs?: unknown } | null)?.retryAfterMs);
    return { status: "pending", retryAfterMs: clampWait(Number.isFinite(wait) ? wait : 2_000) };
  }
  if (res.ok) {
    const tokens = tokensFromResponse(answer, res);
    if (!tokens) {
      throw new CloudSignInError("no_session_returned", 502, "the hosted service approved the request and returned no session");
    }
    return { status: "approved", tokens };
  }
  if (res.status === 404) throw notOffered();
  if (res.status === 429) {
    throw new CloudSignInError(
      "rate_limited", 429, "too many attempts from this connection; give it a few minutes and try again",
    );
  }
  const refused = trimmed((answer as { error?: { code?: unknown } } | null)?.error?.code);
  const sentence = APPROVAL_REFUSALS[refused];
  opts.log?.("cloud_signin_refused", { status: res.status, reason: "the hosted service refused the approval claim" });
  if (sentence) throw new CloudSignInError(refused, 410, sentence);
  throw new CloudSignInError("hosted_refused", 502, `the hosted service answered HTTP ${res.status} to the approval claim`);
}
