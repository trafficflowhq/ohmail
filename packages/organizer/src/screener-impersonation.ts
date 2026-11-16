import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  accountSettings, contacts, folderState, messageInstances, messages, rules,
  fencedAccountWrite, fileImpersonationLetters, impersonationReturnedSenders, AccountErasedError,
  resolveCutline, senderIsActiveSql, heldArrivedInsideSql, senderIsDecidedSql, heldSortKey,
  notGoneSql, readGoneMailboxIds, readListAddresses, readOwnAddresses, domainOf, ruleMatchKeySql,
  IMPERSONATION_FILING_IDS_MAX, SCREENER_FOLDER,
  type ResolvedCutline, type Tx,
} from "@trafficflow/db";
import { correspondentsAmong, sendersAnsweringOwnWriting } from "@trafficflow/core/adapters/drizzle-repo";
import {
  impersonationFiling, silentLogger, type ImpersonationKeep, type ImpersonationTies, type Logger,
} from "@trafficflow/core/mail";

/* THE HELD IMPERSONATION, FILED TO SPAM ON ITS OWN — for an account whose switch is on (the default),
 * the organizer files a held letter whose name claims a dictionary company it cannot be from, by the
 * one pure decision (`impersonationFiling`): no model, no spend, no rule, no contact, no learning
 * signal, never an unsubscribe, never a sender let in. Each letter is filed alone through
 * `fileImpersonationLetters`, listed under Filed automatically with its reason, and Put back returns
 * it for good and exempts its sender, as does any other way a filing comes back to the gate. A letter
 * with a code in it, a sender with any tie to the account, and a letter held for want of confirmation
 * stay where the person decides. A walk kept between runs passes the senders the rule keeps, so they
 * never fill the page for good. */

/** Senders one run files at most — the act's per-cycle bound. */
export const IMPERSONATION_SENDERS_PER_RUN = 50;
/** Held claim letters one run reads at most, in turns across its senders; at least one per sender. */
export const IMPERSONATION_LETTERS_PER_RUN = IMPERSONATION_FILING_IDS_MAX;

/**
 * Where a walk of the waiting senders stands between runs: one per account, kept by the caller
 * (process memory on the worker, engine state on a device), starting empty. Senders are walked by
 * their newest held arrival, so one who writes again comes up again.
 */
export interface ImpersonationWalk {
  /** The last sender examined: the next run resumes after it. */
  after?: { at: Date; address: string } | null;
  /** A sender of this lap failed, or was cut short at the read while filing: the next lap is owed at once. */
  again?: boolean;
  /** The mailboxes walked; another set starts the walk over. */
  over?: string;
}

/** The cutline's three answers off the settings row a caller already read (the engine's drain read). */
export interface ImpersonationCutlineSettings {
  screeningBaselineAt: Date | null;
  dormancyDays: number | null;
  screeningScope: string | null;
}

export interface ScreenerImpersonationDeps {
  /** Scope to ONE account — the caller loops its served accounts. */
  accountId: string;
  /** The mailboxes this install organizes: only their held letters are read. Empty ⇒ nothing runs. */
  mailboxIds: readonly string[];
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link IMPERSONATION_SENDERS_PER_RUN}. */
  sendersPerRun?: number;
  /** Test seam. Default {@link IMPERSONATION_LETTERS_PER_RUN}. */
  lettersPerRun?: number;
  /**
   * The switch and the cutline, as the caller already read them; absent ⇒ the pass reads the row.
   * `on: false` ⇒ nothing is read. A failed read reads as off.
   */
  settings?: { on: boolean } & ImpersonationCutlineSettings;
  /** Asked before each sender after the first; a stop loses nothing, a filed letter left the gate. */
  until?: () => boolean;
  /** Hears a sender's failure before it is swallowed (the worker's shard fault note). */
  noteFault?: (err: unknown) => void;
  /** The account's walk, advanced in place. Absent ⇒ every run starts at the top. */
  walk?: ImpersonationWalk;
}

export interface ScreenerImpersonationResult {
  /** False ⇒ the switch is off or unread, or this install organizes no mailbox of the account. */
  ran: boolean;
  /** Waiting senders with a held claim, examined. */
  examined: number;
  /** Letters filed to Spam by this run. */
  filed: number;
  /** Senders at least one letter of whom was filed. */
  senders: number;
  /** Letters left held, by reason. */
  kept: Partial<Record<ImpersonationKeep | "tied" | "elsewhere", number>>;
  /** Senders whose filing refused; they stay held, and the walk's next lap asks again. */
  failed: number;
  /** True ⇒ senders wait past this run's page, the clock cut it, or a lap is owed again: the next run is owed. */
  capped: boolean;
}

const EMPTY = (): ScreenerImpersonationResult => ({
  ran: false, examined: 0, filed: 0, senders: 0, kept: {}, failed: 0, capped: false,
});

/** A copy on record: the server held the letter at the last read. */
const copyOnRecord = (id: SQL): SQL => sql`exists (select 1 from ${messageInstances} cr where cr.message_id = ${id})`;

/** The switch and the cutline off the account's row; absent row ⇒ on, a failed read ⇒ off (and heard). */
export async function readImpersonationSettings(
  db: Tx, accountId: string, noteFault?: (err: unknown) => void,
): Promise<{ on: boolean } & ImpersonationCutlineSettings> {
  try {
    const [row] = await db.select({
      offAt: accountSettings.impersonationFilingOffAt,
      screeningBaselineAt: accountSettings.screeningBaselineAt,
      dormancyDays: accountSettings.dormancyDays,
      screeningScope: accountSettings.screeningScope,
    }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
    return {
      on: (row?.offAt ?? null) === null,
      screeningBaselineAt: row?.screeningBaselineAt ?? null,
      dormancyDays: row?.dormancyDays ?? null,
      screeningScope: row?.screeningScope ?? null,
    };
  } catch (err) {
    noteFault?.(err);
    return { on: false, screeningBaselineAt: null, dormancyDays: null, screeningScope: null };
  }
}

/**
 * THE PASS, for ONE account: one page of waiting senders holding a claim, their ties read once, the
 * pure decision per letter, and each sender's fileable letters filed in its own fenced transaction.
 * Store-neutral: the Cloud worker's tail and the desktop and phone engines run this one module.
 */
export async function screenerImpersonationPass(
  db: Tx, deps: ScreenerImpersonationDeps,
): Promise<ScreenerImpersonationResult> {
  const log = deps.log ?? silentLogger;
  const now = (): Date => deps.now?.() ?? new Date();
  const { accountId } = deps;
  if (deps.mailboxIds.length === 0) return EMPTY();
  const settings = deps.settings ?? await readImpersonationSettings(db, accountId, deps.noteFault);
  if (!settings.on) return EMPTY();

  const cutline = resolveCutline({
    baselineAt: settings.screeningBaselineAt, dormancyDays: settings.dormancyDays,
    scope: settings.screeningScope, now: now(),
  });
  const limit = deps.sendersPerRun ?? IMPERSONATION_SENDERS_PER_RUN;
  const walk = deps.walk ?? {};
  const over = [...deps.mailboxIds].sort().join(" ");
  if (walk.over !== over) Object.assign(walk, { over, after: null, again: false });
  const page = (after: ImpersonationWalk["after"]): Promise<ClaimSender[]> => selectClaimSenders(db, {
    accountId, mailboxIds: deps.mailboxIds, cutline, after: after ?? null, limit: limit + 1,
  });
  let waiting = await page(walk.after);
  if (waiting.length === 0 && walk.after != null) {
    // The lap is over: the next starts at the top, at once when this one left work behind.
    walk.after = null;
    if (walk.again === true) { walk.again = false; waiting = await page(null); }
  }
  if (waiting.length === 0) walk.again = false;
  const more = waiting.length > limit;
  if (more) waiting = waiting.slice(0, limit);
  const result: ScreenerImpersonationResult = { ...EMPTY(), ran: true, examined: waiting.length, capped: more };
  if (waiting.length === 0) return result;

  const senders = waiting.map((w) => w.address);
  const letters = await readClaimLetters(db, accountId, deps.mailboxIds, senders,
    Math.max(deps.lettersPerRun ?? IMPERSONATION_LETTERS_PER_RUN, senders.length));
  const bySender = new Map<string, ClaimLetter[]>();
  for (const l of letters) {
    const key = l.fromAddress.toLowerCase();
    const theirs = bySender.get(key);
    if (theirs === undefined) bySender.set(key, [l]); else theirs.push(l);
  }
  const lettersOf = (s: string): ClaimLetter[] => bySender.get(s) ?? [];
  const early = await readTies(db, accountId, senders);
  // A filing back at the gate is asked only of senders who would otherwise have a letter filed.
  const asked = senders.filter((s) => lettersOf(s).some((l) => impersonationFiling({ letter: l, ties: early(s) }).file));
  const returned = await impersonationReturnedSenders(db, accountId, asked);
  const ties = (s: string): ImpersonationTies => ({ ...early(s), putBack: early(s).putBack || returned.has(s) });

  const keep = (k: keyof ScreenerImpersonationResult["kept"], n = 1): void => {
    result.kept[k] = (result.kept[k] ?? 0) + n;
  };
  let tried = 0;
  let switchedOff = false;
  for (const { address: sender, latest } of waiting) {
    const mine = lettersOf(sender);
    const fileable: string[] = [];
    for (const l of mine) {
      const v = impersonationFiling({ letter: l, ties: ties(sender) });
      if (v.file) fileable.push(l.id); else keep(v.keep);
    }
    if (fileable.length > 0) {
      if (tried++ > 0 && deps.until?.()) { result.capped = true; break; }
      try {
        const filed = await fencedAccountWrite(db, { accountId }, async (tx) => {
          // The switch again, inside the filing's transaction: turned off mid-page, the rest waits.
          const [row] = await tx.select({ offAt: accountSettings.impersonationFilingOffAt })
            .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
          if ((row?.offAt ?? null) !== null) return null;
          return fileImpersonationLetters(tx, { accountId, address: sender, messageIds: fileable, now: now() });
        });
        if (filed === null) { switchedOff = true; break; }
        if (filed.skipped === "tied") keep("tied", fileable.length);
        else {
          const elsewhere = fileable.length - filed.rerouted.length;
          if (elsewhere > 0) keep("elsewhere", elsewhere);
          if (filed.rerouted.length > 0) {
            result.filed += filed.rerouted.length;
            result.senders++;
            // Cut short at the read: the rest of this sender's letters are the next lap's.
            if (mine[0]!.total > mine.length) walk.again = true;
          }
        }
      } catch (err) {
        if (err instanceof AccountErasedError) break;
        deps.noteFault?.(err);
        result.failed++;
        walk.again = true;
        log.error("screener_impersonation_failed", {
          accountId, err,
          reason: "this sender's held letters were not filed and stay in the Screener with their warning; "
            + "the walk's next lap asks again",
        });
      }
    }
    walk.after = { at: latest, address: sender };
  }
  // Turned off mid-page, nothing is owed: turning it on again owes the run.
  result.capped = switchedOff ? false : result.capped || walk.again === true;

  // `examined`, `moved`, `skipped`, `failed` and `capped` are names the hardened logger keeps.
  const skipped = Object.values(result.kept).reduce((n, k) => n + (k ?? 0), 0);
  log.info("screener_impersonation", {
    accountId, examined: result.examined, moved: result.filed, skipped, failed: result.failed, capped: result.capped,
  });
  return result;
}

interface ClaimSender { address: string; latest: Date }

/**
 * THE WAITING SENDERS HOLDING A CLAIM — the act's window (`screener-auto-act.ts#selectWaitingSenders`):
 * one representative per sender with a copy on record, held inside the cutline or still active, and
 * not decided; without its no-AI exclusion, and only senders with a held claim letter nobody put back,
 * in a mailbox this install organizes. By newest held arrival, oldest first, and after `after`.
 */
async function selectClaimSenders(
  db: Tx, opts: {
    accountId: string; mailboxIds: readonly string[]; cutline: ResolvedCutline;
    after: { at: Date; address: string } | null; limit: number;
  },
): Promise<ClaimSender[]> {
  const d = dialect(db);
  const sender = sql`lower(${messages.fromAddress})`;
  const sortKey = heldSortKey(d, { date: sql`${messages.date}`, arrivedAt: sql`${messages.createdAt}` });
  const gone = await readGoneMailboxIds(db, opts.accountId);
  const reps = db.select({
    messageId: messages.id,
    fromAddress: messages.fromAddress,
    rank: sql<number>`row_number() over (
      partition by ${sender} order by ${sortKey} desc, ${messages.id} desc
    )`.as("rank"),
    heldArrival: sql<number>`max(case when ${heldArrivedInsideSql(d, {
      folder: sql`${folderState.desiredFolder}`, deletedAt: sql`${messages.deletedAt}`, date: sql`${messages.date}`,
      arrivedAt: sql`${messages.arrivedAt}`, recordedAt: sql`${messages.createdAt}`, mailboxId: sql`${messages.mailboxId}`,
    }, opts.cutline)} then 1 else 0 end) over (partition by ${sender})`.as("held_arrival"),
    // To the millisecond a walk's `after` carries, so the resuming comparison meets the row it stopped at.
    latest: sql<Date>`${d.truncMs(sql`max(${messages.createdAt}) over (partition by ${sender})`)}`.as("latest"),
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, opts.accountId),
      eq(folderState.desiredFolder, SCREENER_FOLDER),
      isNull(messages.deletedAt),
      notGoneSql(d, messages.mailboxId, gone),
    ))
    .as("reps");
  // The outer row's address named with its subquery's alias: see the act's selection for why.
  const repSender = sql`lower(${sql.identifier("reps")}.${sql.identifier(messages.fromAddress.name)})`;
  const latest = sql`${sql.identifier("reps")}.${sql.identifier("latest")}`;
  const organized = sql.join(opts.mailboxIds.map((id) => d.castUuid(id)), sql`, `);
  const rows = await db.select({
    fromAddress: reps.fromAddress, latest: sql<Date>`${latest}`.mapWith(messages.createdAt),
  }).from(reps)
    .where(and(
      eq(reps.rank, 1),
      copyOnRecord(sql`${sql.identifier("reps")}.${sql.identifier(messages.id.name)}`),
      sql`exists (
        select 1 from ${messages} cm
          join ${folderState} cf on cf.message_id = cm.id
         where cm.account_id = ${d.castUuid(opts.accountId)}
           and lower(cm.from_address) = ${repSender}
           and cf.desired_folder = ${SCREENER_FOLDER}
           and cm.deleted_at is null
           and cm.sender_check = 'impersonation'
           and cm.unconfirmed_hold is not true
           and cf.auto_filing_undone_at is null
           and cm.mailbox_id in (${organized})
      )`,
      sql`(${reps.heldArrival} = 1 or ${senderIsActiveSql(d, opts.accountId, sql`lower(${reps.fromAddress})`, opts.cutline, gone)})`,
      sql`not ${senderIsDecidedSql(d, opts.accountId, sql`lower(${reps.fromAddress})`)}`,
      opts.after === null ? undefined : sql`(${latest}, ${repSender}) > (${d.ts(opts.after.at)}, ${opts.after.address})`,
    ))
    .orderBy(asc(latest), asc(repSender))
    .limit(opts.limit);
  return rows.map((r) => ({ address: r.fromAddress.toLowerCase(), latest: r.latest }));
}

interface ClaimLetter {
  id: string;
  fromName: string | null;
  fromAddress: string;
  subject: string;
  senderCheck: string | null;
  senderCheckBrand: string | null;
  sensitivityCategory: string | null;
  /** How many such letters its sender has, of which the read took its turns. */
  total: number;
}

/**
 * The senders' held claim letters the door may file: in an organized mailbox, a copy on record, none put
 * back. Read in turns, each sender's newest first, so one sender's pile takes no other sender's place.
 */
async function readClaimLetters(
  db: Tx, accountId: string, mailboxIds: readonly string[], senders: readonly string[], limit: number,
): Promise<ClaimLetter[]> {
  const sender = sql`lower(${messages.fromAddress})`;
  const claims = db.select({
    id: messages.id, fromName: messages.fromName, fromAddress: messages.fromAddress, subject: messages.subject,
    senderCheck: messages.senderCheck, senderCheckBrand: messages.senderCheckBrand,
    sensitivityCategory: messages.sensitivityCategory, createdAt: messages.createdAt,
    turn: sql<number>`row_number() over (partition by ${sender} order by ${messages.createdAt} desc, ${messages.id} desc)`.as("turn"),
    total: sql<number | string>`count(*) over (partition by ${sender})`.as("total"),
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, accountId),
      inArray(messages.mailboxId, [...mailboxIds]),
      inArray(sender, [...senders]),
      eq(folderState.desiredFolder, SCREENER_FOLDER),
      isNull(messages.deletedAt),
      eq(messages.senderCheck, "impersonation"),
      sql`${messages.unconfirmedHold} is not true`,
      isNull(folderState.autoFilingUndoneAt),
      copyOnRecord(sql`${messages.id}`),
    ))
    .as("claims");
  const rows = await db.select().from(claims)
    .orderBy(asc(claims.turn), desc(claims.createdAt), desc(claims.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id, fromName: r.fromName ?? null, fromAddress: r.fromAddress, subject: r.subject ?? "",
    senderCheck: r.senderCheck, senderCheckBrand: r.senderCheckBrand, sensitivityCategory: r.sensitivityCategory,
    // A bigint on the server arrives as a string.
    total: Number(r.total),
  }));
}

/**
 * EVERY TIE BETWEEN THESE SENDERS AND THE ACCOUNT, read once per page: its own addresses, a rule of
 * any kind or state naming the address or its domain, a contact of any source, someone it wrote to
 * or whose mail answers its own (a claim's answer too: here it only keeps a letter held), a list
 * address, and a letter the person put back.
 */
async function readTies(db: Tx, accountId: string, senders: readonly string[]): Promise<(s: string) => ImpersonationTies> {
  const own = await readOwnAddresses(db, accountId);
  const domains = [...new Set(senders.map(domainOf).filter((x) => x !== ""))];
  const named = ruleMatchKeySql(rules.match);
  const ruled = await db.select({ kind: rules.kind, key: sql<string>`${named}` }).from(rules).where(and(
    eq(rules.accountId, accountId),
    or(
      and(eq(rules.kind, "sender"), inArray(named, [...senders])),
      domains.length === 0 ? sql`false` : and(eq(rules.kind, "domain"), inArray(named, domains)),
    ),
  ));
  const ruledSenders = new Set(ruled.filter((r) => r.kind === "sender").map((r) => r.key));
  const ruledDomains = new Set(ruled.filter((r) => r.kind === "domain").map((r) => r.key));
  const contacted = new Set((await db.select({ address: contacts.address }).from(contacts)
    .where(and(eq(contacts.accountId, accountId), inArray(sql`lower(${contacts.address})`, [...senders]))))
    .map((c) => c.address.toLowerCase()));
  const wrote = await correspondentsAmong(db, { accountId, senders, references: "held" });
  const answering = await sendersAnsweringOwnWriting(db, accountId, senders.filter((s) => !wrote.has(s)), { claims: true });
  const lists = await readListAddresses(db, accountId, senders);
  const putBack = new Set((await db.selectDistinct({ address: sql<string>`lower(${messages.fromAddress})` })
    .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, accountId), inArray(sql`lower(${messages.fromAddress})`, [...senders]),
      isNotNull(folderState.autoFilingUndoneAt),
    ))).map((r) => r.address));
  return (s) => ({
    own: own.has(s),
    consented: ruledSenders.has(s) || ruledDomains.has(domainOf(s)) || contacted.has(s),
    correspondent: wrote.has(s) || answering.has(s),
    listed: lists.has(s),
    putBack: putBack.has(s),
  });
}
