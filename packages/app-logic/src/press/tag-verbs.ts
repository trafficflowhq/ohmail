/**
 * A TAG, PUT ON OR TAKEN OFF: one letter, a set, and a tag dropped on rows. All three are the per-message
 * `tag_assign`, said once through the frame's seam.
 */
import type { VerbContext } from "./verb-context.js";
import { rowOf } from "./verb-context.js";

const nameOf = (cx: VerbContext, tagId: string): string => cx.tags.find((x) => x.id === tagId)?.name ?? tagId;

export function toggleTag(cx: VerbContext, messageId: string, tagId: string, assigned: boolean): void {
  const name = nameOf(cx, tagId);
  void cx.press.mutateAndReport(
    { kind: "tag_assign", messageId, tagId, assigned },
    assigned ? cx.t("tag.toastTagged", { name }) : cx.t("tag.toastUntagged", { name }),
  );
}

/**
 * The same verb over a SET, and it is `tag_assign` fanned out: no bulk mutation kind. The round trips are one per
 * message that actually CHANGES; a message that already agrees with the target state is skipped.
 */
export function bulkToggleTag(cx: VerbContext, ids: string[], tagId: string, assigned: boolean): void {
  const { t } = cx;
  const name = nameOf(cx, tagId);
  const targets = ids.filter((id) => {
    const m = rowOf(cx, id);
    return m != null && m.labels.includes(tagId) !== assigned;
  });
  if (targets.length === 0) return;
  /* The COUNT IS WHAT APPLIED, not what was picked: the set seam answers with it, so a press that reached three of
     five says three rather than claiming the two the server refused. */
  void cx.press.mutateSetAndReport(
    targets.map((messageId) => ({ kind: "tag_assign", messageId, tagId, assigned }) as const),
    (applied) =>
      applied === 1
        ? assigned
          ? t("tag.toastTagged", { name })
          : t("tag.toastUntagged", { name })
        : assigned
          ? t("tag.toastTaggedMany", { name, count: applied })
          : t("tag.toastUntaggedMany", { name, count: applied }),
  );
}

/**
 * A TAG DROPPED ON ROWS: apply, never toggle. A drop can never REMOVE a tag: its meaning is "put it here", and the
 * picker remains the place where a tag is taken off.
 */
export const dropTag = (cx: VerbContext, ids: string[], tagId: string): void =>
  bulkToggleTag(cx, ids, tagId, true);

/** What a tag's own two verbs read: the seam, the sentences, and the mirror's tags for the name a delete says. */
export type TagVerbContext = Pick<VerbContext, "press" | "t" | "tags">;

/** A tag's new name, said once through the seam: every letter that carries it carries the new name. */
export function renameTag(cx: TagVerbContext, tagId: string, name: string): void {
  void cx.press.mutateAndReport({ kind: "tag_rename", tagId, name }, cx.t("tag.toastRenamed", { name }));
}

/**
 * The tag taken off every letter that carries it; the letters stay where they are. The name is read BEFORE the
 * mutation: afterwards the optimistic effect has already taken the row away, and the sentence would name nothing.
 */
export function deleteTag(cx: TagVerbContext, tagId: string): void {
  const name = cx.tags.find((x) => x.id === tagId)?.name ?? "";
  void cx.press.mutateAndReport({ kind: "tag_delete", tagId }, cx.t("tag.toastDeleted", { name }));
}
