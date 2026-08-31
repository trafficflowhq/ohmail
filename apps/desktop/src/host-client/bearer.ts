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
 * one refresh token twice IS the theft signal the server revokes families over. Three findings
 * from the review sharpened what that means in practice:
 *
 *  · **Only a 401/403 from the refresh is an authentication judgment.** A `503 host_busy` is
 *    the LISTENER's admission bound refusing before the handler ever read the token; clearing
 *    the pair over it signed a working phone out because the laptop was busy. Anything that is
 *    not an explicit refusal keeps the pair and returns the caller its original 401.
 *  · **Storage is the family's shared head.** Tabs on this origin share the refresh token, so a
 *    manager whose in-memory copy has gone stale (another tab rotated) must re-read storage and
 *    present the FRESHEST token, never its own consumed copy — and the whole rotation runs
 *    under `navigator.locks` where the browser has it, so two tabs' simultaneous expiries
 *    serialize instead of double-presenting. (Without the Locks API the re-read narrows the
 *    window; it cannot close it.)
 *  · **Recovery is bound to the token GENERATION.** A 401 judged against a stamp an earlier
 *    rotation already replaced must restamp and replay, not rotate again — rotating on stale
 *    refusals burned the fresh refresh token for nothing and invalidated the fresh access token
 *    under the requests already carrying it.
 *
 * ── THE RESIDUAL THIS CLIENT CANNOT CLOSE, STATED RATHER THAN IMPLIED ────────────────────────
 *
 * A rotation whose RESPONSE is lost (the request reached the engine, the connection died before
 * the answer) leaves the server holding a committed rotation this client never learned about.
 * The next recovery re-presents the old token — which is now, correctly, the reuse signal — and
 * the family is revoked. The wire cannot distinguish that from theft without a grace this
 * door's native branch deliberately refuses (the shared lifecycle machinery is frozen; the
 * cookie surface's `concurrentGrace` exists for exactly this and is a different trust model).
 * The recovery is the product's own: the phone lands on `/pair` and one fresh QR scan re-pairs
 * it. Bounded, visible, and honest — never a silently wrong session.
 */

/** The wire pair the redeem and the refresh both answer. */
export interface BearerTokens {
  accessToken: string;
  refreshToken: string;
}

/** Where the refresh token survives a page load. One key; the access token is never stored. */
export const REFRESH_STORAGE_KEY = "ohmail.host.refreshToken";

/**
 * WHICH PAIRING THIS BROWSER'S SCRATCH SPACE BELONGS TO — a random id, and never a credential.
 *
 * The shared shell keeps four things in `localStorage` per account: the compose scratch buffer,
 * the durable send lanes, the Screener's intent journal and the Search order. On a cookie-bearing
 * door the account id partitions them. This door mints no cookie by construction, so all four
 * used to land on one key shared by every pairing this origin has ever held — and a host door's
 * origin is an address on a tailnet or a LAN, which is reusable: a laptop paired to one computer,
 * unpaired, and paired to another at the same address would restore the first computer's
 * unfinished message into the second one's composer.
 *
 * This is NOT the mirror's owner id and does not try to be. The mirror on this door is in memory
 * and rebuilt per page load, exactly because naming a persistent one needs a server-CONFIRMED id
 * (this file's own header, and `engine.tsx`). Partitioning scratch space is a weaker question: all
 * it has to guarantee is that two pairings never collide, and a random id per pairing gives that
 * without confirming anything. It authorises nothing, proves nothing, and a forged value gets
 * whoever forged it an empty partition of their own.
 *
 * Minted on a REDEEM and kept across every rotation — a rotated token is the same pairing, and
 * re-minting per rotation would throw away somebody's half-written message every time the access
 * token aged out. Cleared with the refresh token when the session dies.
 */
export const PAIR_SCOPE_STORAGE_KEY = "ohmail.host.pairScope";

/** An id-shaped random scope. `randomUUID` where the platform has it, 128 bits of hex otherwise. */
function mintPairScope(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // No crypto at all is a browser this door cannot serve anyway (the redeem is HTTPS-or-tailnet
  // only). A time-and-random id still partitions two pairings, which is this value's whole job.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

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
  /**
   * Which token era a stamp belongs to — bumped on every adoption. A 401 carrying a stamp from
   * an era a rotation already replaced is STALE: the right recovery is a restamp, never another
   * rotation (see the header's third finding).
   */
  private generation = 0;
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

  /**
   * Adopt a freshly minted pair — the redeem's answer, and every successful rotation's.
   *
   * `fresh` says this is a NEW PAIRING rather than a rotation of the one already held, and it is
   * the only thing that re-mints {@link PAIR_SCOPE_STORAGE_KEY}. The redeem passes it; the
   * rotation inside `rotate()` does not, because a rotated token is the same pairing and a new
   * scope there would discard the user's half-written message every time an access token aged
   * out. See that constant's header for what the scope is and is not.
   */
  adopt(tokens: BearerTokens, opts: { fresh?: boolean } = {}): void {
    this.access = tokens.accessToken;
    this.refresh = tokens.refreshToken;
    this.generation++;
    try {
      this.storage?.setItem(REFRESH_STORAGE_KEY, tokens.refreshToken);
      // A pairing with no scope stored is also a fresh one: an install upgraded from a bundle
      // that predates this key holds a refresh token and nothing else, and leaving it unscoped
      // would leave it on the shared partition this exists to end.
      if (opts.fresh === true || this.storage?.getItem(PAIR_SCOPE_STORAGE_KEY) == null) {
        this.storage?.setItem(PAIR_SCOPE_STORAGE_KEY, mintPairScope());
      }
    } catch {
      /* Storage refused: the session lives for this page load and the next one re-pairs. */
    }
  }

  /**
   * WHICH PAIRING'S SCRATCH SPACE THIS PAGE IS USING, or `null` when there is no pairing.
   *
   * Read from storage on every call rather than cached: `adopt` and `die` both write it, and a
   * second tab on this origin can change it under this one. `null` whenever the browser refuses
   * storage — a surface that cannot persist a scope also cannot persist the things it scopes.
   */
  pairScope(): string | null {
    if (this.refresh === null) return null;
    try {
      return this.storage?.getItem(PAIR_SCOPE_STORAGE_KEY) ?? null;
    } catch {
      return null;
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
      // The scratch space this pairing owned goes with it. The next pairing on this origin mints
      // a new scope and therefore cannot read what this one left — which is the whole point of
      // the key. The VALUES under the old scope are unreachable rather than deleted; the shared
      // shell's own sign-out sweep is what clears them by prefix.
      this.storage?.removeItem(PAIR_SCOPE_STORAGE_KEY);
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
   * Rotate the pair once, single-flighted, under the origin-wide lock where the browser has one.
   * Resolves `true` when a fresh pair is held. A REFUSAL (401/403) clears the session (see the
   * header); everything else — a network failure, the admission bound's 503, any answer that is
   * not an authentication judgment — clears nothing and resolves `false`.
   */
  private rotate(): Promise<boolean> {
    return (this.rotating ??= this.underLock(async (): Promise<boolean> => {
      // THE FRESHEST TOKEN WINS — see the header's second finding. Another tab may have rotated
      // while this manager sat idle (or while this call waited for the lock); its rotation wrote
      // storage, and presenting this manager's stale copy would be the reuse signal. Re-read
      // under the lock, adopt the head, present that.
      try {
        const stored = this.storage?.getItem(REFRESH_STORAGE_KEY) ?? null;
        if (stored !== null && stored !== this.refresh) this.refresh = stored;
      } catch {
        /* storage refused — the in-memory copy is all there is */
      }
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
        // Never CONFIRMED presented. Usually never sent at all; the lost-response case is the
        // documented residual in the header — nothing this side can conclude, nothing cleared.
        return false;
      }
      if (res.ok) {
        try {
          const body = (await res.json()) as { tokens?: BearerTokens };
          if (body.tokens?.accessToken && body.tokens.refreshToken) {
            this.adopt(body.tokens);
            return true;
          }
        } catch {
          /* an OK answer this build cannot read — the old token is consumed and the new pair is
             lost, so the stranded session falls through to the sign-out below, honestly */
        }
        this.die();
        return false;
      }
      if (res.status === 401 || res.status === 403) {
        // The server judged the presented token and said no. Definitive: sign out.
        this.die();
        return false;
      }
      // 503 host_busy, a 5xx, a proxy hiccup — the handler never judged the token. Keep the
      // pair; the caller gets its original 401 and the next episode tries again.
      return false;
    }).finally(() => {
      this.rotating = null;
    }));
  }

  /**
   * The origin-wide rotation lock, where the platform has one. `navigator.locks` serializes the
   * critical section across TABS — two simultaneous expiries then present one token once each in
   * sequence, the second finding the first's result in storage. Browsers without the API (and
   * the test environment) run the section bare: the storage re-read above still collapses the
   * common stale-copy case, and the residual double-present window is stated in the header.
   */
  private underLock(section: () => Promise<boolean>): Promise<boolean> {
    const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks;
    if (locks && typeof locks.request === "function") {
      return (locks as { request: (name: string, cb: () => Promise<boolean>) => Promise<boolean> })
        .request("ohmail.host.rotate", section);
    }
    return section();
  }

  /**
   * The transport `HttpAdapter` and every injected wire run on: the platform fetch with the
   * Authorization header stamped by the MANAGER on every attempt, plus ONE recovery — a 401
   * rotates the pair and replays the request once with the fresh token. One, not a loop: a
   * second 401 with a token minted milliseconds ago is a revocation, and the rotation path has
   * already decided what that means.
   *
   * The recovery is bound to the GENERATION the refused attempt was stamped in. A 401 whose
   * stamp an earlier rotation already replaced is stale evidence — it judged the old token, not
   * the current one — so it restamps and replays WITHOUT rotating: rotating on stale refusals is
   * the cascade the review named (each stale 401 burning the fresh refresh token and pulling the
   * rug from under the requests already carrying the fresh access token).
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
    const stampedIn = this.generation;
    const first = await this.fetchImpl(url, stamped());
    if (first.status !== 401 || this.refresh === null) return first;
    if (this.generation === stampedIn && !(await this.rotate())) return first;
    // Either the rotation minted a fresh pair, or one had ALREADY happened since this request
    // was stamped — both mean the same thing: replay once under the current generation.
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
