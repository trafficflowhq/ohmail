/**
 * WHAT A SWIPE LANDS ON, ON AN OHBOX ROW: the very verbs its menu holds. To the right the read slot as the row's
 * menu says it (Done where the model offers Done, else Mark unread), to the left Later. Each is the menu item's own
 * call into the model, so a swipe and a press of the item are one path, with one Undo.
 */
import type { OhboxRow } from "@ohmail/client-engine";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import type { RowSides } from "../touch/index.js";
import type { useText } from "../text/index.js";

export function ohboxRowSides(model: OhboxListModel, row: OhboxRow, t: ReturnType<typeof useText>): RowSides {
  return {
    read: model.doneOffered(row)
      ? { label: t("actionDone"), icon: "check", press: () => model.doneRow(row) }
      : { label: t("actionMarkUnread"), icon: "unread", press: () => model.markUnread(row.openTarget) },
    later: { label: t("actionLater"), icon: "later", press: () => model.actOn(row, "later") },
  };
}
