/**
 * THE BEARER MANAGER — the served browser client's whole credential, in one small object.
 *
 * The desktop-host door is BEARER-ONLY BY CONSTRUCTION: it composes `allowCookieAuth: false`, its
 * zero-Set-Cookie census sweeps every route, and the redeem answers a token pair and nothing
 * else. So this client holds the pair itself and injects it through the one seam the shared
 * adapter already has (`HttpAdapterOptions.headers`) — there is no cookie code path in this file
 * because there is no cookie anywhere on this door for one to read.
 *
 * ── THE THREAT POSTURE, PLAINLY ──────────────────────────────────────────────────────────────
 *
 * The refresh token persists in `localStorage`; the access token lives in memory only. What that
 * storage IS: the browser of a phone the user owns, on an origin reachable only from inside
 * their own tailnet (`tailscale serve`, funnel forbidden), showing mail that lives on their own
 * computer. The classic argument against localStorage tokens — any script on the origin can read
 * them — is answered where it has to be, at the script boundary: the door serves every HTML
 * document under `script-src 'self'` with NO inline script and NO third-party source
 * (`apps/sidecar/src/host-static.ts`), so the only code that can run on this origin is the
 * artifact the desktop itself packaged. What remains is possession of an unlocked phone, which
 * is possession of its mail apps too — and the take-back for exactly that is the desktop
 * window's Devices pane: a revoke there kills this family's next request, which this manager
 * answers by ending the session locally (below) rather than by retrying into the refusal.
 *
 * ── ROTATION, AND WHAT A FAILURE MEANS ───────────────────────────────────────────────────────
 *
 * `/auth/refresh` on this door takes the body token (the native branch: strict reuse detection,
 * no concurrent grace) — so this manager rotates SERIALLY, single-flighted, because presenting
 * one refresh token twice IS the theft signal the server revokes families over. A 401 from the
 * refresh itself is therefore definitive in both directions: the family is revoked, reused-past,
 * or expired, and the only honest next state is signed-out — the pair is cleared and the
 * subscriber (the gate) lands the UI on `/pair` with a plain sentence. A NETWORK failure is
 * neither: the token was never presented, so nothing is cleared and the original 401 stands for
 * the caller's retry machinery to handle.
 */

/** The wire pair the redeem and the refresh both answer. */
export interface BearerTokens {
  accessToken: string;
  refreshToken: string;
}

/** Where the refresh token survives a page load. One key; the access token is never stored. */
export const REFRESH_STORAGE_KEY = "ohmail.host.refreshToken";

/** The same loose-init shape `bridge-fetch.ts` uses, satisfying both http-adapter declarations. */
type FetchLike = (url: string, init?: unknown) => Promise<Response>;

interface LooseInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** localStorage, or null where the browser refuses it (private mode edge cases). */
function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class BearerManager {
  private access: string | null = null;
  private refresh: string | null = null;
  private readonly storage: Storage | null;
  private readonly fetchImpl: FetchLike;
  /** The single flight — one rotation at a time, because a duplicate presentation reads as theft. */
  private rotating: Promise<boolean> | null = null;
  private readonly deadListeners = new Set<() => void>();

  constructor(opts: { storage?: Storage | null; fetchImpl?: FetchLike } = {}) {
    this.storage = opts.storage !== undefined ? opts.storage : defaultStorage();
    // BIND THE GLOBAL — the same illegal-invocation trap http-adapter.ts documents: a browser's
    // native fetch refuses any receiver that is not its own global.
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
    try {
      this.refresh = this.storage?.getItem(REFRESH_STORAGE_KEY) ?? null;
    } catch {
      this.refresh = null;
    }
  }

  /** Whether this browser holds a pairing at all — what the gate renders the shell on. */
  paired(): boolean {
    return this.refresh !== null;
  }

  /** Adopt a freshly minted pair — the redeem's answer, and every successful rotation's. */
  adopt(tokens: BearerTokens): void {
    this.access = tokens.accessToken;
    this.refresh = tokens.refreshToken;
    try {
      this.storage?.setItem(REFRESH_STORAGE_KEY, tokens.refreshToken);
    } catch {
      /* Storage refused: the session lives for this page load and the next one re-pairs. */
    }
  }

  /** The extra-headers seam's value — `HttpAdapterOptions.headers` calls this per request. */
  headers(): Record<string, string> {
    return this.access !== null ? { authorization: `Bearer ${this.access}` } : {};
  }

  /** End the session locally and tell the gate. Never throws. */
  private die(): void {
    this.access = null;
    this.refresh = null;
    try {
      this.storage?.removeItem(REFRESH_STORAGE_KEY);
    } catch {
      /* already gone */
    }
    for (const cb of [...this.deadListeners]) cb();
  }

  /** Subscribe to the session ending — revoked, reused-past, expired. Returns the unsubscribe. */
  onSessionDead(cb: () => void): () => void {
    this.deadListeners.add(cb);
    return () => this.deadListeners.delete(cb);
  }

  /**
   * Rotate the pair once, single-flighted. Resolves `true` when a fresh pair is held. A refusal
   * clears the session (see the header); a network failure clears nothing and resolves `false`.
   */
  private rotate(): Promise<boolean> {
    return (this.rotating ??= (async (): Promise<boolean> => {
      const presented = this.refresh;
      if (presented === null) return false;
      let res: Response;
      try {
        res = await this.fetchImpl("/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: presented }),
        });
      } catch {
        return false; // never presented — nothing to conclude, nothing to clear
      }
      if (res.ok) {
        try {
          const body = (await res.json()) as { tokens?: BearerTokens };
          if (body.tokens?.accessToken && body.tokens.refreshToken) {
            this.adopt(body.tokens);
            return true;
          }
        } catch {
          /* an OK answer this build cannot read — fall through to the refusal branch */
        }
      }
      // The server judged the presented token and said no. Definitive: sign out.
      this.die();
      return false;
    })().finally(() => {
      this.rotating = null;
    }));
  }

  /**
   * The transport `HttpAdapter` and every injected wire run on: the platform fetch with the
   * Authorization header stamped by the MANAGER on every attempt, plus ONE recovery — a 401
   * rotates the pair and replays the request once with the fresh token. One, not a loop: a
   * second 401 with a token minted milliseconds ago is a revocation, and the rotation path has
   * already decided what that means.
   *
   * The manager's header is merged LAST, so it wins over a caller's copy — the adapter's
   * extra-headers seam supplies the same value, except in the one moment that matters: a
   * rotation that landed between the adapter building its headers and this call, where the
   * seam's copy is the stale token and the manager's is the live one. Everything else the
   * caller set — the idempotency key included, so a replayed mutation lands on the server's
   * existing reservation — travels as it was.
   *
   * An arrow property so it can be handed to `HttpAdapterOptions.fetch` bare, receiverless.
   */
  fetch: FetchLike = async (url, init) => {
    const options = (init ?? {}) as LooseInit;
    const stamped = (): LooseInit => ({
      ...options,
      headers: { ...(options.headers ?? {}), ...this.headers() },
    });
    const first = await this.fetchImpl(url, stamped());
    if (first.status !== 401 || this.refresh === null) return first;
    if (!(await this.rotate())) return first;
    return this.fetchImpl(url, stamped());
  };

  /**
   * Sign this device out on purpose: tell the door (best-effort — the local clear must not hang
   * on an unreachable laptop), then clear. `/auth/logout` on this door revokes the session
   * server-side; `allDevices` stays step-up-gated there, so this can only ever end ITSELF.
   */
  async logout(): Promise<void> {
    try {
      await this.fetchImpl("/auth/logout", { method: "POST", headers: this.headers() });
    } catch {
      /* unreachable laptop — the server-side session ages out; this device is out now */
    }
    this.die();
  }
}
