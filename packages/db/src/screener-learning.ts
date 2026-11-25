import { isScreenerTopic } from "./screener-topics.js";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";
import { fencedAccountWrite, MailboxErasedError } from "./erasure-fence.js";
import { mailboxes, screenerLearning } from "./schema-mail.js";
import { SCREENER_LESSON_LIFETIME_MS, type ScreenerLearningState } from "./screener-learning-state.js";

export type { ScreenerLearningState, ScreenerLesson } from "./screener-learning-state.js";

export interface ScreenerLearningScope {
  accountId: string;
  mailboxId: string;
}

function mailboxMatch({ accountId, mailboxId }: ScreenerLearningScope) {
  return and(eq(mailboxes.accountId, accountId), eq(mailboxes.id, mailboxId),
    isNull(mailboxes.erasedAt), ne(mailboxes.status, "disabled"));
}

function learningMatch({ accountId, mailboxId }: ScreenerLearningScope) {
  return and(eq(screenerLearning.accountId, accountId), eq(screenerLearning.mailboxId, mailboxId));
}

function emptyState(): ScreenerLearningState {
  return { enabled: true, notice: true, text: "", lessons: [], updatedAt: null, revision: 0, rewrittenRevision: 0 };
}

function currentLessons(state: ScreenerLearningState, now: Date): ScreenerLearningState {
  const oldest = now.getTime() - SCREENER_LESSON_LIFETIME_MS;
  return { ...state, lessons: state.lessons.filter(lesson => lesson.at > oldest) };
}

export async function readScreenerLearning(
  db: Tx, scope: ScreenerLearningScope, now: Date,
): Promise<ScreenerLearningState | null> {
  const [row] = await db.select({ data: screenerLearning.data }).from(mailboxes)
    .leftJoin(screenerLearning, learningMatch(scope)).where(mailboxMatch(scope)).limit(1);
  return row ? currentLessons(row.data ?? emptyState(), now) : null;
}

/** The mailbox fence precedes the state lock, matching mailbox erasure. SQLite serializes writes. */
export async function updateScreenerLearning(
  db: Tx, scope: ScreenerLearningScope,
  update: (state: ScreenerLearningState, tx: Tx) => Promise<ScreenerLearningState> | ScreenerLearningState,
): Promise<ScreenerLearningState | null> {
  return fencedAccountWrite(db, { accountId: scope.accountId, mailboxId: scope.mailboxId }, async tx => {
    const [mailbox] = await dialect(tx).forUpdate(tx.select({ id: mailboxes.id }).from(mailboxes)
      .where(mailboxMatch(scope)), { mode: "share" });
    if (!mailbox) return null;
    await tx.insert(screenerLearning).values({ ...scope, data: emptyState() })
      .onConflictDoNothing({ target: screenerLearning.mailboxId });
    return withScreenerLearning(tx, scope, update);
  }).catch(error => {
    if (error instanceof MailboxErasedError) return null;
    throw error;
  });
}

/**
 * Update existing learning inside an account-fenced transaction. Filing and reset can already
 * hold the change-log counter here. Lock only the learning row so they never wait on a mailbox
 * lock at that point. Erasure deletes this same row with the mailbox stamp, in one transaction.
 * If erasure wins the row lock there is nothing to update. Only the separately fenced setup path
 * above can insert a row.
 */
export async function withScreenerLearning(
  tx: Tx, scope: ScreenerLearningScope,
  update: (state: ScreenerLearningState, tx: Tx) => Promise<ScreenerLearningState> | ScreenerLearningState,
): Promise<ScreenerLearningState | null> {
  const [row] = await dialect(tx).forUpdate(tx.select({ data: screenerLearning.data }).from(screenerLearning)
    .innerJoin(mailboxes, and(eq(mailboxes.id, screenerLearning.mailboxId), eq(mailboxes.accountId, screenerLearning.accountId)))
    .where(and(learningMatch(scope), mailboxMatch(scope))), { of: screenerLearning });
  if (!row) return null;
  const next = await update(row.data, tx);
  if (next !== row.data) await tx.update(screenerLearning).set({ data: next }).where(learningMatch(scope));
  return next;
}

export type ScreenerLearningChange =
  | { kind: "enable"; enabled: boolean }
  | { kind: "notice" }
  | { kind: "reset" }
  | { kind: "forget"; id: string };

export async function changeScreenerLearning(
  db: Tx, scope: ScreenerLearningScope, change: ScreenerLearningChange, now: Date,
): Promise<ScreenerLearningState | null> {
  return updateScreenerLearning(db, scope, state => changeState(state, change, now));
}

function changeState(stored: ScreenerLearningState, change: ScreenerLearningChange, now: Date): ScreenerLearningState {
  const state = currentLessons(stored, now);
  if (change.kind === "notice") return { ...state, notice: false };
  if (change.kind === "enable" && change.enabled) return { ...state, enabled: true, notice: false };
  const lessons = change.kind === "forget" ? state.lessons.filter(lesson => lesson.id !== change.id) : [];
  if (change.kind === "forget" && lessons.length === state.lessons.length) return stored;

  const revision = state.revision + 1;
  const { rewrite: _rewrite, rebuilding: _rebuilding, ...rest } = state;
  return {
    ...rest, notice: false, lessons, revision, contextRevision: revision,
    text: "", noteTopics: [], updatedAt: null,
    ...(lessons.length ? { rebuilding: true } : { rewrittenRevision: revision }),
    ...(change.kind === "forget" ? {} : { resetAt: now.getTime() }),
    enabled: change.kind === "enable" ? change.enabled : state.enabled,
  };
}

/** Clear each existing mailbox's lessons and note inside the account's screening reset. */
export async function resetAccountScreenerLearning(tx: Tx, accountId: string, now: Date): Promise<void> {
  const rows = await tx.select({ mailboxId: screenerLearning.mailboxId }).from(screenerLearning)
    .where(eq(screenerLearning.accountId, accountId)).orderBy(screenerLearning.mailboxId);
  for (const { mailboxId } of rows) {
    await withScreenerLearning(tx, { accountId, mailboxId }, state =>
      ({ ...changeState(state, { kind: "reset" }, now), notice: state.notice }));
  }
}

/** The only historical evidence disclosed with a fresh suggestion. */
export function screenerLearningContext(state: ScreenerLearningState | null) {
  if (!screenerLearningEnabled(state) || state.rebuilding) return {};
  const recentCorrections = state.lessons.flatMap(lesson => {
    const suggested = lesson.previous ?? lesson.suggested;
    return (lesson.kind === "correction" || lesson.kind === "reversal") && suggested !== null
      ? [{ suggested, chosen: lesson.chosen, topic: isScreenerTopic(lesson.topic) ? lesson.topic : "other" }] : [];
  }).slice(-5);
  return {
    ...(state.text ? { learnedWords: state.text } : {}),
    ...(recentCorrections.length ? { recentCorrections } : {}),
  };
}

export function screenerLearningEnabled(state: ScreenerLearningState | null): state is ScreenerLearningState {
  return state?.enabled === true && !state.notice;
}

export async function learningSnapshotIsCurrent(
  db: Tx, scope: ScreenerLearningScope, snapshot: ScreenerLearningState | null, now: Date,
): Promise<boolean> {
  if (!screenerLearningEnabled(snapshot)) return true;
  const current = await readScreenerLearning(db, scope, now);
  return screenerLearningEnabled(current) && current.contextRevision === snapshot.contextRevision;
}
