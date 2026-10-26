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
import { useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import type { MessageRowSpoken } from "@ohmail/ui";
import { sentAvatarOf, sentRowRecipient } from "./format";

export interface RowBadgeCopy {
  /** The shield capsule's word. Pass it only when the row IS protected. */
  protectedLabel: string;
  /** The held chip's whole phrase — the count included, because languages place it differently. */
  held: (count: number) => string;
  /**
   * The conversation's length as a SENTENCE. The row draws it as a bare number, which is all a
   * capsule has room for and nothing at all to a reader hearing the row read out.
   */
  thread: (count: number) => string;
  /** The conversation's squares as a sentence: how many, and how many of them unread. */
  marks: (count: number, unread: number) => string;
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
      thread: (count: number) => t("rowThread", { count }),
      marks: (count: number, unread: number) => t("rowMarks", { count, unread }),
      spoken: {
        unread: t("rowUnread"),
        read: t("rowRead"),
        attachment: t("rowAttachment"),
      },
    }),
    [t],
  );
}

/** An own-sent row's label and circle: what the row says in place of the writer's own name. */
export interface SentLabel {
  label: string;
  avatar: { avatarInitial: string; avatarHue: number };
}

/**
 * OWN-SENT ROWS NAME THE RECIPIENT — "Me → Nora Lindt", never the writer's own identity: the first
 * To recipient's name (their address where there is none), "+N" for the rest, and the circle is
 * the recipient's. `null` keeps the ordinary sender display: a received row, or a sent row whose
 * mirror predates recipients on the wire (empty `to`) — never "Me →" with nothing after the arrow.
 * The Ohbox's rows and a reading stream's answered letter read it alike.
 */
export function useSentLabel(): (m: EngineMessage) => SentLabel | null {
  const t = useTranslations("ohbox");
  return useCallback((m: EngineMessage) => {
    const r = sentRowRecipient(m);
    if (!r) return null;
    const label = r.extra > 0
      ? t("rowSentToMore", { name: r.name, count: r.extra })
      : t("rowSentTo", { name: r.name });
    return { label, avatar: sentAvatarOf(r) };
  }, [t]);
}
