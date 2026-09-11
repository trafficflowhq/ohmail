import { type OrganizedBy, type Tx } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import {
  planAccountFanOut, writeReaderRequest, type AccountFanOut, type FanOutRefusal,
} from "./reader-request.js";

/**
 * THE PROFILE FAMILY'S ONE PAYLOAD — `profile.update` (mail 0094). Four doors edit configuration
 * that travels in the organizer's published document — away responder, screening preference,
 * dormancy window, mailbox signature — and all compose the SAME partial payload here. A present
 * field REPLACES; an ABSENT field is left alone: a door that knows one setting must not wipe the
 * other three, which a full-document payload would. Fields are optional, not
 * nullable-with-sentinel: `signature: null` means "no signature" (chosen); absent means "not
 * about the signature". Three of the four are ACCOUNT-scoped and fan out per holding install; the
 * SIGNATURE is `mailboxes.signature`, per mailbox, and takes the per-mailbox dispatch.
 */

/**
 * THE SIGNATURE'S BOUND ON A READER DOOR — 2 000 characters. `MAILBOX_SIGNATURE_MAX_CHARS` is 10
 * 000 for a LOCAL write, and that stays: a locally stored signature crosses no wire. One that
 * TRAVELS does, and the wire's ceiling is `REQUEST_PAYLOAD_MAX_BYTES` measured on the base64url
 * of the JSON — which a 10 000-character signature exceeds, refused by `writeReaderRequest` with
 * a sentence about encoded bytes. Bounded here as well, in CHARACTERS, so the refusal a person
 * reads is about their signature, not an encoding. Both layers, deliberately: this is the
 * sentence; the byte ceiling is the guarantee — 2 000 multi-byte glyphs can still exceed the wire
 * cap and are refused there, never truncated.
 */
export const TRAVELLING_SIGNATURE_MAX_CHARS = 2000;

/**
 * The travelling half of the away responder — the fields ONE `profile.update` REQUEST carries.
 *
 * NOT the same list as the published document's `ProfileAwayResponder`
 * (`@trafficflow/core/adapters/organizer-profile`), and the one that differs is {@link piles}: a
 * request carries it, that document does not. The sentence here used to say "the fields the
 * published document carries" and the two lists were the same, which is why the difference is
 * called out rather than left to be inferred — the document's own shape is a separate ruling, and
 * an import from a document therefore still takes the column's narrow default.
 */
export interface ProfileAwayResponderPatch {
  enabled: boolean;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  audience: string;
  throttle: string;
  /**
   * WHICH PILES GET A REPLY — folder names (mail 0096). The away responder's pile scope travels
   * in the profile fan-out. Before it did, a scope change on a MIXED or READER account wrote
   * nothing locally and the organizer's applier dropped the key it never received — the pane
   * showed the old scope back. `string[]`, not `AwayPile[]`: this is what a door produced and it
   * crosses an install boundary, so the receiving half validates against the closed set rather
   * than trusting the type. REQUIRED here — every door runs the input through `validPiles`, which
   * always answers an array — while the wire's reading is OPTIONAL: an older install sends no
   * `piles`, and its saves must keep working.
   */
  piles: string[];
}

/** The partial. Every field optional; present replaces, absent is not mentioned. */
export interface ProfileUpdatePayload {
  awayResponder?: ProfileAwayResponderPatch;
  signature?: string | null;
  /**
   * THE SIGNATURE'S MARKUP (mail 0098) — the authority half, sent beside the text derived from it.
   *
   * Added by the ruling "a signature's formatting travels to the install that organizes the
   * mailbox" (2026-09-10). Before it this payload had one signature slot and it was the plain
   * half, so a formatted sign-off arrived at the holder as words with the bold, the italic and
   * the links stripped, and nothing reported a partial result. `null` is part of the value: a
   * plain save clears the markup locally and must clear it on the holder too.
   */
  signatureHtml?: string | null;
  dormancyDays?: number | null;
  screeningPreference?: {
    ohboxPolicy?: string | null;
    ohboxBar?: string | null;
    screenerAutoApply?: boolean;
  };
}

/**
 * COMPOSE THE PAYLOAD, dropping nothing and inventing nothing. A field the caller did not name
 * never appears. An explicit copy rather than a spread, so a door that grows a field cannot
 * silently start sending it: the shape is a contract with the drain that applies these requests,
 * and a new member is a decision, not a drive-by. Two were added that way: `piles` in
 * `ProfileAwayResponderPatch` and `signatureHtml`. The copy is per TOP-LEVEL field:
 * `awayResponder` is assigned whole, so a member added to that interface travels the moment the
 * type admits it — which is why the interface, not this function, is where such an addition is
 * recorded.
 */
export function profileRequestPayload(p: ProfileUpdatePayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.awayResponder !== undefined) out.awayResponder = p.awayResponder;
  if (p.signature !== undefined) out.signature = p.signature;
  if (p.signatureHtml !== undefined) out.signatureHtml = p.signatureHtml;
  if (p.dormancyDays !== undefined) out.dormancyDays = p.dormancyDays;
  if (p.screeningPreference !== undefined) out.screeningPreference = p.screeningPreference;
  if (Object.keys(out).length === 0) {
    // Unreachable from a door that checked its own input, and a throw rather than an empty record
    // because an empty `profile.update` is a request asking for nothing: the organizer would apply
    // it, republish an identical document and ack `applied`, and the person would be told their
    // edit travelled when there was no edit.
    throw new ServiceError(
      "validation_failed", 400, "this change names no setting, so there is nothing to send",
    );
  }
  return out;
}

/** One held mailbox that took the settings edit. */
export interface ProfileRequestSent {
  mailboxId: string;
  requestId: string;
  holder: OrganizedBy;
}

/**
 * WHERE ONE SETTINGS EDIT WENT, MAILBOX BY MAILBOX.
 *
 * The same shape `RuleTravel` carries and for the same reason: one press on account-scoped
 * configuration can be a local write AND several requests, and reporting that as one "saved" is
 * the false state ruling 6 names as its Critical. Before mail 0094 these four doors had NO
 * organizer gate at all — on a mailbox this install only reads, the edit wrote the reader's own
 * dead row and the pane showed it as done, for ever.
 */
export interface ProfileTravel {
  appliedLocally: string[];
  pending: ProfileRequestSent[];
  refused: FanOutRefusal[];
}

/** Did anything leave this install? The discriminator for reporting `travel` at all. */
export function profileTravelled(plan: AccountFanOut): boolean {
  return plan.requestTo.length > 0 || plan.refused.length > 0;
}

/**
 * NO `planProfileFanOut` WRAPPER HERE, DELIBERATELY. A one-line alias fixing the kind to
 * `profile.update` was measured to be a hole: `organizer-role-census` keys on the DISPATCH's
 * names, so every door calling the alias instead of `planAccountFanOut` would go INVISIBLE to it
 * — two of the three account-scoped settings doors silently absent, census green. A census keyed
 * on names cannot see through an indirection, so the doors name the dispatch directly and pass
 * the kind. One extra argument at three call sites is the price of the guard finding them.
 */

/**
 * SEND ONE `profile.update` PER CAPABLE HOLDER and report every mailbox's outcome.
 *
 * Refusals ride back rather than throwing, on the rules family's argument: on a mixed account some
 * installs took the edit and one did not, and a throw would discard the successes and tell the
 * person nothing happened.
 */
export async function fanOutProfileEdit(
  tx: Tx, ctx: ServiceContext, plan: AccountFanOut, payload: ProfileUpdatePayload,
): Promise<ProfileTravel> {
  const wire = profileRequestPayload(payload);
  const pending: ProfileRequestSent[] = [];
  for (const target of plan.requestTo) {
    const sent = await writeReaderRequest(tx, ctx, {
      mailboxId: target.mailboxId, kind: "profile.update", payload: wire, holder: target.holder,
    });
    pending.push({ mailboxId: target.mailboxId, requestId: sent.requestId, holder: target.holder });
  }
  return { appliedLocally: plan.organized, pending, refused: plan.refused };
}
