/**
 * THE THIRD DOOR — a server the person in front of this app runs themselves.
 *
 * ── IT IS THE HOSTED DOOR WITH THE ADDRESS MADE A VARIABLE. THAT IS THE WHOLE DESIGN. ──────────
 *
 * There is no self-hosted MODE. The engine's cloud branch already takes the server's base as a
 * configuration field (`CloudDoorConfig.cloudUrl`), carries it through the shell as
 * `OHMAIL_CLOUD_URL`, and hands it to `createCloudAuth` as the base every request is composed
 * against. Everything from the sign-in down — the bearer client, the single-flight refresh, the
 * mirror, the write-through proxy, the sealed session — is identical, because from the engine's
 * point of view a self-hosted ohmail IS an ohmail server; it runs the same code from the same
 * repository. `doors.ts` pinned that field to one constant only because until now there was one
 * server. This file un-pins it, and that is the entire mechanism.
 *
 * Writing it as a fork — a fourth engine mode, a second auth client, a parallel mirror — would
 * have been the larger change AND the worse one: two paths that must stay identical and no
 * structural reason they will. One seam, and every fix to the hosted door is a fix to this one.
 *
 * ── WHAT IS GENUINELY NEW, AND IT IS THREE THINGS ─────────────────────────────────────────────
 *
 *  1. **The base is not the origin.** `<origin>/api`, and it is not a nicety — see `apiBaseFor`
 *     in `cloud-origin.ts`, which carries the measurement. A door that used the typed origin would
 *     sign in successfully and then sync nothing for ever.
 *  2. **The address can be wrong**, in ways the hosted door's constant never could be: a typo, a
 *     machine that is not running ohmail, a certificate from an authority nobody outside that
 *     network has heard of. So this door PROBES before it asks for a password, and every refusal
 *     names the address that was actually dialled.
 *  3. **A credential is a fact about ONE server.** A session sealed against our service must never
 *     be offered to an operator's machine, and vice versa. That is the boot contract
 *     (`credential-host.ts`) in its cloud spelling, and it is enforced where the mail is:
 *     `enforceMirrorOwner` compares the recorded server as well as the recorded address, and its
 *     discard already removes `cloud-tokens.seal`. Nothing here has to revoke anything, and this
 *     file deliberately adds no second enforcement point that could fall out of step with it.
 *
 * ── AND WHAT THIS DOOR DELIBERATELY DOES NOT OFFER: THE BROWSER HANDOFF ───────────────────────
 *
 * `openWeb` takes a PLACE — `link-desktop` — and the shell resolves it to an address it owns. Every
 * one of those addresses is ohmail.app's. Sending an operator's browser there to sign in to THEIR
 * server would be nonsense, and making the shell open a URL typed into this window would hand the
 * webview an "open anything on this machine" command, which is a considerably larger door than the
 * one being built. So the self-hosted arm offers the password-and-code form, which needs no
 * browser and no new shell capability, and says nothing about a handoff at all.
 */

import { engineConfigure, bridgeFetch, type EngineStatus } from "./bridge-fetch.js";
import { sentence, settle, signInToCloud, stalled, standingEngine, type DoorResult } from "./doors.js";
import {
  apiBaseFor,
  normalizeOrigin,
  OPERATOR_CA_FILE,
} from "../../sidecar/src/cloud-origin.js";

export { OPERATOR_CA_FILE };

/**
 * WHAT AN OPERATOR TYPES, AS THE BASE THE ENGINE WILL DIAL — or null when it is not an address.
 *
 * The parse is `normalizeOrigin`'s, which is the ENGINE's own, imported by relative path rather
 * than restated here. That is `credential-host.ts`'s rule and it applies for the same reason: two
 * copies of a rule about which addresses are acceptable would drift, and the drift would be silent
 * — a door that accepted a shape the engine's own comparison then read differently.
 */
export function selfHostBase(typed: string): string | null {
  const origin = normalizeOrigin(typed);
  return origin === null ? null : apiBaseFor(origin);
}

/**
 * The first thing wrong with the address, as a sentence, or null when it is usable.
 *
 * One sentence for every rejected shape, and that is a choice rather than laziness. The parse
 * refuses a path, a query, a fragment, embedded credentials and a foreign scheme, and a person who
 * has typed one of those has not made five different mistakes — they have pasted something that is
 * not the address they open ohmail at. Naming the SHAPE that is wanted is more use than naming the
 * clause that rejected them, and it is the same sentence the door's own hint gives, so the screen
 * does not appear to change its mind.
 */
export function selfHostProblem(typed: string): string | null {
  if (!typed.trim()) return "Your server's address is missing.";
  if (selfHostBase(typed) === null) {
    return (
      "That does not look like a server address. Give the address you open ohmail at in a " +
      "browser — for example https://ohmail.example.com — with nothing after the host."
    );
  }
  return null;
}

/**
 * ASK THE ENGINE WHAT IS AT AN ADDRESS. Null when there is an ohmail server there; a sentence when
 * there is not.
 *
 * WITH A CANDIDATE, the engine dials the origin given here — validated through the same parse this
 * file uses, with the path composed engine-side — and nothing about this install is configured by
 * asking. WITHOUT one, it answers about the door it is already configured for, over that door's own
 * transport, pin included. Both arms exist and the caller chooses; see the route in
 * `cloud-engine.ts` for what the candidate arm widens and what it buys.
 *
 * ── THIS COMMENT USED TO SAY THE OPPOSITE, AND THAT IS WHY IT IS SPELLED OUT ──────────────────
 *
 * It read *"the engine probes what it is CONFIGURED for and never a URL from this window"* while
 * the code beneath it passed a window-supplied candidate straight through. A false comment about a
 * trust boundary is worse than none: it describes a boundary that WOULD be correct, so five review
 * rounds read it and looked no further, and the ordering defect it hid — a fresh install being told
 * its engine is not configured by the screen that configures it — survived all five. What the
 * boundary actually is: the ORIGIN may come from the window, the PATH never does, and
 * `normalizeOrigin` decides what an origin may be.
 */
export async function probeConfiguredServer(candidateOrigin?: string): Promise<string | null> {
  let res: Response;
  try {
    res = await bridgeFetch("/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidateOrigin === undefined ? {} : { origin: candidateOrigin }),
    });
  } catch (err) {
    return sentence(err);
  }
  if (res.ok) return null;
  /* The engine's own sentence, whole. It is the process that dialled, so it is the only thing here
     that knows what happened; a category invented at this layer would be a worse description of a
     fact this window never observed. A body that is not the expected shape falls back to the status
     line rather than throwing inside the handler that was explaining the first failure. */
  try {
    const parsed = (await res.json()) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* not JSON */
  }
  return `The mail engine could not check that address (${res.status}).`;
}

/** What {@link configureSelfHostDoor} ended as: the settled engine, or the sentence to show. */
export interface SelfHostStep {
  status: EngineStatus | null;
  problem: string | null;
}

/**
 * STEP ONE OF TWO: point this install at the operator's server, and find out whether it is there.
 *
 * Separated from the sign-in because the person doing it has not been asked for a password yet —
 * this is the "your server's address" step, and its whole job is to fail here rather than three
 * fields later with a sentence about credentials.
 *
 * ── THE PROBE COMES FIRST, AND THE ORDER IS THE FINDING ───────────────────────────────────────
 *
 * This configured the engine and then asked the engine what it could see, on the reasoning that the
 * window cannot dial — its CSP is `connect-src 'none'` — so proving an address requires configuring
 * for it. The first half of that is true and the conclusion was wrong, because configuring for a
 * different server is not free: `enforceMirrorOwner` runs before the database opens and DISCARDS
 * the previous mirror and its sealed session. So a MISTYPED address cost somebody their entire
 * hosted mirror and a full re-sync, for a typo, before anything had been proved, with Back offering
 * no way back. Raised by review, and it contradicted this door's own reason for existing.
 *
 * So the engine is asked about a CANDIDATE first and nothing is configured until it answers. The
 * engine validates the candidate through the same parse this file uses and composes the path
 * itself; see the route in `cloud-engine.ts` for what that widens and what it buys.
 *
 * A REFUSAL NOW COSTS NOTHING. The settings file is untouched, the previous door is still the
 * configured one, and its mirror and session are where they were. Only a server that answered as an
 * ohmail server, set up and self-hosted, gets as far as replacing the engine.
 *
 * ── AND ON A FRESH INSTALL THERE IS NO ENGINE TO ASK, WHICH MADE THIS DOOR IMPOSSIBLE ─────────
 *
 * The probe is a request to the local engine, and a fresh install has none: nothing is configured,
 * so the shell is `NotConfigured` and `Engine::request` answers every bridge request with *"the
 * engine has not been configured: nothing set OHMAIL_IMAP_HOST, OHMAIL_IMAP_USER"*. Measured on a
 * fresh HOME with the shipped build, whose own log says `not started — nothing set …` and which
 * spawns no engine process at all. So the first act of the door was refused by this app talking
 * about itself, on the screen whose entire job is to configure it, and `engineConfigure` was never
 * reached — the primary path of this whole door, on the installs most likely to walk it.
 *
 * THE ORDER IS THEREFORE DECIDED BY WHAT THERE IS TO LOSE, and the shell is the authority on that
 * rather than a guess: `state === "not_configured"` means no door has been chosen, so there is no
 * mirror, no sealed session and no settings for a mistyped address to cost. That install configures
 * FIRST and asks the engine that results — which is an engine built for the CANDIDATE, so the
 * question is answered by a transport dialling the address that was typed.
 *
 * That second property is why this is not merely a workaround for an empty install. The operator's
 * private certificate authority reaches the engine as `NODE_EXTRA_CA_CERTS`, and the shell composes
 * it only for a SELF-HOSTED cloud configuration — so an engine configured for any other door proves
 * the candidate without the candidate's own trust material and fails TLS on a certificate that is
 * perfectly good. On the fresh path the engine doing the proving IS the candidate's, so the CA is
 * in place for its own proof. An install that already holds a door still probes first and still
 * carries that gap; it is a narrower case (somebody moving an existing install to a private-CA
 * server) and it is recorded rather than quietly fixed here, because closing it means giving the
 * probe a per-origin trust store rather than reordering anything.
 *
 * Everything ELSE keeps the probe-first order exactly: an install with a door to lose must not
 * discard it for a typo, which is the finding that put the probe first in the first place.
 */
export async function configureSelfHostDoor(typedOrigin: string, address: string): Promise<SelfHostStep> {
  const addressProblem = selfHostProblem(typedOrigin);
  if (addressProblem) return { status: null, problem: addressProblem };
  if (!address.trim()) return { status: null, problem: "Your ohmail address on that server is missing." };
  if (!address.includes("@")) return { status: null, problem: "That does not look like a mailbox address." };

  const base = selfHostBase(typedOrigin);
  /* Unreachable — `selfHostProblem` returned null, so the parse succeeded — and asserted rather
     than assumed, because a non-null assertion here would be a claim about another function that
     nothing checks. */
  if (base === null) return { status: null, problem: selfHostProblem(typedOrigin) };

  /**
   * IS THERE ANYTHING FOR A WRONG ADDRESS TO COST? — the shell's own state, read at the submit.
   *
   * `not_configured` is the shell's word for "no door has been chosen", and it is the one state in
   * which nothing can be lost AND nothing can be asked. Read here rather than passed in for
   * `enterLocalDoor`'s reason: a door opened from Settings may have been on screen for minutes,
   * and the order this submit takes has to come from what is true now.
   *
   * A shell that will not answer at all is NOT read as a fresh install. That is the difference
   * between "there is no door yet" and "we could not find out", and only the first is safe to
   * configure over — so anything else keeps the probe-first order and reports what it finds.
   */
  const standing = await standingEngine();
  const nothingToLose = standing !== null && standing.state === "not_configured";

  if (nothingToLose) {
    /* CONFIGURE, THEN PROVE — and the proof goes through the engine that results, which is the
       candidate's own. See the note above for both reasons this order is right HERE and wrong
       everywhere else. */
    const step = await configureFor(base, address);
    if (step.problem !== null) return step;
    const unreachable = await probeConfiguredServer();
    /* THE SERVER'S OWN SENTENCE, and the status is dropped with it: the address step has not been
       passed, so the card stays on the address field with the engine's words above it. The install
       is left pointed at an address that did not answer, which on an install with no door is
       nothing lost — the next attempt reconfigures it — and it is why this arm exists only there. */
    if (unreachable !== null) return { status: null, problem: unreachable };
    return step;
  }

  /* PROVE, THEN COMMIT — the local door's ordering, for the same class of reason: the step that
     cannot be undone goes after the step that can fail. */
  const unreachable = await probeConfiguredServer(typedOrigin);
  if (unreachable !== null) return { status: null, problem: unreachable };

  return configureFor(base, address);
}

/**
 * POINT THIS INSTALL AT A BASE AND WAIT FOR THE ENGINE TO COME BACK.
 *
 * The half both orders above share, factored out so they cannot come to disagree about what a
 * failed configure or a stalled engine says — two spellings of one refusal is how two arms of one
 * door start describing the same state differently.
 */
async function configureFor(base: string, address: string): Promise<SelfHostStep> {
  try {
    await engineConfigure({ mode: "cloud", cloudUrl: base, address: address.trim() });
  } catch (err) {
    return { status: null, problem: sentence(err) };
  }
  const settled = await settle();
  if (settled.state !== "serving") return { status: settled, problem: stalled(settled) };
  return { status: settled, problem: null };
}

/**
 * STEP TWO: sign in to that server.
 *
 * `signInToCloud` unchanged and unwrapped — the request goes to the engine, which composes it
 * against the base it is configured for, so there is nothing about this sign-in that differs from
 * the hosted one and nothing here that should pretend otherwise. It is exported under its own name
 * only so the door's two steps read as two steps.
 */
export async function signInToSelfHost(
  address: string,
  password: string,
  totp: string,
  known?: EngineStatus,
): Promise<DoorResult> {
  return signInToCloud(address, password, totp, known);
}

/*
 * THERE IS DELIBERATELY NO `enterSelfHostDoor` DOING BOTH STEPS IN ONE CALL.
 *
 * `enterCloudDoor` has that shape because the hosted door genuinely collects everything at once —
 * its server is a constant, so there is nothing to prove before asking for a password. This door's
 * whole argument is that the two steps are SEPARATE: the address is proved while the person has
 * typed no secret, so a machine that is not running ohmail is reported as the wrong address rather
 * than as a failed sign-in. A convenience wrapper that ran them back to back would be an invitation
 * to a caller that collects all four fields first, which is the shape this door exists to avoid —
 * and it was written, called by nothing, and removed for that reason.
 */
