/** What stands above Trash's columns: its model, for its list and its own reading column. */
import type { ReactNode } from "react";
import { TrashModelContext, type TrashModel } from "@ohmail/app-logic/trash";

export function TrashAbove({ model, children }: { model: TrashModel; children: ReactNode }) {
  return <TrashModelContext.Provider value={model}>{children}</TrashModelContext.Provider>;
}
