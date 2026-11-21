"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { FeatureEntry } from "@ohmail/app/host";
import { durableSessionSet } from "@ohmail/app-logic/storage/durable";

const STORAGE_KEY = "ohmail.demo-ribbon";

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "gone";
  } catch {
    return false;
  }
}

const useDemoNotice: NonNullable<FeatureEntry["notice"]> = () => {
  const t = useTranslations("ribbon");
  const [dismissed, setDismissed] = useState(wasDismissed);
  if (dismissed) return [];

  // The existing catalogue bolds the heading. The slot draws it separately from the line.
  const [title, line] = t.markup("label", { b: (heading) => `${heading}\n` }).split("\n", 2);
  return [{
    kind: "demo",
    title: title!,
    line: line?.trimStart(),
    acts: [{
      label: t("dismiss"),
      onPress: () => {
        setDismissed(true);
        durableSessionSet(STORAGE_KEY, "gone", "demo.ribbon");
      },
    }],
  }];
};

export const DEMO_NOTICE = { name: "stageCard", render: () => null, notice: useDemoNotice } satisfies FeatureEntry;
