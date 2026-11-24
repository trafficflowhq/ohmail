import { useState } from "react";
import { router } from "expo-router";
import { View } from "react-native";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import { useNetworkNow } from "../net/network-door";
import { activeLocale } from "../i18n/locale";
import { readerZone, topLineSaid } from "../state/live";
import { useWorld } from "../state/world";
import { Button, Panel, Txt } from "./base";
import { lateStripSaid, lateWho } from "./late-lines";

export function LateStrip() {
  const w = useWorld();
  const conn = useConnection();
  const network = useNetworkNow();
  const [hidden, setHidden] = useState<string>();
  const top = topLineSaid({
    network, connection: w.boot.connection, stale: w.boot.staleAsOf, draining: w.boot.draining, continuing: null,
  });
  const session = conn.state.k === "live" ? conn.state.session : null;
  const said = lateStripSaid(w.mailboxes.rows, Date.now(), readerZone(), activeLocale(), lateWho(session));
  if (top?.alert === true || said === null) return null;
  const id = `${said.mailboxId}:${said.since}`;
  if (id === hidden) return null;
  return (
    <Panel style={{ marginHorizontal: 12, marginBottom: 12, paddingHorizontal: 16, paddingVertical: 11 }}>
      <Txt variant="rowSubject" accessibilityRole={said.hot ? "alert" : "summary"}>{said.title}</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Button label={Copy.quotaMailboxes} variant="quiet"
          onPress={() => router.push({ pathname: "/settings", params: { mailbox: said.mailboxId } })} />
        <Button label={Copy.lateHide} variant="quiet" onPress={() => setHidden(id)} />
      </View>
    </Panel>
  );
}
