/**
 * THE PILES' SEAT (Answer Later, Parked, Resurface): what stands above the piles' two columns, and the value of the
 * three registrations' `Above`: one seat for the three, as they are one body, so a switch between them keeps it
 * standing. It hands the frame's side and what a list place's seat reads (`usePlaceListOwn`, the record the four
 * list places hand too) to the piles' live hook (`usePilesLive`, called here once), and stands the model, the reading
 * column's meeting line and the Reply Run. It reads the ground through the live hook's readers and mounts no piece
 * of it.
 *
 * NOT HERE, each absent until the part that draws it stands: the tag picker and the sender's sheet.
 */
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import type { ReactNode } from "react";
import { usePilesLive } from "@ohmail/app-logic/piles";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { usePlaceListOwn } from "../place-list/index.js";
import { useWriting } from "../write/index.js";
import { PilesMeeting } from "./PilesAbove.js";

export function PilesSeat({ children }: { readonly children: ReactNode }) {
  const writing = useWriting();
  const args = usePlaceLiveArgs();
  const model = usePilesLive(args, {
    ...usePlaceListOwn(),
    openReply: writing.openReply,
    closeReply: (id) => {
      if (writing.replyTo === id) writing.closeReply();
    },
  });
  useSwitchEnded(args.route, model.rows.length > 0 || model.mayState);
  return <PilesMeeting model={model}>{children}</PilesMeeting>;
}
