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
 * How an incoming change relates to what we store: no row → new; same folder → duplicate;
 * own-authored → own_copy; pending → own_move; a DISAPPEARANCE → external_move (the user moved
 * it); an appearance only → external_copy. `external_copy` exists because the catch-all made a
 * delivery look like a user's filing — which `commitChange` treats as authoritative, so a
 * stranger's second delivery could set the placement and escape the Screener. It records the
 * instance, sets `conflict`, changes nothing about placement. `own_copy` outranks the evidence
 * check: a self-CC puts one identity in INBOX and Sent — without this branch the user's own habit
 * would empty their inbox. It records its instance too, checked AFTER `duplicate`.
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
