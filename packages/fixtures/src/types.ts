/**
 * @ohmail/fixtures — types for the ohmail demo world.
 *
 * The shapes deliberately echo the backend DTO vocabulary
 * (id / from{name,address} / subject / snippet / folder / unread / tags)
 * so the same fixtures can power the webapp's ?demo mode, app-store
 * screenshots and component tests without translation layers.
 */

/* ------------------------------------------------------------ identity */

export interface Address {
  name: string;
  address: string;
}

export interface AccountFixture {
  email: string;
  displayName: string;
}

export interface MailboxFixture {
  id: string;
  /** Rail display name (domain or provider shorthand). */
  name: string;
  address: string;
  provider: string;
  protocol: "IMAP";
  /** The small right-aligned hint in the rail. */
  railHint: string;
  status: "Connected";
}

/* ---------------------------------------------------------------- tags */

export type TagId = "pottery" | "buch" | "privat";
export type TagHueName = "moss" | "ochre" | "rosewood";

export interface TagFixture {
  id: TagId;
  name: string;
  /** Token hue family — maps to --tg-*-ink / --tg-*-bg. */
  hue: TagHueName;
  /** The prototype's theme class (th-pottery, th-buch, th-privat). */
  className: string;
  /** Message ids carrying this tag. */
  assignedTo: string[];
}

/* ------------------------------------------------------------ messages */

export type Folder = "ohbox" | "reads" | "receipts";

export interface AttachmentFixture {
  /** Display name. Empty string = a NAMELESS part (the common wire shape for calendar invites). */
  filename: string;
  size: string;
  /**
   * The part's MIME type and its literal bytes as text, for fixtures whose attachment the demo
   * can actually SERVE — the fixtures adapter lists and fetches exactly the attachments that
   * carry `content`, still with zero network. A fixture with only the display fields above
   * keeps the old behavior: a paperclip whose strip holds nothing to download.
   */
  contentType?: string;
  content?: string;
}

export interface ProtectedFixture {
  /** Class of protected content (verification codes, today). */
  kind: "verification";
  /** Label shown beside the redacted dots. */
  label: string;
  redactedNote: string;
  /** The protection promise, verbatim. */
  policy: string;
}

export interface InlineArtFixture {
  /** Accessible name of the placeholder illustration. */
  ariaLabel: string;
  caption: string;
}

export interface MessageFixture {
  id: string;
  folder: Folder;
  from: Address;
  subject: string;
  /** One-line preview (list rows). Absent on protected messages. */
  snippet?: string;
  /**
   * Full body. Reads bodies may contain the "[[img]]" marker splitting
   * the text around an inline product illustration (see `art`).
   */
  body?: string;
  /** Display time exactly as the prototype renders it. */
  time: string;
  unread: boolean;
  threadCount?: number;
  attachment?: AttachmentFixture;
  protected?: ProtectedFixture;
  /** Why this landed where it did — the routing chip. */
  rationale?: string;
  /** Tracker-blocking chip ("1 spy pixel blocked …"). */
  trackerNote?: string;
  /** Receipts: the right-aligned amount. */
  amount?: string;
  art?: InlineArtFixture;
}

/* ------------------------------------------------- reads-specific bits */

export interface WaterlineFixture {
  /**
   * The newest message the reader had on screen at the end of their last visit —
   * the waterline renders directly ABOVE it, so this message and everything older
   * sit below the line. Mirrors `WaterlineMeta.newestSeenId` in the client engine.
   */
  newestSeenId: string;
  label: string;
  meta: string;
}

/** The pending classification chip under the first Reads row. */
export interface ReadsAiChipFixture {
  afterId: string;
  label: string;
  confidence: number;
  reason: string;
  approvedLabel: string;
  correctedLabel: string;
}

export interface ReceiptsGroupFixture {
  label: string;
  items: string[];
}

/* ------------------------------------------------------------ screener */

export type ScreenerDest = Folder | "screened" | "spam";
export type DecisionScope = "sender" | "domain";

export interface ScreenerSuggestion {
  dest: ScreenerDest;
  confidence: number;
  rationale: string;
}

/**
 * One held message. It carries its own identity and its own full body, so
 * moving it between screener segments and mail places can never collapse it
 * into a count — every message is always rendered in full.
 */
export interface HeldMailFixture {
  id: string;
  subject: string;
  time: string;
  body: string;
  /** e.g. "31 tracking links · 2 spy pixels blocked" */
  trackerNote?: string;
}

export interface WaitingSenderFixture {
  id: string;
  from: Address;
  initial: string;
  time: string;
  scope: DecisionScope;
  /** Spam-grade mail renders quieter and duller. */
  dull?: boolean;
  ai: ScreenerSuggestion;
  /** Every message held while the sender waits — non-empty, oldest first. */
  held: HeldMailFixture[];
}

export interface ScreenedSenderFixture {
  address: string;
  screenedOn: string;
  /**
   * Every held message, in full — screening out holds mail, it never discards
   * it. "8 held" exists only because eight renderable messages are behind it,
   * so there is no count to drift and no hidden newest-only body.
   */
  held: HeldMailFixture[];
}

export interface SpamDetection {
  source: "auto-detected";
  confidence: number;
  reason: string;
  /** Verbatim badge text ("auto-detected · 0.98 · phishing fingerprint"). */
  label: string;
}

export interface SpamItemFixture {
  from: string;
  detection: SpamDetection;
  /** Held viewable, never deleted unseen — and never collapsed to a count. */
  held: HeldMailFixture[];
}

export interface ScreenerEmptyState {
  glyph: string;
  title: string;
  hint: string;
}

/* -------------------------------------------------------------- triage */

export type TriageState = "replyLater" | "setAside" | "resurface";

export interface TriageItemFixture {
  /** Related message id where one exists in the demo world. */
  messageId?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  /** Resurface only — "Fri 09:00". */
  resurfaceAt?: string;
}

export interface TriageFixture {
  replyLater: TriageItemFixture[];
  setAside: TriageItemFixture[];
  resurface: TriageItemFixture[];
}

/* -------------------------------------------------------------- search */

export interface SearchHitFixture {
  who: string;
  where: string;
  subject: string;
  /** Fuzzy-match annotation ('fuzzy match — "invoice"'). */
  fuzzyNote?: string;
  /** Substring of `subject` to highlight as an exact match. */
  highlight?: string;
}

export interface SearchFacetGroupFixture {
  title: string;
  items: { label: string; count?: number }[];
}

export interface SearchDemoFixture {
  query: string;
  resultCount: number;
  tookMs: number;
  source: string;
  hits: SearchHitFixture[];
  facets: SearchFacetGroupFixture[];
  emptyTitle: string;
  emptyHint: string;
}

/* ------------------------------------------------------------- compose */

export interface ComposeDraftFixture {
  to: Address;
  subject: string;
  /** Chip above the draft — "AI draft — not sent". */
  tagLabel: string;
  body: string;
  /** The grounding chip: where the draft was drafted from. */
  grounding: string;
  editorPlaceholder: string;
  sendNote: string;
}

/* ------------------------------------------------------------ settings */

export interface NotificationChannelFixture {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface NotificationSettingsFixture {
  channels: NotificationChannelFixture[];
  vipLabel: string;
  vips: string[];
  learnedSuggestion: {
    text: string;
    target: string;
    acceptedToast: string;
    dismissedToast: string;
  };
  privacyNote: string;
}

/* -------------------------------------------------------------- counts */

export interface CountsFixture {
  ohboxUnread: number;
  ohboxTotal: number;
  reads: number;
  receipts: number;
  screenerWaiting: number;
  replyLater: number;
  setAside: number;
  resurface: number;
}

/* ----------------------------------------------------------- the world */

export interface Fixtures {
  account: AccountFixture;
  mailboxes: MailboxFixture[];
  tags: TagFixture[];
  ohbox: MessageFixture[];
  reads: MessageFixture[];
  readsWaterline: WaterlineFixture;
  readsAiChip: ReadsAiChipFixture;
  receipts: MessageFixture[];
  receiptsGroups: ReceiptsGroupFixture[];
  screener: {
    waiting: WaitingSenderFixture[];
    screenedOut: ScreenedSenderFixture[];
    spam: SpamItemFixture[];
    emptyStates: Record<"waiting" | "screened" | "spam", ScreenerEmptyState>;
  };
  triage: TriageFixture;
  search: SearchDemoFixture;
  composeDraft: ComposeDraftFixture;
  notificationSettings: NotificationSettingsFixture;
  counts: CountsFixture;
}
