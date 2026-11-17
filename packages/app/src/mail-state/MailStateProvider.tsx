"use client";

/**
 * The mail state's one mount: it publishes the binding `useMailStateBinding` makes to everything under it.
 * The context is the binding's own, taken from its file: a second context here would leave `useMailState()`
 * throwing under a mounted provider.
 */

import type { ReactNode } from "react";
import { MailStateContext, useMailStateBinding, type MailStateInput } from "@ohmail/app-logic/mail-state";

export function MailStateProvider({ children, ...input }: MailStateInput & { children: ReactNode }) {
  return <MailStateContext.Provider value={useMailStateBinding(input)}>{children}</MailStateContext.Provider>;
}
