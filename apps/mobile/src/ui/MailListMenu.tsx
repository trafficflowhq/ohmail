import { useState } from "react";
import { router } from "expo-router";
import { Copy } from "../copy";
import { Tap, Txt } from "./base";
import { Sheet, SheetRow } from "./Sheet";

export function MailListMenu({ unread, fresh = 0, onMarkAll }: { unread: number; fresh?: number; onMarkAll: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tap accessibilityRole="button" accessibilityLabel={Copy.tabMore}
        onPress={() => setOpen(true)}
        style={{ marginLeft: "auto", minWidth: 40, minHeight: 42, alignItems: "center", justifyContent: "center" }}>
        <Txt variant="button">⋯</Txt>
      </Tap>
      <Sheet open={open} onClose={() => setOpen(false)} label={Copy.tabMore}>
        {unread > 0 || fresh > 0 ? (
          <SheetRow label={Copy.markAll} icon="check" onPress={() => { setOpen(false); onMarkAll(); }} />
        ) : null}
        <SheetRow label={Copy.search} icon="search" onPress={() => { setOpen(false); router.push("/search"); }} />
        <SheetRow label={Copy.mailWrite} icon="pen" onPress={() => { setOpen(false); router.push("/compose"); }} />
      </Sheet>
    </>
  );
}
