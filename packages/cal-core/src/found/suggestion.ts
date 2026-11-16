/**
 * A finding as the columns of one stored suggestion (`cal_suggestions`). Offsets are not stored: they
 * index a text only the reading holds. The words are kept as text, so the person sees where the
 * suggestion came from.
 */
import { MAX_FOUND_SOURCE_WORDS_CHARS, MAX_FOUND_TITLE_CHARS } from "../limits.js";
import { cutWhole, subjectTitle } from "./text.js";
import type { Finding, FoundReading, FoundSuggestionColumns } from "./types.js";

/** The finding's words, joined by an ellipsis and cut at the ceiling; `null` when it has none. */
function sourceWordsOf(finding: Finding, reading: FoundReading): string | null {
  const parts = finding.words.map((w) => reading.text.slice(w.start, w.end)).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return cutWhole(parts.join(" … "), MAX_FOUND_SOURCE_WORDS_CHARS);
}

export function suggestionColumnsOf(
  finding: Finding,
  reading: FoundReading,
  subject: string,
): FoundSuggestionColumns {
  const { event } = finding;
  return {
    evidence: finding.evidence,
    proposed: {
      v: 1,
      level: finding.level,
      kind: finding.kind,
      title: subjectTitle(subject, MAX_FOUND_TITLE_CHARS),
      start: event.start,
      end: event.end,
      endGiven: event.endGiven,
      free: finding.free,
    },
    sourceWords: sourceWordsOf(finding, reading),
    findingKey: finding.key,
  };
}
