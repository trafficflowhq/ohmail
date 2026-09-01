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
import { sentence, settle, signInToCloud, stalled, type DoorResult } from "./doors.js";
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
 * ASK THE ENGINE WHAT IS AT THE ADDRESS IT WAS JUST POINTED AT. Null when there is an ohmail
 * server there; a sentence when there is not.
 *
 * The engine probes what it is CONFIGURED for and never a URL from this window — see the route in
 * `cloud-engine.ts` for why that distinction is load-bearing rather than stylistic. So this must be
 * called after `engine_configure` has been accepted and the engine has settled, which is the order
 * {@link enterSelfHostDoor} takes and the order the address step takes.
 */
export async function probeConfiguredServer(): Promise<string | null> {
  let res: Response;
  try {
    res = await bridgeFetch("/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
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
 * ── THE CONFIGURE COMES FIRST, AND IT IS NOT AVOIDABLE ────────────────────────────────────────
 *
 * The window cannot dial: its CSP is `connect-src 'none'` and `offline-guard.ts` replaces every API
 * that could leave the process. The ENGINE is what dials, and the engine dials what it is
 * configured for. So proving the address requires configuring for it, which replaces the engine —
 * the ordinary cost of any door, and cheap here because nothing has been sealed yet.
 *
 * What that leaves behind on a REFUSAL is worth naming: the settings file now points at a server
 * that did not answer, and the install holds no session for it. That is a state the app already
 * handles — the window lands on the hosted sign-in surface — and it is recoverable by opening this
 * door again with a corrected address. It is strictly better than the alternative, which is
 * discovering the same fact after somebody has typed their password.
 *
 * A MIRROR IS NOT AT RISK IN THAT WINDOW. If the previous door was a different server, the engine
 * this configure starts has already discarded that mirror and its sealed session before opening
 * anything (`enforceMirrorOwner`) — which is the correct thing to have happened, since the install
 * is being moved. If it was the same server, nothing was discarded.
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

  try {
    await engineConfigure({ mode: "cloud", cloudUrl: base, address: address.trim() });
  } catch (err) {
    return { status: null, problem: sentence(err) };
  }
  const settled = await settle();
  if (settled.state !== "serving") return { status: settled, problem: stalled(settled) };

  const unreachable = await probeConfiguredServer();
  if (unreachable !== null) return { status: settled, problem: unreachable };
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
