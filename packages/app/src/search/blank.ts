/**
 * WHAT SEARCH SAYS IN THE READING COLUMN WHILE NOTHING IS OPEN: that nothing is, while results stand; nothing at all
 * while there are none (the list says why). The reader draws it; Search only says it.
 */
import type { SearchListModel } from "@ohmail/app-logic/search";
import type { ListBlank } from "@ohmail/app-logic/reading";
import type { Translator } from "@ohmail/app-logic/text";

export function blankOf(model: Pick<SearchListModel, "length">, t: Translator): ListBlank | null {
  return model.length === 0 ? null : { label: t("blankNone"), hot: false };
}
