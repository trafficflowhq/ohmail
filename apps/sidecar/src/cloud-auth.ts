import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describeError } from "@trafficflow/core/mail";
import type { KeyProvider } from "@trafficflow/core/mail";
import { writeAtomic } from "./fs-atomic.js";
import type { Diagnostic } from "./log.js";

/**
 * The cloud bearer client — a plain `Authorization: Bearer` fetch against the hosted API, with a
 * single-flight refresh on 401 and a sealed-to-disk token store. Not `HttpAdapter`, which is
 * browser-shaped (a `tf_csrf` cookie, a jar); this is a Node child authenticating with a token the
 * shell handed it, and the hosted API exempts a bearer from CSRF — so: no jar, one header.
 * The 401 refresh is SINGLE-FLIGHT: the pull loop 401s all at once at expiry, and refreshing
 * per-401 would present the family's token twice, which the API treats as compromise.
 */

/*
 * A rotation whose ANSWER is lost used to cost the session all the same: the retry of the retained
 * token was byte-identical to a replay. Every attempt now carries a name, sealed beside the token
 * it is about to spend BEFORE the request goes out and repeated until an answer lands — the
 * phone's field and semantics (`apps/mobile/src/net/bearer.ts`), three clients and one contract.
 */

export interface CloudTokens {
  accessToken: string;
  refreshToken: string;
  /**
   * NOT part of the wire pair: the name of a rotation this install submitted and never adopted.
   * It travels with the pair because it belongs to it — sealed in the same write, so a launch
   * killed between submit and adopt resumes that attempt rather than presenting a spent token as
   * a stranger. Absent means nothing is owed, which is every ordinary pair.
   */
  refreshAttempt?: string;
}

/**
 * WHERE THE SESSION STANDS — the reading `/health.session` carries. Only `refused` ends it, and
 * only a coded 401 from the refresh door reaches it. `renewing` is an answer that was not a
 * verdict (a firewall's 403, a busy 503, a 429, an uncoded 401); `unreachable` is no answer at
 * all; `seal_failed` is a renewal withheld because its attempt could not be written to disk
 * first. Every state but `refused` keeps the session and retries on its own clock.
 */
export type CloudSessionState = "live" | "renewing" | "unreachable" | "refused" | "seal_failed";

export interface CloudSessionReading {
  state: CloudSessionState;
  /** The refusal's code, a fault's code, or null. A vocabulary word, never a body or a token. */
  code: string | null;
  /** When this state began, ISO. */
  since: string;
}

/**
 * THE CODES THAT END A SESSION — the refresh door's own verdicts, read from our envelope. The
 * legacy `unauthorized` stays until every server this build meets names the three; a 401 with no
 * code of ours is a platform's answer and is retried like any other fault.
 */
export const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "refresh_missing", "refresh_expired", "refresh_revoked", "unauthorized",
]);

/** Renew at this share of the access window (jittered ±5 %), so expiry never meets a request. */
export const RENEW_AHEAD_FRACTION = 0.8;
/** A fault's retry: from a second, doubling, jittered, never more than a minute apart. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 60_000;
/** A server-named wait is honoured up to this; a longer header is read as a mistake. */
export const RETRY_AFTER_MAX_MS = 300_000;

export const OFFLINE_READ_ONLY = "offline_read_only";

/**
 * THE ANSWER WHEN CLOUD CANNOT BE USED RIGHT NOW — the proxy's offline refusal, and the answer a
 * request gets when its renewal met a fault. A relayed hosted 401 there read as a sign-out to
 * the window; this is the refusal the window's outbox already treats as a wait.
 */
export function offlineResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: OFFLINE_READ_ONLY,
        message:
          "this install is offline — the hosted mailbox cannot be reached, so writes are paused " +
          "until it returns; what is already mirrored keeps reading",
        retryable: true,
      },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

export interface CloudAuthConfig {
  /** The door's base URL, as `cloud-origin.ts` resolves it. A trailing slash is trimmed. */
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
   * Called at most once, when the refresh door REFUSED — a 401 carrying a code in
   * {@link REFUSAL_CODES}. The engine's cue to return to sign-in. Nothing else calls it: a 403,
   * an uncoded 401, a 5xx or a dead network is retried and the session stays.
   */
  onSessionRefused?: (code: string) => void;
  /** Told each new {@link CloudSessionReading}, and each fault's retry, for `/health` and the log. */
  onSessionState?: (reading: CloudSessionReading, next: { attempt: number; retryInMs: number | null }) => void;
  /** The jitter's source, injectable so a test can pin the schedule. */
  random?: () => number;
}

/**
 * Name an attempt. NOT a credential — it authorizes nothing and names no row without the token
 * beside it — but unguessable all the same, so holding a stolen token is not also holding the
 * retry arm. The phone prefixes its own the same way.
 */
function mintAttemptId(): string {
  return `r${randomUUID()}`;
}

/** See {@link CloudAuthConfig.requestDeadlineMs}. Generous: a 500-row /sync page on a slow link. */
export const REQUEST_DEADLINE_MS = 90_000;

/**
 * WHETHER THIS INSTALL'S SIGN-IN IS ON DISK — a STATE, not a log line.
 *
 * A seal that could not be written used to be a `cloud_refresh_failed` line while the rotation
 * reported itself done: the session works until the quit and the next launch asks for a password
 * nobody was told it would need. `reason` is the thrown value's CLASS and never its message —
 * the same grammar every log site uses; a filesystem message quotes paths and is not a state.
 */
interface SealState {
  /** False once a seal write threw and until one succeeds. True where there is no seal to write. */
  sealed: boolean;
  /** The class of the last seal refusal, or null while nothing is owed. */
  reason: string | null;
}

export interface CloudAuth {
  /** A bearer-authenticated fetch of `<baseUrl><path>`, with a single-flight refresh + retry on 401. */
  authedFetch(path: string, init?: RequestInit): Promise<Response>;
  /** The tokens currently in play, after any rotation. */
  currentTokens(): CloudTokens;
  /** {@link SealState} — read by `/health`, so the window can say it rather than only the log. */
  sealState(): SealState;
  /** {@link CloudSessionReading} as it stands. */
  session(): CloudSessionReading;
  /** Renew now — the window's Try again — and answer the reading that leaves. */
  renewNow(): Promise<CloudSessionReading>;
  /** Cancel every scheduled renewal and stop reporting. Nothing is sent and nothing is removed. */
  stop(): void;
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
  /* STAGED AND RENAMED (`fs-atomic.ts`), never written in place. This file is the only credential
     a relaunch has: a process killed mid-write left a prefix of one envelope, which `loadSealed-
     Tokens` reads as "this key does not open that file" — a session lost for a write that was
     interrupted rather than refused. The previous complete seal survives instead. */
  writeAtomic(
    path,
    JSON.stringify({ ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion } satisfies SealedTokenFile),
    0o600,
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

/** One renewal's outcome. `fault` keeps the session; only `refused` ends it. */
type Renewal =
  | { kind: "minted"; expiresInMs: number | null }
  | { kind: "refused"; code: string }
  | { kind: "fault"; state: "renewing" | "unreachable" | "seal_failed"; code: string; retryAfterMs: number | null };

/** A code fit for a state line: our envelope's vocabulary shape. Anything else is dropped. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,47}$/;

/** The error code our envelope names, or null — an HTML page, an empty body, a foreign shape. */
async function envelopeCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === "string" && CODE_SHAPE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** `Retry-After` in milliseconds — seconds or an HTTP date — or null when absent or unreadable. */
export function retryAfterMs(res: Response, nowMs: number): number | null {
  const raw = res.headers.get("retry-after")?.trim() ?? "";
  if (raw === "") return null;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - nowMs;
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS);
}

/** A transport failure's word: the deadline, or the network. Never the message. */
function transportCode(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

export function createCloudAuth(cfg: CloudAuthConfig): CloudAuth {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const deadlineMs = cfg.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  const now = cfg.now ?? ((): Date => new Date());
  const random = cfg.random ?? Math.random;
  let tokens = cfg.tokens;
  /** The clone defence, single-flight: one in-flight renewal serves every caller. */
  let renewing: Promise<Renewal> | null = null;
  /** The refusal latch: {@link CloudAuthConfig.onSessionRefused} fires at most once. */
  let sessionRefusedTold = false;
  /** {@link SealState}'s reason — the class of the last refused seal, cleared by the next one. */
  let sealFailure: string | null = null;
  let reading: CloudSessionReading = { state: "live", code: null, since: now().toISOString() };
  /** Consecutive faults, for the backoff. A mint resets it. */
  let faults = 0;
  /** The ONE scheduled renewal — ahead of expiry, or a fault's retry — and which of the two. */
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerIsRetry = false;
  let stopped = false;

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

  const tellSessionRefused = (code: string): void => {
    if (sessionRefusedTold) return;
    sessionRefusedTold = true;
    try {
      cfg.onSessionRefused?.(code);
    } catch {
      /* the cue must never break the fetch it rode in on */
    }
  };

  /** Write `next` to the seal. False when the disk refused it; the class is kept for `/health`. */
  const persist = async (next: CloudTokens, reason: string): Promise<boolean> => {
    if (!cfg.keyProvider || !cfg.sealPath) return true;
    try {
      await sealTokens(cfg.sealPath, cfg.keyProvider, next);
      sealFailure = null;
      return true;
    } catch (err) {
      // Said once per streak: a disk that keeps refusing is retried on the renewal's own clock,
      // and the state line already carries each attempt.
      const first = sealFailure === null;
      sealFailure = describeError(err).errorClass;
      if (first) cfg.log?.("cloud_refresh_failed", { err, reason });
      return false;
    }
  };

  const refresh = async (): Promise<Renewal> => {
    /* THE NAME GOES DOWN BEFORE THE REQUEST GOES OUT, and a retry of an unanswered attempt carries
       the same one, resumed from the seal after a relaunch. When the name cannot be written the
       request does not go out: a rotation the disk does not know about leaves the next launch
       presenting a spent token under a new name, which the server treats as theft and answers by
       revoking every device of the family. The token on disk stays the live one instead. */
    const attemptId = tokens.refreshAttempt ?? mintAttemptId();
    const staged: CloudTokens = { ...tokens, refreshAttempt: attemptId };
    const written = await persist(staged,
      "the next renewal could not be written to disk, so it was not sent; the saved session stays live");
    if (!written) return { kind: "fault", state: "seal_failed", code: "seal_write_failed", retryAfterMs: null };
    tokens = staged;
    let res: Response;
    try {
      res = await fetchImpl(`${base}/auth/refresh`, withDeadline({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: staged.refreshToken, attemptId }),
      }));
    } catch (err) {
      return { kind: "fault", state: "unreachable", code: transportCode(err), retryAfterMs: null };
    }
    if (!res.ok) {
      /* THE ONE VERDICT: a 401 naming one of our refusal codes. A 403 here is a platform's (the
         native refresh takes no CSRF), and an uncoded 401 or a 5xx is not a statement about this
         session — each is retried with the attempt's name, so a retry is a replay, not a reuse. */
      const code = await envelopeCode(res);
      if (res.status === 401 && code !== null && REFUSAL_CODES.has(code)) return { kind: "refused", code };
      return {
        kind: "fault", state: "renewing", code: code ?? `http_${res.status}`,
        retryAfterMs: retryAfterMs(res, now().getTime()),
      };
    }
    let wire: { tokens?: { accessToken?: string; refreshToken?: string; expiresIn?: unknown } };
    try {
      wire = (await res.json()) as typeof wire;
    } catch {
      return { kind: "fault", state: "renewing", code: "unreadable_response", retryAfterMs: null };
    }
    const next = wire.tokens;
    if (!next?.accessToken || !next?.refreshToken) {
      return { kind: "fault", state: "renewing", code: "no_token_pair", retryAfterMs: null };
    }
    // THE ATTEMPT IS ANSWERED, and the pair that replaces it carries no name — one seal write, so
    // there is no window where a fresh token stands beside a spent attempt's name.
    tokens = { accessToken: next.accessToken, refreshToken: next.refreshToken };
    /* A refusal HERE leaves the disk one rotation behind, holding the spent token beside the name
       that spent it — which the server answers as a replay of that attempt, so the next launch
       resumes. The next renewal cannot move further ahead: its own name must land first. */
    await persist(tokens,
      "the renewed session could not be written to disk; the saved one resumes it on the next launch");
    const expiresIn = typeof next.expiresIn === "number" && next.expiresIn > 0 ? next.expiresIn * 1000 : null;
    return { kind: "minted", expiresInMs: expiresIn };
  };

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number, retry: boolean): void => {
    if (stopped) return;
    clearTimer();
    timerIsRetry = retry;
    timer = setTimeout(() => {
      timer = null;
      void renewOnce();
    }, delayMs);
    timer.unref?.();
  };

  const report = (state: CloudSessionState, code: string | null, retryInMs: number | null): void => {
    const changed = reading.state !== state || reading.code !== code;
    if (changed) reading = { state, code, since: now().toISOString() };
    if (!changed && retryInMs === null) return;
    try {
      cfg.onSessionState?.(reading, { attempt: faults, retryInMs });
    } catch {
      /* a listener must not break the renewal it is told about */
    }
  };

  /** Apply one renewal's outcome: the state, and the ONE timer that follows from it. */
  const settle = (r: Renewal): void => {
    if (stopped) return;
    if (r.kind === "minted") {
      faults = 0;
      report("live", null, null);
      if (r.expiresInMs !== null) {
        schedule(Math.round(r.expiresInMs * (RENEW_AHEAD_FRACTION + (random() - 0.5) * 0.1)), false);
      }
      return;
    }
    if (r.kind === "refused") {
      clearTimer();
      report("refused", r.code, null);
      tellSessionRefused(r.code);
      return;
    }
    faults += 1;
    const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(faults - 1, 16));
    const delay = r.retryAfterMs ?? Math.round(backoff * (0.5 + random() / 2));
    report(r.state, r.code, delay);
    schedule(delay, true);
  };

  const renewOnce = (): Promise<Renewal> => {
    // `??=` is the single-flight: the first caller installs the promise, everyone else awaits it,
    // and `finally` clears it so the NEXT renewal starts a fresh one.
    renewing ??= refresh()
      .catch((): Renewal => ({ kind: "fault", state: "renewing", code: "renewal_threw", retryAfterMs: null }))
      .then((r) => {
        settle(r);
        return r;
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };

  const withBearer = (init: RequestInit | undefined, access: string): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${access}`);
    return { ...init, headers };
  };

  const discard = (res: Response): void => {
    void res.body?.cancel().catch(() => undefined);
  };

  const authedFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const sentWith = tokens.accessToken;
    const res = await fetchImpl(`${base}${path}`, withBearer(withDeadline(init), sentWith));
    if (res.status !== 401) return res;
    /* A 401 HERE SAYS THE ACCESS TOKEN IS STALE, never that the session is over — only the
       refresh door says that. So: a session already refused answers as it is; a token renewed
       while this was in flight is simply used; a fault already being retried on its own clock
       is not hurried by every request that meets it; anything else joins the one renewal. */
    if (reading.state === "refused") return res;
    const again = (): Promise<Response> =>
      fetchImpl(`${base}${path}`, withBearer(withDeadline(init), tokens.accessToken));
    if (tokens.accessToken !== sentWith) {
      discard(res);
      return again();
    }
    if (timer !== null && timerIsRetry) {
      discard(res);
      return offlineResponse();
    }
    const r = await renewOnce();
    if (r.kind === "refused") return res;
    discard(res);
    return r.kind === "minted" ? again() : offlineResponse();
  };

  return {
    authedFetch,
    currentTokens: () => tokens,
    sealState: () => ({ sealed: sealFailure === null, reason: sealFailure }),
    session: () => reading,
    renewNow: async () => {
      if (stopped || reading.state === "refused") return reading;
      clearTimer();
      await renewOnce();
      return reading;
    },
    stop: () => {
      stopped = true;
      clearTimer();
    },
  };
}
