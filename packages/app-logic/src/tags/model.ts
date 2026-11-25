/**
 * TAGS' MODEL. With a tag named, the letters carrying it across every place, newest first, read in place, with its
 * Rename and Delete. With none (the place's own address, `#/tag`), every tag as a group that shuts and opens, in
 * account order. A tag is ohmail's own row: Delete takes it off its letters, which stay where they are.
 */
import { useStableCallback } from "../press/stable-callback.js";
import { countWhen, listSurface, saysEmpty } from "@ohmail/client-engine";
import type { EngineMessage, TagEntity as TagDTO } from "@ohmail/wire";
import { createContext, useContext, useMemo, useState } from "react";
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

export function judgeTagName(tags: readonly TagDTO[], tagId: string, draft: string): RenameAnswer {
  const name = draft.trim();
  if (!name) return { kind: "empty" };
  if (tags.find((tag) => tag.id === tagId)?.name === name) return { kind: "same" };
  const other = tags.find(
    (tag) => tag.id !== tagId && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  return other ? { kind: "taken", name: other.name } : { kind: "save", name };
}

export interface TagsModel {
  readonly list: PlaceList;
  /** The tag shown, or null for every tag (or a tag that is gone). */
  readonly tag: TagDTO | null;
  /** The route named a tag that is not there. */
  readonly gone: boolean;
  /** Every tag, by name, each with its letters, in account order; only where no tag is named. */
  readonly groups: readonly TagGroup[];
  readonly toggle: (tagId: string) => void;
  readonly count: number | undefined;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly stamp: (iso: string) => string;
  readonly tagsOf: (m: EngineMessage) => readonly TagDTO[];
  readonly countOf: (tagId: string) => number;
  readonly judge: (tagId: string, draft: string) => RenameAnswer;
  readonly rename: (tagId: string, name: string) => void;
  readonly remove: (tagId: string) => void;
}

// Older local rows can lack a creation time. Give them a stable place before dated tags.
function tagCreatedAt(tag: TagDTO): number {
  const time = Date.parse(tag.createdAt ?? "");
  return Number.isNaN(time) ? -Infinity : time;
}

export function compareTagOrder(a: TagDTO, b: TagDTO): number {
  return tagCreatedAt(a) - tagCreatedAt(b) || a.id.localeCompare(b.id);
}

export function useTagsList(input: TagsInput): TagsModel {
  const { tags, messages, tagId, settled, owed } = input;
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const ordered = useMemo(() => [...tags].sort(compareTagOrder), [tags]);
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
        : ordered.map((x) => ({ tag: x, rows: carrying.get(x.id) ?? [], shut: shut.has(x.id) })),
    [tagId, ordered, carrying, shut],
  );
  const rows = useMemo(
    () => (tag !== null ? (carrying.get(tag.id) ?? []) : groups.flatMap((g) => (g.shut ? [] : g.rows))),
    [tag, carrying, groups],
  );
  const list = usePlaceList({ ...input, rows });
  const toggle = useStableCallback((id: string) => {
    setShut((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  });
  const tagsById = useMemo(() => new Map(tags.map((x) => [x.id, x])), [tags]);
  const tagsOf = useStableCallback((m: EngineMessage) =>
    m.labels.map((id) => tagsById.get(id)).filter((x): x is TagDTO => x !== undefined),
  );
  const countOf = useStableCallback((id: string) => carrying.get(id)?.length ?? 0);
  const judge = useStableCallback((id: string, draft: string) => judgeTagName(tags, id, draft));
  const facts = { settled, count: tagId === null ? tags.length : rows.length, pending: owed };
  const surface = listSurface(facts);
  return {
    list,
    tag,
    gone: tagId !== null && tag === null && saysEmpty(surface),
    groups,
    toggle,
    count: countWhen(facts, facts.count),
    loading: surface === "skeleton" || surface === "pending",
    empty: saysEmpty(surface),
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
