"use client";

/**
 * "What deserves my Ohbox" — the editable screening preference, injected into the general pane. Three controls over
 * one account setting (`GET/PATCH /account/screening`): a POSTURE switch (ON = keep the Ohbox for what is relevant
 * and file obvious bulk to Reads/Receipts; OFF = today's default — framed around RELEVANCE, never "only real people",
 * because the mechanism keeps relevant service mail); an AUTO-APPLY opt-in, default off; and the free-text BAR, which
 * is {@link OhboxWords} — one editor over one column, the transport handed in.
 */

/**
 * It re-files FUTURE mail and says so: the posture does not reach back into the Ohbox, and until a backlog pass ships
 * the setting must not imply it moves the past. The switches show the STORED value (`AutoSuggestRow`'s contract); the
 * failure line sits under the switches, not under the bar, which keeps its own — two controls that can each fail need
 * two places to say so.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSubhead, Switch } from "@ohmail/ui";
import { OhboxWords } from "./OhboxWords";
import { screeningSettings, type ScreeningPreferenceWire } from "../api-client";

export function ScreeningSection() {
  const t = useTranslations("settings");
  const [pref, setPref] = useState<ScreeningPreferenceWire | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const loaded = await screeningSettings.get();
        if (alive.current) setPref(loaded);
      } catch {
        // Leave the section unrendered on a read fault rather than showing a broken control.
        if (alive.current) setPref(null);
      }
    })();
    return () => { alive.current = false; };
  }, []);

  if (!pref) return null;
  const relevanceOn = pref.ohboxPolicy === "people_only";

  /** The two SWITCHES' write. The bar has its own — see {@link OhboxWords}. */
  const apply = (next: Partial<{
    ohboxPolicy: ScreeningPreferenceWire["ohboxPolicy"];
    screenerAutoApply: boolean;
  }>) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    setSaved(false);
    void (async () => {
      try {
        const landed = await screeningSettings.set(next);
        if (!alive.current) return;
        setPref(landed);
        setSaved(true);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  return (
    <>
      <SettingsSubhead>{t("screening.title")}</SettingsSubhead>

      <SettingsRow
        label={t("screening.postureTitle")}
        description={relevanceOn ? t("screening.postureOn") : t("screening.postureOff")}
        control={
          <Switch
            checked={relevanceOn}
            disabled={pending}
            ariaLabel={t("screening.postureTitle")}
            onChange={(next) => apply({ ohboxPolicy: next ? "people_only" : "people_and_replied" })}
          />
        }
      />

      {/* Auto-apply: an opt-in, default OFF. It moves obvious bulk out of the Screener for you using
          the deterministic rules — never the AI, never a purchase, never sensitive mail — and every
          move is reversible. The description states the spend model (none) and what stays untouched. */}
      <SettingsRow
        label={t("screening.autoApplyTitle")}
        description={t("screening.autoApplyDescription")}
        control={
          <Switch
            checked={pref.screenerAutoApply}
            disabled={pending}
            ariaLabel={t("screening.autoApplyTitle")}
            onChange={(next) => apply({ screenerAutoApply: next })}
          />
        }
      />

      {saved ? <span className="scn-sg-note">{t("screening.saved")}</span> : null}
      {failed ? <span className="scn-sg-note">{t("screening.failed")}</span> : null}

      <OhboxWords
        bar={pref.ohboxBar}
        defaultBar={pref.defaultBar}
        busy={pending}
        onSave={async (next) => {
          const landed = await screeningSettings.set({ ohboxBar: next });
          if (alive.current) setPref(landed);
          return landed.ohboxBar;
        }}
      />
    </>
  );
}
