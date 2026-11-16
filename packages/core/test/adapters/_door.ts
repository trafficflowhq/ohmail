import type { WriteDoor } from "../../src/adapters/imap-types.js";

/**
 * The door a FIXTURE hands the adapter: a test mailbox is held by its test by construction, so
 * every write is admitted. Tests only — production doors come from the writer's lease
 * (`packages/organizer/src/lease.ts#writeDoorOf`), and the write-door tests drive the refusing arms.
 */
export const FIXTURE_DOOR: WriteDoor = { ask: () => ({ admit: true }) };
