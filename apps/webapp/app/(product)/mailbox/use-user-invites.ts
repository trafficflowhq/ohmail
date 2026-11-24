"use client";

import { useEffect, useState } from "react";
import { SELF_HOST_BUILD, serverHello } from "../../hello";

/**
 * Should this client offer the Invites pane at all? Two gates, one per kind of truth:
 * `SELF_HOST_BUILD` is COMPILED (`app/hello.ts`) — on the managed bundle the effect body is a
 * constant `return`, no `/hello` round trip, `false` for ever, structurally; `features.pairing` is
 * the SERVER's runtime word — the capability handshake exists so a client learns a ceremony's
 * absence from the descriptor, never from a 404 mid-flow, and an older server that does not
 * announce pairing gets no pane rather than one whose every verb would bounce. `false` while
 * pending: a nav entry appearing a beat after mount is cheaper than one that opens onto refusals.
 */
export function useUserInvites(demo: boolean): boolean {
  const [pairing, setPairing] = useState(false);
  useEffect(() => {
    /* THE DEMO'S WORD FIRST, as on every other capability hook here. This one had no demo gate
       at all, so a fixtures page on a self-host build paid a `/hello` round trip for a pane whose
       every verb mints a real credential. The caller passes the RESOLVED answer — see
       `CloudShell`. */
    if (demo || !SELF_HOST_BUILD) return;
    let alive = true;
    void serverHello().then((h) => {
      if (alive) setPairing(h?.features?.pairing === true);
    });
    return () => {
      alive = false;
    };
  }, [demo]);
  return pairing;
}
