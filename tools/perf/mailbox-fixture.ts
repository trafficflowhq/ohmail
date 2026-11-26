import { randomUUID } from "node:crypto";
import { drizzle, type Sql, type TransactionSql } from "./mailbox-postgres.js";
import {
  accounts,
  accountSettings,
  calCalendars,
  calConnections,
  calEvents,
  calSettings,
  mailboxes,
  refreshTokens,
  sessions,
  users,
} from "@trafficflow/db";
import { generateToken, hashToken, syncService, type AuthConfig } from "@trafficflow/services";

export const MAILBOX_SIZES = [1_000, 10_000, 50_000, 200_000, 400_000, 1_000_000] as const;
const MAX_BASELINE_ROWS = MAILBOX_SIZES.at(-1)!;
const BATCH_ROWS = 10_000;
const FILE_STRIDE = 10;
const SECOND_FILE_STRIDE = 50;
const domain = "fixture.invalid";
const email = ["benchmark", domain].join("@");
const accountId = "63148c89-11b0-4eba-aeee-1b1222880001";
const mailboxId = "63148c89-11b0-4eba-aeee-1b1222880002";
const userId = "63148c89-11b0-4eba-aeee-1b1222880003";
const connectionId = "63148c89-11b0-4eba-aeee-1b1222880004";
const calendarId = "63148c89-11b0-4eba-aeee-1b1222880005";

export interface MailboxCounts {
  rowCount: number;
  attachmentCount: number;
  attachmentFlags: number;
  messagesWithAttachments: number;
}

export function expectedAttachmentCounts(rows: number) {
  const messagesWithAttachments = Math.ceil(rows / FILE_STRIDE);
  return {
    messagesWithAttachments,
    attachmentCount: messagesWithAttachments + Math.ceil(rows / SECOND_FILE_STRIDE),
  };
}

export async function seedMailbox(raw: Sql, rows: number, now = new Date()) {
  const db = drizzle(raw);
  await db.transaction(async (tx) => {
    await tx
      .insert(accounts)
      .values({ id: accountId, name: "Benchmark", aiEnabled: false, aiAnsweredAt: now });
    await tx
      .insert(accountSettings)
      .values({ accountId, onboardingCompletedAt: now, screeningBaselineAt: now });
    await tx.insert(users).values({
      id: userId,
      accountId,
      email,
      displayName: "Benchmark",
      emailVerifiedAt: now,
    });
    await tx.insert(mailboxes).values({
      id: mailboxId,
      accountId,
      provider: "imap",
      address: email,
      displayName: "Benchmark",
      sentFolder: "Sent",
      trashFolder: "Trash",
      lastSyncAt: now,
      initialImportCompletedAt: now,
      organizeConsentedAt: now,
    });
    await tx.insert(calSettings).values({ accountId, enabledAt: now });
    await tx.insert(calConnections).values({
      id: connectionId,
      accountId,
      provider: "ics",
      label: "Fixture calendar",
      lastSyncedAt: now,
    });
    await tx.insert(calCalendars).values({
      id: calendarId,
      accountId,
      connectionId,
      providerId: "fixture",
      name: "Fixture",
      access: "reader",
    });
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const icalUtc = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(".000", "");
    await tx.insert(calEvents).values(
      ["Planning", "Workshop", "Review"].map((title, offset) => {
        const startsAt = new Date(day + (10 + 3 * offset) * 3_600_000);
        const endsAt = new Date(startsAt.getTime() + 3_600_000);
        return {
          accountId,
          calendarId,
          providerId: `event-${offset}`,
          uid: `event-${offset}`,
          title,
          startsAt,
          endsAt,
          startKind: "instant",
          endKind: "instant",
          startLocal: icalUtc(startsAt),
          endLocal: icalUtc(endsAt),
        };
      }),
    );
  });

  // Insert oldest first. A larger tier adds older history with the same IDs,
  // subjects and spacing. Timestamps are anchored to the host clock.
  for (let last = rows; last > 0; last -= BATCH_ROWS) {
    const count = Math.min(last, BATCH_ROWS);
    await insertMessages(raw, last - count + 1, count, now, rows);
  }
  await raw`analyze`;
}

export async function createFixtureSession(raw: Sql, config: AuthConfig, now = new Date()) {
  const sessionToken = generateToken();
  const refreshToken = generateToken();
  const familyId = randomUUID();
  const refreshExpiresAt = new Date(now.getTime() + config.refreshTtlMs);
  await drizzle(raw).transaction(async (tx) => {
    const [session] = await tx
      .insert(sessions)
      .values({
        accountId,
        userId,
        familyId,
        accessTokenHash: hashToken(sessionToken),
        accessExpiresAt: new Date(now.getTime() + config.accessTtlMs),
        refreshExpiresAt,
        lastSyncedAt: now,
      })
      .returning({ id: sessions.id });
    await tx.insert(refreshTokens).values({
      accountId,
      userId,
      familyId,
      sessionId: session!.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiresAt,
      createdAt: now,
    });
  });
  return { accountId, mailboxId, email, familyId, sessionToken, refreshToken };
}

// The set-based insert retains the product's foreign keys, generated fields, indexes
// and change-log cursor. Bodies and indexed words are present at every tier.
async function insertMessages(
  raw: Sql,
  firstOrdinal: number,
  count: number,
  now: Date,
  baselineRows?: number,
) {
  const arrivals = baselineRows === undefined;
  return raw.begin(async (tx): Promise<MailboxCounts> => {
    const [seq] = await tx<{ next_seq: string }[]>`
      insert into account_sync_state (account_id, next_seq) values (${accountId}, ${count})
      on conflict (account_id) do update set next_seq = account_sync_state.next_seq + excluded.next_seq
      returning next_seq
    `;
    const prior = BigInt(seq!.next_seq) - BigInt(count);
    const first = arrivals ? MAX_BASELINE_ROWS + Number(prior) + 1 : firstOrdinal;
    const last = first + count - 1;
    await tx`
      create temporary table perf_message_batch on commit drop as
      with ordinals as (
        select number,
          case when ${arrivals}::boolean or number <= 12 or number % 20 > 5 then number
               else number - number % 20 end as thread_number
        from generate_series(${first}::int, ${last}::int) as number
      )
      select
        number,
        md5('message-' || number)::uuid as message_id,
        md5('thread-' || thread_number)::uuid as thread_id,
        case when ${arrivals}::boolean then 'Harbor delivery ' || number
             when thread_number % 199 = 1 then 'Harbor fixture report ' || thread_number
             else (array['Weekly plan','Library notice','Project notes','Workshop confirmation',
                         'Team update','Travel details','Invoice','Service notice','Discussion',
                         'Delivery confirmation','Meeting notes','Monthly summary'])[1 + thread_number % 12]
                  || ' ' || thread_number end as subject,
        case when ${arrivals}::boolean or number <= 12 then 'INBOX'
             when thread_number % 10 = 7 then 'ohmail/News'
             when thread_number % 10 = 8 then 'ohmail/Receipts'
             when thread_number % 10 = 9 then 'Sent'
             else 'INBOX' end as folder,
        case when ${arrivals}::boolean then ${now.toISOString()}::timestamptz - (${last}::int - number) * interval '1 millisecond'
             else ${now.toISOString()}::timestamptz - number * interval '8 minutes' end as arrived,
        case when ${arrivals}::boolean then ${now.toISOString()}::timestamptz - (${last}::int - number) * interval '1 millisecond'
             else ${now.toISOString()}::timestamptz - thread_number * interval '8 minutes' end as thread_time,
        'person' || (thread_number % 251) || chr(64) || ${domain}::text as sender,
        'Fixture Person ' || (thread_number % 251) as sender_name,
        'This synthetic letter records the details of the correspondence. ' ||
          'The next meeting will cover the outstanding items and the dates for the next delivery. ' ||
          'Keep this note with the project records for future reference.' as body_text,
        case when ${arrivals}::boolean then ${prior.toString()}::bigint + number - ${first}::int + 1
             else ${baselineRows ?? 0}::bigint - number + 1 end as seq
      from ordinals
    `;
    await tx`
      insert into threads (id, account_id, subject, last_message_at, participants)
      select distinct on (thread_id) thread_id, ${accountId}, subject, thread_time,
        jsonb_build_array(jsonb_build_object('name', sender_name, 'address', sender))
      from perf_message_batch order by thread_id, number
      on conflict (id) do nothing
    `;
    const messages = await tx`
      insert into messages (id, account_id, mailbox_id, thread_id, body_hash, dedup_key, subject, from_address,
        from_name, native_locator, date, arrived_at, created_at, updated_at, unread,
        snippet, to_addresses, sender_check, sender_check_by)
      select message_id, ${accountId}, ${mailboxId}, thread_id, md5(body_text), 'fixture:' || number, subject,
        sender, sender_name, jsonb_build_object('folder', folder, 'ref', '1:' || number),
        arrived, arrived, arrived, arrived, ${arrivals}::boolean or number % 4 in (1, 2),
        left(body_text, 110), jsonb_build_array(jsonb_build_object('name', 'Benchmark', 'address', ${email}::text)),
        'none', 'ingest'
      from perf_message_batch order by seq
    `;
    await tx`
      insert into folder_state (message_id, account_id, desired_folder, observed_folder,
        last_set_by, reconcile_status, updated_at)
      select message_id, ${accountId}, folder, folder, 'external', 'reconciled', arrived
      from perf_message_batch
    `;
    await tx`
      insert into message_bodies (message_id, account_id, text, html)
      select message_id, ${accountId}, body_text, case when number % 3 = 0 then '<p>' || body_text || '</p>' end
      from perf_message_batch
    `;
    const metadata = await writeAttachmentMetadata(tx);
    const expected = expectedAttachmentCounts(count);
    if (
      messages.count !== count ||
      metadata.attachmentCount !== expected.attachmentCount ||
      metadata.attachmentFlags !== expected.attachmentCount ||
      metadata.messagesWithAttachments !== expected.messagesWithAttachments
    ) {
      throw new Error("inconsistent fixture message or attachment inserts");
    }
    await tx`
      insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select message_id, ${accountId}, to_tsvector('english', subject || ' ' || sender_name || ' ' || sender),
        to_tsvector('english', body_text), subject || ' ' || sender_name || ' ' || sender, 'text'
      from perf_message_batch
    `;
    await tx`
      insert into change_log (account_id, seq, entity_type, entity_id, op, created_at)
      select ${accountId}, seq, 'message', message_id, 'create', arrived from perf_message_batch order by seq
    `;
    if (arrivals) {
      await tx`select pg_notify('ohmail_change_log', ${`${accountId}:${seq!.next_seq}`})`;
      await tx`update mailboxes set last_sync_at = ${now.toISOString()} where id = ${mailboxId}`;
    }
    return { rowCount: messages.count, ...metadata };
  });
}

async function writeAttachmentMetadata(tx: TransactionSql) {
  const [result] = await tx<
    { attachment_count: number; attachment_flags: number; messages_with_attachments: number }[]
  >`
    with candidates as (
      select message_id, number, arrived,
        case when number % ${SECOND_FILE_STRIDE}::int = 1 then 2 else 1 end as file_count
      from perf_message_batch
      where number % ${FILE_STRIDE}::int = 1
    ), written as (
      insert into attachments (id, account_id, message_id, filename, content_type, size_bytes, part_id, created_at)
      select md5('attachment-' || number || '-' || part)::uuid, ${accountId}, message_id,
        'fixture-file-' || number || '-' || part || (array['.pdf', '.png', '.csv'])[type_index],
        (array['application/pdf', 'image/png', 'text/csv'])[type_index],
        4_096 + mod(number * 131 + part * 97, 2_097_152),
        (part + 1)::text, arrived
      from candidates
      cross join lateral generate_series(1, file_count) as part
      cross join lateral (select 1 + mod(number + part, 3) as type_index) kind
      on conflict (id) do nothing
      returning id
    ), flagged as (
      update messages as message
      set has_attachments = true, attachment_count = candidates.file_count
      from candidates
      where message.id = candidates.message_id
        and (not message.has_attachments or message.attachment_count <> candidates.file_count)
      returning attachment_count
    )
    select (select count(*)::int from written) as attachment_count,
      coalesce(sum(attachment_count), 0)::int as attachment_flags,
      count(*)::int as messages_with_attachments
    from flagged
  `;
  return {
    attachmentCount: result!.attachment_count,
    attachmentFlags: result!.attachment_flags,
    messagesWithAttachments: result!.messages_with_attachments,
  };
}

/** Upgrade fixtures prepared before the attachment metadata was seeded. */
export async function ensureAttachmentMetadata(raw: Sql) {
  await raw.begin(async (tx) => {
    await tx`
      create temporary table perf_message_batch on commit drop as
      select message.id as message_id, message.arrived_at as arrived, split_part(message.dedup_key, ':', 2)::int as number
      from messages as message
      where message.account_id = ${accountId} and message.mailbox_id = ${mailboxId}
        and message.dedup_key like 'fixture:%'
        and split_part(message.dedup_key, ':', 2)::int % ${FILE_STRIDE}::int = 1
    `;
    await writeAttachmentMetadata(tx);
  });
  await raw`analyze messages`;
  await raw`analyze attachments`;
}

async function mailboxCounts(raw: Sql): Promise<MailboxCounts> {
  const [row] = await raw<
    {
      row_count: number;
      attachment_count: number;
      attachment_flags: number;
      messages_with_attachments: number;
    }[]
  >`
    select count(*)::int as row_count, coalesce(sum(attachment_count), 0)::int as attachment_flags,
      count(*) filter (where has_attachments)::int as messages_with_attachments,
      (select count(*)::int from attachments where account_id = ${accountId}) as attachment_count
    from messages where account_id = ${accountId} and mailbox_id = ${mailboxId}
  `;
  return {
    rowCount: row!.row_count,
    attachmentCount: row!.attachment_count,
    attachmentFlags: row!.attachment_flags,
    messagesWithAttachments: row!.messages_with_attachments,
  };
}

export async function mailboxStatus(raw: Sql, counts?: MailboxCounts) {
  const measured = counts ?? (await mailboxCounts(raw));
  const [row] = await raw<
    {
      message_id: string;
      subject: string;
      last_sync_at: string;
      seq: string;
    }[]
  >`
    select msg.id as message_id, msg.subject, mb.last_sync_at,
      (select coalesce(max(seq), 0) from change_log where account_id = ${accountId}) as seq
    from mailboxes mb
    cross join lateral (
      select id, subject from messages
      where account_id = ${accountId} and deleted_at is null
      order by date desc nulls last, id desc limit 1
    ) msg
    where mb.id = ${mailboxId}
  `;
  if (!row) throw new Error("fixture mailbox is missing");
  return {
    ...measured,
    cursor: syncService.encodeCursor(BigInt(row.seq)),
    lastSyncAt: new Date(row.last_sync_at).toISOString(),
    newestMessageId: row.message_id,
    newestSubject: row.subject,
  };
}

export async function ageMailbox(raw: Sql, lastSyncAt: Date): Promise<void> {
  await raw`update mailboxes set last_sync_at = ${lastSyncAt.toISOString()} where id = ${mailboxId}`;
}

export async function arrive(raw: Sql, count: number) {
  return insertMessages(raw, 0, count, new Date());
}
