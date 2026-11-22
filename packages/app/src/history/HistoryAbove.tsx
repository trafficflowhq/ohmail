/** What stands above History's columns: its model, and the meeting the reading column reads. */
import type { ReactNode } from "react";
import { HistoryModelContext, type HistoryModel } from "@ohmail/app-logic/history";
import { PlaceMeeting } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function HistoryAbove({ model, children }: { model: HistoryModel; children: ReactNode }) {
  const t = useText("history");
  const ohbox = useText("ohbox");
  const reader = useText("reader");
  const unread = model.list.rows.filter((row) => row.unread).length;
  const label = unread > 0 ? ohbox("blank.unread", { count: unread }) : reader("blank.none");
  const blank = model.loading ? null : { label, hot: unread > 0 };
  return (
    <HistoryModelContext.Provider value={model}>
      <PlaceMeeting visit={model.list.visit} blank={blank} steps={{ up: t("step.up"), down: t("step.down") }}>
        {children}
      </PlaceMeeting>
    </HistoryModelContext.Provider>
  );
}
