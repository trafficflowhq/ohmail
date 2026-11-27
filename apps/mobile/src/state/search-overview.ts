import { useEffect, useState } from "react";
import { mailboxTotalOf } from "@ohmail/app-logic/search/supplies";
import { mailboxSessionWithSignal, readMailboxes } from "../net/mailboxes";
import { useLiveSession } from "./world";

/** Read the account's aggregate on the resting screen, separately from the routine mailbox roster. */
export function useSearchMailboxTotal(resting: boolean): number | null {
  const session = useLiveSession();
  const [answer, setAnswer] = useState<{ session: NonNullable<typeof session>; total: number | null }>();
  const held = answer?.session === session ? answer : undefined;
  useEffect(() => {
    if (!resting || !session || held) return;
    const controller = new AbortController();
    void readMailboxes(mailboxSessionWithSignal(session, controller.signal), true).then((mailboxes) => {
      if (!controller.signal.aborted && mailboxes !== null) {
        setAnswer({ session, total: mailboxTotalOf(mailboxes) });
      }
    });
    return () => controller.abort();
  }, [resting, session, held]);
  return held?.total ?? null;
}
