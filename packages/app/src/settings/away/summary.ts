import { useSyncExternalStore } from "react";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { dayStamp } from "@ohmail/app-logic/text/format";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import { useAwaySchedule } from "./schedule.js";
import type { PaneSummary } from "../contract.js";

const noRow = () => null;
const noFeed = () => () => {};

/** Read the saved responder from the feed shared with its notice, without asking the server. */
export function useAwaySummary(): PaneSummary | null {
  const { host } = useFrame();
  const wire = host.wires.away;
  const feed = wire === NONE ? undefined : wire.snapshot;
  const row = useSyncExternalStore(feed?.subscribe ?? noFeed, feed?.read ?? noRow, noRow);
  const t = useText("settingsMenu");
  const away = useText("away");
  const locale = useLocale();
  const zone = useTimeZone();
  const { ended, upcoming } = useAwaySchedule(row);
  if (!row || upcoming) return null;
  const end = row.endsAt ? dayStamp(row.endsAt, locale, zone) : null;
  if (ended && end) return { value: t("off"), detail: away("untilPast", { date: end }) };
  const audience = t(row.audience === "everyone" ? "awayEveryone" : "awayScreened");
  const schedule =
    row.enabled && end ? away("untilOn", { date: end }) : row.throttle ? away(row.throttle) : null;
  return {
    value: t(row.enabled && !ended ? "on" : "off"),
    detail: schedule ? t("awayDetail", { audience, schedule }) : audience,
  };
}
