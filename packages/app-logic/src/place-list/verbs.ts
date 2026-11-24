/**
 * THE VERBS RECORD OF A LIST PLACE THAT IS NOT THE OHBOX: a letter's verbs (`useListVerbs` of `../press/`, fed here
 * once and spelled nowhere else), read state through the one seam, the mirror's tags and the mail state's two facts.
 * The four lists beside the reader call it through their feed (`live.ts`); the piles call it themselves.
 *
 * Every press leaves through `args.press`, the frame's WHOLE seam. The place is not the Ohbox (`offOhbox`): no list
 * there holds the row, so a read names it to the engine, and Mark as read flips the one letter.
 *
 * WHO NEVER CALLS IT. The Ohbox keeps its own feed (`../ohbox/live-verbs.ts`: it alone feeds the read set, the reply
 * facing a row and Forward's target). Trash has no letter's verbs: its seam is the frame's with no delete, no move
 * and no raw dispatch, and `verbs.refuses.ts` holds that such a seam is refused here. A stream's items and Search
 * call no list verbs either.
 */
import { useMemo } from "react";
import { doneSubjectIds, pileSubjectIds, pinsSpentBy } from "@ohmail/client-engine";
import type { EngineMessage, TagDTO } from "@ohmail/wire";
import { useConsent } from "../consent/consent-row.js";
import { usePartition } from "../consent/partition.js";
import { atStamp, useDemoMode, useDerivedVersion, useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { useListVerbs, type ListVerbs } from "../press/list-verbs.js";
import { rulesPostureOf } from "../press/rules-posture.js";
import type { ListAnswer } from "../press/verb-context.js";
import { markSeenOver, type PressMarkSeen } from "../reader/mark-seen.js";
import { usePresented } from "../reading/presented-mirror.js";
import type { Translator } from "../text/translator.js";

export type { ListAnswer };

/** What only a seat can read, for the verbs: their sentences, the composer's doors and the place's tag picker. */
export interface PlaceVerbsOwn {
  /** The sentences a letter's verbs say, by `namespace.key`: `ohbox`, `screening`, `session` and `tag`. */
  readonly words: Translator;
  /** The one composer's doors for a letter. Nothing is sent from a list. */
  readonly answer: (how: ListAnswer, m: EngineMessage) => void;
  /** The place's tag picker, pointed at a set of letters. */
  readonly pickTags: (ids: string[], anchor: HTMLElement | null) => void;
}

export interface PlaceVerbs {
  /** A letter's verbs and a selection's, through the seam. */
  readonly verbs: ListVerbs;
  /** Read state through the seam, answering whether the press stands. */
  readonly markSeen: PressMarkSeen;
  /** The mirror's tags, as the stamp of the mirror read them. */
  readonly tags: readonly TagDTO[];
  /** The mail state's two facts: may a list say it is empty, and is an answer still owed. */
  readonly settled: boolean;
  readonly owed: boolean;
}

/**
 * `surface`: the rows the place shows past the mirror (History's store pages), by which a verb resolves a row the
 * mirror does not hold; none where every row is the presented mirror's own.
 */
export function usePlaceVerbs(
  args: PlaceLiveArgs,
  own: PlaceVerbsOwn,
  surface: readonly EngineMessage[],
): PlaceVerbs {
  const engine = useEngine();
  const demo = useDemoMode();
  const derived = useDerivedVersion();
  const presented = usePresented(); // throws where no ground stands above
  const { ownAddresses, firstImportDoneAt } = usePartition(); // throws where no ground stands above
  const consent = useConsent(); // throws where no ground stands above
  const { state: mail, mailboxes: facts } = useMailState();
  const { press, route, plan, commands } = args;
  const markSeen = useMemo(() => markSeenOver(press), [press]);
  const tags = useMemo(() => atStamp(derived, engine.read().list<TagDTO>("tag")), [engine, derived]);
  const rulesTravel = useMemo(() => rulesPostureOf(facts), [facts]).mode === "pending";
  const verbs = useListVerbs({
    engine,
    press,
    t: own.words,
    toast: args.report,
    consent,
    demo,
    nowAt: () => new Date(),
    tags,
    ownAddresses,
    firstImportDoneAt,
    rulesTravel,
    offOhbox: true,
    surface,
    markSeen,
    pileSetFor: (id, ohboxRow) => pileSubjectIds(presented, id, engine.openRowHeld(), ohboxRow),
    doneSetFor: (id) => doneSubjectIds(presented, id),
    pinsSpentFor: (filed) => pinsSpentBy(presented, filed),
    /* The letter that stands over the list on one column: a delete of ITS message closes it. */
    letterUp: plan.columns === 1 ? route.open : null,
    closeLetterUp: () => commands.open(null),
    answer: own.answer,
    pickTags: own.pickTags,
  });
  return { verbs, markSeen, tags, settled: mail.settled, owed: mail.owed };
}
