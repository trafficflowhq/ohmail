"use client";

/**
 * `/link-desktop` as the web serves it: the desktop link's page over its own ceremony (`use-link-desktop-door.ts`):
 * a one-use code minted at the press (never on load), shown, and removed at the SERVER's zero; the mint is step-up
 * gated, so a closed window opens the one dialog and the verified factor retries the mint once, the commitment with
 * it. Nothing here signs in: a browser with no session, an unfinished enrolment and a second refusal after a
 * verified factor are each told to sign in (as a document) and open this page again.
 */

/**
 * The deep link is offered only for a code that is BOUND: when the app opened this page it appended `?challenge=` —
 * the public half of a PKCE pair whose verifier stays in the app's memory — and the code that comes back is spendable
 * only by a caller producing that verifier. That is the whole licence for the "Open ohmail" press: `ohmail://` is
 * claimed by whichever program registered it, and nothing authenticates that, so an interceptor receives a code it
 * cannot use. With NO challenge there is no press — an unbound code over a scheme anybody can claim is strictly worse
 * than the same code retyped into a window a person is looking at; the retype steps stay on the page either way.
 */
import { NONE } from "@ohmail/app/host";
import { LinkDesktopPage, type LinkDesktopDoor, type LinkDesktopState } from "@ohmail/app/doors/link-desktop";
import { apiConfigured } from "../../api-client";
import { WebDoor } from "../door-device";
import { useWebStepUp } from "../mailbox/StepUp";
import { useRefusalSentence } from "../refusal-sentence";
import { useLinkDesktopDoor, type LinkDesktopCeremony } from "./use-link-desktop-door";

/**
 * Where a bound code is handed back to the app. The scheme and the parameter name are a contract with the desktop
 * shell's handler — `code` and nothing else, because a deep link carries the handoff code and never a token.
 */
const deepLink = (code: string): string => `ohmail://link?code=${encodeURIComponent(code)}`;

const toSignIn = (): void => { window.location.assign("/login"); };

/** What the ceremony holds, as the page's state, in the order the card drew it. */
function stateOf(c: LinkDesktopCeremony, bound: boolean, say: (err: unknown) => string): LinkDesktopState {
  if (c.settled.kind === "none") return { at: "signin" };
  if (c.settled.kind === "refused") return { at: "refused", said: say(c.settled.refusal) };
  if (c.settled.kind === "unchecked") return { at: "unchecked" };
  if (c.settled.kind === "checking") return { at: "checking" };
  const press = {
    busy: c.busy,
    retryIn: c.retryAt !== null ? c.retryIn : null,
    refusal: c.error,
    discarded: c.discarded,
    signIn: c.signIn,
    factor: c.phase === "stepup",
  };
  if (c.minted) return { at: "code", code: c.minted.code, remaining: c.remaining, bound, ...press };
  return { at: "start", ...press };
}

/**
 * The prop is the PKCE digest the app committed to, bound here as `commitment`: `challenge` names a 2FA challenge
 * everywhere else in this app, and the two mechanisms are unrelated.
 */
export function LinkDesktopRoute({ challenge: commitment = "" }: { challenge?: string }) {
  const c = useLinkDesktopDoor(commitment);
  const say = useRefusalSentence();
  const stepUp = useWebStepUp();
  const bound = commitment !== "";
  const door: LinkDesktopDoor = {
    state: stateOf(c, bound, say),
    press: c.press,
    // A custom scheme is not a route a client router can take: the document goes, as the old anchor's press did.
    openApp: () => { if (bound && c.minted) window.location.assign(deepLink(c.minted.code)); },
    signIn: toSignIn,
    stepUp,
    factor: {
      onVerified: c.stepUpVerified,
      onCancel: c.stepUpCancelled,
      onDiscarded: c.stepUpDiscarded,
      onOwnerAbsent: c.stepUpOwnerAbsent,
    },
  };
  return (
    <WebDoor>
      <LinkDesktopPage door={apiConfigured() ? door : NONE} />
    </WebDoor>
  );
}
