/**
 * THE LIST'S MENU over Waiting. Its one item, Mark all spam, asks first (`asks/BulkDecision.tsx`).
 */
import { refused, type ScreenerView } from "@ohmail/app-logic/screener";
import { useRef, useState } from "react";
import { Button, Menu, MenuItem } from "@ohmail/ui/base";
import { useText } from "../../text/index.js";
import { useScreener } from "../contract.js";

/** The list's menu over Waiting: Mark all spam, where this install may decide. Opening it moves nothing. */
export function ListMenu({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const { role, waitingCount } = useScreener();
  const at = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (view.segment !== "waiting" || waitingCount === 0 || refused(role)) return null;
  return (
    <>
      <Button
        kind="quiet"
        size="s"
        icon="more"
        label={t("place.listMenu")}
        opens="menu"
        expanded={open}
        ref={at}
        onPress={() => setOpen(!open)}
      />
      <Menu open={open} onClose={() => setOpen(false)} anchor={at} label={t("place.listMenu")} right>
        <MenuItem
          onPress={() => {
            setOpen(false);
            view.askAllSpam();
          }}
        >
          {t("markAllSpam")}
        </MenuItem>
      </Menu>
    </>
  );
}
