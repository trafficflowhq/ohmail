/**
 * A stream's seen run over its MailList (`state/sweep.ts#SeenRun`): the gesture reports the list
 * takes, each a look when the person drives it, and what they mark goes to `mark`.
 */
import { useMemo, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { SeenRun, type SweepFrame } from "../state/sweep";

type ScrollEv = NativeSyntheticEvent<NativeScrollEvent>;

const viewOf = (e: ScrollEv) => ({
  y: e.nativeEvent.contentOffset.y,
  height: e.nativeEvent.layoutMeasurement.height,
});

export function useSeenRun(readLine: number, frames: () => Iterable<SweepFrame>, mark: (ids: string[]) => void) {
  const run = useRef<SeenRun | null>(null);
  run.current ??= new SeenRun(readLine);
  const at = useRef({ frames, mark });
  at.current = { frames, mark };
  const gestures = useMemo(() => {
    const r = run.current!;
    const send = (ids: string[]) => {
      if (ids.length > 0) at.current.mark(ids);
    };
    return {
      onScrollBeginDrag: () => r.drag(),
      onScroll: (e: ScrollEv) => send(r.scroll(viewOf(e), at.current.frames())),
      onScrollEndDrag: (e: ScrollEv) => send(r.lift(viewOf(e), at.current.frames())),
      onMomentumScrollBegin: () => r.glide(),
      onMomentumScrollEnd: (e: ScrollEv) => send(r.land(viewOf(e), at.current.frames())),
    };
  }, []);
  return { run: run.current, gestures };
}
