/**
 * The gate, rendered — the one component that turns `gateFor`'s verdict into a surface. Both
 * mail groups wrap themselves in this: the tabs layout AND the pushed mail detail routes
 * (`app/(mail)/_layout.tsx`). The second wrap exists because a deep link on an unpaired phone
 * mounts a detail route without the tabs layout ever focusing, and a gate living only on the
 * tabs would leave that reader on an empty world with no way out. Connection-flow routes
 * (welcome, servers, scan, connect) stay ungated on purpose: they are where the verdicts route
 * to — including the wall's way off itself.
 */
import { Redirect } from "expo-router";
import { useSyncExternalStore, type ReactNode } from "react";
import { useConnection } from "../net/connection";
import { accessLock, onAccessLock } from "../net/access-lock";
import { gateFor } from "../state/gate";
import { AccountWall } from "./AccountWall";
import { BootShell } from "./Skeleton";

/** The 402 sink's slot, subscribed — the transport writes it from outside React. */
function useAccessLock(): ReturnType<typeof accessLock> {
  return useSyncExternalStore(onAccessLock, accessLock, accessLock);
}

export function Gated({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const lock = useAccessLock();
  const verdict = gateFor(conn.state, conn.profiles.length, lock);
  const session = conn.state.k === "live" ? conn.state.session : null;

  // NOT CONNECTED → the connect flow owns the screen; the mail UI renders only a live
  // mirror. `boot` and `connecting` both paint the instant shell (`BootShell`): the same
  // canvas + top bar the mail screens stand on, with the list silhouette arriving only
  // after the skeleton grace — so the keystore instant stays a quiet frame (a paired phone
  // never flashes the welcome screen on its way to mail), a LOCAL boot passes through in
  // milliseconds with no text screen, and nothing here ever waits on the network (the
  // connection layer goes live off the on-device mirror; sync runs behind the mail UI).
  if (verdict.to === "boot" || verdict.to === "connecting") return <BootShell />;
  if (verdict.to === "welcome") return <Redirect href="/welcome" />;
  if (verdict.to === "servers") return <Redirect href="/servers" />;
  /* AHEAD OF THE APP, the way the browser tab swaps its own surface: a person whose account the
     service has refused should not be reading mail behind it. It takes nothing away — the mirror
     on this phone is untouched and so is the mailbox. */
  if (verdict.to === "wall") return <AccountWall facts={verdict.facts} session={session} />;
  return <>{children}</>;
}
