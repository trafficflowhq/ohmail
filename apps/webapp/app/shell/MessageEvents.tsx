"use client";

/**
 * A MEETING INVITATION'S EVENT, ONCE, AT THE TOP OF THE MESSAGE — on every body surface, right
 * after `InvitationNote` and before the element that holds the mail. One card per distinct event
 * (`AttachmentsChrome.eventsOf`, deduplicated by UID and RECURRENCE-ID), from whichever calendar
 * part carries it. Holds the message's list as `MessageFiles` does, so the calendar pass is asked
 * on any surface. Nothing until the texts land; no controls: the files stay in the strip. Each card
 * stands in its own boundary: a calendar part that throws drops its card, never the pane.
 */
import { useEffect } from "react";
import { IcsEventCard } from "../components/IcsEventCard";
import { useMessageChrome } from "./message-chrome";
import { ViewBoundary } from "./ViewBoundary";

export function MessageEvents({ messageId }: { messageId: string }) {
  const attachments = useMessageChrome().attachments;
  const hold = attachments?.hold;
  useEffect(() => hold?.(messageId), [hold, messageId]);
  const events = attachments?.eventsOf(messageId) ?? [];
  if (events.length === 0) return null;
  return (
    <div className="msg-events">
      {events.map((e) => (
        <ViewBoundary key={e.partId} fallback={null}>
          <IcsEventCard event={e.event} />
        </ViewBoundary>
      ))}
    </div>
  );
}
