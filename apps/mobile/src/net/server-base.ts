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
  if (parseServerAddress(trimmed) !== null) return null;
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
 * DID THIS RESPONSE COME FROM AN OHMAIL API, or from whatever else is serving that path?
 *
 * The API's refusal envelope, and nothing looser: an unauthenticated `GET /sync` is answered
 * `401` with `application/json` and `{"error":{"code":…}}` by all three route tables, because all
 * three are the same request guard. A Next 404 page is `text/html` and parses as nothing.
 *
 * The status is checked as well as the shape because a JSON 404 is exactly what a proxy in front
 * of a stack that does NOT route this path may answer, and reading that as "the API is here"
 * would pick a base whose every drain 404s — the failure this whole file exists to close, one
 * layer in. A 401 is the API saying "this route is mine and you have no session", which is the
 * only answer that establishes both halves.
 */
async function answeredByApi(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return false;
  }
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string";
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
  for (const candidate of [bare, prefixed]) {
    let res: Response;
    try {
      res = await fetchImpl(`${candidate}${PROBE_PATH}`);
    } catch (err) {
      /* A transport failure is about the ORIGIN, not about this candidate path — the same socket
         and the same certificate serve both — so there is nothing the second probe could learn.
         Reported with the platform's words, which the caller may recognise as a pin failure. */
      return {
        kind: "refused",
        reason: `could not reach that server to find its mail API — ${String(err)}`,
      };
    }
    if (await answeredByApi(res)) {
      return { kind: "base", base: candidate, prefixed: candidate === prefixed };
    }
  }

  return {
    kind: "refused",
    reason:
      "That address answers, but ohmail could not find its mail API — neither at the address " +
      "itself nor under /api. If you run this server, check that its proxy is passing /api " +
      "through to the ohmail API.",
  };
}
