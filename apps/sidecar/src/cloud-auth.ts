import { readFileSync, writeFileSync } from "node:fs";
import type { KeyProvider } from "@trafficflow/core/mail";
import type { Diagnostic } from "./log.js";

/**
 * THE CLOUD BEARER CLIENT — a plain `Authorization: Bearer` fetch against the hosted API, with a
 * single-flight refresh on 401 and a sealed-to-disk token store.
 *
 * ── WHY A NEW CLIENT AND NOT `HttpAdapter` ────────────────────────────────────────────────────
 *
 * `packages/client-engine`'s `HttpAdapter` is browser-shaped: it reads a `tf_csrf` cookie, echoes
 * an `X-CSRF-Token` on unsafe methods, and assumes an ambient cookie jar. None of that exists here
 * — this is a Node child talking to `api.ohmail.app` over `fetch`, authenticating with a token the
 * shell handed it, and the hosted API accepts a bearer on any host (`middleware.ts` prefers the
 * `Authorization` header, and a bearer caller is exempt from CSRF by construction). So the correct
 * client is the small one below: no cookie jar, no CSRF, one header.
 *
 * ── THE 401 REFRESH IS SINGLE-FLIGHT ──────────────────────────────────────────────────────────
 *
 * The pull loop can have several requests in flight (a `/sync` page and a `/messages/bodies` page
 * overlap across cycles), and an access token expiring makes all of them 401 at once. Refreshing
 * once per 401 would rotate the refresh-token family several times in a burst — the hosted API
 * treats a reused refresh token as a compromise signal and revokes the family, so a naive
 * per-request refresh would log the install out. {@link createCloudAuth} therefore shares ONE
 * in-flight refresh promise: the first 401 starts it, every concurrent 401 awaits the same one, and
 * all of them retry with the single rotated access token.
 *
 * `POST /auth/refresh` has a NATIVE body branch — `{ refreshToken }` in the body answers
 * `200 { tokens }` (`routes/core.ts`) — so no cookie is involved on this path either.
 */

export interface CloudTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Raised when the session cannot be renewed — the refresh token is spent, rotated past, or reused.
 *
 * `status` is the hosted API's own answer when there was one (401/403 — the DEFINITIVE refusals:
 * the family is revoked or rotated past, and no retry can renew it), and null when the renewal
 * died in transport (offline, a 5xx) — the case a later retry may well survive. The two must not
 * be conflated: one means "sign in again", the other means "wait".
 */
export class CloudAuthError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CloudAuthError";
    this.status = status;
  }
}

export interface CloudAuthConfig {
  /** e.g. `https://api.ohmail.app`. A trailing slash is trimmed. */
  baseUrl: string;
  /** The tokens this launch starts with — resolved store-wins-over-environment by the caller. */
  tokens: CloudTokens;
  /** Injected for tests; production uses the platform's own `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * THE TOKEN SEAL. When present, a rotated token pair is written back through this provider so a
   * later launch resumes without an environment token — the same store-wins precedence the IMAP
   * credential follows. Absent (no durable key) ⇒ tokens live in memory only and this launch's
   * environment token is the sole source, exactly as an IMAP install with no key re-reads its
   * password every launch.
   */
  keyProvider?: KeyProvider;
  /** Where the sealed token pair lives — `<dataDir>/cloud-tokens.seal`. Absent ⇒ no seal. */
  sealPath?: string;
  now?: () => Date;
  log?: Diagnostic;
  /**
   * The ceiling on any single request this module makes, refresh included. Absent ⇒
   * {@link REQUEST_DEADLINE_MS}. A caller that passes its own `signal` (the wake stream, whose
   * request is a held stream by design) is exempt — the deadline covers only requests nobody
   * else is bounding. Without one, a socket that goes half-open under a sleeping laptop parks
   * the pull on a read that resolves never, and the mirror wedges silently with every retry
   * timer waiting on the request that will not end.
   */
  requestDeadlineMs?: number;
  /**
   * Called (at most once) when the hosted API DEFINITIVELY refused to renew the session —
   * `POST /auth/refresh` answered 401/403, which is a revoked or rotated-past family, not a
   * blip. This is the engine's cue to surface "signed out" instead of serving a silently
   * frozen mirror behind a session that no longer exists — measured live: a revoked desktop
   * retried into 401s every five minutes for a day while its window showed week-old mail with
   * no notice anywhere. Fire-and-forget; the fetch that triggered it still returns its 401.
   */
  onSessionRefused?: () => void;
}

/** See {@link CloudAuthConfig.requestDeadlineMs}. Generous: a 500-row /sync page on a slow link. */
export const REQUEST_DEADLINE_MS = 90_000;

export interface CloudAuth {
  /** A bearer-authenticated fetch of `<baseUrl><path>`, with a single-flight refresh + retry on 401. */
  authedFetch(path: string, init?: RequestInit): Promise<Response>;
  /** The tokens currently in play, after any rotation. */
  currentTokens(): CloudTokens;
}

interface SealedTokenFile {
  ciphertext: string;
  keyVersion: number;
}

/**
 * Seal a token pair under the install's key and write it beside the cursor.
 *
 * The same envelope shape the IMAP credential uses (`mailbox_credentials.secret_enc`), so one
 * key ring wraps both. Mode `0600`: the file is a live credential and no other user may read it.
 */
export async function sealTokens(path: string, keyProvider: KeyProvider, tokens: CloudTokens): Promise<void> {
  const sealed = await keyProvider.encrypt(JSON.stringify(tokens));
  writeFileSync(
    path,
    JSON.stringify({ ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion } satisfies SealedTokenFile),
    { mode: 0o600 },
  );
}

/**
 * Read the sealed token pair, or null when there is none / it cannot be opened.
 *
 * A row this key cannot decrypt is `null`, not an error: the recovery is the same as the IMAP
 * side's — the shell supplies a fresh token in the environment and the launch re-seals it. Nothing
 * is logged from here; the thrown value comes from AES-GCM via a provider that also carries key
 * material, and the only fact the caller needs is "this key does not open that file".
 */
export async function loadSealedTokens(path: string, keyProvider: KeyProvider): Promise<CloudTokens | null> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const file = JSON.parse(raw) as SealedTokenFile;
    const plain = await keyProvider.decrypt(file.ciphertext, file.keyVersion);
    const tokens = JSON.parse(plain) as CloudTokens;
    if (typeof tokens.accessToken === "string" && typeof tokens.refreshToken === "string") return tokens;
    return null;
  } catch {
    return null;
  }
}

export function createCloudAuth(cfg: CloudAuthConfig): CloudAuth {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const deadlineMs = cfg.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  let tokens = cfg.tokens;
  /** The clone defence, single-flight: one in-flight refresh serves every concurrent 401. */
  let refreshing: Promise<CloudTokens> | null = null;
  /** The definitive-refusal latch: {@link CloudAuthConfig.onSessionRefused} fires at most once. */
  let sessionRefusedTold = false;

  /**
   * Bound a request that nobody else is bounding. A caller-supplied `signal` wins untouched —
   * the wake stream's held request is the deliberate case — and everything else gets the
   * deadline, which also covers the body read: aborting the signal rejects a parked `json()`,
   * so a half-open socket becomes a retryable error instead of a pull that never returns.
   */
  const withDeadline = (init: RequestInit | undefined): RequestInit | undefined => {
    if (init?.signal) return init;
    return { ...init, signal: AbortSignal.timeout(deadlineMs) };
  };

  const tellSessionRefused = (): void => {
    if (sessionRefusedTold) return;
    sessionRefusedTold = true;
    try {
      cfg.onSessionRefused?.();
    } catch {
      /* the cue must never break the fetch it rode in on */
    }
  };

  const persist = async (next: CloudTokens): Promise<void> => {
    if (!cfg.keyProvider || !cfg.sealPath) return;
    try {
      await sealTokens(cfg.sealPath, cfg.keyProvider, next);
    } catch (err) {
      cfg.log?.("cloud_refresh_failed", {
        err,
        reason: "the rotated session could not be sealed to disk; it is held in memory for this " +
          "launch and the next launch reads the environment token instead",
      });
    }
  };

  const refresh = async (): Promise<CloudTokens> => {
    const res = await fetchImpl(`${base}/auth/refresh`, withDeadline({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    }));
    if (res.status === 401 || res.status === 403) {
      // DEFINITIVE: the family is revoked, rotated past, or reused — no retry renews it.
      tellSessionRefused();
      throw new CloudAuthError(`the hosted API refused to renew the session (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) throw new CloudAuthError(`the hosted API could not renew the session right now (HTTP ${res.status})`);
    const wire = (await res.json()) as { tokens?: { accessToken?: string; refreshToken?: string } };
    const next = wire.tokens;
    if (!next?.accessToken || !next?.refreshToken) {
      throw new CloudAuthError("the refresh response carried no token pair");
    }
    tokens = { accessToken: next.accessToken, refreshToken: next.refreshToken };
    await persist(tokens);
    return tokens;
  };

  const refreshOnce = (): Promise<CloudTokens> => {
    // `??=` is the single-flight: the first caller installs the promise, everyone else awaits it,
    // and `finally` clears it so the NEXT expiry starts a fresh one.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const withBearer = (init: RequestInit | undefined, access: string): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${access}`);
    return { ...init, headers };
  };

  const authedFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const bounded = withDeadline(init);
    const res = await fetchImpl(`${base}${path}`, withBearer(bounded, tokens.accessToken));
    if (res.status !== 401) return res;
    let renewed: CloudTokens;
    try {
      renewed = await refreshOnce();
    } catch (err) {
      cfg.log?.("cloud_refresh_failed", {
        err,
        reason: "the session could not be renewed, so the mirror pauses until the shell supplies a " +
          "fresh token; nothing local is lost",
      });
      return res;
    }
    return fetchImpl(`${base}${path}`, withBearer(withDeadline(init), renewed.accessToken));
  };

  return { authedFetch, currentTokens: () => tokens };
}
