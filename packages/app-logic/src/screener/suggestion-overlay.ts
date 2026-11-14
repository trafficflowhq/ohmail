import type { ScreenerSenderDTO } from "@ohmail/client-engine";

/**
 * A suggestion bought this session, as the Screener's rows take it: the mirror's own suggestion shape, plus the id of
 * the mirror suggestion it landed over (`null` for none). The purchase itself is the shell's; the rows only read it.
 */
export type OverlaidSuggestion = NonNullable<ScreenerSenderDTO["ai"]> & { over?: string | null };

/** Suggestions known so far, keyed by sender. */
export type SuggestionOverlay = ReadonlyMap<string, OverlaidSuggestion>;
