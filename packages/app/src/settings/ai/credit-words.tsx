import { dayStamp } from "@ohmail/app-logic/text/format";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import type { ReactNode } from "react";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import type { AiCredits } from "./budget.js";
import { AI_NAMESPACE } from "./namespace.js";

/** The AI budget as a person reads it, one sentence per pool; `null` where a pool has nothing to say. */
export interface CreditWords {
  /** What is left of the month's allowance against it, never more than the allowance (a trial's pot during a trial). */
  readonly month: string;
  /** What the balance holds above the allowance, only when it really does. */
  readonly extra: string | null;
  /** The one-time screening credits, while they last. */
  readonly setup: string | null;
  /** What the screening credits pay for, with their last day where they have one; said with `setup`. */
  readonly setupNote: string | null;
}

/**
 * THE ONE READING OF THE AI BUDGET, for every place that shows it: Subscription, Settings › AI and the Settings list.
 * The pools are never added together: the month's line is capped at the allowance, a balance above it is said apart,
 * and the setup credits are their own line.
 */
export function useCreditWords(credits: AiCredits | null | undefined): CreditWords | null {
  const own = useText(AI_NAMESPACE);
  const locale = useLocale();
  const zone = useTimeZone();
  if (!credits) return null;
  const { remaining, total, setup, trial } = credits;
  const month = total === undefined ? remaining : Math.min(remaining, total);
  const extra = total === undefined ? 0 : remaining - month;
  const screening = setup && setup.remaining > 0 ? setup : null;
  return {
    month:
      total === undefined
        ? own("creditsBalance", { remaining })
        : own(trial ? "creditsLeft" : "creditsMonth", { remaining: month, total }),
    extra: extra > 0 ? own("creditsExtraLeft", { count: extra }) : null,
    setup: screening ? own("setupCreditsLeft", { count: screening.remaining }) : null,
    setupNote: !screening
      ? null
      : screening.expiresAt === null
        ? own("setupCreditsNote")
        : own("setupCreditsNoteUntil", { date: dayStamp(screening.expiresAt, locale, zone) }),
  };
}

/**
 * The budget's lines on a sheet: the month's, its `meter` right under it (it measures the month alone), then the extra
 * and the screening credits where they have something, the latter with what they pay for.
 */
export function CreditLines({
  credits,
  off,
  meter,
}: {
  readonly credits: AiCredits;
  readonly off?: boolean;
  readonly meter?: ReactNode;
}) {
  const own = useText(AI_NAMESPACE);
  const words = useCreditWords(credits);
  if (!words) return null;
  return (
    <>
      <SettingLine label={own("budget")} value={words.month} off={off} />
      {meter}
      {words.extra ? <SettingLine label={own("creditsExtra")} value={words.extra} off={off} /> : null}
      {words.setup ? <SettingLine label={own("setupCredits")} value={words.setup} off={off} /> : null}
      {words.setup && words.setupNote ? <SettingNote>{words.setupNote}</SettingNote> : null}
    </>
  );
}

/** The AI entry's line in the Settings list: the month's sentence, hot when nothing is left. */
export function useAiBudgetSummary(
  credits: AiCredits | null | undefined,
): { detail: string; hot: boolean } | null {
  const words = useCreditWords(credits);
  return credits && words ? { detail: words.month, hot: credits.remaining === 0 } : null;
}
