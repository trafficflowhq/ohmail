/**
 * ═══ WHICH ADDRESS IS THE SERVER, AND WHERE ON IT IS THE API ═══════════════════════════════════
 *
 * Two questions the phone's doors ask that its pairing seam never had to, because until there was
 * a self-hosted door every origin this app could reach served the API at its own root:
 *
 *  · **the hosted service** has a whole hostname to itself — `https://api.ohmail.app/sync` IS the
 *    API;
 *  · **a desktop host** serves its route table directly on the address it binds, with no proxy in
 *    front and no prefix — `https://<tailnet-or-lan>/sync` IS the API;
 *  · **a self-host stack** serves ONE origin, and the browser client, the landing pages and the
 *    API all sit behind one Caddy site. Its `@api` matcher (`deploy/selfhost/Caddyfile`) routes
 *    `/api/*` to the API container plus a named handful of bare paths — `/hello`, `/pair`,
 *    `/pair/*`, `/auth`, `/auth/*`, `/health`, `/events`, `/internal*` — and EVERYTHING ELSE to
 *    the web container. `/sync` is not in that list. So `https://<origin>/sync` reaches the Next
 *    app, which answers a 404 HTML error page.
 *
 * ── THE DEFECT THIS CLOSES, WHICH THE PHONE SHIPPED ────────────────────────────────────────────
 *
 * `bootEngine` composes `HttpAdapter({ baseUrl: origin })` from the profile's origin. Pairing to a
 * self-host stack therefore got the whole way in — `/hello` answers, `/pair/redeem` answers,
 * `/auth/session` answers, so the pairing SUCCEEDS and names a real account — and then mirrored
 * nothing, for ever, with an HTML 404 as the only clue. That is verbatim the failure
 * `apps/sidecar/src/cloud-origin.ts` describes for a door that uses the typed origin as its base;
 * the desktop's third door closed it with `apiBaseFor`, and the phone had the identical hole
 * behind a different entry screen.
 *
 * ── WHY THE PHONE MEASURES THE BASE INSTEAD OF DERIVING IT FROM THE DOOR ───────────────────────
 *
 * The desktop can derive: its self-hosted arm is a door of its own, so the code that composes
 * `<origin>/api` is only ever reached for a server the person said was self-hosted.
 *
 * A phone cannot. Its credential arrives as a QR carrying `${origin}/pair#${token}`, and a QR
 * carries no door — somebody standing in front of a self-host setup page scans the same shape a
 * desktop's Devices pane shows. A door-driven derivation would be correct for the address the
 * chooser typed and wrong for the identical server reached by camera, which is the more common
 * gesture. Branching on `/hello`'s `flavor` would be closer, and still a guess about a
 * deployment's routing read off a label rather than from the routing.
 *
 * So {@link resolveApiBase} ASKS. It probes `<origin>/sync` with no credential and reads whether
 * the answer came from the API; if it did not, it probes `<origin>/api/sync` the same way. The
 * discriminator is the measurement `cloud-origin.ts` records rather than a new invention, and it
 * is made by the client instead of assumed about the deployment:
 *
 *   MEASURED 2026-09-01 against the live hosted service —
 *     `GET https://api.ohmail.app/sync`      → 401 `{"error":{"code":"unauthorized",…}}` (JSON)
 *     `GET https://api.ohmail.app/api/sync`  → 401 `{"error":{"code":"unauthorized",…}}` (JSON)
 *   and recorded by the desktop's door lane against a live self-host stack —
 *     `GET https://ohmail.test/sync`         → 404 text/html, from the Next app
 *     `GET https://ohmail.test/api/sync`     → 401 JSON, from the API
 *
 * The bare probe is tried FIRST and wins, which is what makes this change inert on both doors
 * that already work: managed and desktop-host answer it from the API and keep the origin as their
 * base, byte for byte what they used before this file existed. Only the deployment that 404s the
 * bare path takes the prefix, and it is the only one that was broken.
 *
 * ── AND WHAT STAYS ON THE ORIGIN ───────────────────────────────────────────────────────────────
 *
 * `/hello`, `/pair/redeem`, `/auth/refresh`, `/auth/logout` and `/auth/session`. Every one of them
 * is routed at the bare path on all three deployments — the Caddyfile names them explicitly, the
 * hosted service has no prefix to speak of, and the desktop host serves its table unproxied — and
 * every one of them demonstrably works today. Moving a request that works onto a base this file
 * has just computed would be churn on the credential path for no measured gain, so the seam keeps
 * them where they are and this base governs exactly the `/sync` family, which is exactly what was
 * measured to need it.
 */
import { originNeedsPin } from "@ohmail/client-engine";
import {
  apiBaseFor,
  normalizeOrigin as strictOrigin,
} from "../../../sidecar/src/cloud-origin.js";
import type { FetchLike } from "./bearer";

/**
 * WHAT A PERSON MAY TYPE INTO "your server's address", AS AN ORIGIN — or null.
 *
 * The ENGINE's own parse, imported by relative path rather than restated. That is
 * `credential-host.ts`'s rule and it holds here for the same reason: two copies of a rule about
 * which addresses are acceptable drift, and the drift is silent — a phone that accepted a shape
 * the desktop's comparison then read differently. `cloud-origin.ts` is written import-free
 * precisely so both sides can reach it, and one mutation reddens both suites.
 *
 * What it accepts, refuses and invents is documented there and not paraphrased here. The one line
 * worth repeating, because this app's own transport gate says it too: `http:` is refused for
 * anything but loopback, so the parse and {@link import('./pairing').admitOrigin} cannot disagree
 * about cleartext.
 */
export function parseServerAddress(typed: string): string | null {
  return strictOrigin(typed);
}

/** `<origin>/api` — {@link apiBaseFor}, re-exported so the screens keep one import. */
export { apiBaseFor };

/**
 * The first thing wrong with a typed address, as a sentence, or null when it is usable.
 *
 * ONE sentence for every rejected shape, which is the desktop door's judgment and not laziness:
 * the parse refuses a path, a query, a fragment, embedded credentials, a foreign scheme and
 * cleartext to a network address, and somebody who typed one of those has not made six different
 * mistakes — they have pasted something that is not the address they open ohmail at. Naming the
 * SHAPE that is wanted is more use than naming the clause that rejected them.
 *
 * The cleartext arm is separated because it is the one refusal that is about SAFETY rather than
 * shape, and a person who typed `http://mail.lan` has typed a perfectly well-formed address that
 * this app will not use. Telling them it "does not look like an address" would be false.
 */
export function addressProblem(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === "") return "Your server's address is missing.";
  const origin = parseServerAddress(trimmed);
  if (origin !== null) {
    /**
     * AN ADDRESS NO CERTIFICATE AUTHORITY CAN VOUCH FOR IS REFUSED HERE, EARLY, WITH THE USEFUL
     * SENTENCE — and this arm is the one that stops a correct refusal from arriving as a vague one.
     *
     * A typed IP literal parses perfectly well and is a perfectly ordinary thing to type: it is the
     * address a router handed a computer on the same network. `originNeedsPin` says such an origin
     * can only ever be trusted through a pin, and a pin comes from the code the computer shows —
     * never from an address somebody typed, because a fingerprint is 43 characters nobody will
     * enter correctly. `admitOrigin` refuses it at pairing time and says exactly that.
     *
     * Without this arm the door would probe it first, and the probe would fail at the TLS handshake
     * — so the person would be told the server could not be reached, which is true and useless, for
     * an address that is right and a method that is wrong. The remedy sentence belongs at the field
     * that accepted the address, not three steps later.
     *
     * `originNeedsPin` is the engine's own predicate rather than a second IP test here, for the
     * reason the parse is imported rather than restated: one rule about which addresses need a pin,
     * and the door cannot come to disagree with the seam that enforces it.
     */
    if (originNeedsPin(origin)) {
      return (
        "That is a numeric address on a network, and no certificate authority can vouch for one — " +
        "so ohmail can only trust it through the code your computer shows. Open Settings → " +
        "Devices there and scan that instead."
      );
    }
    return null;
  }
  if (/^http:\/\//i.test(trimmed)) {
    return (
      "That is a plain, unencrypted address, and ohmail will not send your mail over one. " +
      "Give the https address you open ohmail at in a browser."
    );
  }
  return (
    "That does not look like a server address. Give the address you open ohmail at in a " +
    "browser — for example https://ohmail.example.com — with nothing after the host."
  );
}

/** The route the derivation probes. Authenticated on every ohmail table, so a bare GET 401s. */
const PROBE_PATH = "/sync";

/**
 * HOW LONG ONE CANDIDATE MAY HOLD THE PAIRING, and why a deadline is not optional here.
 *
 * Raised by review round 2, and it is the same hazard `IDENTITY_PROBE_DEADLINE_MS` exists for one
 * module over: a server that ACCEPTS the connection and never answers is not a failure any `await`
 * ends. This probe runs inside `pairWithServer`, which a screen awaits behind a "Pairing…" label,
 * so an unbounded wait here is a pairing that hangs for ever — and on a self-host stack the bare
 * `/sync` is served by a component that is not the API, which is exactly the sort of route that
 * can be misconfigured into never answering.
 *
 * The same number as the identity probe's, deliberately, and for the same reason stated there:
 * far above any healthy round trip, far below "the app never gets anywhere". A timed-out candidate
 * counts as a TRANSPORT failure rather than as a definitive answer, because nothing was learned —
 * so the other candidate is still tried.
 *
 * NOT A FIX FOR THE WHOLE CEREMONY: `negotiate` and the redeem around this call have no deadline
 * either, and that is pre-existing rather than addressed here. What this closes is the unbounded
 * await this slice would otherwise have ADDED.
 */
const PROBE_DEADLINE_MS = 8000;

/**
 * One probe, bounded. Cancels through `AbortSignal` where the platform honours it and falls back to
 * a race where it does not — belt and braces on purpose, because the two failure modes are
 * different: an honoured signal frees the socket, while the race only frees the CALLER. Rejects on
 * a timeout, so the loop treats it as a transport failure and tries the other candidate.
 */
async function probeOnce(fetchImpl: FetchLike, url: string): Promise<Response> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`no answer from ${url} within ${PROBE_DEADLINE_MS}ms`));
    }, PROBE_DEADLINE_MS);
  });
  try {
    /* `redirect: "manual"` — see {@link answeredByApi}'s redirect note. Honoured where the platform
       honours it; the guards there are what hold when it is not. */
    return await Promise.race([
      fetchImpl(url, {
        redirect: "manual",
        ...(controller ? { signal: controller.signal } : {}),
      }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Let go of a response this function is not going to read.
 *
 * Review round 2's third finding: a rejected candidate's body was never consumed and never
 * cancelled, so the stream could sit holding a socket and native buffers. Two probes per pairing
 * makes that small, and it is free to close, and "small" is not a reason to leave a stream open.
 *
 * Best-effort in both directions: `body` is absent on platforms with no streams (React Native's
 * fetch, on some versions, is one), and `cancel()` can reject on a stream that is already done —
 * neither is a reason to fail a probe that has already answered its question.
 */
function letGo(res: Response): void {
  try {
    void res.body?.cancel().catch(() => undefined);
  } catch {
    /* no streams on this platform, or already released */
  }
}

/**
 * Same scheme, host and port — used to refuse an answer that came from somewhere else.
 * `null`/empty input answers `true`, because "no information" must not reject every response;
 * see the redirect note in {@link answeredByApi}.
 */
function answeredFromCandidate(finalUrl: string, candidate: string): boolean {
  if (finalUrl === "") return true;
  try {
    return new URL(finalUrl).origin === new URL(candidate).origin;
  } catch {
    return false;
  }
}

/**
 * DID THIS RESPONSE COME FROM AN OHMAIL API AT THE ADDRESS THAT WAS ASKED?
 *
 * The API's refusal envelope, and nothing looser: an unauthenticated `GET /sync` is answered
 * `401`, `application/json`, `{"error":{"code":"unauthorized",…}}` by all three route tables,
 * because all three are the same request guard. A Next 404 page is `text/html` and parses as
 * nothing.
 *
 * The STATUS is checked as well as the shape because a JSON 404 is exactly what a proxy in front
 * of a stack that does NOT route this path may answer, and reading that as "the API is here" would
 * pick a base whose every drain 404s — the failure this whole file exists to close, one layer in. A
 * 401 is the API saying "this route is mine and you have no session", which is the only answer that
 * establishes both halves.
 *
 * The CODE is checked exactly, not merely for being a string. Review raised the looser form: any
 * `{"error":{"code":<anything>}}` satisfied it, so a component that is not the API but answers in a
 * JSON-error idiom could claim the path. `"unauthorized"` is what the guard actually says.
 *
 * ── THE RESIDUAL, STATED RATHER THAN CLOSED ────────────────────────────────────────────────────
 *
 * This signal is SELF-ASSERTED, and no unauthenticated request can do better. Something serving
 * `/sync` at a base could forge that exact refusal and take the bearer that follows.
 *
 * What bounds it is WHO could: the forger has to be answering on the origin the person typed or
 * scanned — the same host, behind the same certificate, that they have already chosen to hold their
 * whole mailbox. So the reachable harm is one component of the operator's own box getting traffic
 * another component of it should have had. It is not a cross-origin escalation: a base is only ever
 * `<origin>` or `<origin>/api`, never an address this function was not given.
 *
 * A REQUEST-ID OR `no-store` HEADER CHECK WAS CONSIDERED AND REJECTED, and the reason is worth
 * recording because it looks like a free win. Both API hosts stamp `X-Request-Id` and
 * `Cache-Control: no-store` on every response (`apps/server/src/handler.ts`,
 * `apps/api-vercel/src/handler.ts`), and a Next error page carries neither — so requiring one would
 * genuinely harden this. But the DESKTOP-HOST door answers straight out of `app.handle` through
 * `host-listener.ts` with no such wrapper, so requiring either header would refuse the door that
 * works today in order to harden the one that did not work at all. Regressing a shipping door to
 * tighten a same-origin signal is the wrong trade.
 *
 * ── AND THE ANSWER MUST HAVE COME FROM THE ADDRESS THAT WAS ASKED ─────────────────────────────
 *
 * Also review's, and it is the sharper half. `fetch` follows redirects, so an origin could answer
 * the probe with a redirect to any other address — turning a credential-free GET into a request the
 * phone makes on somebody else's behalf, possibly to a name only this phone's network can resolve,
 * and letting the redirect TARGET satisfy the check above.
 *
 * THREE guards, and not one of them is complete on its own:
 *
 *  1. `redirect: "manual"` at the call, which suppresses the follow where the platform honours it
 *     (node's undici does; React Native's fetch does not on every version);
 *  2. `Response.redirected === true` — a platform that followed one and SAYS so is caught here even
 *     if it reports no final URL. Compared strictly, so a platform that does not set the field is
 *     not thereby refused;
 *  3. the response's final URL must still be on the candidate's origin.
 *
 * ── AND THE RESIDUAL, WHICH REVIEW ROUND 2 CALLED THE FIX INCOMPLETE FOR, SIZED HONESTLY ───────
 *
 * A platform that follows the redirect AND sets no `redirected` AND reports an empty `Response.url`
 * defeats all three. `Response.url` empty is read as "no information" rather than as a failure,
 * deliberately: a platform that reports no final URL for ORDINARY responses would otherwise have
 * every server refused, which is a total breakage traded for a partial guard.
 *
 * What that residual can and cannot do is worth stating exactly, because it is smaller than it
 * looks. The base stored is always `candidate` — `<origin>` or `<origin>/api`, the address the
 * person named — and NEVER the redirect's target, which this function does not carry anywhere. So
 * the reachable harm is choosing the wrong PATH on the right ORIGIN: the same bounded outcome as
 * the forged-refusal residual above.
 *
 * The larger-sounding worry — a bearer reaching the redirect's target — is not this probe's to
 * close and is not created by it: any authenticated request to an origin that redirects does that,
 * because the engine's own transport follows redirects too. That is a pre-existing property of
 * `HttpAdapter`, named here so it is not mistaken for something this file introduced or fixed.
 */
async function answeredByApi(res: Response, candidate: string): Promise<boolean> {
  /* Every rejection below lets the body go — see {@link letGo}. Only the arm that READS the body
     does not, because reading it is releasing it. */
  if (res.status !== 401) { letGo(res); return false; }
  /* `redirected` is the third guard and the cheapest: a platform that followed a redirect and SAYS
     so is caught here even if it reports no final URL. Compared strictly to `true`, so a platform
     that does not set the field at all (RN, on some versions) is not thereby refused. */
  if ((res as { redirected?: boolean }).redirected === true) { letGo(res); return false; }
  if (!answeredFromCandidate(res.url ?? "", candidate)) { letGo(res); return false; }
  if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    letGo(res);
    return false;
  }
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    return body.error?.code === "unauthorized";
  } catch {
    return false;
  }
}

export type BaseVerdict =
  /** The base every `/sync`-family request must be composed against. */
  | { kind: "base"; base: string; prefixed: boolean }
  /** Nothing at this address answers as an ohmail API. `reason` is showable. */
  | { kind: "refused"; reason: string };

/**
 * WHERE THE API IS ON THIS ORIGIN — the bare root, or behind `/api`.
 *
 * Called ONCE, at pairing time, before the single-use token is spent: a server whose API cannot
 * be found is a refusal that costs nothing, and finding out after the burn would leave somebody
 * holding a dead code. The answer is stored on the profile ({@link
 * import('../state/servers').ServerProfile.apiBase}), so no launch pays for this and the boot
 * still owes the wire nothing.
 *
 * Both probes carry NO credential, deliberately. This runs before the redeem, so there is none to
 * carry — and a probe that needed one could not be the thing that decides where to send it.
 */
export async function resolveApiBase(
  fetchImpl: FetchLike,
  origin: string,
): Promise<BaseVerdict> {
  const bare = origin.replace(/\/+$/, "");
  const prefixed = apiBaseFor(bare);

  /* THE BARE PATH FIRST, AND THE ORDER IS THE COMPATIBILITY GUARANTEE. Managed and desktop-host
     answer here, so they keep the base they have always used and this file changes nothing about
     them. A deployment that answers BOTH (the hosted service does — it canonicalizes one leading
     `/api` off itself) resolves to the bare origin, which is the value already in every stored
     profile: no existing pairing's base moves. */
  const transportFailures: string[] = [];
  /**
   * DID ANY CANDIDATE PRODUCE A RESPONSE AT ALL — i.e. was the server REACHED?
   *
   * Review round 2's fourth finding, and it is about which of two sentences is true rather than
   * about a crash. One candidate throwing (a redirect to an unreachable target, a reset on one
   * route) while the other answers definitively means the server WAS reached, so
   * "could not reach that server" is a false sentence — and a false sentence `isPinFailure` may
   * then dress up as "this computer's identity has changed", sending somebody to look for a key
   * that never changed.
   *
   * A genuine pin or handshake failure fails BOTH candidates, because they ride one socket and one
   * certificate — so this flag is exactly what separates the case the transport sentence is for
   * from the case it is not. That is the true version of the claim the first draft of this function
   * made about the whole loop.
   */
  let reached = false;
  for (const candidate of [bare, prefixed]) {
    let res: Response;
    try {
      res = await probeOnce(fetchImpl, `${candidate}${PROBE_PATH}`);
    } catch (err) {
      /**
       * A TRANSPORT FAILURE ON ONE CANDIDATE NO LONGER ENDS THE SEARCH.
       *
       * This returned immediately, under a comment claiming a transport failure is about the ORIGIN
       * rather than the path because "the same socket and the same certificate serve both". That is
       * true of DNS and of a handshake and NOT true in general — review named a reset on one path
       * and a redirect to an unreachable host, and either would have refused a perfectly good
       * self-hosted server before its `/api` candidate was ever tried. The claim was too strong for
       * the conclusion it was carrying.
       *
       * So the failure is remembered and the next candidate is tried. Only if nothing answers as
       * the API does a remembered failure become the sentence — and then it is the FIRST one, whose
       * words the caller may recognise as a pin failure.
       */
      transportFailures.push(String(err));
      continue;
    }
    reached = true;
    if (await answeredByApi(res, candidate)) {
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
      reason: `could not reach that server to find its mail API — ${transportFailures[0]!}`,
    };
  }

  return {
    kind: "refused",
    reason:
      "That address answers, but ohmail could not find its mail API — neither at the address " +
      "itself nor under /api. If you run this server, check that its proxy is passing /api " +
      "through to the ohmail API.",
  };
}
