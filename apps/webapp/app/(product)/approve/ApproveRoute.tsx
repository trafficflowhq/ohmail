"use client";

/**
 * `/approve` as the web serves it: the approval's page over the approval's own ceremony (`use-approve-door.ts`), which
 * settles whose browser this is first, reads the request and waits, keeps it across a sign-in, and retries the
 * confirm once a stale factor verifies in the one step-up dialog. The page draws what the ceremony holds and calls its
 * acts; the request id stays here.
 */
import { NONE } from "@ohmail/app/host";
import { ApprovePage, type ApproveDoor, type ApproveState } from "@ohmail/app/doors/approve";
import { apiConfigured } from "../../api-client";
import { WebDoor } from "../door-device";
import { useWebStepUp } from "../mailbox/StepUp";
import { useRefusalSentence } from "../refusal-sentence";
import { useApproveDoor, type ApproveCeremony } from "./use-approve-door";

/** What the ceremony holds, as the page's state, in the order the card drew it. */
function stateOf(c: ApproveCeremony, request: string, say: (err: unknown) => string): ApproveState {
  if (!request) return { at: "bare" };
  if (c.phase === "done") return { at: "done" };
  if (c.phase === "denied") return { at: "denied" };
  if (c.settled.kind === "refused") return { at: "refused", said: say(c.settled.refusal) };
  if (c.settled.kind === "unchecked") return { at: "unchecked" };
  const retryIn = c.retryAt !== null ? c.retryIn : null;
  if (c.loading || c.settled.kind !== "owner") return { at: "checking", retryIn };
  if (!c.asked) return { at: "gone", said: c.error };
  const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(c.asked.requestedAt)) / 60_000);
  return {
    at: "ask",
    asked: {
      label: c.asked.label || null,
      platform: c.asked.platform || null,
      minutes,
      network: c.asked.ipClass || null,
      // Only `different` says anything: an unknown or missing answer says nothing rather than guess.
      otherNetwork: c.asked.network === "different",
      account: c.named,
      remaining: c.remaining,
    },
    busy: c.busy,
    retryIn,
    refusal: c.error ?? c.note,
    factor: c.phase === "stepUp",
  };
}

export function ApproveRoute({ request = "" }: { request?: string }) {
  const c = useApproveDoor(request);
  const say = useRefusalSentence();
  const stepUp = useWebStepUp();
  const door: ApproveDoor = {
    state: stateOf(c, request, say),
    confirm: c.confirm,
    deny: c.deny,
    stepUp,
    factor: {
      onVerified: c.stepUpVerified,
      onCancel: c.stepUpCancelled,
      onDiscarded: c.stepUpDiscarded,
      onOwnerAbsent: c.settleAgain,
    },
  };
  return (
    <WebDoor>
      <ApprovePage door={apiConfigured() ? door : NONE} />
    </WebDoor>
  );
}
