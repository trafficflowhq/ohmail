/** What a found settings document holds, in the units the confirm card speaks. */
export interface ProfileImportCountsWire {
  screener: number;
  rules: number;
  notifyRules: number;
  tags: number;
  awayResponder: boolean;
  /** The copy carries a signature; absent from an older server. On a result: it is this mailbox's now. */
  signature?: boolean;
  /**
   * An offer's: the copy's signature replaces a different one on this mailbox, named by this receipt.
   * The card says so, and Import sends it back; without it the one on the mailbox stays.
   */
  signatureReplaces?: string;
  /** A result's: the copy carried a signature, and the different one on this mailbox stayed. */
  signatureKept?: boolean;
  /** An offer's: the rule removals the copy records, absent when none (or from an older server). */
  removedRules?: number;
}

/**
 * `GET /mailboxes/:id/profile-import` — is there a settings document waiting on this mailbox?
 *
 * `none` is the resting answer and the cheap one: the server reads its own durable record and
 * dials nothing, which is what lets the shell ask once per mailbox per tab. `found` carries the
 * counts of the document AS IT IS NOW plus its `fingerprint` — the receipt the confirm sends
 * back, so what gets applied is exactly what was shown. `newer` means a later ohmail wrote it;
 * nothing is offered, because a partial import would silently drop what this build cannot read.
 */
export type ProfileImportCandidateWire = ProfileImportQuestionWire & {
  /** Whether the mailbox keeps this ohmail's settings copy, as its organizer last recorded it; absent when never refused. */
  copy?: { kept: boolean; code: string | null };
};

type ProfileImportQuestionWire =
  | { state: "none" }
  | {
      state: "found";
      fingerprint: string;
      updatedAt: string;
      producer: { kind: string; version: string };
      counts: ProfileImportCountsWire;
    }
  | { state: "newer"; v: number }
  /**
   * Answered "Not now" and still standing in the mailbox, which this install does not overwrite.
   * Settings shows it with two presses, {@link profileImport.apply} and
   * {@link profileImport.replace}; the card never offers it again. Counts as detected.
   */
  | {
      state: "declined";
      fingerprint: string;
      updatedAt: string;
      producer: { kind: string; version: string };
      counts: ProfileImportCountsWire;
    }
  /**
   * The document holds more entries in one of its lists than the server will apply in a single
   * transaction, so nothing is offered — the same answer `newer` gives, for a different reason.
   *
   * Declared so the wire contract is complete; the card reads it as NO OFFER through `asOffer`'s
   * tolerant reader, which is already the correct behaviour — nothing is claimed and nothing is
   * shown. A dedicated message naming the list and the limit would be better and is a separate
   * change to the card, not to this type.
   */
  | { state: "too_large"; fingerprint: string; list: string; count: number; max: number };

export interface ProfileImportAppliedWire {
  imported: ProfileImportCountsWire;
  /** Document rules the server's own validation refused — imported minus these arrived. */
  skippedRules: number;
  /** Rules here the copy records as removed there, removed here too; absent from an older server. */
  retiredRules?: number;
  seq: number | null;
}

/**
 * `POST …/profile-import` answered 202: the read did not fit the request, and the mailbox's
 * organizer finishes the import. `reason` is `slow` or `unreachable` when this press found out,
 * absent when the same press was already waiting. Ask {@link profileImport.status} after.
 */
export interface ProfileImportPendingWire {
  state: "importing";
  fingerprint: string;
  reason?: "slow" | "unreachable";
}

/** `GET …/profile-import/status` — where a handed-over press stands. Never dials. */
export type ProfileImportStatusWire =
  | { state: "importing"; fingerprint: string }
  | {
      state: "imported";
      imported: ProfileImportCountsWire | null;
      skippedRules: number;
      retiredRules?: number;
    }
  | { state: "refused"; reason: string; message: string };

/** The host carries the exact reviewed document and promises that a refusal sentence comes from the server. */
export interface ProfileImportTransport {
  candidate(mailboxId: string): Promise<ProfileImportCandidateWire>;
  /**
   * 200 applied, or 202 handed to the organizer — then {@link status} is asked. `signatureReplaces`:
   * the offer's receipt, sent only when the card said the copy's signature replaces this mailbox's.
   */
  apply(
    mailboxId: string,
    fingerprint: string,
    signatureReplaces?: string,
  ): Promise<ProfileImportAppliedWire | ProfileImportPendingWire>;
  /** Where a handed-over press stands. A primary-key read; never a dial. */
  status(mailboxId: string, fingerprint: string): Promise<ProfileImportStatusWire>;
  decline(mailboxId: string, subject: { fingerprint?: string; v?: number }): Promise<unknown>;
  /** The Settings row's "save this ohmail's settings to the mailbox" — see `api-client`. */
  replace(mailboxId: string, fingerprint: string): Promise<unknown>;
}
