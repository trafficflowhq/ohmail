/**
 * THE THIRD DOOR — a server the person in front of this app runs themselves: the hosted door
 * with the address made a variable, no self-hosted MODE. The engine's cloud branch takes the
 * base as configuration (`CloudDoorConfig.cloudUrl` → `OHMAIL_CLOUD_URL` → `createCloudAuth`);
 * sign-in, refresh, mirror, write-through proxy and sealed session are identical — a fork
 * would be two paths that must stay the same with no structural reason. New: (1) the base is
 * `<origin>/api`, never the origin (`apiBaseFor` in `cloud-origin.ts` has the measurement);
 * (2) the address can be wrong, so the door PROBES first and refusals name the address
 * dialled; (3) a credential is a fact about ONE server (`enforceMirrorOwner` compares it).
 */

/*
 * NO BROWSER HANDOFF ON THIS DOOR: `openWeb` takes a PLACE and the shell resolves it to an
 * address it owns — every one of those is ohmail.app's. Sending an operator's browser there
 * to sign in to THEIR server would be nonsense, and letting the shell open a URL typed into
 * this window would hand the webview an "open anything on this machine" command. So the
 * self-hosted arm offers the password-and-code form: no browser, no new shell capability.
 */

import { engineConfigure, engineLogout, bridgeFetch, type EngineStatus } from "./bridge-fetch.js";
import {
  probeTlsRefusal,
  sentence,
  settle,
  signInToCloud,
  stalled,
  standingEngine,
  type DoorRefusal,
  type DoorResult,
  type HostSuggestion,
} from "./doors.js";
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
 * ASK THE ENGINE WHAT IS AT AN ADDRESS — null when an ohmail server is there, a sentence when
 * not. WITH a candidate the engine dials the origin given here (validated through the same
 * parse this file uses, the path composed engine-side) and nothing about this install is
 * configured by asking; WITHOUT one it answers about the door it is configured for, pin
 * included. Spelled out because this comment once said the opposite — "the engine probes what
 * it is CONFIGURED for and never a URL from this window" — while the code passed a candidate
 * through; a false comment about a trust boundary survives review after review. The boundary:
 * the ORIGIN may come from the window, the PATH never does, `normalizeOrigin` decides the rest.
 */
export async function probeConfiguredServer(candidateOrigin?: string): Promise<DoorRefusal | null> {
  let res: Response;
  try {
    res = await bridgeFetch("/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidateOrigin === undefined ? {} : { origin: candidateOrigin }),
    });
  } catch (err) {
    return { sentence: sentence(err), suggestion: null };
  }
  if (res.ok) return null;
  /* The engine's own sentence, whole: it is the process that dialled, so a category invented
     at this layer would describe a fact this window never observed; an unexpected body falls
     back to the status line rather than throwing inside the handler explaining the first
     failure. The details beside it are read with the other door's own reader: returning
     `error.message` alone threw away a `details` naming the host that WOULD have worked,
     while the standalone door sharpened the same body. One reader now — `probeTlsRefusal` —
     which declines every shape it does not fully recognise, so the two doors agree on the
     shapes they do not rewrite as well as on the ones they do. */
  try {
    const parsed = (await res.json()) as { error?: { message?: string; details?: unknown } };
    const sharper = probeTlsRefusal(parsed.error?.details);
    if (sharper) return sharper;
    if (parsed.error?.message) return { sentence: parsed.error.message, suggestion: null };
  } catch {
    /* not JSON */
  }
  return {
    sentence: `The mail engine could not check that address (${res.status}).`,
    suggestion: null,
  };
}

/** What {@link configureSelfHostDoor} ended as: the settled engine, or the sentence to show. */
export interface SelfHostStep {
  status: EngineStatus | null;
  problem: string | null;
  /**
   * A HOST THE PROBE NAMED — `DoorResult.suggestion`'s field, spelled the same way for the same
   * reason: the card renders both doors' refusals through one component, and a second name for the
   * same fact is how the two screens come to offer it differently.
   */
  suggestion?: HostSuggestion | null;
}

/**
 * STEP ONE OF TWO: point this install at the operator's server, and find out whether it is
 * there — separated from the sign-in so it fails here rather than three fields later. THE
 * PROBE COMES FIRST: configuring for a different server is not free — `enforceMirrorOwner`
 * runs before the database opens and DISCARDS the previous mirror and its sealed session, so
 * the old configure-then-ask order cost a mistyped address somebody's entire hosted mirror.
 * The engine is asked about a CANDIDATE (validated by the same parse, path composed
 * engine-side; see the route in `cloud-engine.ts`), and nothing is configured until it
 * answers: a refusal costs nothing — settings untouched, mirror and session where they were.
 */

/*
 * ON A FRESH INSTALL THERE IS NO ENGINE TO ASK — the shell is `NotConfigured` and every
 * bridge request answers "the engine has not been configured", so probe-first made this door
 * impossible on the installs most likely to walk it. The order is decided by WHAT THERE IS TO
 * LOSE, read from the shell: `state === "not_configured"` means no mirror, no sealed session,
 * no settings to cost — that install configures FIRST, and the probing engine IS the
 * candidate's, so the operator's private CA (`NODE_EXTRA_CA_CERTS`, composed only for a
 * self-hosted configuration) is in place for its own proof. An install that already holds a
 * door still probes first; the private-CA gap there is recorded, not quietly fixed here.
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
   * IS THERE ANYTHING FOR A WRONG ADDRESS TO COST? — the shell's own state, read at the
   * submit. `not_configured` is the shell's word for "no door has been chosen": the one state
   * in which nothing can be lost AND nothing can be asked. Read here rather than passed in,
   * for `enterLocalDoor`'s reason: a door opened from Settings may have been on screen for
   * minutes, and the order this submit takes has to come from what is true now. A shell that
   * will not answer is NOT read as a fresh install — "there is no door yet" and "we could not
   * find out" differ, and only the first is safe to configure over.
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
    if (unreachable !== null) {
      /**
       * ── AND THEN PUT IT BACK, SO THIS ARM'S REFUSAL COSTS NOTHING EITHER ────────────────
       * The card stays on the address field with the server's own words, which is enough for
       * somebody who keeps typing and not for somebody who quits: `gateFor` routes on the
       * SETTINGS, so an install left configured for an address that did not answer comes back
       * as a chosen door with no session — the chooser it needs no longer offered.
       * `engine_logout` is the exact undo: it removes `config.json` and returns the shell to
       * `not_configured`, the state this arm found (mirror and key untouched; no sealed
       * session exists yet). IF THE UNDO FAILS the person is told — the way back is this door.
       */
      const stranded = await forgetDoor();
      return {
        status: null,
        problem: stranded === null ? unreachable.sentence : `${unreachable.sentence} ${stranded}`,
        suggestion: unreachable.suggestion,
      };
    }
    return step;
  }

  /* PROVE, THEN COMMIT — the local door's ordering, for the same class of reason: the step that
     cannot be undone goes after the step that can fail. */
  const unreachable = await probeConfiguredServer(typedOrigin);
  if (unreachable !== null) {
    return { status: null, problem: unreachable.sentence, suggestion: unreachable.suggestion };
  }

  return configureFor(base, address);
}

/**
 * FORGET THE DOOR THIS FUNCTION JUST CHOSE — null when it is forgotten, a sentence when it is not.
 *
 * The undo half of the fresh-install order, and the reason it is `engine_logout` rather than a
 * second configure: there is no configuration meaning "no door", so the only way back to the state
 * this arm found is the command that removes the settings file. See the call site.
 */
async function forgetDoor(): Promise<string | null> {
  try {
    await engineLogout();
    return null;
  } catch (err) {
    return (
      "This computer is now set up for that address and could not be put back " +
      `(${sentence(err)}). Open this door again to give a different one.`
    );
  }
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
 * THERE IS DELIBERATELY NO `enterSelfHostDoor` DOING BOTH STEPS IN ONE CALL. `enterCloudDoor`
 * has that shape because the hosted server is a constant — nothing to prove before asking for
 * a password. This door's whole argument is that the two steps are SEPARATE: the address is
 * proved while the person has typed no secret, so a machine not running ohmail is reported as
 * the wrong address rather than a failed sign-in. A convenience wrapper invites a caller that
 * collects all four fields first — it was written, called by nothing, and removed.
 */
