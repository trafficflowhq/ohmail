import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import { useState, type ReactNode } from "react";
import { isHeld, useDraftsList, type DraftsDoor } from "@ohmail/app-logic/drafts";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { useDayClock } from "@ohmail/app-logic/session/day-clock";
import { scheduleLabel, stampOver } from "@ohmail/app-logic/text/format";
import { useDraftSendLists } from "@ohmail/app-logic/writing/composer-lists";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import { COMPOSE_SEND_KEY } from "@ohmail/app-logic/writing/mail-send";
import { unresolvedSendRows } from "@ohmail/app-logic/writing/send-lock";
import { useFrame, usePress } from "../frame/index.js";
import { useTimeZone } from "../text/index.js";
import { DraftsAbove } from "./DraftsAbove.js";
import { useDiscardWords } from "./words.js";

/** Drafts and Write share these columns and the account's one composer. */
export function DraftsSeat({ children }: { readonly children: ReactNode }) {
  const { scheduled, waiting } = useDraftSendLists();
  const composer = useComposer();
  const { state } = useMailState();
  const { commands, host, route } = useFrame();
  const epoch = route.place === "write" ? composer.composeEpochNow() : null;
  const [opening, setOpening] = useState(() => draftOpening(epoch));
  if (opening.epoch !== epoch) setOpening(draftOpening(epoch));
  const { undoToast } = usePress();
  const now = useDayClock(null, useTimeZone());
  const words = useDiscardWords();
  const heldHere = unresolvedSendRows(COMPOSE_SEND_KEY, host.session.scope);
  const door: DraftsDoor = {
    waiting,
    heldHere,
    open: (d) => {
      // Another window can record an unconfirmed send after this row was drawn.
      const heldNow = unresolvedSendRows(COMPOSE_SEND_KEY, host.session.scope);
      if (isHeld({ heldHere: heldNow, waiting }, d)) commands.go({ place: "drafts", open: d.id });
      else composer.openDraft(d);
    },
    decide: composer.decideDraftDiscard,
    withdrawWaiting: composer.withdrawDraftWaiting,
    discard: (id, shown) => composer.discardDraftRow(id, shown, true),
    cancelSchedule: composer.cancelSchedule,
    editScheduled: composer.editScheduled,
    resolve: composer.resolveHeldSend,
    sendAgain: composer.sendAgain,
    repliesHere: composer.draftRepliesHere,
    notSent: composer.notSentRows,
  };
  const model = useDraftsList({
    drafts: composer.drafts,
    scheduled,
    settled: state.settled,
    owed: state.owed,
    door,
    report: undoToast,
    words,
    now,
    stamp: stampOver(now),
    appointment: (iso) => scheduleLabel(iso, now),
  });
  useSwitchEnded(route, route.place === "write" || !model.loading);
  return (
    <DraftsAbove model={model} openedAt={opening.at}>
      {children}
    </DraftsAbove>
  );
}

/** The blank row keeps its opening time even when the list window unmounts it. */
function draftOpening(epoch: number | null) {
  return { epoch, at: epoch === null ? undefined : new Date().toISOString() };
}
