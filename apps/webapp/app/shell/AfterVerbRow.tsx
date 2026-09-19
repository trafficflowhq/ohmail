"use client";

/**
 * Settings → General → After acting on a message. A `SegmentedControl` in `ImageQualityRow`'s
 * exact shape and for its exact reason: the choice changes how THIS install's reading pane
 * behaves and nothing about anybody's mail, so it is stored in this browser, scoped to the
 * signed-in account, and drawn by the shared file rather than injected by a host. The value
 * arrives one frame late (no `localStorage` on the server), read in an effect.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";
import {
  AFTER_VERB_CHOICES,
  DEFAULT_AFTER_VERB,
  type AfterVerbChoice,
  readAfterVerb,
  writeAfterVerb,
} from "./after-verb";
import { storageOwner } from "./storage-owner";

export function AfterVerbRow() {
  const t = useTranslations("settings");
  const [choice, setChoice] = useState<AfterVerbChoice>(DEFAULT_AFTER_VERB);
  const owner = useRef<string | null>(null);

  useEffect(() => {
    owner.current = storageOwner();
    setChoice(readAfterVerb(owner.current));
  }, []);

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
            writeAfterVerb(next, owner.current);
            setChoice(next);
          }}
          className="afterverb-seg"
          options={AFTER_VERB_CHOICES.map((id) => ({ id, label: t(`afterVerbChoice.${id}`) }))}
        />
      }
    />
  );
}
