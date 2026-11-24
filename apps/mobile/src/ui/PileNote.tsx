import { isPileNoteCount, usePileNoteDismissal } from "@ohmail/app-logic/lists/pile-note";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { View } from "react-native";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import { pileNoteNotNowKey } from "../state/account-rows";
import { secureKV } from "../state/servers-native";
import type { WorldActions } from "../state/live";
import { useWorld } from "../state/world";
import { Button, Panel, Txt } from "./base";

/** News or Receipts, as the world's actions name them (the engine stays behind its seam). */
type Pile = Parameters<WorldActions["pileUnscreened"]>[0];

const kept = secureKV();

export function PileNote({ pile }: { pile: Pile }) {
  const { state } = useConnection();
  if (state.k !== "live") return null;
  const storageKey = pileNoteNotNowKey(state.session.ownerKey, pile);
  return <AccountPileNote key={storageKey} pile={pile} storageKey={storageKey} />;
}

function AccountPileNote({ pile, storageKey }: { pile: Pile; storageKey: string }) {
  const { actions } = useWorld();
  const [answer, setAnswer] = useState<{ total: number; atLeast: boolean } | null>(null);
  const [pressing, setPressing] = useState(false);
  const [dismissed, setDismissed] = useState<`${number}` | null>(null);
  const writes = useRef(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void kept.get(storageKey).catch(() => null).then((raw) => {
      if (current) setDismissed(raw !== null && isPileNoteCount(raw) ? raw : "0");
    });
    return () => { current = false; };
  }, [storageKey]);

  const keep = useCallback((count: `${number}`) => {
    setDismissed(count);
    writes.current = writes.current.then(() => kept.set(storageKey, count)).catch(() => undefined);
  }, [storageKey]);

  const ask = useCallback(() => {
    actions.pileUnscreened(pile).then(
      (next) => { if (alive.current) setAnswer(next); },
      // A note, not a surface: a door that will not answer has none to make.
      () => { if (alive.current) setAnswer(null); },
    );
  }, [actions, pile]);
  useFocusEffect(ask);

  const dismiss = usePileNoteDismissal(answer?.total, dismissed, keep);
  if (answer === null || dismiss === null) return null;
  const press = (): void => {
    if (pressing) return;
    setPressing(true);
    void actions.screenPileUnscreened(pile).finally(() => {
      if (!alive.current) return;
      setPressing(false);
      ask();
    });
  };
  return (
    <Panel style={{ paddingVertical: 14, paddingHorizontal: 18, marginBottom: 12, gap: 8 }}>
      <Txt variant="body" accessibilityRole="summary">
        {Copy.pileUnscreenedLead(answer.total, pile === "news" ? Copy.reads : Copy.receipts, answer.atLeast)}
      </Txt>
      <Txt variant="note" tone="ink2">{Copy.pileUnscreenedLine}</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label={Copy.unscreenedAll(answer.total)} variant="solid" disabled={pressing} onPress={press} />
        <Button label={Copy.pileUnscreenedDismiss} variant="quiet" disabled={pressing} onPress={dismiss} />
      </View>
    </Panel>
  );
}
