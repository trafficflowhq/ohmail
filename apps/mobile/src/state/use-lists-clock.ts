/**
 * The provider's half of `world-clock.ts`: a beat that moves at the next edge a list reads, armed
 * again whenever the mailbox or the zone moves, ticking at once on a resume past the edge, and a
 * zone read again on resume. The world's projection lists the beat among its dependencies.
 */
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { readerZone, type EntityReader } from "./live";
import { nextClockEdge, worldClock } from "./world-clock";

export function useListsClock(opts: {
  engine: { read(): EntityReader } | null;
  zone: string;
  derivedStamp: number;
  onZone: (zone: string) => void;
}): number {
  const { engine, zone, derivedStamp, onZone } = opts;
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (engine === null) return undefined;
    const clock = worldClock({ edge: () => nextClockEdge(engine.read(), new Date(), zone), tick: () => setBeat((n) => n + 1) });
    clock.arm();
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const here = readerZone();
      if (here !== zone) onZone(here);
      else clock.resume();
    });
    return () => { clock.stop(); sub.remove(); };
  }, [engine, zone, derivedStamp, beat, onZone]);
  return beat;
}
