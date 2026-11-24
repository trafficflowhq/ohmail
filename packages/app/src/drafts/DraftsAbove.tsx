/** What stands above Drafts' two columns: its model, for the list and the reading column alike. */
import { createContext, type ReactNode } from "react";
import { DraftsModelContext, type DraftsModel } from "@ohmail/app-logic/drafts";

export const DraftOpenedAtContext = createContext<string | undefined>(undefined);

export function DraftsAbove({
  model,
  openedAt,
  children,
}: {
  model: DraftsModel;
  openedAt?: string;
  children: ReactNode;
}) {
  return (
    <DraftsModelContext.Provider value={model}>
      <DraftOpenedAtContext.Provider value={openedAt}>{children}</DraftOpenedAtContext.Provider>
    </DraftsModelContext.Provider>
  );
}
