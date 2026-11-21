"use client";

import { useTranslations } from "next-intl";
import { useFaceSettings as useSharedFaceSettings, type FaceSettingsProps } from "@ohmail/app/settings/face";

export type { FaceSettingsProps };

export function useFaceSettings(props: FaceSettingsProps) {
  const t = useTranslations("settings");
  return useSharedFaceSettings(props, () => t("faceFailed"));
}
