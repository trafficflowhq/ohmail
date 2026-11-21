"use client";

import { useMemo, type ReactNode } from "react";
import { mailboxes as mailboxApi } from "../../api-client";
import { MailboxFilings, type MailboxFilingsApi } from "../../shell/MailboxFilings";
import { MailboxSelfCheck } from "../../shell/MailboxSelfCheck";
import { AccountSection } from "./AccountSection";
import { CloudStorageNotice } from "./CloudStorageNotice";
import { MailboxSection } from "./MailboxSection";
import { PasswordSection } from "./PasswordSection";
import { SubscriptionSection } from "./SubscriptionSection";
import type { FeatureEntry } from "@ohmail/app/host";
import type { WebFeatureCards } from "./web-supplies";

/** Settings → Mailboxes' waiting filings, on the Cloud API. Module scope: one identity per load. */
const filingsApi: MailboxFilingsApi = {
  read: mailboxApi.filings, retry: mailboxApi.retryFilings, leave: mailboxApi.leaveFilings,
};

const card = (name: FeatureEntry["name"], node: ReactNode): FeatureEntry => ({ name, render: () => node });

/** The account and mailbox cards mounted by the Cloud shell. */
export function useWebFeatureCards(subscriptionPage: boolean, withdrawManage: () => void): WebFeatureCards {
  return useMemo(() => ({
    account: card("account", <><PasswordSection /><AccountSection /></>),
    mailboxes: card("mailboxes", (
      <>
        <MailboxSection subscriptionPane={subscriptionPage} />
        <MailboxFilings api={filingsApi} />
        <MailboxSelfCheck check={mailboxApi.selfCheck} />
      </>
    )),
    subscription: card("subscription", <SubscriptionSection onNowhere={withdrawManage} />),
    storageCard: card("storageCard", <CloudStorageNotice />),
  }), [subscriptionPage, withdrawManage]);
}
