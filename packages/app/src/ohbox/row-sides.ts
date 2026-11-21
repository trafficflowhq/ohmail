/** Swipe toward a definite read state. The shortcuts use the same read actions as the rest of the Ohbox. */
import type { OhboxRow } from "@ohmail/client-engine";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import type { RowSides } from "../touch/index.js";
import type { useText } from "../text/index.js";

export function ohboxRowSides(model: OhboxListModel, row: OhboxRow, t: ReturnType<typeof useText>): RowSides {
  return {
    right: { label: t("actionMarkUnread"), icon: "unread", press: () => model.markUnread(row.openTarget) },
    left: { label: t("actionMarkRead"), icon: "read", press: () => model.markRowRead(row) },
  };
}
