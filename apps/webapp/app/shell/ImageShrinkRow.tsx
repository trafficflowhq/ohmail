"use client";

/**
 * SETTINGS → GENERAL → SHRINK PICTURES.
 *
 * A `SegmentedControl` beside the theme's and the language's, because it is the same class of
 * decision as they are: it changes how this install behaves and nothing about anybody's mail, it is
 * stored in this browser rather than on the account, and it applies to a standalone install exactly
 * as it does to the Cloud client. That is why the row is drawn by the shared file directly instead
 * of being injected by a host the way every account-backed row in this pane is — there is no server
 * in this preference at any point, so there is nothing for a host to supply.
 *
 * ── WHY THE VALUE ARRIVES ONE FRAME LATE ──────────────────────────────────────────────────────
 *
 * The level lives in `localStorage`, which does not exist on the server. Reading it in the initial
 * state would make the server and the client render different markup, and React resolves a
 * hydration mismatch by keeping the SERVER's value — so the stored setting would be read and then
 * silently thrown away. The read is therefore an effect, which is one frame of the default followed
 * by the truth. This is the same shape, for the same reason, as `usePersistedFlag`.
 *
 * ── NO PER-COMPOSE OVERRIDE ───────────────────────────────────────────────────────────────────
 *
 * Deliberately one dial in one place. A per-message control would put a second answer next to the
 * attach button for a question almost nobody asks twice, and the case it exists for — "this one
 * needs to go at full size" — is served by moving the dial to None and back, which is two clicks
 * and leaves no ambiguity about what the setting means.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";
import {
  DEFAULT_IMAGE_SHRINK_LEVEL,
  IMAGE_SHRINK_LEVELS,
  type ImageShrinkLevel,
  readImageShrinkLevel,
  writeImageShrinkLevel,
} from "../components/image-shrink";

export function ImageShrinkRow() {
  const t = useTranslations("settings");
  const [level, setLevel] = useState<ImageShrinkLevel>(DEFAULT_IMAGE_SHRINK_LEVEL);

  // Post-mount, never during render — see the hydration note above.
  useEffect(() => {
    setLevel(readImageShrinkLevel());
  }, []);

  return (
    <SettingsRow
      label={t("imageShrink")}
      description={t("imageShrinkHint")}
      control={
        <SegmentedControl<ImageShrinkLevel>
          ariaLabel={t("imageShrinkAria")}
          value={level}
          onChange={(next) => {
            if (next === level) return;
            // Storage first, then the control. There is nothing asynchronous to fail here — a
            // blocked storage is swallowed inside `writeImageShrinkLevel` — so the two cannot end
            // up disagreeing, and the next pick reads back exactly what the segment shows.
            writeImageShrinkLevel(next);
            setLevel(next);
          }}
          className="shrink-seg"
          options={IMAGE_SHRINK_LEVELS.map((id) => ({ id, label: t(`imageShrinkLevel.${id}`) }))}
        />
      }
    />
  );
}
