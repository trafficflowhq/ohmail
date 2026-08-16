"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "@ohmail/ui";
import { SignupProvider } from "./components/Signup";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider storageKey="ohmail.theme">
      <SignupProvider>{children}</SignupProvider>
    </ThemeProvider>
  );
}
