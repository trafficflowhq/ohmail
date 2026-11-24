"use client";

import { useMemo, type ReactNode } from "react";
import { CloudStorageNotice } from "./CloudStorageNotice";
import { MountedSubscriptionSection } from "./SubscriptionSection";
import type { FeatureEntry } from "@ohmail/app/host";
import type { WebFeatureCards } from "./web-supplies";

const card = (name: FeatureEntry["name"], node: ReactNode): FeatureEntry => ({ name, render: () => node });

/** Cards supplied by the Cloud shell. */
export function useWebFeatureCards(withdrawManage: () => void): WebFeatureCards {
  return useMemo(() => ({
    // The Settings pane registry owns Mailboxes. This feature supplies its notices.
    mailboxes: card("mailboxes", null),
    subscription: {
      name: "subscription",
      render: (sheet) => <MountedSubscriptionSection onNowhere={withdrawManage} sheet={sheet} />,
    },
    storageCard: card("storageCard", <CloudStorageNotice />),
  }), [withdrawManage]);
}
