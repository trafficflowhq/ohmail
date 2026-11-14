import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Answer } from "../contract.js";
import { gatedAsk, type GatedAnswer } from "../gated.js";
import {
  DEVICES_START,
  devicesModelOf,
  devicesStep,
  type DevicesAct,
  type DevicesDoor,
  type DevicesEvent,
  type DevicesLists,
  type DevicesModel,
} from "./model.js";

const TAKEN = { ok: true } as const;
/** A door that gave no answer at all: nothing is known, so nothing is claimed beyond "it did not go through". */
const UNANSWERED = { ok: false, word: "said", said: "" } as const;

type Step = (event: DevicesEvent) => void;

/** The door's call for a verb, and what a verb that was taken did. A refusal is handed back as the door said it. */
async function sent(door: DevicesDoor, act: DevicesAct, step: Step): Promise<GatedAnswer> {
  switch (act.kind) {
    case "add": {
      const made = await door.add(act.name);
      if (!made.ok) return made;
      step({ kind: "made", link: made.value });
      return TAKEN;
    }
    case "revokeCode": {
      const gone = await door.revokeCode(act.id);
      if (!gone.ok) return gone;
      step({ kind: "revoked", id: act.id });
      return TAKEN;
    }
    case "remove": {
      const gone = await door.remove(act.id);
      if (!gone.ok) return gone;
      step({ kind: "removed" });
      return TAKEN;
    }
    case "signOutWeb": {
      const out = await door.signOutWeb();
      if (!out.ok) return out;
      step({ kind: "signedOutWeb", ended: out.value.ended });
      return TAKEN;
    }
  }
}

/**
 * Devices' model over its door. Opening it asks both lists, then whether the server groups the plain browser
 * sessions. Every verb is TRIED first; only the server's refusal asks the factor, whose verified answer sends the
 * parked verb once more; a second such refusal is the sign-in remedy. After a verb that was taken both lists are
 * read again, as the next call.
 *
 * A pane that was left sends nothing and steps nothing. The guard is armed in the effect, so a tree mounted twice
 * over still reads. The pairing link lives in this state alone, from the door's answer until Done or until its code
 * is revoked.
 */
export function useDevices(door: DevicesDoor): DevicesModel {
  /** The one place the state lives: each event is stepped from here as it arrives, never inside a state updater. */
  const held = useRef(DEVICES_START);
  const [state, setState] = useState(DEVICES_START);
  const alive = useRef(false);
  /** The reads asked so far: an answer is drawn only while no later read was asked. */
  const reads = useRef(0);

  /** Both lists, asked. A pane that was left asks nothing; an answer that a later read overtook is not drawn. */
  const read = useCallback(
    async (step: Step): Promise<void> => {
      if (!alive.current) return;
      reads.current += 1;
      const asked = reads.current;
      let answer: Answer<DevicesLists>;
      try {
        answer = await door.read();
      } catch {
        // A read that gave no answer is a read that failed.
        answer = UNANSWERED;
      }
      if (asked === reads.current) step({ kind: "read", answer });
    },
    [door],
  );

  const send = useCallback(
    function step(event: DevicesEvent): void {
      if (!alive.current) return;
      const next = devicesStep(held.current, event);
      held.current = next.state;
      setState(next.state);

      if (next.then === "read") void read(step);
      if (next.then === "copy" && next.state.made !== null) {
        void door.copy(next.state.made.link).then(
          (took) => step({ kind: "copied", took }),
          () => step({ kind: "copied", took: false }),
        );
      }
      if (next.run === null) return;
      const { act } = next.run;
      /** The verb, and after one that was taken both lists again, before the verb counts as over. */
      const performed = async (): Promise<GatedAnswer> => {
        const answer = await sent(door, act, step);
        if (answer.ok) await read(step);
        return answer;
      };
      void performed().then(
        (answer) => step({ kind: "answered", answer }),
        () => step({ kind: "answered", answer: UNANSWERED }),
      );
    },
    [door, read],
  );

  useEffect(() => {
    alive.current = true;
    void read(send);
    void door.groupsWebSessions().then(
      (groups) => send({ kind: "groups", groups }),
      // Not known: every session keeps a line of its own.
      () => send({ kind: "groups", groups: false }),
    );
    return () => {
      alive.current = false;
    };
  }, [door, read, send]);

  const ask = useMemo(() => gatedAsk(state.gate, send), [state.gate, send]);
  return useMemo(() => devicesModelOf(state, ask, send), [state, ask, send]);
}
