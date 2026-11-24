import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Answer } from "../contract.js";
import { gatedAsk, type GatedAnswer } from "../gated.js";
import {
  INVITES_START,
  invitesModelOf,
  invitesStep,
  type InvitesAct,
  type InvitesDoor,
  type InvitesEvent,
  type InvitesModel,
  type OpenInvite,
} from "./model.js";

const TAKEN = { ok: true } as const;
/** A door that gave no answer at all: nothing is known, so nothing is claimed beyond "it did not go through". */
const UNANSWERED = { ok: false, word: "said", said: "" } as const;

type Step = (event: InvitesEvent) => void;

/** The door's call for a verb, and what a verb that was taken did. A refusal is handed back as the door said it. */
async function sent(door: InvitesDoor, act: InvitesAct, step: Step): Promise<GatedAnswer> {
  if (act.kind === "make") {
    const made = await door.make(act.name);
    if (!made.ok) return made;
    step({ kind: "made", invite: made.value });
    return TAKEN;
  }
  const gone = await door.revoke(act.id);
  if (!gone.ok) return gone;
  step({ kind: "revoked" });
  return TAKEN;
}

/**
 * Invites' model over its door. Opening it reads the open invites, once. Every verb is TRIED first; only the
 * server's refusal asks the factor, whose verified answer sends the parked verb once more; a second such refusal is
 * the sign-in remedy. After a verb that was taken the list is read again, as the next call.
 *
 * A pane that was left sends nothing and steps nothing. The guard is armed in the effect, so a tree mounted twice
 * over still reads. The invite link lives in this state alone, from the door's answer until Done.
 */
export function useInvites(door: InvitesDoor): InvitesModel {
  /** The one place the state lives: each event is stepped from here as it arrives, never inside a state updater. */
  const held = useRef(INVITES_START);
  const [state, setState] = useState(INVITES_START);
  const alive = useRef(false);
  /** The reads asked so far: an answer is drawn only while no later read was asked. */
  const reads = useRef(0);

  /** The list, asked. A pane that was left asks nothing; an answer that a later read overtook is not drawn. */
  const read = useCallback(
    async (step: Step): Promise<void> => {
      if (!alive.current) return;
      reads.current += 1;
      const asked = reads.current;
      let answer: Answer<readonly OpenInvite[]>;
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
    function step(event: InvitesEvent): void {
      if (!alive.current) return;
      const next = invitesStep(held.current, event);
      held.current = next.state;
      setState(next.state);

      if (next.then === "copy" && next.state.made !== null) {
        void door.copy(next.state.made.link).then(
          (took) => step({ kind: "copied", took }),
          () => step({ kind: "copied", took: false }),
        );
      }
      if (next.run === null) return;
      const { act } = next.run;
      /** The verb, and after one that was taken the list again, before the verb counts as over. */
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
    return () => {
      alive.current = false;
    };
  }, [read, send]);

  const ask = useMemo(() => gatedAsk(state.gate, send), [state.gate, send]);
  return useMemo(() => invitesModelOf(state, ask, send), [state, ask, send]);
}
