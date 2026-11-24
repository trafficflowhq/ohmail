import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  SCREENER_LESSON_LIFETIME_MS,
  accounts,
  isScreenerTopic,
  accountSettings,
  decisionCanBeApplied,
  messages,
  ModelConsentWithdrawn,
  readRequestEligibility,
  readScreenerLearning,
  screenerLearning,
  updateScreenerLearning,
  type ScreenerLearningScope,
  type ScreenerLearningState,
  type AccessPort,
  type Tx,
} from "@trafficflow/db";
import {
  askScreenerRewrite,
  type ScreenerRewriteReference,
  type ClassifierPort,
  type ScreenerRewriteInput,
} from "@trafficflow/core/mail";

import type { AiCallOptions } from "@trafficflow/core";

const LEASE_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [5 * 60_000, 60 * 60_000] as const;

async function permissions(db: Tx, scope: ScreenerLearningScope) {
  const [row] = await db
    .select({
      language: accountSettings.locale,
      ownWords: accountSettings.ohboxBar,
    })
    .from(accounts)
    .leftJoin(accountSettings, eq(accountSettings.accountId, accounts.id))
    .where(and(eq(accounts.id, scope.accountId), eq(accounts.aiEnabled, true), isNull(accounts.erasedAt)));
  return row &&
    decisionCanBeApplied(await readRequestEligibility(db, scope.accountId, scope.mailboxId, "requests"))
    ? row
    : null;
}

function lessonRows(state: ScreenerLearningState, now: number) {
  return state.lessons.filter((lesson) => lesson.at > now - SCREENER_LESSON_LIFETIME_MS);
}

export async function drainScreenerLearning(
  db: Tx,
  accountId: string,
  classifier: ClassifierPort | undefined,
  clock: () => Date = () => new Date(),
  access?: AccessPort,
  call?: AiCallOptions,
): Promise<void> {
  const rows = await db
    .select({ mailboxId: screenerLearning.mailboxId })
    .from(screenerLearning)
    .where(eq(screenerLearning.accountId, accountId))
    .orderBy(screenerLearning.mailboxId);
  for (const { mailboxId } of rows) {
    const scope = { accountId, mailboxId };
    const base = classifier?.rewriteScreener ? await permissions(db, scope) : null;
    const id = randomUUID();
    const now = clock().getTime();
    const state = await updateScreenerLearning(db, scope, (current) => {
      const lessons = lessonRows(current, now);
      const stored = lessons.length === current.lessons.length ? current : { ...current, lessons };
      const retry = current.rewrite?.revision === current.revision ? current.rewrite : undefined;
      const failures = retry?.failures ?? 0;
      if (
        !base ||
        !current.enabled ||
        current.notice ||
        current.revision === current.rewrittenRevision ||
        (current.rewrite?.id && current.rewrite.until > now) ||
        (retry?.until ?? 0) > now ||
        failures > RETRY_DELAYS_MS.length ||
        !lessons.length
      )
        return stored;
      return { ...stored, rewrite: { id, until: now + LEASE_MS, revision: current.revision, failures } };
    });
    if (state?.rewrite?.id !== id || !base || !classifier?.rewriteScreener) continue;

    const fresh = state.lessons.filter(
      (lesson) => (lesson.revision ?? state.revision) > state.rewrittenRevision,
    );
    const pending = state.rebuilding
      ? state.lessons
      : fresh.length
        ? fresh.slice(0, 8)
        : state.lessons.slice(-8);
    const earlier = state.lessons
      .filter(
        (lesson) =>
          !pending.includes(lesson) && (lesson.revision ?? state.revision) <= state.rewrittenRevision,
      )
      .slice(-8);
    const choices: ScreenerRewriteInput["choices"] = [...earlier, ...pending].map((lesson, index) => ({
      kind: lesson.kind,
      topic: isScreenerTopic(lesson.topic) ? lesson.topic : "other",
      suggested: lesson.suggested,
      previous: lesson.previous,
      chosen: lesson.chosen,
      ...(index < earlier.length ? { earlier: true } : {}),
    }));
    const input: ScreenerRewriteInput = {
      language: base.language === "de" ? "de" : "en",
      previous: state.text,
      choices,
    };
    const unchanged = async (handle: Tx) => {
      const current = await permissions(handle, scope);
      return current !== null && current.language === base.language && current.ownWords === base.ownWords;
    };
    const stillOurs = (current: ScreenerLearningState | null) =>
      current?.rewrite?.id === id &&
      current.revision === state.revision &&
      current.enabled &&
      !current.notice &&
      current.rewrite.until > clock().getTime() &&
      choices.length ===
        lessonRows({ ...current, lessons: [...earlier, ...pending] }, clock().getTime()).length;
    const beforeDispatch = async () => {
      if (!stillOurs(await readScreenerLearning(db, scope, clock())) || !(await unchanged(db))) {
        throw new ModelConsentWithdrawn();
      }
    };
    const creditsAllowRewrite = async () => {
      if (!access) return true;
      const verdict = await access.accessOrFault?.(accountId, { forDispatch: true });
      if (!verdict || verdict === "fault" || !verdict.ok || !verdict.limits.aiEnabled) return false;
      const credits = verdict.aiCredits;
      const setup = credits?.setup;
      return (
        (credits?.remaining ?? 0) > 0 ||
        Boolean(
          setup &&
          setup.remaining > 0 &&
          (setup.expiresAt === null || Date.parse(setup.expiresAt) > clock().getTime()),
        )
      );
    };
    let text: string;
    try {
      const messageIds = [
        ...new Set(state.lessons.flatMap((lesson) => (lesson.messageId ? [lesson.messageId] : []))),
      ];
      const references: ScreenerRewriteReference[] = messageIds.length
        ? await db
            .select({
              senderName: messages.fromName,
              subject: messages.subject,
            })
            .from(messages)
            .where(
              and(
                eq(messages.accountId, accountId),
                eq(messages.mailboxId, mailboxId),
                inArray(messages.id, messageIds),
              ),
            )
        : [];
      const allowDispatch = async () => {
        if (!(await creditsAllowRewrite())) throw new ModelConsentWithdrawn();
        await beforeDispatch();
      };
      // The transport repeats the gate before dispatch and on its own retries.
      text = await askScreenerRewrite(
        classifier.rewriteScreener.bind(classifier),
        input,
        allowDispatch,
        {
          ...call,
          beforeDispatch: allowDispatch,
        },
        references,
      );
    } catch (error) {
      if (!(error instanceof ModelConsentWithdrawn)) {
        await updateScreenerLearning(db, scope, (current) => {
          if (current.rewrite?.id !== id || current.revision !== state.revision) return current;
          const failures = (current.rewrite.failures ?? 0) + 1;
          const delay = RETRY_DELAYS_MS[failures - 1] ?? 0;
          return {
            ...current,
            rewrite: { revision: current.revision, failures, until: clock().getTime() + delay },
          };
        });
      }
      continue;
    }
    await updateScreenerLearning(db, scope, async (current, tx) => {
      if (!stillOurs(current) || !(await unchanged(tx))) return current;
      const { rewrite: _rewrite, rebuilding: _rebuilding, ...rest } = current;
      return {
        ...rest,
        text,
        noteTopics: [],
        updatedAt: text === current.text ? current.updatedAt : clock().getTime(),
        rewrittenRevision: fresh.length > pending.length ? pending.at(-1)!.revision! : current.revision,
      };
    });
  }
}
