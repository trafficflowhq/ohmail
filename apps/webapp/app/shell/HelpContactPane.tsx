"use client";

/**
 * SETTINGS › HELP & CONTACT. Write to us opens the person's own composer: To support, a subject,
 * and the diagnostics block in the body, where it is seen and can be removed (`SupportDiagnostics`).
 * Where this surface has no mailbox to send from, or no composer to open, it is a `mailto:` with
 * the same subject and body, or, where a mailto would not leave the window (`mailtoLeaves`), the
 * address and the block to copy. The block's facts are core's (`supportFacts`): classes and an
 * opaque account id, never an address or a host.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection } from "@ohmail/ui";
import {
  SUPPORT_ADDRESS, supportBlock, supportBody, supportFacts, supportMailto, type SupportSurface,
} from "@trafficflow/core/diagnostics";
import { defaultFrom, optionsFromFacts } from "./compose-from";
import { copyRefused, type MailboxFacts } from "./mail-state";

/** What the host knows about itself: which surface, which build, and the account where there is one. */
export interface SupportHost {
  surface: Exclude<SupportSurface, "phone">;
  version: string | null | undefined;
  commit: string | null | undefined;
  /** The ohmail account id, or `null` on a door with no account. Never an address. */
  accountId: string | null;
  /**
   * `false` where a clicked `mailto:` does not reach the mail app: the desktop window takes it into
   * its own composer (`open-external.ts`), which has no mailbox to send from either. Absent ⇒ it leaves.
   */
  mailtoLeaves?: boolean;
}

/** The new message Write to us opens. `diag` is the block, so the composer can offer to remove it. */
export interface SupportSeed {
  to: string;
  subject: string;
  body: string;
  diag: string;
}

/** The OS class from the browser's own words; the diagnostic builder narrows it again. */
export function navigatorOs(nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined): string | null {
  if (!nav) return null;
  const said = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/android/i.test(said)) return "android";
  if (/iphone|ipad|ipod/i.test(said)) return "ios";
  if (/mac/i.test(said)) return "macos";
  if (/win/i.test(said)) return "windows";
  if (/linux|x11|cros/i.test(said)) return "linux";
  return null;
}

export function HelpContactPane({ host, mailboxes, onWrite }: {
  host: SupportHost;
  /** `GET /mailboxes` as the shell holds it; `undefined` while it cannot tell. */
  mailboxes: readonly MailboxFacts[] | null | undefined;
  /** Opens the composer with the seed; `null` where this door has none that can send. */
  onWrite: ((seed: SupportSeed) => void) | null;
}) {
  const t = useTranslations("help");
  const [copied, setCopied] = useState<"address" | "diag" | null>(null);
  const copy = (what: "address" | "diag", text: string) => {
    // Deniable and absent in an insecure context; the address is on screen either way.
    try {
      void navigator.clipboard?.writeText(text).then(() => setCopied(what), () => setCopied(null));
    } catch {
      setCopied(null);
    }
  };
  const facts = supportFacts({
    surface: host.surface,
    build: { version: host.version ?? null, commit: host.commit ?? null },
    platform: { os: navigatorOs(typeof navigator === "undefined" ? undefined : navigator) },
    account: host.accountId,
    mailboxes: mailboxes ?? [],
  });
  const diag = supportBlock(facts, {
    title: t("diag"), app: t("dApp"), build: t("dBuild"), platform: t("dPlatform"), account: t("dAccount"),
    mailbox: t("dMailbox"), lastSync: t("dLastSync"), none: t("dNone"),
  });
  const subject = t("subject");
  const body = supportBody(diag);
  // A copy that refuses its own pull leaves the door offline: a mail sent from here would wait.
  const canSend = onWrite !== null && !copyRefused(mailboxes) && defaultFrom(optionsFromFacts(mailboxes ?? [])) !== null;
  const leaves = host.mailtoLeaves !== false;
  const version = `${facts.version ?? t("dNone")}${facts.commit !== null ? ` · ${t("dBuild")} ${facts.commit.slice(0, 9)}` : ""}`;
  return (
    <SettingsSection>
      <SettingsRow
        label={t("write")}
        description={canSend ? t("writeWhy") : leaves ? t("writeWhyMailto") : t("writeWhyCopy")}
        control={canSend ? (
          <Button variant="primary" onClick={() => onWrite({ to: SUPPORT_ADDRESS, subject, body, diag })}>
            {t("write")}
          </Button>
        ) : leaves ? (
          <a className="btn primary" href={supportMailto(subject, body)}>{t("write")}</a>
        ) : (
          <span className="help-copy">
            <Button variant="primary" onClick={() => copy("address", SUPPORT_ADDRESS)}>
              {copied === "address" ? t("copied") : t("copyAddress")}
            </Button>
            <Button variant="ghost" onClick={() => copy("diag", diag)}>
              {copied === "diag" ? t("copied") : t("copyDiag")}
            </Button>
          </span>
        )}
      />
      <SettingsRow label={t("versionLabel")} value={version} />
      <SettingsNote>{t("diagWhat")}</SettingsNote>
      <SettingsNote>{t("note")}</SettingsNote>
    </SettingsSection>
  );
}
