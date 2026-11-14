/**
 * THE ACTS THAT WRITE AND SEND A LETTER: members of `EngineMutation` (`acts.ts`).
 */
import type { EmailAddress } from "./base.js";
import type { ComposeAttachment } from "./drafts.js";

export type SendAct =
  /**
   * Send mail — the one mutation whose effect leaves the building. One verb, two entry points
   * (`inReplyTo` is the only difference); threading headers are minted server-side, so
   * `inReplyTo: null` keeps a stranger's Message-ID out of a fresh conversation. The
   * mutate-time effect is one `sending` draft, never a Sent row — nothing optimistic may assert
   * delivery; the Sent copy is a confirm-time overlay reconciled away by `messageIdHeader` (~10
   * min TTL backstop). `send_unverified`, `send_failed` and retryable `in_flight` stay
   * distinguishable. `cc` and `bcc` are both delivered; bcc rides the envelope only
   * (`imap.ts#send`).
   */
  | {
      kind: "mail_send";
      /**
       * The message being answered, or `null` for a fresh compose — see above. A reply's
       * recipient, subject, mailbox and thread are all derived from it.
       */
      inReplyTo: string | null;
      /**
       * The message being forwarded — the exclusive peer of {@link inReplyTo}: exactly one is
       * ever non-null, and the recipients are the user's. A forward THREADS like a reply: the
       * server mints `In-Reply-To`/`References` off the original, so the Sent copy stays in the
       * original's conversation and a recipient's answer joins it. The client sends only the id;
       * the server refuses `no_forward` (a sensitive body must never leave through a quote
       * block), appends the quoted original and streams the attachments from IMAP — a
       * client-built quote is the seam a redacted body would escape through. The compose
       * surface asks once before forwarding `no_forward` mail (`forwardPress`); this is the second check.
       */
      forwardOf?: string | null;
      /**
       * WHICH OF THE ORIGINAL'S FILES GO — attachment ids, only beside {@link forwardOf}. Absent:
       * every part (the request is the one it always was). Present: exactly these, `[]` none. The
       * server refuses an id that is not one of the original's parts (409, nothing sent).
       */
      forwardParts?: string[];
      /**
       * The person confirmed forwarding a `no_forward` original after the one-sentence ask. The
       * server refuses such a forward without it (403) and admits it with it; ignored otherwise.
       */
      forwardConfirmed?: boolean;
      /**
       * The sender's clock for a forward: the IANA zone and language the quoted header names the
       * original's date in. Unstated, the server writes it in UTC and English.
       */
      forwardClock?: { zone: string; locale: string };
      /**
       * The draft row this message already is, when there is one. A compose
       * autosaves through `draft_save`, so naming the row makes the send
       * USE it: the adapter skips `POST /drafts` and goes straight to
       * `POST /drafts/:id/send` — one row from first keystroke to delivery,
       * no abandoned twin per send. Absent for a reply and for surfaces
       * that do not autosave (the pre-autosave path, unchanged). The final
       * field values still travel on the mutation and are PUT before
       * sending: the debounce means the last two seconds of typing may not have reached the row.
       */
      draftId?: string;
      /**
       * The version of {@link draftId}'s row the editor's words are based on: the send's PUT states
       * it, and a row moved off it refuses the edit and sends nothing. Not part of the fingerprint.
       */
      ifContentRevision?: string;
      /**
       * Exactly what the user typed, as plain text. No quoted original: see the http adapter.
       *
       * When {@link html} is set this is the LOCAL plain rendering of it, used for the
       * optimistic draft row and for deciding there is something to send. It is not what the
       * recipient's plaintext client will read: the server derives that from the sanitized
       * html, so the two parts of the multipart cannot be made to disagree by a client. The
       * mirror converges on the server's rendering at the next drain, which is the ordinary
       * optimistic-overlay contract rather than an exception to it.
       */
      body: string;
      /**
       * The rich body, as the editor produced it, or absent for a plain-text send. `null`: the
       * editor holds no formatting, so the save before the send makes a formatted row plain.
       *
       * Sent INSTEAD of `body` on the wire — `POST /drafts` refuses both in one request,
       * because accepting both is how two clients end up disagreeing about which one the
       * recipient sees.
       */
      html?: string | null;
      mailboxId?: string;
      threadId?: string | null;
      subject?: string;
      to?: EmailAddress[];
      /** Carbon recipients (Compose, and a reply to all). A `Cc:` header on the delivered mail. */
      cc?: EmailAddress[];
      /** Blind-carbon recipients (Compose only). Delivered on the envelope; never a header. */
      bcc?: EmailAddress[];
      /**
       * FILES TO ATTACH — bytes, carried to the send request and never stored (see {@link
       * ComposeAttachment}). Reply and Compose alike may set it; absent for a plain send. The http
       * adapter puts these on `POST /drafts/:id/send`, the server decodes and hands them to the
       * transport, and the mailbox's own Sent copy carries them because it is built from the same
       * message. They are NOT part of the autosaved draft — a draft holds no attachment bytes.
       */
      attachments?: ComposeAttachment[];
      /**
       * Send later (mail 0077): the instant this message should leave, ISO
       * 8601 with timezone. Present ⇒ the adapter puts an appointment on
       * the draft (`POST /drafts/:id/schedule`) instead of sending — the
       * server's scheduled-send pass runs the ordinary gated send when the
       * time comes, and the draft rides `/sync` as `status: "scheduled"` so
       * every device can see and cancel it. Exclusive of
       * {@link attachments} and {@link forwardOf}: a draft row stores no
       * bytes and no forward reference, so the adapter refuses the combination.
       */
      sendAt?: string;
      /**
       * SEND THE HELD MESSAGE AGAIN — the server sends the row {@link draftId} names under its held
       * attempt's Message-ID, after looking in Sent, with {@link attachments} as the files that went
       * the first time. No save and no staging: the held row's frozen words are what goes. Needs
       * `draftId`; never with `sendAt`, `forwardOf` or `forwardParts` (a held forward names its original).
       */
      again?: true;
    };

/** A draft's own life: taken into the editor, saved, unscheduled, discarded, resolved. */
export type DraftAct =
  | { kind: "draft_accept"; draftId: string }
  /**
   * TAKE A SEND-LATER APPOINTMENT OFF A DRAFT — `DELETE /drafts/:id/schedule`. The row returns
   * to an ordinary draft on every device; the server answers 409 "already being sent" when the
   * scheduled-send pass claimed it first, which the surface reports rather than pretending the
   * cancel landed (the overlay rolls back, so the row keeps saying "scheduled" or converges to
   * "sent" on the next drain — never a false "cancelled").
   */
  | { kind: "draft_schedule_cancel"; draftId: string }
  /**
   * Autosave: the compose form becomes a row, and stays the same row. A draft used to live in
   * `localStorage` — gone with site data, invisible to the account, stranded on one device.
   * `draftId: null` CREATES (`POST /drafts`) and the server's id comes back on {@link
   * MutationResult.entityId}; a non-null id UPDATES that row. An engine mutation, not an
   * `app/api-client` call (`rule_delete`'s argument): the shared-shell views ship in the
   * desktop mirror, which has no api-client — and the engine buys the overlay and `/sync`. It
   * carries no `status`: only `POST /drafts/:id/send` may move a draft — a client that could
   * set the column would be a second path to "sent".
   */
  | {
      kind: "draft_save";
      /** `null` ⇒ create. A server id ⇒ update THAT row. Never a client-minted id. */
      draftId: string | null;
      /**
       * The SENDING mailbox. Required on create; on an update it RE-TARGETS the row — the From
       * pick has to reach the account, or a draft reopened on another device sends from the
       * identity the row froze at its first autosave. The server refuses the move on any row
       * past `draft` (409), so a send in flight keeps the identity it was reserved under.
       */
      mailboxId?: string;
      threadId?: string | null;
      inReplyToMessageId?: string | null;
      /** The message this draft forwards. Absent leaves the row's own; `null` clears it. */
      forwardOfMessageId?: string | null;
      /** The original's files the person kept, beside a forward. Absent leaves the row's list. */
      forwardParts?: string[] | null;
      subject: string;
      /**
       * The plain rendering, always. It is what the Drafts list shows and what decides there is
       * anything worth saving; when {@link html} is set the server derives the delivered
       * plaintext from the markup instead, exactly as it does for `mail_send`.
       */
      body: string;
      /** The markup; `null` = the editor holds no formatting (demotes a rich row); absent = not said. */
      html?: string | null;
      to: EmailAddress[];
      cc: EmailAddress[];
      bcc: EmailAddress[];
      /** An update's base version ({@link EngineDraft.contentRevision}): a row moved off it refuses the save. */
      ifContentRevision?: string;
    }
  /**
   * THROW THE DRAFT AWAY — `DELETE /drafts/:id`, and a tombstone in the mirror.
   *
   * Discard is a real verb here in a way it was not when a draft was a `localStorage` key: the
   * row is on the account and on every device, so "I do not want this any more" has to be said
   * out loud rather than by clearing a form. An unknown id yields no effects, which the engine
   * reports as `not_found` without going near the wire — the right answer for a draft a
   * concurrent drain already removed.
   */
  | { kind: "draft_discard"; draftId: string }
  /**
   * Answer for a send this server could not confirm — `POST /drafts/:id/resolve`, the one
   * sanctioned exit from the held state. An `unverified` draft said "check your Sent folder"
   * with nowhere to put the answer, so the row was parked permanently. `arrived` records the
   * delivery (the row becomes `sent`); `not_arrived` returns an ordinary draft that can be
   * edited, discarded or re-sent under a fresh key. Idempotent on the server: a
   * compare-and-swap on `unverified`, so a repeat answers 200 and the other outcome arriving
   * second cannot reopen a resolution. No durable key needed.
   */
  | { kind: "draft_resolve"; draftId: string; outcome: "arrived" | "not_arrived" };
