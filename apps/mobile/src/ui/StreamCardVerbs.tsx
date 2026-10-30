/**
 * Reply and Forward under an open News card — the web's stream card carries the reader's verbs.
 * Both open the reader's own composer on the message the reader would show (`world.message`),
 * and Forward keeps the reader's rules: the letter is read through its door first
 * (`forwardFetch`), and a `no_forward` letter asks once.
 */
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { useWorld } from "../state/world";
import { Button, Txt } from "./base";
import { SurfaceBoundary } from "./ErrorBoundary";
import { ComposeSheet, forwardAskSentence } from "./MessageActions";
import { Sheet, SheetRow } from "./Sheet";

type Open = null | "forward-ask" | { compose: "reply" | "forward"; confirmed?: boolean };

export function StreamCardVerbs({ id }: { id: string }) {
  const w = useWorld();
  const world = useRef(w);
  world.current = w;
  const [open, setOpen] = useState<Open>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const close = () => setOpen(null);

  const forward = () => {
    const go = () => {
      if (mounted.current) setOpen(world.current.message(id)?.forwardAsk ? "forward-ask" : { compose: "forward" });
    };
    const reading = w.actions.forwardFetch(id);
    if (reading === null) go();
    else void reading.then(go);
  };

  const m = open === null ? undefined : w.message(id);
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <Button icon="reply" label={Copy.actionReply} onPress={() => setOpen({ compose: "reply" })} />
        <Button icon="fwd" label={Copy.actionForward} onPress={forward} />
      </View>
      {m?.forwardAsk ? (
        <Sheet open={open === "forward-ask"} onClose={close} label={Copy.forwardAskQuestion}>
          <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            {Copy.forwardAskQuestion}
          </Txt>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {forwardAskSentence(m.forwardAsk)}
          </Txt>
          <SheetRow icon="open" label={Copy.actionForward} onPress={() => setOpen({ compose: "forward", confirmed: true })} />
        </Sheet>
      ) : null}
      {m !== undefined && open !== null && typeof open === "object" ? (
        <SurfaceBoundary surface="composer" frame="sheet" onClose={close}>
          <ComposeSheet m={m} mode={open.compose} forwardConfirmed={open.confirmed === true} onClose={close} />
        </SurfaceBoundary>
      ) : null}
    </>
  );
}
