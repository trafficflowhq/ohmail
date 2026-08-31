"use client";

/**
 * SETTINGS → GENERAL → PICTURE QUALITY.
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
 * ── ONE VALUE PER ACCOUNT, TWO SURFACES ───────────────────────────────────────────────────────
 *
 * The compose attach row surfaces this same dial (`ComposeAttach`), reading and writing the same
 * stored value through the same two functions — so "this one needs to go at full size" is served
 * where the file is being picked, without walking here, and the choice made there is remembered
 * exactly as a choice made here is. The value is keyed by the signed-in account
 * (`owner-cookie.ts` → `readOwner`, the same id the mail mirror is named for), because a browser
 * is not a person: on a shared machine one account's full-size preference must not become
 * another's default. A surface with no account — the standalone desktop, the demo — uses the
 * account-less key, which is also where every pre-scoping choice lives, so nothing resets.
 * What remains deliberately absent is a PER-MESSAGE override: a level that applied to one
 * compose and not the next would turn the stored setting into a default with invisible
 * exceptions. Both controls move the one dial, and a move made in either place is what every
 * later pick obeys.
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
