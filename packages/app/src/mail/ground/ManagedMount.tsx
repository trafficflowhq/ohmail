"use client";

/**
 * MANAGED OR NOT, FOR EVERYTHING THE GROUND STANDS: whether the server behind this frame is the managed service, as
 * the host answers it (`host.capabilities.service`). Two sentences hang on it: what an unnamed server holder is
 * called, and whether a credit price is said. Moved from the old shell's frame (`TodaysFrame.tsx`, over
 * `todays-inputs.ts`'s `managedService`), where it stood above every view.
 *
 * THE OUTERMOST PIECE OF THE GROUND: every piece under it and every pane reads it. Absent, the context reads as
 * managed (the shipped wording), so a person on a server they run themselves would be shown credit prices.
 */
import type { ReactNode } from "react";
import { ManagedServiceContext } from "@ohmail/app-logic/doors/managed-service";
import { useFrame } from "../../frame/index.js";

export function ManagedMount({ children }: { readonly children: ReactNode }): ReactNode {
  const managed = useFrame().host.capabilities.service === "managed";
  return <ManagedServiceContext.Provider value={managed}>{children}</ManagedServiceContext.Provider>;
}
