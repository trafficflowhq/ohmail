/** Away responder settings over the paired or on-device organizer's session. */
import { AWAY_ANSWERABLE_PILES, AWAY_PILE_VIEW, AWAY_SCREENER_FOLDER, awayEffectivePiles } from "@ohmail/app-logic/away";
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
  type AwayEdits, type AwayRefusal, type AwayRow, type AwayScope,
} from "../src/ui/away-form";
import { MailAppearance } from "../src/theme/mail";
import { Button, Chip, Panel, Rule, Screen, Scroller, Section, Tap, Txt, ViewHead } from "../src/ui/base";
import { DetailBar, PaneTop } from "../src/ui/chrome";
import { Field } from "../src/ui/Field";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";
import { Sheet, SheetRow } from "../src/ui/Sheet";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { YieldToMore } from "../src/ui/more-move";
import { useUnsavedHold } from "../src/ui/more-pane";

/** How far ahead the end-date rows reach — a quarter, the resurface chooser's own horizon. */
const END_DATE_DAYS = 90;

export default function AwayScreen({ inPane = false }: { inPane?: boolean }) {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="away">
      <Gated>
        <YieldToMore paneKey={inPane ? null : "away"}>
          <MailAppearance><AwayBody inPane={inPane} /></MailAppearance>
        </YieldToMore>
      </Gated>
    </SurfaceBoundary>
  );
}

/** What the last save answered. Held as a KIND; the sentence is chosen at render. */
type Said = null | "saved" | "asked" | "failed" | "unreachable" | "changed";

function AwayBody({ inPane }: { inPane: boolean }) {
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
  const [scope, setScope] = useState<AwayScope | null>(null);
  const [pickingRate, setPickingRate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const [picking, setPicking] = useState(false);
  /** The holder's refusal of the last away change sent from here, as the read reports it. */
  const [refused, setRefused] = useState<AwayRefusal | null>(null);
  const navigation = useNavigation();
  /** A leave the stack held for an unsaved change: Discard dispatches it, Keep editing drops it. */
  const [leaving, setLeaving] = useState<null | { action: Parameters<typeof navigation.dispatch>[0] }>(null);
  /** The same for a pick of another destination in More's pane, which is no stack leave. */
  const [paneLeave, setPaneLeave] = useState<null | { go: () => void }>(null);

  /** Take a server row as the truth on screen — the values shown are always the stored ones. */
  const adopt = useCallback((row: AwayRow) => {
    setRead(row);
    setEnabled(row.enabled);
    setBody(row.body ?? "");
    setEndsAt(row.endsAt);
    setScope({ audience: row.audience, piles: row.piles, throttle: row.throttle });
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
  const edits: AwayEdits = { enabled, body, endsAt, ...(scope ? { scope } : {}) };
  const unsaved = awayUnsaved(read, edits);
  const editScope = (patch: Partial<AwayScope>) => {
    if (!scope || saving) return;
    setScope({ ...scope, ...patch });
    setSaid(null);
  };
  usePreventRemove(unsaved && !saving, ({ data }) => setLeaving({ action: data.action }));
  useUnsavedHold(unsaved && !saving, (go) => setPaneLeave({ go }));
  const keepEditing = () => {
    setLeaving(null);
    setPaneLeave(null);
  };
  const discardAndLeave = () => {
    const held = leaving;
    const pick = paneLeave;
    setLeaving(null);
    setPaneLeave(null);
    if (read !== null) adopt(read);
    if (held !== null) navigation.dispatch(held.action);
    pick?.go();
  };

  const save = async () => {
    const next = awaySaveBody(read, edits);
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
      {inPane ? <PaneTop /> : <DetailBar backCapsule backLabel={Copy.settings} />}
      <Scroller bounded avoidKeyboard>
        <ViewHead title={Copy.awayTitle} />

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

        {scope !== null ? (
          <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
            <Section style={{ paddingTop: 16 }}>{Copy.awayAudienceLabel}</Section>
            <View style={{ paddingHorizontal: 20 }}>
              <Segmented
                value={scope.audience}
                disabled={saving}
                segments={[
                  { value: "screened_in", label: Copy.awayScreenedIn },
                  { value: "everyone", label: Copy.awayEveryone },
                ]}
                onChange={(audience) => editScope({
                  audience,
                  piles: audience !== scope.audience && audience === "screened_in"
                    ? scope.piles.filter((pile) => pile !== AWAY_SCREENER_FOLDER)
                    : scope.piles,
                })}
              />
              {scope.audience !== "everyone" && awayAudienceWide(scope.audience) ? (
                <Txt variant="note" tone="ink2">{Copy.awayEveryone}</Txt>
              ) : null}
            </View>
            <Rule inset={20} />
            <Section>{Copy.awayPilesLabel}</Section>
            <ScopePiles audience={scope.audience} piles={scope.piles} saving={saving}
              onChange={(piles) => editScope({ piles })} />
            <Rule inset={20} />
            <Section>{Copy.awayThrottleLabel}</Section>
            <View style={{ alignItems: "flex-start", paddingHorizontal: 20 }}>
              <Button label={throttleWord(scope.throttle)} variant="quiet" disabled={saving}
                accessibilityLabel={Copy.ariaLabelDetail(Copy.awayThrottleLabel, throttleWord(scope.throttle))}
                onPress={() => setPickingRate(true)} />
            </View>
          </Panel>
        ) : null}

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
      <Sheet open={leaving !== null || paneLeave !== null} onClose={keepEditing} label={Copy.awayLeaveAsk} cancel="own">
        <Txt variant="note" tone="ink" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {read !== null ? awayUnsavedLine(read) : Copy.awayLeaveAsk}
        </Txt>
        <SheetRow label={Copy.awayLeaveDiscard} onPress={discardAndLeave} />
        <SheetRow label={Copy.awayLeaveKeep} onPress={keepEditing} />
      </Sheet>

      <Sheet open={pickingRate} onClose={() => setPickingRate(false)} label={Copy.awayThrottleLabel}>
        {(["always", "per_message", "per_day", "per_week"] as const).map((throttle) => (
          <SheetRow key={throttle} label={throttleWord(throttle)} on={scope?.throttle === throttle}
            onPress={() => { editScope({ throttle }); setPickingRate(false); }} />
        ))}
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

function ScopePiles({ audience, piles, saving, onChange }: {
  audience: string;
  piles: string[];
  saving: boolean;
  onChange: (next: string[]) => void;
}) {
  const effective = awayEffectivePiles(piles, awayAudienceWide(audience) ? "everyone" : "screened_in");
  const { verbatim } = awayPileWords(effective);
  const labels = {
    ohbox: Copy.awayPileOhbox, reads: Copy.awayPileReads,
    receipts: Copy.awayPileReceipts, screener: Copy.awayPileScreener,
  };
  return (
    <View style={{ paddingHorizontal: 20 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {AWAY_ANSWERABLE_PILES.map((pile) => {
          const word = AWAY_PILE_VIEW[pile];
          const selected = effective.includes(pile);
          const disabled = saving || (word === "ohbox" && selected) || (word === "screener" && audience !== "everyone");
          return (
            <Tap key={pile} accessibilityRole="checkbox" accessibilityLabel={labels[word]}
              accessibilityState={{ checked: selected, disabled }} disabled={disabled}
              onPress={() => onChange(selected ? effective.filter((entry) => entry !== pile) : [...effective, pile])}
              style={{ minHeight: 44, justifyContent: "center" }}>
              <Chip variant={selected ? "neutral" : "outline"} {...(selected ? { icon: "check" } : {})}>
                {labels[word]}
              </Chip>
            </Tap>
          );
        })}
      </View>
      {effective.length === 0 ? <Txt variant="note" tone="ink">{Copy.awayPilesNone}</Txt> : null}
      {verbatim.map((folder) => (
        <Txt key={folder} variant="note" tone="ink2">{Copy.awayPileOther(folder)}</Txt>
      ))}
    </View>
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
