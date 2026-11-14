"use client";

/**
 * THE OHBOX's VISIT MARK, written by the ground: when the person leaves the Ohbox for another place (or the tab goes
 * hidden, or the page goes), the engine's mark moves, so what the sender rules filed elsewhere since is counted from
 * there next time. On the ground and not in the Ohbox's seat, which leaves with the walk away: the hook writes when
 * its `open` turns false, never on an unmount. A letter opened at the Ohbox is no leave. Never on the demo, as the old
 * shell had it (`useOhboxVisitMark(demo ? null : engine, !demo && view === "ohbox")`).
 */
import { useEngineOrNull, useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { useOhboxVisitMark } from "@ohmail/app-logic/reading/ohbox-visit";
import { useFrame } from "../../frame/index.js";

export function useOhboxVisitAtBoot(): void {
  const engine = useEngineOrNull();
  const demo = useResolvedDemoMode();
  const { route } = useFrame();
  useOhboxVisitMark(demo ? null : engine, !demo && route.place === "ohbox");
}
