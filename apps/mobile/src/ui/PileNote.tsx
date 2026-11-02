/**
 * THE NOTE ON NEWS AND RECEIPTS — the web's (`apps/webapp/app/shell/pile-note.ts`): how many letters
 * in the pile came from senders nobody let in, and one press that sends them to the Screener. Asked
 * each time the screen comes into focus and after a press; absent at zero, on a failed read and on a
 * door with no such route. Nothing moves without the press, and the press writes intents only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Copy } from "../copy";
import type { WorldActions } from "../state/live";
import { useWorld } from "../state/world";
import { Button, Panel, Txt } from "./base";

/** News or Receipts, as the world's actions name them (the engine stays behind its seam). */
type Pile = Parameters<WorldActions["pileUnscreened"]>[0];

export function PileNote({ pile }: { pile: Pile }) {
  const { actions } = useWorld();
  const [answer, setAnswer] = useState<{ total: number; atLeast: boolean } | null>(null);
  const [pressing, setPressing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const ask = useCallback(() => {
    actions.pileUnscreened(pile).then(
      (next) => { if (alive.current) setAnswer(next); },
      // A note, not a surface: a door that will not answer has none to make.
      () => { if (alive.current) setAnswer(null); },
    );
  }, [actions, pile]);
  useFocusEffect(ask);

  if (answer === null || answer.total <= 0) return null;
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
    <Panel style={{ paddingVertical: 14, paddingHorizontal: 18, marginBottom: 12 }}>
      <Txt variant="note" tone="ink2" accessibilityRole="text">{Copy.pileUnscreenedLead(answer.total, answer.atLeast)}</Txt>
      <Button
        label={Copy.unscreenedAll(answer.total)}
        variant="solid"
        disabled={pressing}
        onPress={press}
        style={{ marginTop: 8, alignSelf: "flex-start" }}
      />
    </Panel>
  );
}
