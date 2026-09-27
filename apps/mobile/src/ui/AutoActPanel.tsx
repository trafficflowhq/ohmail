/**
 * "Act on confident suggestions for me" on the phone — the web entry's words and its
 * two disabled states. Disabled while automatic suggestions are off (the act acts on what that
 * switch buys), and on a phone that reads mail another install organizes: the consent is not
 * carried to the organizer, so the sentence sends the person there. The control shows the value
 * the server last answered with, never the pick.
 */
import { useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import type { PhoneMailbox } from "../net/mailboxes";
import { Panel, Txt } from "./base";
import { Segmented } from "./Segmented";

/** The answering server organizes none of the live mailboxes — a reader install. */
export function readsOnly(known: boolean, rows: readonly PhoneMailbox[]): boolean {
  if (!known) return false;
  const live = rows.filter((r) => r.status !== "disabled");
  return live.length > 0 && live.every((r) => r.organizerRole === "reader");
}

export function AutoActPanel({
  on,
  suggestOn,
  reader,
  pending,
  set,
}: {
  on: boolean;
  suggestOn: boolean;
  reader: boolean;
  pending: boolean;
  set: (on: boolean) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  const disabled = pending || reader || !suggestOn;
  const why = reader ? Copy.autoActReader : suggestOn ? null : Copy.autoActNeedsSuggest;
  const write = (next: "on" | "off") => {
    if (disabled) return;
    setFailed(false);
    void set(next === "on").then(() => undefined, () => setFailed(true));
  };
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        <Txt variant="settingsLabel">{Copy.autoActTitle}</Txt>
        <Txt variant="note" tone="ink2">{Copy.autoActDescription}</Txt>
      </View>
      <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
        <Segmented<"on" | "off">
          value={on ? "on" : "off"}
          onChange={write}
          disabled={disabled}
          segments={[
            { value: "off", label: Copy.switchOff },
            { value: "on", label: Copy.switchOn },
          ]}
        />
        {why ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>{why}</Txt>
        ) : null}
        {failed ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>{Copy.autoActFailed}</Txt>
        ) : null}
      </View>
    </Panel>
  );
}
