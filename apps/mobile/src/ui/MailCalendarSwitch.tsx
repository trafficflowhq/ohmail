import { useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { isoOfDay, nowIn, readerZones, type CalendarConnectionRecord, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { invitationsInWindow } from "@ohmail/app-logic/calendar/invitations";
import { Copy } from "../copy";
import { readerZone } from "../state/live";
import { mailEventPort } from "../state/mail-event-port";
import { useLiveSession, useWorld } from "../state/world";
import type { ConnectedSession } from "../net/pairing";
import { mailCalendarPort, type MailCalendarPort } from "../switch/mail-calendar-port";
import { calendarMark, mailSize } from "../theme/mail";
import { useTheme } from "../theme";
import { Rule, Tap, Txt } from "./base";
import { Icon, NavigationIcon } from "./Icon";
import { usePosture } from "./posture";
import { Sheet, SheetRow } from "./Sheet";

const CALENDAR = "ohcal";
const noVersion = () => 0;
const ignoreChanges = () => () => undefined;

function useCalendarAttention(session: ConnectedSession | null): boolean {
  const { worldKey, mailboxes } = useWorld();
  const port = mailboxes.known && worldKey === session?.ownerKey ? mailEventPort(session) : null;
  const version = useSyncExternalStore(port?.subscribe ?? ignoreChanges, port?.version ?? noVersion, noVersion);
  const zone = readerZone();
  const zones = readerZones();
  const now = port === null ? null : nowIn(Date.now(), zone, zones);
  const todayKey = now === null ? null : isoOfDay(now.day);
  return useMemo(() => {
    if (port === null || todayKey === null || session === null) return false;
    const events = port.events();
    if (events.length === 0) return false;
    const read = session.engine.read();
    const calendars = read.list<CalendarRecord>("calendar");
    const connections = new Map(read.list<CalendarConnectionRecord>("calendar_connection").map((connection) => [connection.id, connection]));
    const groups = invitationsInWindow({ events, calendars, connections, todayKey, zone, zones,
      daysAhead: port.held().window.daysAhead, ownAddresses: mailboxes.ownAddresses,
    });
    return Boolean(groups?.waiting);
  }, [port, session, todayKey, zone, zones, mailboxes.ownAddresses, version]);
}

export function MailCalendarSwitch({ drawer = false, onNavigate }: { drawer?: boolean; onNavigate?: () => void }) {
  const session = useLiveSession();
  const port = useMemo(() => mailCalendarPort(session), [session]);
  return port === null ? null : <CalendarControl session={session} port={port} drawer={drawer} onNavigate={onNavigate} />;
}

function CalendarControl({ session, port, drawer, onNavigate }: {
  session: ConnectedSession | null;
  port: MailCalendarPort;
  drawer: boolean;
  onNavigate?: () => void;
}) {
  const t = useTheme();
  const posture = usePosture();
  // The heading's normal gap plus this margin is the gap after the calendar switch on web.
  const headerGap = t.mail && posture.sizeClass === "compact" && posture.heightClass !== "compact"
    ? mailSize.edge - mailSize.inset : undefined;
  const wants = useCalendarAttention(session);
  const [store, setStore] = useState(false);
  const { native, sender } = port;

  const press = async () => {
    if (native.otherState() === "absent") {
      setStore(true);
      return;
    }
    const result = await sender.open({ to: "last" });
    if (result === "absent") setStore(true);
    else if (result === "opened") onNavigate?.();
  };
  const control = (
    <Tap
        accessibilityRole="button" accessibilityLabel={CALENDAR}
        accessibilityHint={wants ? Copy.mailCalendarWaiting : undefined}
        onPress={() => { void press(); }}
        style={drawer ? {
          flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 20,
        } : {
          width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radius.pill, backgroundColor: t.c.panel,
          marginEnd: headerGap,
        }}
      >
        {drawer ? <NavigationIcon name="calendar" color={t.c.ink} /> : <Icon name="calendar" size={17} color={t.c.ink} />}
        {drawer ? (
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 1 }}>
            <Txt variant="rowSender">{CALENDAR}</Txt>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: calendarMark }} />
          </View>
        ) : null}
        {wants && (drawer ? (
          <View style={{ marginLeft: "auto", width: 8, height: 8, marginRight: 6,
            borderWidth: 1, borderColor: calendarMark, borderRadius: 4 }} />
        ) : (
          <View style={{ position: "absolute", top: 2, right: 2, width: 10, height: 10, borderRadius: 5, backgroundColor: calendarMark }} />
        ))}
    </Tap>
  );
  return (
    <>
      {drawer ? <View style={{ gap: 4 }}>{control}<Rule inset={8} /></View> : control}
      <Sheet open={store} onClose={() => setStore(false)} label={CALENDAR}>
        <Txt variant="body" style={{ paddingHorizontal: 16, paddingBottom: 6 }}>{Copy.mailCalendarInstall}</Txt>
        <SheetRow label={Copy.mailCalendarStore} onPress={() => { setStore(false); void sender.store(); }} />
      </Sheet>
    </>
  );
}
