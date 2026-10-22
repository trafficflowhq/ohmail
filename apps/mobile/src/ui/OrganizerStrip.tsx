/**
 * THE OHBOX'S STRIP ABOUT THIS PHONE'S CLAIM — one line, its note, and Settings' own verb.
 *
 * It decides nothing: `organizer-strip.ts` answers from the card's `claimHere(...)`, and this
 * renders it on the SAME subscription Settings reads, so a stand-down, a hand-back or a resume
 * redraws the list's line as it redraws the card. A strip, never a sheet. The claim strip is a
 * standalone door's; the gap offer draws on every door, its server's count included.
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Copy } from "../copy";
import {
  onOrganizerState, organizerHandBackLateSaid, organizerHandedBack, organizerInstruction,
  organizerStateVersion, pressOrganizeHere, standaloneHereFor,
} from "../engine/organizer-session";
import { answerGapLetters } from "../net/mailboxes";
import { useConnection } from "../net/connection";
import { useWorld } from "../state/world";
import { Button, Panel, Txt } from "./base";
import { stoodDown } from "./lifecycle-strip";
import { NotifyPermission } from "./NotifyPermission";
import { gapOffersOf, organizerStripOf, type OrganizerStrip as StripLine } from "./organizer-strip";
import { claimHere, pressSaidLine, pressSaidOf, type PhoneClaim, type PressSaid } from "./standalone-form";
import { useNotifyPermission } from "./useNotifyPermission";

export function OrganizerStrip() {
  /* A paired session has no door in this process and pays no subscription or permission read; the
     offer its server counted still reaches it. */
  return useWorld().standalone ? <OnThisPhone /> : <GapLetters />;
}

/**
 * THIS PHONE'S CLAIM AND THE STRIP LINE IT DRAWS, read once for every Ohbox line that speaks of it:
 * the strip, the connect notice and the knock (`readingAtConnectNow`, `knockSlotOf`). `null` on a
 * paired session, which has no door here.
 */
export function useStandaloneClaim(): { claim: PhoneClaim | null; strip: StripLine | null } {
  const w = useWorld();
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
  return { claim, strip };
}

function OnThisPhone() {
  const [said, setSaid] = useState<PressSaid>(null);
  const notify = useNotifyPermission();
  const { claim, strip } = useStandaloneClaim();
  /* THE ASK OUTLIVES THE STRIP: a start that worked turns the claim `ours`, which draws no strip,
     and the sheet it opens must still be there to answer. */
  const ask = (
    <>
      <GapLetters />
      <NotifyPermission open={notify.open} onAnswer={notify.answer} />
    </>
  );
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

/**
 * THE GAP OFFER (mail 0151, 0158) — letters that arrived while no device was organizing a mailbox
 * this phone, or the server it is paired with, now organizes: counted by the person's rules, and
 * apart from senders they have not decided about. File files the first set and puts the second in
 * the Screener on the next drain; Leave closes the offer. A press answered is hidden until the next
 * mailbox read.
 */
function GapLetters() {
  const w = useWorld();
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  /* The refusal's KIND, worded at render, so a language switch rewords it. */
  const [said, setSaid] = useState<"changed" | "failed" | null>(null);
  const key = (o: { id: string; count: number; strangers: number }): string => `${o.id}@${o.count}+${o.strangers}`;
  const offers = gapOffersOf(w.mailboxes.rows).filter((o) => !answered.has(key(o)));
  if (session === null || offers.length === 0) return null;
  const press = (o: { id: string; count: number; strangers: number }, file: boolean): void => {
    void answerGapLetters(session, o.id, { file, count: o.count, strangers: o.strangers }).then((r) => {
      if (r === "pressed" || r === "left") { setSaid(null); setAnswered((s) => new Set([...s, key(o)])); }
      else setSaid(r === "changed" ? "changed" : "failed");
    });
  };
  return (
    <>
      {offers.map((o) => (
        <Panel key={o.id} style={{ marginHorizontal: 6, marginBottom: 12, padding: 14, gap: 6 }}>
          <Txt variant="body" accessibilityRole="summary">{o.strangers === 0 ? Copy.gapLetters(o.count, o.address)
            : o.count === 0 ? Copy.gapStrangers(o.strangers, o.address) : Copy.gapBoth(o.count, o.strangers, o.address)}</Txt>
          {said === null ? null : (
            <Txt variant="note" tone="ink2" accessibilityRole="alert">{said === "changed" ? Copy.gapChanged : Copy.gapFailed}</Txt>
          )}
          <Button label={o.count === 0 ? Copy.gapScreen : Copy.gapFile} variant="quiet" style={{ alignSelf: "flex-start" }} onPress={() => press(o, true)} />
          <Button label={Copy.gapLeave} variant="quiet" style={{ alignSelf: "flex-start" }} onPress={() => press(o, false)} />
        </Panel>
      ))}
    </>
  );
}
