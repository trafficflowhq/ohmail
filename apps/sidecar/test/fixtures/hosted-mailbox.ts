import type { MailboxDTO } from "@trafficflow/services/mail";

/**
 * A HOSTED `GET /mailboxes` ANSWER, for every fake Cloud API in this suite.
 *
 * The Cloud mirror refreshes the account's mailboxes at the start of every pull and refuses to
 * drain without them (`cloud-mirror.ts`), so a fake that does not serve this route serves an
 * offline account. It lives here rather than in one test file because five of them need it and a
 * second copy is a second shape to drift.
 *
 * The two stamps are DELIBERATELY NON-NULL in the default. `lastSyncAt` and
 * `initialImportCompletedAt` are the hosted account's own progress and the mirror must not copy
 * either — a copied import stamp would resolve the local body walk as finished before it had
 * fetched a body, and every message would open blank. Carrying them here is what lets a test watch
 * that happen if the mirror ever starts copying them.
 */
export function hostedMailbox(id: string, address: string, over: Partial<MailboxDTO> = {}): MailboxDTO {
  return {
    id,
    provider: "imap",
    address,
    displayName: null,
    status: "connected",
    authKind: "password",
    lastSyncAt: "2026-01-01T00:11:00.000Z",
    errorCode: null,
    errorDetail: null,
    failedAt: null,
    retryCount: 0,
    syncBlockedReason: null,
    syncBlockedSince: null,
    disabledReason: null,
    initialImportCompletedAt: "2026-01-01T00:11:00.000Z",
    pendingMoves: 0,
    /* THE SAME ROWS SPLIT BY WHAT DECIDES THEM, and `due + deferred` IS `pendingMoves` — so
     * these two are zero here because the count above is. A default that disagreed with itself
     * would hand every fake Cloud API a mailbox no deployment can produce.
     *
     * `asOf` is the read's own instant and the DTO requires it, so it carries the stamp the rest
     * of this default reads at. `lastCycleAt` stays null on `organizeConsentedAt`'s rule: a value
     * here would change what these tests exercise, and a test that needs a turn passes one
     * through `over`. */
    filing: {
      due: 0,
      deferred: 0,
      oldestPendingAt: null,
      nextAttemptAt: null,
      attempts: 0,
      lastRefusalClass: null,
      stuck: 0,
      stuckSince: null,
      stuckRefusalClass: null,
      asOf: "2026-01-01T00:11:00.000Z",
      lastCycleAt: null,
    },
    /* A hosted organizer that is fetching; a test about one that is behind passes it through `over`. */
    fetching: { behind: false, since: null },
    /* ── THE ORGANIZER BLOCK, WRITTEN OUT ────────────────────────────────────────────────
     *
     * A HOSTED mailbox is organized by the deployment answering `GET /mailboxes`, so the role
     * is `organizer` and `organizedBy` names nobody — `null` as a whole, which is what the DTO
     * says for "this install does". `organizerState` is null for every organizer's row always.
     *
     * `organizeConsentedAt` is deliberately NULL rather than a stamp. `cloud-mirror.ts` copies
     * it into the local row, where `mayOrganize` reads it on a door switch, so a stamp here
     * would change what these tests exercise. A test that needs a consented hosted mailbox
     * passes one through `over`, which is what that parameter is for. */
    organizerRole: "organizer",
    organizedBy: null,
    organizerState: null,
    organizedByThisInstall: true,
    organizeConsentedAt: null,
    organizerEventAt: null,
    organizerEventSeenAt: null,
    /* `false` is what the mirror reads from an absent key (`=== true`), and it is also the
     * honest answer for an organizer row: the question does not arise. */
    organizerAcceptsRequests: false,
    organizerReleasedAt: null,
    releaseRequestedAt: null,
    releaseRefusal: null,
    takeoverAuthorizedAt: null,
    organizerParkedAt: null,
    inboundQuietSince: null,
    inboundQuietDismissedAt: null,
    smtpMaxSizeBytes: null,
    folders: [],
    createdAt: "2026-01-01T00:04:00.000Z",
    ...over,
  };
}

/** The route's body: `{ items }`, exactly as `packages/api/src/routes/mailboxes.ts` answers it. */
export const mailboxList = (items: readonly MailboxDTO[]): { items: MailboxDTO[] } => ({ items: [...items] });
