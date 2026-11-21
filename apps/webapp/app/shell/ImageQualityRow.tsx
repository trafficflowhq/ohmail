"use client";

/**
 * Settings → General → Picture quality. A `SegmentedControl` beside the theme's and the language's: it changes how
 * this install behaves and nothing about anybody's mail, stored in this browser rather than on the account — which is
 * why the row is drawn by the shared file directly instead of injected by a host: there is no server in this
 * preference, so there is nothing for a host to supply. The value arrives one frame late: `localStorage` does not
 * exist on the server, and a hydration mismatch keeps the SERVER's value, so the read is an effect —
 * `usePersistedFlag`'s shape.
 */

/**
 * One value per account, two surfaces: `ComposeAttach` surfaces the same dial through the same two functions, keyed
 * by the scope of the shell both are drawn in (the account the mirror is named for, on the web); the account-less
 * key, where every pre-scoping choice lives, is read as the fallback. Drawn in no shell, the row stores nothing.
 * Deliberately no PER-MESSAGE override: a level that applied to one compose and not the next would turn the setting
 * into a default with invisible exceptions.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_LEVELS,
  type ImageQualityLevel,
  readImageQualityLevel,
  writeImageQualityLevel,
} from "../components/image-quality";
import { useScopeHere } from "@ohmail/app/frame/scope";

export function ImageQualityRow() {
  const t = useTranslations("settings");
  const [level, setLevel] = useState<ImageQualityLevel>(DEFAULT_IMAGE_QUALITY_LEVEL);
  /* The account whose preference this row edits: the scope of the shell it is drawn in. Drawn in none, the row
     shows the default and stores nothing. */
  const scope = useScopeHere();

  // Post-mount, never during render — see the hydration note above.
  useEffect(() => {
    if (scope !== null) setLevel(readImageQualityLevel(scope));
  }, [scope]);

  return (
    <SettingsRow
      label={t("imageQuality")}
      description={t("imageQualityHint")}
      control={
        <SegmentedControl<ImageQualityLevel>
          ariaLabel={t("imageQualityAria")}
          value={level}
          onChange={(next) => {
            if (next === level) return;
            // Storage first, then the control. There is nothing asynchronous to fail here — a
            // blocked storage is swallowed inside `writeImageQualityLevel` — so the two cannot end
            // up disagreeing, and the next pick reads back exactly what the segment shows.
            if (scope !== null) writeImageQualityLevel(next, scope);
            setLevel(next);
          }}
          className="quality-seg"
          options={IMAGE_QUALITY_LEVELS.map((id) => ({ id, label: t(`imageQualityLevel.${id}`) }))}
        />
      }
    />
  );
}
