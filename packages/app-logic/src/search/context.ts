/**
 * THE MODEL'S DOOR. The shell that composes Search calls `useSearchList` once and stands the model above both
 * columns; only Search's own parts read it. The reading column reads the meeting line, never this.
 */
import { createContext, useContext } from "react";
import type { SearchListModel } from "./types.js";

export const SearchModelContext = createContext<SearchListModel | null>(null);

/** Search's model. Nothing standing above is a mistake of composition, said at once, never an empty list. */
export function useSearchModel(): SearchListModel {
  const model = useContext(SearchModelContext);
  if (model === null) throw new Error("Search was drawn with no model above it (SearchModelContext)");
  return model;
}
