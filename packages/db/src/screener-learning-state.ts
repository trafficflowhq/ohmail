import { matchingScreenerTopics } from "./screener-topics.js";

/** A bounded, mailbox-local history. References are minted by ohmail and stay on this host. */
export interface ScreenerLesson {
  id: string;
  decisionId: string;
  messageRef: string;
  messageId?: string;
  revision?: number;
  at: number;
  kind: "correction" | "confirmation" | "independent" | "reversal";
  suggested: string | null;
  previous: string | null;
  chosen: string;
  topic: string;
}

export interface ScreenerLearningState {
  enabled: boolean;
  notice: boolean;
  text: string;
  noteTopics?: string[];
  lessons: ScreenerLesson[];
  updatedAt: number | null;
  revision: number;
  resetAt?: number;
  contextRevision?: number;
  rewrittenRevision: number;
  rebuilding?: true;
  rewrite?: { id?: string; until: number; revision?: number; failures?: number };
}

export const SCREENER_LESSON_LIFETIME_MS = 30 * 86_400_000;
export const SCREENER_LESSON_LIMIT = 32;

/** Keep independently recognizable lessons. Rebuild ambiguous wording from the remaining history. */
export function noteWithoutTopic(state: ScreenerLearningState, topic: string) {
  if (topic === "other") return { text: "", noteTopics: [], updatedAt: null };
  const sentences = state.text.match(/[^.!?\n]+(?:[.!?]+|$)/gu) ?? [];
  const text = sentences.filter((sentence, index) => {
    const legacy = state.noteTopics?.length === sentences.length ? state.noteTopics[index] : undefined;
    const topics: readonly string[] = legacy ? [legacy] : matchingScreenerTopics(sentence);
    return topics.length > 0 && !topics.includes(topic);
  }).map(sentence => sentence.trim()).join(" ");
  return { text, noteTopics: [], updatedAt: text ? state.updatedAt : null };
}
