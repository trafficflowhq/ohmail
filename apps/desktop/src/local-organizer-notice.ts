/**
 * ACKNOWLEDGING THE ORGANIZER NOTICE FROM THIS WINDOW — the desktop half of one shared line.
 * The shared shell shows a quiet line when who organizes a mailbox has changed, with one press
 * that makes it go for good; the published bundle aliases the Cloud client to a refusing stub,
 * so the wire is injected by whichever host mounted it. One transport serves both doors:
 * `POST /mailboxes/:id/organizer-notice/dismiss` stamps one instant on the caller's own
 * mailbox row — standalone out of the store on this machine, Cloud through the write-through
 * proxy with the session's bearer. The acknowledgement lives on the row, not in a local
 * preference, so a phone, a browser tab and this window agree the change has been seen.
 */
import { bridgeFetch } from "./bridge-fetch.js";
import type { OrganizerNoticeTransport } from "../../webapp/app/shell/OrganizerNotice";

/**
 * MUST REJECT on failure — the shell reads a resolved promise as "acknowledged" and takes the
 * line off screen. A refusal has to come back as one, or a stamp that was never written would
 * look like one that was, and the line would return on the next poll with no explanation.
 */
export const organizerNoticeOverBridge: OrganizerNoticeTransport = async (mailboxId) => {
  const res = await bridgeFetch(
    `/mailboxes/${encodeURIComponent(mailboxId)}/organizer-notice/dismiss`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`${res.status}`);
  return undefined;
};
