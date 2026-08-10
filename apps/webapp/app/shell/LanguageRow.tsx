"use client";

/**
 * SETTINGS → GENERAL → LANGUAGE.
 *
 * A `SegmentedControl` beside the theme's, because they are the same class of decision — how the
 * app is drawn, changing nothing about anybody's mail — and putting them in different shapes would
 * imply otherwise. Two members today; the control grows sideways cleanly and the list comes from
 * `LOCALES` rather than from this file, so a third language is a catalogue and a constant.
 *
 * ── WHY THIS ROW DISAPPEARS RATHER THAN GOING GREY ─────────────────────────────────────────────
 *
 * `useAppLocale()` is null wherever no host wired a locale provider: the demo's bare panes, and the
 * forty-odd unit tests that render one component with no context around it. A disabled selector
 * there would be a control that cannot control, which is exactly the built-and-unreachable shape
 * `SettingsView`'s injected-node seam exists to avoid. So the row is absent, structurally.
 *
 * ── THE FAILURE IS SAID, AND THE CONTROL DOES NOT MOVE ────────────────────────────────────────
 *
 * On the Cloud client `setLocale` writes the account BEFORE the catalogue swaps, and rejects without
 * having changed anything. So a refused write leaves the segmented control showing the language the
 * account actually holds and puts a sentence in a toast — the same contract every other settings
 * control here keeps ("resolve to what the database holds, never to what the click hoped for"). The
 * alternative, an optimistic swap that reverts, tells somebody their language changed and then takes
 * it away, and leaves them unable to say what their setting is.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow, useToast } from "@ohmail/ui";
import { useAppLocale } from "./LocaleContext";
import type { AppLocale } from "./locale";

export function LanguageRow() {
  const t = useTranslations("settings");
  const toast = useToast();
  const controls = useAppLocale();
  /** Local, so a rejection can be reported without the shared `busy` flag owning the message. */
  const [saving, setSaving] = useState(false);

  if (controls === null) return null;

  return (
    <SettingsRow
      label={t("language")}
      description={t("languageHint")}
      control={
        <SegmentedControl<AppLocale>
          ariaLabel={t("languageAria")}
          value={controls.locale}
          /* Disabled while a switch is in flight — the catalogue for the new language may still be
             arriving, and a second press would race the first. */
          onChange={(next) => {
            if (saving || controls.busy || next === controls.locale) return;
            setSaving(true);
            void controls
              .setLocale(next)
              .catch(() => {
                toast(t("languageFailed"));
              })
              .finally(() => {
                setSaving(false);
              });
          }}
          className="lang-seg"
          /* The name of each language IN THAT LANGUAGE — "English", "Deutsch" — and it is the same
             pair in both catalogues rather than a translated word. A German reader looking for their
             language scans for "Deutsch", not for whatever the language they cannot read calls it;
             an English reader is not helped by "German" either, since the label they are choosing
             is the one they will be reading afterwards. This is the one place in the catalogue where
             `en.json` and `de.json` hold identical strings on purpose. */
          options={controls.locales.map((id) => ({ id, label: t(`languageName.${id}`) }))}
        />
      }
    />
  );
}
