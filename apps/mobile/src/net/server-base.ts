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
/**
 * THE SENTENCE FOR AN ADDRESS NO CERTIFICATE AUTHORITY CAN VOUCH FOR — a numeric one on a network.
 *
 * Named once because it is now given from TWO places, and the second is the point: an address that
 * would need a pin gets this whether it was typed as `https://` (refused outright) or as `http://`
 * (where the obvious remedy, "use https", leads straight back to this refusal). One sentence, so
 * the two paths cannot drift into telling somebody different things about one address.
 *
 * `originNeedsPin` is the engine's own predicate rather than an IP test written here, for the
 * reason the parse is imported rather than restated: one rule about which addresses need a pin, so
 * the door cannot come to disagree with the seam (`admitOrigin`) that enforces it.
 */
const NEEDS_THE_CODE =
  "That is a numeric address on a network, and no certificate authority can vouch for one — " +
  "so ohmail can only trust it through the code your computer shows. Open Settings → " +
  "Devices there and scan that instead.";

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
    if (originNeedsPin(origin)) return NEEDS_THE_CODE;
    return null;
  }
  /**
   * WAS THE SCHEME THE ACTUAL REASON? — and this arm used to answer that from the scheme alone,
   * which made it lie.
   *
   * Review round 3's fifth finding. `http://localhost/path` is refused for its PATH: cleartext to
   * loopback is explicitly allowed, so `http://localhost:8080` parses fine. Reading `http://` as
   * the cause named the wrong clause, and its remedy — "give the https address" — is advice that
   * does not fix the address and would not have been needed if it had.
   *
   * The discriminator is the imported parse ITSELF rather than a loopback test written here: swap
   * the scheme and ask again. If the https spelling parses, the scheme was the only thing wrong and
   * the safety sentence is true. If it still does not, the address has a shape problem that has
   * nothing to do with the scheme, and the shape sentence is the honest one. No clause of the
   * acceptance rule is restated to make that judgment, which is the property the census holds.
   */
  const httpsSpelling = /^http:\/\//i.test(trimmed)
    ? parseServerAddress(trimmed.replace(/^http:/i, "https:"))
    : null;
  if (httpsSpelling !== null) {
    /**
     * …AND THE REMEDY HAS TO SURVIVE BEING TAKEN — review round 4's fifth finding.
     *
     * "Give the https address" is the right advice for `http://mail.example.com` and useless for
     * `http://192.168.1.20`: the https spelling of a numeric address parses, so this branch used to
     * offer it, and typing exactly what it asked for hit `originNeedsPin` and was refused again. A
     * remedy that leads to a second refusal is worse than no remedy, because the person has now
     * done what they were told.
     *
     * So the SAME predicate that will judge the https spelling is asked here, about that spelling,
     * before it is recommended — and where it would be refused, the sentence that actually leads
     * somewhere is the one given.
     */
    if (originNeedsPin(httpsSpelling)) return NEEDS_THE_CODE;
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
 * ONE PROBE, BOUNDED END TO END — the fetch AND the body read under a single deadline.
 *
 * ── WHY THE CLASSIFICATION MOVED IN HERE ───────────────────────────────────────────────────────
 *
 * The first version of this bounded only the fetch, and review round 3 named the hole: a server
 * that returns `401 application/json` HEADERS inside the deadline and then never finishes — or
 * endlessly trickles — the BODY defeats it completely. The timer is already cleared and the
 * controller already discarded by the time `res.json()` is awaited, so the pairing stalls exactly
 * as it did before the deadline existed, one layer further in. A deadline that ends at the headers
 * is not a deadline on the operation anybody cares about.
 *
 * So the whole question — "did an ohmail API answer this URL?" — is asked inside one controller and
 * one timer. The abort now covers the body stream too, which is the part that can be made
 * unbounded by a server that is otherwise perfectly responsive.
 *
 * Cancels through `AbortSignal` where the platform honours it and falls back to a race where it
 * does not; the two are not redundant, because they free different things — an honoured signal
 * frees the socket, a race frees only the CALLER. And where only the race fires, the abandoned
 * fetch's response is still released rather than left holding a stream (round 3's third finding).
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
   * THIS PROMISE ALWAYS HAS A HANDLER, EVEN IF NOTHING EVER RACES IT — review round 5.
   *
   * `fetchImpl` is a seam, and a seam can throw SYNCHRONOUSLY: a transport that rejects a malformed
   * URL by throwing, a test double, a platform binding that has not been installed. The throw
   * propagates to the caller correctly — but the timer is already armed, and when it fires it
   * rejects a promise nobody is waiting on. In React Native that is an unhandled rejection, which
   * is a red box in development and, on some runtimes, a good deal worse.
   *
   * The `finally` clears the timer for every path that gets INTO the try; this covers the one path
   * that never does. Attaching a no-op rejection handler is enough — it does not swallow the
   * rejection the race sees, because that race attaches its own.
   *
   * REDUNDANT WITH THE FETCH'S PLACEMENT INSIDE THE TRY, deliberately and in the same way the
   * reject-before-abort ordering is redundant with the `expired` reclassification: with the call
   * inside, a synchronous throw already reaches the `finally`, so a mutation runner reports this
   * line as unnecessary. What must hold is that AT LEAST ONE is present, which is a property of the
   * pair: removing either alone changes nothing, and removing both leaves an unhandled rejection,
   * so the two are only meaningful when tested together.
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
       * THE BODY READ LOST TO THE DEADLINE, AND THIS RESPONSE IS ORPHANED — round 4's first
       * finding. The `settled` handler on `inFlight` cannot cover it: that promise resolved while
       * `settled` was still false, so its callback did nothing.
       *
       * ── AND `letGo` IS THE BELT, NOT THE FIX. THE ABORT IS THE FIX. ─────────────────────────
       *
       * Writing this line as the answer was wrong, and a test caught it: `res.json()` has LOCKED
       * the body by the time the deadline fires, and `cancel()` on a locked stream throws — which
       * `letGo` swallows, so the call is a no-op in exactly the case it was added for. Believing it
       * worked would have left a comment claiming a release that never happened.
       *
       * What actually frees a stalled body is the `abort()` the timer already fired, and it fires
       * BEFORE this runs: an honoured signal terminates the body stream and makes the pending
       * `res.json()` reject. A platform that ignores the signal leaks the stream until collection —
       * the same residual the abandoned-fetch case has, and the honest size of it.
       *
       * The call stays because the other rejection paths reach `letGo` before anything is locked,
       * and one release function for all of them is worth more than an arm that has to remember
       * which state it is in.
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
 * DID THIS ANSWER COME FROM THE EXACT URL THAT WAS ASKED?
 *
 * ── THE WHOLE URL, NOT THE ORIGIN, AND ROUND 3 IS WHY ──────────────────────────────────────────
 *
 * This compared ORIGINS, and review named the gap: a SAME-ORIGIN redirect passes an origin check.
 * `<origin>/sync` answering `302 → <origin>/api/sync` would have validated the BARE candidate on
 * the strength of the prefixed one's answer, and the bare base would then be stored — a base whose
 * probe never succeeded directly. Later requests are the ones that pay for it: a proxy that
 * redirects `/sync` need not redirect `/sync/snapshot`, and a 301/302 turns an authenticated POST
 * into a GET, so the mutation surface would break in a way the pairing never showed.
 *
 * Comparing the whole URL is both tighter and simpler to justify: the probe asked one exact
 * address and the answer must be from that address. Both sides go through `new URL`, so a
 * platform that reports a normalized form (a default port written out, a case-folded host) still
 * compares equal — the standard's own definition rather than a string match.
 *
 * An EMPTY final URL answers `true`, because "no information" must not reject every response; see
 * the sized residual in {@link answeredByApi}.
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
 *  3. the response's final URL must be the exact URL that was asked — see
 *     {@link answeredFromRequest}, which compares the whole URL rather than the origin because a
 *     SAME-ORIGIN redirect passes an origin check.
 *
 * ── AND THE RESIDUAL, WHICH REVIEW ROUND 2 CALLED THE FIX INCOMPLETE FOR, SIZED HONESTLY ───────
 *
 * A platform that follows the redirect AND sets no `redirected` AND reports an empty `Response.url`
 * defeats all three. `Response.url` empty is read as "no information" rather than as a failure,
 * deliberately: a platform that reports no final URL for ORDINARY responses would otherwise have
 * every server refused, which is a total breakage traded for a partial guard.
 *
 * ── AND THE RESIDUAL HAS TWO HALVES. AN EARLIER VERSION OF THIS NOTE NAMED ONLY ONE. ───────────
 *
 * It said "the reachable harm is choosing the wrong PATH on the right ORIGIN", which is true of the
 * BASE and false as a summary — the paragraph above it had already said the request goes out. A
 * comment that contradicts itself two paragraphs apart is worse than one that overstates, because
 * each half looks checked. Review round 6 called it, correctly. Both halves, then:
 *
 *  1. **THE ANSWER IS NOT ACCEPTED.** The base stored is always `candidate` — `<origin>` or
 *     `<origin>/api`, the address the person named — and NEVER a redirect's target, which this
 *     function does not carry anywhere. That half is closed.
 *  2. **THE REQUEST IS STILL ISSUED**, and rejecting the response cannot un-issue it. On a platform
 *     that follows the redirect, a hostile origin can make this phone send a credential-free GET to
 *     an address of its choosing — including one only this phone's network can resolve. That is
 *     blind request forgery against whatever is on that network, and no check after the fact
 *     touches it.
 *
 * WHAT BOUNDS THE SECOND HALF IS THAT IT IS NOT A NEW CAPABILITY. Reaching this line means the
 * origin has ALREADY been dialled by `negotiate` (`/hello`), whose fetch follows redirects on the
 * same platform under the same rules, and the engine's own transport does too on every
 * authenticated request afterwards. An origin that can do this through the probe could already do
 * it through the handshake that let it get this far. So this file makes the primitive two requests
 * cheaper and does not create it — which is the honest size of it, and is not the same as saying
 * it does not exist.
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
     * A PARSE FAILURE IS AN ANSWER. A TRANSFER FAILURE IS NOT — review round 6.
     *
     * Both used to land here and both became `false`, i.e. "definitively not the API". They are not
     * the same fact. Body bytes that arrived and did not parse ARE a disproof: whatever that was,
     * it is not the API's envelope. A connection that RESET while the body was being read disproves
     * nothing — the API may well be exactly here — and calling it a disproof let a transient
     * failure on the right candidate produce the sentence saying both addresses had been ruled out,
     * which sends an operator to change proxy routing that was already correct.
     *
     * `SyntaxError` is the discrimination and it is the platform's own: `Response.json()` rejects
     * with one for malformed JSON and with a network error (a `TypeError`) for a transfer that
     * failed. Anything that is not a parse error is re-thrown, so the caller classifies it as the
     * transport failure it is.
     */
    if (err instanceof SyntaxError) return false;
    throw err;
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
  /**
   * A CANDIDATE THAT TIMED OUT — the server accepted and did not finish answering.
   *
   * Round 3's fourth finding: a server that withholds headers on BOTH candidates leaves `reached`
   * false, so the transport sentence fired and said "could not reach that server" about a server
   * that had accepted two connections. That points somebody at their network, or — through
   * `isPinFailure` — at a certificate, when the actual fault is a route that hangs.
   *
   * A timeout is therefore neither a transport failure nor a reach: it is its own fact, with its own
   * sentence, and it is the one that names what to look at.
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
      reason: `could not reach that server to find its mail API — ${transportFailures[0]!}`,
    };
  }

  /* A STALL IS ITS OWN ANSWER — see {@link stalled}. Below the transport arm because a run that had
     both a hard failure and a stall was, at least once, genuinely unable to connect; above the two
     below because a route that never answered has not been disproved, and both of those sentences
     are about candidates that were. */
  if (stalled) {
    return {
      kind: "refused",
      reason: stalledAfterHeaders
        ? "That server started answering and then stopped, so ohmail stopped waiting. If you run " +
          "it, check that its proxy is passing requests through to the ohmail API."
        : "That server did not answer in time, so ohmail stopped waiting. That may be the network " +
          "between this phone and it, or a route on the server that never replies.",
    };
  }

  /**
   * A MIXED RESULT MUST NOT CLAIM BOTH CANDIDATES WERE DISPROVED — review round 5's second finding.
   *
   * One candidate answering definitively (and not as the API) while the other fails at the transport
   * used to reach the generic sentence below, which says the API was found "neither at the address
   * itself nor under /api". That is false: the failed candidate was never CLASSIFIED at all, and it
   * may be exactly where the API is. A transient reset would have been reported as a proxy
   * misconfiguration, sending an operator to change routing that was already right.
   *
   * Reaching here means `reached` is true (or the arm above would have fired), so this is precisely
   * the mixed case: one address answered, one did not, and the sentence says both halves.
   */
  if (transportFailures.length > 0) {
    return {
      kind: "refused",
      reason:
        "One of the two addresses ohmail tried answered and was not its mail API, and the other " +
        `could not be reached — ${transportFailures[0]!}. If you run this server, check that it ` +
        "is passing /api through to the ohmail API.",
    };
  }

  /* BOTH CANDIDATES WERE CLASSIFIED AND NEITHER WAS THE API — the only state in which "neither" is
     a true word, which is what the two arms above exist to protect. */
  return {
    kind: "refused",
    reason:
      "That address answers, but ohmail could not find its mail API — neither at the address " +
      "itself nor under /api. If you run this server, check that its proxy is passing /api " +
      "through to the ohmail API.",
  };
}
