/**
 * "File impersonations to Spam" on the phone — the web Settings switch's words, over
 * `/account/screening`. On by default. Absent while the read has not answered, could not be made,
 * or the server does not know the switch. The control shows the value the server last answered
 * with, never the pick.
 */
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import type { ConnectedSession } from "../net/pairing.js";
import { readImpersonationFiling, saveImpersonationFiling } from "../net/auto-filed";
import { Panel, Txt } from "./base";
import { Segmented } from "./Segmented";

export function ImpersonationFilingPanel({ session }: { session: ConnectedSession }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    let live = true;
    void readImpersonationFiling(session).then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, [session]);

  if (on === null) return null;
  const write = (next: "on" | "off") => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void saveImpersonationFiling(session, next === "on").then((v) => {
      if (!alive.current) return;
      if (v === null) setFailed(true); else setOn(v);
      setPending(false);
    });
  };
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        <Txt variant="settingsLabel">{Copy.impersonationTitle}</Txt>
        <Txt variant="note" tone="ink2">{Copy.impersonationDescription}</Txt>
      </View>
      <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
        <Segmented<"on" | "off">
          value={on ? "on" : "off"}
          onChange={write}
          disabled={pending}
          segments={[
            { value: "off", label: Copy.switchOff },
            { value: "on", label: Copy.switchOn },
          ]}
        />
        {failed ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>{Copy.autoActFailed}</Txt>
        ) : null}
      </View>
    </Panel>
  );
}
