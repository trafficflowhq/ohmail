/**
 * THE OHBOX'S PRESSES: a letter's verbs and the selection's (`useListVerbs` of `../press/`, fed here and spelled
 * nowhere else), read state through the one seam, and Mark all read with its true Undo.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useMemo } from "react";
import { doneSubjectIds, pileSubjectIds, pinsSpentBy } from "@ohmail/client-engine";
import { useConsent } from "../consent/consent-row.js";
import { usePartition } from "../consent/partition.js";
import { useDemoMode, useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { useListVerbs, type ListVerbs } from "../press/list-verbs.js";
import { rulesPostureOf } from "../press/rules-posture.js";
import { useStableCallback } from "../press/stable-callback.js";
import type { ListAnswer } from "../press/verb-context.js";
import { markSeenOver, type PressMarkSeen } from "../reader/mark-seen.js";
import { createReadSetMemo } from "../reading/conversation-on-screen.js";
import { usePresented } from "../reading/presented-mirror.js";
import { dispatchMarkAllRead, dispatchMarkAllUndo } from "../reading/read-all.js";
import type { Translator } from "../text/translator.js";
import { useNowAt } from "../session/day-clock.js";
import type { OhboxMirror } from "./live-mirror.js";

export interface OhboxVerbsInput {
  readonly args: PlaceLiveArgs;
  readonly mirror: OhboxMirror;
  /** The sentences the verbs say, by `namespace.key`. */
  readonly words: Translator;
  /** The one composer's doors for a letter, and the place's tag picker. */
  readonly answer: (how: ListAnswer, m: EngineMessage) => void;
  readonly pickTags: (ids: string[], anchor: HTMLElement | null) => void;
  /** Our own reply facing the row a letter was selected on, and the letter a Forward takes for an entered row. */
  readonly ownFaceFor: (m: EngineMessage) => EngineMessage | null;
  readonly forwardTargetFor: (m: EngineMessage) => EngineMessage;
}

export interface OhboxVerbs {
  readonly verbs: ListVerbs;
  readonly markSeen: PressMarkSeen;
  /** The unread members of the conversation the panels show, minus a resurfaced pin: what Mark as read writes. */
  readonly readSetFor: (messageId: string) => string[];
  readonly markAllRead: (ids: string[]) => void;
}

export function useOhboxVerbs(input: OhboxVerbsInput): OhboxVerbs {
  const { args, mirror, words } = input;
  const engine = useEngine();
  const demo = useDemoMode();
  const presented = usePresented();
  const { ownAddresses, firstImportDoneAt } = usePartition();
  const consent = useConsent();
  const { mailboxes: facts } = useMailState();
  const { press, route, plan, commands } = args;
  const markSeen = useMemo(() => markSeenOver(press), [press]);
  const readSetMemo = useMemo(() => createReadSetMemo(), []);
  const readSetFor = useStableCallback((id: string): string[] => readSetMemo(presented, engine.read(), id));
  const rulesTravel = useMemo(() => rulesPostureOf(facts), [facts]).mode === "pending";
  /* A dated sentence is made at the day the host says it is (the demo's), else now. */
  const nowAt = useNowAt();
  const verbs = useListVerbs({
    engine,
    press,
    t: words,
    toast: args.report,
    consent,
    demo,
    nowAt,
    tags: mirror.tags,
    ownAddresses,
    firstImportDoneAt,
    rulesTravel,
    surface: mirror.surface,
    markSeen,
    readSetFor,
    ownFaceFor: input.ownFaceFor,
    pileSetFor: (id, ohboxRow) => pileSubjectIds(presented, id, engine.openRowHeld(), ohboxRow),
    doneSetFor: (id) => doneSubjectIds(presented, id),
    pinsSpentFor: (filed) => pinsSpentBy(presented, filed),
    /* The letter that stands over the list on one column: a delete of ITS message closes it. */
    letterUp: plan.columns === 1 ? route.open : null,
    closeLetterUp: () => commands.open(null),
    /* Forward takes the row as it was entered: its open target then. */
    answer: (how, m) => input.answer(how, how === "forward" ? input.forwardTargetFor(m) : m),
    pickTags: input.pickTags,
  });
  const markAllRead = useStableCallback((ids: string[]) => {
    if (ids.length === 0) return;
    dispatchMarkAllRead((m) => engine.mutate(m), ids);
    /* A true undo rather than a confirm: it flips back exactly the ids this press flipped, so mail already read
       before the press stays read. Raised through the seam's own door, so `z` presses what the button presses. */
    press.undoToast(words("markAll.done", { count: ids.length }), {
      action: words("markAll.undo"),
      undo: true,
      onAction: () => void dispatchMarkAllUndo((m) => engine.mutate(m), ids, null),
      duration: 6000,
    });
  });
  return { verbs, markSeen, readSetFor, markAllRead };
}
