"use client";

/**
 * `/subscribed` as the web serves it: the return after paying over its own ceremony (`use-subscribed-door.ts`), which
 * goes on to the app by itself where a session stands. Open ohmail leaves as a document, as the old link did.
 */
import { SubscribedPage, type SubscribedDoor } from "@ohmail/app/doors/subscribed";
import { WebDoor } from "../door-device";
import { useSubscribedDoor } from "./use-subscribed-door";

const toApp = (): void => { window.location.assign("/"); };

export function SubscribedRoute() {
  const { signedIn } = useSubscribedDoor();
  const door: SubscribedDoor = { state: { at: signedIn === false ? "back" : "continuing" }, open: toApp };
  return (
    <WebDoor>
      <SubscribedPage door={door} />
    </WebDoor>
  );
}
