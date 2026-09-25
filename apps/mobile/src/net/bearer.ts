/**
 * The bearer manager, on React Native — this app's whole credential, in one small object. A
 * port of `apps/desktop/src/host-client/bearer.ts` semantics — single-flight rotation, one reading
 * of the refresh answer, generation-bound replay, refusal-only sign-out — with two narrowing
 * substitutions: the refresh token persists in the device keystore, and `navigator.locks` is
 * dropped because RN is one JS runtime with no sibling presenters. A lost rotation response used
 * to end the pairing: strict reuse read the retry of the retained token as theft. Every attempt
 * now carries a name persisted BEFORE it submits and repeated until an answer lands.
 */

import { readRefreshAnswer } from "@ohmail/client-engine";

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
  /**
   * Persist the name of the attempt about to be submitted, beside the token it will spend. The
   * store clears it in the same write that saves the answer, so adopting IS clearing and no
   * caller can forget to.
   */
  armAttempt(attemptId: string): Promise<void>;
}

/**
 * WHY A SESSION ENDED, for the surface that has to say it. `revoked` is the server withdrawing
 * this family because a spent token was presented by somebody — the one case a person meets as
 * "pair again" with no reason at all, and the one this app now names.
 */
export type SessionDeath = "refused" | "revoked";

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
  /**
   * The name of the attempt in flight, or the one a previous attempt left UNANSWERED — loaded
   * from the keystore at construction, which is what makes a retry survive an app kill between
   * submit and adopt. Cleared by every adoption and every death.
   */
  private attempt: string | null;
  private readonly deadListeners = new Set<(why: SessionDeath) => void>();

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
    vault: RefreshVault;
    fetchImpl?: FetchLike;
  }) {
    this.origin = opts.origin.replace(/\/+$/, "");
    this.access = opts.accessToken ?? null;
    this.refresh = opts.refreshToken;
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

  /**
   * Adopt a freshly minted pair — every successful rotation's answer. Memory is updated
   * synchronously (the next stamp must carry the new token); the returned promise is the vault
   * write, which `rotate()` awaits and other callers may ignore.
   */
  adopt(tokens: BearerTokens): Promise<void> {
    this.access = tokens.accessToken;
    this.refresh = tokens.refreshToken;
    this.generation++;
    // THE ATTEMPT IS ANSWERED. In memory first, for the stamp's reason; the store clears it in
    // the same write `save` makes, so there is no window where a new token stands beside an old
    // attempt's name. A `fetch` resolves once or throws, so one attempt never has two answers.
    this.attempt = null;
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
  private async die(why: SessionDeath): Promise<void> {
    if (this.access === null && this.refresh === null) return;
    this.access = null;
    this.refresh = null;
    this.attempt = null;
    await this.vault.clear().catch(() => {
      /* already gone, or the keystore refused — either way this session is over locally */
    });
    for (const cb of [...this.deadListeners]) cb(why);
  }

  /**
   * Subscribe to the session ending. The callback is told WHY, because "pair again" with no
   * reason is what a person meets today and `revoked` is the one death worth naming: somebody
   * presented a token this family had already spent.
   */
  onSessionDead(cb: (why: SessionDeath) => void): () => void {
    this.deadListeners.add(cb);
    return () => this.deadListeners.delete(cb);
  }

  /**
   * Rotate the pair once, single-flighted. Resolves `true` when a fresh pair is held. A REFUSAL
   * (`readRefreshAnswer`) clears the session; everything else — a network failure, a 503, a
   * sign-in page, a firewall's 403 — clears nothing and resolves `false`.
   * No lock and no storage re-read around the critical section: one runtime, one presenter
   * (the header's second paragraph).
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
      await this.vault.armAttempt(attemptId).catch(() => {
        /* The keystore refused. The attempt is still named on the wire and in memory, so a retry
           inside this process is recognised; only one that outlives the process is not — which
           is exactly where every phone stood before the name existed. */
      });
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.origin}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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
