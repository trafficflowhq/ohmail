import type { ReaderInvitationProps } from "@ohmail/app/reader";
import { useDoors } from "@ohmail/app-logic/reader/doors";
import { IcsEventCards } from "./IcsEventCard";
import { InvitationNote } from "./InvitationNote";

/** The Reader's file strip already holds this letter's list on the same scoped door. */
export function ReaderInvitation({ messageId, invitationWithoutEvent, text, full }: ReaderInvitationProps) {
  const { files } = useDoors();
  return (
    <>
      <InvitationNote message={{ invitationWithoutEvent }} text={text} full={full} className="rd-invitation-note" />
      <IcsEventCards events={files?.eventsOf(messageId) ?? []} />
    </>
  );
}
