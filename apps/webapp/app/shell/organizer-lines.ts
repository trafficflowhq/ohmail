"use client";

/* THE ORGANIZER'S TWO LINES ABOVE THE OHBOX, out of `ShellInner` whole: what changed about who
   organizes these mailboxes and has not been acknowledged, and the letters that arrived while
   nothing did (mail 0151). Both are derived from the polled rows and answered through a door the
   host injects; each is withheld where nothing can answer it, since it would stand for ever. */

import { useMemo } from "react";

import type { GapLettersTransport } from "./GapLettersNotice";
import { gapOffers, organizerNotices } from "./mail-state";
import type { OrganizerNoticeTransport } from "./OrganizerNotice";
import { useStableCallback } from "./stable-callback";

export function useOrganizerLines({ facts, demo, organizerNoticeTransport, gapLettersTransport, refreshFacts }: {
  facts: Parameters<typeof organizerNotices>[0];
  demo: boolean;
  organizerNoticeTransport: OrganizerNoticeTransport | undefined;
  gapLettersTransport: GapLettersTransport | undefined;
  refreshFacts: () => void;
}) {
  /* `organizerNotices` is the rule, memoised on the polled rows; the list is usually empty. */
  const organizerChanges = useMemo(() => organizerNotices(facts), [facts]);
  /* "Mark read" through the injected door (one route, `POST /mailboxes/:id/organizer-notice/dismiss`,
     on two transports: the publish script denies `app/api-client` to this shell). `refreshFacts` so the
     line leaves on the answer; a rejection passes through and the component puts the line back. A
     stable callback, never a memoized closure: that would pin its render's scope (`stable-callback.ts`). */
  const acknowledgeOrganizerNotice: OrganizerNoticeTransport = useStableCallback(async (id: string) => {
    const answer = await organizerNoticeTransport?.(id);
    refreshFacts();
    return answer;
  });
  const noticeOn = !demo && organizerNoticeTransport !== undefined && organizerChanges.length > 0;
  /* The gap offers: the rows are read again either way, so a refused count is replaced by the new one. */
  const gapOfferList = useMemo(() => gapOffers(facts), [facts]);
  const answerGapLetters: GapLettersTransport = useStableCallback(async (id: string, a: { file: boolean; count: number; strangers: number }) => {
    try { return await gapLettersTransport?.(id, a); } finally { refreshFacts(); }
  });
  const gapOn = !demo && gapLettersTransport !== undefined && gapOfferList.length > 0;
  return { organizerChanges, acknowledgeOrganizerNotice, noticeOn, gapOfferList, answerGapLetters, gapOn };
}
