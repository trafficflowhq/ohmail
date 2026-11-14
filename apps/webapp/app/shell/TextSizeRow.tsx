"use client";

/**
 * Settings → General → Text size. Per device like the face pin and drawn by the shared file, so a
 * standalone install has it too: storage first, then the screen, through the host's door — the
 * desktop window's page zoom or the browser's stamp (`text-size.ts`). The value arrives one frame
 * late in the CONTROL only; the page itself was stamped before its first paint.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow } from "@ohmail/ui";
import { setTextSize } from "../(product)/mailbox/general-preferences";
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, readTextSize, type TextSize } from "./text-size";

export function TextSizeRow() {
  const t = useTranslations("settings");
  const [size, setSize] = useState<TextSize>(DEFAULT_TEXT_SIZE);

  useEffect(() => {
    setSize(readTextSize());
  }, []);

  return (
    <SettingsRow
      label={t("textSize")}
      description={t("textSizeHint")}
      control={
        <SegmentedControl<`${TextSize}`>
          ariaLabel={t("textSizeAria")}
          value={`${size}`}
          onChange={(next) => {
            const n = Number(next) as TextSize;
            if (n === size) return;
            setTextSize(n);
            setSize(n);
          }}
          className="textsize-seg"
          options={TEXT_SIZES.map((n) => ({ id: `${n}` as const, label: t("textSizeValue", { n }) }))}
        />
      }
    />
  );
}
