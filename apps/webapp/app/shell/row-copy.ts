/**
 * THE TWO BADGES A MESSAGE ROW WEARS, IN WORDS.
 *
 * `MessageRow` used to print "protected" and "{n} held" itself. Both are one-word English
 * literals inside `packages/ui`, which is the one place in this tree that cannot read a
 * catalogue — so every German list showed an English capsule on exactly the rows that matter
 * most: the ones a rule is holding and the ones whose remote content was blocked.
 *
 * Seven views render the row. Rather than seven `useTranslations("message")` calls and seven
 * chances to word it differently, they take the words from here.
 */
import { useMemo } from "react";
import { useTranslations } from "next-intl";

export interface RowBadgeCopy {
  /** The shield capsule's word. Pass it only when the row IS protected. */
  protectedLabel: string;
  /** The held chip's whole phrase — the count included, because languages place it differently. */
  held: (count: number) => string;
}

export function useRowBadgeCopy(): RowBadgeCopy {
  const t = useTranslations("message");
  return useMemo(
    () => ({
      protectedLabel: t("rowProtected"),
      held: (count: number) => t("rowHeld", { count }),
    }),
    [t],
  );
}
