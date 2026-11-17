import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, organizerRequests, type Tx } from "@trafficflow/db";
import type { ServiceContext } from "@trafficflow/services/mail";
import {
  acksIn, deriveRequestKey,
  type AckRecord, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage, type MetaRecordsList,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "@ohmail/organizer/request-drain";
import { listedOf } from "../../../packages/organizer/test/_meta-list.js";

/**
 * A reader's settings press carried to the organizer through the production functions on both
 * sides: the service door, the reader's signed append, the organizer's drain, the reader's
 * settlement. Two stores, one folder. The organizer store is the caller's, so a pg twin can
 * hand in the lane database while the reader stays on PGlite.
 */

export type EventLog = Array<{ event: string; detail: Record<string, unknown> }>;

export interface RoundTrip {
  /** What the reader's door answered, or the error it threw. */
  answer: unknown;
  drain: Awaited<ReturnType<typeof applyMetaRequests>> | null;
  ack: AckRecord | null;
  /** The reader's own request row after it settled, or `null` when nothing was queued. */
  readerRow: { state: string; refusedReason: string | null; payload: unknown } | null;
  events: EventLog;
  readerCtx: ServiceContext;
}

function sharedMeta(): { store: Map<number, string>; reader: RequestReaderIo; organizer: RequestOrganizerIo } {
  const store = new Map<number, string>();
  let nextUid = 1;
  const list = async (): Promise<MetaRecordsList> =>
    listedOf([...store.entries()].map(([ref, raw]) => ({ ref, raw })));
  return {
    store,
    reader: { listMetaRecords: list, async append(raw: string) { store.set(nextUid++, raw); } },
    organizer: {
      listMetaRecords: list,
      async ack(raw: string) { store.set(nextUid++, raw); },
      async remove(refs: readonly unknown[]) {
        for (const r of refs) if (typeof r === "number") store.delete(r);
      },
    },
  };
}

const ADDRESS = "shared@round-trip.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "the-shared-password" }, address: ADDRESS })!;
const READER = { installId: "reader-install", kind: "local" as const };
const at = (base: Date, s: number): Date => new Date(base.getTime() + s * 1000);

export async function profileRoundTrip(opts: {
  organizerDb: Tx;
  accountId: string;
  now: Date;
  /** The reader's press, through the real door. */
  press: (ctx: ServiceContext, mailboxId: string) => Promise<unknown>;
}): Promise<RoundTrip> {
  const { organizerDb, accountId, now } = opts;
  const reader = await makeTestDb();
  const [mb] = await reader.insert(mailboxes).values({
    accountId, provider: "imap", address: ADDRESS,
    organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,profile",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).returning({ id: mailboxes.id });
  const mailboxId = mb!.id;
  await organizerDb.insert(mailboxes).values({
    id: mailboxId, accountId, provider: "imap", address: ADDRESS, organizerRole: "organizer",
  });

  const readerCtx: ServiceContext = {
    db: reader as unknown as ServiceContext["db"], accountId, userId: null, now: () => now, requestId: "r",
  };
  const events: EventLog = [];
  const log = (event: string, detail: Record<string, unknown>): void => { events.push({ event, detail }); };

  const readRow = async (): Promise<RoundTrip["readerRow"]> => {
    const [row] = await reader.select({
      state: organizerRequests.state, refusedReason: organizerRequests.refusedReason,
      payload: organizerRequests.payload,
    }).from(organizerRequests).where(eq(organizerRequests.mailboxId, mailboxId));
    return row ?? null;
  };
  let answer: unknown;
  try {
    answer = await opts.press(readerCtx, mailboxId);
  } catch (err) {
    return { answer: err, drain: null, ack: null, readerRow: await readRow(), events, readerCtx };
  }

  const meta = sharedMeta();
  const readerRt = {
    mailboxId, accountId, installId: READER.installId,
    adapter: { requestReaderIo: () => meta.reader } as unknown as MailboxAdapter, requestKey: KEY,
  };
  await driveOutstandingRequests(reader as unknown as Tx, readerRt, READER, at(now, 1), log);
  const drain = await applyMetaRequests(organizerDb, {
    mailboxId, accountId, installId: "organizer-install",
    adapter: { requestOrganizerIo: () => meta.organizer } as unknown as MailboxAdapter, requestKey: KEY,
  }, at(now, 2), log);
  const records = [...meta.store.entries()].map(([ref, raw]) => ({ ref, raw }));
  const ack = acksIn(records, KEY)[0] ?? null;
  await driveOutstandingRequests(reader as unknown as Tx, readerRt, READER, at(now, 3), log);

  return { answer, drain, ack, readerRow: await readRow(), events, readerCtx };
}
