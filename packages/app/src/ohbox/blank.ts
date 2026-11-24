/**
 * WHAT THE OHBOX SAYS IN THE READING COLUMN WHILE NOTHING IS OPEN: how many wait, "All read", or "Nothing open"
 * while the count may not be stated yet; nothing at all when the list has no rows (the list says it is empty).
 * The reader draws it; the Ohbox only says it.
 */
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import type { ListBlank } from "@ohmail/app-logic/reading";
import type { Translator } from "@ohmail/app-logic/text";

export function blankOf(
  model: Pick<OhboxListModel, "all" | "mayState" | "unreadIds">,
  t: Translator,
): ListBlank | null {
  if (model.all.length === 0) return null;
  if (!model.mayState) return { label: t("blank.none"), hot: false };
  const unread = model.unreadIds.length;
  return unread > 0
    ? { label: t("blank.unread", { count: unread }), hot: true }
    : { label: t("blank.clear"), hot: false };
}
