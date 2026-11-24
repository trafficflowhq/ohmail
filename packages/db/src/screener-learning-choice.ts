import { isScreenerTopic, screenerLessonKind, screenerTopic } from "./screener-topics.js";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "./change-log.js";
import { accounts, messages, routingDecisions, screenerLearning } from "./schema-mail.js";
import { canonicalNewsSpelling } from "./screener-apply.js";
import { destinationIsDecision } from "./screener-cutline.js";
import {
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, SCREENER_LEARNED_SUGGESTION_STATUS,
} from "./screener-suggestion.js";
import { noteWithoutTopic, SCREENER_LESSON_LIFETIME_MS, SCREENER_LESSON_LIMIT, type ScreenerLesson } from "./screener-learning-state.js";
import { withScreenerLearning, type ScreenerLearningScope } from "./screener-learning.js";

function ref(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recent(lessons: readonly ScreenerLesson[], at: Date): ScreenerLesson[] {
  return lessons.filter(lesson => lesson.at > at.getTime() - SCREENER_LESSON_LIFETIME_MS);
}

interface Choice {
  messageId: string;
  decisionId: string;
  actionId: string;
  chosen: string;
  shownSuggestionId?: string;
  at: Date;
  pressedAt?: Date;
}

/** Called on the organizer's durable human decision, inside the filing transaction. */
export async function recordScreenerChoice(tx: Tx, scope: ScreenerLearningScope, choice: Choice): Promise<void> {
  if (!destinationIsDecision(choice.chosen)) return;
  await withScreenerLearning(tx, scope, async state => {
    const pressedAt = (choice.pressedAt ?? choice.at).getTime();
    if (!state.enabled || state.notice || pressedAt < (state.resetAt ?? 0)
      || pressedAt <= choice.at.getTime() - SCREENER_LESSON_LIFETIME_MS) return state;
    const id = ref(choice.actionId);
    const lessons = recent(state.lessons, choice.at);
    const decisionId = ref(choice.decisionId);
    if (lessons.some(lesson => lesson.id === id || lesson.decisionId === decisionId)) return state;
    const [mail] = await tx.select({ subject: messages.subject }).from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(and(eq(messages.id, choice.messageId), eq(messages.accountId, scope.accountId),
        eq(messages.mailboxId, scope.mailboxId), eq(accounts.aiEnabled, true)));
    if (!mail) return state;

    const [offer] = choice.shownSuggestionId ? await tx.select({ destination: routingDecisions.destination, topic: routingDecisions.screenerTopic })
      .from(routingDecisions).where(and(
        eq(routingDecisions.id, choice.shownSuggestionId), eq(routingDecisions.accountId, scope.accountId),
        eq(routingDecisions.messageId, choice.messageId),
        eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
        inArray(routingDecisions.status, [SCREENER_SUGGESTION_STATUS, SCREENER_LEARNED_SUGGESTION_STATUS]),
      )) : [];
    const suggested = offer && destinationIsDecision(offer.destination) ? canonicalNewsSpelling(offer.destination) : null;
    const chosen = canonicalNewsSpelling(choice.chosen);
    const [priorAdvice] = offer ? [] : await tx.select({ topic: routingDecisions.screenerTopic })
      .from(routingDecisions).where(and(
        eq(routingDecisions.accountId, scope.accountId), eq(routingDecisions.messageId, choice.messageId),
        eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
        inArray(routingDecisions.status, [SCREENER_SUGGESTION_STATUS, SCREENER_LEARNED_SUGGESTION_STATUS]),
      )).orderBy(desc(routingDecisions.createdAt)).limit(1);
    const answerTopic = offer?.topic ?? priorAdvice?.topic;
    const topic = isScreenerTopic(answerTopic) ? answerTopic : screenerTopic(mail.subject);
    const lesson: ScreenerLesson = {
      id, decisionId, messageRef: ref(choice.messageId), messageId: choice.messageId, revision: state.revision + 1, at: choice.at.getTime(),
      kind: screenerLessonKind(chosen, suggested, null),
      suggested, chosen, previous: null, topic,
    };
    return { ...state, revision: state.revision + 1, lessons: [...lessons, lesson].slice(-SCREENER_LESSON_LIMIT) };
  });
}

type LaterChoice = { previous: string; chosen: string; actionId: string };

async function changeLesson(
  tx: Tx, scope: ScreenerLearningScope, match: (row: ScreenerLesson) => boolean, at: Date, change?: LaterChoice,
): Promise<void> {
  await withScreenerLearning(tx, scope, async state => {
    const lessons = recent(state.lessons, at);
    const prior = lessons.find(match);
    if (!prior || !state.enabled || state.notice) return state;
    if (change) {
      if (canonicalNewsSpelling(change.previous) !== prior.chosen || !destinationIsDecision(change.chosen)
        || canonicalNewsSpelling(change.chosen) === prior.chosen) return state;
      const [allowed] = await tx.select({ id: accounts.id }).from(accounts)
        .where(and(eq(accounts.id, scope.accountId), eq(accounts.aiEnabled, true)));
      if (!allowed) return state;
    }
    const kept = lessons.filter(row => !match(row));
    if (change) kept.push({
      ...prior, id: ref(change.actionId), previous: prior.chosen, chosen: canonicalNewsSpelling(change.chosen),
      at: at.getTime(), kind: "reversal", revision: state.revision + 1,
    });
    const revision = state.revision + 1;
    return {
      ...state, ...noteWithoutTopic(state, prior.topic), lessons: kept, revision, contextRevision: revision,
      rewrittenRevision: kept.length ? state.rewrittenRevision : revision,
    };
  });
}

/** A later move counts only when it can be traced to the very lesson it changes. */
export async function reviseScreenerMessage(
  tx: Tx, scope: ScreenerLearningScope, messageId: string, at: Date, change: LaterChoice | undefined,
): Promise<void> {
  const match = ref(messageId);
  if (change) {
    const [mail] = await tx.select({ id: messages.id }).from(messages).where(and(
      eq(messages.accountId, scope.accountId), eq(messages.mailboxId, scope.mailboxId), eq(messages.id, messageId),
    ));
    if (!mail) return;
  }
  await changeLesson(tx, scope, lesson => lesson.messageRef === match, at, change);
}

/** Rule edits change only attributed lessons on the mailboxes that remember that decision. */
export async function reviseScreenerDecision(
  tx: Tx, accountId: string, ruleId: string, at: Date, change?: LaterChoice,
): Promise<void> {
  const match = ref(ruleId);
  const rows = await tx.select({ mailboxId: screenerLearning.mailboxId, data: screenerLearning.data })
    .from(screenerLearning).where(eq(screenerLearning.accountId, accountId)).orderBy(screenerLearning.mailboxId);
  for (const { mailboxId, data } of rows) {
    if (data.lessons.some(lesson => lesson.decisionId === match)) {
      await changeLesson(tx, { accountId, mailboxId }, lesson => lesson.decisionId === match, at, change);
    }
  }
}

export const screenerMessageRef = ref;
