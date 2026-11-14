/**
 * WHAT A CLIENT SENDS: the body of each request that has one, as a client writes it. A server
 * reads a body it has not yet judged, so where its service checks every field itself it takes the
 * same names with every field possibly absent and every value unknown (`UntrustedBody`, `routes.ts`);
 * the field names are these either way, so a field renamed on one side does not compile on the
 * other.
 */
import type { EmailAddress, Folder, ISODateTime } from "./base.js";
import type { TriageState } from "./mail.js";
import type { RuleKeyAddress } from "./organizing.js";

// ── messages ────────────────────────────────────────────────────────────────

export interface MessagePatchBody {
  unread?: boolean;
  folder?: string;
  /**
   * `"glance"` marks the surface's own involuntary read — the dwell commit, the stream sweep —
   * as opposed to a deliberate act. A glance-read LANDS (a resurfaced message keeps its genuine
   * read state, and reading it sticks — owner ruling 2026-08-26) but does NOT spend the
   * resurface pin: placement in Resurface is the attention signal, answered by dealing with the
   * row, and nobody pressed anything to get here. Absent ⇒ deliberate ⇒ spends.
   */
  via?: string;
}

/** `PATCH /messages` — one read-state decision applied to up to {@link MARK_SEEN_MAX_IDS} messages. */
export interface MarkSeenBody {
  ids: string[];
  unread: boolean;
  /** See {@link MessagePatchBody.via} — the batch form carries the same label. */
  via?: string;
  /**
   * AN OPEN READ — set by the engine alone (`Engine.enrich`), on a read whose every id is in the
   * conversation the reader has open. Stamps `open_read_at` on the rows that were unread, when all
   * ids are one conversation; over several it stamps nothing and the read still lands. Absent ⇒
   * arrival. `true` beside `unread: true` is refused: nothing an unread does may place a row.
   */
  openRead?: true;
  /**
   * AN UNDO OF A MARK UNREAD: `{ [id]: ISO }`, each row's open read before the press, `{}` for none.
   * A read only, never beside `openRead`. Restored on a live id that is read, holds no open read and
   * is in no pile, never later than now; a key outside `ids` is ignored. Its read spends no pin.
   */
  restoreOpenReadAt?: Record<string, ISODateTime>;
}

export interface MoveBody {
  folder: string;
  /** Applied only while the letter is still here; otherwise refused `stale_press` (a card's move). */
  from?: string;
  /** The move of a press that also writes the sender's rule: not an override of the route it rewrites, nor a place decided on its own. */
  pressRule?: boolean;
}

// ── triage ──────────────────────────────────────────────────────────────────

export interface TriageSetBody {
  state: TriageState;
  /**
   * REQUIRED for `bubbled_up`, and FORCED NULL for every other state — including `resurfaced`,
   * which is the one where a client might plausibly send one.
   *
   * Dropped rather than refused: a client that sends a timestamp with `resurfaced` is not making
   * a different request, it is over-specifying this one. Storing it would be the harm — the
   * worker's due-scan selects on `bubble_up_at`, so a resurfaced row carrying a future date is a
   * second flip waiting to happen, and every surface that renders the column (`triagePiles`'
   * `resurfaceAt`) would read it as "still scheduled".
   */
  bubbleUpAt?: string;
  /**
   * An Undo's press-time open read, with `state: "none"` only: restored on a read row with none,
   * never later than now, and the un-park reset is skipped. Absent or null is an ordinary `none`.
   */
  restoreOpenReadAt?: string | null;
}

/**
 * `POST /messages/:id/triage` as it arrives: the body above, and `untilTs`, an earlier spelling of
 * `bubbleUpAt` that the route still reads.
 */
export interface TriageWireBody extends TriageSetBody {
  untilTs?: string;
}

// ── tags and folders ────────────────────────────────────────────────────────

export interface TagBody {
  name: string;
  hue?: string;
}

/** `POST /messages/:id/tags` — put a tag on a letter or take it off; with `name`, tag-or-create under `tagId`. */
export interface TagAssignBody {
  tagId: string;
  assigned: boolean;
  /** TAG-OR-CREATE: the name the person typed. An existing name wins over the id. */
  name?: string;
}

/** `POST /folders` body. */
export interface FolderCreateBody { mailboxId: string; name: string }

/** `PATCH /folders/:id` body — the new full canonical path. */
export interface FolderRenameBody { name: string }

// ── rules ───────────────────────────────────────────────────────────────────

export interface CreateRuleBody {
  kind: string;
  match: string;
  destination: string;
  priority?: number;
  enabled?: boolean;
  /**
   * THE SECOND TERM — from this address AND with this in the subject. Absent or `null` for a
   * one-term rule (every rule before mail 0050). `kind: "sender"` ONLY; a term on any other kind
   * is a 400, never silently dropped. Not squeamishness: a domain rule narrowed by subject is
   * coherent, but nothing composes one — the subject sheet opens from ONE message and offers its
   * sender — so accepting it would be an untested wire shape reachable only by hand. `header` is
   * refused as the engine's `rule_create` refuses it: it names no principal. Stored VERBATIM
   * after trimming, matched case-folded by `core/src/rules.ts#subjectSatisfies` — the typed case
   * is preserved because the surfaces quote it back.
   */
  subjectContains?: string | null;
  /**
   * THE THIRD TERM — *from this address AND with this in the message text* (mail 0052). Absent or
   * `null` for a rule without one. Everything `subjectContains` documents applies verbatim:
   * `kind: "sender"` only and a 400 anywhere else, stored VERBATIM after trimming, matched
   * case-folded by `core/src/rules.ts#bodySatisfies` against the message's canonical plain text.
   * It composes with the subject term — a rule may carry both, and both must then hold.
   */
  bodyContains?: string | null;
  /**
   * ALSO APPLY THIS RULE TO MAIL ALREADY FILED — defaults to TRUE. A rule applies to ALL
   * messages, future and previous, by default; `undefined` means yes and only an explicit `false`
   * declines. Here it is one column: `retro_requested_at` is stamped inside the create/update
   * transaction and nothing else happens in this process — the worker's retro-apply pass finds
   * the owed rule on its next per-account cycle and walks the backlog in bounded pages, writing
   * `folder_state` desired-state the reconciler turns into IMAP moves. A rule matching four
   * thousand messages must not run inside a request; this is the seam that keeps it out of one.
   */
  applyRetro?: boolean;
}

export type PatchRuleBody = Partial<CreateRuleBody> & {
  /**
   * An undo, not a press: the PATCH names the rule's old place and the stored provenance is KEPT.
   * It never sets one. Only the phone's way back from a committed Move sends it.
   */
  keepProvenance?: boolean;
  /**
   * With `keepProvenance` only: the inferred value the undo read before the Move made the rule the
   * person's. Written only over a `manual` row (`restoredProvenanceSql`); it never makes a claim.
   */
  restoreProvenance?: string;
  /**
   * A RULES-PAGE CHANGE: re-file the mail the rule filed in its old place to the new one, and nothing
   * else (`rule-retro.ts`, the refile walk). Only with `applyRetro: false` and a destination.
   */
  refile?: boolean;
  /**
   * A PUBLISHED RULE'S KEY, only at {@link PUBLISHED_RULE_ID}: a reader-only install's change of a
   * rule the organizer's copy lists and this install holds no row for. Relayed, never written here.
   */
  key?: RuleKeyAddress;
};

// ── the Screener ────────────────────────────────────────────────────────────

export interface ScreenBody {
  decision: "yes" | "no";
  /**
   * WHERE THE USER ASKED FOR IT — one of `DECIDABLE_FOLDERS`. Optional, and absence is the
   * endpoint's original behaviour: `yes` ⇒ `INBOX`, `no` ⇒ `ohmail/Screened`. Optional because a
   * shipped desktop mirror and the API's contract tests post `{decision}` alone, and a client
   * that cannot name a folder should still admit a sender. NOT "the server will guess": present,
   * it decides the folder outright; absent, the two-folder default stands and `appliedFolder`
   * says which.
   */
  dest?: Folder;
  scope?: "sender" | "domain";   // default "sender"
  /**
   * Also apply the PROMOTED rule to this sender's mail that has already left the gate. Absent is
   * `true`, the contract `POST /rules` already carries; a non-boolean is a 400 rather than a
   * coercion, because `"false"` is truthy and reading an attempt to decline as consent to
   * reorganize a mailbox is the failure that check exists for.
   */
  applyRetro?: boolean;
}

// ── drafts ──────────────────────────────────────────────────────────────────

export interface CreateDraftBody {
  mailboxId: string;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  /**
   * The message this draft FORWARDS — its original, which the send quotes and whose
   * attachments it carries. Exclusive with {@link inReplyToMessageId}: both set is a 400.
   */
  forwardOfMessageId?: string | null;
  /**
   * The original's attachment ids the person kept, only beside {@link forwardOfMessageId} (a 400
   * otherwise); stored sorted and deduped. Absent or `null` on create: every part goes. On a patch,
   * absent leaves the row's list, `null` clears it; a patch that moves the forward clears it too.
   */
  forwardParts?: string[] | null;
  subject?: string;
  /**
   * The text/plain body.
   *
   * Legal on its own â that is a plain draft, and the whole product worked that way until
   * rich compose. Illegal ALONGSIDE a non-null {@link html}: see {@link DraftsService.richBody}
   * for why the server derives it instead of accepting it.
   */
  body?: string;
  /**
   * The rich body, as the editor produced it. Sanitized before it is stored; `body` is then
   * DERIVED from what survived. Omit or send `null` for a plain-text draft.
   */
  html?: string | null;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  /**
   * Blind-carbon recipients. Stored on the draft and delivered on the SMTP ENVELOPE ONLY â never
   * written into the message headers of the delivered mail or the Sent-folder copy (see
   * `SendService.reserve` â `OutboundMessage.bcc`, and `imap.ts#send`). Omit or `[]` for none.
   */
  bcc?: EmailAddress[];
  /** The AI drafter's reasoning (3b). Null/omitted for manual compose. */
  rationale?: string | null;
}

/**
 * PUT/PATCH — any subset of the composable fields, `mailboxId` included. `mailboxId` was fixed
 * after create, which froze the sending IDENTITY at the first autosave: the row is born at the
 * first keystroke, so a From picked afterwards — the explicit selector, or the domain-match
 * switch that fires once recipients exist — changed the screen and nothing else, and the mail
 * left under whatever the picker held when typing began. The pick has to reach the row, so the
 * patch may move it: validated exactly like create (owned, not disabled), and refused with a 409
 * the moment the row has left `draft` — a send in flight keeps the identity it was reserved
 * under.
 */
export type PatchDraftBody = Partial<CreateDraftBody>;

/**
 * DraftsService â MANUAL compose CRUD for `/drafts`. A draft is STORED and never
 * auto-sent (the AI drafter and the gated send are separate paths). Every
 * client-visible mutation runs ONE `db.transaction` that writes the `drafts` row
 * AND appends a `draft` change through the `change_log` seam SyncService reads
 * (in-tx) â so draft create/edit/delete surface in `/sync`. `materializeDraft`
 * means a `draft` change re-materializes to the live DTO rather than
 * tombstoning. Every query is scoped to `ctx.accountId`; a cross-account id
 * â 404. `create` validates the `mailboxId` belongs to the account.
 */
/**
 * THE OUTCOMES A PERSON CAN REPORT for a send this server could not confirm.
 *
 * Not a general "set the status" verb: these are the only two things a reader is in a position to
 * know, from the one place they can look. `arrived` means they found it in their Sent folder;
 * `not_arrived` means they looked and it is not there.
 */
export type SendResolution = "arrived" | "not_arrived";
