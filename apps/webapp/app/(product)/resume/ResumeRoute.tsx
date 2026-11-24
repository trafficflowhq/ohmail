"use client";

/**
 * `/` while the gate answers "resume": the signed-out page over the splash's ceremony (`use-resume-door.ts`). The
 * page draws from the first frame, server-rendered; the ways on leave as documents, as the splash's own do.
 */
import { NONE } from "@ohmail/app/host";
import { SignedOutPage, type SignedOutDoor } from "@ohmail/app/doors/signed-out";
import { WebDoor } from "../door-device";
import { useResumeDoor } from "./use-resume-door";

const toSignIn = (): void => { window.location.assign("/login"); };

export function ResumeRoute({ initialOwner = null, staleJar }: { initialOwner?: string | null; staleJar?: string }) {
  const { state, tryAgain } = useResumeDoor({ initialOwner, staleJar });
  const door: SignedOutDoor = { state, tryAgain, signIn: toSignIn, demo: NONE };
  return (
    <WebDoor>
      <SignedOutPage door={door} />
    </WebDoor>
  );
}
