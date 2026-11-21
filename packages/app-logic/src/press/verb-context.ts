/**
 * WHAT A LIST'S VERBS READ AT A PRESS: the engine, the frame's one press seam, the sentences, the account's facts
 * and the rows the place can show. One record a render (`useListVerbs` makes it), handed to every verb of
 * `message-verbs.ts`, `selection-verbs.ts`, `selection-screening.ts`, `move-to-place.ts` and `tag-verbs.ts`: plain
 * functions, so a press is read top to bottom and tested without a component.
 */
import type { EngineMessage, RuleEntity as RuleDTO, TagEntity as TagDTO } from "@ohmail/wire";
import { pressRules, type EntityReader, type OhmailEngine } from "@ohmail/client-engine";
import type { ConsentState } from "../consent/consent-state.js";
import type { Translator } from "../text/translator.js";
import type { FirstImports, ShellConsentFacts } from "./consent-options.js";
import type { ToastFn } from "./report.js";
import type { ShellDispatch } from "./shell-dispatch.js";

/** What of the frame's press seam a list's verbs leave through. Never a second seam. */
export type ListPress = Pick<
  ShellDispatch,
  | "fileAndRefresh"
  | "toastWithUndo"
  | "mutateAndReport"
  | "mutateSetAndReport"
  | "refusalCopy"
  | "rosterRef"
  | "routing"
  | "deleting"
  | "restoring"
>;

/** How a letter is answered from a list: the plain reply, everyone, a forward, or the drafted reply. */
export type ListAnswer = "reply" | "reply_all" | "forward" | "draft";

export interface VerbContext {
  readonly engine: OhmailEngine;
  readonly press: ListPress;
  /** A rule change made here travels to the organizer: every press plans over the organizer's copy (`pressRules`). */
  readonly rulesTravel: boolean;
  /** The sentences, by `namespace.key`: `ohbox`, `screening`, `session` and `tag`. */
  readonly t: Translator;
  /** The frame's one report slot. */
  readonly toast: ToastFn;
  /** The resurface hour (the horizon-less verbs mint tomorrow at the account's own time) and the partition's facts. */
  readonly consent: Pick<ConsentState, "resurfaceTime"> & ShellConsentFacts;
  /** The demo's lists are not partitioned, so a press there reads nothing back. */
  readonly demo: boolean;
  /** The place's clock, read at the press. */
  readonly nowAt: () => Date;
  /** The mirror's tags, for the name a tag verb says. */
  readonly tags: readonly TagDTO[];
  /** The account's own addresses: our own letter teaches no rule. */
  readonly ownAddresses: readonly string[];
  /** Each mailbox's first import, for the held-claim term of every read-back. */
  readonly firstImportDoneAt?: FirstImports | undefined;
  /** Every message the place can show past the mirror, by id (the Ohbox's surface, `ohbox-surface.ts`). */
  readonly surfaceById: ReadonlyMap<string, EngineMessage>;
  /** Read state through the one seam, with no sentence of its own. */
  readonly markSeen: (ids: string[], unread: boolean, via?: "glance", readRow?: string) => Promise<boolean>;
  /** The reader's Mark as read set ON THE OHBOX, else absent: every other place keeps the per-message flip. */
  readonly readSetFor?: ((messageId: string) => string[]) | undefined;
  /** The place is not the Ohbox: no view there holds the row, so a read names it to the engine. */
  readonly offOhbox: boolean;
  /** Our own reply facing the Ohbox row a message was selected on, decided at the press: Move seeds from it. */
  readonly ownFaceFor?: ((m: EngineMessage) => EngineMessage | null) | undefined;
  /** What a pile press acts on: the message's pile row, or in the Ohbox its Ohbox row (`pileSubjectIds`). */
  readonly pileSetFor?: ((messageId: string, ohboxRow: boolean) => string[]) | undefined;
  /** What Done on a message releases: its Resurfaced row's pins, or its booked Resurface row (`doneSubjectIds`). */
  readonly doneSetFor?: ((messageId: string) => string[]) | undefined;
  /** The pins a delete spends at the press (`pinsSpentBy`); the engine spends every other filing's. */
  readonly pinsSpentFor?: ((filed: readonly string[]) => string[]) | undefined;
  /** The letter that is up over the list on one column, and its close: a delete closes it only over ITS message. */
  readonly letterUp: string | null;
  readonly closeLetterUp: () => void;
  /** The one composer's doors for a letter, as the place's host hands them. Nothing is sent from here. */
  readonly answer: (how: ListAnswer, m: EngineMessage) => void;
}

/** The facts needed by the shared Move press, including its delayed sender routing. */
export type MoveContext = Pick<
  VerbContext,
  | "engine"
  | "press"
  | "rulesTravel"
  | "t"
  | "toast"
  | "nowAt"
  | "ownAddresses"
  | "surfaceById"
  | "offOhbox"
  | "ownFaceFor"
>;

/**
 * `read`, answering a surface's own row for a message id `read` holds nothing for: the rows a list shows past the
 * mirror. A selection's verbs resolve through this, as a single row's press resolves through the row it was pressed on.
 */
export function withRows(read: EntityReader, rows: ReadonlyMap<string, EngineMessage>): EntityReader {
  if (rows.size === 0) return read;
  return {
    get: <T>(type: string, id: string) =>
      read.get<T>(type, id) ?? (type === "message" ? (rows.get(id) as unknown as T | undefined) : undefined),
    list: (type) => read.list(type),
    entries: (type) => read.entries(type),
    version: () => read.version(),
    stampOf: (type) => read.stampOf(type),
    stampExcept: (ignore) => read.stampExcept(ignore),
  };
}

/** `read`, answering `row` for its own id where `read` holds nothing: the pressed row as a seed. */
export function withRow(read: EntityReader, row: EngineMessage): EntityReader {
  return {
    get: <T>(type: string, id: string) =>
      read.get<T>(type, id) ?? (type === "message" && id === row.id ? (row as unknown as T) : undefined),
    list: (type) => read.list(type),
    entries: (type) => read.entries(type),
    version: () => read.version(),
    stampOf: (type) => read.stampOf(type),
    stampExcept: (ignore) => read.stampExcept(ignore),
  };
}

/**
 * THE ROWS A SET IS PRESSED ON. The verb reader holds the mirror and the History and Search pages; the surface adds
 * the rows the place shows past the mirror, so a selection holding such a row resolves it.
 */
export const setRead = (cx: MoveContext): EntityReader => withRows(cx.engine.verbRead(), cx.surfaceById);

export const rowOf = (cx: MoveContext, id: string): EngineMessage | undefined =>
  setRead(cx).get<EngineMessage>("message", id);

/** Which mailboxes a set lives in, first-seen; an unresolvable id is `""`, refused as unknown. */
export function mailboxesOf(cx: MoveContext, ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const mb = rowOf(cx, id)?.mailboxId ?? "";
    if (!out.includes(mb)) out.push(mb);
  }
  return out;
}

/** The rules a press plans over, read at the press: the organizer's copy where a change here travels to it. */
export const planRules = (cx: MoveContext, read: EntityReader): RuleDTO[] =>
  pressRules(read, {
    travels: cx.rulesTravel,
    queued: cx.engine.queuedRuleWrites?.() ?? [],
    applied: cx.engine.appliedRuleRequests?.() ?? [],
    unsettled: cx.engine.unsettledRulePresses?.() ?? [],
    now: cx.nowAt(),
  });

/** That list where it is not the local rows; the planners read the local rows when it is absent. */
export const planOver = (cx: MoveContext, read: EntityReader): RuleDTO[] | undefined =>
  cx.rulesTravel ? planRules(cx, read) : undefined;
