"use client";

/**
 * THE MAIL STATE'S MOUNT ABOVE THE PANES: the one provider of the mailbox facts and of the copy's age for a mounted
 * frame, with the two counts it samples off the mirror. `MailStateHost` was moved out of the web shell as it stood
 * and takes its probes as inputs; `MailStateMount` is the ground's piece and reads them off the host.
 */
import { useMemo, type ReactNode } from "react";
import { useDerivedVersion, useEngine } from "@ohmail/app-logic/engine";
import type { FreshnessProbe, MailboxProbe } from "@ohmail/app-logic/mail-state";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { MailStateProvider } from "../../mail-state/index.js";

/**
 * The ground's first piece: the mail state of this frame, its two probes the host's own reads. A read the host
 * answers with none is no probe: every state keyed by a mailbox is then withheld, and the engine's own verdict on the
 * copy's age stands. Its scope is the host's.
 */
export function MailStateMount({ children }: { readonly children: ReactNode }): ReactNode {
  const { host } = useFrame();
  const { mailboxes, copyAge } = host.reads;
  return (
    <MailStateHost
      scope={host.session.scope}
      probe={mailboxes === NONE ? undefined : (mailboxes as MailboxProbe)}
      freshnessProbe={copyAge === NONE ? undefined : (copyAge as FreshnessProbe)}
    >
      {children}
    </MailStateHost>
  );
}

/**
 * The mail-state provider, hoisted above `ShellInner`. As the outermost
 * element of `ShellInner`'s return, the shell PROVIDED the mailbox facts
 * and could not read them — fine while consumers were leaves, wrong once
 * the From line needed the facts on the wire: `sendReply` and the compose
 * plan are built in `ShellInner`, and a fact the shell cannot see is one
 * the mutation cannot carry. `mirrored` moved up because the provider
 * needs it. Nothing else moved; the existing consumers read a context,
 * not a position. `scope` is the host's, as the frame hands it: whose mail state this is.
 */
export function MailStateHost({ scope, probe, freshnessProbe, children }: { scope: string | null; probe?: MailboxProbe; freshnessProbe?: FreshnessProbe; children: ReactNode }) {
  const engine = useEngine();
  /* THE DERIVED STAMP, not the global version: the one thing this host computes is a count of
     messages, and a body landing moves neither the count nor anything under it. `children` is a
     stable element, so the provider re-rendering never reaches the shell — what this removes is
     the whole-mirror `list("message")` below, once per body publish. */
  const derived = useDerivedVersion();
  /**
   * EVERY message in the MIRROR — Screener, Reads and Receipts included, not the Ohbox's rows.
   *
   * What this DEVICE holds, and no longer the progress signal: the engine evicts past the window
   * as the pages land, so this pins at the window's floor while an import runs on. Sampled exactly
   * once — here — because two surfaces sampling their own could disagree about whether the mirror
   * is growing. The engine calls `notify()` once per drained page, so this is live with no extra
   * plumbing.
   */
  const mirrored = useMemo(() => engine.read().list("message").length, [engine, derived]);
  /**
   * AND HOW MUCH IT HAS TAKEN IN — the import's producer on this door. Counted at the sync
   * reader's own door, so eviction cannot move it; sampled on the SAME stamp as `mirrored`, so the
   * pair the provider derives from is read at one instant. The derived stamp and not the global
   * one for the same reason as the line above: a body landing moves neither number.
   */
  const received = useMemo(() => engine.receivedMessages(), [engine, derived]);
  return (
    <MailStateProvider scope={scope} probe={probe} freshnessProbe={freshnessProbe} mirrored={mirrored} received={received}>
      {children}
    </MailStateProvider>
  );
}
