"use client";

import type { ReactNode } from "react";
import { onNoticeReturn } from "@ohmail/app-logic/notices/browser-channels";
import {
  BrowserGeneralSettings as GeneralSettings, BrowserSettingsAbove, type GeneralSettingsProps,
} from "@ohmail/app/settings/browser";
import { useAppLocale } from "../../shell/LocaleContext";
import { applyWakeIntent, readChannels, subscriptionWanted, writeChannels } from "../../shell/notification-settings";

export { BrowserAwaySettings } from "@ohmail/app/settings/browser";

const textRoot = () => (typeof document === "undefined" ? null : document.documentElement);

export function BrowserGeneralSettings(props: Omit<GeneralSettingsProps, "textSize" | "language">) {
  return <GeneralSettings {...props} locale={useAppLocale()} textRoot={textRoot} />;
}

const notifications = {
  applyWakeIntent, readChannels, subscriptionWanted, writeChannels,
  onReturn: (refresh: () => void) => onNoticeReturn(window, refresh),
};

export function BrowserNotificationSettings({ children }: { children: ReactNode }) {
  return <BrowserSettingsAbove preferences={notifications}>{children}</BrowserSettingsAbove>;
}
