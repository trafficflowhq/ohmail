import { refuse, type Refusal } from "../refusal";
import type { SessionDeath } from "./bearer";

/**
 * WHAT A PERSON READS WHEN A SESSION ENDS ON THE SERVER — one mapping, in one place, so the
 * connection layer's render and the suite that watches it read the same line.
 *
 * `revoked` is the family the server SWEPT: a token it had already spent was presented, which is
 * the theft signal and, until the attempt id existed, was also what an ordinary dropped refresh
 * answer looked like. It is named because "pair again" with no reason is what somebody met on a
 * phone that had done nothing wrong. Everything else is the plain end of a pairing.
 */
export function deathRefusal(why: SessionDeath): Refusal {
  return refuse(why === "revoked" ? "pairKeyPresentedTwice" : "pairEndedOnServer");
}
