/**
 * THE BEARER MANAGER, ON REACT NATIVE — this app's whole credential, in one small object.
 *
 * A port of `apps/desktop/src/host-client/bearer.ts` SEMANTICS — single-flight rotation,
 * 401/403-only judgment, generation-bound replay, refusal-only sign-out — with two platform
 * substitutions, each of which is a *narrowing*, not a loosening:
 *
 *  · **The refresh token persists in the device keystore, not localStorage.** The vault this
 *    manager writes through is expo-secure-store (`servers-native.ts`): iOS Keychain / Android
 *    Keystore-encrypted storage, readable only by this app. That is a strictly stronger posture
 *    than the browser client's — there, any script on the origin can read localStorage and the
 *    defense is the door's CSP; here the OS itself is the boundary and no other app's code runs
 *    in this process. The access token stays in memory only, exactly as on desktop.
 *
 *  · **`navigator.locks` is DROPPED, and nothing replaces it, because nothing needs to.** The
 *    browser manager serializes rotation across TABS — several JS runtimes sharing one storage
 *    key, any of which may present the family's one refresh token. React Native is ONE JS
 *    runtime with no siblings: this object's in-memory token IS the family's head, so the
 *    desktop's storage re-read before presenting (documented in its header) has no stale-copy
 *    case to collapse, and the plain in-memory single-flight promise below is the complete
 *    serialization. There is no bare window left open — there was never a second presenter.
 *
 * Everything else is the desktop file's contract, kept deliberately:
 *
 *  · **Only a 401/403 from `/auth/refresh` is an authentication judgment.** A network failure,
 *    a 503 admission bound, a proxy hiccup — none of those judged the token, so none of them
 *    clears it. Clearing on anything less signs a working phone out because a laptop was busy.
 *  · **Recovery is bound to the token GENERATION.** A 401 stamped in an era a rotation already
 *    replaced restamps and replays without rotating again — rotating on stale refusals burns
 *    the fresh refresh token and pulls the rug from under requests carrying the fresh access
 *    token.
 *  · **One rotation, one replay.** A second 401 on a token minted milliseconds ago is a
 *    revocation, and the rotation path has already decided what that means.
 *
 * ── THE RESIDUAL, RESTATED FOR THIS PLATFORM ─────────────────────────────────────────────────
 *
 * A rotation whose RESPONSE is lost, or an app killed between the server committing a rotation
 * and the vault write landing, leaves the keystore holding a token the server has already
 * rotated past. The next launch presents it, the server reads strict reuse — correctly — and
 * revokes the family. The recovery is the product's own and it is one gesture: the phone lands
 * on the server picker and a single fresh QR scan re-pairs it. Bounded, visible, never a
 * silently wrong session. (`rotate()` awaits the vault write before resolving, so the window is
 * a kill *during* the keystore write, not the whole life of a fire-and-forget promise.)
 */

/** The wire pair the redeem and the refresh both answer — the desktop manager's exact shape. */
export interface BearerTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Where the refresh token survives an app kill. The profile store binds this to the active
 * server profile's slot in expo-secure-store; tests bind a recorder. `save` is awaited by the
 * rotation before it resolves (the residual above); `clear` is a refusal's take-back.
 */
export interface RefreshVault {
  save(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

/** The same loose-init fetch shape the engine's HttpAdapter and the desktop manager ride. */
export type FetchLike = (url: string, init?: unknown) => Promise<Response>;

interface LooseInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export class BearerManagerRN {
  private access: string | null;
  private refresh: string | null;
  /** Requests are ABSOLUTE on this platform — there is no served origin to be relative to. */
  private readonly origin: string;
  private readonly vault: RefreshVault;
  private readonly fetchImpl: FetchLike;
  /** The single flight — one rotation at a time, because a duplicate presentation reads as theft. */
  private rotating: Promise<boolean> | null = null;
  /**
   * Which token era a stamp belongs to — bumped on every adoption. A 401 carrying a stamp from
   * an era a rotation already replaced is STALE: the right recovery is a restamp, never another
   * rotation (the desktop manager's rule, kept verbatim).
   */
  private generation = 0;
  private readonly deadListeners = new Set<() => void>();

  constructor(opts: {
    /** `https://host` or plain `http://192.168…` — the door this credential belongs to. */
    origin: string;
    /** The pair the redeem just minted (fresh pairing), or null access on a cold app launch. */
    accessToken?: string | null;
    /** The persisted refresh token the profile store loaded — the family's head. */
    refreshToken: string | null;
    vault: RefreshVault;
    fetchImpl?: FetchLike;
  }) {
    this.origin = opts.origin.replace(/\/+$/, "");
    this.access = opts.accessToken ?? null;
    this.refresh = opts.refreshToken;
    this.vault = opts.vault;
    // Bind the global — RN's fetch is a plain function today, but the illegal-invocation trap
    // the desktop manager documents costs nothing to keep closed.
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  }

  /** Whether this manager holds a pairing at all — what the connection layer renders on. */
  paired(): boolean {
    return this.refresh !== null;
  }

  /**
   * Adopt a freshly minted pair — every successful rotation's answer. Memory is updated
   * synchronously (the next stamp must carry the new token); the returned promise is the vault
   * write, which `rotate()` awaits and other callers may ignore.
   */
  adopt(tokens: BearerTokens): Promise<void> {
    this.access = tokens.accessToken;
    this.refresh = tokens.refreshToken;
    this.generation++;
    return this.vault.save(tokens.refreshToken).catch(() => {
      /* A keystore refusal: the session lives until the next kill, then one scan re-pairs. */
    });
  }

  /** The extra-headers seam's value — `HttpAdapterOptions.headers` calls this per request. */
  headers(): Record<string, string> {
    return this.access !== null ? { authorization: `Bearer ${this.access}` } : {};
  }

  /**
   * End the session locally and tell the connection layer. Never throws, and IDEMPOTENT: the
   * routed logout below can die inside its own recovery (the refresh refused mid-logout), and
   * the funeral must not be held twice — one dead signal per session, whoever reports it.
   */
  private async die(): Promise<void> {
    if (this.access === null && this.refresh === null) return;
    this.access = null;
    this.refresh = null;
    await this.vault.clear().catch(() => {
      /* already gone, or the keystore refused — either way this session is over locally */
    });
    for (const cb of [...this.deadListeners]) cb();
  }

  /** Subscribe to the session ending — revoked, reused-past, expired. Returns the unsubscribe. */
  onSessionDead(cb: () => void): () => void {
    this.deadListeners.add(cb);
    return () => this.deadListeners.delete(cb);
  }

  /**
   * Rotate the pair once, single-flighted. Resolves `true` when a fresh pair is held. A REFUSAL
   * (401/403) clears the session; everything else — a network failure, a 503 admission bound,
   * any answer that is not an authentication judgment — clears nothing and resolves `false`.
   * No lock and no storage re-read around the critical section: one runtime, one presenter
   * (the header's second paragraph).
   */
  private rotate(): Promise<boolean> {
    return (this.rotating ??= (async (): Promise<boolean> => {
      const presented = this.refresh;
      if (presented === null) return false;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.origin}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: presented }),
        });
      } catch {
        // Never CONFIRMED presented — usually never sent at all. Nothing to conclude, nothing
        // cleared; the lost-response case is the documented residual in the header.
        return false;
      }
      if (res.ok) {
        try {
          const body = (await res.json()) as { tokens?: BearerTokens };
          if (body.tokens?.accessToken && body.tokens.refreshToken) {
            await this.adopt(body.tokens);
            return true;
          }
        } catch {
          /* an OK answer this build cannot read — the old token is consumed and the new pair is
             lost, so the stranded session falls through to the sign-out below, honestly */
        }
        await this.die();
        return false;
      }
      if (res.status === 401 || res.status === 403) {
        // The server judged the presented token and said no. Definitive: sign out.
        await this.die();
        return false;
      }
      // 503 host_busy, a 5xx, a proxy hiccup — the handler never judged the token. Keep the
      // pair; the caller gets its original 401 and the next episode tries again.
      return false;
    })().finally(() => {
      this.rotating = null;
    }));
  }

  /**
   * The transport the engine's `HttpAdapter` and the pairing probes run on: the platform fetch
   * with the Authorization header stamped by the MANAGER on every attempt, plus ONE recovery —
   * a 401 rotates the pair and replays the request once with the fresh token. The recovery is
   * bound to the GENERATION the refused attempt was stamped in; a stale 401 restamps and
   * replays WITHOUT rotating (the desktop header's cascade). The manager's header merges LAST,
   * so a rotation that landed between the adapter building its headers and this call wins over
   * the stale copy; everything else the caller set — the Idempotency-Key included — travels as
   * it was. An arrow property so it can be handed to `HttpAdapterOptions.fetch` bare.
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
   * Sign this device out on purpose: tell the door (best-effort — the local clear must not
   * hang on an unreachable server), then clear. `/auth/logout` revokes the session server-side;
   * `allDevices` stays step-up-gated there, so this can only ever end ITSELF.
   *
   * Routed through {@link fetch} — the manager's own recovery — NOT the raw transport:
   * `/auth/logout` is an authenticated route, and a cold launch or an aged-out access
   * token would send it bare, collect a silent 401, and clear the LOCAL half while the refresh
   * family stayed live server-side. Under the recovery, the 401 buys a fresh access token with
   * the stored refresh token and the replayed logout actually lands. If that recovery is itself
   * refused, the manager has already died honestly — `die()`'s idempotence makes the final
   * clear a no-op.
   */
  async logout(): Promise<boolean> {
    // ANSWERS WHETHER THE SERVER WAS ACTUALLY TOLD, and that is the whole reason for the return.
    // The local half happens either way — a device taking its own credential back must not be
    // blocked by an unreachable server — but the SERVER half is what revokes the session and,
    // on the hosted tier, takes this device's wake registration down with it. Reporting a forget
    // over a logout that never landed leaves both alive with nothing left to retry them.
    //
    // ── 401 COUNTS AS TOLD ONLY WHEN THE FAMILY WAS ACTUALLY JUDGED ───────────────────────
    //
    // A bare 401 is not evidence on its own. `fetch` answers the ORIGINAL 401 when its one
    // recovery could not run — a `/auth/refresh` that 500s, or a dead network — and the refresh
    // token is then still live, the hosted session still open, its push row still dialling. So
    // this read a transient refresh outage as a completed revocation and let a forget report
    // both take-backs done.
    //
    // What separates them is what the manager DID: a refusal is an authentication judgment and
    // clears the credential (`rotate` → `die`), while a transient failure clears nothing. So a
    // 401 with no credential left is "already gone"; a 401 with the credential still held is a
    // logout that did not land. Anything else — a 500, a 503, a dead network — did not land.
    let told = true;
    if (this.access !== null || this.refresh !== null) {
      told = false;
      try {
        const res = await this.fetch(`${this.origin}/auth/logout`, { method: "POST" });
        const judged = this.refresh === null;
        told = (res.status >= 200 && res.status < 300) || (res.status === 401 && judged);
      } catch {
        /* unreachable server — the server-side session ages out; this device is out now */
      }
    }
    await this.die();
    return told;
  }
}
