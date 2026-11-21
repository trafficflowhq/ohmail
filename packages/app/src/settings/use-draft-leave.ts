import { useLayoutEffect, useRef, useState } from "react";
import type { AskLeave } from "../host/device.js";

type LeaveQuestion = (ask: AskLeave) => () => void;
type Choice = { leave: Parameters<AskLeave>[0]; physical: Parameters<AskLeave>[1] };

/** The saved row decides when the question is released. A write in progress has not confirmed it. */
export function useDraftLeave(dirty: boolean, holdLeave: LeaveQuestion, revision: unknown) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const hold = useRef(holdLeave);
  hold.current = holdLeave;
  const physicalChoice = useRef<Choice["physical"]>(undefined);
  const lastRevision = useRef(revision);
  useLayoutEffect(() => {
    if (Object.is(lastRevision.current, revision)) return;
    lastRevision.current = revision;
    physicalChoice.current?.keep();
    physicalChoice.current = undefined;
  }, [revision]);
  useLayoutEffect(() => {
    if (!dirty) {
      setChoice(null);
      return;
    }
    let detach = () => {};
    const release = hold.current((leave, physical) => {
      detach();
      if (physicalChoice.current !== physical) physicalChoice.current?.keep();
      physicalChoice.current = physical;
      const incoming = { leave, physical };
      const cancel = () => setChoice((current) => (current === incoming ? null : current));
      if (physical?.signal.aborted) return setChoice(null);
      physical?.signal.addEventListener("abort", cancel, { once: true });
      detach = () => physical?.signal.removeEventListener("abort", cancel);
      setChoice(incoming);
    });
    return () => {
      physicalChoice.current?.keep();
      physicalChoice.current = undefined;
      detach();
      release();
    };
  }, [dirty]);
  return {
    leaving: choice !== null,
    keep: () => {
      setChoice(null);
      choice?.physical?.keep();
    },
    discard: (drop: () => void) => {
      if (!choice || choice.physical?.signal.aborted) return;
      setChoice(null);
      if (choice.physical) choice.leave(drop);
      else {
        drop();
        choice.leave();
      }
    },
  };
}
