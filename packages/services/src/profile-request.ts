import { type OrganizedBy, type Tx } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import {
  planAccountFanOut, writeReaderRequest, type AccountFanOut, type FanOutRefusal,
} from "./reader-request.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PROFILE FAMILY'S ONE PAYLOAD — `profile.update` (mail 0094, ruling 6)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Four doors in three files edit the configuration that travels in the organizer's published
 * document: the away responder, the screening preference, the dormancy window, and the mailbox
 * signature. They all compose the SAME partial payload, and they compose it here.
 *
 * ── WHY IT IS PARTIAL, AND WHAT "PARTIAL" MEANS ON THE OTHER SIDE ──────────────────────────
 *
 * Each present field REPLACES; an ABSENT field is not mentioned and is left alone. That is the
 * difference between "the person edited their responder" and "the person cleared everything except
 * their responder", and a full-document payload could not tell those apart: a door that knows
 * about one setting would send nulls for the other three and wipe them on the organizer.
 *
 * So absence is load-bearing, and it is why every field here is optional rather than nullable with
 * a sentinel. `signature: null` means "no signature" — a value somebody chose. `signature` absent
 * means "this request is not about the signature".
 *
 * ── THE FAMILY IS SCOPED TWO DIFFERENT WAYS, WHICH IS THE PART THAT SURPRISES ──────────────
 *
 * Three of the four are ACCOUNT-scoped rows (`away_responders` and `account_settings`), so they
 * fan out: a local write for the mailboxes this install organizes, plus one request per install
 * holding one of the others. The SIGNATURE is `mailboxes.signature` — per mailbox, because a person
 * with two addresses has two sign-offs — so it takes the per-mailbox dispatch instead, and asking
 * it the account-wide question would publish one mailbox's sign-off into the other's document.
 */

/**
 * THE SIGNATURE'S BOUND ON A READER DOOR — 2 000 characters (ruling 6).
 *
 * `MAILBOX_SIGNATURE_MAX_CHARS` is 10 000 for a LOCAL write, and that stays: a signature this
 * install stores and appends itself has no wire to cross. A signature that has to TRAVEL does, and
 * the wire's own ceiling is `REQUEST_PAYLOAD_MAX_BYTES` measured on the base64url of the JSON —
 * which a 10 000-character signature exceeds, and which `writeReaderRequest` would refuse with a
 * sentence about encoded bytes.
 *
 * Bounded here as well, in CHARACTERS, so the refusal a person reads is about their signature
 * rather than about an encoding. Both layers, deliberately: this is the sentence, and the byte
 * ceiling behind it is the guarantee — a 2 000-character signature of multi-byte glyphs can still
 * exceed the wire cap, and it is refused there rather than truncated.
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
   * WHICH PILES GET A REPLY — folder names (mail 0096).
   *
   * Added by the ruling "the away responder's pile scope travels in the profile fan-out"
   * (2026-09-10). Before it, a save on a MIXED or READER account that changed the scope wrote
   * nothing locally, sent one request per held mailbox carrying the other six fields, and the
   * organizer's applier dropped the key it never received — so the pane showed the old scope back
   * and the person read it as a setting that reverted itself.
   *
   * `string[]` and not `AwayPile[]`: this is what a door produced and it crosses an install
   * boundary, so the receiving half validates it again against the closed set rather than
   * trusting this type. It is REQUIRED here — every door that builds this patch runs the input
   * through `validPiles`, which always answers an array — while the wire's own reading of it is
   * OPTIONAL, because an install one release older sends no `piles` at all and its saves must
   * keep working.
   */
  piles: string[];
}

/** The partial. Every field optional; present replaces, absent is not mentioned. */
export interface ProfileUpdatePayload {
  awayResponder?: ProfileAwayResponderPatch;
  signature?: string | null;
  dormancyDays?: number | null;
  screeningPreference?: {
    ohboxPolicy?: string | null;
    ohboxBar?: string | null;
    screenerAutoApply?: boolean;
  };
}

/**
 * COMPOSE THE PAYLOAD, dropping nothing and inventing nothing.
 *
 * A field the caller did not name never appears. Written as an explicit copy rather than a spread
 * of the caller's object so that a door which grows a field cannot silently start sending it: the
 * shape is defined by ruling 6 and the drain that applies these requests, and a new member is a
 * ruling, not a commit.
 *
 * ONE MEMBER HAS BEEN ADDED THAT WAY, and it is named here because this docblock is the rule it
 * had to satisfy: `piles` inside {@link ProfileAwayResponderPatch}, by the ruling "the away
 * responder's pile scope travels in the profile fan-out" (2026-09-10). Cited by date and subject
 * rather than by commit, because a sha in a source comment is a pointer that a rebase turns into
 * a survivor no sweep can clear.
 *
 * Note that the copy is per TOP-LEVEL field: `awayResponder` is assigned whole, so a member added
 * to that interface travels the moment the type admits it. That is precisely why the interface —
 * not this function — is where the ruling is recorded.
 */
export function profileRequestPayload(p: ProfileUpdatePayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.awayResponder !== undefined) out.awayResponder = p.awayResponder;
  if (p.signature !== undefined) out.signature = p.signature;
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

/* NO `planProfileFanOut` WRAPPER HERE, AND THAT IS DELIBERATE.
 *
 * A one-line alias fixing the kind to `profile.update` looked like the tidy thing and was measured
 * to be a hole: `organizer-role-census` keys on the DISPATCH's names, so every door calling the
 * alias instead of `planAccountFanOut` would have gone INVISIBLE to it — two of the three
 * account-scoped settings doors, silently absent from the list of doors that ask the question,
 * with the census green.
 *
 * A census keyed on names cannot see through an indirection, so the doors name the dispatch
 * directly and pass the kind. One extra argument at three call sites is the price of the guard
 * being able to find them.
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
