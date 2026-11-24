/**
 * The words nearly every other module of this package is written in: an instant, a cursor, a page,
 * an address, the six folders, and the small closed sets a message carries.
 */

export type ISODateTime = string;

// ── Cursor-paginated list envelope. Independent from /sync cursors. ──
export type Cursor = string;

export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;   // null ⇒ last page
}

export interface EmailAddress { name: string | null; address: string; }

/**
 * Real IMAP folders — the six the rules file mail into (the rules' own name for the set is
 * `Destination`; contract §1.2).
 * These five strings are the most durable copy the product writes: created
 * inside the customer's own mailbox, rendered by every client, forever —
 * including after the customer leaves. Changing one is an IMAP data
 * migration — the 0.22 News rename did it, the organizer renaming on its
 * next pass with both spellings admitted meanwhile. Never render a raw
 * folder string: map through `VIEW_OF_FOLDER`, and fall back to
 * `folderLeaf()` for a folder this client does not know (contract §8).
 */
export type Folder =
  | "INBOX"
  | "ohmail/Screener"
  | "ohmail/News"
  | "ohmail/Receipts"
  | "ohmail/Screened"
  | "ohmail/Quarantine";

export interface SensitivityFlags {
  sensitive: boolean;
  category: "otp" | "verification" | "password_reset" | "security_alert" | null;
  no_ai: boolean;
  no_forward: boolean;
  no_kb: boolean;
  priority: boolean;
}

/**
 * The authentication evidence about the CLAIMED author. `"fail"` demotes: evidence against, toward
 * the Screener only. Absent evidence must never select the destructive branch for a person's
 * consent: gating the known-sender match on a positive verdict makes every row of a large backlog
 * answer Screener, so a person's consent is honoured without `pass`. The one exception is an
 * inferred admission of a company's own address, held at an arrival door unless `pass`
 * (`rules.ts#EvaluateRulesInput.ownedUnconfirmed`). Members: `"unauthenticated"` — the caller did
 * not look (NULL resolves here); `"unavailable"` — looked, found nothing it may believe; `"pass"` —
 * the provider or the sender's own signature confirmed it; `"fail"` — evidence AGAINST. A
 * compile-time fixture pins the field required.
 */
export type AuthVerdict = "unauthenticated" | "unavailable" | "pass" | "fail";

/** Which fact decided a capped suggestion. A closed set — the row renders one sentence per code. */
export type SenderReasonCode =
  | "impersonation" | "campaign" | "auth_fail" | "brand_mismatch" | "correspondent";

/**
 * Why {@link oneClickUnsubscribeUri} answered what it answered — for a message a user is
 * looking at, so the interface can say "this sender offers no way out" instead of going quiet.
 *
 * `"mailto_only"` means the header offered no `https:` URI we may act on — in practice a
 * `mailto:`, and it is a distinct state on purpose: it is the case where the sender DID publish
 * an unsubscribe route and we are refusing it on the user's behalf, which is the one refusal
 * that owes the user an explanation.
 *
 * As a client reads it on the body fetch (§8):
 *  · `one_click`     — RFC 8058; the server can POST it for the user.
 *  · `not_one_click` — an https unsubscribe page, opened in a browser.
 *  · `mailto_only`   — a `mailto:` route ohmail never sends on the user's behalf.
 *  · `no_header`     — no route; also the forward-compatible default when
 *                      an older server does not send the field.
 */
export type UnsubscribeHeaderState =
  | "one_click"
  | "no_header"
  | "mailto_only"
  | "not_one_click";
