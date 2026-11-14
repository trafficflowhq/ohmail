/**
 * THE SCREENER'S VIEW: what one section shows and what a press in it does, over the frame's one model. `decide` is
 * the only call of the model's `decide`: the panel, a key, a menu, the card and a row's place all go through it, so a
 * decision leaves once and the next sender opens below it. Of the engine it asks only for the open letters' bodies;
 * selecting a sender reads nothing and marks nothing read.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { senderKey, type FailedAtGateDTO, type ScreenerSenderDTO } from "@ohmail/client-engine";
import { useEngineOrNull } from "../engine/context.js";
import type { KeyBinding } from "../keys/binding.js";
import type { DecisionDestination, DecisionScope } from "./decision.js";
import {
  acceptDestOf,
  activeFilterOf,
  filterChoices,
  filterCounts,
  filterGroupOf,
  type FilterCounts,
  type ScreenerFilterId,
} from "./filter.js";
import { screenerKeys, type KeySegment, type ScreenerKeyWords } from "./keys.js";
import { defaultScopeOf } from "./reach.js";
import type { ScreenerState } from "./screener-state.js";
import type { SpamRow } from "./spam-row.js";
import { firstOf, refused, useAllSpamAsk, useDecide, useHeldBodies, useShown, walk } from "./view-parts.js";

export type ViewRow = ScreenerSenderDTO | SpamRow;

export interface ScreenerViewInput {
  readonly state: ScreenerState;
  readonly segment: KeySegment;
  /** The sender open in this section, kept above the list for the frame's life. */
  readonly selected: string | null;
  readonly select: (id: string | null) => void;
  readonly go: (segment: KeySegment) => void;
  /** The frame's one undo door: true where it took something back. */
  readonly undo: () => boolean;
  readonly words: ScreenerKeyWords;
  /** One column: the open sender stands over the list, and Escape takes it down. */
  readonly oneColumn: boolean;
}

/** What is asked of the person now, over the list. */
export type ScreenerAsk =
  | { readonly kind: "allSpam"; readonly senders: readonly ScreenerSenderDTO[] }
  /** Screen out or Spam where the press would send a one-click unsubscribe: asked before anything leaves. */
  | {
      readonly kind: "unsub";
      readonly sender: ScreenerSenderDTO;
      readonly dest: "screened" | "spam";
      readonly read: boolean;
    }
  | null;
/**
 * What stands open beside the open sender: its place menu, the scope's menu, its More menu, the row's menu, its
 * card; or the filter's menu over the queue.
 */
export type ScreenerShown = "place" | "scope" | "more" | "row" | "card" | "filter" | null;

export interface ScreenerView {
  readonly segment: KeySegment;
  /** The section's rows, in the order they are drawn and walked. */
  readonly rows: readonly ViewRow[];
  /** Senders decided here that the organizer has not carried out yet: drawn under the queue. */
  readonly decided: ScreenerState["decided"];
  readonly filter: {
    readonly counts: FilterCounts;
    readonly active: ScreenerFilterId | null;
    readonly choices: readonly ScreenerFilterId[];
    readonly choose: (id: ScreenerFilterId | null) => void;
  };
  /** The open row's id, and the row itself. */
  readonly openId: string | null;
  readonly open: ViewRow | null;
  /** On one column, the open sender stands over the list. */
  readonly full: boolean;
  readonly shown: ScreenerShown;
  readonly show: (what: ScreenerShown) => void;
  /** Open a row; `then` opens a menu or the card of it in the same press (a right click). */
  readonly select: (id: string, then?: ScreenerShown) => void;
  readonly close: () => void;
  readonly scopeOf: (sender: ScreenerSenderDTO) => DecisionScope;
  readonly setScope: (sender: ScreenerSenderDTO, scope: DecisionScope) => void;
  /** The open waiting sender's decision. Refused where this install may not decide: the selection stays. */
  readonly decide: (dest: DecisionDestination, read: boolean) => void;
  /** Where the open sender's accept files them; null with no real suggestion. */
  readonly accept: DecisionDestination | null;
  /**
   * A waiting row's own accept, by its id: the open sender's decision for the open one; for another the press alone,
   * or first the unsubscribe question about that sender where one would go out.
   */
  readonly acceptRow: (id: string) => void;
  readonly ask: ScreenerAsk;
  /** Mark all spam asks first: nothing leaves, and no unsubscribe is asked, before the yes. */
  readonly askAllSpam: () => void;
  readonly answerAllSpam: (yes: boolean) => void;
  /** The unsubscribe question's answer: the yes makes the decision it held, the no makes none. */
  readonly answerUnsub: (yes: boolean) => void;
  /** A letter its provider failed, open in the reading column in place of a sender; null while a sender is. */
  readonly failedOpen: FailedAtGateDTO | null;
  readonly openFailed: (id: string) => void;
  /** Ask a held letter's body once more: a person's press, the one way past a server that refused. */
  readonly retryBody: (id: string) => void;
  readonly keys: KeyBinding[];
}

const idOf = (row: ViewRow): string => ("pinned" in row ? row.sender.id : row.id);
const senderOf = (row: ViewRow): ScreenerSenderDTO => ("pinned" in row ? row.sender : row);

const NO_DECIDED: ScreenerState["decided"] = [];

/** The open row, where it is a waiting sender nobody has decided yet. */
/** A letter its provider failed, open in place of a sender. */
function failedOf(state: ScreenerState, id: string | null): FailedAtGateDTO | null {
  return id === null ? null : (state.failedAtGate?.find((f) => f.id === id) ?? null);
}

/** The open row: a row of the section, or a sender decided here and waiting for the organizer. */
function openRow(
  openId: string | null,
  rows: readonly ViewRow[],
  decided: ScreenerState["decided"],
): ViewRow | null {
  if (openId === null) return null;
  return rows.find((r) => idOf(r) === openId) ?? decided.find((d) => d.sender.id === openId)?.sender ?? null;
}

function undecided(open: ViewRow | null, decided: ScreenerState["decided"]): ScreenerSenderDTO | null {
  if (open === null || "pinned" in open) return null;
  return decided.some((d) => d.sender.id === open.id) ? null : open;
}

/** Is the open waiting sender in the filter's group (or is nothing open)? */
function inGroup(
  waiting: readonly ScreenerSenderDTO[],
  selected: string | null,
  group: ScreenerFilterId,
): boolean {
  const row = waiting.find((w) => w.id === selected);
  return row === undefined || filterGroupOf(row) === group;
}

/** The section's rows as drawn and walked, the filter's counts, and the ids a key may move to. */
function useRows(
  state: ScreenerState,
  segment: KeySegment,
  filter: ScreenerFilterId | null,
  selected: string | null,
) {
  const { waiting, screenedOut, spam, isExiting } = state;
  const counts = useMemo(() => filterCounts(waiting, isExiting), [waiting, isExiting]);
  const active = segment === "waiting" ? activeFilterOf(filter, counts) : null;
  /* The open sender stays in a filtered list when their suggestion moves them to another group. */
  const keptKey = useMemo(() => {
    const row = selected ? waiting.find((w) => w.id === selected) : undefined;
    return row ? senderKey(row.from.address) : undefined;
  }, [selected, waiting]);
  const rows: readonly ViewRow[] = useMemo(() => {
    if (segment === "screened") return screenedOut;
    if (segment === "spam") return spam;
    if (active === null) return waiting;
    return waiting.filter((w) => filterGroupOf(w) === active || senderKey(w.from.address) === keptKey);
  }, [segment, screenedOut, spam, waiting, active, keptKey]);
  const decided = useMemo(
    () => (segment === "waiting" ? state.decided : NO_DECIDED),
    [segment, state.decided],
  );
  const ids = useMemo(() => [...rows.map(idOf), ...decided.map((d) => d.sender.id)], [rows, decided]);
  const selectable = useMemo(
    () => (segment === "waiting" ? ids.filter((id) => !isExiting(id)) : ids),
    [segment, ids, isExiting],
  );
  return { counts, active, rows, decided, ids, selectable };
}

/** A waiting row's accept: its real suggestion, where it has one and was not decided here already. */
function acceptOf(
  state: ScreenerState,
  segment: KeySegment,
  decided: ScreenerState["decided"],
  id: string,
  decideRow: (sender: ScreenerSenderDTO, dest: DecisionDestination) => void,
): void {
  const row = segment === "waiting" ? state.waiting.find((w) => w.id === id) : undefined;
  const dest = row ? acceptDestOf(row) : null;
  if (row !== undefined && dest !== null && !decided.some((d) => d.sender.id === id)) decideRow(row, dest);
}

export function useScreenerView(input: ScreenerViewInput): ScreenerView {
  const { state, segment, selected, select: selectAbove, words, oneColumn } = input;
  const [filter, setFilter] = useState<ScreenerFilterId | null>(null);
  const [scopes, setScopes] = useState<ReadonlyMap<string, DecisionScope>>(() => new Map());
  /** A decision left no undecided row to move to: nothing is open until the person picks one. */
  const [unpicked, setUnpicked] = useState(false);
  const [full, setFull] = useState(false);
  const [failedId, setFailedId] = useState<string | null>(null);
  const { counts, active, rows, decided, ids, selectable } = useRows(state, segment, filter, selected);
  const failedOpen = segment === "waiting" ? failedOf(state, failedId) : null;
  const openId =
    selected !== null && selectable.includes(selected) ? selected : unpicked ? null : (selectable[0] ?? null);
  /* What is open is the person's selection: one that left the list falls to the first row, said above. */
  useEffect(() => {
    if (openId !== selected) selectAbove(openId);
  }, [openId, selected, selectAbove]);
  useEffect(() => setUnpicked(false), [segment]);
  const { shown, setShown, openWith } = useShown(openId, segment);
  const open = useMemo(() => openRow(openId, rows, decided), [openId, rows, decided]);
  const openWaiting = segment === "waiting" && failedOpen === null ? undecided(open, decided) : null;
  useHeldBodies(
    failedOpen !== null ? [failedOpen.id] : open === null ? [] : senderOf(open).held.map((h) => h.id),
  );
  const engine = useEngineOrNull();
  const scopeOf = useCallback(
    (s: ScreenerSenderDTO): DecisionScope => scopes.get(s.id) ?? defaultScopeOf(s),
    [scopes],
  );
  const ask = useAllSpamAsk(state, scopeOf, segment);
  const { decide, decideRow, answerUnsub, unsub, dropUnsub } = useDecide({
    state,
    segment,
    openId,
    openWaiting,
    ids,
    isRow: (id) => rows.some((r) => idOf(r) === id),
    scopeOf,
    closeShown: () => setShown(null),
    left: (next) => {
      setUnpicked(next === null);
      selectAbove(next);
    },
  });
  const close = () => {
    setFull(false);
    setFailedId(null);
  };
  const accept = openWaiting ? acceptDestOf(openWaiting) : null;
  /* Escape closes an ask, then a menu, then the open sender on one column. */
  const escape = firstOf([
    unsub !== null && dropUnsub,
    ask.open && ask.close,
    shown !== null && (() => setShown(null)),
    oneColumn && full && close,
  ]);
  const keys = screenerKeys({
    words,
    segment,
    step: walk(selectable, openId, (id) => {
      setUnpicked(false);
      selectAbove(id);
    }),
    decidable: openWaiting !== null,
    decide,
    suggested: accept,
    applyAll: state.suggestedCount > 0 ? () => state.applyAll(scopeOf) : null,
    card: refused(state.role) ? null : () => setShown((was) => (was === "card" ? null : "card")),
    go: input.go,
    undo: () => void input.undo(),
    escape,
  });

  return {
    segment,
    rows,
    decided,
    filter: {
      counts,
      active,
      choices: segment === "waiting" ? filterChoices(counts) : [],
      choose: (id) => {
        /* A pressed filter shows its group alone, so an open sender outside it is let go. */
        if (id !== null && !inGroup(state.waiting, selected, id)) selectAbove(null);
        setUnpicked(false);
        setFilter(id);
      },
    },
    openId,
    open,
    full: oneColumn && full && (open !== null || failedOpen !== null),
    shown,
    show: setShown,
    select: (id, then = null) => {
      setUnpicked(false);
      setFailedId(null);
      openWith(id, then);
      selectAbove(id);
      if (oneColumn && then === null) setFull(true);
    },
    close,
    scopeOf,
    setScope: (s, scope) => setScopes((was) => new Map(was).set(s.id, scope)),
    decide,
    accept,
    acceptRow: (id) => acceptOf(state, segment, decided, id, decideRow),
    ask: unsub ?? (ask.asked.length > 0 ? { kind: "allSpam", senders: ask.asked } : null),
    askAllSpam: ask.ask,
    answerAllSpam: ask.answer,
    answerUnsub,
    failedOpen,
    openFailed: (id) => {
      setFailedId(id);
      setShown(null);
      if (oneColumn) setFull(true);
    },
    retryBody: (id) => void engine?.hydrateBody(id, { retry: true }),
    keys,
  };
}

export { senderOf as viewSender, idOf as viewRowId };
