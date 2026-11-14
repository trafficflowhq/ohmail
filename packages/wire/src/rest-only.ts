/**
 * RECORDS A CLIENT ASKS FOR AND THE FEED NEVER CARRIES: tracker events, contacts, notes,
 * snippets, notify rules, the away responder and the knowledge base. Clients refetch them.
 */
import type { EmailAddress, ISODateTime } from "./base.js";

// ── Tracker / spy-pixel events — "who tried to spy
// on you". Materialized from `tracker_events` joined to the message (sender) and
// its body (blocked = remote content not yet loaded). The stored `kind`
// ('pixel'|'remote_image'|'read_receipt') maps to the wire kind. ──
export interface TrackerEventDTO {
  id: string;
  messageId: string;
  sender: EmailAddress;
  pixelHost: string;              // who tried to spy (host; "" when unresolvable)
  detectedAt: ISODateTime;
  kind: "tracking_pixel" | "read_receipt" | "remote_beacon";
  blocked: boolean;               // true while remote content is blocked (not loaded)
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference & compose niceties. These are REST-only resources (no /sync entity
// growth); clients refetch. The wire shapes reflect the 0010 tables (which the
// migration fixes) — noting two deviations from the aspirational DTOs: a snippet
// carries `title`/`shortcut` (its stored columns) rather than `name`, and a
// notify-rule carries a `{ kind, target }` text spec rather than a contact/thread
// union (the 0010 column shape).
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactDTO {
  id: string;
  name: string | null;
  addresses: string[];            // the known sender address(es) — one per contact row today
  screened: "approved" | "screened_out" | "unknown";   // Screener outcome (default "unknown" pre-integration)
  lastSeenAt: ISODateTime | null;
  updatedAt: ISODateTime;
}

export type NoteTarget =
  | { kind: "contact"; contactId: string }
  | { kind: "thread"; threadId: string };

export interface NoteDTO {
  id: string;
  target: NoteTarget;
  body: string;
  updatedAt: ISODateTime;
}

export interface SnippetDTO {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  updatedAt: ISODateTime;
}

export interface NotifyRuleDTO {
  id: string;
  kind: string;                   // 'sender' (default) | 'domain' | 'keyword' | 'thread' …
  target: string;
  createdAt: ISODateTime;
}

export interface AwayResponderDTO {
  enabled: boolean;
  /**
   * The responder is REPLY-ONLY (mail 0087): it carries no subject of its own and answers with
   * `Re: <what the correspondent wrote>`, threaded by `In-Reply-To`/`References`. `subject` is
   * therefore GONE from this contract — the column survives one release for a rolling deploy's
   * sake, unread and unwritten, and `put` accepts the field and ignores it so an older client's
   * save is not a 400. It is dropped by a 0.15 contract migration.
   */
  body: string | null;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  /**
   * Who gets an automatic reply. `'screened_in'` — the default, and what the default-disabled shape
   * reports — restricts it to senders already past the Screener; `'everyone'` includes a
   * first-contact stranger still held there. Never null: see the column's note in `schema-mail.ts`.
   */
  audience: "screened_in" | "everyone";
  /**
   * Which piles get a reply (mail 0096; four members by mail 0101) — folder names, `['INBOX']`
   * when omitted. The second dimension beside `audience`: `audience` is a fact about a SENDER
   * (past the Screener, decided once); this is a fact about WHERE their mail landed. FOLDERS, not
   * pile words: the Ohbox pile's folder is `INBOX`, and the surface translates for display
   * (`AWAY_PILE_VIEW`/`awayEffectivePiles` in `@trafficflow/core/away-scope`, imported by both
   * the settings control and the banner so the offered set cannot drift from the refused one).
   * Never null; an EMPTY array is a responder that answers nobody — a state, not an absence.
   * `ohmail/Screener` is only ever stored beside `audience: 'everyone'`.
   */
  piles: ("INBOX" | "ohmail/News" | "ohmail/Receipts" | "ohmail/Screener")[];
  /**
   * HOW OFTEN ONE PERSON MAY BE ANSWERED — `'per_day'` when omitted by a client, which is both the
   * column default and what every row migrated by 0087 carries.
   *
   * `'per_message'` means "once, until you change the text" and is keyed by a hash of the body, not
   * by this row's `updatedAt`: a save is not an edit, and keying on the row is what made switching
   * the responder off and on again re-answer every correspondent.
   */
  throttle: "always" | "per_message" | "per_day" | "per_week";
  updatedAt: ISODateTime | null;  // null when never configured (default disabled shape)
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base + manual drafts (`/kb`, `/drafts`).
//
// `KbEntryDTO` is the account's knowledge-base entry (REST-only). `DraftDTO`
// (`drafts.ts`) is a STORED, never-auto-sent reply; `status` is the send-progress
// state a `draft` change_log row surfaces to clients. `mailboxId` is required
// (send must pick the identity/SMTP).
// ─────────────────────────────────────────────────────────────────────────────

export interface KbEntryDTO {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
