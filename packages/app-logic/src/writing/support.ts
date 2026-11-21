import {
  SUPPORT_ADDRESS,
  supportBlock,
  supportBody,
  supportFacts,
  supportMailto,
  type SupportSurface,
  type SupportWords,
} from "@trafficflow/core/diagnostics";
import { copyRefused, type MailboxFacts } from "../mail-state/mail-state.js";
import { defaultFrom, optionsFromFacts } from "./compose-from.js";
import type { SupportSeed } from "./composer-types.js";

/** The build and live account facts supplied by the current host. */
export interface SupportHost {
  surface: Exclude<SupportSurface, "phone">;
  version: string | null | undefined;
  commit: string | null | undefined;
  /** The opaque account ID, or null where there is no confirmed account. */
  accountId: string | null;
  mailtoLeaves?: boolean;
}

/** The OS class from the browser's own words. The diagnostic builder narrows it again. */
export function navigatorOs(
  nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined,
): string | null {
  if (!nav) return null;
  const said = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/android/i.test(said)) return "android";
  if (/iphone|ipad|ipod/i.test(said)) return "ios";
  if (/mac/i.test(said)) return "macos";
  if (/win/i.test(said)) return "windows";
  if (/linux|x11|cros/i.test(said)) return "linux";
  return null;
}

/** One scrubbed diagnostics block for the draft, external link, and copy actions. */
export function supportContact(
  host: SupportHost,
  mailboxes: readonly MailboxFacts[] | null | undefined,
  os: string | null,
  subject: string,
  words: SupportWords,
) {
  const facts = supportFacts({
    surface: host.surface,
    build: { version: host.version ?? null, commit: host.commit ?? null },
    platform: { os },
    account: host.accountId,
    mailboxes: mailboxes ?? [],
  });
  const diag = supportBlock(facts, words);
  const seed: SupportSeed = { to: SUPPORT_ADDRESS, subject, body: supportBody(diag), diag };
  const canSend = !copyRefused(mailboxes) && defaultFrom(optionsFromFacts(mailboxes ?? [])) !== null;
  return {
    seed,
    canSend,
    href: supportMailto(subject, seed.body),
    version: facts.version,
    commit: facts.commit,
  };
}
