/**
 * THE DOOR'S TICKETS. A probe's admission and the code beside it stay on the native side; the page is handed a ticket
 * and nothing else, and only the ticket reaches the redeem. One ticket is live at a time. It is 16 random bytes, bound
 * to the page that was offered it, taken once, and dead after five minutes, which is the life of a code at its server.
 *
 * An admission is a lease on a key the probe had to install to dial at all (`pairing.ts`, `PairAdmission`). So every
 * end of a ticket that is not its take gives the lease back and lets go of the code: a dismiss, a new offer, the page
 * ending, the five minutes passing, a take from another page.
 */
import type { PairAdmission } from "../net/pairing";
import { TICKET_SHAPE } from "./door-kinds";

/** How long an offered pairing may wait for its press. */
export const TICKET_LIFE_MS = 5 * 60_000;

export interface DoorTicketsDeps {
  /** 16 bytes from the platform's own generator, as lowercase hex. */
  readonly mint: () => string;
  readonly now: () => number;
  /** The epoch of the page that is open now; empty with none. */
  readonly epoch: () => string;
  /** Gives back what the probe installed (`pairing.ts`, `discardAdmission`). */
  readonly discard: (admission: PairAdmission) => void;
  /** Runs `fn` once after `ms`; answers its cancel. */
  readonly later: (fn: () => void, ms: number) => () => void;
}

/** What a taken ticket hands the redeem: the admission the person was shown, and the code that waited beside it. */
export interface Taken {
  readonly admission: PairAdmission;
  readonly token: string;
}

interface Held extends Taken {
  readonly ticket: string;
  readonly epoch: string;
  readonly at: number;
  readonly stopClock: () => void;
}

export class DoorTickets {
  private live: Held | null = null;

  constructor(private readonly deps: DoorTicketsDeps) {}

  /** Holds a probed pairing for one press. The offer before it, if any, ends here. */
  offer(admission: PairAdmission, token: string): string {
    this.end();
    let ticket: string;
    try {
      ticket = this.deps.mint();
    } catch (failed) {
      this.deps.discard(admission);
      throw failed;
    }
    if (!TICKET_SHAPE.test(ticket)) {
      this.deps.discard(admission);
      throw new Error("door-tickets: the generator did not give 16 bytes as hex");
    }
    const stopClock = this.deps.later(() => this.drop(ticket), TICKET_LIFE_MS);
    this.live = { ticket, epoch: this.deps.epoch(), admission, token, at: this.deps.now(), stopClock };
    return ticket;
  }

  /**
   * The press: the live ticket, once, from the page it was offered to, inside its five minutes. Anything else takes
   * nothing. A live ticket asked for too late or from another page ends; a ticket that is not the live one ends nothing.
   */
  take(ticket: string): Taken | null {
    const held = this.live;
    if (held === null || held.ticket !== ticket) return null;
    const epoch = this.deps.epoch();
    if (epoch === "" || held.epoch !== epoch || this.deps.now() - held.at > TICKET_LIFE_MS) {
      this.end();
      return null;
    }
    this.live = null;
    held.stopClock();
    return { admission: held.admission, token: held.token };
  }

  /** The confirmation was left without its press. */
  drop(ticket: string): void {
    if (this.live !== null && this.live.ticket === ticket) this.end();
  }

  /** The page ended, or the door closed. */
  dropAll(): void {
    this.end();
  }

  private end(): void {
    const held = this.live;
    if (held === null) return;
    this.live = null;
    held.stopClock();
    this.deps.discard(held.admission);
  }
}
