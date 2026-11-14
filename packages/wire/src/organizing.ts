/**
 * HOW AN ACCOUNT'S MAIL IS ARRANGED: tags, the mailbox's own folders, the account's settings row,
 * the rules that file by sender, and the arrangement an organizer publishes for a mailbox this
 * install only reads. Each record is here twice where a client reads it more leniently than the
 * server writes it: the server's record (`…DTO`) and the device copy's reading (`…Entity`).
 */
import type { Folder, ISODateTime } from "./base.js";

/**
 * A tag — the account's own label, keyed by message through `message_tags`.
 *
 * It is NEVER an IMAP folder: ohmail organizes in place with a fixed folder set and a tag is a
 * cross-cutting dimension over it, not a seventh pile. The consequence the UI states plainly is
 * that a tag lives only in our database — a disconnect keeps it (that is a reversible soft
 * delete), but erasing the account takes it, and it never outlives its message.
 *
 * No `className`: the client derives presentation from `hue`.
 */
export interface TagDTO {
  id: string;
  name: string;
  hue: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * One of the mailbox's own folders — the `folder` entity `/sync` reserves and the folders
 * foundation fills (FOLDERS-SPEC.md §4). Materialized from the worker's `mailbox_folders`
 * inventory (post-exclusion: never the organized six, the Sent folder or the `ohmail` namespace),
 * and emitted ONLY while "Use folders" is on — a flag-off account's wire is byte-identical to the
 * pre-feature wire. `name` is the CANONICAL `/`-joined path, the spelling `MessageDTO.folder`
 * carries for mail living there — the natural key. `mailboxId` and `mailbox` extend the spec's
 * minimal shape: the rail sections folders by mailbox, and a live client has no other mirror
 * source for the owning address.
 */
export interface FolderDTO {
  id: string;
  name: string;
  mailboxId: string;
  mailbox: string;
  updatedAt: ISODateTime;
  /**
   * The user's in-flight COMMAND on this folder (folders stage 2: create / rename / delete),
   * absent when settled. `name` stays the mailbox's OWN truth throughout — a rename in flight
   * carries the target in `op.to` and keeps the old `name` until the worker's RENAME lands, so
   * the mirror never claims a mailbox state that does not exist yet. `error` is a closed
   * catalogue code once the worker refused the command; it stands until dismissed or replaced.
   */
  op?: { kind: "create" | "rename" | "delete"; to?: string; error?: string };
}

/**
 * The account's settings row on the delta feed — the `"settings"` entity. One row per account
 * (`entity_id` = the account id, op always `"update"`). It exists so a settings write travels the
 * sync channel and rings the wake like any other change; the AUTHORITY for what a surface renders
 * stays `GET /consent` — a client reads this as "the settings moved, re-ask", never as a second
 * consent read. The wire carries only the row's own scalars: the flags surfaces gate chrome on,
 * and the stamp that says they moved. Deliberately absent: the consent read's counts (they change
 * with every drain and are not settings), and anything that authorises spending on its own —
 * `autoSuggestAt` is here as a FACT; the spend gate still reads `GET /consent`.
 */
export interface SettingsDTO {
  /** The account id — the entity's own id on the wire, one row per account. */
  accountId: string;
  /** Stored dial, or null for "the product default" (never the default value itself). */
  dormancyDays: number | null;
  autoSuggestAt: ISODateTime | null;
  blockRemoteImagesAt: ISODateTime | null;
  loadTrackingPixelsAt: ISODateTime | null;
  blockAutoUnsubscribeAt: ISODateTime | null;
  foldersEnabledAt: ISODateTime | null;
  /** Per-mailbox "Use folders" EXCEPTIONS — `{ mailboxId: instant switched off }` (spec §17). */
  folderMailboxesOff: Record<string, ISODateTime>;
  /** The account's interface language, or null for "no preference stored". */
  locale: string | null;
  updatedAt: ISODateTime;
}

/**
 * THE ORGANIZER'S ARRANGEMENT OF A MAILBOX THIS INSTALL ONLY READS — the `mailbox_profile`
 * entity, keyed by the mailbox. `rules` is the cached document's rule list projected 1:1, ids
 * `profile:<mailboxId>:<index>` over the canonical order; a client PRESENTS that mailbox's mail by
 * these and nothing routes by them. `asOf` is when this install read the document.
 */
export interface MailboxProfileDTO {
  mailboxId: string;
  rules: RuleDTO[];
  asOf: ISODateTime;
  from: { kind: string | null; name: string | null; since: ISODateTime | null };
  updatedAt: ISODateTime;
  /** The request ids the organizer says this copy includes, newest first; `null` = unstated. */
  applied: string[] | null;
}

export interface RuleDTO {
  id: string;
  kind: "sender" | "domain" | "header";
  match: string;
  destination: Folder;
  priority: number;
  /** `seeded-from-sent`: written by the onboarding seed for someone the user had written to. */
  provenance: "manual" | "migrated" | "promoted" | "seeded-from-sent";
  enabled: boolean;
  /**
   * The rule's SECOND term, or `null` — *from this address AND with this in the subject* (mail
   * 0050). A conjunction, never an alternative: a present term only ever makes the rule fire less
   * often. Offered on `kind: "sender"` only; see `RulesService.validSubjectContains`.
   *
   * It is on the DTO because two surfaces cannot tell the truth without it: the rules list would
   * render two rules for one address identically, and the sender sheet's rule ladder would retarget
   * a narrow subject rule when the user changed a broad sender's destination.
   */
  subjectContains: string | null;
  /**
   * The rule's THIRD term, or `null` — *from this address AND with this in the message text*
   * (mail 0052). `subjectContains`' contract one field deeper, and on the DTO for its reasons:
   * the rules list and the ladder must be able to tell a body-narrowed rule from a bare one.
   */
  bodyContains: string | null;
  stats: { hits: number; lastHitAt: ISODateTime | null; demotions: number };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /**
   * The backlog pass: when past mail was asked for (`null` = nobody asked) and when the
   * organizer's pass finished it (`null` = not yet). No count and no cursor: the count is taken
   * from the filed folder and the cursor is the walk's own bookkeeping. `from` is where a Change
   * takes the rule's mail from while a Rules-page re-filing is owed: its origin while it waits
   * (`pendingRefileFrom`), the rule's own place once a page moved mail or the walk parked; else null.
   */
  retro: { requestedAt: ISODateTime | null; doneAt: ISODateTime | null; from: Folder | null };
  /**
   * The act on suggestions wrote this rule and no person has decided about the sender since
   * (`rulesTheActWrote`). `false` for every other rule, and for a holder's rule read from its
   * published document, which carries no mark.
   */
  byOhmail: boolean;
  /**
   * A person decided this rule (`rules.person_decided_at`, mail 0128; a document's `personDecidedAt`):
   * their own Screener press wrote it, or they paused it. A promoted domain rule so marked is consent to a
   * hold for want of confirmation (mail 0176). Present only as `true`; absent from an older server.
   */
  personDecided?: true;
}

/**
 * THE ORGANIZER'S ARRANGEMENT OF A MAILBOX THIS INSTALL ONLY READS — the server's
 * `MailboxProfileDTO`. `rules` is the cached document's rule list: the partition judges this
 * mailbox's mail by them instead of the local rule entities, and nothing writes or routes by them.
 */
export interface MailboxProfileEntity {
  mailboxId: string;
  rules: RuleEntity[];
  asOf: string;
  from: { kind: string | null; name: string | null; since: string | null };
  updatedAt: string;
  /** The request ids the organizer says this copy includes; `null` or absent = unstated. */
  applied?: string[] | null;
}

export interface RuleEntity {
  id: string;
  kind: "sender" | "domain" | "header";
  match: string;
  destination: Folder;
  priority: number;
  /**
   * Where this rule came from. `seeded-from-sent` is the onboarding seed: the user had written
   * to this address, so the rule records consent they had already given by writing. `promoted`
   * covers a Screener press and the act on suggestions alike; {@link byOhmail} tells them apart.
   */
  provenance: "manual" | "migrated" | "promoted" | "seeded-from-sent";
  enabled: boolean;
  /**
   * The rule's second term, or `null` — from this address AND with this in the subject. A
   * conjunction the server evaluates; here it decides only which of a sender's rules PLACES one
   * message (the consent partition), never admission. The rules list needs it too (two rules
   * differing only by term would render as duplicates with two Revoke buttons), and so does the
   * sender sheet's ladder (retargeting a narrow rule would silently widen it — the ladder must skip
   * it). Optional, the one such field on `RuleDTO`: older servers and rows read as "no term";
   * `undefined` and `null` mean the same.
   */
  subjectContains?: string | null;
  /**
   * THE RULE'S THIRD TERM, or `null` — *from this address AND with this in the message text*.
   *
   * `subjectContains`' contract one field deeper, including WHY it is on the mirror (the rules
   * list must render a body-narrowed rule differently from a bare one, and the sender sheet's
   * ladder must not retarget it) and why it is OPTIONAL: an older server does not send it, and a
   * mirror row predating the column reads as "no term" — `undefined` and `null` are the same
   * thing to every reader here.
   */
  bodyContains?: string | null;
  stats: { hits: number; lastHitAt: ISODateTime | null; demotions: number };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /**
   * THE BACKLOG PASS: when past mail was asked for, and when the organizer's pass finished it.
   * ABSENT IS UNKNOWN — an older server or sidecar does not send it — and never reads as done:
   * a surface then never says every message arrived when past mail was asked for.
   */
  retro?: {
    requestedAt: ISODateTime | null; doneAt: ISODateTime | null;
    /** While a Rules-page re-filing is owed, where a Change takes the rule's mail from; absent or null: none. */
    from?: Folder | null;
  };
  /**
   * THE ACT ON SUGGESTIONS WROTE THIS RULE and no person has decided about the sender since.
   * Absent from an older server, and from a copy that does not carry it; both read as a person's.
   */
  byOhmail?: boolean;
  /**
   * A PERSON DECIDED THIS RULE (their own Screener press, or their pause): a promoted domain rule so
   * marked is consent to a hold for want of confirmation, as the server's gate reads it. Absent from an
   * older server and on every other rule; absent reads as nobody's decision, the reading that holds.
   */
  personDecided?: true;
}

/**
 * A tag — a real `/sync` entity backed by the `tags` table, the client
 * mirror of the server's `TagDTO`. A tag is OURS: a row in our database
 * keyed by message, never an IMAP folder — which is why the product can
 * create and destroy it, and why the UI tells the truth about its lifetime:
 * a disconnect keeps tags, erasing the account takes them, and a tag never
 * outlives its message (folders survive leaving; tags do not). `className`
 * is optional because the server does not send it — presentation, not
 * account data; `hueOf` derives rendering from `hue` for both worlds.
 */
export interface TagEntity {
  id: string;
  name: string;
  hue: string;
  className?: string;
  createdAt?: ISODateTime;
  updatedAt?: ISODateTime;
}

/**
 * One of the mailbox's own folders — a `"folder"` entity off `/sync`
 * (FOLDERS-SPEC.md §4). `name` is the canonical `/`-joined path and the
 * natural key — the same spelling `MessageDTO.folder` carries, so a view
 * joins the two with `===`. The id names the entity on the wire and in a
 * URL, never in the organizer profile. `mailboxId`/`mailbox` extend the
 * spec deliberately: the rail sections folders by mailbox (§14) and a live
 * client has no other mirror source for the owning address. Emitted only
 * while "Use folders" is on — flag-off parity (§10).
 */
export interface FolderEntity {
  id: string;
  /** Canonical `/`-joined path, exactly as messages carry it. */
  name: string;
  mailboxId: string;
  /** The owning mailbox's address — the rail's section label when 2+ mailboxes exist. */
  mailbox: string;
  updatedAt?: ISODateTime;
  /**
   * The user's in-flight COMMAND on this folder (stage 2: create / rename / delete), absent
   * when settled. `name` stays the MAILBOX's truth throughout — a rename in flight keeps the
   * old spelling here and carries the commanded target in `op.to`, so every join on `name`
   * (the folder view, the unread counts, the tail verdict) stays consistent with the messages
   * while the rail renders the pending state honestly. `op.error` is a closed catalogue code
   * once the worker refused the command; it stands until the user dismisses it.
   */
  op?: { kind: "create" | "rename" | "delete"; to?: string; error?: string };
}

/** A rule's four-field key as `PATCH|DELETE /rules/<PUBLISHED_RULE_ID>` sends it. */
export interface RuleKeyAddress {
  kind: string;
  match: string;
  subjectContains: string | null;
  bodyContains: string | null;
}
