/**
 * Which address is the server, and where on it is the API? Hosted and desktop-host serve the API
 * at the origin's root; a self-host stack's Caddy routes `/api/*` plus a few bare paths
 * (`/hello`, `/pair/*`, `/auth/*`) to the API and everything else — `/sync` included — to the
 * web container's HTML 404. So the base is measured, not derived (a QR carries no door):
 * {@link resolveApiBase} probes `<origin>/sync`, then `<origin>/api/sync`, credential-free; the
 * API answers 401 JSON, a Next 404 is text/html (measured 2026-09-01). The bare probe is tried
 * first and wins, so working doors keep their origin; `/hello`, `/pair/*` and `/auth/*` stay on
 * the origin, and the measured base governs only the `/sync` family.
 */
/* The refusals this module returns are rendered on the address field, so they are copy and live
   in the deck. See `copy.en.ts`'s "transport & pairing refusals" block. */
import { Copy } from "../copy";
import { refuse, type Refusal } from "../refusal";
import { originNeedsPin } from "@ohmail/client-engine";
import {
  apiBaseFor,
  normalizeOrigin as strictOrigin,
} from "../../../sidecar/src/cloud-origin.js";
import type { FetchLike } from "./bearer";

/**
 * What a person may type into "your server's address", as an origin — or null. The engine's own
 * parse, imported rather than restated: two copies of an acceptance rule drift silently, so
 * `cloud-origin.ts` is written import-free precisely so both sides reach it and one mutation
 * reddens both suites. What it accepts, refuses and invents is documented there. The one line
 * worth repeating: `http:` is refused for anything but loopback, so the parse and
 * {@link import('./pairing').admitOrigin} cannot disagree about cleartext.
 */
export function parseServerAddress(typed: string): string | null {
  return strictOrigin(typed);
}

/** `<origin>/api` — {@link apiBaseFor}, re-exported so the screens keep one import. */
export { apiBaseFor };

/**
 * The first thing wrong with a typed address, as a sentence, or null when usable. One sentence
 * for every rejected shape: the parse refuses a path, query, fragment, embedded credentials, a
 * foreign scheme and cleartext to a network address — and somebody who typed one has not made
 * six different mistakes, they pasted something that is not the address they open ohmail at.
 * Naming the wanted shape helps more than naming the clause. The cleartext arm is separated
 * because it is the one refusal about safety rather than shape: `http://mail.lan` is perfectly
 * well-formed, and "does not look like an address" would be false.
 */
/**
 * The sentence for an address no certificate authority can vouch for — a numeric one on a
 * network. Named once because it is given from two places: an address that would need a pin gets
 * this whether typed as `https://` (refused outright) or `http://` (where "use https" leads
 * straight back here). One sentence, so the two paths cannot drift. `originNeedsPin` is the
 * engine's own predicate rather than an IP test written here — one rule about which addresses
 * need a pin, so the door cannot disagree with the seam (`admitOrigin`) that enforces it.
 */
const NEEDS_THE_CODE = (): Refusal => refuse("baseNeedsTheCode");

export function addressProblem(typed: string): Refusal | null {
  const trimmed = typed.trim();
  if (trimmed === "") return refuse("baseAddressMissing");
  const origin = parseServerAddress(trimmed);
  if (origin !== null) {
    /**
     * An address no certificate authority can vouch for is refused here, early, with the useful
     * sentence. A typed IP literal parses fine and is an ordinary thing to type; `originNeedsPin`
     * says such an origin is only trusted through a pin, which comes from the code the computer
     * shows — never from a typed address. Without this arm the door would probe it, fail at the
     * TLS handshake, and say the server could not be reached — true and useless. The remedy
     * belongs at the field that accepted the address, not three steps later. The engine's own
     * predicate, not a second IP test: one rule, so door and seam cannot disagree.
     */
    if (originNeedsPin(origin)) return NEEDS_THE_CODE();
    return null;
  }
  /**
   * Was the scheme the actual reason? Answering from the scheme alone lies: `http://localhost/path`
   * is refused for its path — cleartext to loopback is allowed, so `http://localhost:8080` parses
   * fine — and "give the https address" would not fix it. The discriminator is the imported parse
   * itself, not a loopback test written here: swap the scheme and ask again. If the https spelling
   * parses, the scheme was the only fault and the safety sentence is true; if not, the shape
   * sentence is the honest one. No clause of the acceptance rule is restated — the property the
   * census holds.
   */
  const httpsSpelling = /^http:\/\//i.test(trimmed)
    ? parseServerAddress(trimmed.replace(/^http:/i, "https:"))
    : null;
  if (httpsSpelling !== null) {
    /**
     * The remedy has to survive being taken. "Give the https address" is right for
     * `http://mail.example.com` and useless for `http://192.168.1.20`: the https spelling of a
     * numeric address parses, so this branch used to offer it, and typing exactly what it asked
     * for hit `originNeedsPin` and was refused again — a remedy that leads to a second refusal is
     * worse than none. So the same predicate that will judge the https spelling is asked here,
     * about that spelling, before it is recommended.
     */
    if (originNeedsPin(httpsSpelling)) return NEEDS_THE_CODE();
    return refuse("baseCleartext");
  }
  return refuse("baseNotAnAddress");
}

/** The route the derivation probes. Authenticated on every ohmail table, so a bare GET 401s. */
const PROBE_PATH = "/sync";

/**
 * How long one candidate may hold the pairing. A server that accepts the connection and never
 * answers is not a failure any `await` ends, and this probe runs inside `pairWithServer`, which
 * a screen awaits behind a "Pairing…" label — an unbounded wait here is a pairing that hangs
 * forever. The same number as `IDENTITY_PROBE_DEADLINE_MS`, deliberately: far above any healthy
 * round trip, far below "the app never gets anywhere". A timed-out candidate counts as a
 * transport failure, not a definitive answer — nothing was learned, so the other candidate is
 * still tried. Not a fix for the whole ceremony: `negotiate` and the redeem have no deadline
 * either, pre-existing; this closes only the unbounded await this file would otherwise add.
 */
export const PROBE_DEADLINE_MS = 8000;

/** What one bounded probe concluded. Thrown instead when nothing was concluded at all. */
type ProbeAnswer = "api" | "not-api";

/**
 * Thrown by {@link probeCandidate} when the deadline fired.
 *
 * `afterHeaders` is not a detail — it is the difference between two sentences that are each false
 * of the other's case. Headers that arrived and a body that never finished IS a server that
 * accepted the connection and began answering. A deadline that fires with no headers at all may be
 * DNS, a TCP connect or a TLS negotiation hanging silently, and claiming acceptance there would
 * point an operator at their proxy for what is a connectivity problem (review round 4).
 */
class ProbeTimeout extends Error {
  constructor(message: string, readonly afterHeaders: boolean) {
    super(message);
    this.name = "ProbeTimeout";
  }
}

/**
 * One probe, bounded end to end — the fetch and the body read under a single deadline. Bounding
 * only the fetch leaves a hole: a server that returns `401 application/json` headers inside the
 * deadline and then never finishes the body stalls the pairing one layer further in, with the
 * timer already cleared. So the whole question — "did an ohmail API answer this URL?" — runs
 * inside one controller and one timer, and the abort covers the body stream too. Cancels through
 * `AbortSignal` where the platform honours it and falls back to a race where it does not; the two
 * free different things — an honoured signal frees the socket, a race frees only the caller. Where
 * only the race fires, the abandoned fetch's response is still released rather than left holding a stream.
 */
async function probeCandidate(
  fetchImpl: FetchLike,
  requested: string,
  deadlineMs: number,
): Promise<ProbeAnswer> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  /** The deadline fired. Read in the catch — see the error-type note there. */
  let expired = false;
  /** The response whose HEADERS arrived, or null. Decides {@link ProbeTimeout.afterHeaders}. */
  let headed: Response | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      /* REJECT BEFORE ABORTING, and the order is review round 4's second finding rather than a
         style choice: `abort()` can SYNCHRONOUSLY reject the in-flight fetch with an `AbortError`,
         and whichever rejection reaches the race first decides which error the caller sees. With
         the abort first, a server that simply withheld its answer produced an `AbortError`, which
         the loop recorded as a TRANSPORT failure — so the deadline's own sentence was bypassed and
         the person was told the server could not be reached. The `expired` flag below makes the
         outcome independent of the ordering anyway; this just stops relying on it. */
      reject(new ProbeTimeout(`no answer from ${requested} within ${deadlineMs}ms`, headed !== null));
      controller?.abort();
    }, deadlineMs);
  });
  /**
   * This promise always has a handler, even if nothing ever races it. `fetchImpl` is a seam and
   * can throw synchronously (a transport rejecting a malformed URL, a test double, a missing
   * platform binding): the throw propagates correctly, but the timer is already armed and its
   * firing would reject a promise nobody awaits — an unhandled rejection, a red box in RN dev.
   * The no-op handler does not swallow the rejection the race sees; that race attaches its own.
   * Deliberately redundant with the fetch's placement inside the try: removing either alone
   * changes nothing, removing both leaves an unhandled rejection, so the pair is only meaningful
   * tested together.
   */
  void timedOut.catch(() => undefined);

  /* `redirect: "manual"` — see {@link answeredByApi}'s redirect note. Honoured where the platform
     honours it; the guards there are what hold when it is not.

     INSIDE the try below rather than before it, for the same round-5 finding: a synchronous throw
     from the seam must still reach the `finally` that clears the timer. */
  try {
    const inFlight = fetchImpl(requested, {
      redirect: "manual",
      ...(controller ? { signal: controller.signal } : {}),
    });
    /* THE ABANDONED RESPONSE IS STILL LET GO. If the platform ignores the abort, this fetch outlives
       the race it lost; when it eventually resolves, nothing was going to consume its body. Attached
       here rather than in a `finally`, because the whole point is that it may land long after this
       function has returned. */
    void inFlight.then(
      (res) => { if (settled) letGo(res); },
      () => undefined,
    );

    const res = await Promise.race([inFlight, timedOut]);
    headed = res;
    try {
      /* The body read is INSIDE the race too — round 3's first finding. `answeredByApi` reads it,
         so the race is around the classification rather than around the fetch. */
      return (await Promise.race([answeredByApi(res, requested), timedOut])) ? "api" : "not-api";
    } catch (err) {
      /**
       * The body read lost to the deadline and this response is orphaned — the `settled` handler
       * on `inFlight` resolved while `settled` was still false, so its callback did nothing.
       * `letGo` is the belt, not the fix: `res.json()` has locked the body by the time the
       * deadline fires, and `cancel()` on a locked stream throws — which `letGo` swallows, a
       * no-op in exactly this case. What frees a stalled body is the `abort()` the timer already
       * fired; a platform that ignores the signal leaks the stream until collection, the same
       * residual the abandoned-fetch case has. The call stays because the other rejection paths
       * reach `letGo` before anything is locked, and one release function is worth the no-op arm.
       */
      letGo(res);
      throw err;
    }
  } catch (err) {
    /* THE DEADLINE'S OWN ERROR, WHATEVER SURFACED — round 4's second finding. An abort that beat
       the timer's own rejection would otherwise arrive as an `AbortError` and be classified as a
       transport failure, which is the one shape that produces a false "could not reach" sentence
       about a server that answered nothing but was perfectly reachable. */
    if (expired) {
      throw new ProbeTimeout(
        `no answer from ${requested} within ${deadlineMs}ms`,
        headed !== null,
      );
    }
    throw err;
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

/**
 * Let go of a response this function is not going to read. A rejected candidate's body otherwise
 * sits holding a socket and native buffers; two probes per pairing makes that small, and small is
 * not a reason to leave a stream open. Best-effort in both directions: `body` is absent on
 * platforms with no streams (React Native's fetch, on some versions), and `cancel()` can reject
 * on a stream that is already done — neither is a reason to fail a probe that has answered.
 */
function letGo(res: Response): void {
  try {
    void res.body?.cancel().catch(() => undefined);
  } catch {
    /* no streams on this platform, or already released */
  }
}

/**
 * Did this answer come from the exact URL that was asked? Comparing origins leaves a gap: a
 * same-origin redirect passes an origin check, so `<origin>/sync` answering `302 → /api/sync`
 * would validate the bare candidate on the prefixed one's answer — and later requests pay, since
 * a proxy that redirects `/sync` need not redirect `/sync/snapshot`, and a 301/302 turns an
 * authenticated POST into a GET. The whole URL is compared, both sides through `new URL`, so a
 * platform reporting a normalized form still compares equal. An empty final URL answers `true`:
 * "no information" must not reject every response — see the residual in {@link answeredByApi}.
 */
function answeredFromRequest(finalUrl: string, requested: string): boolean {
  if (finalUrl === "") return true;
  try {
    return new URL(finalUrl).href === new URL(requested).href;
  } catch {
    return false;
  }
}

/**
 * Did this response come from an ohmail API at the address asked? The test is the API's refusal
 * envelope, nothing looser: 401 + `application/json` + `{"error":{"code":"unauthorized"}}`, status
 * and code compared exactly — a proxy's JSON 404 must not pick a base whose every drain 404s. The
 * signal is self-asserted; a forger must sit on the very origin the person chose, never
 * cross-origin (a base is only `<origin>` or `<origin>/api`). An `X-Request-Id`/`no-store` check
 * would refuse the desktop-host door, which sends neither. Redirects get three incomplete guards —
 * `redirect: "manual"`, `Response.redirected`, {@link answeredFromRequest}'s exact-URL check; the
 * stored base is never a redirect target, and the issued request is the residual — bounded: `/hello` already dialled this origin.
 */
async function answeredByApi(res: Response, requested: string): Promise<boolean> {
  /* Every rejection below lets the body go — see {@link letGo}. Only the arm that READS the body
     does not, because reading it is releasing it. */
  if (res.status !== 401) { letGo(res); return false; }
  /* `redirected` is the third guard and the cheapest: a platform that followed a redirect and SAYS
     so is caught here even if it reports no final URL. Compared strictly to `true`, so a platform
     that does not set the field at all (RN, on some versions) is not thereby refused. */
  if ((res as { redirected?: boolean }).redirected === true) { letGo(res); return false; }
  if (!answeredFromRequest(res.url ?? "", requested)) { letGo(res); return false; }
  if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    letGo(res);
    return false;
  }
  try {
    /* `?.` ON THE BODY ITSELF, not only on `error` — review round 7. `null` is valid JSON, so a
       401 whose body is literally `null` (or a number, or a string) parses fine and then throws a
       `TypeError` on the property access. Under the discrimination below a thrown TypeError is a
       TRANSPORT failure, so two fully received responses could produce "could not reach that
       server". A body that parsed and is not the envelope is a DISPROOF, which is what this now
       answers. */
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    return body?.error?.code === "unauthorized";
  } catch (err) {
    /**
     * A parse failure is an answer; a transfer failure is not. Body bytes that arrived and did
     * not parse are a disproof — whatever that was, it is not the API's envelope. A connection
     * that reset mid-body disproves nothing: the API may be exactly here, and calling it a
     * disproof produced the sentence saying both addresses were ruled out, sending an operator to
     * change proxy routing that was already correct. `SyntaxError` is the platform's own
     * discrimination — `Response.json()` rejects with one for malformed JSON and a `TypeError`
     * for a failed transfer; anything that is not a parse error is re-thrown for the caller to
     * classify as transport.
     */
    if (err instanceof SyntaxError) return false;
    throw err;
  }
}

export type BaseVerdict =
  /** The base every `/sync`-family request must be composed against. */
  | { kind: "base"; base: string; prefixed: boolean }
  /** Nothing at this address answers as an ohmail API. `reason` is showable. */
  | { kind: "refused"; reason: Refusal };

/**
 * Where the API is on this origin — the bare root, or behind `/api`. Called once, at pairing
 * time, before the single-use token is spent: a server whose API cannot be found is a refusal
 * that costs nothing, and finding out after the burn leaves somebody holding a dead code. The
 * answer is stored on the profile
 * ({@link import('../state/servers').ServerProfile.apiBase}), so no launch pays for this and the
 * boot still owes the wire nothing. Both probes carry no credential: this runs before the
 * redeem, so there is none — and a probe that needed one could not decide where to send it.
 */
export async function resolveApiBase(
  fetchImpl: FetchLike,
  origin: string,
  /**
   * Override the per-candidate deadline (tests). Absent, {@link PROBE_DEADLINE_MS}.
   *
   * The same seam `ConnectConfig.identityDeadlineMs` provides one module over, for the same reason:
   * a deadline can only be proven by a server that never answers, and a suite that pays the real
   * eight seconds twice per such case is a suite people stop running. A case still pins the DEFAULT,
   * so the override cannot quietly become the shipped value.
   */
  opts: { deadlineMs?: number } = {},
): Promise<BaseVerdict> {
  const deadlineMs = opts.deadlineMs ?? PROBE_DEADLINE_MS;
  const bare = origin.replace(/\/+$/, "");
  const prefixed = apiBaseFor(bare);

  /* THE BARE PATH FIRST, AND THE ORDER IS THE COMPATIBILITY GUARANTEE. Managed and desktop-host
     answer here, so they keep the base they have always used and this file changes nothing about
     them. A deployment that answers BOTH (the hosted service does — it canonicalizes one leading
     `/api` off itself) resolves to the bare origin, which is the value already in every stored
     profile: no existing pairing's base moves. */
  const transportFailures: string[] = [];
  /**
   * Did any candidate produce a response at all — was the server reached? One candidate throwing
   * (a redirect to an unreachable target, a reset on one route) while the other answers
   * definitively means the server was reached, so "could not reach that server" would be false —
   * and a false sentence `isPinFailure` may dress up as "this computer's identity has changed",
   * sending somebody after a key that never changed. A genuine pin or handshake failure fails
   * both candidates (one socket, one certificate), so this flag separates the case the transport
   * sentence is for from the case it is not.
   */
  let reached = false;
  /**
   * A candidate that timed out — the server accepted and did not finish answering. A server that
   * withholds headers on both candidates would otherwise leave `reached` false, firing "could not
   * reach that server" about a server that accepted two connections — pointing somebody at their
   * network or, through `isPinFailure`, at a certificate, when the fault is a route that hangs.
   * A timeout is neither a transport failure nor a reach: its own fact, with its own sentence,
   * the one that names what to look at.
   */
  let stalled = false;
  /**
   * Did a stall happen AFTER headers arrived? See {@link ProbeTimeout.afterHeaders}: only then is
   * "that server accepted the connection and began answering" a true sentence. A deadline that
   * fires with nothing received may be DNS, a connect or a TLS negotiation hanging, and pointing an
   * operator at their proxy for that is the same class of misdirection as the reachability one.
   */
  let stalledAfterHeaders = false;
  for (const candidate of [bare, prefixed]) {
    let answer: ProbeAnswer;
    try {
      answer = await probeCandidate(fetchImpl, `${candidate}${PROBE_PATH}`, deadlineMs);
    } catch (err) {
      if (err instanceof ProbeTimeout) {
        stalled = true;
        if (err.afterHeaders) {
          /* HEADERS ARRIVED, SO THE SERVER WAS REACHED — round 4's third finding. Without this a
             candidate that answered its headers and then stalled left `reached` false, and a
             transport failure on the OTHER candidate then produced "could not reach that server"
             about a server whose headers this app had in hand. */
          reached = true;
          stalledAfterHeaders = true;
        }
        continue;
      }
      /**
       * A transport failure on one candidate no longer ends the search. "The same socket and
       * certificate serve both" is true of DNS and a handshake and not in general — a reset on
       * one path or a redirect to an unreachable host would refuse a good self-hosted server
       * before its `/api` candidate was tried. The failure is remembered and the next candidate
       * tried; only if nothing answers as the API does a remembered failure become the sentence —
       * the first one, whose words the caller may recognise as a pin failure.
       */
      transportFailures.push(String(err));
      continue;
    }
    reached = true;
    if (answer === "api") {
      return { kind: "base", base: candidate, prefixed: candidate === prefixed };
    }
  }

  /* THE TRANSPORT SENTENCE ONLY WHERE NOTHING WAS REACHED — see {@link reached}. It is the more
     specific fact where it is true ("the connection did not happen"), it carries the platform's own
     words, and it is the only one of the two that `isPinFailure` can recognise, which is what lets
     a changed desktop key read as a changed key rather than as a missing API. Where the server DID
     answer on one candidate, that sentence would be false and the generic one below is the honest
     description of what happened. */
  if (!reached && transportFailures.length > 0) {
    return {
      kind: "refused",
      reason: refuse("baseApiUnreachable", transportFailures[0]!),
    };
  }

  /* A STALL IS ITS OWN ANSWER — see {@link stalled}. Below the transport arm because a run that had
     both a hard failure and a stall was, at least once, genuinely unable to connect; above the two
     below because a route that never answered has not been disproved, and both of those sentences
     are about candidates that were. */
  if (stalled) {
    return {
      kind: "refused",
      reason: refuse(stalledAfterHeaders ? "baseApiStopped" : "baseApiTimeout"),
    };
  }

  /**
   * A mixed result must not claim both candidates were disproved. One candidate answering
   * definitively (not as the API) while the other fails at the transport used to reach the
   * generic "neither at the address itself nor under /api" — false, since the failed candidate
   * was never classified and may be exactly where the API is; a transient reset read as a proxy
   * misconfiguration sends an operator to change routing that was right. Reaching here means
   * `reached` is true, so this is precisely the mixed case: one address answered, one did not,
   * and the sentence says both halves.
   */
  if (transportFailures.length > 0) {
    return {
      kind: "refused",
      reason: refuse("baseApiMixed", transportFailures[0]!),
    };
  }

  /* BOTH CANDIDATES WERE CLASSIFIED AND NEITHER WAS THE API — the only state in which "neither" is
     a true word, which is what the two arms above exist to protect. */
  return {
    kind: "refused",
    reason: refuse("baseApiNotFound"),
  };
}
