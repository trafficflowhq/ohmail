import { createHash, randomBytes } from "node:crypto";

import type { CloudTokens } from "./cloud-auth.js";
import type { Diagnostic } from "./log.js";

/**
 * SIGNING IN TO THE HOSTED ACCOUNT, from a Cloud-mode install that has no session yet.
 *
 * ── WHY THIS EXISTS, AND WHAT IT REPLACES ─────────────────────────────────────────────────────
 *
 * Cloud mode used to be reachable only by a launch that already carried a token pair in its
 * environment: the shell had to obtain one somewhere else and hand it over. There is nowhere else.
 * A person who installs the app and picks the hosted door has an email address, a password and a
 * six-digit code, and this module is what turns those three into the pair the mirror pulls with.
 *
 * ── AND THE OTHER WAY IN: A CODE FROM THE BROWSER ─────────────────────────────────────────────
 *
 * Typing a password into a native window is the one place a person cannot check an address bar,
 * so there is a second path and it is one request: the browser signs in at `ohmail.app`, mints a
 * one-use handoff code (`POST /auth/desktop-link`, behind a step-up gate), and this exchanges it
 * at `POST /auth/desktop-claim` for the same pair the password path ends with. The code is worth
 * a session for about two minutes and only once. The password path stays the default; this is
 * the alternative, not the replacement, because it needs a browser signed in to the account and
 * that is not always where somebody is standing.
 *
 * ── AND WHY THAT CODE NO LONGER HAS TO BE RETYPED ─────────────────────────────────────────────
 *
 * A code a person carries in their fingers is safe because nothing but a person can read it off a
 * screen. Handing it back over a URL scheme is not: `ohmail://` is claimed by whichever program on
 * the machine registered it, and nothing authenticates that. So before the browser is opened this
 * process invents a VERIFIER — 32 random bytes, base64url, 43 characters — keeps it in memory, and
 * publishes only `sha256(verifier)` as the CHALLENGE that travels in the page's URL. The account
 * binds the code it mints to that digest, and refuses to spend it for any caller that cannot
 * produce the verifier the digest was made from. A program that intercepts the scheme therefore
 * receives a code it cannot use, and a failed attempt does not consume it either.
 *
 * Three properties of the verifier are load-bearing and each one is a rule about this file:
 *
 *  · it is generated HERE and never leaves this process except as the claim's own field. It is
 *    not a parameter of the sign-in body, so no caller over the bridge can supply one — the
 *    engine uses the verifier it is holding or none at all;
 *  · it is never a log field. The diagnostics here carry a step name and an HTTP status, and
 *    nothing that could be exchanged for a session;
 *  · it dies with the process. That is not a defect to work around: a code minted against a
 *    challenge whose verifier no longer exists is a code nobody can spend, which is exactly the
 *    property that makes it safe to send over a scheme in the first place.
 *
 * The retype path is UNCHANGED and coexists with it. A code minted with no challenge is claimed
 * with no verifier, exactly as it always was; the hosted side decides which of the two it is
 * looking at from the row, at mint, and never afterwards.
 *
 * ── THE TWO STEPS, AND THE FIELD NAME THAT IS NOT THE ONE YOU EXPECT ──────────────────────────
 *
 *  1. `POST /auth/login` `{email, password}` → **200** `{status: "twofa_required", loginToken}`.
 *     A 200 here is NOT a session; it is a challenge. Treating it as success is the mistake this
 *     comment exists to prevent.
 *  2. `POST /auth/2fa/totp/verify` `{loginToken, code}` → the session. The parameter is
 *     `loginToken` and not `challengeToken`.
 *
 * ── WHERE THE TOKENS ARE, AND WHY BOTH PLACES HAVE TO BE READ ─────────────────────────────────
 *
 * The hosted API decides per HOST whether it speaks cookies. On a cookie host the session is
 * established with `Set-Cookie` and the token pair is STRIPPED from the JSON body; on a bearer-only
 * host the cookies are omitted and the pair stays in the body. Both are the same session — only the
 * transport differs — so this reads the body first and falls back to the cookies. Reading only one
 * would work against one deployment and silently return "no session" against the other.
 *
 * `tf_session` carries the access token verbatim and `tf_refresh` the refresh token verbatim, so
 * lifting them needs no decoding. `Set-Cookie` must be read with `getSetCookie()`: iterating a
 * `Headers` joins repeated names with `", "`, and a cookie's own `Expires=Wed, 09 Jun 2027` contains
 * a comma, so the joined string cannot be split back apart.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT REACH ──────────────────────────────────────────────
 *
 * No IMAP adapter, no organizer lease, no sync loop — it is `fetch` and JSON and nothing else. It
 * is imported from `cloud-engine.ts`, so the structural census over that file's graph covers it:
 * the sign-in surface cannot become a door into the organizer.
 *
 * ── AND WHAT IT NEVER SAYS OUT LOUD ───────────────────────────────────────────────────────────
 *
 * The address, the password and the code are arguments and never log fields. The diagnostics here
 * carry a step name and an HTTP status, which is everything an operator needs to tell "the server
 * refused" apart from "the server was not there".
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
 * TWO SHAPES, and `handoffCode` is what selects between them.
 *
 *  · **the password path** — `{email, password, totp}`, the two-step hosted sign-in described
 *    above. Still the default the app offers.
 *  · **the browser path** — `{handoffCode}` alone. The person signed in on ohmail.app, that page
 *    minted a one-use code, and they retyped it here. One request, no password in this process
 *    at any point.
 *
 * Every field is optional because this arrives as JSON over the bridge and a type is not a
 * validation. {@link cloudSignIn} decides which branch it is on and refuses a request that
 * satisfies neither, rather than trusting the shape it was handed.
 */
export interface CloudSignInRequest {
  email?: string;
  password?: string;
  /** The six digits from the authenticator app. */
  totp?: string;
  /** The code shown by `ohmail.app/link-desktop`. Present ⇒ the other three are not read. */
  handoffCode?: string;
}

export interface CloudSignInOptions {
  /** e.g. `https://api.ohmail.app`. A trailing slash is trimmed. */
  baseUrl: string;
  /** Injected for tests; production dials the real hosted API. */
  fetchImpl?: typeof fetch;
  log?: Diagnostic;
  /**
   * The PKCE verifier this install is holding, if it minted one before opening the browser.
   *
   * ON THE OPTIONS AND NOT ON THE REQUEST, and that placement is the whole of the rule. The
   * request is JSON that arrived over the bridge; the options are composed by the engine from its
   * own memory. Putting the verifier on the request shape would mean any caller that can reach
   * `POST /cloud/signin` could name the verifier a code is claimed with — which is precisely the
   * capability the binding exists to withhold from whoever intercepted the scheme.
   *
   * Absent is not a lesser call. It is the retype flow, where the code was minted unbound and is
   * claimed exactly as it was before any of this existed.
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
  for (const cookie of cookies) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "") continue;
    if (name === "tf_session") accessToken = value;
    else if (name === "tf_refresh") refreshToken = value;
  }
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

/** The token pair a session response carries, from whichever of the two places holds it. */
function tokensFromResponse(body: unknown, res: Response): CloudTokens | null {
  const wire = (body as { tokens?: { accessToken?: unknown; refreshToken?: unknown } } | null)?.tokens;
  if (typeof wire?.accessToken === "string" && typeof wire?.refreshToken === "string") {
    return { accessToken: wire.accessToken, refreshToken: wire.refreshToken };
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
    const verifier = trimmed(opts.verifier);
    const res = await post(
      "/auth/desktop-claim",
      verifier ? { code: handoff, verifier } : { code: handoff },
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
  const verifyRes = await post("/auth/2fa/totp/verify", { loginToken, code }, "verify");
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
