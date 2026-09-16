/**
 * THE DOORKEEPER IN FRONT OF THE LOCATOR BUDGET'S LRU.
 *
 * Least-recently-used has one degenerate case and the worker's poll is exactly it: a round-robin
 * over a roster whose projections together exceed the budget evicts every mailbox before its own
 * turn comes round again, so the hit rate is 0.00 and every cycle pays one `listKnownLocators`.
 * The remedy is admission, not a wider budget: a projection reaches the LRU only on its SECOND
 * miss inside one roster round, so a roster that cannot all be held keeps the mailboxes it will
 * hit instead of replacing them wholesale every round.
 */

/**
 * How many mailbox ids one generation may hold. A worker serves a shard, so this is far above any
 * roster it is given; it is a bound rather than a size, and it is what makes the charge below a
 * number rather than a hope. Past it a first miss is simply not recorded — that mailbox stays cold
 * until a round with room, which is the same cost it pays today.
 */
export const DOORKEEPER_MAX_MAILBOXES = 1024;

/** A remembered mailbox id: its string header and characters, and its slot in the Set. */
const ID_HEADER_BYTES = 16;
const BYTES_PER_CHAR = 2;
const ID_SLOT_BYTES = 24;

function idBytes(mailboxId: string): number {
  return ID_HEADER_BYTES + BYTES_PER_CHAR * mailboxId.length + ID_SLOT_BYTES;
}

/**
 * ONE ROUND OF MEMORY, ROTATED AT THE BOUNDARY — two generations, never one.
 *
 * A mailbox misses at most once per roster round, so a single set cleared at the boundary could
 * never see a second miss and would admit nobody, ever. `current` is the round now running and
 * `previous` the one before it; a miss admits when either remembers the mailbox, and the boundary
 * drops the older generation, so a first miss two rounds old no longer opens the door.
 */
export class KnownSetDoorkeeper {
  private current = new Set<string>();
  private previous = new Set<string>();
  private currentBytes = 0;
  private previousBytes = 0;
  /** The mailboxes that have begun a cycle in the round now running — how the boundary is found. */
  private round = new Set<string>();

  /** What the two generations cost the heap; the budget holds this back from what memos may take. */
  get chargedBytes(): number { return this.currentBytes + this.previousBytes; }

  /**
   * Whether any roster round has been announced. Before the first one there is no window for a
   * second miss to be inside, so the door stands open — an attach pass, a rig or a suite driving
   * the budget directly is admitted by the LRU alone, exactly as before.
   */
  get armed(): boolean { return this.round.size > 0; }

  /** Read by the bound's own case: how many ids each generation is holding. */
  get sizes(): { current: number; previous: number } {
    return { current: this.current.size, previous: this.previous.size };
  }

  /**
   * The worker's loop calls this at the top of every mailbox's turn, so a mailbox beginning a
   * SECOND cycle is the roster having come round — that is the boundary, and it needs no counter
   * from the scheduler and no pass stamp the memo cannot see. A re-admitted mailbox (a doorbell
   * rung after its turn) ends the round early, which admits less rather than more.
   */
  beginCycle(mailboxId: string): void {
    if (this.round.has(mailboxId)) {
      this.previous = this.current;
      this.previousBytes = this.currentBytes;
      this.current = new Set();
      this.currentBytes = 0;
      this.round = new Set();
    }
    this.round.add(mailboxId);
  }

  /**
   * Whether this miss may reach the LRU. A mailbox either generation remembers is admitted; a
   * mailbox neither remembers is recorded and served cold this round. The record is what makes the
   * next miss the second one.
   */
  admits(mailboxId: string): boolean {
    if (!this.armed) return true;
    if (this.previous.has(mailboxId) || this.current.has(mailboxId)) return true;
    if (this.current.size < DOORKEEPER_MAX_MAILBOXES) {
      this.current.add(mailboxId);
      this.currentBytes += idBytes(mailboxId);
    }
    return false;
  }
}
