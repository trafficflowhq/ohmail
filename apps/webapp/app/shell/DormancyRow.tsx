"use client";

/**
 * The dormancy dial — how long a sender may go quiet before the Screener stops asking about them.
 * Moving it only changes what the Screener SHOWS: it never moves a message, never hides unread
 * mail, never touches a decided or placed sender — a plain settings write, unlike
 * {@link AutoSuggestRow}, which spends money. Presets, not a free field: the window is bounded
 * 1–365 by the column's CHECK, and a free integer invites a 0 that empties the queue and a 2e8
 * that crashes the `GET /consent` read; "60 days" is the default and picking it stores NULL, so
 * the account tracks the default (`setDormancyDays`). It writes through the hook (the partition
 * memo is keyed on `consent.dormancyDays`) and shows the stored echo, never the optimistic pick.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";

/**
 * The rungs the dial offers, in days — the onboarding flow's ladder, which is the same question
 * asked in the same words at setup and in Settings. "All time" is the fifth rung and is NOT a
 * number: see {@link ALL_TIME}.
 */
const PRESETS = [90, 180, 365] as const;

/**
 * THE MODE RUNG. `account_settings.screening_scope = 'all_time'` (mail 0083) means there is no
 * cutline at all — no cutoff and no dormancy — so it is the same dial's other answer rather than
 * a switch beside it, and it is written by the same call.
 *
 * A string sentinel rather than a magic number (`0`, `Infinity`, `36500`): the column is bounded
 * 1–365 by its own CHECK, so every number that could stand for "all time" is one the server must
 * refuse. The control's value space is therefore days-or-the-mode, exactly like the wire's.
 */
const ALL_TIME = "all";

export function DormancyRow({
  days,
  scope,
  setDormancyDays,
}: {
  /** The EFFECTIVE window as the server answered it — always a number. */
  days: number;
  /**
   * The EFFECTIVE mode as the server answered it. `'all_time'` means the window is stored but
   * not applied, which is why this control still remembers the number underneath: narrowing back
   * restores what was chosen rather than a default, and that is what "extend later" promises.
   */
  scope: "window" | "all_time";
  /**
   * `useConsentState().setDormancyDays` — and it must be THAT one, not `consentApi`, or the open
   * tab keeps partitioning with the stale window. Resolves to the effective window it stored.
   *
   * Takes the PAIR, because the window and the mode are one answer and the server writes them in
   * one upsert. Either half omitted means untouched: picking a number names both (a number IS a
   * window), picking "all time" names only the mode, so the stored number survives underneath.
   */
  setDormancyDays: (
    days: number | null | undefined, scope?: "window" | "all_time",
  ) => Promise<number>;
}) {
  const t = useTranslations("settings");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /** What the control is showing: the mode's rung, or the stored window's. */
  const selected = scope === "all_time" ? ALL_TIME : String(days);

  const choose = (next: string) => {
    if (pending || next === selected) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        // ── TWO SHAPES, ONE CALL ──────────────────────────────────────────────────────
        //
        // A number is a WINDOW, so it names both halves: the days and the mode that applies
        // them. Choosing 90 on an all-time account has to move the mode back or the number
        // would be stored and ignored — a control that reports success and changes nothing.
        //
        // "All time" names ONLY the mode, deliberately. The window stays where it was, so
        // narrowing again restores the number the person chose rather than the product
        // default. `setDormancyDays` coerces the default to a NULL store, so this component
        // never has to know which number is the default.
        if (next === ALL_TIME) await setDormancyDays(undefined, "all_time");
        else await setDormancyDays(Number(next), "window");
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  /**
   * The rungs on screen — the ladder, plus the stored window when it is not on it. The band is
   * 1–365 and the ladder is three of those values, so an account can hold a window this control
   * does not offer: the product default (60) is exactly such a value. Rendering the ladder alone
   * would leave the control with NOTHING selected over a real stored setting — a segmented control
   * showing no selection reads as "unset", a lie about a value the server is counting with. So
   * the stored window joins the ladder when not already on it, in order, and disappears the moment
   * the person moves off it.
   */
  const rungs = PRESETS.includes(days as (typeof PRESETS)[number])
    ? [...PRESETS]
    : [...PRESETS, days].sort((a, b) => a - b);

  return (
    <>
      <SettingsRow
        label={t("dormancy.title")}
        description={t("dormancy.description")}
        control={
          <SegmentedControl<string>
            ariaLabel={t("dormancy.ariaLabel")}
            value={selected}
            onChange={choose}
            className="dormancy-seg"
            options={[
              ...rungs.map((d) => ({ id: String(d), label: t("dormancy.dayLabel", { days: d }) })),
              // LAST, and outside the numbers, because it is where the numbers stop being the
              // answer. Keyboard reaches it exactly as it reaches the others and for the same
              // reason: `SegmentedControl` renders every option as a real `<button>` inside a
              // `role="group"`, so each rung is tab-reachable and Enter/Space activates it. The
              // mode rung therefore needs no key handling of its own and gets none — adding any
              // would be a second, divergent story for one of five identical controls.
              { id: ALL_TIME, label: t("dormancy.allTime") },
            ]}
          />
        }
      />
      {/* CLAIM-PINNED, and the two sentences say different true things. In window mode the note
          is about who gets asked; in all-time mode it is about the fact that widening asks about
          MORE senders and still moves nothing. Neither says the setting moves mail, because it
          does not: widening makes older undecided senders active in the Screener QUEUE, their
          mail stays physically where it is, and a decision is what moves it. */}
      <p className="set-note-inline">
        {scope === "all_time" ? t("dormancy.microcopyAllTime") : t("dormancy.microcopy")}
      </p>
      <p className="set-note-inline">{t("dormancy.microcopyWider")}</p>
      {failed ? <span className="scn-sg-note">{t("dormancy.failed")}</span> : null}
    </>
  );
}
