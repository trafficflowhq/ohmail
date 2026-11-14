/**
 * WHAT A PERSON CAN DO FROM A CLIENT, as the queue carries it. One union, {@link EngineMutation},
 * written here in the groups a reader looks for; the sending and draft acts and the rule acts are
 * long enough to have files of their own (`acts-drafts.ts`, `acts-rules.ts`).
 */
import type { Folder, ISODateTime } from "./base.js";
import type { CalendarAct } from "./calendar.js";
import type { TriageState } from "./mail.js";
import type { FeedView, ScreenDest, WaterlineMeta } from "./mirror.js";
import type { DraftAct, SendAct } from "./acts-drafts.js";
import type { RuleAct } from "./acts-rules.js";

/**
 * The optimistic mutation vocabulary. Each mutation is applied locally at once
 * (user-always-wins) and mapped by the adapter to its wire endpoint (HTTP) or
 * served in-place (fixtures).
 */
export type EngineMutation = MessageAct | TagAct | FolderAct | SeenAct | SendAct | DraftAct | RuleAct;

/** One user verb's discriminant — the unit the verb-parity census counts in. */
export type MutationKind = EngineMutation["kind"];

/** Every act a queue may carry: the mail's, and the calendar's once it has any. */
export type Act = EngineMutation | CalendarAct;

/** What a person does to a letter: where it is, whether it waits, who decides its sender, its tags. */
export type MessageAct =
  /**
   * MOVE. `from`: applied only while the letter is still in that folder — a Screener card's move by
   * id, so a press replayed after the person filed the letter elsewhere leaves it there (the server
   * answers `stale_press`, read as superseded). Absent: unconditional, every other move.
   * `pressRule`: the move of a press that also writes the sender's rule, so the server does not
   * count it against the route that press rewrites. Older servers ignore it.
   */
  | { kind: "move"; messageId: string; folder: Folder; from?: Folder; pressRule?: true }
  /**
   * DELETE — the message rides to the provider's native `\Trash` on the server (never an
   * expunge) and leaves the mirror's living views everywhere (`DELETE /messages/:id`, mail
   * 0065). The optimistic effect is the tombstone itself; a mailbox with no Trash folder is
   * refused by the server (422 `no_trash_folder`) and the overlay rolls back, which is the
   * honest screen for a delete that cannot happen.
   */
  | { kind: "message_delete"; messageId: string }
  /**
   * `state: "resurfaced"` is the "Now" horizon and takes no `bubbleUpAt` — the server forces it
   * null, and so does the optimistic effect, so the two halves agree. See
   * {@link TriageState}. `restoreOpenReadAt` is set by an Undo alone (`undo.ts#triageRestore`):
   * with `state: "none"` it puts back the open read the press ended, so the row keeps its place in
   * Earlier instead of filing at arrival.
   */
  | {
      kind: "triage_set"; messageId: string; state: TriageState; bubbleUpAt?: ISODateTime | null;
      restoreOpenReadAt?: ISODateTime;
    }
  | {
      kind: "screener_decide";
      senderId: string;
      decision: "yes" | "no";
      /**
       * Which of the five the user pressed — and it is now on the wire:
       * `POST /screener/:id` carries it, files the held mail there and
       * promotes the rule at the same folder. It used to be a local-only
       * hint the adapter dropped, which made three of the five buttons
       * decoration — the follow-up `move`s lost a race against the decide's
       * own write. `ScreenDest`, not {@link OhmailView}: `screener` is where
       * mail is HELD, never a destination, and the server refuses it.
       */
      dest?: ScreenDest;
      /** "&read" seen-semantics: a Yes files the held mail already-seen (unread=false). */
      read?: boolean;
      scope?: "sender" | "domain";
      /**
       * Also apply the promoted rule to mail that has already left the gate. The decide files the
       * HELD mail and stops, so a sender with five messages waiting and four hundred already in
       * Reads had no door to the four hundred; this arms `rules.retro_requested_at` on the rule the
       * decision promotes. Absent = the server's default (true), the same contract `rule_create`
       * uses — the surface states it either way.
       */
      applyRetro?: boolean;
    }
  | {
      kind: "tag_assign";
      messageId: string;
      tagId: string;
      assigned: boolean;
      /**
       * Filled by the engine at mutate() time: the full next labels array.
       *
       * FOR THE OPTIMISTIC EFFECT ONLY — it is deliberately NOT the wire body, though it was
       * described as one before the backend existed. Sending an array would be a
       * read-modify-write, and two concurrent toggles of different tags on one message would
       * lose one of them. The adapter sends `{ tagId, assigned }`; see `http-adapter.ts`.
       */
      labels?: string[];
      /**
       * Tag-or-create — no longer the only way to mint a tag (see
       * `tag_create`), but a different act: tagging a message with a new
       * name is one gesture and one request; splitting it would leave a
       * window where the tag exists on nothing. `tagId` is a client-minted
       * uuid the server adopts as the row id, so the optimistic paint names
       * the tag the database holds. If the name already exists, the
       * existing tag wins and the client's id is never seen;
       * `tagsOfMessage` filters unknown ids, so the chip lands one drain later.
       */
      createName?: string;
    };

/** A tag's own life: made, renamed, recoloured, deleted. */
export type TagAct =
  /**
   * The three tag verbs that had no caller: `POST /tags`, `PATCH /tags/:id` and `DELETE
   * /tags/:id` were mounted and contract-tested with zero client callers — Rename and Delete
   * raised a "not wired up" toast. Engine mutations rather than a Cloud-only seam
   * (`SettingsView`'s argument): `tag` is a real `/sync` entity, so demo, desktop and live are
   * all correct with no special case. Here `tagId` is a CLIENT-LOCAL name, not the row id:
   * `POST /tags` mints the id server-side, the optimistic row is deleted on confirm (the
   * `rule_create` shape), and a name collision answers 409 and rolls back — the surface checks
   * first.
   */
  | { kind: "tag_create"; tagId: string; name: string; hue?: string }
  /**
   * RENAME — NAME ONLY. The colour travels on its own verb ({@link tag_recolor}); a rename that
   * also carried a hue would make one "Save" mean two things and send a field the user did not
   * touch. `PATCH /tags/:id` accepts `name` alone, which is what this sends.
   */
  | { kind: "tag_rename"; tagId: string; name: string }
  /**
   * Recolour — hue only. `TagsService.HUES` and the UI's `TagHueName` were
   * two different lists overlapping only on `moss`, so any colour a picker
   * offered was one the other half could not honour (an invisible dot or a
   * 400). Reconciled to the hues the Blanc system paints — ten now; the
   * widening added token families and `chip.css` rules in the same change
   * as the server's list, no migration (`tags.hue` is plain text).
   * `PATCH /tags/:id` takes `{ hue }` on its own.
   */
  | { kind: "tag_recolor"; tagId: string; hue: string }
  /**
   * Deleting a tag takes it off every message, and the effect says so:
   * `TagsService.remove` deletes the `message_tags` rows in the same
   * transaction and appends one `message` change per affected message, so
   * the server's own answer clears the chips; `mutations.ts` mirrors that
   * rather than only tombstoning the tag row. The messages themselves are
   * untouched — a tag is a row keyed by message, never an IMAP folder, so
   * deleting one moves no mail; the surface says that before it asks.
   */
  | { kind: "tag_delete"; tagId: string };

/** A folder of the mailbox's own, commanded from here and carried out by the organizer. */
export type FolderAct =
  /**
   * The folder verbs (FOLDERS-SPEC.md stage 2) — real IMAP operations in the user's OWN
   * mailbox, executed by the worker under the organizer lease after the API records the command
   * (`folder_ops`). The optimism model is PENDING MARKERS, never pretended completion: the
   * effect paints the entity's `op` marker, the adapter's echo replaces it with the server's
   * pending row, and the settled entity arrives when the worker confirms. CREATE: `folderId` is
   * a client-local name (`tag_create`'s rule); `name` is the full canonical path; the surface
   * validates with `folderNameError` first, so the server's 400 is the race.
   */
  | { kind: "folder_create"; folderId: string; mailboxId: string; name: string }
  /**
   * RENAME — the new FULL canonical path (rename and move are one wire act: a move is a rename
   * under a new parent; stage 2's UI ships rename-in-place and the vocabulary already carries
   * both). The subtree, the contained messages' folder addresses, the folder-scoped state and
   * the cursors all follow when the worker lands the swap — in ONE transaction beside the IMAP
   * RENAME. Until then the entity wears `op: { kind: "rename", to }` and keeps its old name.
   */
  | { kind: "folder_rename"; folderId: string; name: string }
  /**
   * DELETE — the ratified ceremony: the folder's messages (the whole subtree, children first)
   * move to the provider's native \Trash — the message-delete verb's own semantics, NEVER an
   * expunge — and each emptied folder is then removed. The surface asks BEFORE the act with the
   * server-truth numbers (`GET /folders/:id/summary` — "N messages across M folders move to
   * Trash"), the same confirm-before-act ceremony the message Delete ships, and for the same
   * reason: there is no un-delete on the wire. The entity wears `op: { kind: "delete" }` until
   * the tombstones arrive.
   */
  | { kind: "folder_delete"; folderId: string }
  /**
   * DISMISS a FAILED folder command — the refusal was read. A failed CREATE takes its
   * never-created row with it (nothing on the server answers to it); a failed rename/delete
   * leaves the folder exactly as the mailbox has it. Pending commands cannot be dismissed —
   * the worker may be mid-execution, and a cancel racing an IMAP write would leave the marker
   * lying in whichever direction lost.
   */
  | { kind: "folder_op_dismiss"; folderId: string };

/** What was seen: a reading stream's line, and a letter's read state. */
export type SeenAct =
  /**
   * A reading stream's seen-state — the \Seen sweep and the waterline, one verb for both piles.
   * `view` names the stream (absent ⇒ `reads`); the effect filters flips to
   * `FOLDER_OF_VIEW[view]` by construction and writes that view's own `view_meta` row, so
   * Reads' line cannot move because Receipts was left. Two separable acts: `messageIds` is the
   * \Seen sweep (absent ⇒ every unread id in the view's folder); `upToId` is the waterline
   * commit — ABSENT MEANS THE LINE DOES NOT MOVE, so it moves exactly once, on leave (a default
   * once let every dwell-mark drag it mid-visit). The waterline is client state: `/sync` has no
   * `view_meta` type; only the PATCHes cross the wire.
   */
  | {
      kind: "feed_mark_seen";
      /** Which stream's folder and waterline. Absent ⇒ `reads`. */
      view?: FeedView;
      /** Waterline anchor — the newest message that was on screen. Absent ⇒ the line stays put. */
      upToId?: string;
      /** Filled by the engine at mutate() time: the unread ids of the view's folder to flip. */
      messageIds?: string[];
      /** Undo of a Mark all read only (`feedLineUndo`): the line exactly as it was, `null` for none. */
      line?: WaterlineMeta | null;
    }
  /**
   * Folder-agnostic read-state — the one thing `feed_mark_seen` is not.
   * That is a stream's verb: its effect drops ids outside its view's
   * folder while its wire side would PATCH anything, so reusing it for the
   * Ohbox would leave rows bold until the next drain and then silently
   * change them. This one flips exactly the ids it is given, wherever they
   * live, wire and overlay alike, and never touches a waterline. `unread`,
   * not a `seen` verb: it is the field the mutation sets, so `u` and "mark
   * selection read" are one mutation with two values.
   */
  | {
      kind: "mark_seen";
      messageIds: string[];
      unread: boolean;
      /**
       * Was this read an act, or just a look? Indistinguishable by the time they reach here,
       * and one thing turns on it: the server spends a resurfaced row's pin on a DELIBERATE
       * read. `"glance"` is claimed by surfaces that decide FOR the reader (the Ohbox dwell,
       * the Receipts per-card mark); everything else omits it. A glance-labelled read still
       * lands (owner ruling 2026-08-26) — the server marks read WITHOUT spending the pin.
       * Absent means deliberate, the safe default: a call site that forgets this spends the pin
       * a little too eagerly, never leaves one that can never be answered.
       */
      via?: "glance";
      /**
       * AN OPEN READ — set by `Engine.enrich` alone, never by a surface: every id is in the
       * conversation the reader holds open. The server then stamps `openReadAt` on the rows that
       * were unread, which places them at the top of "Earlier".
       */
      openRead?: true;
      /**
       * The row a person read with its own verb while no reader holds it (a phone row's swipe, the
       * web reader off the Ohbox). Engine-local: `Engine.enrich` judges it as it judges the held row
       * and drops it, so it never reaches the wire, the outbox or the overlay.
       */
      readRow?: string;
      /**
       * AN UNDO OF A MARK UNREAD — set by `inverseMutations` alone: each flipped row's open read before
       * the press, `{}` when none had one. Present, the read is an Undo's: it puts back each named row's
       * open read (on a row holding none, in no pile, never after now), places nothing anew (no
       * `openRead`) and spends no resurfaced pin.
       */
      restoreOpenReadAt?: Record<string, ISODateTime>;
    };
