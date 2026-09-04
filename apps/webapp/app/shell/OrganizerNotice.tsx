"use client";

/**
 * ═══ WHO ORGANIZES THIS MAILBOX CHANGED — SAID ONCE, THEN GONE ════════════════════════════
 *
 * Exactly one install organizes a mailbox at a time; every other install that has it connected
 * reads it. Which install holds it can change — somebody presses "Organize here" on a laptop, a
 * server is stopped, a mailbox is released — and when it does, the same person may be sitting in
 * front of a window whose Screener has quietly stopped filing, or started.
 *
 * This is the line that says so. It appears when a change has not been acknowledged, carries one
 * action that acknowledges it, and then never appears again for that change.
 *
 * ── WHY ONCE, AND NOT A STANDING BANNER ───────────────────────────────────────────────────────
 *
 * Because reading a mailbox somebody else organizes is a NORMAL, often deliberate state — a phone
 * and a laptop on one mailbox is the ordinary shape of the product — and a banner that says so on
 * every visit is a warning about a decision the person already made. The durable record belongs
 * on the pane that holds durable records: Settings → Mailboxes keeps the state line and the
 * controls, permanently, and this says only what CHANGED.
 *
 * ── WHY IT IS DERIVED FROM TWO INSTANTS RATHER THAN A DISMISSED FLAG ──────────────────────────
 *
 * `organizerNotices` in `mail-state.ts` owns that argument in full. The short of it: the pair
 * lives on the mailbox row, so a phone, a browser and a desktop window agree about whether a
 * change has been seen, and acknowledging on one of them clears it on the others.
 *
 * ── THE ONE GATE THIS COMPONENT MAKES FOR ITSELF ──────────────────────────────────────────────
 *
 * No transport, no notice. A line that cannot be acknowledged is exactly the repeated warning the
 * whole design refuses to be — it would stand on every visit for ever, with a button that does
 * nothing or no button at all. The shell passes a transport only on a door that serves the route,
 * so the honest degraded state is silence plus the permanent line in Settings.
 */

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { OrganizerNotice as OrganizerNoticeFact } from "./mail-state";
import { goSettings } from "./routing";

/**
 * HOW "Mark read" REACHES THE ROW.
 *
 * Injected rather than imported, on the seam rule the away responder and the profile card already
 * follow: the browser reaches a hosted API, the desktop window reaches an engine on the same
 * machine over a pipe, and the sentence, the gate and the once-per-change rule have exactly one
 * implementation between them.
 *
 * MUST REJECT on failure. A resolved promise is read as "acknowledged" and the line leaves the
 * screen on this door until the next poll agrees; a rejection puts it back, which is the truthful
 * outcome for a stamp that was not written.
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
   * MAILBOXES ACKNOWLEDGED IN THIS SESSION, so the line leaves on the press rather than on the
   * poller's slower clock.
   *
   * Optimistic and NOT authoritative: the row is what decides, and the next poll brings the
   * stamped instant back and keeps this line gone on its own. This exists because the poll is
   * seconds away and a person who presses "Mark read" and watches nothing happen presses again.
   *
   * A FAILED write is removed from here again, so the line comes back rather than being silently
   * swallowed — the acknowledgement did not happen, and the surface must not claim it did.
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
