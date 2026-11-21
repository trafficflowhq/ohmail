/**
 * THE VERBS OF A LIST OF LETTERS, as a place's live hook takes them: one vocabulary behind every door of a place (a
 * key on the cursor row, the row's menu, the open letter's panel through the list's visit, the selection's bar, a
 * tag dropped on rows).
 *
 * A place's `live.ts` calls `useListVerbs` once and hands the answer to its model; a seat never writes a verb. Every
 * press leaves through the frame's one press seam, so its sentence, its Undo and its refusal are the seam's. The
 * bodies are the plain functions beside this file (`message-verbs.ts`, `selection-verbs.ts`,
 * `selection-screening.ts`, `move-to-place.ts`, `tag-verbs.ts`), the web shell's own, word for word: what an act
 * does is what it did there. No effect lives here.
 *
 * NOT HERE, and whose: the sender's sheet (its press over an address, its forecast, the rules in play, the audit, a
 * subject's rule) and a tag's own life (create, rename, recolour, delete). Each arrives with the part that draws it.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useMemo, useRef } from "react";
import type { BulkAction, BulkActionOptions, MessageAction, MoveSubject } from "./actions.js";
import type { ActedMarker } from "./after-verb.js";
import { runMessageAction } from "./message-verbs.js";
import { planBulkScreening, screenBulk } from "./selection-screening.js";
import { runBulkAction } from "./selection-verbs.js";
import type { ScreeningDest } from "./sender-screening.js";
import { useStableCallback } from "./stable-callback.js";
import { bulkToggleTag, dropTag, toggleTag } from "./tag-verbs.js";
import { planRules, type VerbContext } from "./verb-context.js";

export interface ListVerbsInput extends Omit<VerbContext, "surfaceById" | "rulesTravel" | "offOhbox"> {
  /** A rule change made here travels to the organizer (the rules' posture is `pending`). */
  rulesTravel?: boolean;
  /** The place is not the Ohbox. */
  offOhbox?: boolean;
  /** Every message the place can show past the mirror (the Ohbox: `ohboxSurfaceMessages`). */
  surface: readonly EngineMessage[];
  /** The place's tag picker, pointed at a set of letters. */
  pickTags: (ids: string[], anchor: HTMLElement | null) => void;
}

/** The record a place's live hook composes with. Consumers destructure it: a memo may not depend on it. */
export type ListVerbs = ReturnType<typeof useListVerbs>;

export function useListVerbs(input: ListVerbsInput) {
  const { surface, pickTags, rulesTravel = false, offOhbox = false, ...rest } = input;
  const surfaceById = useMemo(() => new Map(surface.map((m) => [m.id, m])), [surface]);
  /* One record a render: a press reads the facts of the render it was made in, as a closure would. */
  const cx: VerbContext = { ...rest, rulesTravel, offOhbox, surfaceById };
  // The routing window's commits re-plan over the same list of rules a press plans over.
  cx.press.routing.planOver.current = rulesTravel ? (read) => planRules(cx, read) : null;

  /** The last verb's subject, for the list's reaction once the row leaves (`after-verb.ts`). */
  const lastActed = useRef<ActedMarker | null>(null);
  /** Every id a verb here acted on this session: a tombstone one of them left is this tab's own, not "gone". */
  const actedIds = useRef<Set<string>>(new Set());

  const onMessageAction = useStableCallback(
    (action: MessageAction, m: EngineMessage, moveSubject?: MoveSubject) => {
      /* THE ACTED MARKER: every message verb funnels through here, so this one write is what lets the list tell "my
       verb moved the open row" from a drain applying another device's work. A ref: nothing renders for it. */
      lastActed.current = { id: m.id, at: Date.now() };
      actedIds.current.add(m.id);
      runMessageAction(cx, action, m, moveSubject);
    },
  );
  const onBulkAction = useStableCallback(
    (action: BulkAction, ids: string[], options?: BulkActionOptions): boolean =>
      runBulkAction(cx, action, ids, options),
  );
  const onBulkScreen = useStableCallback((ids: string[], dest: ScreeningDest): boolean =>
    screenBulk(cx, ids, dest),
  );
  /* The confirmation's numbers alone: it is drawn on every render and must not be able to dispatch anything.
     Committing is `screen`, which plans again from the same function, so a selection that changed between the two
     cannot commit a plan nobody was shown. */
  const screenPreview = useStableCallback((ids: string[], dest: ScreeningDest) => {
    const { senders, messages, rules } = planBulkScreening(cx, ids, dest);
    return { senders, messages, rules };
  });
  const tagSet = useStableCallback((ids: string[], anchor: HTMLElement | null) => {
    if (ids.length > 0) pickTags(ids, anchor);
  });
  /** The four callbacks the selection's bar takes, as one stable object. */
  const bulkVerbs = useMemo(
    () => ({ run: onBulkAction, tag: tagSet, screenPreview, screen: onBulkScreen }),
    [onBulkAction, tagSet, screenPreview, onBulkScreen],
  );

  return {
    onMessageAction,
    bulkVerbs,
    toggleTag: useStableCallback((messageId: string, tagId: string, assigned: boolean) =>
      toggleTag(cx, messageId, tagId, assigned),
    ),
    bulkToggleTag: useStableCallback((ids: string[], tagId: string, assigned: boolean) =>
      bulkToggleTag(cx, ids, tagId, assigned),
    ),
    dropTag: useStableCallback((ids: string[], tagId: string) => dropTag(cx, ids, tagId)),
    lastActed,
    actedIds,
  };
}
