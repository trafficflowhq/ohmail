/**
 * THE SCREENER: a waiting sender as the server lists one, a bought suggestion as the feed carries
 * it and as a device copy reads it, and the sender row a client derives for its screen.
 */
import type { EmailAddress, Folder, ISODateTime, SenderReasonCode, UnsubscribeHeaderState } from "./base.js";
import type { BodyState, WithheldMarker } from "./bodies.js";
import type { SenderCheckDTO } from "./mail.js";
import type { OhmailView } from "./mirror.js";

export interface ScreenerItem {
  id: string;                     // the screener entry id (the representative message id when derived)
  messageId: string;
  /**
   * THE SENDER'S IDENTITY FACT (mail 0148), aggregated over every held message of theirs: one
   * names `brand` from an address `brand` does not send from. Absent when none does. Rendered
   * apart from `aiSuggestion`, which it also caps whatever message the advice was bought on.
   */
  checked?: SenderCheckDTO;
  /**
   * WHICH OF THE ACCOUNT'S MAILBOXES THE STRANGER WROTE TO. The id, never the address: a sheet
   * resolves it through the roster it already holds, and the "more than one mailbox" gate lives
   * in that resolver so no surface re-derives it. Absent from the wire until now, so a client
   * could not label the row if it wanted to — the Junk pane beside it has always been per-mailbox.
   */
  mailboxId: string;
  threadId: string | null;
  /**
   * `name` is the display name the sender chose, as the mirror parsed it — screening signal, and
   * the reason this is not the bare address: a stranger's asserted identity is half of what the
   * decision is taken on. Null where the mail carried none.
   */
  sender: EmailAddress;
  subject: string;
  snippet: string;
  receivedAt: ISODateTime;
  aiSuggestion: {                 // AI pre-suggestion (reuses the injected classifier)
    // `hold` ⇒ the model declined to place this sender, so the decision belongs to the person
    // reading the Screener. A surface may show it; a BULK control may never act on it. See
    // `screener-advice.ts`'s SCREEN_DISPOSITION for why this is three-valued and not two.
    //
    // THIS FIELD IS THE BULK-ACTIONABLE VERDICT AND NOTHING ELSE. It is deliberately still
    // three-valued after `destination` was added beside it: every bulk control reads `decision`,
    // so widening it would have widened what "Apply all" may do in one step.
    decision: "yes" | "no" | "hold";
    /**
     * WHICH pile the model actually named — the answer `decision` collapses. The collapse was
     * lossy in a way the user could see: on a live account 63 `ohmail/Receipts`, 43
     * `ohmail/Reads` and 5 `ohmail/Quarantine` answers all rendered as the single word "Screened
     * out", so the Screener appeared never to suggest Receipts, Reads or spam. A surface shows
     * this; nothing acts on it. `decision` remains the only field a control may consult, so a
     * client that ignores this field behaves exactly as before.
     */
    destination: Folder;
    /** The model's own hard "no". Separated from `ohmail/Screened` so junk can be named as junk. */
    spam: boolean;
    confidence: number;           // 0..1
    rationale: string;
    /**
     * WHICH FACT OHMAIL CHECKED DECIDED THIS — absent for every suggestion the model's own answer
     * stands unchanged for, which is nearly all of them. A closed set (`SenderReasonCode`), so a
     * surface renders ONE sentence per code out of its own catalogue rather than printing a
     * server string: the reason is a fact about this message, and a fact is said in the reader's
     * language. `rationale` stays the model's sentence and is unrelated — where a fact capped the
     * answer and the model disagreed, `rationale` is empty and this names why.
     */
    reasonCode?: SenderReasonCode;
    /**
     * The brand the mail claimed to be, for `impersonation` — from OHMAIL's own dictionary, never
     * a word the sender wrote, which is what makes it safe to render. Absent for every other code.
     */
    reasonBrand?: string;
    /** How many unrelated senders carried this subject, for `campaign`. Absent otherwise. */
    reasonCount?: number;
  } | null;                       // null while unclassified / when AI is unavailable
  updatedAt: ISODateTime;
}

/**
 * A bought Screener suggestion as `/sync` carries it — THE VERDICT, NEVER THE MODEL'S TEXT. The
 * 2026-09-18 ruling reversed "no model output in /sync" for exactly these fields: the chip's
 * facts, so every device shows a purchase the second it lands. `rationale` (the model's own
 * sentence) stays OFF the wire by design — `decision` is derived server-side (posture, the
 * rationale gate, the sender check), so the client renders a verdict it could not misderive.
 * The entity id is the stored row's id (a re-buy tombstones the old row and creates a new one);
 * `senderKey` is the grouping key — a suggestion is ABOUT a sender, bought from one message.
 */
export interface ScreenerSuggestionDTO {
  id: string;
  /** The message the advice was bought about; the client mirror cascades on it. */
  messageId: string;
  /** `lower(from_address)` of that message — the per-sender key every client groups by. */
  senderKey: string;
  decision: "yes" | "no" | "hold";
  destination: Folder;
  spam: boolean;
  confidence: number;
  reasonCode?: SenderReasonCode;
  reasonBrand?: string;
  reasonCount?: number;
  /** When the suggestion was bought (the stored row's creation). */
  boughtAt: ISODateTime;
  updatedAt: ISODateTime;
  /**
   * When the act on suggestions tried to file this sender and was refused, and why —
   * both or neither, `null` on every ordinary suggestion. The Screener row says one sentence.
   */
  actRefusedAt: ISODateTime | null;
  actRefusal: "account_erased" | "not_organizer" | "mailbox_removed" | "store_fault" | null;
}

/**
 * A bought Screener suggestion as `/sync` delivers it — the server's `ScreenerSuggestionDTO`
 * (above), spelled here as the CLIENT reads it: `destination` and
 * `reasonCode` stay open strings so an older client tolerates a newer server's vocabulary rather
 * than throw. THE VERDICT ONLY, never the model's text: `decision` arrives derived (posture, the
 * rationale gate, the sender check), so a client cannot misderive it, and there is no `rationale`
 * field on this wire by design.
 */
export interface ScreenerSuggestionEntity {
  id: string;
  /** The message the advice was bought about; the mirror cascades on it. */
  messageId: string;
  /** `lower(from_address)` — the per-sender key a surface groups by; newest `boughtAt` wins. */
  senderKey: string;
  decision: "yes" | "no" | "hold";
  destination: string;
  spam: boolean;
  confidence: number;
  reasonCode?: string;
  reasonBrand?: string;
  reasonCount?: number;
  boughtAt: ISODateTime;
  updatedAt: ISODateTime;
  /**
   * Why the act on suggestions could not file this sender, or `null`; absent from an
   * older server. The refusal and its clear both ride the delta, so the mirror is its authority.
   */
  actRefusal?: string | null;
  actRefusedAt?: ISODateTime | null;
}

export type ScreenerSegment = "waiting" | "screened_out" | "spam";

export interface ScreenerHeldMail {
  /** Own identity, so a held message is never just a slot in a count. */
  id: string;
  subject: string;
  time: string;
  body: string;
  /**
   * The message's own snippet and read state, on a DERIVED row. A surface draws the body through
   * its reader's door (the webapp's `useDrawnBody`), which rests on the snippet; `body` below is
   * this derivation's copy and does not move when a body lands under a derived stamp.
   */
  snippet?: string;
  unread?: boolean;
  /**
   * WHAT `body` ACTUALLY IS. Absent ⇒ `full`, which is the fixture world:
   * a `screener_sender` entity carries its held bodies verbatim and there is nothing to
   * hydrate. A DERIVED row — every row on a Cloud account — starts at `snippet` and moves
   * through `loading` to `full` or `failed`, and the preview has to say which, because a
   * consent decision taken on a truncation is the risk the Screener exists to remove.
   */
  bodyState?: BodyState;
  /** WHY a `withheld` body is empty — {@link MessageBody.withheld}; absent on every other state. */
  bodyWithheld?: WithheldMarker;
  /**
   * The stored `text/html` part, or null. Carried so the Screener renders a stranger's mail
   * with the SAME sandboxed renderer the reading pane uses — sanitized, in a frame that cannot
   * phone home, remote images blocked until consent — rather than as a text dump the consent
   * decision is taken on. Null on a fixture row (the demo carries text only) and on every
   * non-`full` `bodyState`, which is the contract {@link bodyOf} already keeps: only a hydrated
   * `ready` body has a document to show. Optional so a `screener_sender` fixture entity, whose
   * held array is carried verbatim, needs no new field.
   */
  html?: string | null;
  /** Whether the reader has consented to remote content for THIS held message. */
  loadedRemoteContent?: boolean;
  /**
   * The sender's unsubscribe posture on THIS held message, from its hydrated body. The Screener's
   * screened-out and spam previews render an unsubscribe control from it (one-click acts via the
   * route, not-one-click links out). Absent on a fixture row and until the body is `full`, which
   * is why it is optional and defaulted to `"no_header"` where read. */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's https unsubscribe page, for `not_one_click` only; else null/absent. */
  unsubscribeUrl?: string | null;
  trackerNote?: string;
}

/**
 * A HELD LETTER ITS PROVIDER FAILED, WITH NO WAITING ROW TO DECIDE IT — one claiming the account's own
 * address, a contact's, or a decided sender's. Not counted and outside the queue's pages: each letter
 * is decided alone, by a `move` out of the gate, never by a rule.
 */
export interface FailedAtGateDTO {
  id: string;
  from: EmailAddress;
  subject: string;
  /** The row's stamp, as every Screener row's. */
  time: string;
  mailboxId: string;
  /** The letter claims one of the account's own addresses. */
  own: boolean;
}

export interface ScreenerSenderDTO {
  id: string;
  segment: ScreenerSegment;
  from: EmailAddress;
  /**
   * THE IDENTITY FACT, FOR THE SENDER: a held message of theirs claims `brand` by name from an
   * address `brand` does not send from (`MessageDTO.senderCheck`), aggregated over the very bag
   * this row lists, the newest marked message naming the brand. `domain` is the address's own, for
   * the shared-provider sentence. Rendered outside the AI advice, whether or not any was bought.
   * `list`: anyone on a mailing list can write as this address (mail 0150) — its own sentence.
   * `claimsOnly`: the store's queue says a screen-out of this sender sets aside the letters claiming
   * `brand` alone and writes no rule (a list the person let in); absent, it is the address's.
   * `unverified`: no held letter claims anything, and the address is `brand`'s own while its
   * provider did not confirm the sender — said on the row, with no chip; a claim outranks it.
   * `brand` may then be a domain (`admin.ch`), where the address names no one brand.
   */
  checked?: {
    reason: "impersonation" | "unverified"; brand: string; domainShared: boolean; domain: string; list?: true;
    claimsOnly?: true;
  };
  /**
   * HOW MANY LETTERS OF THIS SENDER THE LISTS SHOW PAST THE GATE — in the Ohbox, News or Receipts.
   * A waiting row is first contact only while this is absent: an answer the gate admitted is there.
   */
  reached?: number;
  /**
   * An enabled allow rule names this sender's domain, and the domain is a shared provider's: the
   * rule admits nobody, so the sender waits as a stranger the rule seemed to cover. Said on the row.
   */
  inertRule?: { domain: string };
  /**
   * WHICH OF THE ACCOUNT'S MAILBOXES THE STRANGER WROTE TO — the representative's own
   * `mailboxId`, the same fact `ScreenerItem.mailboxId` carries on the wire. The id and never the
   * address: the sheet resolves it through the roster it already holds, and the "more than one
   * mailbox" gate lives in that resolver so no surface re-derives it. Optional because a FIXTURE
   * row has no mailbox behind it — absent means "nothing to name", which is what the demo is.
   */
  mailboxId?: string;
  initial: string;
  time: string;
  scope: "sender" | "domain";
  dull?: boolean;
  /**
   * The advice on record for this sender, or `null` when none was ever
   * bought. `noAnswer` exists because the other two could not say it: a run
   * that could not answer left the row looking exactly like one nobody had
   * asked about, on a surface the person had just paid to fill in. Present
   * ⇒ `dest` is `screener` and the reason is the content. It was
   * `withheld`; under the AI-OPEN ruling of 2026-08-08 there is no such
   * mail on a path a person asked for, so the member and the name are gone
   * — every reason left is a fact about the RUN, answered by asking again.
   */
  ai: {
    dest: OhmailView | "screened" | "spam";
    confidence: number;
    rationale: string;
    /**
     * The mirror's `screener_suggestion` this came from — which purchase it is, for the one join
     * of the mirror and the session's overlay (`joinSuggestion`). Absent on a fixture row and on
     * an answer the overlay holds; client-side only, never on the wire.
     */
    id?: string;
    noAnswer?: "out_of_credits" | "over_quote" | "spend_unavailable" | "model_unavailable" | "model_declined";
    /**
     * WHICH FACT OHMAIL CHECKED DECIDED THIS — a deterministic sender check the server ran before
     * the model, which may bound what the model's answer is allowed to say. A closed set, so the
     * row renders one sentence per code out of its own catalogue rather than a server string.
     * Absent on every ordinary suggestion, on a fixture row, and from any server that predates it.
     */
    reasonCode?: "impersonation" | "campaign" | "auth_fail" | "brand_mismatch" | "correspondent";
    /** The brand named for `impersonation` — ohmail's own dictionary word, never the sender's. */
    reasonBrand?: string;
    /** How many unrelated senders carried this subject, for `campaign`. */
    reasonCount?: number;
    /** The act on suggestions tried to file this sender and was refused. */
    actRefused?: true;
  } | null;
  /**
   * NO-COLLAPSE: every held message, in full, oldest first —
   * non-empty in every segment. There is deliberately no `heldCount` /
   * `lastSubject` / `lastBody` beside it: a count that is not `held.length`
   * can drift, and a "last body" is how held mail becomes hidden mail.
   */
  held: ScreenerHeldMail[];
  /**
   * TRUE when this sender’s representative message is `no_ai` — mail the sensitivity pass keeps
   * away from a model. Such a row can never carry a suggestion, and it used to say "No suggestion
   * yet", a promise nothing was ever going to keep. Optional and only ever `true`: absent means
   * "not that", which is what a fixture row and an older mirror both are.
   */
  noAi?: true;
  /**
   * screened_out only — the row's stamp, minted through {@link messageStamp} like every other
   * stamp on this screen and never by a caller's own formatting. Absent where no producer can
   * form one (a mutation has no zone or locale), and the row's own `time` answers.
   */
  screenedOn?: string;
  /** spam only */
  detection?: { source: string; confidence: number; reason: string; label: string };
  /**
   * TRUE when `screenerSegments()` computed this row from the message
   * mirror rather than a `screener_sender` entity — every row on a Cloud
   * account, none in the demo. Not cosmetic: `id` is then the
   * representative MESSAGE id (what `POST /screener/:id` resolves), and the
   * affordances differ — the server has no un-screen and no delete
   * endpoint, so releasing a derived sender is per-message `move` and
   * Delete is not offered. The UI must not guess which kind of row it has.
   */
  derived?: true;
  /**
   * Whether the representative is physically at the gate (`ohmail/Screener`) — waiting rows
   * only. The segments run over the PROJECTED reader, where an active-undecided sender's INBOX
   * mail is presented in the Screener without leaving the INBOX; such a rep is physically in
   * the INBOX, so `POST /screener/:id` would 404 and the local guard refuses. `false` marks
   * exactly that case, so the commit path routes past the gate (`rule_create`); `true` when
   * genuinely held; absent on a fixture row. Observable record, not authority:
   * `screener-state.ts#commit` re-reads the raw mirror at commit time.
   */
  gatePhysical?: boolean;
  /**
   * A waiting row MINTED from the store's queue page: the mirror holds none of this sender's held
   * mail, so `held` is the one message the page named, at its snippet. A decision on it is the
   * ordinary decide, sent for a representative only the server holds.
   */
  stored?: true;
  updatedAt: ISODateTime;
}
