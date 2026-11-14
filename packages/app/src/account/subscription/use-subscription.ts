import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NONE } from "../../host/index.js";
import {
  subscriptionModelOf,
  subscriptionStart,
  subscriptionStep,
  type PlanInterval,
  type PlanPick,
  type SubscriptionDoor,
  type SubscriptionEvent,
  type SubscriptionModel,
} from "./model.js";

/** A read the door could not answer is one whose prices could not be read. */
const UNREAD = { ok: false, word: "plans_unavailable" } as const;

/**
 * Subscription's model over its door. Opening it makes no address: the standing is the access answer the shell
 * already holds, and the plans are asked once as the pane opens, where the host has their read (a new standing asks
 * nothing again). The press makes the address, one at a time; the door leaves for it, and only what the press came
 * to is said here. A pane that was left steps nothing: the guard is armed in the effect, so a tree mounted twice over
 * still answers.
 */
export function useSubscription(door: SubscriptionDoor): SubscriptionModel {
  const status = useSyncExternalStore(door.status.subscribe, door.status.read, door.status.read);
  const held = useRef(subscriptionStart(door.plans !== NONE));
  const [state, setState] = useState(held.current);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const step = useCallback((event: SubscriptionEvent): void => {
    if (!alive.current) return;
    held.current = subscriptionStep(held.current, event);
    setState(held.current);
  }, []);

  const read = door.plans;
  const askPlans = useCallback(() => {
    if (read === NONE) return;
    step({ kind: "plansAsked" });
    void read().then(
      (answer) => step({ kind: "plansAnswered", answer }),
      () => step({ kind: "plansAnswered", answer: UNREAD }),
    );
  }, [read, step]);
  useEffect(() => askPlans(), [askPlans]);

  const manage = useCallback(
    (pick?: PlanPick) => {
      if (!alive.current || held.current.opening) return;
      step({ kind: "pressed" });
      void door.manage(pick).then(
        (outcome) => step({ kind: "managed", outcome }),
        () => step({ kind: "managed", outcome: "failed" }),
      );
    },
    [door, step],
  );
  const choose = useCallback((interval: PlanInterval) => step({ kind: "chosen", interval }), [step]);
  const retryPlans = useCallback(() => {
    if (held.current.plans.at === "unavailable") askPlans();
  }, [askPlans]);

  return useMemo(
    () => subscriptionModelOf(state, status, { choose, manage, retryPlans }),
    [state, status, choose, manage, retryPlans],
  );
}
