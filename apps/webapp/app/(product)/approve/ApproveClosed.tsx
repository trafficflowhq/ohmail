"use client";

/**
 * `/approve` on a self-hosted server: the approval's closed page. A self-hosted server mounts no browser approval
 * (`routes/desktop-approval.ts` is the hosted table's alone): the desktop asks only the hosted service, so a link here
 * was made by somebody else. The page says so and nothing more: no settle, no read, no kept request.
 */
import { ApprovePage, type ApproveDoor } from "@ohmail/app/doors/approve";
import { WebDoor } from "../door-device";
import { useWebStepUp } from "../mailbox/StepUp";

const nothing = (): void => {};

export function ApproveClosed() {
  const stepUp = useWebStepUp();
  const door: ApproveDoor = {
    state: { at: "closed" },
    confirm: nothing,
    deny: nothing,
    stepUp,
    factor: { onVerified: nothing, onCancel: nothing, onDiscarded: nothing },
  };
  return (
    <WebDoor>
      <ApprovePage door={door} />
    </WebDoor>
  );
}
