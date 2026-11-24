import { useState } from "react";
import { isFolderDescendant } from "@ohmail/app-logic/lists/folders";
import { foldersOpenedKey, usePersistedIdSet } from "@ohmail/app-logic/storage/persisted-ui";
import type { StorageScope } from "@ohmail/app-logic/storage/scope";

/** An arrival reveals its ancestors for this visit. An explicit collapse can hide them again. */
export function useFolderBranches(scope: StorageScope, open: string | null, visitId: string | null) {
  const opened = usePersistedIdSet(scope === null ? null : foldersOpenedKey(scope));
  const [visit, setVisit] = useState<{ id: string | null; folded: readonly string[] }>({
    id: visitId,
    folded: [],
  });
  if (visit.id !== visitId) setVisit({ id: visitId, folded: [] });
  const ancestor = (key: string) => open !== null && isFolderDescendant(open, key);
  const has = (key: string) => opened.has(key) || (ancestor(key) && !visit.folded.includes(key));
  const toggle = (key: string) => {
    const next = !has(key);
    if (ancestor(key)) {
      setVisit((was) => ({
        id: visitId,
        folded: next ? was.folded.filter((id) => id !== key) : [...was.folded, key],
      }));
    }
    opened.set(key, next);
  };
  return { has, toggle };
}
