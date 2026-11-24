/**
 * WHAT SEARCH SAYS IN THE READING COLUMN WHILE NOTHING IS OPEN: that nothing is, at rest or while results stand.
 * For an active search without results the list speaks on its own.
 */
import type { SearchListModel } from "@ohmail/app-logic/search";
import type { ListBlank } from "@ohmail/app-logic/reading";
import type { Translator } from "@ohmail/app-logic/text";

export function blankOf(
  model: Pick<SearchListModel, "length" | "text" | "narrowed">,
  t: Translator,
): ListBlank | null {
  if (model.length === 0 && (model.text !== "" || model.narrowed)) return null;
  return { label: t("blankNone"), hot: false };
}
