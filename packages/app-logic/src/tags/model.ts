/**
 * TAGS' MODEL. With a tag named, the letters carrying it across every place, newest first, read in place, with its
 * Rename and Delete. With none (the place's own address, `#/tag`), every tag as a group that shuts and opens, by
 * name. A tag is ohmail's own row: Delete takes it off its letters, which stay where they are.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { EngineMessage, TagDTO } from "@ohmail/client-engine";
import { newestFirst, usePlaceList, type PlaceList, type PlaceListInput } from "../place-list/place-list.js";

export interface TagsInput extends Omit<PlaceListInput, "rows"> {
  readonly tags: readonly TagDTO[];
  /** The letters that carry any tag. */
  readonly messages: readonly EngineMessage[];
  /** The tag the place shows (the route's), or none: every tag. */
  readonly tagId: string | null;
  readonly settled: boolean;
  readonly owed: boolean;
  readonly stamp: (iso: string) => string;
  /** The tag's own two verbs, through the seat's path. */
  readonly rename: (tagId: string, name: string) => void;
  readonly remove: (tagId: string) => void;
}

export interface TagGroup {
  readonly tag: TagDTO;
  readonly rows: readonly EngineMessage[];
  readonly shut: boolean;
}

/** What a new name for a tag is: a name to save, nothing to do, or another tag's. */
export type RenameAnswer =
  { kind: "save"; name: string } | { kind: "same" } | { kind: "empty" } | { kind: "taken"; name: string };

export interface TagsModel {
  readonly list: PlaceList;
  /** The tag shown, or null for every tag (or a tag that is gone). */
  readonly tag: TagDTO | null;
  /** The route named a tag that is not there. */
  readonly gone: boolean;
  /** Every tag, by name, each with its letters; only where no tag is named. */
  readonly groups: readonly TagGroup[];
  readonly toggle: (tagId: string) => void;
  readonly count: number;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly stamp: (iso: string) => string;
  readonly tagsOf: (m: EngineMessage) => readonly TagDTO[];
  readonly countOf: (tagId: string) => number;
  readonly judge: (tagId: string, draft: string) => RenameAnswer;
  readonly rename: (tagId: string, name: string) => void;
  readonly remove: (tagId: string) => void;
}

export function useTagsList(input: TagsInput): TagsModel {
  const { tags, messages, tagId, settled, owed } = input;
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const byName = useMemo(() => [...tags].sort((a, b) => a.name.localeCompare(b.name)), [tags]);
  const tag = tagId === null ? null : (tags.find((x) => x.id === tagId) ?? null);
  const carrying = useMemo(() => {
    const of = new Map<string, EngineMessage[]>();
    for (const m of [...messages].sort(newestFirst)) {
      for (const id of m.labels) {
        const rows = of.get(id) ?? [];
        rows.push(m);
        of.set(id, rows);
      }
    }
    return of;
  }, [messages]);
  const groups = useMemo<readonly TagGroup[]>(
    () =>
      tagId !== null
        ? []
        : byName.map((x) => ({ tag: x, rows: carrying.get(x.id) ?? [], shut: shut.has(x.id) })),
    [tagId, byName, carrying, shut],
  );
  const rows = useMemo(
    () => (tag !== null ? (carrying.get(tag.id) ?? []) : groups.flatMap((g) => (g.shut ? [] : g.rows))),
    [tag, carrying, groups],
  );
  const list = usePlaceList({ ...input, rows });
  const toggle = useCallback((id: string) => {
    setShut((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const tagsById = useMemo(() => new Map(tags.map((x) => [x.id, x])), [tags]);
  const tagsOf = useCallback(
    (m: EngineMessage) => m.labels.map((id) => tagsById.get(id)).filter((x): x is TagDTO => x !== undefined),
    [tagsById],
  );
  const countOf = useCallback((id: string) => carrying.get(id)?.length ?? 0, [carrying]);
  const judge = useCallback(
    (id: string, draft: string): RenameAnswer => {
      const name = draft.trim();
      const own = tagsById.get(id);
      if (name.length === 0) return { kind: "empty" };
      if (own !== undefined && name === own.name) return { kind: "same" };
      const other = tags.find((x) => x.id !== id && x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      return other !== undefined ? { kind: "taken", name: other.name } : { kind: "save", name };
    },
    [tags, tagsById],
  );
  const none = tagId === null ? tags.length === 0 : rows.length === 0;
  return {
    list,
    tag,
    gone: tagId !== null && tag === null && settled && !owed,
    groups,
    toggle,
    count: tag !== null ? rows.length : tags.length,
    loading: none && (!settled || owed),
    empty: none && settled && !owed,
    stamp: input.stamp,
    tagsOf,
    countOf,
    judge,
    rename: input.rename,
    remove: input.remove,
  };
}

export const TagsModelContext = createContext<TagsModel | null>(null);

export function useTagsModel(): TagsModel {
  const model = useContext(TagsModelContext);
  if (model === null) throw new Error("Tags was drawn with no model above it (TagsModelContext)");
  return model;
}
