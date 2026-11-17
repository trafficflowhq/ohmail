import { and, eq } from "drizzle-orm";
import {
  accountSettings, mailboxes, mailboxProfileMirror, isOrganizerKind, isOrganizerRole, resolveCutline,
  type OrganizedBy, type ResolvedCutline,
} from "@trafficflow/db";
import { DEFAULT_DORMANCY_DAYS, type ScreeningScope } from "@trafficflow/core/mail";
import { DEFAULT_STALE_AFTER_MS, clockSkewBoundMs } from "@trafficflow/core/adapters/organizer-lease";
import { isStatedInstant } from "@trafficflow/core/adapters/organizer-profile";
import type { ServiceContext } from "./context.js";

/**
 * WHOSE WINDOW SCREENS EACH MAILBOX (RULING-026). The window belongs to a mailbox's ORGANIZER: on
 * a mailbox this install organizes it is the account's own row (`own`); on one it reads, it is the
 * window the organizer published in its settings document, read off this install's mirror
 * (`organizer`). With no mirrored document (`unread`) or one that states no window (`unstated`) the
 * folder is listed whole and the source says why. The reader's own row is never applied to a
 * mailbox it does not organize. Mirror only, no dial: a request opens no IMAP.
 */
export type WindowSource = "own" | "organizer" | "unread" | "unstated";

export interface EffectiveScreeningWindow {
  baselineAt: string | null;
  dormancyDays: number;
  scope: ScreeningScope;
  source: WindowSource;
  /** Who organizes the mailbox, on a mailbox this install reads; `null` on its own. */
  holder: OrganizedBy | null;
  /** When the mirrored document was read, where one is; `null` otherwise. */
  asOf: string | null;
}

/** The folder whole: what `unread` and `unstated` resolve to — no date retires anybody. */
const FOLDER_WHOLE = { baselineAt: null, dormancyDays: DEFAULT_DORMANCY_DAYS, scope: "all_time" as const };

/**
 * The envelope's window, well-formed only — the mirror stores what the parser kept. Its baseline is the
 * cutoff the queue and the count bind, from a copy anyone can write: a stated instant only, from 1970 on
 * and not after `notAfterMs` ({@link isStatedInstant}), also where an earlier build's parser kept another.
 */
function publishedWindow(doc: unknown, notAfterMs: number): Pick<EffectiveScreeningWindow, "baselineAt" | "dormancyDays" | "scope"> | null {
  const s = typeof doc === "object" && doc !== null ? (doc as { screening?: unknown }).screening : undefined;
  if (typeof s !== "object" || s === null) return null;
  const o = s as Record<string, unknown>;
  const days = o.dormancyDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) return null;
  if (o.scope !== "window" && o.scope !== "all_time") return null;
  if (o.baselineAt !== null && !isStatedInstant(o.baselineAt, notAfterMs)) return null;
  return { baselineAt: o.baselineAt as string | null, dormancyDays: days, scope: o.scope };
}

/**
 * ONE QUERY over the account's mailboxes LEFT JOIN the mirror (the account column in the join
 * predicate: the mirror is keyed by mailbox alone), plus one `account_settings` read.
 */
export async function effectiveScreeningWindows(ctx: ServiceContext): Promise<Map<string, EffectiveScreeningWindow>> {
  const rows = await ctx.db.select({
    id: mailboxes.id,
    role: mailboxes.organizerRole,
    kind: mailboxes.organizedByKind,
    name: mailboxes.organizedByName,
    since: mailboxes.organizedSince,
    doc: mailboxProfileMirror.doc,
    readAt: mailboxProfileMirror.readAt,
  })
    .from(mailboxes)
    .leftJoin(mailboxProfileMirror, and(
      eq(mailboxProfileMirror.mailboxId, mailboxes.id),
      eq(mailboxProfileMirror.accountId, ctx.accountId),
    ))
    .where(eq(mailboxes.accountId, ctx.accountId));
  const [own] = await ctx.db.select({
    baselineAt: accountSettings.screeningBaselineAt,
    dormancyDays: accountSettings.dormancyDays,
    scope: accountSettings.screeningScope,
  }).from(accountSettings).where(eq(accountSettings.accountId, ctx.accountId)).limit(1);
  const ownDays = own?.dormancyDays;
  const ownWindow = {
    baselineAt: own?.baselineAt == null ? null : new Date(own.baselineAt).toISOString(),
    dormancyDays: typeof ownDays === "number" && ownDays > 0 ? ownDays : DEFAULT_DORMANCY_DAYS,
    scope: own?.scope === "all_time" ? "all_time" as const : "window" as const,
  };

  // The latest baseline a copy may state here: two clocks differ by at most the lease's skew bound.
  const notAfterMs = ctx.now().getTime() + clockSkewBoundMs(DEFAULT_STALE_AFTER_MS);
  const out = new Map<string, EffectiveScreeningWindow>();
  for (const r of rows) {
    const role = isOrganizerRole(r.role) ? r.role : "reader";
    if (role === "organizer") {
      out.set(r.id, { ...ownWindow, source: "own", holder: null, asOf: null });
      continue;
    }
    const holder: OrganizedBy = {
      kind: isOrganizerKind(r.kind) ? r.kind : null,
      name: r.name ?? null,
      since: r.since ? new Date(r.since).toISOString() : null,
    };
    const asOf = r.readAt == null ? null : new Date(r.readAt).toISOString();
    if (r.doc == null) {
      out.set(r.id, { ...FOLDER_WHOLE, source: "unread", holder, asOf: null });
      continue;
    }
    const published = publishedWindow(r.doc, notAfterMs);
    out.set(r.id, published === null
      ? { ...FOLDER_WHOLE, source: "unstated", holder, asOf }
      : { ...published, source: "organizer", holder, asOf });
  }
  return out;
}

/** The cutline each mailbox is screened by, for the queue's one predicate and its count. */
export function cutlinesOf(windows: ReadonlyMap<string, EffectiveScreeningWindow>, now: Date): Map<string, ResolvedCutline> {
  const out = new Map<string, ResolvedCutline>();
  for (const [id, w] of windows) {
    out.set(id, resolveCutline({
      baselineAt: w.baselineAt === null ? null : new Date(w.baselineAt),
      dormancyDays: w.dormancyDays, scope: w.scope, now,
    }));
  }
  return out;
}
