"use client";

/**
 * Settings → General → After acting on a message. A `SegmentedControl` in `ImageQualityRow`'s
 * exact shape and for its exact reason: the choice changes how THIS install's reading pane
 * behaves and nothing about anybody's mail, so it is stored in this browser, scoped to the
 * signed-in account, and drawn by the shared file rather than injected by a host. The value
 * arrives one frame late (no `localStorage` on the server), read in an effect.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";
import {
  AFTER_VERB_CHOICES,
  DEFAULT_AFTER_VERB,
  type AfterVerbChoice,
  readAfterVerb,
  writeAfterVerb,
} from "@ohmail/app-logic/press/after-verb";
import { useScopeHere } from "@ohmail/app/frame";

export function AfterVerbRow() {
  const t = useTranslations("settings");
  const [choice, setChoice] = useState<AfterVerbChoice>(DEFAULT_AFTER_VERB);
  /* The scope of the shell this row is drawn in; drawn in none, it shows the default and stores nothing. */
  const scope = useScopeHere();

  useEffect(() => {
    if (scope !== null) setChoice(readAfterVerb(scope));
  }, [scope]);

  return (
    <SettingsRow
      label={t("afterVerb")}
      description={t("afterVerbHint")}
      control={
        <SegmentedControl<AfterVerbChoice>
          ariaLabel={t("afterVerbAria")}
          value={choice}
          onChange={(next) => {
            if (next === choice) return;
            // Storage first, then the control — the ImageQualityRow ordering, same reason.
            if (scope !== null) writeAfterVerb(next, scope);
            setChoice(next);
          }}
          className="afterverb-seg"
          options={AFTER_VERB_CHOICES.map((id) => ({ id, label: t(`afterVerbChoice.${id}`) }))}
        />
      }
    />
  );
}
