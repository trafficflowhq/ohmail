import {
  MAILBOX_DISABLED_REASONS, isMailboxDisabledReason,
  MAILBOX_SYNC_BLOCK_REASONS, isMailboxSyncBlockReason,
} from "./mailbox-errors.js";
import {
  ORGANIZER_ROLES, isOrganizerRole, ORGANIZER_KINDS, isOrganizerKind,
  ORGANIZER_STATES, isOrganizerState, ORGANIZER_INTENTS, isOrganizerIntent,
  type OrganizerKind,
} from "./organizer-role.js";

/**
 * THE CLOSED SETS THE TWO STORES CARRY, AND WHICH OF THEM MAY BE A CHECK ON A DEVICE.
 *
 * A CHECK is part of the table definition in SQLite: there is no `ALTER … DROP CONSTRAINT`. So a
 * set the server widens by DROP-then-ADD — three of the five below have been widened already —
 * cannot be widened on a device by a migration step at all, only by a full table rebuild
 * (`mailboxes` is fifty columns). The day 0.18 ships the device store, the baseline freezes and
 * that rebuild is the only route left.
 *
 * The rule, from that: a WIDENABLE set carries no CHECK on the device store. Its members are
 * refused at the write door instead — the same validator on both dialects, which is where a value
 * derived from a string was reaching the column unchecked anyway. An IMMUTABLE set keeps its
 * CHECK on both, named here with the reason it cannot grow.
 *
 * `closed-set-parity.test.ts` enumerates this table against the pg journal's own history, the two
 * schema twins and the device baseline, and it is what replaces the `.noop` files' argument.
 */

/**
 * WIDENABLE means MEASURED widenable: the pg journal added this constraint in more than one
 * migration, i.e. dropped it and added it back with another member. IMMUTABLE means it was added
 * once and cannot grow without the product changing — `why` says which invariant closes it.
 */
export type ClosedSetClass = "widenable" | "immutable";

export interface ClosedSet {
  /** The constraint's name on the server, which is the key everything else is read by. */
  readonly constraint: string;
  readonly table: string;
  readonly column: string;
  /** Whether NULL is a value the column may hold — every set here but one admits it. */
  readonly nullable: boolean;
  /** The members, from the ONE constant that defines them; never a second copy. */
  readonly members: readonly string[];
  /** The write-door validator for those members, from the same module as the constant. */
  readonly isMember: (v: unknown) => boolean;
  readonly kind: ClosedSetClass;
  readonly why: string;
}

export const CLOSED_SETS: readonly ClosedSet[] = [
  {
    constraint: "mailboxes_disabled_reason_closed",
    table: "mailboxes", column: "disabled_reason", nullable: true,
    members: MAILBOX_DISABLED_REASONS, isMember: isMailboxDisabledReason,
    kind: "widenable",
    why: "tracks ORGANIZER_KINDS as a suffix, so it widens whenever that does — mail 0027 opened "
      + "it and mail 0103 widened it for 'mobile'.",
  },
  {
    constraint: "mailboxes_sync_blocked_reason_closed",
    table: "mailboxes", column: "sync_blocked_reason", nullable: true,
    members: MAILBOX_SYNC_BLOCK_REASONS, isMember: isMailboxSyncBlockReason,
    kind: "widenable",
    why: "one member per refusal branch in the worker's sync loop, so a new branch widens it — "
      + "mail 0029 opened it and mail 0102 widened it for 'read_limited'.",
  },
  {
    constraint: "mailboxes_organized_by_kind_closed",
    table: "mailboxes", column: "organized_by_kind", nullable: true,
    members: ORGANIZER_KINDS, isMember: isOrganizerKind,
    kind: "widenable",
    why: "one member per kind of install that can organize a mailbox — mail 0083 opened it and "
      + "mail 0103 widened it for 'mobile', the standalone phone.",
  },
  {
    constraint: "mailboxes_takeover_intent_closed",
    table: "mailboxes", column: "takeover_intent", nullable: false,
    members: ORGANIZER_INTENTS, isMember: isOrganizerIntent,
    kind: "immutable",
    why: "the verb behind the takeover stamp, and there are two of them: a press either joins a "
      + "free mailbox or takes a live holder's. A third verb would not widen this set; it would "
      + "be a different decision at the fence. NOT NULL, so it has no null arm.",
  },
  {
    constraint: "mailboxes_organizer_role_closed",
    table: "mailboxes", column: "organizer_role", nullable: false,
    members: ORGANIZER_ROLES, isMember: isOrganizerRole,
    kind: "immutable",
    why: "the two halves of one invariant — exactly one active organizer per mailbox, and the "
      + "loser is a reader. A third member would not widen this set; it would be a different "
      + "product. NOT NULL, so it has no null arm.",
  },
  {
    constraint: "mailboxes_organizer_state_closed",
    table: "mailboxes", column: "organizer_state", nullable: true,
    members: ORGANIZER_STATES, isMember: isOrganizerState,
    kind: "immutable",
    why: "the lease's occupancy as a reader cycle last saw it, and a lease is held or it is not. "
      + "NULL is the third answer — 'we have not looked' — so a new state would be a new reading "
      + "of the lease rather than a member.",
  },
];

/** The set a constraint name identifies; an unknown name is a bug, never a default. */
export function closedSet(constraint: string): ClosedSet {
  const found = CLOSED_SETS.find((s) => s.constraint === constraint);
  if (found === undefined) {
    throw new Error(
      `${constraint} is not a closed set this table knows. A CHECK over an enumeration belongs `
      + "here with its class, or the device store's rule says nothing about it.",
    );
  }
  return found;
}

/** What a write door throws for a value the set does not hold. Named, so a log can say which. */
export class ClosedSetViolation extends Error {
  readonly code = "closed_set_violation";
  constructor(readonly set: ClosedSet, readonly value: unknown) {
    super(
      `${set.table}.${set.column} holds a closed set and ${JSON.stringify(value)} is not a member`,
    );
    this.name = "ClosedSetViolation";
  }
}

/**
 * THE WRITE DOOR, for the columns whose store may not refuse for them.
 *
 * On the server the CHECK answers 23514 for a foreign value; on a device a widenable column has no
 * CHECK, so this is the refusal. Every writer of such a column that does not hand it a value of
 * the column's own literal type passes through here.
 */
export function closedSetValue(constraint: string, value: unknown): string | null {
  const set = closedSet(constraint);
  if (value === null || value === undefined) {
    if (set.nullable) return null;
    throw new ClosedSetViolation(set, value);
  }
  if (!set.isMember(value)) throw new ClosedSetViolation(set, value);
  return value as string;
}

/**
 * `mailboxes.organized_by_kind`, at its three derived write sites.
 *
 * Two of them cut the kind out of a stand-down reason (`organized_elsewhere:<kind>`) — one with a
 * cast and one with nothing — and the column's CHECK was the only thing standing behind either. It
 * coerces rather than refuses, on the read side's own rule: a peer this build cannot rank IS
 * `unknown`, and every reader downstream fails closed on that word.
 */
export function organizerKindColumn(raw: unknown): OrganizerKind {
  return isOrganizerKind(raw) ? raw : "unknown";
}
