/** What stands above Drafts' two columns: its model, for the list and the reading column alike. */
import type { ReactNode } from "react";
import { DraftsModelContext, type DraftsModel } from "@ohmail/app-logic/drafts";

export function DraftsAbove({ model, children }: { model: DraftsModel; children: ReactNode }) {
  return <DraftsModelContext.Provider value={model}>{children}</DraftsModelContext.Provider>;
}
