"use client";

import { createContext, useContext } from "react";
import {
  applySendAndDone, releasePlanAt,
  type EngineMutation, type EntityReader, type MutationResult, type SendAndDonePlan,
} from "@ohmail/client-engine";

/**
 * SEND + DONE'S RELEASE ON THE WEB — the one door every road that confirms a send enters: the
 * live press, the backoff flush, the collector, and Try again on the strip. The release is read
 * from the PRESENTED mirror at this moment (`releasePlanAt`), never taken from the press.
 * `false` is nothing released: no Done is said and no Undo offered, and the caller says the
 * ordinary sentence. `true` is released, and the sentence with its Undo follows the dispatch.
 */
export function releaseSendAndDone(opts: {
  presented: EntityReader;
  intent: SendAndDonePlan;
  dispatch: (m: EngineMutation) => Promise<boolean>;
  say: (undo: EngineMutation[]) => void;
}): boolean {
  const release = releasePlanAt(opts.presented, opts.intent);
  if (release === null) return false;
  void applySendAndDone(release, opts.dispatch).then((filed) => { if (filed) opts.say(release.undo); });
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
