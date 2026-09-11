"use client";

/**
 * Who organizes this mailbox changed — said once, then gone. Exactly one install organizes a mailbox; which one can
 * change ("Organize here" on a laptop, a stopped server, a release), and the same person may sit in front of a window
 * whose Screener quietly stopped filing, or started. This line appears while a change is unacknowledged, carries one
 * action, then never again for that change. Once and not a standing banner: reading a mailbox somebody else organizes
 * is a normal, often deliberate state, and the durable record lives in Settings → Mailboxes. Derived from two
 * instants rather than a dismissed flag (`organizerNotices` in `mail-state.ts` owns the argument): the pair lives on
 * the mailbox row, so acknowledging on one device clears it on the others. The one gate this component makes for
 * itself: no transport, no notice — a line that cannot be acknowledged would stand on every visit for ever.
 */

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { OrganizerNotice as OrganizerNoticeFact } from "./mail-state";
import { goSettings } from "./routing";

/**
 * How "Mark read" reaches the row. Injected rather than imported, on the seam rule the away
 * responder and the profile card follow: the browser reaches a hosted API, the desktop window
 * reaches an engine on the same machine over a pipe, and the sentence, the gate and the
 * once-per-change rule have exactly one implementation between them. MUST REJECT on failure: a
 * resolved promise is read as "acknowledged" and the line leaves the screen until the next poll
 * agrees; a rejection puts it back — the truthful outcome for a stamp that was not written.
 */
export type OrganizerNoticeTransport = (mailboxId: string) => Promise<unknown>;

export function OrganizerNotice({
  notices,
  onAcknowledge,
}: {
  /** `organizerNotices(facts)`, newest change first. Empty renders nothing at all. */
  notices: readonly OrganizerNoticeFact[];
  onAcknowledge: OrganizerNoticeTransport;
}) {
  const t = useTranslations("mailboxes");
  /**
   * Mailboxes acknowledged in this session, so the line leaves on the press rather than on the
   * poller's slower clock. Optimistic and NOT authoritative: the row decides, and the next poll
   * brings the stamped instant back and keeps the line gone on its own — this exists because the
   * poll is seconds away and a person who presses "Mark read" and watches nothing happen presses
   * again. A FAILED write is removed from here again, so the line comes back: the acknowledgement
   * did not happen, and the surface must not claim it did.
   */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const live = notices.filter((n) => !acknowledged.has(n.id));
  if (live.length === 0) return null;

  const sentence = (n: OrganizerNoticeFact): ReactNode => {
    if (n.kind === "here") return t("noticeHere", { address: n.address });
    if (n.kind === "released") return t("noticeReleased", { address: n.address });
    if (n.kind === "stopped") {
      /* THE ONE OPEN CONDITION OF THE FOUR, and the only one whose sentence carries emphasis:
         nobody is filing this mailbox, and mail is accumulating unsorted while that is true. The
         other three describe a change that has already settled. `rich` rather than two keys
         because the lead and the tail are one sentence, and a language that orders them
         differently must be free to. */
      const mark = { b: (chunks: ReactNode) => <b>{chunks}</b> };
      return n.name
        ? t.rich("noticeStopped", { ...mark, name: n.name, address: n.address })
        : t.rich("noticeStoppedUnknown", { ...mark, address: n.address });
    }
    return n.name
      ? t("noticeElsewhere", { name: n.name, address: n.address })
      : t("noticeElsewhereUnknown", { address: n.address });
  };

  const acknowledge = (id: string): void => {
    setAcknowledged((s) => new Set(s).add(id));
    void onAcknowledge(id).catch(() => {
      setAcknowledged((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    });
  };

  /* ONE LINE PER MAILBOX, and not one line for the roster. Two mailboxes changing hands are two
     facts with two different remedies, and each is acknowledged on its own row — a combined line
     would either name one mailbox and hide the other, or be acknowledged for both by a press
     about one. Newest first, so a slot with room for one carries the most recent change. */
  return (
    <>
      {live.map((n) => (
        <div className="ohx-notice ohx-organizer" role="status" data-state={n.kind} key={n.id}>
          <span>{sentence(n)}</span>
          {/* THE WAY TO ACT ON IT, ON THE ONE LINE THAT NAMES SOMETHING TO ACT ON. A mailbox
              nobody organizes is the state a person would want to fix from here; the other three
              describe a settled situation whose durable record and controls are in the same pane
              anyway. "Mark read" ends every line, last, so the acknowledging press is always in
              the same place. */}
          {n.kind === "stopped" ? (
            <button type="button" onClick={() => goSettings("mailboxes")}>
              {t("noticeOpenMailboxes")}
            </button>
          ) : null}
          <button type="button" onClick={() => acknowledge(n.id)}>
            {t("noticeDismiss")}
          </button>
        </div>
      ))}
    </>
  );
}
