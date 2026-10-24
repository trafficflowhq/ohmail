/**
 * SETTINGS › ABOUT › HELP & CONTACT, the pure half. Write to us opens the composer addressed to
 * support with a subject and the diagnostics block in the body (`app/compose.tsx` takes it as a
 * `mailto:` plus the block); with no mailbox to send from, the same `mailto:` goes to the phone's
 * mail app. The block is the diagnostic file's facts (`phoneSupportBlock`): classes and an opaque
 * account id, never an address or a host.
 */
import { Copy } from "../copy";
import {
  SUPPORT_ADDRESS, phoneSupportBlock, supportBody, supportMailto, withSupportBlock, withoutSupportBlock,
  type PhoneDiagnosticDeps,
} from "../engine/diagnostics";

export interface PhoneSupportMail {
  to: string;
  subject: string;
  body: string;
  /** The block alone, so the composer can take it out or put it back. */
  diag: string;
  mailto: string;
}

export function phoneSupportMail(
  state: Parameters<typeof phoneSupportBlock>[0],
  deps: Pick<PhoneDiagnosticDeps, "platform" | "build">,
): PhoneSupportMail {
  const diag = phoneSupportBlock(state, deps, {
    title: Copy.helpDiag, app: Copy.helpDApp, build: Copy.helpDBuild, platform: Copy.helpDPlatform,
    account: Copy.helpDAccount, mailbox: Copy.helpDMailbox, lastSync: Copy.helpDLastSync, none: Copy.helpDNone,
  });
  const subject = Copy.helpSubject;
  const body = supportBody(diag);
  return { to: SUPPORT_ADDRESS, subject, body, diag, mailto: supportMailto(subject, body) };
}

/** The composer's strip: the block is in the body (Remove gives `next`), or it is not (Add back gives `next`). */
export type DiagStrip = { k: "present"; next: string } | { k: "removed"; next: string };

export function diagStrip(body: string, diag: string): DiagStrip {
  const without = withoutSupportBlock(body, diag);
  return without !== null ? { k: "present", next: without } : { k: "removed", next: withSupportBlock(body, diag) };
}
