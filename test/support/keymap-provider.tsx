"use client";

import type { ReactNode } from "react";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
import "../../packages/app/src/frame/touch-keys.css";

/** Mount the frame's keyboard registry around a component exercised on its own. */
export function KeymapProvider({ children }: { children: ReactNode }) {
  return <KeymapContext.Provider value={useKeymapStore()}>{children}</KeymapContext.Provider>;
}
