"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { Button, Opening } from "@ohmail/ui/base";
import { MailboxOpening } from "../../shell/BootSkeleton";
import { productStylesReady } from "../product-styles-ready";

// Let the document paint its opening frame while the mailbox and its styles download.
const opening = () => <MailboxOpening serverFrame immediate />;

function MailboxLoadFailure() {
  const t = useTranslations("appError");
  return (
    <Opening kind="web" label={t("title")} action={
      <Button kind="two" onPress={() => window.location.reload()}>{t("reload")}</Button>
    } />
  );
}

export const ReturningMailbox = dynamic(async () => {
  try {
    const [ready, { CloudShell }] = await Promise.all([productStylesReady(), import("./CloudShell")]);
    return ready ? CloudShell : MailboxLoadFailure;
  } catch {
    return MailboxLoadFailure;
  }
}, { ssr: false, loading: opening });

export const CloudMailbox = dynamic(() => import("./CloudShell").then((module) => module.CloudShell));
export const WakeMailbox = dynamic(() => import("./CloudShell").then((module) => module.WakeMailboxEntry));
