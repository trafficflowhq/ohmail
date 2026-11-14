"use client";

import { durableSet } from "@ohmail/app-logic/storage/durable";
import { awayPiles, awayRules } from "@ohmail/app-logic/press/away-settings";
import { isAppLocale, type AppLocale } from "@ohmail/app-logic/text/locale";
import {
  applyTextSize,
  isTextSize,
  readTextSize,
  TEXT_SIZE_KEY,
  TEXT_SIZES,
  type TextSize,
} from "@ohmail/app-logic/text/text-size";
import { AwaySettings, type AwaySettingsProps } from "./AwaySettings.js";
import { BrowserGeneralPane, type GeneralSettingsProps } from "./GeneralSettings.js";

interface LocaleControls {
  locale: AppLocale;
  locales: readonly AppLocale[];
  setLocale: (next: AppLocale) => Promise<void>;
  scope: "account" | "install";
  busy: boolean;
}

export function setTextSize(size: TextSize, root?: HTMLElement | null): void {
  durableSet(TEXT_SIZE_KEY, String(size), "ui.textSize");
  applyTextSize(size, root);
}

export function BrowserGeneralSettings({
  locale,
  textRoot,
  ...props
}: Omit<GeneralSettingsProps, "textSize" | "language"> & {
  locale: LocaleControls | null;
  textRoot?: () => HTMLElement | null;
}) {
  return (
    <BrowserGeneralPane
      {...props}
      textSize={{
        read: readTextSize,
        choices: TEXT_SIZES,
        set: (size) => {
          if (isTextSize(size)) setTextSize(size, textRoot?.());
        },
      }}
      language={
        locale && {
          value: locale.locale,
          choices: locale.locales,
          local: locale.scope === "install",
          busy: locale.busy,
          async set(next) {
            if (isAppLocale(next)) await locale.setLocale(next);
          },
        }
      }
    />
  );
}

export function BrowserAwaySettings(props: Pick<AwaySettingsProps, "wire" | "runsOn">) {
  return <AwaySettings {...props} rules={awayRules} piles={awayPiles} />;
}
