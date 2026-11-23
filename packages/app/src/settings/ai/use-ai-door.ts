import { useEffect, useRef, useState } from "react";
import { useText } from "../../text/index.js";
import { AI_START, aiStep, type AiDoor, type AiModel } from "./model.js";

/** One state for the account switch and the consent write that can report a failure on the same sheet. */
export function useAiDoor(door: AiDoor | null): {
  model: AiModel;
  saveDraft(write: () => Promise<void>): void;
} {
  const text = useText("settings");
  const [state, setState] = useState(AI_START);
  const life = useRef<AbortController | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    setState(AI_START);
    if (!door) return;
    const current = new AbortController();
    life.current = current;
    const unreadable = () => {
      if (!current.signal.aborted)
        setState((s) => aiStep(s, { kind: "unreadable", said: text("aiUnreadable") }));
    };
    void door.read().then((enabled) => {
      if (typeof enabled !== "boolean") unreadable();
      else if (!current.signal.aborted) setState((s) => aiStep(s, { kind: "read", enabled }));
    }, unreadable);
    void door.model().then(
      (model) => {
        if (model === false && !current.signal.aborted) setState((s) => aiStep(s, { kind: "noModel" }));
      },
      () => {},
    );
    return () => current.abort();
  }, [door, text]);

  const save = async (next: boolean | null, write?: () => Promise<void>) => {
    const current = life.current;
    if (!door || !current || current.signal.aborted || pending.current === current || state.enabled === null)
      return;
    pending.current = current;
    const back = state.enabled;
    setState((s) => aiStep(s, { kind: "press", next: next ?? back }));
    try {
      if (next === null) await write?.();
      else {
        const enabled = await door.set(next);
        if (typeof enabled !== "boolean") throw new Error("Missing AI setting");
        if (!current.signal.aborted) setState((s) => aiStep(s, { kind: "answered", enabled }));
      }
    } catch (error) {
      if (!current.signal.aborted)
        setState((s) => aiStep(s, { kind: "refused", back, said: door.messageFor(error) }));
    } finally {
      if (pending.current === current) pending.current = null;
    }
  };
  return {
    model: { ...state, toggle: (next) => void save(next) },
    saveDraft: (write) => void save(null, write),
  };
}
