import { useState } from "react";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";
import { Sheet, SheetRow } from "./Sheet";

export function StreamMailMenu({ onRead }: { onRead: () => void }) {
  const [open, setOpen] = useState(false);
  const t = useTheme();
  return (
    <>
      <Tap accessibilityRole="button" accessibilityLabel={Copy.readerMessageActions} accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={{ minWidth: 40, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
        <Txt variant="button" tone="ink2">⋯</Txt>
      </Tap>
      <Sheet open={open} onClose={() => setOpen(false)} label={Copy.readerMessageActions} phoneMenu={t.mail === true}>
        <SheetRow icon="open" label={Copy.readsReadInFull} onPress={() => { setOpen(false); onRead(); }} />
      </Sheet>
    </>
  );
}
