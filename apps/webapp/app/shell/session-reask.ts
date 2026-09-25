"use client";

/**
 * A STORE READ THE SESSION REFUSED IS ASKED AGAIN ONCE THE SESSION IS RENEWED. History's and Search's
 * pages go out on the engine's transport, which does not renew, so a 401 there is the credential's
 * answer, not the store's. The read asks for the renewal itself (single-flight), is shown as loading
 * while that is out, and re-asks on the revival the renewal publishes. Bounded three ways: one renewal
 * asked per refusal, one re-ask per revival, and the store's own ceiling ends the wait.
 */
import { useEffect, useRef, useState } from "react";
import { STORE_ANSWER_TIMEOUT_MS } from "@ohmail/client-engine";
import { probeSessionNow, subscribeSessionRevival, useSessionDead } from "./session-truth";

/** Is this failure a refused credential? The engine's `errorClassOf` reads `<name> <status> <code>`. */
export function sessionRefused(cause: string | null): boolean {
  return cause !== null && cause.split(" ").includes("401");
}

type Phase = "idle" | "waiting" | "reasked" | "overdue";

/**
 * `true` while a refused read waits on its renewal. `answered` is the read landing, which ends the
 * episode; `reask` asks the store again. Refused a second time after a renewal, it says so — a server
 * refusing every fresh session must not drive a refresh loop.
 */
export function useSessionReask(cause: string | null, answered: boolean, reask: () => void): boolean {
  const refused = sessionRefused(cause);
  const dead = useSessionDead();
  const [phase, setPhase] = useState<Phase>("idle");
  const live = useRef({ refused, reask });
  live.current = { refused, reask };

  useEffect(() => {
    if (answered) setPhase("idle");
  }, [answered]);
  useEffect(() => {
    if (!refused) return undefined;
    if (phase === "reasked") {
      setPhase("overdue");
      return undefined;
    }
    if (phase === "waiting") return undefined;
    setPhase("waiting");
    probeSessionNow();
    const timer = setTimeout(() => setPhase((p) => (p === "waiting" ? "overdue" : p)), STORE_ANSWER_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // The phase is this effect's OUTPUT; a new refusal is what re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refused]);
  useEffect(() => subscribeSessionRevival(() => {
    if (!live.current.refused) return;
    setPhase("reasked");
    live.current.reask();
  }), []);
  return refused && !dead && (phase === "idle" || phase === "waiting");
}
