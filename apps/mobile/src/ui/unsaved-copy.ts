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
 * WHAT THE PERSON WAS DOING. A map keyed by a known verb, never a computed lookup — an unlisted
 * kind takes the generic sentence rather than putting `folder_op_dismiss` in front of somebody
 * trying to understand why their mail did not send.
 *
 * Deliberately NOT exhaustive over `MutationKind`: making a new verb a compile error would put a
 * copy chore in the path of everyone who adds one, and the pressure then is to write filler. The
 * guard asserts the FALLBACK works instead of asserting the table is complete.
 */
const KINDS = new Map<string, string>(Object.entries({
  move: Copy.unsavedKindMove,
  message_delete: Copy.unsavedKindDelete,
  triage_set: Copy.unsavedKindTriage,
  screener_decide: Copy.unsavedKindScreener,
  mark_seen: Copy.unsavedKindRead,
  feed_mark_seen: Copy.unsavedKindRead,
  mail_send: Copy.unsavedKindSend,
  draft_save: Copy.unsavedKindDraft,
  draft_accept: Copy.unsavedKindDraft,
  draft_discard: Copy.unsavedKindDraftDiscard,
  draft_schedule_cancel: Copy.unsavedKindSchedule,
  tag_assign: Copy.unsavedKindTag,
  tag_create: Copy.unsavedKindTag,
  tag_rename: Copy.unsavedKindTag,
  tag_recolor: Copy.unsavedKindTag,
  tag_delete: Copy.unsavedKindTag,
  folder_create: Copy.unsavedKindFolder,
  folder_rename: Copy.unsavedKindFolder,
  folder_delete: Copy.unsavedKindFolder,
  folder_op_dismiss: Copy.unsavedKindFolder,
  rule_create: Copy.unsavedKindRule,
  rule_update: Copy.unsavedKindRule,
  rule_delete: Copy.unsavedKindRule,
}));

export function describeKind(m: AbandonedMutation): string {
  return KINDS.get(m.mutation.kind) ?? Copy.unsavedKindOther;
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
