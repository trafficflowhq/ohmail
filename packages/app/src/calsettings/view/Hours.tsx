import { clockTime } from "@ohmail/app-logic/calendar";
import { Button } from "@ohmail/ui/base";
import { SettingLine } from "@ohmail/ui/mail";
import { useReport } from "../../frame/commands.js";
import { useLocale, useText } from "../../text/index.js";
import { hoursInView } from "../hours.js";
import type { SettingsRead } from "../settings-read.js";
import { Choice } from "./Choice.js";

const HOUR = 60;
const DAY = 24 * HOUR;
const HOURS = Array.from({ length: 25 }, (_, hour) => hour * HOUR);
const clampHour = (minute: number) => Math.min(DAY, Math.max(0, minute));

export function Hours({ said, save, step = false }: SettingsRead & { step?: boolean }) {
  const t = useText("calsettings");
  const locale = useLocale();
  const report = useReport();
  const { from, to } = hoursInView(said);
  const write = async (which: "from" | "to", pick: (minute: number) => number) => {
    if (save === "none") return;
    const done = await save((current) => {
      const { from, to } = hoursInView(current);
      const start = which === "from" ? pick(from) : from;
      const end = which === "to" ? pick(to) : to;
      if (start < 0 || start >= end || end > DAY) return null;
      return { dayFromMinute: start, dayToMinute: end };
    });
    if (!done) report(t("notSaved"));
  };
  const choice = (minute: number) => ({
    key: String(minute),
    label: minute === DAY ? "24:00" : clockTime(minute, locale),
  });
  const editable = said !== null && save !== "none";
  const line = (which: "from" | "to") => {
    const start = which === "from";
    const label = t(`view.${which}`);
    const minute = start ? from : to;
    const fits = (value: number) => (start ? value >= 0 && value < to : value > from && value <= DAY);
    if (!step || !editable)
      return (
        <Choice
          label={label}
          value={said ? choice(minute) : null}
          items={HOURS.filter(fits).map(choice)}
          onPick={editable ? (key) => void write(which, () => Number(key)) : undefined}
        />
      );
    const stepEarlier = (value: number) => clampHour(value - HOUR);
    const stepLater = (value: number) => clampHour(value + HOUR);
    const earlier = stepEarlier(minute);
    const later = stepLater(minute);
    return (
      <SettingLine label={label}>
        <Button
          kind="quiet"
          size="s"
          icon="back"
          label={t("view.hourEarlier")}
          disabled={earlier === minute || !fits(earlier)}
          onPress={() => void write(which, stepEarlier)}
        />
        <strong>{minute === DAY ? "24:00" : clockTime(minute, locale)}</strong>
        <Button
          kind="quiet"
          size="s"
          icon="fwd"
          label={t("view.hourLater")}
          disabled={later === minute || !fits(later)}
          onPress={() => void write(which, stepLater)}
        />
      </SettingLine>
    );
  };
  return (
    <>
      {line("from")}
      {line("to")}
    </>
  );
}
