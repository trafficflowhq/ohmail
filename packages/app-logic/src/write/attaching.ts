import { useCallback, useEffect, useRef, useState } from "react";
import { holdFilesForRestart } from "../doors/app-update.js";

/** The names of the picks still being read; a pick being read holds an app restart. */
export function useAttaching(stands: () => boolean) {
  const [attaching, setAttaching] = useState<readonly string[]>([]);
  const inFlight = useRef(new Map<number, readonly string[]>());
  const seq = useRef(0);
  const restart = useRef<(() => void) | null>(null);
  const report = useCallback((): void => {
    const names = [...inFlight.current.values()].flat();
    const mounted = stands();
    if (names.length > 0 && mounted) restart.current ??= holdFilesForRestart();
    else {
      restart.current?.();
      restart.current = null;
    }
    if (mounted) setAttaching(names);
  }, [stands]);
  useEffect(
    () => () => {
      restart.current?.();
      restart.current = null;
    },
    [],
  );
  const begin = useCallback(
    (names: readonly string[]) => {
      const pick = ++seq.current;
      const setNames = (next: readonly string[]): void => {
        inFlight.current.set(pick, next);
        report();
      };
      setNames(names);
      return {
        setNames,
        end: () => {
          if (inFlight.current.delete(pick)) report();
        },
      };
    },
    [report],
  );
  return { attaching, begin };
}
