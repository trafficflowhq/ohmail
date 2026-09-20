"use client";

/**
 * Move, File and Junk, with an Undo in the toast. The press is TWO HALVES and one sentence: the
 * mail moves now through the ordinary `move` (the engine builds that reversal), and the ROUTING —
 * the rule written or retargeted — is a DELAYED COMMIT held by the engine's routing window. Undo
 * puts the mail back and drops the intent in one press; nothing about the routing's wire changes,
 * it is simply sent when the window closes. The window is `UNDO_MS`, imported, never a second
 * number, and `presentAt` shows the named rows where they were filed while the wire waits.
 */

/**
 * THE PLAN IS RE-READ HERE, AT THE COMMIT. `routing-intents.ts` states why the journal may not
 * hold mutations; this is the other half of it — the same ladder the press used, asked again of
 * the mirror as it is now. Its three answers are each said rather than swallowed: the seed
 * message is gone, the rule is already standing (the ladder writes nothing), or the rule was
 * written and the server had something to say about it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FOLDER_OF_VIEW,
  createRoutingWindow,
  routingIntentsKey,
  routingSubject,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type MutationStatus,
  type RoutingIntent,
  type RoutingOpen,
  type ScreenDest,
  type TabWindows,
} from "@ohmail/client-engine";
import { localStorageDoor } from "./durable";
import { storageOwner } from "./storage-owner";
import { UNDO_MS } from "./screener-state";
import {
  planScreeningChange,
  screeningToast,
  senderScreening,
  worstStatus,
  type ScreeningPlan,
  type ScreeningToastKey,
} from "./sender-screening";

export { UNDO_MS };

/**
 * ENOUGH OF THE PRESS TO CORRECT ITS OWN SENTENCE, and no more. The press-time toast is the
 * optimistic one (`screeningToast(plan, null)`) because the rule has not been sent yet; when the
 * window closes and the server refuses or defers, the window owes the correction, and a
 * correction takes the same placeholders the sentence took. Held in memory beside the open
 * window and never journalled: a press replayed at the next launch has no toast to correct, and
 * writing a reader's correspondents into `localStorage` to phrase one would be the wrong trade.
 */
export interface RoutingNote {
  sender: string;
  place: string;
  count: number;
}

/** The sentences this module raises. Resolved by the caller, so the catalogue is read once. */
export interface RoutingUndoCopy {
  /**
   * The seed message left the mirror before the window closed, so the ladder cannot be asked
   * about it. Said rather than dropped: the reader was promised a rule.
   */
  gone: string;
  /** A press that died of age while the app was closed — said, never swept in silence. */
  expired: (count: number) => string;
  /** The server's own answer, when it differs from what the press said. */
  correction: (key: ScreeningToastKey, note: RoutingNote) => string;
}

/** One routing press, as the shell hands it over. */
export interface RoutingPressInput {
  /** A press id — minted per press, and the id the coordinator names it by. */
  id: string;
  /** The message the plan was seeded from, and the address it was about. */
  seedId: string;
  address: string;
  /** Where the press files, in the planner's vocabulary. */
  dest: ScreenDest;
  /**
   * The messages this press NAMED, shown at `dest` while the window runs — the ids the caller
   * pressed on, never the sender's whole backlog: the overlay is a promise about what the press
   * did, and promising more than it did is the defect it exists to prevent.
   */
  messageIds: readonly string[];
  /** The placeholders a correction would take. */
  note: RoutingNote;
}

export interface RoutingUndo {
  /** Hold one press. Answers whether an Undo may be offered over it. */
  hold: (press: RoutingPressInput) => RoutingOpen;
  /** The subject a press is about — what {@link RoutingUndo.undo} takes. */
  subjectOf: (address: string) => string;
  /** Take the press on this subject back: the intent is dropped, nothing was sent. */
  undo: (subject: string) => boolean;
  /** Where held presses are showing their mail — composed into the presentation reader. */
  places: ReadonlyMap<string, Folder>;
}

export interface RoutingUndoDeps {
  /** The mirror, read at the COMMIT — never a reader captured when the press was made. */
  read: () => EntityReader;
  /** The surface's filing dispatch. One mutation, one answer. */
  send: (m: EngineMutation) => Promise<{ status: MutationStatus }>;
  toast: (sentence: string) => void;
  copy: RoutingUndoCopy;
  /** The cross-tab coordinator. Absent is "one window on this device", and it is said. */
  windows?: TabWindows | undefined;
  /** The journal's owner, read at BUILD time like every other owner-keyed store. */
  owner?: string | null;
  windowMs?: number;
  now?: () => number;
  /** `false` on a surface with no server to carry a rule to — the demo. */
  enabled?: boolean;
}

const NO_PLACES: ReadonlyMap<string, Folder> = new Map();

/**
 * THE SHELL'S BINDING — the window behind a memo, the overlay as React state, and the two places
 * a held press may not simply evaporate (`useDeleteUndo`'s shape, and for its reasons).
 */
export function useRoutingUndo(deps: RoutingUndoDeps): RoutingUndo {
  const [places, setPlaces] = useState<ReadonlyMap<string, Folder>>(NO_PLACES);
  /* THE DEPS ARE READ THROUGH A REF, never closed over: `toast`, `copy` and `send` change
     identity on most renders, and rebuilding the window would drop every armed timer — a press
     silently un-filed by an unrelated re-render. */
  const latest = useRef(deps);
  latest.current = deps;
  /** The press's own note, for the correction. Keyed by press id, dropped when it settles. */
  const notes = useRef(new Map<string, RoutingNote>());
  /**
   * The plan the commit just built, handed from `plan` to `dispatch`. They run back to back
   * inside one commit, so this is a hand-off and not state: re-planning in both would ask the
   * mirror twice and could answer twice. `null` is the seed-is-gone answer, told apart from
   * "the ladder had nothing to write".
   */
  const built = useRef(new Map<string, ScreeningPlan | null>());

  const window_ = useMemo(() => createRoutingWindow({
    door: localStorageDoor("routing.intents"),
    key: routingIntentsKey(latest.current.owner ?? storageOwner()),
    windowMs: latest.current.windowMs ?? UNDO_MS,
    ...(latest.current.windows ? { windows: latest.current.windows } : {}),
    ...(latest.current.now ? { now: () => latest.current.now!() } : {}),

    plan: (i) => {
      /* SENDER SCOPE AND NO RETRO — `planMoveToPlace`'s own arguments, because this IS that
         press, asked again of the mirror as it now is. */
      const sender = senderScreening(latest.current.read(), i.seedId, i.address);
      if (!sender) { built.current.set(i.id, null); return []; }
      const plan = planScreeningChange(sender, i.dest, "sender", true, false);
      built.current.set(i.id, plan);
      return plan.ruleMutations;
    },

    dispatch: async (mutations, i) => {
      const plan = built.current.get(i.id);
      const note = notes.current.get(i.id);
      built.current.delete(i.id);
      notes.current.delete(i.id);
      if (plan === null) { latest.current.toast(latest.current.copy.gone); return; }
      if (plan === undefined) return;
      const results = await Promise.all(mutations.map((m) => latest.current.send(m)));
      /**
       * THE WINDOW SPEAKS ONLY FOR THE SERVER, and `confirmed` is not something to say. The press
       * raised its sentence long ago; what it cannot have said is what the server did with the
       * rule seconds later — refused it, queued it here, or recorded it for the organizing
       * install — so those three, and only those, earn a second sentence.
       */
      /* Keyed on the STATUS and never on the sentence: the commit re-plans, and a re-plan's key
         legitimately differs from the press's (the press moved mail this plan does not carry), so
         comparing the two words raised a correction after every ordinary success. */
      const worst = worstStatus(results);
      if (worst === null || worst === "confirmed") return;
      const key = screeningToast(plan, worst);
      if (note) latest.current.toast(latest.current.copy.correction(key, note));
    },

    onPending: (openIntents) => {
      const next = new Map<string, Folder>();
      for (const i of openIntents) {
        const folder = FOLDER_OF_VIEW[i.dest];
        if (!folder) continue;
        for (const id of i.messageIds) next.set(id, folder);
      }
      setPlaces(next);
    },
  }), []);

  /**
   * LEAVING COMMITS, and the boot finishes what a killed tab started. `pagehide` rather than
   * `beforeunload` for `useDeleteUndo`'s reason; whatever it does not get out is replayed here at
   * the next launch — committed if its window elapsed, resumed with the time it had left if not,
   * skipped if another tab owns it, and REPORTED if it died of age.
   */
  const replayed = useRef(false);
  const enabled = deps.enabled ?? true;
  useEffect(() => {
    if (enabled && !replayed.current) {
      replayed.current = true;
      void window_.replay((latest.current.now ?? Date.now)()).then((seen) => {
        if (seen.expired.length > 0) {
          latest.current.toast(latest.current.copy.expired(seen.expired.length));
        }
      });
    }
    const commitAll = (): void => { window_.flush(); };
    globalThis.window?.addEventListener("pagehide", commitAll);
    return () => {
      globalThis.window?.removeEventListener("pagehide", commitAll);
      commitAll();
    };
  }, [window_, enabled]);

  return {
    places,
    subjectOf: useCallback((address: string) => routingSubject({ scope: "sender", address }), []),
    hold: useCallback((press: RoutingPressInput): RoutingOpen => {
      const intent: RoutingIntent = {
        v: 1,
        id: press.id,
        seedId: press.seedId,
        address: press.address,
        scope: "sender",
        dest: press.dest,
        messageIds: [...press.messageIds],
        at: (latest.current.now ?? Date.now)(),
      };
      notes.current.set(press.id, press.note);
      const out = window_.open(intent);
      /* A press the jar refused has already been sent and its note consumed; clearing it here is
         the belt for a dispatch that threw before it could — a map that only grows is a leak
         with a reader's correspondent in it. */
      if (!out.held) notes.current.delete(press.id);
      return out;
    }, [window_]),
    undo: useCallback((subject: string) => window_.undo(subject), [window_]),
  };
}
