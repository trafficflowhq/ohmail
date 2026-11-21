import { readerZones, type CalendarPort } from "@ohmail/app-logic/calendar";
import { RefusalLine } from "@ohmail/ui/base";
import { useFrame } from "../frame/commands.js";
import type { PaneProps, Route } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { OpenEvent } from "./OpenEvent.js";
import { useEventActions } from "./use-event-actions.js";
import { useFaces, useSettings, useSources, useWhere } from "./where.js";
import "./placement.css";

/** The reminder destination on a host that offers only mail. */
export function CalendarNoticeBody({ route }: PaneProps) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  return port === NONE ? null : <CalendarNoticeEvent route={route} port={port} />;
}

function CalendarNoticeEvent({ route, port }: { route: Route; port: CalendarPort }) {
  const { commands } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const zones = readerZones();
  const settings = useSettings(port);
  const where = useWhere(port, route, settings, zone, zones);
  const sources = useSources(port);
  const found = useFaces(port, sources, where?.span ?? null, where?.today ?? null, zone, zones);
  const actions = useEventActions(port, zones);
  const opened = found?.events.find((event) => event.id === route.open);
  if (!where || !opened) {
    return (
      <RefusalLine way={{ label: t("closeEvent"), onPress: () => commands.event(null) }}>
        {t("unreadable")}
      </RefusalLine>
    );
  }
  return (
    <section className="cal-body" aria-label={t("landmark")}>
      <OpenEvent
        key={opened.id}
        event={{ ...opened, viewOnly: true }}
        zones={zones}
        today={where.today}
        actions={actions}
      />
    </section>
  );
}
