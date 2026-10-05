/**
 * THE OHBOX'S STRIP ABOUT THIS PHONE'S CLAIM — one line, its note, and Settings' own verb.
 *
 * It decides nothing: `organizer-strip.ts` answers from the card's `claimHere(...)`, and this
 * renders it on the SAME subscription Settings reads, so a stand-down, a hand-back or a resume
 * redraws the list's line as it redraws the card. A strip, never a sheet. A standalone door only.
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Copy } from "../copy";
import {
  onOrganizerState, organizerHandBackLateSaid, organizerHandedBack, organizerInstruction,
  organizerStateVersion, pressOrganizeHere, standaloneHereFor,
} from "../engine/organizer-session";
import { useWorld } from "../state/world";
import { Button, Panel, Txt } from "./base";
import { stoodDown } from "./lifecycle-strip";
import { NotifyPermission } from "./NotifyPermission";
import { organizerStripOf } from "./organizer-strip";
import { claimHere, pressSaidLine, pressSaidOf, type PressSaid } from "./standalone-form";
import { useNotifyPermission } from "./useNotifyPermission";

export function OrganizerStrip() {
  /* A paired session has no door in this process and pays no subscription or permission read. */
  return useWorld().standalone ? <OnThisPhone /> : null;
}

function OnThisPhone() {
  const w = useWorld();
  const [said, setSaid] = useState<PressSaid>(null);
  const notify = useNotifyPermission();
  useSyncExternalStore(
    useCallback((cb: () => void) => onOrganizerState(cb), []),
    organizerStateVersion,
    organizerStateVersion,
  );
  const here = standaloneHereFor({ standalone: w.standalone });
  const claim = here === null ? null : claimHere(here, organizerInstruction(), organizerHandedBack());
  const strip = claim === null ? null : organizerStripOf(claim, {
    stoppedHere: stoodDown(w.mailboxes.rows).length > 0,
    late: organizerHandBackLateSaid(),
    os: Platform.OS,
  });
  /* THE ASK OUTLIVES THE STRIP: a start that worked turns the claim `ours`, which draws no strip,
     and the sheet it opens must still be there to answer. */
  const ask = <NotifyPermission open={notify.open} onAnswer={notify.answer} />;
  if (claim === null || strip === null) return ask;
  /* THE PRESS'S ANSWER, beside the press — spent against the claim, as on the card. */
  const answer = pressSaidLine(said, claim);
  return (
    <>
      <Panel style={{ marginHorizontal: 6, marginBottom: 12, padding: 14, gap: 6 }}>
        <Txt variant="body" accessibilityRole="summary">{strip.label}</Txt>
        {strip.note === null ? null : <Txt variant="note" tone="ink2">{strip.note}</Txt>}
        {strip.late === null ? null : <Txt variant="note" tone="ink2">{strip.late}</Txt>}
        {answer === null ? null : (
          <Txt variant="note" tone="ink2" accessibilityRole="alert">{answer}</Txt>
        )}
        {strip.start ? (
          <Button
            label={Copy.settingsStartHere}
            variant="quiet"
            style={{ alignSelf: "flex-start" }}
            onPress={() => {
              /* THE CARD'S OWN DOOR AND ITS OWN ASK, in the same order: a refused start asks for
                 nothing, and a started one runs the notification ask the card runs. */
              void pressOrganizeHere("start").then(async (outcome) => {
                setSaid(pressSaidOf(outcome));
                if (outcome === "started") await notify.gate();
              });
            }}
          />
        ) : null}
      </Panel>
      {ask}
    </>
  );
}
