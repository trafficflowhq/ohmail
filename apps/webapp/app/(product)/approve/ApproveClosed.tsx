"use client";

/** The self-hosted approval page when opened without a valid request. */
import { ApprovePage, type ApproveDoor } from "@ohmail/app/doors/approve";
import { WebDoor } from "../door-device";
import { useWebStepUp } from "../mailbox/StepUp";

const nothing = (): void => {};

export function ApproveClosed({ expired = false }: { expired?: boolean }) {
  const stepUp = useWebStepUp();
  const door: ApproveDoor = {
    state: expired ? { at: "gone", said: null, phone: true } : { at: "closed" },
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
