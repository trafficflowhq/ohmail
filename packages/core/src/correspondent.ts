import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  accountSettings, autoReplyByUsWhere, folderState, mailboxFolders, mailboxes, messageBodies,
  messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { parseMessageIds } from "./threading.js";
import { SENT_SHAPED_PATHS } from "./types.js";

/**
 * HAS THIS ACCOUNT WRITTEN TO THEM — the one predicate. A correspondent is never first contact:
 * the Screener holds nobody this account wrote to, and nothing files them as spam on the model's
 * word. Evidence is a copy in the mailbox's own Sent-shaped folder — the server's answer, never
 * the `From` header a stranger writes — addressed to them (`wrote`), or named by their mail's
 * In-Reply-To/References (`replied`). An automatic reply is not writing. Only writing AFTER the
 * consent point counts — the later of the mailbox's connect and the sent-mail seed's answer:
 * history before it is the seed's question, answered by the person, and stays theirs.
 */
export interface CorrespondentEvidence {
  /** When this account wrote — the Sent copy's own arrival, else its date. */
  sentAt: Date;
  via: "wrote" | "replied";
}

/** Sent copies one `wrote` read may examine. The newest win, and they are what the answer needs. */
export const CORRESPONDENT_SCAN_ROWS = 1000;

/** Held senders whose representative's reference headers one `"held"` read may examine. */
export const CORRESPONDENT_HELD_ROWS = 500;

/**
 * The evidence for each of `senders` (lower-cased keys), absent for a stranger. `references` are
 * the message ids each sender's own mail names, as `threadKeyOf` parses them. `arms: "reply"`
 * asks only the indexed reply arm — the ingest's form, where the `wrote` arm is already carried
 * by `contacts`, taught when the Sent copy is ingested.
 */
export async function correspondentsAmong(db: Tx, args: {
  accountId: string;
  senders: readonly string[];
  /** Each sender's referenced ids, or `"held"`: read them off the mail the gate holds from them. */
  references?: ReadonlyMap<string, readonly string[]> | "held";
  arms?: "reply" | "all";
}): Promise<Map<string, CorrespondentEvidence>> {
  const out = new Map<string, CorrespondentEvidence>();
  const senders = [...new Set(args.senders.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (senders.length === 0) return out;
  const d = dialect(db);
  const references = args.references === "held"
    ? await heldReferences(db, args.accountId, senders)
    : args.references;

  const refsBySender = new Map<string, string[]>();
  for (const s of senders) {
    const refs = references?.get(s) ?? [];
    if (refs.length > 0) refsBySender.set(s, [...refs]);
  }
  const allRefs = [...new Set([...refsBySender.values()].flat())];
  const replyOnly = (args.arms ?? "all") === "reply";
  if (replyOnly && allRefs.length === 0) return out;

  const scope = await ownWritingScope(db, args.accountId);
  if (scope === null) return out;
  const { ownWriting, arrival } = scope;
  const keep = (sender: string, ev: CorrespondentEvidence): void => {
    const held = out.get(sender);
    if (!held || ev.sentAt > held.sentAt) out.set(sender, ev);
  };

  if (allRefs.length > 0) {
    const replied = await db.select({
      header: messages.messageIdHeader, arrivedAt: messages.arrivedAt, date: messages.date,
      createdAt: messages.createdAt,
    }).from(messages)
      .innerJoin(messageInstances, eq(messageInstances.messageId, messages.id))
      .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
      .leftJoin(accountSettings, eq(accountSettings.accountId, messages.accountId))
      .where(and(inArray(messages.messageIdHeader, allRefs), ...ownWriting));
    const byHeader = new Map<string, Date>();
    for (const r of replied) {
      if (!r.header) continue;
      const at = sentAtOf(r);
      const prev = byHeader.get(r.header);
      if (!prev || at > prev) byHeader.set(r.header, at);
    }
    for (const [s, refs] of refsBySender) {
      for (const ref of refs) {
        const at = byHeader.get(ref);
        if (at) keep(s, { sentAt: at, via: "replied" });
      }
    }
  }
  if (replyOnly) return out;

  const to = d.jsonArrayElements(messages.toAddresses, "co_to");
  const cc = d.jsonArrayElements(messages.ccAddresses, "co_cc");
  const wanted = sql`(${sql.join(senders.map((s) => sql`${s}`), sql`, `)})`;
  const wrote = await db.select({
    to: messages.toAddresses, cc: messages.ccAddresses, arrivedAt: messages.arrivedAt,
    date: messages.date, createdAt: messages.createdAt,
  }).from(messages)
    .innerJoin(messageInstances, eq(messageInstances.messageId, messages.id))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .leftJoin(accountSettings, eq(accountSettings.accountId, messages.accountId))
    .where(and(...ownWriting, sql`(
      exists (select 1 from ${to.from} where lower(${to.value}->>'address') in ${wanted})
      or exists (select 1 from ${cc.from} where lower(${cc.value}->>'address') in ${wanted})
    )`))
    .orderBy(desc(arrival))
    .limit(CORRESPONDENT_SCAN_ROWS);
  const asked = new Set(senders);
  for (const r of wrote) {
    const at = sentAtOf(r);
    for (const a of [...addressesOf(r.to), ...addressesOf(r.cc)]) {
      if (asked.has(a)) keep(a, { sentAt: at, via: "wrote" });
    }
  }
  return out;
}

/**
 * Everyone this account wrote to since its consent point, with when it last did — the `wrote`
 * arm with no sender asked about, for the retro that teaches `contacts` what Sent copies ingested
 * before the ingest taught them already say. The newest {@link CORRESPONDENT_SCAN_ROWS} copies.
 */
export async function recipientsOfOwnWriting(db: Tx, accountId: string): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const scope = await ownWritingScope(db, accountId);
  if (scope === null) return out;
  const rows = await db.select({
    to: messages.toAddresses, cc: messages.ccAddresses, arrivedAt: messages.arrivedAt,
    date: messages.date, createdAt: messages.createdAt,
  }).from(messages)
    .innerJoin(messageInstances, eq(messageInstances.messageId, messages.id))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .leftJoin(accountSettings, eq(accountSettings.accountId, messages.accountId))
    .where(and(...scope.ownWriting))
    .orderBy(desc(scope.arrival))
    .limit(CORRESPONDENT_SCAN_ROWS);
  for (const r of rows) {
    const at = sentAtOf(r);
    for (const a of [...addressesOf(r.to), ...addressesOf(r.cc)]) {
      const held = out.get(a);
      if (!held || at > held) out.set(a, at);
    }
  }
  return out;
}

/**
 * THE ACCOUNT'S OWN WRITING, as predicates over `messages ⋈ message_instances ⋈ mailboxes ⟕
 * account_settings`: an instance in a Sent-shaped folder, arrived after the consent point, not
 * an automatic reply. `null` when no mailbox holds a Sent-shaped folder — nothing can count. The
 * folders are read first and spelled exactly, so the instance read is the unique index.
 */
async function ownWritingScope(db: Tx, accountId: string): Promise<{ ownWriting: SQL[]; arrival: SQL } | null> {
  const d = dialect(db);
  const sentFolders = await db.select({ mailboxId: mailboxFolders.mailboxId, folder: mailboxFolders.folder })
    .from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .where(and(
      eq(mailboxes.accountId, accountId),
      inArray(sql`lower(${mailboxFolders.folder})`, [...SENT_SHAPED_PATHS]),
    ));
  if (sentFolders.length === 0) return null;
  const inSent = or(...sentFolders.map((f) => and(
    eq(messageInstances.mailboxId, f.mailboxId), eq(messageInstances.folder, f.folder),
  )))!;
  const arrival = sql`coalesce(${messages.arrivedAt}, ${messages.date}, ${messages.createdAt})`;
  return {
    arrival,
    ownWriting: [
      eq(messages.accountId, accountId),
      inSent,
      sql`${arrival} > ${d.greatest(mailboxes.createdAt,
        sql`coalesce(${accountSettings.seedConfirmedAt}, ${mailboxes.createdAt})`)}`,
      sql`not ${autoReplyByUsWhere(d, {
        accountId: messages.accountId as unknown as SQL,
        id: messages.id as unknown as SQL,
        fromAddress: messages.fromAddress as unknown as SQL,
        messageIdHeader: messages.messageIdHeader as unknown as SQL,
      })}`,
    ],
  };
}

const sentAtOf = (r: { arrivedAt: Date | null; date: Date | null; createdAt: Date }): Date =>
  r.arrivedAt ?? r.date ?? r.createdAt;

/**
 * The message ids each sender's representative held message — the newest, the one the Screener
 * shows and prices — names in In-Reply-To/References: the reply arm's question for a pass with no
 * arriving message in hand. One row per sender by the Screener's own window, never a whole bag.
 */
async function heldReferences(
  db: Tx, accountId: string, senders: readonly string[],
): Promise<Map<string, string[]>> {
  const d = dialect(db);
  const sender = sql`lower(${messages.fromAddress})`;
  const reps = db.select({
    from: messages.fromAddress,
    // Aliased: the device store returns rows positionally and refuses two same-named columns.
    inReplyTo: sql<unknown>`${d.jsonGet(messageBodies.headers, "in-reply-to")}`.as("co_in_reply_to"),
    references: sql<unknown>`${d.jsonGet(messageBodies.headers, "references")}`.as("co_references"),
    rank: sql<number>`row_number() over (
      partition by ${sender} order by coalesce(${messages.date}, ${d.ts(new Date(0))}) desc, ${messages.id} desc
    )`.as("rank"),
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(
      eq(messages.accountId, accountId),
      eq(folderState.desiredFolder, "ohmail/Screener"),
      inArray(sender, [...senders]),
    ))
    .as("co_reps");
  const rows = await db.select({ from: reps.from, inReplyTo: reps.inReplyTo, references: reps.references })
    .from(reps).where(eq(reps.rank, 1)).limit(CORRESPONDENT_HELD_ROWS);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.from.trim().toLowerCase();
    const ids = [...parseMessageIds(headerLines(r.inReplyTo)), ...parseMessageIds(headerLines(r.references))];
    if (ids.length > 0) out.set(key, [...(out.get(key) ?? []), ...ids]);
  }
  return out;
}

/** A stored header's values — a JSON array on the server, JSON text on the device store. */
function headerLines(value: unknown): string[] {
  const v = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The lower-cased addresses of one stored `EmailAddress[]` column, whatever store decoded it. */
function addressesOf(value: unknown): string[] {
  const list = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (e && typeof e === "object" ? (e as { address?: unknown }).address : undefined))
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim().toLowerCase());
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
