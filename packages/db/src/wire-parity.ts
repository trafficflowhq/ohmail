/**
 * FOUR OF THIS PACKAGE'S CLOSED SETS ARE SPELLED AGAIN ON THE WIRE (`@ohmail/wire`,
 * `mailbox-states.ts`), because a mailbox's row travels to clients and the wire's package imports
 * nothing. The lists here stay the one place each member is explained and stored; these lines
 * hold the two spellings equal, so a member added to a list or to a union alone does not compile.
 * Types only: nothing here runs.
 */
import type {
  Assert, Same,
  MailboxDisabledReason as WireMailboxDisabledReason,
  MailboxErrorCode as WireMailboxErrorCode,
  MailboxSyncBlockReason as WireMailboxSyncBlockReason,
  OrganizerKind as WireOrganizerKind,
} from "@ohmail/wire";
import type { MailboxDisabledReason, MailboxErrorCode, MailboxSyncBlockReason } from "./mailbox-errors.js";
import type { OrganizerKind } from "./organizer-role.js";

export type WireParity = [
  Assert<Same<MailboxErrorCode, WireMailboxErrorCode>>,
  Assert<Same<MailboxDisabledReason, WireMailboxDisabledReason>>,
  Assert<Same<MailboxSyncBlockReason, WireMailboxSyncBlockReason>>,
  Assert<Same<OrganizerKind, WireOrganizerKind>>,
];
