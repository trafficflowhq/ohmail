"use client";

/**
 * Settings → General → Language. A `SegmentedControl` beside the theme's — the same class of decision, how the app is
 * drawn — and the list comes from `LOCALES`, so a third language is a catalogue and a constant. The row disappears
 * rather than going grey: `useAppLocale()` is null wherever no host wired a provider (the demo's bare panes,
 * forty-odd unit tests), and a disabled selector there is a control that cannot control — absent, structurally.
 */

/**
 * The failure is said and the control does not move: `setLocale` writes the account BEFORE the catalogue swaps and
 * rejects without having changed anything, so a refused write leaves the control showing the language the account
 * holds and puts the sentence in a toast — resolve to what the database holds, never what the click hoped for; an
 * optimistic swap that reverts leaves someone unable to say what their setting is.
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
      /* The reach of the choice, from the host that persists it — see `LocaleControls.scope`.
         A standalone install writes the language nowhere but this machine, so the account-wide
         sentence would be a claim about a sync that does not happen. */
      description={t(controls.scope === "install" ? "languageHintLocal" : "languageHint")}
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
