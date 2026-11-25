"use client";

/**
 * SETUP RESUMES, ONCE PER TAB, for an account that never connected a mailbox: on a host with a setup page of its own
 * (the first run's `setupHref`, the web) the account is sent there once per tab, and only on answers (`GET
 * /mailboxes` answered empty, the LIVE consent read answered with no finished setup, the default view with nothing in
 * the address, no sign-in return on this load). Never on the demo, read off the browser's own answer. The rule is
 * `@ohmail/app-logic/doors/setup-resume`'s; this is the old shell's call of it (`AppShell.tsx`, `useShellSetup`) as
 * it stood, over the ground's readers and the host's first-run wire.
 *
 * ITS ANSWER, where "connect a mailbox" goes on this host (null: Settings' Mailboxes), is handed on through ONE reader,
 * `useSetupHref()`, which the boot duties provide: the connection's feeder reads it there.
 */
import { useConsent } from "@ohmail/app-logic/consent";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import { useShellSetup } from "@ohmail/app-logic/doors/setup-resume";
import { useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";

/** The resume, once per tab; answers where a person with no mailbox connects one on this host, or null. */
export function useSetupAtBoot(): string | null {
  const { host } = useFrame();
  const demo = useResolvedDemoMode();
  const { mailboxes: facts } = useMailState();
  const consent = useConsent();
  const firstRun = host.wires.firstRun;
  return (
    useShellSetup(firstRun === NONE ? undefined : (firstRun as FirstRunHost), demo, facts, consent) ?? null
  );
}

export { SetupHrefContext } from "../../mailboxes/connection.js";
