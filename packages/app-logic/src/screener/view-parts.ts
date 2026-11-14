/**
 * THE VIEW'S PARTS: what is asked of the person before anything leaves (Mark all spam's question, the unsubscribe
 * question), the one way a decision leaves, what stands open beside the open sender, and the open letters' bodies.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import { useEffect, useRef, useState } from "react";
import { BODY_FETCH_TIMEOUT_MS, domainOfAddress, senderKey } from "@ohmail/client-engine";
import { useEngineOrNull } from "../engine/context.js";
import { isNothingOrganizes, type OrganizerRefusal } from "../press/organizer-refusal.js";
import type { DecisionDestination, DecisionScope } from "./decision.js";
import type { KeySegment } from "./keys.js";
import { nextAfterDecision } from "./next-sender.js";
import type { ConfirmedBulkDecision, ConfirmedSenders, ScreenerState } from "./screener-state.js";
import { acceptDestOf } from "./filter.js";
import type { ScreenerAsk, ScreenerShown } from "./view.js";

/**
 * A DECISION THIS INSTALL'S PRESS WOULD MEET REFUSED: the model's own guard, read by every place that offers a
 * decision. A reader that may not decide, or a mailbox nothing organizes yet, unless this install asked to take it over.
 */
export const refused = (
  r: ScreenerState["role"] & { pressRefusal?: OrganizerRefusal | null; takeoverAsked?: true },
) => r.takeoverAsked !== true && (r.mode === "blocked" || isNothingOrganizes(r.pressRefusal));

type BulkKind = "allSpam" | "applySuggestions";

const unsubscribeCount = (senders: ConfirmedSenders): number =>
  new Set([...senders.values()].flatMap((entry) => entry.unsubscribeIds)).size;

/** The two bulk actions share one account-bound question and one snapshot of what can leave. */
export function useBulkAsk(
  state: ScreenerState,
  segment: KeySegment,
  scopeOf: (row: ScreenerSenderDTO) => DecisionScope,
  simulated: boolean,
) {
  const engine = useEngineOrNull();
  const [draft, setDraft] = useState<{
    engine: typeof engine;
    account: ScreenerState["accountScope"];
    kind: BulkKind;
    senders: ConfirmedSenders;
  } | null>(null);
  const current =
    segment === "waiting" && draft?.engine === engine && draft.account === state.accountScope ? draft : null;
  const waiting = state.waiting.filter((row) => !state.isExiting(row.id));
  const rowIds = new Map(
    waiting.map((row) => [
      senderKey(row.from.address),
      new Set(row.held.length ? row.held.map((letter) => letter.id) : [row.id]),
    ]),
  );
  const remaining = new Map<string, ConfirmedBulkDecision>();
  if (current)
    for (const [key, entry] of current.senders) {
      const own = rowIds.get(key);
      if (!own || !entry.ids.some((id) => own.has(id))) continue;
      const visible =
        entry.scope === "sender"
          ? own
          : new Set(
              [...rowIds]
                .filter(([from]) => domainOfAddress(from) === domainOfAddress(key))
                .flatMap(([, ids]) => [...ids]),
            );
      const ids = entry.ids.filter((id) => visible.has(id));
      remaining.set(key, {
        ...entry,
        ids,
        unsubscribeIds: entry.unsubscribeIds.filter((id) => visible.has(id)),
      });
    }
  const reconcileDraft = () => {
    if (!draft) return;
    if (!current || !remaining.size) {
      setDraft(null);
      return;
    }
    if (
      remaining.size !== current.senders.size ||
      [...remaining].some(([key, entry]) => entry.ids.length !== current.senders.get(key)?.ids.length)
    )
      setDraft({ ...current, senders: remaining });
  };
  useEffect(reconcileDraft);
  const file = (kind: BulkKind, senders: ConfirmedSenders) => {
    if (refused(state.role)) return;
    if (kind === "allSpam")
      state.markAllSpam(
        () => "sender",
        (row) => senders.has(senderKey(row.from.address)),
        senders,
      );
    else state.applyAll(scopeOf, senders);
  };
  const begin = (kind: BulkKind) => {
    if (current || refused(state.role) || state.applying != null) return;
    const senders = new Map(
      waiting.flatMap((row) => {
        const key = senderKey(row.from.address);
        const dest = kind === "allSpam" ? "spam" : acceptDestOf(row);
        if (!dest) return [];
        const scope = kind === "allSpam" ? "sender" : scopeOf(row);
        const ids =
          scope === "sender"
            ? [...(rowIds.get(key) ?? [])]
            : [
                ...new Set(
                  [...rowIds]
                    .filter(([other]) => domainOfAddress(other) === domainOfAddress(key))
                    .flatMap(([, ids]) => [...ids]),
                ),
              ];
        const demoting = dest === "spam" || dest === "screened";
        const unsubscribeIds =
          !demoting || simulated
            ? []
            : (state.bulkUnsubscribeIds?.(row, scope, ids) ??
              ((state.unsubClaimOf?.(row, scope) ?? "none") === "none" ? [] : ids));
        return [[key, { scope, dest, ids, unsubscribeIds }] as const];
      }),
    );
    if (!senders.size) return;
    if (kind === "applySuggestions" && unsubscribeCount(senders) === 0) file(kind, senders);
    else setDraft({ engine, account: state.accountScope, kind, senders });
  };
  return {
    question:
      current && remaining.size > 0
        ? {
            kind: current.kind,
            senders: waiting.filter((row) => remaining.has(senderKey(row.from.address))),
            unsubscribeCount: unsubscribeCount(remaining),
          }
        : null,
    close: () => setDraft(null),
    begin,
    answer: (yes: boolean) => {
      setDraft(null);
      if (yes && current && remaining.size) file(current.kind, remaining);
    },
  };
}

/** One fetch, one slot's wait, and time for the mirror to publish the answer. */
export const HELD_BODY_STALL_MS = BODY_FETCH_TIMEOUT_MS * 2 + 3_000;

/**
 * THE MOUNTED LETTERS' BODIES ASK AS ONE URGENT REQUEST: a person is reading them, so they do not queue behind
 * background work. Keyed on the exact ids, so it asks again when the open sender changes, never when a body lands.
 * Asking is all it does: no letter turns read.
 */
export function useHeldBodies(ids: readonly string[]): void {
  const engine = useEngineOrNull();
  const key = ids.join(",");
  useEffect(() => {
    if (engine !== null && key !== "") void engine.hydrateBodies(key.split(","), { urgent: true });
  }, [engine, key]);
}

/**
 * What stands open beside the open sender, for the sender it was opened on: opening another closes it, unless the
 * press that opened the sender opened it too (a right click). A section of its own starts with nothing open.
 */
export function useShown(openId: string | null, segment: KeySegment) {
  const [shown, setShown] = useState<ScreenerShown>(null);
  const after = useRef<ScreenerShown>(null);
  useEffect(() => setShown(null), [segment]);
  useEffect(() => {
    setShown(after.current);
    after.current = null;
  }, [openId]);
  /** Open `then` with the sender a press opens: at once where it is open already. */
  const openWith = (id: string, then: ScreenerShown) => {
    if (id === openId) setShown(then);
    else after.current = then;
  };
  return { shown, setShown, openWith };
}

export interface DecideInput {
  readonly state: ScreenerState;
  readonly segment: KeySegment;
  readonly openId: string | null;
  /** The open waiting sender nobody has decided yet. */
  readonly openWaiting: ScreenerSenderDTO | null;
  /** The demo shows the courtesy in its copy, but sends no unsubscribe request. */
  readonly simulated?: boolean;
  /** Every id the section walks, and whether one is still a row to move to. */
  readonly ids: readonly string[];
  readonly isRow: (id: string) => boolean;
  readonly scopeOf: (s: ScreenerSenderDTO) => DecisionScope;
  /** What follows a decision that left: the menus close, the next sender opens (none: nothing is open). */
  readonly left: (next: string | null) => void;
  readonly closeShown: () => void;
}

/**
 * THE ONE WAY A DECISION LEAVES: the model's `decide`, once any question before it has its yes. Screen out and Spam
 * that would send a one-click unsubscribe ask first: no request leaves before its yes. A refused press (a reader's
 * install that may not decide) moves nothing: the person stays on that sender.
 */
export function useDecide(input: DecideInput) {
  const { state, openWaiting, scopeOf } = input;
  const [unsub, setUnsub] = useState<Extract<ScreenerAsk, { kind: "unsub" }> | null>(null);
  const engine = useEngineOrNull();
  const account = state.accountScope;
  const openSender = openWaiting === null ? null : senderKey(openWaiting.from.address);
  useEffect(() => setUnsub(null), [input.segment, openSender, engine, account]);
  /* `stay`: a row's own press on a sender that is not the open one leaves the selection where it is. */
  const leave = (
    sender: ScreenerSenderDTO,
    dest: DecisionDestination,
    read: boolean,
    scope: DecisionScope,
    stay = false,
    applyRetro?: boolean,
    unsubscribeIds?: readonly string[],
  ) => {
    const next = nextAfterDecision(input.ids, sender.id, (id) => input.isRow(id) && !state.isExiting(id));
    input.closeShown();
    // The derived card's existing branch applies no retro pass and still moves the Inbox mail it shows.
    // An explicit false would select the separate sheet branch and leave those messages behind.
    const retro = applyRetro === false && sender.derived === true ? undefined : applyRetro;
    state.decide(sender, dest, { read, scope, applyRetro: retro, unsubscribeIds });
    if (refused(state.role) || stay) return;
    input.left(next);
  };
  const askUnsubscribe = (
    sender: ScreenerSenderDTO,
    dest: DecisionDestination,
    read: boolean,
    scope: DecisionScope,
    applyRetro?: boolean,
  ): boolean => {
    if ((dest !== "screened" && dest !== "spam") || input.simulated || refused(state.role)) return false;
    const claim = state.unsubClaimOf(sender, scope);
    if (claim === "none") return false;
    const domain = domainOfAddress(senderKey(sender.from.address));
    const rows = [
      sender,
      ...state.waiting.filter(
        (row) =>
          scope === "domain" &&
          row.id !== sender.id &&
          domainOfAddress(senderKey(row.from.address)) === domain &&
          !state.isExiting(row.id),
      ),
    ];
    const ids = [...new Set(rows.flatMap((row) => row.held.map((letter) => letter.id)))];
    const unsubscribeIds = state.bulkUnsubscribeIds?.(sender, scope, ids) ?? ids;
    input.closeShown();
    setUnsub({
      kind: "unsub",
      sender,
      dest,
      read,
      scope,
      applyRetro,
      claim,
      unsubscribeIds,
      senders: rows.length,
    });
    return true;
  };
  const decide = (dest: DecisionDestination, read: boolean, applyRetro?: boolean) => {
    if (openWaiting === null) return;
    const scope = scopeOf(openWaiting);
    if (!askUnsubscribe(openWaiting, dest, read, scope, applyRetro))
      leave(openWaiting, dest, read, scope, false, applyRetro);
  };
  const decideRow = (sender: ScreenerSenderDTO, dest: DecisionDestination) => {
    if (sender.id === input.openId) return decide(dest, false);
    const scope = scopeOf(sender);
    if (!askUnsubscribe(sender, dest, false, scope)) leave(sender, dest, false, scope, true);
  };
  const answerUnsub = (yes: boolean) => {
    const asked = unsub;
    setUnsub(null);
    if (yes && asked !== null) {
      leave(
        asked.sender,
        asked.dest,
        asked.read,
        asked.scope,
        asked.sender.id !== input.openId,
        asked.applyRetro,
        asked.unsubscribeIds,
      );
    }
  };
  return { decide, decideRow, answerUnsub, unsub, dropUnsub: () => setUnsub(null) };
}

/** The first of the closers that stands, or null where nothing is open. */
export function firstOf(closers: readonly (false | (() => void))[]): (() => void) | null {
  return closers.find((c): c is () => void => c !== false) ?? null;
}

/** j and k: the row below and the row above the open one, clamped at the list's ends. */
export function walk(
  ids: readonly string[],
  openId: string | null,
  to: (id: string) => void,
): { down: (() => void) | null; up: (() => void) | null } {
  const at = openId === null ? -1 : ids.indexOf(openId);
  const next = ids[at + 1];
  const prev = at > 0 ? ids[at - 1] : undefined;
  return {
    down: next === undefined ? null : () => to(next),
    up: prev === undefined ? null : () => to(prev),
  };
}
