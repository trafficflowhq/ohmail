/**
 * ONE MANAGER PER PAIRING SLOT, FOR THE WHOLE JS PROCESS. Two managers over one slot hold the same
 * refresh token, and presenting a token the other already spent is the reuse signal: the server
 * ends the pairing. An Android activity recreate rebuilds the React tree inside the same runtime
 * while a rotation can be in flight, so a manager per session is two holders. A slot's manager is
 * built once, from its row as read at the first ask, or from a redeem's fresh pair; every later
 * ask gets that instance in whatever state it is in. `test/bearer-construction-census.test.ts`
 * refuses a `BearerManagerRN` constructed anywhere else.
 */
import { BearerManagerRN, type FetchLike, type RefreshVault, type SessionDeath } from "./bearer";
import { noteSessionDeath } from "./session-death";

/** A stored row, as a slot's manager is built from it. No access token: a cold manager has none. */
export interface SlotRow {
  origin: string;
  refreshToken: string | null;
  /** `ServerProfile.refreshAttempt` — the attempt a killed rotation left unanswered. */
  refreshAttempt: string | null;
  /** The account an erased answer must name. `null`: never this manager's to act on. */
  accountId: string | null;
  vault: RefreshVault;
  fetchImpl?: FetchLike;
}

/** A pair a redeem just minted: a new family for the slot, owing no attempt. */
export interface SlotRedeem {
  origin: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  vault: RefreshVault;
  fetchImpl?: FetchLike;
}

interface Slot {
  manager: BearerManagerRN;
  /** How the slot's manager died, heard whoever else listens; `null` while it lives. */
  death: SessionDeath | null;
}

export class BearerRegistry {
  private readonly slots = new Map<string, Slot>();
  /** Writes the one log line per death; the app's is `noteSessionDeath`. */
  private readonly note: (why: SessionDeath) => void;

  constructor(note: (why: SessionDeath) => void = (why) => noteSessionDeath(why)) {
    this.note = note;
  }

  /** The slot's manager: built on the first ask from `row()`, the held one on every later ask. */
  managerFor(profileId: string, row: () => SlotRow): BearerManagerRN {
    const held = this.slots.get(profileId);
    if (held !== undefined) return held.manager;
    return this.hold(profileId, new BearerManagerRN({ ...row(), accessToken: null }));
  }

  /**
   * A redeem minted a new family for this slot (a re-pair keeps the row id): the held manager,
   * dead or alive, is replaced. It keeps only its own family's token, which nothing else holds,
   * and the store refuses its writes over the new one. The one caller is `pairWithServer`.
   */
  adoptRedeem(profileId: string, redeem: SlotRedeem): BearerManagerRN {
    return this.hold(profileId, new BearerManagerRN({ ...redeem, refreshAttempt: null }));
  }

  /**
   * How the slot's manager died in this process, or `null` — a read that builds nothing. A death
   * nobody was subscribed to (a launch's wake drain, a torn-down tree's last request) is still
   * answered here, so the next connect says it instead of reading a cleared row.
   */
  deathOf(profileId: string): SessionDeath | null {
    return this.slots.get(profileId)?.death ?? null;
  }

  /** The pairing is forgotten: nobody holds this slot any more. */
  evict(profileId: string): void {
    this.slots.delete(profileId);
  }

  /** Hold `manager` as the slot's, hearing its death first. A replaced manager's death is not the slot's. */
  private hold(profileId: string, manager: BearerManagerRN): BearerManagerRN {
    const slot: Slot = { manager, death: null };
    this.slots.set(profileId, slot);
    manager.onSessionDead((why) => {
      if (this.slots.get(profileId) !== slot) return;
      slot.death = why;
      this.note(why);
    });
    return manager;
  }
}

/** The process's registry. `PairingEnv.bearers` overrides it in tests. */
export const bearers = new BearerRegistry();
