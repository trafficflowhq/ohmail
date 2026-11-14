"use client";

/**
 * THE PARTITION AND THE PRESENTED MIRROR, MOUNTED ABOVE THE PANES: whose mail this is and where each letter is
 * presented, derived once for a mounted frame (`usePartition()`), and the mirror as the lists present it, composed
 * once over what the frame's press seam holds back (`usePresented()`). It reads the mail state and the consent
 * row above it and the frame's room, and hands the room the mailbox facts, so one reader of them stands in a frame.
 */
import { useMemo, type ReactNode } from "react";
import { PartitionContext, useConsent, usePartitionOf } from "@ohmail/app-logic/consent";
import { useDemoMode, useDerivedVersion, useEngine, useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { PresentedMirrorContext, presentedOver } from "@ohmail/app-logic/reading";
import { useDayClock } from "@ohmail/app-logic/session/day-clock";
import { useRoomFacts, useRoomHolds } from "../../frame/index.js";
import { useTimeZone } from "../../text/index.js";

export function PresentedMount({ children }: { readonly children: ReactNode }): ReactNode {
  const engine = useEngine();
  const derived = useDerivedVersion();
  const demo = useDemoMode();
  const resolvedDemo = useResolvedDemoMode();
  const { mailboxes: facts, refresh } = useMailState();
  const consent = useConsent();
  /* The clock the cutline is drawn against: it moves when the day turns where the reader is. */
  const now = useDayClock(null, useTimeZone());
  /* What the seam holds back, read in the render in which it moves: a deleted letter leaves the lists with its
     report, never a commit later. */
  const { held, places } = useRoomHolds();
  useRoomFacts({ rows: facts, refresh });
  /* The mirror as it is: every mutation, body and search reads this one, never the presented one below. */
  const reader = engine.read();
  const partition = usePartitionOf({ engine, reader, derived, demo, resolvedDemo, now, facts, consent });
  const { consentView } = partition;
  const presented = useMemo(
    () => presentedOver(reader, consentView, held, places),
    [reader, consentView, held, places],
  );
  return (
    <PartitionContext.Provider value={partition}>
      <PresentedMirrorContext.Provider value={presented}>{children}</PresentedMirrorContext.Provider>
    </PartitionContext.Provider>
  );
}
