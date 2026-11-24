import { useState } from "react";
import { Copy } from "../copy";
import { Tap, Txt } from "./base";
import { Sheet, SheetRow } from "./Sheet";

export function StreamMailMenu({ onRead }: { onRead: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tap accessibilityRole="button" accessibilityLabel={Copy.readerMessageActions} onPress={() => setOpen(true)}
        style={{ position: "absolute", top: 23, right: 17, paddingHorizontal: 5 }}>
        <Txt variant="button" tone="ink2">⋯</Txt>
      </Tap>
      <Sheet open={open} onClose={() => setOpen(false)} label={Copy.readerMessageActions}>
        <SheetRow icon="open" label={Copy.readsReadInFull} onPress={() => { setOpen(false); onRead(); }} />
      </Sheet>
    </>
  );
}
