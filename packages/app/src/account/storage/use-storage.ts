import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { gatedAsk } from "../gated.js";
import {
  STORAGE_START,
  storageChangeAnswer,
  storageModelOf,
  storageStep,
  type StorageAddon,
  type StorageDoor,
  type StorageEvent,
  type StorageModel,
} from "./model.js";

/** A change the door could not answer is one that did not leave: the shipped card said "failed" for every throw. */
const UNANSWERED = { ok: false, word: "failed" } as const;

/**
 * Storage's model over its door. Drawing it asks nothing: the figures are the access answer the shell already holds.
 * A press of the switch writes once and the switch holds what the server took; a press of Change plan or Add storage
 * tries the change, and only the server's refusal asks the factor, whose verified answer sends the parked change once.
 * A pane that was left sends nothing and steps nothing: the guard is armed in the effect, so a tree mounted twice over
 * still answers.
 */
export function useStorage(door: StorageDoor): StorageModel {
  const figures = useSyncExternalStore(door.figures.subscribe, door.figures.read, door.figures.read);
  /** The one place the state lives: each event is stepped from here, synchronously, so two in one tick stay two. */
  const held = useRef(STORAGE_START);
  const [state, setState] = useState(STORAGE_START);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback(
    function step(event: StorageEvent): void {
      if (!alive.current) return;
      const next = storageStep(held.current, event);
      held.current = next.state;
      setState(next.state);
      if (next.run === null) return;
      const { act } = next.run;
      void door.change(act === "change" ? undefined : act).then(
        (answer) => step({ kind: "answered", answer: storageChangeAnswer(answer) }),
        () => step({ kind: "answered", answer: UNANSWERED }),
      );
    },
    [door],
  );

  const change = useCallback((addon?: StorageAddon) => send({ kind: "try", act: addon ?? "change" }), [send]);
  const setMail = useCallback(
    (on: boolean) => {
      if (!alive.current || held.current.mail?.busy === true) return;
      send({ kind: "mailPressed", on });
      void door.setMail(on).then(
        (taken) => send({ kind: "mailAnswered", on, taken }),
        () => send({ kind: "mailAnswered", on, taken: false }),
      );
    },
    [door, send],
  );

  const ask = useMemo(() => gatedAsk(state.change, send), [state.change, send]);
  return useMemo(
    () => storageModelOf(state, figures, ask, { change, setMail }),
    [state, figures, ask, change, setMail],
  );
}
