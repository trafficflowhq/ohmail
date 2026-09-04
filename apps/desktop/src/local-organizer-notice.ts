/**
 * ACKNOWLEDGING THE ORGANIZER NOTICE FROM THIS WINDOW — the desktop half of one shared line.
 *
 * The shared shell shows a quiet line when who organizes a mailbox has changed and nobody has
 * acknowledged it yet, with one press that makes it go for good. It cannot make that press
 * itself: the published bundle aliases the Cloud client to a refusing stub, and the shell is
 * denied that import in any case, so the wire is injected by whichever host mounted it.
 *
 * ── ONE TRANSPORT FOR BOTH DOORS, WHICH IS NOT TRUE OF EVERY SEAM HERE ────────────────────────
 *
 * The away responder needs a door rule and the profile card needs another, because what those
 * routes DO differs between a standalone install and a Cloud-connected one. This one does not.
 * `POST /mailboxes/:id/organizer-notice/dismiss` stamps one instant on the caller's own mailbox
 * row and is mounted on both doors: the standalone engine serves it out of the store on this
 * machine, and on the Cloud door the write-through proxy forwards it to the hosted account with
 * the session's bearer. The window presses the same path either way.
 *
 * The acknowledgement is deliberately not a local preference. It lives on the row so that a phone,
 * a browser tab and this window agree about whether a change has been seen — a per-install flag
 * would show one change once per install, which is the same sentence three times.
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
