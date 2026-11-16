"use client";

/**
 * `/account/delete` as the web serves it: the delete page over its own ceremony (`use-delete-account-door.ts`), which
 * settles whose browser this is, reads the session's own address, asks the second factor on every press with the one
 * step-up dialog and erases only once it verifies. Every way on leaves as a document: the erased account's engine and
 * mirror must not outlive the page, and the server re-decides `/` from the cookies that are left.
 */
import { NONE } from "@ohmail/app/host";
import {
  DeleteAccountPage, type DeleteAccountDoor, type DeleteAccountState,
} from "@ohmail/app/doors/delete-account";
import { apiConfigured } from "../../../api-client";
import { SELF_HOST_BUILD } from "../../../hello";
import { WebDoor } from "../../door-device";
import { useWebStepUp } from "../../mailbox/StepUp";
import { useRefusalSentence } from "../../refusal-sentence";
import { useDeleteAccountDoor, type DeleteAccountCeremony } from "./use-delete-account-door";

const leaveFor = (to: string) => (): void => { window.location.assign(to); };

/** What the ceremony holds, as the page's state, in the order the pane drew it. */
function stateOf(c: DeleteAccountCeremony, say: (err: unknown) => string): DeleteAccountState {
  if (c.stage === "done" && c.result) {
    return { at: "done", subscription: c.cancelledEarlier ? "cancelled" : c.result.subscription, unclean: c.eraseMirrorBlocked };
  }
  if (c.settled.kind === "refused") return { at: "refused", said: say(c.settled.refusal) };
  if (c.settled.kind === "unchecked") return { at: "unchecked" };
  if (c.sessionFailed !== null) return { at: "refused", said: c.sessionFailed };
  if (c.signedOut) return { at: "signedout" };
  if (c.who === null) return { at: "checking" };
  return {
    at: "form",
    email: c.who.email,
    subscription: c.manageOffered,
    typed: c.typed,
    busy: c.stage === "erasing",
    refusal: c.error,
    cancelled: c.discarded,
    factor: c.stage === "factor",
  };
}

export function DeleteAccountRoute() {
  const c = useDeleteAccountDoor();
  const say = useRefusalSentence();
  const stepUp = useWebStepUp();
  const door: DeleteAccountDoor = {
    state: stateOf(c, say),
    service: SELF_HOST_BUILD ? "self" : "managed",
    type: c.setTyped,
    begin: c.begin,
    back: leaveFor("/"),
    // A full navigation, not a router push: it tears down what this tab held of the erased account, and the cookies
    // are already cleared, so `/` re-decides.
    home: () => { window.location.replace("/"); },
    signIn: leaveFor("/login"),
    privacy: leaveFor("/privacy"),
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
      <DeleteAccountPage door={apiConfigured() ? door : NONE} />
    </WebDoor>
  );
}
