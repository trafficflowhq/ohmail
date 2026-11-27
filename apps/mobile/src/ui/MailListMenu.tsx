import { useState } from "react";
import { View } from "react-native";
import { design } from "@ohmail/tokens/design";
import { Copy } from "../copy";
import { usePullToSync } from "../state/pull";
import { Tap } from "./base";
import { NavigationIcon } from "./Icon";
import { OhboxWhere } from "./OhboxWhere";
import { Sheet, SheetRow } from "./Sheet";
import { useSheetAnchor } from "./sheet-anchor";
import { useTheme } from "../theme";

const paperTriggerWidth = Number.parseFloat(design.faces.paper.phone["h-m"]);

export function MailListMenu({ unread = 0, fresh = 0, onMarkAll, anchored = true }: {
  unread?: number;
  fresh?: number;
  onMarkAll?: () => void;
  anchored?: boolean;
}) {
  const t = useTheme();
  const pull = usePullToSync();
  const [open, setOpen] = useState(false);
  const { anchor, anchorRef, anchorTo } = useSheetAnchor();
  const close = () => setOpen(false);
  return (
    <>
      <View ref={anchorRef} collapsable={false} style={{ marginLeft: "auto" }}>
        <Tap accessibilityRole="button" accessibilityLabel={Copy.tabMore} accessibilityState={{ expanded: open }}
          onPress={() => anchored ? anchorTo(() => setOpen(true)) : setOpen(true)}
          style={{ minWidth: t.mail ? paperTriggerWidth : 40, minHeight: 42, alignItems: "center", justifyContent: "center" }}>
          <NavigationIcon name="more" color={t.c.ink2} />
        </Tap>
      </View>
      <Sheet open={open} onClose={close} label={Copy.tabMore}
        phoneMenu={t.mail === true} anchor={anchored ? anchor : undefined} anchorAlign="end">
        {open ? <OhboxWhere filed={null} mode="checked" /> : null}
        <SheetRow label={pull.refreshing ? Copy.selfCheckChecking : pull.result ?? Copy.drawerPullMail}
          navigationIcon="pull" disabled={pull.refreshing} onPress={() => { close(); pull.onRefresh(); }} />
        {onMarkAll && (unread > 0 || fresh > 0) ? (
          <SheetRow label={Copy.markAll} icon="mail" detail={unread > 0 ? String(unread) : undefined} onPress={() => { close(); onMarkAll(); }} />
        ) : null}
      </Sheet>
    </>
  );
}
