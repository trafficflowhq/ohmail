/** What stands above a folder's columns: its model, and the meeting the reading column reads. */
import type { ReactNode } from "react";
import { FolderModelContext, type FolderModel } from "@ohmail/app-logic/folder";
import { PlaceMeeting } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function FolderAbove({ model, children }: { model: FolderModel; children: ReactNode }) {
  const t = useText("folder");
  const label =
    model.goneName !== null
      ? t("gone", { name: model.goneName })
      : model.empty
        ? t("emptyTitle")
        : t("metaCount", { count: model.count });
  return (
    <FolderModelContext.Provider value={model}>
      <PlaceMeeting
        visit={model.list.visit}
        blank={model.loading ? null : { label, hot: false }}
        steps={{ up: t("step.up"), down: t("step.down") }}
      >
        {children}
      </PlaceMeeting>
    </FolderModelContext.Provider>
  );
}
