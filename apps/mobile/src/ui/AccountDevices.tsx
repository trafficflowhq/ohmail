import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { Copy } from "../copy";
import { accountDevicesPage } from "../net/devices";
import type { ConnectedSession } from "../net/pairing";
import { Rule, Txt } from "./base";
import { Nav } from "./MoreNav";

export function AccountDevices({ session }: { session: ConnectedSession }) {
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, [session]);

  const open = async () => {
    if (pending.current) return;
    const attempt = new AbortController();
    pending.current = attempt;
    setFailed(false);
    try {
      const page = await accountDevicesPage(session, attempt.signal);
      if (attempt.signal.aborted) return;
      if (page) await Linking.openURL(page);
      else setFailed(true);
    } catch {
      if (!attempt.signal.aborted) setFailed(true);
    } finally {
      if (pending.current === attempt) pending.current = null;
    }
  };
  return <>
    <Nav label={Copy.settingsManageDevices} sub={Copy.settingsDevicesBrowser} icon="phone" chevron onPress={() => void open()} />
    {failed ? <Txt variant="note" tone="ink2" accessibilityLiveRegion="polite">{Copy.settingsDevicesFailed}</Txt> : null}
    <Rule />
  </>;
}
