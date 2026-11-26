"use client";

/**
 * THE APP TIMES ITSELF, from the frame's first draw: the startup marks, the three interaction percentiles and the frame
 * sampler, reported every five minutes (`ui-vitals.ts` carries the reasoning). Always on, no flag: an instrument that
 * has to be turned on is one that was off during the incident. Moved from the old shell as it stood
 * (`AppShell.tsx`: `useUiVitals()`, and the mark of a usable list).
 *
 * "COLD START TO A USABLE LIST", the budget's own measure, marked once: MAIL ON SCREEN, not a completed drain.
 * `pulled` is the mirror's own row count, so the first draw holding mail marks; an EMPTY mailbox still owes a drain
 * before "nothing here" is a fact, and `settled` is that case, which keeps a new account markable. `markStartup` takes
 * the first answer, so a mount again cannot overwrite a cold figure.
 */
import { useEffect } from "react";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { markStartup, useUiVitals } from "@ohmail/app-logic/session/ui-vitals";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { prepareWriting } from "../../write/rich-entry.js";
import { preloadMailSettings } from "../panes.js";

export function useStartupMarks(): void {
  useUiVitals();
  const { pulled, state: mailState } = useMailState();
  const { host, route } = useFrame();
  const usable = pulled > 0 || mailState.settled;
  const demo = host.session.today !== NONE;
  useEffect(() => {
    if (!usable) return;
    markStartup("listUsable");
    if (route.place !== "ohbox") return;
    // Give the enabled list a paint before preparing any optional views.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void prepareWriting().catch(() => {});
        if (!demo) preloadMailSettings();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [usable, route.place, demo]);
}
