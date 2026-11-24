import { useMemo, useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { useLiveSession } from "../state/world";
import { mailCalendarPort } from "../switch/mail-calendar-port";
import { calendarMark } from "../theme/mail";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { Sheet, SheetRow } from "./Sheet";

const CALENDAR = "ohcal";

export function MailCalendarSwitch({ drawer = false, onNavigate }: { drawer?: boolean; onNavigate?: () => void }) {
  const t = useTheme();
  const session = useLiveSession();
  const port = useMemo(() => mailCalendarPort(session), [session]);
  const [store, setStore] = useState(false);
  if (!port) return null;
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
  return (
    <>
      <Tap
        accessibilityRole="button" accessibilityLabel={CALENDAR}
        onPress={() => { void press(); }}
        style={drawer ? {
          flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 20,
        } : {
          width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radius.pill, backgroundColor: t.c.panel,
        }}
      >
        <Icon name="calendar" size={17} color={t.c.ink} />
        {drawer ? <View style={{ flexDirection: "row", alignItems: "baseline", gap: 1 }}>
          <Txt variant="rowSender">{CALENDAR}</Txt>
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: calendarMark }} />
        </View>
          : <View style={{ position: "absolute", top: 2, right: 2, width: 10, height: 10, borderRadius: 5, backgroundColor: calendarMark }} />}
      </Tap>
      <Sheet open={store} onClose={() => setStore(false)} label={CALENDAR}>
        <Txt variant="body" style={{ paddingHorizontal: 16, paddingBottom: 6 }}>{Copy.mailCalendarInstall}</Txt>
        <SheetRow label={Copy.mailCalendarStore} onPress={() => { setStore(false); void sender.store(); }} />
      </Sheet>
    </>
  );
}
