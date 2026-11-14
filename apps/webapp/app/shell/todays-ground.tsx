"use client";

/**
 * THE MAIL GROUND'S CONTEXTS, FILLED BY THE OLD SHELL. A place seated after the first one reads the ground and
 * nothing of a shell: the consent row (`useConsent()`), the partition (`usePartition()`), the mirror as the lists
 * present it (`usePresentedMirror()`) and the two doors of a letter (`useDoors()`). Where a host hands the ground
 * itself, the ground's own mounts make those calls. On the hosts that still hand the old shell's composition, that
 * shell stays the ONE caller of every hook: this file provides the shell's own instances as the ground's contexts,
 * so a frame holds one consent row, one partition, one presented mirror, one file door and one picture door,
 * whichever of the two stands above its panes. The mail state needs no fill: the old shell stands the ground's own
 * mount of it.
 *
 * It is the one file that reads the old shell for a seated place. What a place needs that the ground does not offer
 * yet is a new member of a ground context: typed in `@ohmail/app-logic`, filled here and in the ground's mount.
 * Nothing is derived here: a value handed in is the value provided. The two doors are handed one by one and
 * provided as one record, the same record while neither door moved; the doors in it are the shell's very objects.
 */
import { useMemo, type ReactNode } from "react";
import type { EntityReader } from "@ohmail/client-engine";
import { ConsentContext, PartitionContext, type ConsentRow, type Partition } from "@ohmail/app-logic/consent";
import { DoorsContext, type Doors } from "@ohmail/app-logic/reader/doors";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";

export interface TodaysGroundFill {
  /** The row the shell's one call answered, with its writers. */
  readonly consent: ConsentRow;
  /** The record the shell's one derivation answered. */
  readonly partition: Partition;
  /** The mirror as the shell's lists present it, composed over its own seam's holds in the render that moves them. */
  readonly presented: EntityReader;
  /** The shell's one file door; undefined where its engine opens no file. */
  readonly files: Doors["files"];
  /** The shell's one picture door; undefined where its host named no picture wire. */
  readonly pictures: Doors["pictures"];
}

export function TodaysGround({
  consent,
  partition,
  presented,
  files,
  pictures,
  children,
}: TodaysGroundFill & { readonly children: ReactNode }): ReactNode {
  const doors = useMemo((): Doors => ({ files, pictures }), [files, pictures]);
  return (
    <ConsentContext.Provider value={consent}>
      <PartitionContext.Provider value={partition}>
        <PresentedMirrorContext.Provider value={presented}>
          <DoorsContext.Provider value={doors}>{children}</DoorsContext.Provider>
        </PresentedMirrorContext.Provider>
      </PartitionContext.Provider>
    </ConsentContext.Provider>
  );
}
