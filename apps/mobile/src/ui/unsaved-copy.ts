/**
 * THE WORDS for a change the engine gave up on — pure, so both the phone's chrome and its guard
 * can read them without standing up a renderer.
 *
 * Separate from `UnsavedChanges.tsx` deliberately: the decisions here (which verb this was, whether
 * the server's sentence is worth repeating) are the part that can be WRONG, and they are testable
 * as data. Leaving them inside the component would mean asserting them through JSX.
 */
import type { AbandonedMutation } from "../state/live";
import { Copy } from "../copy";

/**
 * What the person was doing. A map keyed by a known verb, never a computed lookup — an unlisted
 * kind takes the generic sentence rather than putting `folder_op_dismiss` in front of somebody
 * trying to understand why their mail did not send. Deliberately not exhaustive over
 * `MutationKind`: making a new verb a compile error would put a copy chore in the path of
 * everyone who adds one, and the pressure then is filler; the guard asserts the fallback works
 * instead. It holds keys, not sentences: a module-scope map of `Copy.x` reads would freeze every
 * value in the language active at first import — carry the key, format at point of use.
 */
const KINDS = new Map<string, keyof typeof Copy>(Object.entries({
  move: "unsavedKindMove",
  message_delete: "unsavedKindDelete",
  triage_set: "unsavedKindTriage",
  screener_decide: "unsavedKindScreener",
  mark_seen: "unsavedKindRead",
  feed_mark_seen: "unsavedKindRead",
  mail_send: "unsavedKindSend",
  draft_save: "unsavedKindDraft",
  draft_accept: "unsavedKindDraft",
  draft_discard: "unsavedKindDraftDiscard",
  draft_schedule_cancel: "unsavedKindSchedule",
  tag_assign: "unsavedKindTag",
  tag_create: "unsavedKindTag",
  tag_rename: "unsavedKindTag",
  tag_recolor: "unsavedKindTag",
  tag_delete: "unsavedKindTag",
  folder_create: "unsavedKindFolder",
  folder_rename: "unsavedKindFolder",
  folder_delete: "unsavedKindFolder",
  folder_op_dismiss: "unsavedKindFolder",
  rule_create: "unsavedKindRule",
  rule_update: "unsavedKindRule",
  rule_delete: "unsavedKindRule",
}));

export function describeKind(m: AbandonedMutation): string {
  const key = KINDS.get(m.mutation.kind);
  return key === undefined ? Copy.unsavedKindOther : (Copy[key] as string);
}

/**
 * WHY — and an honest sentence when the server gave none.
 *
 * `{"code":"internal","message":"internal error"}` is the API's envelope for a throw nobody
 * modelled. Repeating it puts the app's own noise in front of a person and reads as the app
 * explaining itself; saying what is actually known is shorter and true.
 */
export function reason(m: AbandonedMutation): string {
  const opaque = m.error.code === null
    || m.error.code === "internal"
    || m.error.message.trim() === "";
  return opaque ? Copy.unsavedNoReason : m.error.message;
}
