/**
 * The away responder — the one thing this product does that sends mail on its own, and going away
 * is a phone moment. A FORM WITH A SAVE, not live controls: the message is prose, so a
 * live-saving field would write half a sentence into mail that goes out in somebody's name (the
 * webapp `AwayResponderRow`'s own rule, and this is the same route pair).
 *
 * This phone edits three fields and STATES the other three — who gets a reply, which piles, how
 * often — because the replace means every save carries them back, and a switch that turns on a
 * standing order without naming who it answers puts the consequence off screen.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { Copy } from "../src/copy";
import { useLocale } from "../src/i18n/LocaleProvider";
import { readAwayAnswer, saveAway } from "../src/net/away";
import { useConnection } from "../src/net/connection";
import { calendarDayLabel, dayEndIso, readerZone, setTimeLabel } from "../src/state/live";
import { useWorld } from "../src/state/world";
import {
  awayAudienceWide, awayPileWords, awayRefusalLine, awaySaveBlocked, awaySaveBody, awaySay,
  awayFailedLine, awaySavedUntil, awayStatedLine, awayUnsaved, awayUnsavedLine,
  type AwayRefusal, type AwayRow,
} from "../src/ui/away-form";
import { Button, Panel, Rule, Screen, Scroller, Section, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Field } from "../src/ui/Field";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";
import { Sheet, SheetRow } from "../src/ui/Sheet";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";

/** How far ahead the end-date rows reach — a quarter, the resurface chooser's own horizon. */
const END_DATE_DAYS = 90;

export default function AwayScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="away">
      <Gated>
        <AwayBody />
      </Gated>
    </SurfaceBoundary>
  );
}

/** What the last save answered. Held as a KIND; the sentence is chosen at render. */
type Said = null | "saved" | "asked" | "failed" | "unreachable" | "changed";

function AwayBody() {
  const locale = useLocale();
  const conn = useConnection();
  const w = useWorld();
  const session = conn.state.k === "live" ? conn.state.session : null;

  /** The SERVER's row, or `null` while the read has not landed. Never a default — see `net/away.ts`. */
  const [read, setRead] = useState<AwayRow | null>(null);
  const [asked, setAsked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [body, setBody] = useState("");
  const [endsAt, setEndsAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const [picking, setPicking] = useState(false);
  /** The holder's refusal of the last away change sent from here, as the read reports it. */
  const [refused, setRefused] = useState<AwayRefusal | null>(null);
  const navigation = useNavigation();
  /** A leave the stack held for an unsaved change: Discard dispatches it, Keep editing drops it. */
  const [leaving, setLeaving] = useState<null | { action: Parameters<typeof navigation.dispatch>[0] }>(null);

  /** Take a server row as the truth on screen — the values shown are always the stored ones. */
  const adopt = useCallback((row: AwayRow) => {
    setRead(row);
    setEnabled(row.enabled);
    setBody(row.body ?? "");
    setEndsAt(row.endsAt);
  }, []);

  useEffect(() => {
    if (session === null) return;
    let live = true;
    void readAwayAnswer(session).then((answer) => {
      if (!live) return;
      setAsked(true);
      /* A read that could not be made is NOT "off": it is "we could not ask", and the difference
         decides whether a save is allowed at all. `null` leaves the form unarmed and says so. */
      if (answer === null) { setSaid("unreachable"); return; }
      adopt(answer.row);
      setRefused(answer.refused);
    });
    return () => { live = false; };
  }, [session, adopt]);

  const now = new Date();
  const zone = readerZone();
  const say = awaySay(enabled, endsAt, now);
  const blocked = awaySaveBlocked({ enabled, body, endsAt }, now);
  /* The one thing the server refuses that this form can refuse first: a message nobody wrote,
     turned on. The webapp's `incomplete`, at the same door. */
  const incomplete = enabled && body.trim() === "";
  const canSave = read !== null && !saving && !blocked && !incomplete;
  /* THE EDIT AGAINST THE SAVED ROW. While they differ the line under the switch says so, and the
     stack asks before this screen goes — Back, the swipe and the rail alike. */
  const unsaved = awayUnsaved(read, { enabled, body, endsAt });
  usePreventRemove(unsaved && !saving, ({ data }) => setLeaving({ action: data.action }));
  const discardAndLeave = () => {
    const held = leaving;
    setLeaving(null);
    if (read !== null) adopt(read);
    if (held !== null) navigation.dispatch(held.action);
  };

  const save = async () => {
    const next = awaySaveBody(read, { enabled, body, endsAt });
    /* NO READ, NO SAVE. Composing a body without one would send the route's defaults for the
       three fields this screen does not edit, which narrows the audience and the pile scope on
       somebody's behalf — silently, and in the direction that stops mail going out. */
    if (next === null || session === null) { setSaid("unreachable"); return; }
    setSaving(true);
    setSaid(null);
    setRefused(null);
    const out = await saveAway(session, next);
    setSaving(false);
    if (out.kind === "refused") { setSaid("failed"); return; }
    /* The answer carries the row the SERVER now holds, and that is what the controls show —
       including on the 202, where nothing was written here at all. "Saved." over reverted values
       is the false state this branch exists to prevent. */
    adopt(out.row);
    setSaid(out.kind === "asked" ? "asked" : "saved");
  };

  /* The field's value is the edit; the sentence about it is the SAVED row's (`awaySavedUntil`). */
  const untilValue = endsAt === null ? Copy.awayUntilNone : setTimeLabel(endsAt, now, zone);
  const savedUntil = awaySavedUntil(read, now);
  const savedUntilLine = savedUntil === null || read?.endsAt == null ? null
    : savedUntil === "expired" ? Copy.awayUntilPast(setTimeLabel(read.endsAt, now, zone))
      : Copy.awayUntilOn(setTimeLabel(read.endsAt, now, zone));

  return (
    <Screen>
      {/* The page carries its own heading, so the bar carries only the way back. */}
      <DetailBar />
      <Scroller bounded>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.awayTitle}</Txt>
        </View>

        {/* THE SWITCH AND WHAT IT SAYS. Two segments rather than a toggle, the phone's own idiom
            for a two-way choice; the sentence under it is the state, not the control's label. */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <Segmented<"off" | "on">
              value={enabled ? "on" : "off"}
              onChange={(v) => { setEnabled(v === "on"); setSaid(null); }}
              segments={[
                { value: "off", label: Copy.awaySwitchOff },
                { value: "on", label: Copy.awaySwitchOn },
              ]}
            />
            {/* THE SAVED RESPONDER, never the segment's position — see `awayStatedLine`. */}
            <Txt variant="note" tone="ink2" style={{ marginTop: 10 }}>
              {awayStatedLine(read) ?? " "}
            </Txt>
            {/* AN UNSAVED CHANGE, said here with the Save that settles it, in view. */}
            {unsaved && read !== null ? (
              <View style={{ marginTop: 10, gap: 10 }}>
                <Txt variant="note" tone="ink" accessibilityLiveRegion="polite">{awayUnsavedLine(read)}</Txt>
                <View style={{ flexDirection: "row" }}>
                  <Button
                    label={saving ? Copy.awaySaving : Copy.awaySave}
                    variant="solid"
                    disabled={!canSave}
                    onPress={() => void save()}
                  />
                </View>
              </View>
            ) : null}
            {/* WHERE THE REPLIES COME FROM — this phone when it organizes the mailbox itself,
                otherwise the machine the More screen names. Neither sentence is a default: the
                world already knows which install holds this mailbox. */}
            <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
              {w.standalone
                ? Copy.awayWhereThisPhone
                : w.mailboxes.organizer
                  ? Copy.awayWhereHost(w.mailboxes.organizer.name)
                  : Copy.awayWhereThisPhone}
            </Txt>
          </View>
        </Panel>

        {/* THE MESSAGE — prose, so it is typed and then saved, never saved as it is typed. */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Field
            label={Copy.awayBodyLabel}
            value={body}
            onChange={(v) => { setBody(v); setSaid(null); }}
            input={{ multiline: true, autoCapitalize: "sentences", autoCorrect: true }}
            {...(incomplete ? { error: Copy.awayIncomplete } : {})}
          />
          <Txt variant="hint" tone="ink3" style={{ paddingHorizontal: 16, paddingTop: 10 }}>
            {Copy.awayNever}
          </Txt>
        </Panel>

        {/* THE END DATE — a day, resolved at the end of itself where the reader is. Rows rather
            than a native date picker: this app installs no datetime-picker module, and the
            resurface chooser already made a list the phone's idiom for exactly this. */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.awayUntilLabel}</Section>
          <View style={{ paddingHorizontal: 20, gap: 10 }}>
            <Txt variant="note" tone="ink2">{untilValue}</Txt>
            {savedUntilLine !== null ? (
              <Txt variant="note" tone={savedUntil === "expired" ? "ink" : "ink2"}>{savedUntilLine}</Txt>
            ) : null}
            {say === "expired" ? (
              <Txt variant="caption" tone="ink3">{Copy.awayUntilExpired}</Txt>
            ) : null}
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button label={Copy.awayUntilPick} variant="quiet" onPress={() => setPicking(true)} />
              {endsAt !== null ? (
                <Button
                  label={Copy.awayUntilClear}
                  variant="plain"
                  onPress={() => { setEndsAt(null); setSaid(null); }}
                />
              ) : null}
            </View>
          </View>
        </Panel>

        {/* WHAT THIS PHONE IS NOT OFFERING TO CHANGE, stated. Every save carries these back
            exactly as they were read, so they are facts about what will be sent and to whom. */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.awayAudienceLabel}</Section>
          <View style={{ paddingHorizontal: 20, gap: 4 }}>
            <Txt variant="note" tone="ink2">
              {read === null ? " " : awayAudienceWide(read.audience) ? Copy.awayEveryone : Copy.awayScreenedIn}
            </Txt>
          </View>
          <Rule inset={20} />
          <Section>{Copy.awayPilesLabel}</Section>
          <View style={{ paddingHorizontal: 20, gap: 4 }}>
            <PileLines piles={read === null ? null : read.piles} />
          </View>
          <Rule inset={20} />
          <Section>{Copy.awayThrottleLabel}</Section>
          <View style={{ paddingHorizontal: 20, gap: 4 }}>
            <Txt variant="note" tone="ink2">{read === null ? " " : throttleWord(read.throttle)}</Txt>
            <Txt variant="caption" tone="ink3" style={{ paddingTop: 6 }}>
              {Copy.awayScopeElsewhere}
            </Txt>
          </View>
        </Panel>

        <View style={{ paddingHorizontal: 16, paddingBottom: 20, gap: 10 }}>
          <View style={{ flexDirection: "row" }}>
            <Button
              label={saving ? Copy.awaySaving : Copy.awaySave}
              variant="solid"
              disabled={!canSave}
              onPress={() => void save()}
            />
          </View>
          {/* WHAT THE LAST SAVE DID. `asked` is the 202 and is not a failure; `unreachable` is a
              read that never landed, which is why nothing here can be saved. */}
          {said !== null ? (
            <Txt variant="note" tone={said === "saved" ? "ink2" : "ink"}>
              {said === "saved" ? Copy.awaySaved
                : said === "asked" ? Copy.awayAsked
                  : said === "changed" ? Copy.awayChangedElsewhere
                    : said === "unreachable" ? Copy.awayUnreachable
                      : awayFailedLine(read)}
            </Txt>
          ) : asked && read === null ? (
            <Txt variant="note" tone="ink">{Copy.awayUnreachable}</Txt>
          ) : refused !== null ? (
            <Txt variant="note" tone="ink">{awayRefusalLine(refused)}</Txt>
          ) : null}
        </View>
      </Scroller>

      {/* LEAVING WITH AN UNSAVED CHANGE ASKS. Closing the sheet is Keep editing. */}
      <Sheet open={leaving !== null} onClose={() => setLeaving(null)} label={Copy.awayLeaveAsk} cancel="own">
        <Txt variant="note" tone="ink" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {read !== null ? awayUnsavedLine(read) : Copy.awayLeaveAsk}
        </Txt>
        <SheetRow label={Copy.awayLeaveDiscard} onPress={discardAndLeave} />
        <SheetRow label={Copy.awayLeaveKeep} onPress={() => setLeaving(null)} />
      </Sheet>

      <Sheet open={picking} onClose={() => setPicking(false)} label={Copy.awayUntilLabel}>
        <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {Copy.awayUntilLabel}
        </Txt>
        {/* Floored at TOMORROW: an end date today has already begun, and the server refuses an
            instant already past while the responder is on. */}
        {Array.from({ length: END_DATE_DAYS }, (_, i) => {
          const at = dayEndIso(now, i + 1, zone);
          return (
            <SheetRow
              key={at}
              label={calendarDayLabel(new Date(at), locale)}
              on={endsAt === at}
              onPress={() => { setEndsAt(at); setSaid(null); setPicking(false); }}
            />
          );
        })}
      </Sheet>
    </Screen>
  );
}

/**
 * WHICH PILES GET A REPLY. A folder this build has no word for is named VERBATIM, never dropped:
 * a filtered list would state a narrower scope than the responder acts on, which reads on screen
 * as a promise that mail is not being answered when it is.
 */
function PileLines({ piles }: { piles: readonly string[] | null }) {
  if (piles === null) return <Txt variant="note" tone="ink2"> </Txt>;
  if (piles.length === 0) return <Txt variant="note" tone="ink">{Copy.awayPilesNone}</Txt>;
  const { known, verbatim } = awayPileWords(piles);
  const words = known.map((k) =>
    k === "ohbox" ? Copy.awayPileOhbox
      : k === "reads" ? Copy.awayPileReads
        : k === "receipts" ? Copy.awayPileReceipts
          : Copy.awayPileScreener);
  return (
    <>
      {words.length > 0 ? <Txt variant="note" tone="ink2">{words.join(", ")}</Txt> : null}
      {verbatim.map((folder) => (
        <Txt key={folder} variant="note" tone="ink2">{Copy.awayPileOther(folder)}</Txt>
      ))}
    </>
  );
}

/** The stored rate's word. An unrecognised member is shown verbatim rather than renamed. */
function throttleWord(throttle: string): string {
  switch (throttle) {
    case "always": return Copy.awayAlways;
    case "per_message": return Copy.awayPerMessage;
    case "per_week": return Copy.awayPerWeek;
    case "per_day": return Copy.awayPerDay;
    default: return throttle;
  }
}
