"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "@ohmail/ui";
import { localStorageDoor } from "../shell/durable";
import { SignupProvider } from "./components/Signup";

/* The same door the product door mounts — one origin, one coherent device (see below). */
const THEME_DOOR = localStorageDoor("theme");

export function Providers({ children }: { children: ReactNode }) {
  return (
    /* `faces` — the paper/ohmarchy axis is active here since the landing wired its own
       face controls (the FaceToggle above the headline; §5's slice): a Linux visitor now
       has a way back, which was the review-caught reason this host once opted out. The
       storage keys are the provider defaults — the SAME `ohmail.face` device pin the
       product door reads, one origin, one coherent device. The pre-paint stamp is the
       marketing root's inline boot script. */
    <ThemeProvider storageKey="ohmail.theme" faces storage={THEME_DOOR}>
      <SignupProvider>{children}</SignupProvider>
    </ThemeProvider>
  );
}
