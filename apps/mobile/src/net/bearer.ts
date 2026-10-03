/**
 * The bearer manager, on React Native — this app's whole credential, in one small object. A
 * port of `apps/desktop/src/host-client/bearer.ts` semantics — single-flight rotation, one reading
 * of the refresh answer, generation-bound replay, refusal-only sign-out — with the refresh token in
 * the device keystore and no `navigator.locks`: one manager per pairing slot for the whole process,
 * held by `bearer-registry.ts`, is what keeps a token from being presented twice. An activity
 * recreate rebuilds the React tree in the same runtime while a rotation can be in flight, so a
 * manager per session is two presenters. Every attempt carries a name persisted before it submits.
 * A death is this manager's own fact: settled once, and told to a listener that subscribes late.
 */

import { ACCOUNT_ERASED, ERASED_ANSWER_HEADER, readRefreshAnswer, sessionEndedResponse } from "@ohmail/client-engine";
import type { SessionRenewalDoor } from "@ohmail/client-engine";
import type { RefreshWrite } from "../state/servers";

/** The wire pair the redeem and the refresh both answer — the desktop manager's exact shape. */
export interface BearerTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Where the refresh token survives an app kill. The profile store binds this to the profile's
 * slot in expo-secure-store; tests bind a recorder. `save` is awaited by the rotation before it
 * resolves; `clear` is a refusal's take-back. Every write carries `held`, every token this
 * manager has held, and the store writes only over one of them: a re-pair's newer family is not
 * this manager's to touch, and a write that failed is caught up by the next one.
 */
export interface RefreshVault {
  save(refreshToken: string, held: ReadonlySet<string>): Promise<RefreshWrite>;
  /** `why` is the death this clear follows: an erased account's copy is owed before the token goes. */
  clear(held: ReadonlySet<string>, why: SessionDeath): Promise<RefreshWrite>;
  /**
   * Persist the name of the attempt about to be submitted, beside `head`, the token it will
   * spend — written together, so a failed save is repaired here and a kill after this write
   * relaunches on a pair the server can answer. Adopting clears the name.
   */
  armAttempt(attemptId: string, head: string, held: ReadonlySet<string>): Promise<RefreshWrite>;
}

/**
 * WHY A SESSION ENDED, for the surface that has to say it. `revoked` is the server withdrawing
 * this family because a spent token was presented by somebody — the one case a person meets as
 * "pair again" with no reason at all, and the one this app now names.
 */
export type SessionDeath = "refused" | "revoked" | "erased";

/**
 * Name an attempt. NOT a credential — it authorizes nothing, names no row without the token
 * beside it, and the server's window on it is a minute — but unguessable all the same, so that
 * holding a stolen token is not also holding the retry arm. `Math.random` twice plus the clock,
 * because a native crypto module is a `require` this bundle cannot afford to have missing.
 */
/**
 * The refusal the server gives a family it has just SWEPT. Pinned on the server side by the auth-flow suite ("a REFUSAL
 * still clears the jar — and now NAMES which refusal it was") and on this side by the
 * bearer-retry suite: the sentence is the wire, and both halves have to move together.
 */
const REUSE_REFUSAL = "refresh token reuse detected";

/**
 * Which death a refusal names. Anything else is the ORDINARY refusal — a guess would be worse
 * than the plain sentence, and this decides only which words a person reads, never whether the
 * session ends.
 */
function deathOf(message: string | null): SessionDeath {
  return message === REUSE_REFUSAL ? "revoked" : "refused";
}

function mintAttemptId(): string {
  const chunk = (): string => Math.floor(Math.random() * 36 ** 8).toString(36).padStart(8, "0");
  return `r${Date.now().toString(36)}${chunk()}${chunk()}`;
}

/**
 * Does this answer say THIS profile's account was erased? `410 account_erased` naming `accountId`
 * in `X-Ohmail-Account`. Reads a clone. A 410 naming nobody or another account says nothing here.
 */
async function erasesAccount(res: Response, accountId: string | null): Promise<boolean> {
  if (res.status !== 410 || accountId === null) return false;
  try {
    const code = ((await res.clone().json()) as { error?: { code?: unknown } } | null)?.error?.code;
    return code === ACCOUNT_ERASED && res.headers.get("X-Ohmail-Account") === accountId;
  } catch {
    return false;
  }
}

/**
 * THE ROUTES WHOSE 401 IS AN ANSWER: a wrong code, a wrong password, a spent single-use token. A
 * lapsed access token gets the same 401, so a renewal there would send the credential twice: two
 * attempts against the sign-in throttle and a rotated session per wrong code. Path prefixes, held to the
 * server by `test/factor-routes-never-refresh.test.ts`, which drives this transport over every
 * route the server checks such a credential on. `/auth/logout` is not here: a cold launch sends it
 * with no access token, and the renewal is what lets it land.
 */
const NEVER_RENEW = [
  "/auth/login", "/auth/register", "/auth/refresh", "/auth/verify-email", "/auth/2fa/", "/auth/step-up/",
  "/pair/redeem", "/admin/staff/", "/auth/desktop-claim", "/auth/desktop-approval/claim", "/oauth/token",
];

/** May a 401 here be renewed and the request sent again? Read below the origin and the `/api` mount. */
function mayRenewFor(url: string): boolean {
  const route = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/^\/api(?=\/)/, "");
  return !NEVER_RENEW.some((p) => route.startsWith(p));
}

/** The same loose-init fetch shape the engine's HttpAdapter and the desktop manager ride. */
export type FetchLike = (url: string, init?: unknown) => Promise<Response>;

interface LooseInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export class BearerManagerRN implements SessionRenewalDoor {
  private access: string | null;
  private refresh: string | null;
  /** Requests are ABSOLUTE on this platform — there is no served origin to be relative to. */
  private readonly origin: string;
  /** The account this pairing is for (`ServerProfile.accountId`) — what an erased answer must name. */
  private readonly accountId: string | null;
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
  /**
   * The name of the attempt in flight, or the one a previous attempt left UNANSWERED — loaded
   * from the keystore at construction, which is what makes a retry survive an app kill between
   * submit and adopt. Cleared by every adoption and every death.
   */
  private attempt: string | null;
  private readonly deadListeners = new Set<(why: SessionDeath) => void>();
  private readonly renewedListeners = new Set<() => void>();
  /** Every refresh token this manager has held, in order: the one it was built with, then each adopted. */
  private readonly chain: string[] = [];
  /** The death, settled after its listeners heard it; `null` while this manager lives. */
  private settled: SessionDeath | null = null;
  /** The death in progress or settled; `null` for a manager that has not died. */
  private dying: Promise<SessionDeath> | null = null;

  constructor(opts: {
    /** `https://host` or plain `http://192.168…` — the door this credential belongs to. */
    origin: string;
    /** The pair the redeem just minted (fresh pairing), or null access on a cold app launch. */
    accessToken?: string | null;
    /** The persisted refresh token the profile store loaded — the family's head. */
    refreshToken: string | null;
    /**
     * The attempt the store had armed — `ServerProfile.refreshAttempt`. Present only where a
     * rotation was submitted and never adopted, which is precisely the case the retry is for:
     * a relaunch resumes that attempt rather than starting one the server cannot recognise.
     */
    refreshAttempt?: string | null;
    /** The profile's account id. Absent: an erased answer is never this manager's to act on. */
    accountId?: string | null;
    vault: RefreshVault;
    fetchImpl?: FetchLike;
  }) {
    this.origin = opts.origin.replace(/\/+$/, "");
    this.accountId = opts.accountId ?? null;
    this.access = opts.accessToken ?? null;
    this.refresh = opts.refreshToken;
    if (opts.refreshToken !== null) this.chain.push(opts.refreshToken);
    this.attempt = opts.refreshAttempt ?? null;
    this.vault = opts.vault;
    // Bind the global — RN's fetch is a plain function today, but the illegal-invocation trap
    // the desktop manager documents costs nothing to keep closed.
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  }

  /** Whether this manager holds a pairing at all — what the connection layer renders on. */
  paired(): boolean {
    return this.refresh !== null;
  }

  /** How this manager died, or `null` while it lives — set once every listener has heard it. */
  get death(): SessionDeath | null {
    return this.settled;
  }

  /** The death in progress or settled, resolving to its cause; `null` for a manager that has not died. */
  deathSettled(): Promise<SessionDeath> | null {
    return this.dying;
  }

  /** The chain as a write carries it: the store admits a write only over one of these tokens. */
  private held(): ReadonlySet<string> {
    return new Set(this.chain);
  }

  /**
   * Adopt a freshly minted pair — every successful rotation's answer. Memory is updated
   * synchronously (the next stamp must carry the new token); the returned promise is the vault
   * write, which `rotate()` awaits and other callers may ignore.
   */
  adopt(tokens: BearerTokens): Promise<void> {
    // The chain before this pair: the row holds one of its tokens, whichever write last landed.
    const held = this.held();
    this.chain.push(tokens.refreshToken);
    this.access = tokens.accessToken;
    this.refresh = tokens.refreshToken;
    this.generation++;
    // THE ATTEMPT IS ANSWERED. In memory first, for the stamp's reason; the store clears it in
    // the same write `save` makes, so there is no window where a new token stands beside an old
    // attempt's name. A `fetch` resolves once or throws, so one attempt never has two answers.
    this.attempt = null;
    // A read the old token was refused on asks again now; a reader's fault is not the credential's.
    for (const cb of [...this.renewedListeners]) {
      try { cb(); } catch { /* the pair is adopted either way */ }
    }
    return this.vault.save(tokens.refreshToken, held).then(() => undefined, () => {
      /* A keystore refusal: the session lives until the next kill, then one scan re-pairs. */
    });
  }

  /** The store reads' renewal door (`createSessionReask`): ask a rotation, single-flighted. */
  renew(): void {
    void this.rotate();
  }

  /** Hear every adopted pair. Returns the unsubscribe. */
  onRenewed(cb: () => void): () => void {
    this.renewedListeners.add(cb);
    return () => this.renewedListeners.delete(cb);
  }

  /** No credential left: a refusal is said, never waited on. */
  ended(): boolean {
    return !this.paired();
  }

  /** The extra-headers seam's value — `HttpAdapterOptions.headers` calls this per request. */
  headers(): Record<string, string> {
    // Every ask declares it understands `410 account_erased` (the server answers 401 otherwise).
    const declared = { [ERASED_ANSWER_HEADER]: ACCOUNT_ERASED };
    return this.access !== null ? { ...declared, authorization: `Bearer ${this.access}` } : declared;
  }

  /**
   * End the session locally and tell the connection layer. Never throws, and IDEMPOTENT: the
   * routed logout below can die inside its own recovery (the refresh refused mid-logout), and
   * the funeral must not be held twice — one dead signal per session, whoever reports it. The
   * death is settled AFTER the listener loop: a listener that subscribed during the clear is
   * told by the loop, one that subscribes afterwards by `onSessionDead`, and nobody twice.
   */
  private die(why: SessionDeath): Promise<void> {
    if (this.access === null && this.refresh === null) {
      return this.dying === null ? Promise.resolve() : this.dying.then(() => undefined);
    }
    this.access = null;
    this.refresh = null;
    this.attempt = null;
    const dying = (async (): Promise<SessionDeath> => {
      await this.vault.clear(this.held(), why).catch(() => {
        /* already gone, or the keystore refused — either way this session is over locally */
      });
      for (const cb of [...this.deadListeners]) cb(why);
      this.settled = why;
      return why;
    })();
    this.dying = dying;
    return dying.then(() => undefined);
  }

  /**
   * Subscribe to the session ending. The callback is told WHY, because "pair again" with no
   * reason is what a person meets today and `revoked` is the one death worth naming: somebody
   * presented a token this family had already spent. A subscriber to a manager that has already
   * died is told once, on a microtask: never synchronously, so a caller that paints `live` right
   * after subscribing is not painted over.
   */
  onSessionDead(cb: (why: SessionDeath) => void): () => void {
    this.deadListeners.add(cb);
    const settled = this.settled;
    if (settled !== null) {
      void Promise.resolve().then(() => {
        if (this.deadListeners.has(cb)) cb(settled);
      });
    }
    return () => this.deadListeners.delete(cb);
  }

  /**
   * Rotate the pair once, single-flighted. Resolves `true` when a fresh pair is held. A REFUSAL
   * (`readRefreshAnswer`) clears the session; everything else — a network failure, a 503, a
   * sign-in page, a firewall's 403 — clears nothing and resolves `false`.
   * No lock and no storage re-read around the critical section: the registry holds one
   * manager per slot for the process, so this flight is the slot's only presenter.
   */
  private rotate(): Promise<boolean> {
    return (this.rotating ??= (async (): Promise<boolean> => {
      const presented = this.refresh;
      if (presented === null) return false;
      // THE NAME GOES DOWN BEFORE THE REQUEST GOES OUT, and a retry of an attempt whose answer
      // never arrived carries the SAME one — resumed from the field the store loaded at
      // construction, so an app killed between submit and adopt still retries as itself rather
      // than as a stranger holding a spent token. A fresh name only where none is owed. The
      // vault write is AWAITED: a name on the wire that is not yet in the keystore is the one
      // ordering a retry cannot recover from.
      const attemptId = this.attempt ?? mintAttemptId();
      this.attempt = attemptId;
      await this.vault.armAttempt(attemptId, presented, this.held()).catch(() => {
        /* The keystore refused. The attempt is still named on the wire and in memory, so a retry
           inside this process is recognised; only one that outlives the process is not — which
           is exactly where every phone stood before the name existed. */
      });
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.origin}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json", [ERASED_ANSWER_HEADER]: ACCOUNT_ERASED },
          body: JSON.stringify({ refreshToken: presented, attemptId }),
        });
      } catch {
        // Never CONFIRMED presented — usually never sent at all. Nothing to conclude, nothing
        // cleared; the lost-response case is the documented residual in the header.
        return false;
      }
      const answer = await readRefreshAnswer(res);
      if (answer.kind === "minted") {
        await this.adopt(answer.tokens);
        return true;
      }
      if (answer.kind === "erased") {
        // The account is gone — only when the server named THIS pairing's account. Else the pair stays.
        if (answer.account !== null && answer.account === this.accountId) await this.die("erased");
        return false;
      }
      if (answer.kind === "refused") {
        // The server judged the presented token and said no, by name. Definitive: sign out, and
        // say WHICH no — a family swept for reuse reads apart from a token that merely expired.
        await this.die(deathOf(answer.message));
        return false;
      }
      // Not the server's verdict: a 503, a sign-in page, a firewall's 403, an unreadable 200. Keep
      // the pair and the attempt's name; the caller gets its original 401, and the next episode
      // retries as the same attempt, which the server answers if it had already rotated.
      return false;
    })().finally(() => {
      this.rotating = null;
    }));
  }

  /**
   * The transport the engine's `HttpAdapter` and the pairing probes run on: the platform fetch
   * with the Authorization header stamped by the MANAGER on every attempt, plus ONE recovery —
   * a 401 rotates the pair and replays once, never where the 401 is an answer ({@link NEVER_RENEW}).
   * The recovery is bound to the GENERATION the refused attempt was stamped in; a stale 401
   * restamps and replays WITHOUT rotating (the desktop header's cascade). The manager's header
   * merges LAST, so a rotation landing between the adapter building its headers and this call
   * wins over the stale copy; everything else the caller set, the Idempotency-Key included,
   * travels as it was. An arrow property so it can be handed to `HttpAdapterOptions.fetch` bare.
   */
  fetch: FetchLike = async (url, init) => {
    const options = (init ?? {}) as LooseInit;
    const stamped = (): LooseInit => ({
      ...options,
      headers: { ...(options.headers ?? {}), ...this.headers() },
    });
    const stampedIn = this.generation;
    const first = await this.heard(await this.fetchImpl(url, stamped()));
    if (first.status !== 401 || this.refresh === null || !mayRenewFor(url)) return first;
    if (this.generation === stampedIn && !(await this.rotate())) return first;
    // Either the rotation minted a fresh pair, or one had ALREADY happened since this request
    // was stamped — both mean the same thing: replay once under the current generation.
    return this.heard(await this.fetchImpl(url, stamped()));
  };

  /**
   * THE READ PATH'S ERASED ANSWER, heard before the engine sees it: the session dies as `erased`
   * FIRST, and the engine is handed the dead session's refusal. The 410 itself reads to the
   * adapter as a cursor expiry, whose remedy — discard and re-bootstrap — would loop on a gone
   * account every cadence instead of the door's wipe.
   */
  private async heard(res: Response): Promise<Response> {
    if (!(await erasesAccount(res, this.accountId))) return res;
    await this.die("erased");
    return sessionEndedResponse();
  }

  /**
   * Sign this device out on purpose: tell the door (best-effort — the local clear must not
   * hang on an unreachable server), then clear. `/auth/logout` revokes the session
   * server-side; `allDevices` stays step-up-gated there, so this can only ever end itself.
   * Routed through {@link fetch} — the manager's own recovery — not the raw transport:
   * `/auth/logout` is authenticated, and a cold launch would send it bare, collect a silent
   * 401, and clear the local half while the refresh family stayed live server-side. Under the
   * recovery the replayed logout actually lands; if the recovery is itself refused, the
   * manager has already died honestly — `die()`'s idempotence makes the final clear a no-op.
   */
  async logout(): Promise<boolean> {
    // Answers whether the server was actually told — the whole reason for the return. The
    // local half happens either way, but the server half is what revokes the session and, on
    // the hosted tier, takes this device's wake registration down; reporting a forget over a
    // logout that never landed leaves both alive with nothing left to retry them. A bare 401
    // is not evidence on its own: `fetch` answers the original 401 when its one recovery could
    // not run (a `/auth/refresh` that 500s, a dead network), and the refresh token is then
    // still live. What separates them is what the manager DID: a refusal clears the credential
    // (`rotate` → `die`), a transient failure clears nothing — so a 401 with no credential
    // left is "already gone", a 401 with the credential still held did not land.
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
    // "refused", not "revoked": a deliberate sign-out is not a family somebody replayed, and the
    // surface must not tell the person their key was presented twice when they pressed the button.
    await this.die("refused");
    return told;
  }
}
