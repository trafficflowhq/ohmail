/**
 * The verbs a press can name: one message's (`MessageAction`), a selection's (`BulkAction`) and a move's
 * destination. Behaviour and views share this one vocabulary.
 */
import type { OhmailView } from "@ohmail/client-engine";

/**
 * MOVE CARRIES ITS DESTINATION.
 *
 * It used to be a bare `"move"` that AppShell answered with a toast reading "Demo — Move
 * isn't wired yet." — on live, paying accounts. The mutation it needed has been on the
 * wire the whole time (`POST /messages/:id/move`, contract-tested), and the only thing
 * missing was a destination, so the action carries one. A template member rather than a
 * second callback argument: every pass-through of `onAction` keeps compiling unchanged.
 */
export type MoveTarget = Extract<OhmailView, "ohbox" | "reads" | "receipts" | "screened" | "spam">;
/**
 * `"unread"` is the FALLBACK arm of the read toggle, not its normal path — see
 * {@link ActionBar}. The shell answers it by dispatching the same `mark_seen` the `u` key
 * dispatches; it is reached only where `u` is not bound (the desktop shell, a test with no
 * keymap provider), and it is deliberately a toggle rather than a direction so that no
 * caller has to know the current state to use it correctly.
 */
export type MessageAction =
  /**
   * PUT THIS MESSAGE BACK WHERE IT WAS — dispatched only from the Trash reading pane's one
   * primary verb and from `⇧⌫` there. It is not a filing verb and carries no folder: the
   * destination was recorded when the message was deleted and is resolved by the server, so a
   * client naming one would be a second opinion about somebody's own mail.
   *
   * The shell answers it by opening a HELD window exactly as the delete key does, for the same
   * reason — there is no un-restore on the wire — so the row leaves the list at the press and
   * the request goes out when the Undo window closes.
   */
  | "restore"
  | "reply"
  /**
   * Reply to EVERYONE on the message — sender plus the other To/Cc recipients. Dispatched only
   * from a control that `replyAllRecipients` allowed to render, so a 1:1 message never offers
   * it; the shell resolves the same call again at send time (`AppShell.sendReply`).
   */
  | "reply_all"
  /**
   * Forward this message on — the third verb of the "answer it" family, once reachable only from a
   * panel's ⋯ menu (reported from real use: it belongs in the pill beside Reply). A row verb on the
   * bar's FLOOR now (`.abar-fwd`, beside Reply at every width, no menu twin). The shell answers with `openForward` — the
   * reply dock in forward mode, docked to THIS message, the seam the panel menus always dispatched.
   * NOT a toggle, deliberately: `openForward` refuses a `no_forward` original with a toast, and a
   * verb whose second press means "close" would swallow that refusal on the second try.
   */
  | "forward"
  | "later"
  | "aside"
  | "resurface"
  /**
   * Resurface AT a chosen instant. Plain `"resurface"` is the horizon-less default the keyboard
   * and the palette still dispatch (the shell resolves it to next Friday); the popover on the
   * bar's Resurface button feeds a specific ISO through this variant — tomorrow, next week, or a
   * picked day. Encoded in the action rather than added as a second `onAction` argument for the
   * reason `move:${MoveTarget}` is: every pass-through of `onAction` keeps compiling unchanged.
   */
  | `resurface:${string}`
  /**
   * RESURFACE NOW — the horizon chooser's fourth answer, and a different KIND of answer from the other three. Not
   * `resurface:<a moment ago>`, and the distinction is the whole point. The three dated answers all write
   * `bubbled_up` with a future instant and wait for a bubble-up pass to flip them; a past instant in that same
   * variant would be a promise nobody keeps — the pass is gated behind the worker's cycle, and a standalone desktop
   * install runs no worker. So "now" is its own member, dispatching the direct `resurfaced` transition the server
   * accepts, and the row is pinned by the time the request returns.
   */
  | "resurface_now"
  /**
   * DONE WITH A RESURFACE — the deliberate release, named. The release has existed as long as the pin has: a
   * deliberate `mark_seen` (no `via`) spends it, and the row files back at its arrival slot in "Earlier". What
   * it never had was a face — the only doors were "Mark as read", `⇧I` and the bulk verbs, none of which says "this
   * resurface is finished". This action is that face, NOT a new mechanism: the shell answers it with the same
   * `mark_seen` every deliberate read dispatches, plus a `triage_set: none` first when the message is merely
   * SCHEDULED (`bubbled_up`) rather than pinned — cancelling the booking is the release's other half there, and it is
   * the existing triage vocabulary, no new wire verb anywhere.
   */
  | "resurface_done"
  | "draft"
  | "unread"
  /**
   * DELETE — the one destructive verb, and it is a MOVE: the engine's `message_delete` files the message to the
   * provider's own \Trash folder and NEVER expunges (FOLDERS-SPEC.md §16.3; the product rule lives at
   * `packages/core/src/adapters/imap-types.ts`, the third user-commanded write). Gated on the verb reader holding the
   * row (`chrome.verbHolds`) — and NOT on the folders foundation flag, which files nothing and never did — and
   * dispatched ONLY from the confirm strip the ⋯ menu opens — there is no un-delete on the wire, so the ceremony is a
   * confirm, never an undo the product could not honour. The mobile reader ships the identical ceremony, and a parity
   * test on its side pins the two surfaces' wording to this catalogue, word for word.
   */
  | "delete"
  | `move:${MoveTarget}`;

/** The DecisionBar's vocabulary, so filing means the same thing everywhere. */
export const MOVE_TARGETS: MoveTarget[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/**
 * The same verbs, over a selection. Declared beside {@link MessageAction} rather than in the view that renders the
 * bulk bar, because the point is ONE vocabulary: the selection used to offer only ⇧U and Escape; it gets the action
 * bar's own grouping minus the one verb that cannot mean anything over a set. `later`/`aside`/`resurface` — the three
 * horizons, unchanged. `move:<view>` — this message relocated, per message, no rule. `read`/`unread` — DIRECTIONS,
 * not a toggle, the one deliberate divergence: one message has a read state to flip, a selection has a MIXED one, and
 * "toggle eleven messages" would mark six read and five unread in one gesture.
 */

/**
 * `delete` — the set filed to the provider's native \Trash, one `message_delete` per id, through the SAME
 * delayed-commit window a single delete opens (`delete-undo.ts`): a member of this union, not a separate callback,
 * because it IS the same verb over more rows — one window, one toast, one Undo; the ask belongs to the surface, the
 * only dispatch site stays the window. Screening is NOT in this union: a decision about senders with a consent
 * ceremony of its own, so it travels as its own callback — folding it in would be the design error the ruling names
 * by name.
 */
export type BulkAction =
  | "later"
  | "aside"
  | "resurface"
  /**
   * DONE OVER A SET — the release a Resurfaced conversation's own button presses. Here and not
   * beside the per-message `resurface_done` because a row stands for every member carrying a pin:
   * one press clears every booking and spends every pin in one batch, with one sentence. Never
   * offered by the selection bar; the row is its only caller.
   */
  | "done"
  | "read"
  | "unread"
  | "delete"
  | `move:${MoveTarget}`;
