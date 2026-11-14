import { useEffect, useState } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { ScreenerModel, ScreenerSuggest, ScreenerUnsubscribe } from "./model.js";
import { useWrite, WrittenSwitch } from "./written.js";

/**
 * The suggestions, what may act on them, and unsubscribing on a screen-out: the one control that spends sits below
 * the ones that do not, and the one whose consequence leaves the building sits last.
 */
export function SuggestSheet({ model }: { readonly model: ScreenerModel }) {
  const { suggest, ownSuggest, act, unsubscribe } = model;
  if (!suggest && !ownSuggest && !act && !unsubscribe) return null;
  return (
    <SettingsSheet>
      {suggest ? <AutoSuggest suggest={suggest} /> : null}
      {ownSuggest ? (
        <WrittenSwitch
          label={ownSuggest.said.title}
          on={ownSuggest.on}
          note={ownSuggest.said.description}
          failed={ownSuggest.said.failed}
          set={ownSuggest.set}
        />
      ) : null}
      {act ? (
        <>
          <WrittenSwitch
            label={act.said.title}
            on={act.on}
            held={act.why !== null}
            note={act.said.description}
            failed={act.said.failed}
            set={act.set}
          />
          {act.said.why ? <SettingNote>{act.said.why}</SettingNote> : null}
        </>
      ) : null}
      {unsubscribe ? <UnsubscribeSwitch control={unsubscribe} /> : null}
    </SettingsSheet>
  );
}

export function UnsubscribeSwitch({ control }: { readonly control: ScreenerUnsubscribe }) {
  const t = useText("settings");
  return (
    <>
      <WrittenSwitch
        label={t("autoUnsub.title")}
        on={control.on}
        note={control.on ? t("autoUnsub.on") : t("autoUnsub.off")}
        failed={t("autoUnsub.failed")}
        set={(next) => control.setBlocked(!next)}
      />
      <SettingNote>
        {t(control.from === "computer" ? "autoUnsub.microcopyComputer" : "autoUnsub.microcopy")}
      </SettingNote>
    </>
  );
}

/**
 * On explains what the quote sends. The quote and the consent write each need a press. Off writes at once: turning it off spends
 * nothing and removes an authorisation, so nothing stands between a person and the brake.
 */
function AutoSuggest({ suggest }: { readonly suggest: ScreenerSuggest }) {
  const write = useWrite();
  const t = useText("screener");
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    if (suggest.on !== false) setReviewing(false);
  }, [suggest.on]);
  const confirming = suggest.on === false && reviewing;
  const awaitingApproval = suggest.phase === "closed";
  const cancel = () => {
    setReviewing(false);
    suggest.cancel();
  };
  const { said } = suggest;
  const turn = (on: boolean) =>
    write.run(async () => {
      await suggest.set(on);
      cancel();
    });
  return (
    <>
      <SettingLine
        label={said.title}
        toggle={{
          on: suggest.on === true,
          onChange: (next) => {
            if (suggest.on === null) return;
            if (!next) {
              turn(false);
            } else if (!reviewing) {
              suggest.cancel();
              setReviewing(true);
            }
          },
        }}
        off={write.pending || suggest.on === null}
      />
      <SettingNote>{said.state}</SettingNote>
      {confirming ? (
        <>
          <SettingNote>{said.what}</SettingNote>
          {said.cost ? <SettingNote>{said.cost}</SettingNote> : null}
          <SettingNote>{said.decides}</SettingNote>
          {said.quote ? <SettingNote>{said.quote}</SettingNote> : null}
          {said.notice ? <SettingNote>{said.notice}</SettingNote> : null}
          {write.failed ? <SettingNote warn>{said.failed}</SettingNote> : null}
          {awaitingApproval ? (
            <>
              <SettingNote>{t("suggest.autoQuoteDisclosure")}</SettingNote>
              <Button kind="ink" size="s" onPress={suggest.open}>
                {t("suggest.autoQuoteApprove")}
              </Button>
            </>
          ) : (
            <Button
              kind="ink"
              size="s"
              disabled={!suggest.priced || write.pending}
              onPress={() => turn(true)}
            >
              {said.turnOn}
            </Button>
          )}
          <Button kind="quiet" size="s" disabled={write.pending} onPress={cancel}>
            {said.cancel}
          </Button>
        </>
      ) : write.failed ? (
        <SettingNote warn>{said.failed}</SettingNote>
      ) : null}
    </>
  );
}
