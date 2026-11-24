/**
 * THE MODEL'S DOOR. The shell that composes the Ohbox calls `useOhboxList` once and stands the model above both
 * columns; only the Ohbox's own parts read it. The reading column reads the visit the list hands it
 * (`@ohmail/app-logic/reading`, `ListMeetingContext`), never this.
 */
import { createContext, useContext } from "react";
import type { OhboxListModel } from "./ohbox-list.js";

export const OhboxModelContext = createContext<OhboxListModel | null>(null);

/** The Ohbox's model. Nothing standing above is a mistake of composition, said at once, never an empty list. */
export function useOhboxModel(): OhboxListModel {
  const model = useContext(OhboxModelContext);
  if (model === null) throw new Error("the Ohbox was drawn with no model above it (OhboxModelContext)");
  return model;
}
