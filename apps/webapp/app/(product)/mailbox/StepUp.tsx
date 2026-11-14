"use client";

/**
 * THE STEP-UP DIALOG AS THE WEB MOUNTS IT: the one binding of `@ohmail/app/doors/step-up`, over the web's step-up door
 * (`web-step-up.ts`) and the doors' reader. It takes `StepUpPrompt`'s four inputs, so a place switches to it by one
 * import line, and the place's own line about what happens the moment the factor verifies.
 */
import { useMemo } from "react";
import { StepUpDialog, type StepUpDoor, type StepUpProps } from "@ohmail/app/doors/step-up";
import { DoorText } from "../door-device";
import { useRefusalSentence } from "../refusal-sentence";
import { webStepUp } from "./web-step-up";

/** The web's step-up door, its refusals said in the reader's language: what a door's page hands its dialog. */
export function useWebStepUp(): StepUpDoor {
  const say = useRefusalSentence();
  return useMemo(() => webStepUp(say), [say]);
}

export function StepUp(props: StepUpProps & { line?: string }) {
  const door = useWebStepUp();
  return (
    <DoorText>
      <StepUpDialog door={door} {...props} />
    </DoorText>
  );
}
