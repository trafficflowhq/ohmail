"use client";

import { useState } from "react";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { SupportSeed } from "@ohmail/app-logic/writing/composer-types";
import { supportContact, type SupportHost } from "@ohmail/app-logic/writing/support";
import type { PaneSheet } from "../contract.js";
import { useText } from "../../text/index.js";
import { HelpPane } from "./HelpPane.js";
import type { HelpWrite } from "./model.js";

export interface HelpContactProps {
  readonly host: SupportHost;
  readonly mailboxes: readonly MailboxFacts[] | null | undefined;
  readonly onWrite: ((seed: SupportSeed) => void) | null;
  readonly os: string | null;
  readonly copyText: (text: string) => Promise<boolean> | undefined;
  readonly sheet?: PaneSheet;
}

export function HelpContactPane({ host, mailboxes, onWrite, os, copyText, sheet }: HelpContactProps) {
  const t = useText("help");
  const [copied, setCopied] = useState<"address" | "diag" | null>(null);
  const { seed, canSend, href, facts } = supportContact(host, mailboxes, os, t("subject"), {
    title: t("diag"),
    app: t("dApp"),
    build: t("dBuild"),
    platform: t("dPlatform"),
    account: t("dAccount"),
    mailbox: t("dMailbox"),
    lastSync: t("dLastSync"),
    none: t("dNone"),
  });
  const copy = (what: "address" | "diag") => {
    try {
      void copyText(what === "diag" ? seed.diag : seed.to)?.then(
        (written) => setCopied(written ? what : null),
        () => setCopied(null),
      );
    } catch {
      setCopied(null);
    }
  };
  const write: HelpWrite =
    canSend && onWrite !== null
      ? { kind: "compose", write: () => onWrite(seed) }
      : host.mailtoLeaves !== false
        ? { kind: "mailto", href }
        : { kind: "copy", copied, copy };
  return <HelpPane model={{ write, facts, clipboard: { copied, copy } }} sheet={sheet} />;
}
