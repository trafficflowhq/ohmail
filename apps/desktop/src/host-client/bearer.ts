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
 * ROTATION: `/auth/refresh` takes the body token (strict reuse detection, no concurrent grace), so
 * this manager rotates SERIALLY, single-flighted — presenting one refresh token twice IS the theft
 * signal. Three sharpenings: only the door's named refusal is a judgment (`readRefreshAnswer`; `503
 * host_busy` is the listener's admission bound — clearing over it signed a working phone out); storage
 * is the family's shared head (a stale in-memory copy re-reads storage and presents the FRESHEST
 * token, the whole rotation under `navigator.locks` — without it the re-read narrows the
 * double-present window, it cannot close it); recovery is bound to the token GENERATION (a 401 judged
 * against a replaced stamp restamps and replays, never re-rotates).
 */

/*
 * A rotation whose RESPONSE is lost used to end the pairing: strict reuse read the retry of the
 * retained token as theft, the browser landed on `/pair`, and one fresh QR scan re-paired it.
 * Every attempt now carries a name, committed to IndexedDB and written to the jar BEFORE it
 * submits, and owed for the token it went out with until the pairing ends. A retry, a reload, or a
 * restart whose jar lost its last batch (localStorage reaches disk in batches, so a crash can drop
 * the name and the answer's token together) presents that token under the same name, so the
 * server can tell a retry from a replay. What remains is the phone's own bounded residual, stated
 * there: an attacker holding a whole captured request can replay it inside the presented token's
 * window, and the legitimate retry rotates straight past it.
 */

import { isCredentialRefusal, isSessionRefusal, readRefreshAnswer } from "@ohmail/client-engine";
import { durableIdbCommit, storageDoor, type StorageDoor } from "@ohmail/client-engine/durable";

/** The wire pair the redeem and the refresh both answer. */
export interface BearerTokens {
  accessToken: string;
  refreshToken: string;
  /** The access window in seconds, where the issuing door stated one. Held in memory only. */
  expiresIn?: number;
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

/**
 * THE NAME OF A ROTATION THIS ORIGIN SUBMITTED AND NEVER ADOPTED — the phone's field
 * (`apps/mobile/src/net/bearer.ts`), the phone's semantics, three clients and one contract. A bare
 * id, written before the request goes and removed by the adoption that answers it, as every shipped
 * build writes it: a tab still running one sends whatever this key holds as its name.
 */
export const REFRESH_ATTEMPT_STORAGE_KEY = "ohmail.host.refreshAttempt";

/**
 * THE NAME, OWED FOR THE TOKEN IT WENT OUT WITH: `{ id, mark, at }`, never with a token, kept past
 * the adoption. A crash can leave the jar on a token a rotation already spent, and only the name
 * that spent it brings it back: this door honours that name for the token's whole life and sweeps
 * the family under any other. Older builds never read this key.
 */
export const OWED_ATTEMPT_STORAGE_KEY = "ohmail.host.refreshAttemptOwed";

/**
 * THE RECORD'S DURABLE COPY: IndexedDB commits it strictly before the request leaves. Each step
 * waits at most {@link ATTEMPT_STORE_BUDGET_MS}; an IndexedDB that is missing, refusing or hung
 * leaves the jar's copies alone, as before, and never holds a rotation back.
 */
export const REFRESH_ATTEMPT_DB = "ohmail-host-session";
const ATTEMPT_STORE = "attempt";
const OWED_KEY = "owed";
export const ATTEMPT_STORE_BUDGET_MS = 1_500;

/**
 * THE SIGN-OUTS THE COMPUTER WAS NOT TOLD: `[{ token, at }]`, a refresh token each — the only thing
 * the refresh door's sign-out accepts. Written by a sign-out the door did not confirm, sent to
 * `/auth/refresh/logout` at the next chance and never presented for a renewal; the constructor and
 * `paired()` never read it. At most {@link OWED_SIGN_OUTS_MAX}, each for {@link OWED_SIGN_OUT_MAX_AGE_MS}.
 */
export const OWED_SIGN_OUTS_STORAGE_KEY = "ohmail.host.signOutsOwed";
const OWED_SIGN_OUTS_MAX = 4;
const OWED_SIGN_OUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** The retry while a sign-out is owed: from half a minute, doubling, at most a quarter of an hour. */
const OWED_RETRY_FIRST_MS = 30_000;
const OWED_RETRY_MAX_MS = 15 * 60_000;
/** How long one sign-out's dial may take, a press's or an owed one's, before it is left for the next chance. */
export const OWED_DIAL_MS = 10_000;

/** What became of a sign-out's half at the computer: said, owed for the next connection, or neither. */
export type SignOutOutcome = "told" | "owed" | "untold";

interface OwedSignOut {
  token: string;
  at: number;
}

/** The server's `hashToken` (SHA-256, base64url, unpadded) — what a re-pair names; `null` without WebCrypto. */
async function familyDigest(token: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(token)));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

/** A rotation's name, the mark of the token it went out with, and when it was named. */
interface OwedAttempt {
  id: string;
  mark: string;
  at: number;
}

/** Enough of a refresh token to tell which one a name is owed for, never the token: FNV-1a, 32 bits. */
function refreshMark(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function owedAttemptOf(v: unknown): OwedAttempt | null {
  const p = v as Partial<OwedAttempt> | null | undefined;
  return p && typeof p.id === "string" && typeof p.mark === "string" && typeof p.at === "number"
    ? { id: p.id, mark: p.mark, at: p.at } : null;
}

/** The jar's record; `null` where there is none or it does not parse. */
function keptAttempt(raw: string | null): OwedAttempt | null {
  if (raw === null) return null;
  try {
    return owedAttemptOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

const readOwed = (db: IDBDatabase): Promise<OwedAttempt | null> => new Promise((resolve, reject) => {
  const get = db.transaction(ATTEMPT_STORE, "readonly").objectStore(ATTEMPT_STORE).get(OWED_KEY);
  get.onsuccess = () => resolve(owedAttemptOf(get.result));
  get.onerror = () => reject(get.error);
});

const commitOwed = (db: IDBDatabase, owed: OwedAttempt): Promise<unknown> => {
  const tx = db.transaction(ATTEMPT_STORE, "readwrite", { durability: "strict" });
  tx.objectStore(ATTEMPT_STORE).put(owed, OWED_KEY);
  return durableIdbCommit(tx, `idb:${REFRESH_ATTEMPT_DB}`);
};

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

/**
 * Name an attempt. NOT a credential — it authorizes nothing and names no row without the token
 * beside it — but unguessable all the same, so holding a stolen token is not also holding the
 * retry arm. Built on this file's one id source, prefixed the way the phone prefixes its own.
 */
function mintAttemptId(): string {
  return `r${mintPairScope()}`;
}

/**
 * THE ROUTES WHOSE 401 IS AN ANSWER: a wrong code, a wrong password, a spent single-use token. A
 * server older than `credential_refused` gives a lapsed access token the same 401, so a renewal there
 * would send the credential twice: two attempts against the sign-in throttle and a rotated pairing per
 * wrong code. The code is read first ({@link isCredentialRefusal}); this list is the belt. Held to the
 * server by `factor-routes-never-refresh.test.ts`, which drives this transport over every route
 * the server checks such a credential on.
 */
const NEVER_RENEW = [
  "/auth/login", "/auth/register", "/auth/refresh", "/auth/verify-email", "/auth/2fa/", "/auth/step-up/",
  "/pair/redeem", "/admin/staff/", "/auth/desktop-claim", "/auth/desktop-approval/claim", "/oauth/token",
  "/auth/password",
];

/** A stated window this close to its end counts as lapsed: the answer's transit, on this clock. */
const WINDOW_LEAD_MS = 30_000;

/** The instant a stated window ends, from now; `null` where the door stated none. */
function windowEndOf(expiresIn: number | undefined): number | null {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + expiresIn * 1000 : null;
}

/** May a 401 here be renewed and the request sent again? Read below the origin, where the URL names one. */
function mayRenewFor(url: string): boolean {
  const route = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  return !NEVER_RENEW.some((p) => route.startsWith(p));
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
  /** When the held access token's stated window ends ({@link windowEndOf}); never persisted, no timer. */
  private accessExpiresAt: number | null = null;
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
  /**
   * The name this page last sent, beside the jar's and IndexedDB's copies: what is left when
   * storage refuses. A rotation leaves it owed for its token; a death and a new pairing clear it.
   */
  private attempt: OwedAttempt | null = null;
  /** The name's IndexedDB: `undefined` reads the browser's own on each call, `null` is none. */
  private readonly idb: IDBFactory | null | undefined;
  private readonly deadListeners = new Set<() => void>();
  /** The owed sign-outs' one flight, and the retry armed while one is still owed. */
  private draining: Promise<void> | null = null;
  private owedRetry: ReturnType<typeof setTimeout> | null = null;
  private owedRetryMs = OWED_RETRY_FIRST_MS;

  constructor(opts: { storage?: Storage | null; fetchImpl?: FetchLike; idb?: IDBFactory | null } = {}) {
    this.door = storageDoor(
      opts.storage !== undefined ? opts.storage : defaultStorage(),
      "host-pair",
    );
    // BIND THE GLOBAL — the same illegal-invocation trap http-adapter.ts documents: a browser's
    // native fetch refuses any receiver that is not its own global.
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
    this.idb = opts.idb;
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
    // A sign-out this browser still owes its computer goes now, and again whenever it may land.
    const page = globalThis as { addEventListener?: (type: string, cb: () => void) => void; document?: Document };
    page.addEventListener?.("online", () => { void this.drainOwedSignOuts(); });
    page.document?.addEventListener("visibilitychange", () => {
      if (page.document?.visibilityState === "visible") void this.drainOwedSignOuts();
    });
    void this.drainOwedSignOuts();
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
    this.accessExpiresAt = windowEndOf(tokens.expiresIn);
    this.refresh = tokens.refreshToken;
    this.generation++;
    // Storage refused answers "lost" from the door and raises the notice; the session then lives
    // for this page load and the next one re-pairs, which is what the door exists to say out loud.
    this.door.set(REFRESH_STORAGE_KEY, tokens.refreshToken);
    // THE ATTEMPT IS ANSWERED, for every build: the bare name goes AFTER the token is written, as
    // it always has. The record stays owed for the token it went out with: a crash before the jar
    // keeps this token comes back holding that one. The next rotation presents this token, whose
    // mark differs, under a new name.
    this.door.remove(REFRESH_ATTEMPT_STORAGE_KEY);
    // A REDEEM re-mints; a rotation does not. The upgrade case is NOT handled here — it is
    // handled in the constructor, because by the time `adopt` runs the shell has already
    // mounted and read a partition. See `ensureScope`.
    if (opts.fresh === true) {
      // A new pairing owes no name.
      this.forgetAttempt();
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
    this.accessExpiresAt = null;
    this.refresh = null;
    this.door.remove(REFRESH_STORAGE_KEY);
    this.forgetAttempt();
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
    this.accessExpiresAt = null;
    this.refresh = null;
    // In memory only, like the pair: the jar belongs to the pairing that replaced this one.
    this.attempt = null;
    for (const cb of [...this.deadListeners]) cb();
  }

  /** Subscribe to the session ending — revoked, reused-past, expired. Returns the unsubscribe. */
  onSessionDead(cb: () => void): () => void {
    this.deadListeners.add(cb);
    return () => this.deadListeners.delete(cb);
  }

  /**
   * Rotate the pair once, single-flighted, under the origin-wide lock where the browser has one.
   * Resolves `true` when a fresh pair is held. A REFUSAL (`readRefreshAnswer`) clears the session;
   * everything else — a network failure, the admission bound's 503, a sign-in page, a firewall's
   * 403 — clears nothing and resolves `false`.
   */
  /**
   * IS THE PAIRING THIS ROTATION IS FOR STILL THE ONE THIS ORIGIN HOLDS? Asked IMMEDIATELY
   * BEFORE THE STORE IS TOUCHED, never only before the await.
   *
   * The check at the top of `rotate` answers about a state the resumption no longer has. Re-pair
   * in another tab while a refresh is in flight and the late answer lands under the SUCCESSOR's
   * scope: a late refusal's `die()` deletes the new pairing's refresh token and its scope, and a
   * late success's `adopt` overwrites them with the old pairing's — either way the pairing the
   * person just made stops working, from a background rotation, with no user act. Both were
   * reproduced against the unchanged module.
   *
   * A mismatch stands THIS TAB down — in memory only, telling the gate, leaving the jar alone,
   * which is `standDown`'s whole reason — and the caller writes nothing. It is not a lock: two
   * refreshes still run, and the one whose pairing is gone simply keeps its hands off.
   *
   * Not to be confused with the launch rule: a refused LAUNCH must still DISCARD the credential
   * it sealed. That is about a credential this install owns and got wrong; this is about a
   * credential that belongs to a different pairing.
   */
  private standDownIfRepaired(scope: string | null): boolean {
    if (this.readScope() === scope) return false;
    this.standDown();
    return true;
  }

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
      // THE SCOPE THIS ROTATION IS FOR, captured in a LOCAL beside the token it is about to
      // present. Not re-read off `this.scopeAtStart` after the await: a redeem on this very
      // manager moves that field, which is exactly the case the comparison below has to catch.
      const scopeAtSend = this.scopeAtStart;
      // A refused read answers null from the door — the in-memory copy is all there is.
      const stored = this.door.get(REFRESH_STORAGE_KEY);
      if (stored !== null && stored !== this.refresh) this.refresh = stored;
      const presented = this.refresh;
      if (presented === null) return false;
      // THE NAME GOES DOWN BEFORE THE REQUEST GOES OUT, and a retry of an attempt whose answer
      // never arrived carries the SAME one. The jar is the shared head for the name exactly as it
      // is for the token — a tab that submitted and never adopted leaves the name behind, and
      // whichever tab rotates next, or a restart, resumes it. A fresh name only where none is
      // owed for this token.
      const attemptId = await this.attemptFor(presented, scopeAtSend);
      // Asked again past the store's wait: a death or a re-pair may have come in between.
      if (this.refresh === null) return false;
      if (this.standDownIfRepaired(scopeAtSend)) return false;
      let res: Response;
      try {
        res = await this.fetchImpl("/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: presented, attemptId }),
        });
      } catch {
        // Never CONFIRMED presented. Usually never sent at all; the lost-response case is the
        // documented residual in the header — nothing this side can conclude, nothing cleared.
        return false;
      }
      const answer = await readRefreshAnswer(res);
      if (answer.kind === "minted") {
        /* THE WRITE DOOR. Reading the body is a second suspension point, so this is asked after
           it and not once after the fetch. */
        if (this.standDownIfRepaired(scopeAtSend)) return false;
        this.adopt(answer.tokens);
        return true;
      }
      if (answer.kind === "refused") {
        // The server judged the presented token and said no, by name. Definitive: sign out — of
        // the pairing this rotation was FOR, which is why the scope is asked again first.
        if (this.standDownIfRepaired(scopeAtSend)) return false;
        this.die();
        return false;
      }
      // Not the host's verdict: a 503, a sign-in page, a firewall's 403, an unreadable 200. Keep
      // the pair and the attempt's name; the caller gets its original 401, and the next episode
      // retries as the same attempt, which the host answers if it had already rotated.
      return false;
    }).finally(() => {
      this.rotating = null;
    }));
  }

  /**
   * The name a rotation of `presented` goes out under, in every copy before it goes: of the records
   * owed for this token (by mark) the newest, since one that missed a write holds an older name;
   * none, the bare name, which carries no mark but went out with the token the jar holds (every
   * build removes it on adoption); neither, a new one. A pairing that ended meanwhile gets nothing
   * written.
   */
  private async attemptFor(presented: string, scope: string | null): Promise<string> {
    const mark = refreshMark(presented);
    const live = (): boolean => this.refresh !== null && this.readScope() === scope;
    // `undefined`: IndexedDB gave no answer, and is not asked again for this rotation.
    const stored = await this.attemptStoreStep(readOwed);
    const kept = this.door.get(OWED_ATTEMPT_STORAGE_KEY);
    const bare = this.door.get(REFRESH_ATTEMPT_STORAGE_KEY);
    const owed = [stored ?? null, keptAttempt(kept), this.attempt].reduce<OwedAttempt | null>(
      (newest, p) => (p !== null && p.mark === mark && (newest === null || p.at > newest.at) ? p : newest),
      null,
    ) ?? (bare?.startsWith("r") ? { id: bare, mark, at: 0 } : null)
      ?? { id: mintAttemptId(), mark, at: Date.now() };
    if (!live()) return owed.id;
    this.attempt = owed;
    // Every copy holds it before it goes: a crash may keep any of them, and an older tab reads the bare one.
    const record = JSON.stringify(owed);
    if (kept !== record) this.door.set(OWED_ATTEMPT_STORAGE_KEY, record);
    if (bare !== owed.id) this.door.set(REFRESH_ATTEMPT_STORAGE_KEY, owed.id);
    if (stored !== undefined && stored?.id !== owed.id) {
      await this.attemptStoreStep((db) => (live() ? commitOwed(db, owed) : Promise.resolve(undefined)));
    }
    return owed.id;
  }

  /** The name's IndexedDB, or `null` where the browser has none or refuses the lookup. */
  private attemptStore(): IDBFactory | null {
    if (this.idb !== undefined) return this.idb;
    try {
      return globalThis.indexedDB ?? null;
    } catch {
      return null;
    }
  }

  /** One step on the name's store within the budget; `undefined` when it is missing, refuses or does not answer. */
  private attemptStoreStep<T>(step: (db: IDBDatabase) => Promise<T>): Promise<T | undefined> {
    const factory = this.attemptStore();
    if (factory === null) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let over = false;
      const timer = setTimeout(() => { over = true; resolve(undefined); }, ATTEMPT_STORE_BUDGET_MS);
      const answer = (value: T | undefined): void => {
        clearTimeout(timer);
        resolve(value);
      };
      try {
        const req = factory.open(REFRESH_ATTEMPT_DB, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(ATTEMPT_STORE); };
        req.onerror = () => answer(undefined);
        req.onsuccess = () => {
          const db = req.result;
          // A death or a new pairing deleting the database is never blocked by this page.
          db.onversionchange = () => db.close();
          // Opened past the budget: the rotation went without it, and a late write could only be older.
          if (over) { db.close(); return; }
          new Promise<T>((ok) => { ok(step(db)); }).then(answer, () => answer(undefined)).finally(() => db.close());
        };
      } catch {
        answer(undefined);
      }
    });
  }

  /** The name goes with the pairing: this page's copy, the jar's two, and IndexedDB's, deleted unawaited. */
  private forgetAttempt(): void {
    this.attempt = null;
    this.door.remove(REFRESH_ATTEMPT_STORAGE_KEY);
    this.door.remove(OWED_ATTEMPT_STORAGE_KEY);
    try {
      this.attemptStore()?.deleteDatabase(REFRESH_ATTEMPT_DB);
    } catch {
      /* refused: a later pairing's tokens never bear its mark */
    }
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
   * Authorization header stamped by the MANAGER on every attempt, plus ONE recovery: a 401 rotates
   * the pair and replays once, never where the 401 is an answer ({@link NEVER_RENEW}). One, not a
   * loop: a second 401 on a token minted milliseconds ago is a revocation. The recovery is bound to
   * the GENERATION the refused attempt was stamped in: a 401 whose stamp an earlier rotation
   * replaced restamps and replays WITHOUT rotating — rotating on stale refusals burns the fresh
   * refresh token and invalidates the fresh access token under requests already carrying it. The
   * manager's header merges LAST, so a rotation landing between the adapter building its headers and
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
    // A press whose 401 is never renewed leaves on a live token: a lapsed window rotates FIRST,
    // then the press is sent once (the phone's rule). An unstated window with a token held is
    // today's path.
    if (!mayRenewFor(url) && this.refresh !== null && this.windowLapsed()) await this.rotate();
    const stampedIn = this.generation;
    const first = await this.fetchImpl(url, stamped());
    if (first.status !== 401 || this.refresh === null || !mayRenewFor(url)) return first;
    // The server named the CREDENTIAL (a wrong code): the answer itself, never a lapsed session.
    if (await isCredentialRefusal(first)) return first;
    if (this.generation === stampedIn && !(await this.rotate())) return first;
    // Either the rotation minted a fresh pair, or one had ALREADY happened since this request
    // was stamped — both mean the same thing: replay once under the current generation.
    return this.fetchImpl(url, stamped());
  };

  /** No access token to send, or its stated window has run out ({@link WINDOW_LEAD_MS} early). */
  private windowLapsed(): boolean {
    return this.access === null
      || (this.accessExpiresAt !== null && Date.now() >= this.accessExpiresAt - WINDOW_LEAD_MS);
  }

  /**
   * Sign this device out on purpose: clear here, then tell the door (best-effort, within
   * {@link OWED_DIAL_MS}); answers whether the door said the session is over.
   * `allDevices` stays step-up-gated there, so this can only ever end ITSELF. The sidecar's
   * `revokeHeldSession` contract: `/auth/logout` with a held access token, and on its 401, or with
   * none held, `/auth/refresh/logout` with the refresh token, which names the family in any state —
   * after a rotation whose answer was lost too. Never a renewal, and a rotation in flight is not
   * waited for: the door ends the family whichever of its tokens it is shown.
   */
  async logout(): Promise<boolean> {
    return (await this.signOut()) === "told";
  }

  /**
   * {@link logout}, saying what became of the door's half. The local half comes first, before any
   * request: the refresh token is kept as OWED ({@link OWED_SIGN_OUTS_STORAGE_KEY}) and the session
   * dies here, so a page closed while the computer is silent leaves nothing paired and the debt
   * kept. A door that is told forgets it; otherwise it is sent at the next chance. `untold` is a
   * sign-out this browser could not even keep a note of.
   */
  async signOut(): Promise<SignOutOutcome> {
    const access = this.access;
    const refresh = this.refresh;
    const owed = refresh !== null && this.oweSignOut(refresh);
    this.die();
    if (access === null && refresh === null) return "told";
    const told = await this.endAtHost(access, refresh);
    if (told && refresh !== null) this.forgetOwedSignOut(refresh);
    this.armOwedRetry();
    if (told) return "told";
    if (!owed) return "untold";
    // A drain that ran meanwhile (a visible page, `online`, another tab) may have told it already.
    return this.owedSignOuts().some((e) => e.token === refresh) ? "owed" : "told";
  }

  /**
   * The family a re-pair of this browser names (`previousSession`): the held refresh token's
   * digest, else the newest owed sign-out's. `null` where there is neither.
   */
  async previousSession(): Promise<string | null> {
    const newest = this.owedSignOuts().reduce<OwedSignOut | null>((n, e) => (n === null || e.at >= n.at ? e : n), null);
    const token = this.refresh ?? newest?.token ?? null;
    return token === null ? null : familyDigest(token);
  }

  /**
   * Tell the computer about every sign-out this browser owes it, one flight at a time. Forgotten on a
   * 2xx, the door's own refusal, or a computer without the door (404, 405 — a debt is never renewed);
   * kept on anything else. Never throws.
   */
  drainOwedSignOuts(): Promise<void> {
    return (this.draining ??= (async () => {
      for (const entry of this.owedSignOuts()) {
        if (Date.now() - entry.at > OWED_SIGN_OUT_MAX_AGE_MS) {
          this.forgetOwedSignOut(entry.token);
          continue;
        }
        let settled = false;
        // Bounded, so one dial the network never answers holds no later chance behind it.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), OWED_DIAL_MS);
        try {
          const res = await this.fetchImpl("/auth/refresh/logout", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: entry.token }),
            signal: abort.signal,
          });
          settled = res.ok || res.status === 404 || res.status === 405 || isSessionRefusal(res.status, await envelopeCode(res));
        } catch {
          /* not reached: kept for the next chance */
        } finally {
          clearTimeout(timer);
        }
        if (settled) this.forgetOwedSignOut(entry.token);
      }
    })().finally(() => {
      this.draining = null;
      this.armOwedRetry();
    }));
  }

  private owedSignOuts(): OwedSignOut[] {
    try {
      const parsed: unknown = JSON.parse(this.door.get(OWED_SIGN_OUTS_STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((e): e is OwedSignOut => typeof e?.token === "string" && e.token !== "" && typeof e?.at === "number")
        : [];
    } catch {
      return [];
    }
  }

  /** Keep `token` as owed, read back; `false` when the list is full or the jar will not keep it. */
  private oweSignOut(token: string): boolean {
    const owed = this.owedSignOuts().filter((e) => e.token !== token);
    if (owed.length >= OWED_SIGN_OUTS_MAX) return false;
    this.door.set(OWED_SIGN_OUTS_STORAGE_KEY, JSON.stringify([...owed, { token, at: Date.now() }]));
    return this.owedSignOuts().some((e) => e.token === token);
  }

  private forgetOwedSignOut(token: string): void {
    const left = this.owedSignOuts().filter((e) => e.token !== token);
    if (left.length === 0) this.door.remove(OWED_SIGN_OUTS_STORAGE_KEY);
    else this.door.set(OWED_SIGN_OUTS_STORAGE_KEY, JSON.stringify(left));
  }

  /** While something is owed, one timer, each wait twice the last up to the cap; none once it is all sent. */
  private armOwedRetry(): void {
    if (this.owedSignOuts().length === 0) {
      if (this.owedRetry !== null) clearTimeout(this.owedRetry);
      this.owedRetry = null;
      this.owedRetryMs = OWED_RETRY_FIRST_MS;
      return;
    }
    if (this.owedRetry !== null) return;
    const wait = this.owedRetryMs;
    this.owedRetryMs = Math.min(wait * 2, OWED_RETRY_MAX_MS);
    this.owedRetry = setTimeout(() => {
      this.owedRetry = null;
      void this.drainOwedSignOuts();
    }, wait);
    // A Node timer would hold a test run open; a browser's is a number.
    (this.owedRetry as { unref?: () => void }).unref?.();
  }

  /** A 2xx, or the refresh door's own 401: nothing is left to end. Within {@link OWED_DIAL_MS}; never throws. */
  private async endAtHost(access: string | null, refresh: string | null): Promise<boolean> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), OWED_DIAL_MS);
    try {
      if (access !== null) {
        const res = await this.fetchImpl("/auth/logout", {
          method: "POST", headers: { authorization: `Bearer ${access}` }, signal: abort.signal,
        });
        if (res.ok) return true;
        if (res.status !== 401) return false;
      }
      if (refresh === null) return false;
      const door = await this.fetchImpl("/auth/refresh/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: refresh }),
        signal: abort.signal,
      });
      return door.ok || isSessionRefusal(door.status, await envelopeCode(door));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The code our error envelope names, or null: a door's own refusal said apart from a page in front of it. */
async function envelopeCode(res: Response): Promise<string | null> {
  try {
    const code = ((await res.json()) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
