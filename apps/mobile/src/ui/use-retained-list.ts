import { useLayoutEffect, useRef } from "react";

/** Keep the mounted list quiet while covered. The first focused commit uses current props. */
export function useRetainedList<T>(list: T, focused: boolean, worldKey: string): T {
  const last = useRef<{ worldKey: string; list: T } | null>(null);
  const shown = !focused && last.current?.worldKey === worldKey ? last.current.list : list;
  useLayoutEffect(() => { last.current = { worldKey, list: shown }; }, [worldKey, shown]);
  return shown;
}
