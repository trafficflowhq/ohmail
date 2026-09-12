/**
 * THE BEARER MANAGER — the served browser client's whole credential, in one small object. The
 * desktop-host door is BEARER-ONLY BY CONSTRUCTION (`allowCookieAuth: false`, a
 * zero-Set-Cookie census, a redeem answering a token pair), so this client holds the pair and
 * injects it through `HttpAdapterOptions.headers` — no cookie code path exists because no
 * cookie exists. The refresh token persists in `localStorage`, the access token in memory:
 * the classic script-can-read-it argument is answered at the script boundary — every document
 * is served `script-src 'self'`, no inline script (`apps/sidecar/src/host-static.ts`) — and
 * what remains is possession of an unlocked phone, whose take-back is the desktop's Devices
 */

/*
 * pane: a revoke kills the next request, which this manager answers by ending the session.
 */

/*
 * ROTATION: `/auth/refresh` takes the body token (strict reuse detection, no concurrent
 * grace), so this manager rotates SERIALLY, single-flighted — presenting one refresh token
 * twice IS the theft signal. Three sharpenings: only a 401/403 from the refresh is an
 * authentication judgment (`503 host_busy` is the listener's admission bound — clearing over
 * it signed a working phone out because the laptop was busy); storage is the family's shared
 * head (a stale in-memory copy re-reads storage and presents the FRESHEST token, the whole
 * rotation under `navigator.locks` where the browser has it — without the Locks API the
 * re-read narrows the double-present window, it cannot close it); recovery is bound to the token
 * GENERATION (a 401 judged against a replaced stamp restamps and replays, never re-rotates).
 */

/*
 * The residual this client cannot close: a rotation whose RESPONSE is lost leaves the server
 * committed and the next recovery re-presents the old token — the family is revoked, the
 * phone lands on `/pair`, and one fresh QR scan re-pairs it. Bounded, visible, honest.
 */

import { storageDoor, type StorageDoor } from "@ohmail/client-engine/durable";

/** The wire pair the redeem and the refresh both answer. */
export interface BearerTokens {
  accessToken: string;
  refreshToken: string;
}

/** Where the refresh token survives a page load. One key; the access token is never stored. */
export const REFRESH_STORAGE_KEY = "ohmail.host.refreshToken";

/**
 * WHICH PAIRING THIS BROWSER'S SCRATCH SPACE BELONGS TO — a random id, never a credential.
 * The shared shell keeps four things in `localStorage` per account; this door mints no
 * cookie, so all four used to land on one key shared by every pairing this origin ever held —
 * and a host door's origin is a reusable address, so a laptop paired to a second computer at
 * the first one's address restored the first computer's unfinished message. NOT the mirror's
 * owner id: that needs a server-CONFIRMED id (`engine.tsx`); partitioning scratch only has to
 * keep two pairings from colliding, and a forged value earns an empty partition. Minted on a
 * REDEEM and kept across rotations — a rotated token is the same pairing, and re-minting
 */

/*
 * would throw away a half-written message every time the access token aged. Cleared with the
 * refresh token when the session dies.
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
  /**
   * THE DOOR OVER THIS PAGE'S JAR — the jar stays injectable (the tests hand one in), the ANSWER
   * does not. A refused write to the pairing's refresh token or scope used to be swallowed here;
   * it now raises the same once-per-session notice the shared shell already renders, because a
   * host client that cannot keep its credential re-pairs on the next load and the person should
   * be told before it happens rather than after.
   */
  private readonly door: StorageDoor;
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
    this.door = storageDoor(
      opts.storage !== undefined ? opts.storage : defaultStorage(),
      "host-pair",
    );
    // BIND THE GLOBAL — the same illegal-invocation trap http-adapter.ts documents: a browser's
    // native fetch refuses any receiver that is not its own global.
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
    this.refresh = this.door.get(REFRESH_STORAGE_KEY);
    /**
     * A PAIRING THAT EXISTS MUST HAVE A SCOPE BEFORE THE FIRST RENDER, NOT AT ITS FIRST
     * ADOPT. The upgrade arm lived in {@link adopt}, which runs on a redeem or a rotation —
     * neither has happened when a browser already holding a refresh token loads this build
     * for the first time. `paired()` was true while `pairScope()` was null, so `HostGate` set
     * the storage owner to `null` and mounted the shell on the old un-owned `…local`
     * partition — the previous pairing's compose buffer, read by the shell's own effects
     * before any request could 401. Minting here closes the window: the manager is
     * constructed before anything renders (`main.tsx` builds it above `createRoot`).
     */
    this.ensureScope();
    this.scopeAtStart = this.readScope();
  }

  /**
   * The pairing this manager belongs to, remembered at construction.
   *
   * `rotate` re-reads the shared refresh token deliberately — another TAB may have rotated the
   * SAME pairing while this one sat idle, and presenting a consumed token is the theft signal. But
   * "the stored token changed" has two causes and only one of them is that: the other is a fresh
   * `/pair` redeem, which points this origin at a DIFFERENT computer. Adopting there made a stale
   * tab authenticate as the new account while still rendering the old one's mail. The scope is
   * what tells the two apart, and it exists now.
   */
  private scopeAtStart: string | null;

  private readScope(): string | null {
    return this.door.get(PAIR_SCOPE_STORAGE_KEY);
  }

  /** Give the held pairing a scope if it has none. No pairing, no scope — and never a re-mint. */
  private ensureScope(): void {
    if (this.refresh === null) return;
    // A refused write leaves `pairScope()` answering null and the shell partitioning as un-owned,
    // exactly as before — and now the door has said so.
    if (this.door.get(PAIR_SCOPE_STORAGE_KEY) == null) {
      this.door.set(PAIR_SCOPE_STORAGE_KEY, mintPairScope());
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
    // Storage refused answers "lost" from the door and raises the notice; the session then lives
    // for this page load and the next one re-pairs, which is what the door exists to say out loud.
    this.door.set(REFRESH_STORAGE_KEY, tokens.refreshToken);
    // A REDEEM re-mints; a rotation does not. The upgrade case is NOT handled here — it is
    // handled in the constructor, because by the time `adopt` runs the shell has already
    // mounted and read a partition. See `ensureScope`.
    if (opts.fresh === true) {
      this.door.set(PAIR_SCOPE_STORAGE_KEY, mintPairScope());
    } else {
      this.ensureScope();
    }
    // THIS manager now belongs to whatever scope is stored — it either minted it or confirmed
    // it. Without this line the check in `rotate` would fire on the manager's own first adopt
    // (constructed before any pairing existed, so it started with none) and end a session that
    // nothing was wrong with.
    this.scopeAtStart = this.readScope();
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
    return this.door.get(PAIR_SCOPE_STORAGE_KEY);
  }

  /** The extra-headers seam's value — `HttpAdapterOptions.headers` calls this per request. */
  headers(): Record<string, string> {
    return this.access !== null ? { authorization: `Bearer ${this.access}` } : {};
  }

  /** End the session locally and tell the gate. Never throws. */
  private die(): void {
    this.access = null;
    this.refresh = null;
    this.door.remove(REFRESH_STORAGE_KEY);
    // The scratch space this pairing owned goes with it. The next pairing on this origin mints
    // a new scope and therefore cannot read what this one left — which is the whole point of
    // the key. The VALUES under the old scope are unreachable rather than deleted; the shared
    // shell's own sign-out sweep is what clears them by prefix.
    this.door.remove(PAIR_SCOPE_STORAGE_KEY);
    for (const cb of [...this.deadListeners]) cb();
  }

  /**
   * END THIS TAB'S SESSION WITHOUT TOUCHING THE SHARED CREDENTIAL — the whole difference from
   * `die()`. `die()` clears `localStorage`, correct when the SESSION is over (revoked,
   * reused-past, signed out) and exactly wrong for `rotate`'s case above, where storage holds
   * the SUCCESSOR's credential because another tab re-paired this origin: `die()` there
   * deletes the new pairing's refresh token and scope — the guard against a stale tab acting
   * as the new account would destroy the new account's session, from a background rotation,
   * with no user act. So this drops the in-memory pair, tells the gate, leaves the jar alone.
   */
  private standDown(): void {
    this.access = null;
    this.refresh = null;
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
      // A DIFFERENT PAIRING IS NOT A ROTATION OF THIS ONE. If the scope has moved since this
      // manager was built, the origin has been re-paired to another computer: this tab's session
      // is over, and adopting the successor's token would make it act as an account whose mail it
      // is not showing. Ending it is the honest answer, and it is the same one the gate already
      // renders for a revoked family.
      if (this.readScope() !== this.scopeAtStart) {
        this.standDown();
        return false;
      }
      // A refused read answers null from the door — the in-memory copy is all there is.
      const stored = this.door.get(REFRESH_STORAGE_KEY);
      if (stored !== null && stored !== this.refresh) this.refresh = stored;
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
   * rotates the pair and replays once. One, not a loop: a second 401 on a token minted
   * milliseconds ago is a revocation. The recovery is bound to the GENERATION the refused
   * attempt was stamped in: a 401 whose stamp an earlier rotation replaced restamps and
   * replays WITHOUT rotating — rotating on stale refusals burns the fresh refresh token and
   * invalidates the fresh access token under requests already carrying it. The manager's
   * header merges LAST, so a rotation landing between the adapter building its headers and
   */

  /*
   * this call still sends the live token; everything else the caller set (the idempotency key
   * included) travels as it was. An arrow property so it can be handed bare, receiverless.
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
