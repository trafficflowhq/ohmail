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
 * by the signed-in account (`readOwner`, the id the mirror is named for); an accountless surface uses the
 * account-less key, where every pre-scoping choice lives. Deliberately no PER-MESSAGE override: a level that applied
 * to one compose and not the next would turn the setting into a default with invisible exceptions.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_LEVELS,
  type ImageQualityLevel,
  readImageQualityLevel,
  writeImageQualityLevel,
} from "../components/image-quality";
import { storageOwner } from "./storage-owner";

export function ImageQualityRow() {
  const t = useTranslations("settings");
  const [level, setLevel] = useState<ImageQualityLevel>(DEFAULT_IMAGE_QUALITY_LEVEL);
  /** The account whose preference this row edits — read post-mount like the value itself. */
  const owner = useRef<string | null>(null);

  // Post-mount, never during render — see the hydration note above. The account cookie is read
  // in the same effect for the same reason: there is no document on the server.
  useEffect(() => {
    owner.current = storageOwner();
    setLevel(readImageQualityLevel(owner.current));
  }, []);

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
            writeImageQualityLevel(next, owner.current);
            setLevel(next);
          }}
          className="quality-seg"
          options={IMAGE_QUALITY_LEVELS.map((id) => ({ id, label: t(`imageQualityLevel.${id}`) }))}
        />
      }
    />
  );
}
