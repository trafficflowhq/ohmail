"use client";

/**
 * PULL NEW MAIL, BOUND ONCE A FRAME: the ground's one call of `usePullNewMail` (two calls are two latches, so two
 * flights), provided to every part below (`PullContext`): the rail's foot and its `p`, the Ohbox's list under a
 * finger and its menu. The settle watch reads the host's own mailbox read, as the ground's mail state reads it.
 */
import type { ReactNode } from "react";
import type { MailboxProbe } from "@ohmail/app-logic/mail-state";
import { PullContext, usePullNewMail } from "@ohmail/app-logic/session/pull-new-mail";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";

export function PullMount({ children }: { readonly children: ReactNode }): ReactNode {
  const { host } = useFrame();
  const probe = host.reads.mailboxes === NONE ? undefined : (host.reads.mailboxes as MailboxProbe);
  const binding = usePullNewMail(probe);
  return <PullContext.Provider value={binding}>{children}</PullContext.Provider>;
}
