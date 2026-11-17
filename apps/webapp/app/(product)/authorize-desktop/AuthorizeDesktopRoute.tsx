"use client";

/**
 * `/authorize-desktop` as the web serves it: the native authorization's page over its own ceremony
 * (`use-authorize-desktop-door.ts`), which settles whose browser this is, READS the request (nothing is minted on
 * load), counts down the server's seconds, and on the press confirms and opens the app's own address; a stale factor
 * is asked in the one step-up dialog. The handle stays here; Sign in leaves as a document.
 */
import { NONE } from "@ohmail/app/host";
import {
  AuthorizeDesktopPage, type AuthorizeDesktopDoor, type AuthorizeDesktopState,
} from "@ohmail/app/doors/authorize-desktop";
import { apiConfigured } from "../../api-client";
import { WebDoor } from "../door-device";
import { useWebStepUp } from "../mailbox/StepUp";
import { useRefusalSentence } from "../refusal-sentence";
import { useAuthorizeDesktopDoor, type AuthorizeDesktopCeremony } from "./use-authorize-desktop-door";

const toSignIn = (): void => { window.location.assign("/login"); };

/** What the ceremony holds, as the page's state, in the order the card drew it. */
function stateOf(c: AuthorizeDesktopCeremony, request: string, say: (err: unknown) => string): AuthorizeDesktopState {
  if (c.done) return { at: "done" };
  if (request && c.settled.kind === "none") return { at: "signin" };
  if (request && c.settled.kind === "refused") return { at: "refused", said: say(c.settled.refusal) };
  if (request && c.settled.kind === "unchecked") return { at: "unchecked" };
  if (c.loading || (request && c.settled.kind !== "owner")) return { at: "checking" };
  if (!c.asked) return { at: "over", said: c.error };
  return {
    at: "ask",
    client: c.asked.clientId,
    address: c.asked.address,
    remaining: c.remaining,
    busy: c.busy,
    refusal: c.error,
    factor: c.stepUp,
  };
}

export function AuthorizeDesktopRoute({ request = "" }: { request?: string }) {
  const c = useAuthorizeDesktopDoor(request);
  const say = useRefusalSentence();
  const stepUp = useWebStepUp();
  const door: AuthorizeDesktopDoor = {
    state: stateOf(c, request, say),
    confirm: () => c.confirm(),
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
      <AuthorizeDesktopPage door={apiConfigured() ? door : NONE} />
    </WebDoor>
  );
}
