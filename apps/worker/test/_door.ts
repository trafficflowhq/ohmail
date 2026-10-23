import { writeDoorOf, type LeasePermit, type MailboxWriteAuthority } from "../src/lease.js";

/**
 * THE ONE TEST-ONLY DOOR. A fixture mailbox is held by its test, so a fixture rides a permit that
 * is HELD — never re-read, never stood down — and both guards admit it as they admit a live claim.
 * `not_supplied` is refused at both, so a fixture that supplies nothing writes nothing. No `src/`
 * file imports this (`lease-not-supplied-census.test.ts`); the refusing arms are driven there and in
 * `lease-door-per-write.test.ts`.
 */
export const FIXTURE_LEASE: LeasePermit = {
  async check(): Promise<void> { /* held for the life of the test */ },
  names: {
    installId: "fixture", mailboxId: "fixture", uidValidity: null, nonce: null, mintedNonces: [],
    issuedAt: new Date(0),
  },
  verifiedAt: new Date(0), reads: 1, probes: 0, writesSinceRead: 0, revoked: false,
  standing: () => "held",
};

/** {@link FIXTURE_LEASE} as a pass's whole authority, for the passes that take one. */
export const FIXTURE_AUTHORITY: MailboxWriteAuthority = { lease: FIXTURE_LEASE };

/** The door a fixture hands the adapter, built by the one door function the organizers use. */
export const FIXTURE_DOOR = writeDoorOf(FIXTURE_AUTHORITY);
