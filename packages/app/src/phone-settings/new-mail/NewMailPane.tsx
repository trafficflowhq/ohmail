import { Tag, RadioLines } from "@ohmail/ui/base";
import { SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { wakeSentenceKey, type WakePaneState } from "@ohmail/app-logic/phone/wake";
import { useText } from "../../text/index.js";
import "./placement.css";

export interface NewMailModel extends WakePaneState {
  choose(id: string): void;
  turnOff(): void;
}

/** A distributor is an installed Android app, whose package name is never empty. */
const NO_DISTRIBUTOR = "";

export function NewMailPane({ model }: { readonly model: NewMailModel }) {
  const t = useText("phoneSettings");
  const word = wakeSentenceKey(model.state, model.os);
  const warn = word === "noKey" || word === "refused" || word === "failed" || word === "rowRemains";
  const choices = model.os === "ios" ? [] : model.choices;
  const distributor = t("newMail.distributor");
  const options = choices.map(({ id, name }) => ({ value: id, label: name }));
  options.push({ value: NO_DISTRIBUTOR, label: t("newMail.none") });

  return (
    <>
      <SettingsSheet
        title={t("newMail.title")}
        sign="bell"
        hot={warn}
        aside={<Tag>{t(word === "on" ? "newMail.on" : "newMail.off")}</Tag>}
      >
        <SettingNote warn={warn}>{t(`newMail.say.${word}`)}</SettingNote>
      </SettingsSheet>
      {choices.length > 0 ? (
        <SettingsSheet title={distributor}>
          <fieldset className="wake-choices" disabled={model.busy}>
            <RadioLines
              label={distributor}
              kind="sheet"
              options={options}
              value={model.chosen ?? NO_DISTRIBUTOR}
              onChange={(id) => {
                if (model.busy) return;
                if (id === NO_DISTRIBUTOR) model.turnOff();
                else model.choose(id);
              }}
            />
          </fieldset>
          {word === "rowRemains" ? null : (
            <SettingNote>
              {t(model.chosen === null ? "newMail.noneNote" : "newMail.distributorNote")}
            </SettingNote>
          )}
        </SettingsSheet>
      ) : null}
    </>
  );
}
