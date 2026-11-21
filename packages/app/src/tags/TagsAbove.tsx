/** What stands above Tags' columns: its model, and the meeting the reading column reads. */
import type { ReactNode } from "react";
import { TagsModelContext, type TagsModel } from "@ohmail/app-logic/tags";
import { PlaceMeeting } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function TagsAbove({ model, children }: { model: TagsModel; children: ReactNode }) {
  const t = useText("tags");
  const ohbox = useText("ohbox");
  const reader = useText("reader");
  const unread = model.list.rows.filter((row) => row.unread).length;
  const label = unread > 0 ? ohbox("blank.unread", { count: unread }) : reader("blank.none");
  return (
    <TagsModelContext.Provider value={model}>
      <PlaceMeeting
        visit={model.list.visit}
        blank={model.loading ? null : { label, hot: unread > 0 }}
        steps={{ up: t("step.up"), down: t("step.down") }}
      >
        {children}
      </PlaceMeeting>
    </TagsModelContext.Provider>
  );
}
