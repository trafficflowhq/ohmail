/**
 * THE GATE, RENDERED — the one component that turns `gateFor`'s verdict into a surface.
 *
 * Both mail groups wrap themselves in this: the tabs layout AND the pushed mail detail
 * routes (`app/(mail)/_layout.tsx`). The second wrap exists because a deep link —
 * `ohmail://message/<id>` on an unpaired phone, a route restored after the session ended —
 * mounts a detail route WITHOUT the tabs layout ever focusing, and a gate that lives only
 * on the tabs would leave that reader on an empty world with no way out. Connection-flow
 * routes (welcome, servers, scan, connect) stay ungated on purpose: they are where the
 * verdicts route TO.
 */
import { Redirect } from "expo-router";
import type { ReactNode } from "react";
import { useConnection } from "../net/connection";
import { gateFor } from "../state/gate";
import { BootShell } from "./Skeleton";

export function Gated({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const verdict = gateFor(conn.state, conn.profiles.length);

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
  return <>{children}</>;
}
