/**
 * A LETTER WHOSE TEXT WAS EMPTIED FOR SPACE, in the reader: the sentence, Load it now and Storage
 * settings. Load it now reads the letter from the mail server for this view (`loadLiveBody`) and
 * hands the text to the reader through `onLoaded`, which keeps it in view state: nothing is written
 * to the device store, the mirror or the engine. A mailbox ohmail no longer reads gets no Load it now.
 */
import { useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { loadLiveBody, type LiveBodyAnswer } from "../net/account";
import { useLiveSession } from "../state/world";
import { Button, Txt } from "./base";

type Phase = { k: "idle" } | { k: "loading" } | { k: "loaded" } | { k: "refused"; why: Exclude<LiveBodyAnswer["kind"], "text"> };

function refusalSaid(why: Exclude<LiveBodyAnswer["kind"], "text">): string {
  switch (why) {
    case "gone": return Copy.storageLoadGone;
    case "too_large": return Copy.storageLoadTooLarge;
    case "busy": return Copy.storageLoadBusy;
    case "failed": return Copy.storageLoadFailed;
  }
}

export function EmptiedLetter({ messageId, removed, onLoaded, onSettings }: {
  messageId: string;
  /** ohmail no longer reads the letter's mailbox: its text does not come back, and is not loaded. */
  removed: boolean;
  /** The loaded text, for this view only. */
  onLoaded: (text: string) => void;
  onSettings: () => void;
}) {
  /* The paired server: Cloud reads the mail server; a paired desktop answers or relays. */
  const session = useLiveSession();
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const loadable = !removed && session !== null;

  const load = (): void => {
    if (session === null || phase.k === "loading") return;
    setPhase({ k: "loading" });
    void loadLiveBody(session, messageId).then((answer) => {
      if (answer.kind !== "text") { setPhase({ k: "refused", why: answer.kind }); return; }
      setPhase({ k: "loaded" });
      onLoaded(answer.text);
    });
  };

  if (phase.k === "loaded") {
    return (
      <View style={{ gap: 4, marginBottom: 12 }} testID="emptied-loaded">
        <Txt variant="caption" tone="ink3">{Copy.storageLoaded}</Txt>
        <Txt variant="caption" tone="accent" accessibilityRole="link" onPress={onSettings}>{Copy.storageSettings}</Txt>
      </View>
    );
  }
  return (
    <View style={{ gap: 10, marginBottom: 12 }} testID="emptied-letter">
      <Txt variant="note" tone="ink2">{removed ? Copy.storageEmptiedRemoved : Copy.storageEmptied}</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {loadable ? (
          <Button
            label={phase.k === "loading" ? Copy.storageLoading : Copy.storageLoadNow}
            variant="solid"
            disabled={phase.k === "loading"}
            onPress={load}
          />
        ) : null}
        <Button label={Copy.storageSettings} onPress={onSettings} />
      </View>
      {loadable ? <Txt variant="caption" tone="ink3">{Copy.storageLoadNote}</Txt> : null}
      {phase.k === "refused" ? (
        <Txt variant="caption" tone="ink2" accessibilityRole="alert">{refusalSaid(phase.why)}</Txt>
      ) : null}
    </View>
  );
}
