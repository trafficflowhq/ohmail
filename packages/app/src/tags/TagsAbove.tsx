/** What stands above Tags' columns: its model, and the meeting the reading column reads. */
import type { ReactNode } from "react";
import { TagsModelContext, type TagsModel } from "@ohmail/app-logic/tags";
import { PlaceMeeting } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function TagsAbove({ model, children }: { model: TagsModel; children: ReactNode }) {
  const t = useText("tags");
  const label = model.empty
    ? model.tag === null
      ? t("empty.none")
      : t("empty.tag")
    : model.tag === null
      ? t("count.tags", { count: model.count })
      : t("count.letters", { count: model.count });
  return (
    <TagsModelContext.Provider value={model}>
      <PlaceMeeting
        visit={model.list.visit}
        blank={model.loading ? null : { label, hot: false }}
        steps={{ up: t("step.up"), down: t("step.down") }}
      >
        {children}
      </PlaceMeeting>
    </TagsModelContext.Provider>
  );
}
