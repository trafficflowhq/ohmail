"use client";

import type { ReactNode } from "react";
import {
  BrowserGeneralSettings as GeneralSettings, BrowserSettingsAbove, setTextSize as setSizeAtRoot, type GeneralSettingsProps,
} from "@ohmail/app/settings/browser";
import type { TextSize } from "@ohmail/app-logic/text/text-size";
import { useAppLocale } from "../../shell/LocaleContext";
import { applyWakeIntent, readChannels, subscriptionWanted, writeChannels } from "../../shell/notification-settings";

export { BrowserAwaySettings } from "@ohmail/app/settings/browser";

const textRoot = () => (typeof document === "undefined" ? null : document.documentElement);

export function setTextSize(size: TextSize): void {
  setSizeAtRoot(size, textRoot());
}

export function BrowserGeneralSettings(props: Omit<GeneralSettingsProps, "textSize" | "language">) {
  return <GeneralSettings {...props} locale={useAppLocale()} textRoot={textRoot} />;
}

const notifications = { applyWakeIntent, readChannels, subscriptionWanted, writeChannels };

export function BrowserNotificationSettings({ children }: { children: ReactNode }) {
  return <BrowserSettingsAbove preferences={notifications}>{children}</BrowserSettingsAbove>;
}
