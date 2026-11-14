import { Seg } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { windowRungs, type ScreenerWindow } from "./model.js";
import { SCREENER_NAMESPACE } from "./namespace.js";
import { travelledSaid } from "./travelled.js";
import { useWrite } from "./written.js";

const ALL_TIME = "all";

/**
 * How far back the Screener asks about senders never decided about. It changes who is asked and moves no mail; both
 * notes say so, each the true one for the scope that is stored.
 */
export function WindowSheet({ window: dial }: { readonly window: ScreenerWindow }) {
  const t = useText("settings");
  const own = useText(SCREENER_NAMESPACE);
  const write = useWrite();
  const selected = dial.scope === "all_time" ? ALL_TIME : String(dial.days);
  const choose = (next: string) => {
    if (write.pending || next === selected) return;
    write.run(() => (next === ALL_TIME ? dial.set(undefined, "all_time") : dial.set(Number(next), "window")));
  };
  const note = write.failed ? null : dial.note;
  return (
    <SettingsSheet
      wants={note?.kind === "refused" ? { word: own("notApplied"), line: travelledSaid(note, t) } : undefined}
    >
      <SettingLine label={t("dormancy.title")} narrow="under">
        <Seg
          label={t("dormancy.ariaLabel")}
          value={selected}
          onChange={choose}
          options={[
            ...windowRungs(dial.days, dial.defaultDays).map((d) => ({
              value: String(d),
              label: t(d === dial.defaultDays ? "dormancy.dayLabelDefault" : "dormancy.dayLabel", {
                days: d,
              }),
            })),
            { value: ALL_TIME, label: t("dormancy.allTime") },
          ]}
        />
      </SettingLine>
      <SettingNote>{t("dormancy.description")}</SettingNote>
      <SettingNote>
        {dial.scope === "all_time" ? t("dormancy.microcopyAllTime") : t("dormancy.microcopy")}
      </SettingNote>
      <SettingNote>{t("dormancy.microcopyWider")}</SettingNote>
      {write.failed ? <SettingNote warn>{t("dormancy.failed")}</SettingNote> : null}
      {note && note.kind !== "refused" ? <SettingNote>{travelledSaid(note, t)}</SettingNote> : null}
    </SettingsSheet>
  );
}
