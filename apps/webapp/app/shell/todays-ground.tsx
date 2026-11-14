"use client";

/**
 * THE MAIL GROUND'S CONTEXTS, FILLED BY THE OLD SHELL. A place seated after the first one reads the ground and
 * nothing of a shell: the consent row (`useConsent()`), the partition (`usePartition()`) and the mirror as the lists
 * present it (`usePresentedMirror()`). Where a host hands the ground itself, the ground's own mounts make those
 * calls. On the hosts that still hand the old shell's composition, that shell stays the ONE caller of every hook:
 * this file provides the shell's own instances as the ground's contexts, so a frame holds one consent row, one
 * partition and one presented mirror, whichever of the two stands above its panes. The mail state needs no fill:
 * the old shell stands the ground's own mount of it.
 *
 * It is the one file that reads the old shell for a seated place. What a place needs that the ground does not offer
 * yet is a new member of a ground context: typed in `@ohmail/app-logic`, filled here and in the ground's mount.
 * Nothing is derived here and no hook is called: a value handed in is the value provided.
 */
import type { ReactNode } from "react";
import type { EntityReader } from "@ohmail/client-engine";
import { ConsentContext, PartitionContext, type ConsentRow, type Partition } from "@ohmail/app-logic/consent";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";

export interface TodaysGroundFill {
  /** The row the shell's one call answered, with its writers. */
  readonly consent: ConsentRow;
  /** The record the shell's one derivation answered. */
  readonly partition: Partition;
  /** The mirror as the shell's lists present it, composed over its own seam's holds in the render that moves them. */
  readonly presented: EntityReader;
}

export function TodaysGround({
  consent,
  partition,
  presented,
  children,
}: TodaysGroundFill & { readonly children: ReactNode }): ReactNode {
  return (
    <ConsentContext.Provider value={consent}>
      <PartitionContext.Provider value={partition}>
        <PresentedMirrorContext.Provider value={presented}>{children}</PresentedMirrorContext.Provider>
      </PartitionContext.Provider>
    </ConsentContext.Provider>
  );
}
