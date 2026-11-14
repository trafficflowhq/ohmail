"use client";

import { useTranslations } from "next-intl";
import { useFaceSettings as useSharedFaceSettings, type FaceSettingsProps } from "@ohmail/app/settings/browser";

export type { FaceSettingsProps };
export { setTextSize } from "./browser-settings";

export function useFaceSettings(props: FaceSettingsProps) {
  const t = useTranslations("settings");
  return useSharedFaceSettings(props, () => t("faceFailed"));
}
