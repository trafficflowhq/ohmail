import { useRef, useState } from "react";
import { Button, Menu, MenuItem, Seg, Slot } from "@ohmail/ui/base";
import { SettingArea, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import {
  awayPilesAfter,
  awayUnsaved,
  type AwayAudience,
  type AwayModel,
  type AwayOutcome,
  type AwayRules,
  type AwayThrottle,
} from "./model.js";
import { AWAY_NAMESPACE } from "./namespace.js";

const AUDIENCES: readonly AwayAudience[] = ["screened_in", "everyone"];
const THROTTLES: readonly AwayThrottle[] = ["always", "per_message", "per_day", "per_week"];
const PILE_WORD = {
  ohbox: "pileOhbox",
  reads: "pileReads",
  receipts: "pileReceipts",
  screener: "pileScreener",
} as const;

/**
 * Settings › Away responder. Every control edits a draft; Save writes the whole row. The switch's note and every
 * refusal say which responder is STORED, and an unsaved edit says it has not reached it, with its own Save; a held
 * leave asks there before the edit is dropped.
 */
export function AwayPane({ model, rules }: { readonly model: AwayModel; readonly rules: AwayRules }) {
  const t = useText("away");
  const own = useText(AWAY_NAMESPACE);
  const settings = useText("settings");
  const { saved, draft, pending } = model.state;

  if (!saved || !draft) {
    return model.state.unreachable ? (
      <SettingsSheet wants={{ word: own("notRead"), line: t("unreachable") }} />
    ) : null;
  }
  const unsaved = awayUnsaved(draft, saved, rules);
  const stillSaid = saved.enabled ? t("unsavedStillOn") : t("unsavedStillOff");
  const saveWord = pending ? t("saving") : t("save");
  const wants = !unsaved
    ? undefined
    : model.leaving
      ? {
          word: settings("notSaved"),
          line: `${stillSaid} ${t("leaveAsk")}`,
          acts: (
            <>
              <Button kind="ink" size="s" onPress={() => model.discard()}>
                {t("leaveDiscard")}
              </Button>
              <Button kind="quiet" size="s" onPress={() => model.keep()}>
                {t("leaveKeep")}
              </Button>
            </>
          ),
        }
      : {
          word: settings("notSaved"),
          line: stillSaid,
          acts: (
            <Button kind="ink" size="s" disabled={pending} onPress={() => model.save()}>
              {saveWord}
            </Button>
          ),
        };

  return (
    <SettingsSheet wants={wants}>
      <SettingLine
        label={t("title")}
        toggle={{ on: draft.enabled, onChange: (enabled) => model.edit({ enabled }) }}
        off={pending}
      />
      <SettingNote>{saved.enabled ? t("on") : t("off")}</SettingNote>
      <SettingArea
        label={t("bodyLabel")}
        value={draft.body ?? ""}
        onChange={pending ? undefined : (body) => model.edit({ body })}
        lines={4}
        name="away-body"
      />
      <SettingLine label={t("audienceLabel")} narrow="under">
        <Seg
          label={t("audienceLabel")}
          value={draft.audience}
          onChange={(audience) => model.edit({ audience })}
          options={AUDIENCES.map((value) => ({
            value,
            label: t(value === "everyone" ? "everyone" : "screenedIn"),
          }))}
        />
      </SettingLine>
      <SettingNote>{draft.audience === "everyone" ? t("everyoneNote") : t("screenedInNote")}</SettingNote>
      <SettingLine label={t("pilesLabel")} narrow="under">
        {model.piles.map((choice) => (
          <Button
            key={choice.pile}
            kind={choice.on ? "ink" : "two"}
            size="s"
            pressed={choice.on}
            disabled={pending || choice.fixed || choice.audienceLocked}
            onPress={() => model.edit({ piles: awayPilesAfter(model.piles, choice.pile, !choice.on) })}
          >
            {t(PILE_WORD[choice.word])}
          </Button>
        ))}
      </SettingLine>
      {model.piles.some((c) => c.fixed) ? (
        <SettingNote>{`${t("pileOhbox")}: ${t("pileOhboxNote")}`}</SettingNote>
      ) : null}
      {model.piles.some((c) => c.audienceLocked) ? (
        <SettingNote>{`${t("pileScreener")}: ${t("pileScreenerNote")}`}</SettingNote>
      ) : null}
      <SettingNote>{t("pilesNote")}</SettingNote>
      <SettingNote>{t("never")}</SettingNote>
      <SettingLine label={t("untilLabel")} narrow="under">
        <Slot label={t("untilPick")} onPress={(event) => model.pickEnd(event.currentTarget)}>
          {model.endsSaid.draft ?? t("untilNone")}
        </Slot>
        {draft.endsAt === null ? null : (
          <Button kind="quiet" size="s" disabled={pending} onPress={() => model.edit({ endsAt: null })}>
            {t("untilClear")}
          </Button>
        )}
      </SettingLine>
      {saved.enabled && model.endsSaid.saved !== null ? (
        <SettingNote>
          {model.savedEnded
            ? t("untilPast", { date: model.endsSaid.saved })
            : t("untilOn", { date: model.endsSaid.saved })}
        </SettingNote>
      ) : null}
      <AwayRate throttle={draft.throttle} set={(throttle) => model.edit({ throttle })} />
      {model.runsOn === "thisComputer" ? (
        <SettingNote>{t("localNote")}</SettingNote>
      ) : typeof model.runsOn === "object" ? (
        <SettingNote>{t("hostNote", { host: model.runsOn.host })}</SettingNote>
      ) : null}
      <Button kind="ink" size="s" disabled={pending} onPress={() => model.save()}>
        {saveWord}
      </Button>
      {model.state.outcome ? <Outcome outcome={model.state.outcome} storedOn={saved.enabled} /> : null}
    </SettingsSheet>
  );
}

/** How often one person gets a reply: the rate's word opens its menu. */
function AwayRate({
  throttle,
  set,
}: {
  readonly throttle: AwayThrottle;
  readonly set: (next: AwayThrottle) => void;
}) {
  const t = useText("away");
  const [open, setOpen] = useState(false);
  const at = useRef<HTMLButtonElement | null>(null);
  return (
    <SettingLine label={t("throttleLabel")} narrow="under">
      <Slot ref={at} label={t("throttleLabel")} expanded={open} onPress={() => setOpen((o) => !o)}>
        {t(throttle)}
      </Slot>
      <Menu open={open} onClose={() => setOpen(false)} anchor={at} label={t("throttleLabel")} right>
        {THROTTLES.map((choice) => (
          <MenuItem
            key={choice}
            checked={throttle === choice}
            onPress={() => {
              setOpen(false);
              set(choice);
            }}
          >
            {t(choice)}
          </MenuItem>
        ))}
      </Menu>
    </SettingLine>
  );
}

/** What the last save said, beside the Save that asked. Every refusal says which responder is stored. */
function Outcome({ outcome, storedOn }: { readonly outcome: AwayOutcome; readonly storedOn: boolean }) {
  const t = useText("away");
  const settings = useText("settings");
  const said = outcomeSaid(outcome, storedOn, t, settings);
  const warn =
    outcome.kind === "failed" ||
    outcome.kind === "incomplete" ||
    outcome.kind === "expired" ||
    outcome.kind === "refused";
  return <SettingNote warn={warn}>{said}</SettingNote>;
}

function outcomeSaid(outcome: AwayOutcome, storedOn: boolean, t: Text, settings: Text): string {
  switch (outcome.kind) {
    case "saved":
      return t("saved");
    case "asked":
      return t("asked");
    case "applied":
      return t("applied");
    case "changedElsewhere":
      return t("changedElsewhere");
    case "incomplete":
      return t("incomplete");
    case "expired":
      return t("untilExpired");
    case "failed":
      return storedOn ? t("failedStillOn") : t("failedStillOff");
    case "refused": {
      const unreadable = outcome.by.refusal !== "other";
      return outcome.by.holder
        ? settings(unreadable ? "screening.refusedUnreadable" : "screening.refusedOther", {
            name: outcome.by.holder,
          })
        : settings(unreadable ? "screening.refusedUnreadableUnknown" : "screening.refusedOtherUnknown");
    }
  }
}
