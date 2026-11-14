import { useEffect, useRef, useState } from "react";

type LeaveQuestion = (ask: (leave: () => void) => void) => () => void;

/** The saved row decides when the question is released. A write in progress has not confirmed it. */
export function useDraftLeave(dirty: boolean, holdLeave: LeaveQuestion) {
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const hold = useRef(holdLeave);
  hold.current = holdLeave;
  useEffect(() => {
    if (dirty) return hold.current((resume) => setLeave(() => resume));
    setLeave(null);
  }, [dirty]);
  return {
    leaving: leave !== null,
    keep: () => setLeave(null),
    discard: () => {
      setLeave(null);
      leave?.();
    },
  };
}
