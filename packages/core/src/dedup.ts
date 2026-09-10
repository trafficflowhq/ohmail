/**
 * IDENTITY IS `(account, mailbox, uidvalidity, uid)` OR THE CONTENT HASH. A header the sender
 * writes — Message-ID, In-Reply-To, References, To, Cc — may GROUP or RANK only when corroborated
 * by something the sender does not control: our own sent record, the person's own reply, or the
 * server's locator. The rule and its four consumers are `sender-headers.ts`.
 */
import { permitsAdoption, type Change, type MoveEvidence, type StoredMessage } from "./ports.js";

export type DedupOutcome =
  | { kind: "new" }
  | { kind: "duplicate"; existing: StoredMessage }
  | { kind: "own_move"; existing: StoredMessage }
  | { kind: "external_move"; existing: StoredMessage }
  | { kind: "external_copy"; existing: StoredMessage }
  | { kind: "own_copy"; existing: StoredMessage };

export interface DedupInput {
  change: Change;
  dedupKey: string;                 // canonical dedup key the caller looked `existing` up with
  existing: StoredMessage | null;   // result of the dual-key lookup, or null
  pendingMoveFolders: Set<string>;  // folders we have an outstanding move to for this message
  /**
   * REQUIRED. What the caller knows about a DISAPPEARANCE — see {@link MoveEvidence}.
   *
   * No default, deliberately: a default would pick the adoption branch invisibly, which is the
   * shape of the bug this field exists to close. A compiled contract fixture omits it on
   * purpose, so leaving it out fails to build rather than silently adopting.
   */
  evidence: MoveEvidence;
}

/**
 * Decide how an incoming change relates to what we already store, using content
 * identity (already resolved into `existing`), pending-move correlation, and the MOVE
 * EVIDENCE that separates a user's placement from a stranger's delivery.
 *
 * - no existing row                        -> new
 * - same folder as stored                  -> duplicate (a re-observation / replay)
 * - different folder, own-authored         -> own_copy (the Sent twin of mail we already hold)
 * - different folder, pending              -> own_move (our move landing; never re-ingest)
 * - different folder, a DISAPPEARANCE      -> external_move (the user moved it; user wins)
 * - different folder, an appearance ONLY   -> external_copy (a second instance; nothing adopted)
 *
 * ── WHY `external_copy` EXISTS, AND WHAT IT KILLS ────────────────────────────────────────────
 *
 * `external_move` used to be the catch-all for "we know this message and it is somewhere we did
 * not put it". That made a PURE CREATE — a delivery — indistinguishable from a user's own filing,
 * and `commitChange` treats a user's filing as authoritative: `folder_state.desired_folder` flips
 * to the observed folder, `last_set_by` becomes `external`, an `adopt_external` audit row is
 * written and a `move` delta goes out to every client.
 *
 * So a stranger could cause ohmail to treat their message as one the user had already consented
 * to. Two deliveries and a wait, no other capability: send a message that matches an existing
 * logical identity, and its placement becomes whatever folder the second delivery lands in. The
 * founding premise of the product — first contact is held for your consent — is defeated by that,
 * because the second message escapes the Screener on the strength of the first.
 *
 * `external_copy` is the honest answer to the same observation: a second PHYSICAL instance of one
 * LOGICAL message. It records the instance (so the locator is known and its body is never
 * re-fetched), sets `folder_state.conflict`, and changes NOTHING about placement — no
 * `desired_folder`, no `change_log` row, no audit. And it is the right answer for the
 * byte-identical case as well as the different-body one: identical bytes ARE the same logical
 * message, so a second instance with no adoption is correct rather than a residue to clean up.
 *
 * ── WHY `own_copy` STILL OUTRANKS THE EVIDENCE CHECK ────────────────────────────────────────
 *
 * One message can legitimately be in TWO folders at once the moment Sent is watched. A user who
 * CCs or BCCs themselves — the oldest self-archiving habit there is — and every mailing list
 * that echoes your own post back to you both put the SAME logical identity in INBOX and in Sent.
 * So does a provider that files an SMTP submission into Sent alongside ohmail's own APPEND.
 *
 * Without this branch, the Sent observation of a message already stored in INBOX would reach the
 * evidence test — and when the user's client APPENDs to Sent and DELETES from INBOX in one
 * session, the evidence is real, so the adoption would fire: the message would DISAPPEAR from the
 * Imbox and a `move` delta would say so. The user's own filing habit would silently empty their
 * inbox. `ownAuthored` is set by the ADAPTER (only it knows the server's Sent path) and only on
 * pure creates.
 *
 * `own_copy` writes no placement and no delta — but it now DOES record its instance.
 * That is not bookkeeping: the reason it did not loop before was the Sent folder's UID watermark
 * (`DEFAULT_SENT_HISTORY_MESSAGES`) and nothing else. INBOX has no watermark, so every other
 * declined locator was re-fetched every cycle for ever.
 *
 * It is deliberately checked AFTER `duplicate`: an own-authored observation in the folder we
 * already record IS just a replay, and the ordinary duplicate path (which re-asserts the
 * locator) is the right one for it.
 */
export function classifyDedup(input: DedupInput): DedupOutcome {
  const { change, existing, pendingMoveFolders, evidence } = input;
  if (existing === null) return { kind: "new" };

  const observedFolder = change.locator.folder;
  const knownFolder = existing.nativeLocator.folder;

  if (observedFolder === knownFolder) return { kind: "duplicate", existing };
  if (change.ownAuthored) return { kind: "own_copy", existing };
  if (pendingMoveFolders.has(observedFolder)) return { kind: "own_move", existing };
  // THE CONSENT BOUNDARY. Adoption requires a disappearance; an appearance is a copy.
  if (permitsAdoption(evidence)) return { kind: "external_move", existing };
  return { kind: "external_copy", existing };
}
