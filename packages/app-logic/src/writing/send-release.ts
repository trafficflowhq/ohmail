"use client";

import type { EngineMutation } from "@ohmail/wire";
import { createContext, useContext } from "react";
import {
  applySendAndDone, inverseMutations, narrowRead, releasePlanAt,
  type EntityReader, type MutationResult, type SendAndDonePlan,
} from "@ohmail/client-engine";

/** A retrying step keeps its original outbox receipt. This resolves to what reached the wire. */
export type FilingStep = boolean | { settled: Promise<EngineMutation | null> };

function undoFor(undo: EngineMutation[], applied: EngineMutation): EngineMutation[] {
  if (applied.kind !== "mark_seen") return undo;
  // The engine can narrow a waiting read when another press takes some of its messages.
  const ids = new Set(applied.messageIds);
  return undo.flatMap<EngineMutation>((inverse) => {
    if (inverse.kind === "triage_set") return ids.has(inverse.messageId) ? [inverse] : [];
    if (inverse.kind !== "mark_seen") return [inverse];
    const messageIds = inverse.messageIds.filter((id) => ids.has(id));
    return messageIds.length > 0 ? [narrowRead(inverse, messageIds)] : [];
  });
}

/**
 * SEND + DONE'S RELEASE ON THE WEB — the one door every road that confirms a send enters: the
 * live press, the backoff flush, the collector, and Try again on the strip. The release is read
 * from the PRESENTED mirror at this moment (`releasePlanAt`), never taken from the press.
 * `false` is nothing released: no Done is said and no Undo offered, and the caller says the
 * ordinary sentence. `true` means the release owns the report once filing settles.
 */
export function releaseSendAndDone(opts: {
  presented: EntityReader;
  intent: SendAndDonePlan;
  dispatch: (m: EngineMutation) => Promise<FilingStep>;
  say: (undo: EngineMutation[], complete: boolean, takeUndo: () => EngineMutation[]) => void;
}): boolean {
  const release = releasePlanAt(opts.presented, opts.intent);
  if (release === null) return false;
  const undo: EngineMutation[] = [];
  const say = (complete: boolean) => opts.say([...undo], complete, () => undo.splice(0));
  let late: (() => void) | undefined;
  void applySendAndDone(release, async (mutation) => {
    const inverse = inverseMutations(opts.presented, mutation);
    const step = await opts.dispatch(mutation);
    if (typeof step !== "boolean") {
      // Stop filing at this step, but keep its inverse until its own outbox write settles.
      late = () => {
        void step.settled.then((applied) => {
          if (applied === null) return;
          undo.unshift(...undoFor(inverse, applied));
          const fullStep = applied.kind !== "mark_seen" || mutation.kind !== "mark_seen"
            || applied.messageIds.length === mutation.messageIds.length;
          say(fullStep && mutation === release.mutations.at(-1));
        });
      };
      return false;
    }
    if (!step) return false;
    undo.unshift(...inverse);
    return true;
  }).then(
    (complete) => {
      say(complete);
      late?.();
    },
    () => say(false),
  );
  return true;
}

/** A confirmed result handed to the shell's door; one carrying no intent is ignored there. */
export type SendRelease = (res: MutationResult) => void;

const SendReleaseContext = createContext<SendRelease | null>(null);

/** Provided at the shell's root, above both strip mounts. */
export const SendReleaseProvider = SendReleaseContext.Provider;

/** `null` outside the shell: a strip with no shell above it releases nothing. */
export function useSendRelease(): SendRelease | null {
  return useContext(SendReleaseContext);
}
