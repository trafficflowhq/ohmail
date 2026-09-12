/**
 * THE TWO BADGES A MESSAGE ROW WEARS, IN WORDS. `MessageRow` used to print "protected" and "{n} held" itself. Both
 * are one-word English literals inside `packages/ui`, which is the one place in this tree that cannot read a
 * catalogue — so every German list showed an English capsule on exactly the rows that matter most: the ones a rule is
 * holding and the ones whose remote content was blocked.
 */

/**
 * Seven views render the row. Rather than seven `useTranslations("message")` calls and seven chances to word it
 * differently, they take the words from here.
 */
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { MessageRowSpoken } from "@ohmail/ui";

export interface RowBadgeCopy {
  /** The shield capsule's word. Pass it only when the row IS protected. */
  protectedLabel: string;
  /** The held chip's whole phrase — the count included, because languages place it differently. */
  held: (count: number) => string;
  /**
   * THE TWO FACTS A ROW DRAWS IN COLOUR AND SHAPE, IN WORDS — read state and the clip. Same
   * journey as the badges above and one more reason: a screen reader hears no dot and no ink, so
   * "unread" was carried by nothing at all. Memoized WITH the rest, because the row takes it as
   * one object and a fresh one per render is a prop no comparator can pass.
   */
  spoken: MessageRowSpoken;
}

export function useRowBadgeCopy(): RowBadgeCopy {
  const t = useTranslations("message");
  return useMemo(
    () => ({
      protectedLabel: t("rowProtected"),
      held: (count: number) => t("rowHeld", { count }),
      spoken: {
        unread: t("rowUnread"),
        read: t("rowRead"),
        attachment: t("rowAttachment"),
      },
    }),
    [t],
  );
}
