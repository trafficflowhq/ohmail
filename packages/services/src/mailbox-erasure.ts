/**
 * The per-mailbox erasure lives in `@trafficflow/db` (`mailbox-erasure.ts`): the request stamps
 * from here and the worker's pass sweeps from there, and the worker may import db alone. One
 * table walk, re-exported so a services caller names it where it always did.
 */
export {
  stampMailboxErasure, sweepMailboxData, erasureRemaining,
  type MailboxErasureStamp,
} from "@trafficflow/db";
