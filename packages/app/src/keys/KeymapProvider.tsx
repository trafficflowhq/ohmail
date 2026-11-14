"use client";

import type { ReactNode } from "react";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
/* The rules that stop key hints being shown on devices with no keys. It rides with the
   registry rather than with any one component because the chrome it hides is spread across the
   shell, the dock and the reading overlay, and this module is the one thing that is in the
   bundle whenever any of them are. `AppShell` imports it; it never renders conditionally. */
import "./touch-keys.css";

/** The keyboard registry's one provider: the dispatcher is `useKeymapStore`, this file mounts it with its stylesheet. */
export function KeymapProvider({ children }: { children: ReactNode }) {
  return <KeymapContext.Provider value={useKeymapStore()}>{children}</KeymapContext.Provider>;
}
