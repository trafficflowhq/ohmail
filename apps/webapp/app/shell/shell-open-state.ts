"use client";

/**
 * THE SHELL'S OPEN STATE — what is selected, what the reader shows, what the URL claims, and
 * what a visit has seen.
 *
 * One module because they are one question asked from four sides: a press moves the selection,
 * the route mirror keeps the bar and the open state agreed, the transition effect closes what
 * the last view had open, and the seen batches spend the visit on the way out. The eight effects
 * keep the order they had. Lifted out of `AppShell.tsx` unchanged (ARCH-022).
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { useTranslations } from "next-intl";
import {
  isResurfaced,
  senderKey,
  threadOf,
  VIEW_OF_FOLDER,
  waterlineIdOf,
  type ConsentPartition,
  type EngineMessage,
  type EntityReader,
  type FeedView,
  type Folder,
  type FolderEntity,
  type OhmailEngine,
  type OhmailView,
  type TriagePileEntry,
  type WaterlineMeta,
} from "@ohmail/client-engine";
import { type ToastFn } from "@ohmail/ui";
import { placeFirstRow, useCursorHint, type CursorHost } from "./cursor-placer";
import { useCursorPlacer } from "./keymap";
import type { MessageBarPanel } from "./message-chrome";
import { readColumnHidden } from "./narrow";
import { dispatchMarkAll, dispatchMarkAllRead } from "./read-all";
import type { RichValue } from "./rich-text";
import { go, goScreener, goSettings, reflectMessage, type Route, type ScreenerSegmentId } from "./routing";
import type { ScreenerState } from "./screener-state";
import { createSeenBatcher } from "./seen-batch";
import { useStableCallback } from "./stable-callback";
import type { ShellDispatch } from "./shell-dispatch";
import type { SenderAuditState } from "./SenderAuditPanel";
import type { SenderMenuState } from "./SenderMenu";
import type { SubjectRuleState } from "./SubjectRuleSheet";
import type { TagPickerState } from "./TagPicker";
import type { PaneId } from "../views/SettingsView";
import type { ReadsChipState } from "../views/ReadsView";

/**
 * How long the located row stays marked, and how long we look for it.
 *
 * The flash is long enough to be seen after a route transition and short enough that it is
 * plainly a "here it is" rather than a selection — the cursor is what says selected, and this
 * must not compete with it. The search window is bounded because a row that never appears
 * means the message has left that pile, and looking forever would keep a `requestAnimationFrame`
 * loop alive for the life of the tab.
 */
const LOCATE_FLASH_MS = 1600;
const LOCATE_TIMEOUT_MS = 2000;

/**
 * What a stream's departure commits: the waterline it read up to, and the glance marks it holds.
 *
 * The same shape `ReadsView`/`ReceiptsView` declare for their `onLeaveSeen` prop. Named here
 * because two callbacks and a factory now spell it, and three copies of an inline object type
 * drift apart one edit at a time.
 */
type FeedSeenCommit = { upToId: string; messageIds: string[] };

/**
 * WHERE A MESSAGE OPENS — the decision, with nothing else in it.
 *
 * Extracted from `openMessage` because the decision and the navigation are two things and
 * only one of them is checkable without a browser. Every arm below answers a reported
 * defect, and each is now an assertion rather than a paragraph.
 */
export type OpenTarget =
  | { kind: "ohbox"; id: string; reader: boolean }
  | { kind: "stream"; view: "reads" | "receipts"; id: string }
  // `row` is NON-NULL by construction: a Screener surface can only show a message THROUGH its
  // sender row, so when no row is held the target is the reader instead — never a rowless
  // screener arm. The type is the invariant `openTargetFor` keeps: it never names a surface
  // that cannot show the message.
  | { kind: "screener"; segment: ScreenerSegmentId; row: string }
  /** One of the mailbox's own folders — navigate to its view, message tail on the URL. */
  | { kind: "folder"; folderId: string; id: string }
  | { kind: "reader"; id: string };

/**
 * Where a hit opens. Presentation before physical folder: the consent cutline SHOWS a message somewhere other
 * than its folder (`placeOf`, total over the mirror), so routing by `m.folder` navigated to a pile the row was
 * never in; `undefined` = no partition considered it (demo, desktop, folder outside the presented set) and only
 * then is the folder honest; `null` = History, pile-less, opened in the reader. `parked` mail is pile-less the
 * same way (no Ohbox group lists it) and opens in the reader too. `rowFor` = the Screener row that speaks for
 * the sender, else the reader. `holds` asks whether the pile's own list actually holds the id — an archive
 * search hit can name a message no local row exists for — and a message no pile holds opens in the reader, in
 * place. Search must open what it found.
 */
export function openTargetFor(
  m: EngineMessage,
  narrow: boolean,
  rowFor: (m: EngineMessage, segment: ScreenerSegmentId) => string | null,
  placeOf?: ReadonlyMap<string, Folder | null>,
  parked?: ReadonlySet<string>,
  holds?: (view: "ohbox" | "reads" | "receipts", id: string) => boolean,
  /**
   * The `folder` entity id whose VIEW can show this message, or null — the folders
   * foundation's lookup (FOLDERS-SPEC.md). Mailbox-scoped like every folder-shaped surface
   * (two mailboxes may both have a `Projects`, and a hit must open its OWN), and the callback
   * owns the HOLDS question too: an archive-only search hit can name a folder whose entity
   * exists while the message is outside this device's mirror, and naming the folder view for
   * a row its list cannot render is the exact promise this function's type forbids. Null ⇒
   * the reader fallback, which carries the off-mirror row with it. Optional; absent (demo,
   * folders off, callers written before the feature) keeps the reader fallback.
   */
  folderTargetFor?: (m: EngineMessage, folder: Folder) => string | null,
): OpenTarget {
  const presented = placeOf?.get(m.id);
  // `null` ⟺ History (dormant, undecided) — pile-less, so the reader is where it opens.
  if (presented === null) return { kind: "reader", id: m.id };
  // The presented folder when the cutline placed it, the physical one when it did not.
  const folder: Folder = presented ?? m.folder;
  const view: OhmailView | undefined = VIEW_OF_FOLDER[folder];
  if (view === "ohbox") {
    // PARKED ⇒ in no Ohbox group, so the Ohbox cannot show it. Checked HERE and not at the top of
    // the function on purpose: `ohboxView` is the only surface that holds parked rows out, so a
    // Reads issue queued for Answer Later is still a locatable row in Reads and must keep routing
    // there. Diverting only where the surface genuinely cannot show the message is the whole of
    // what this function's return type promises.
    //
    // Kept as its own arm although `holds` below subsumes it: the parked rule is a statement about
    // the triage model that is true whether or not a caller passes a pile predicate, and a caller
    // that passes neither still gets it right.
    if (parked?.has(m.id)) return { kind: "reader", id: m.id };
    return holds && !holds("ohbox", m.id)
      ? { kind: "reader", id: m.id }
      : { kind: "ohbox", id: m.id, reader: narrow };
  }
  if (view === "reads" || view === "receipts") {
    return holds && !holds(view, m.id)
      ? { kind: "reader", id: m.id }
      : { kind: "stream", view, id: m.id };
  }
  if (view === "screener" || view === "screened" || view === "spam") {
    const segment: ScreenerSegmentId =
      view === "screener" ? "waiting" : view === "screened" ? "screened" : "spam";
    const row = rowFor(m, segment);
    // A Screener surface can only show a message THROUGH its sender row. When this client holds
    // no row for the sender — an archive-only hit, or a sender the queue does not mint one for —
    // naming the segment would drop the user at a list the message is not in and flash nothing.
    // So fall to the reader, in place: the same answer History gives a pile-less hit, and the
    // invariant that `openTargetFor` never names a surface that cannot show the message.
    return row ? { kind: "screener", segment, row } : { kind: "reader", id: m.id };
  }
  // ONE OF THE USER'S OWN FOLDERS — reachable since the folders foundation: a message whose
  // presented place is not one of the six may live in a folder the account browses as a view.
  // Route it there (the view lists it, the URL's message tail opens it) rather than stranding
  // the hit in Search's reader — the same "never name a surface that cannot show the message"
  // rule, pointed at the surface that CAN.
  const folderId = folderTargetFor?.(m, folder);
  if (folderId) return { kind: "folder", folderId, id: m.id };
  // A folder no view owns — the folders feature off, an unknown path. The reader, in place.
  return { kind: "reader", id: m.id };
}

/**
 * What the reader shows — the mirror's own row, else the row the opener carried in. `GET
 * /search` answers over the whole archive while the mirror is a window over it, so a hit can
 * name a message with no local row: the mirror answered `undefined`, the reader's `open` prop
 * was false, and the sheet never came up ("clicking it does not open it"). The fallback is
 * keyed on the id, renders exactly what the archive returned (a body cannot be fetched for a
 * rowless message, so `snippet` says so). The mirror wins whenever it has the row — it carries
 * the overlay and this device's own triage and flag state.
 */
/**
 * THREE ANSWERS, AND THE THIRD IS THE ONE THIS SURFACE WAS MISSING. `null` used to mean both
 * "nothing is open" and "the message being read has been taken away", which is why a message
 * another mail client moved out of every watched folder left a blank pane and no word said.
 * `"gone"` is that second state named; see {@link OhmailEngine.messageIsGone} for why it is asked
 * of the TOMBSTONE and never of mere absence.
 */
export type ReaderAnswer = EngineMessage | "gone" | null;

export function readerMessageFor(
  readerFor: string | null,
  fromMirror: (id: string) => EngineMessage | undefined,
  offMirror: EngineMessage | null,
  isGone: (id: string) => boolean,
): ReaderAnswer {
  if (!readerFor) return null;
  const mine = fromMirror(readerFor);
  if (mine) return mine;
  if (offMirror?.id === readerFor) return offMirror;
  return isGone(readerFor) ? "gone" : null;
}

/**
 * WHAT THE OPEN STATE IS HANDED. Every field is required and none has a default. The derivations
 * arrive under the shell's own names, narrowed to the members read here — the type is the
 * boundary — and `setReplyTo` is the one setter: the route transition closes the inline editor
 * with every other overlay, and that clear cannot be split from the pass that performs it.
 */
export interface ShellOpenStateInput {
  engine: OhmailEngine;
  /** The mirror as it is — `engine.read()` from the render, never re-read here. */
  reader: EntityReader;
  /** The derived stamp the mirror-reading effects are keyed on (`useDerivedVersion`). */
  derived: number;
  route: Route;
  t: ReturnType<typeof useTranslations>;
  toast: ToastFn;
  /** The dispatch seam every read-state write leaves through (`shell-dispatch.ts`). */
  mutateAndReport: ShellDispatch["mutateAndReport"];
  /** Has the mail state settled? The route mirror will not erase a claim before it has. */
  mailState: { settled: boolean };
  screener: Pick<ScreenerState, "waiting" | "screenedOut" | "spam" | "flush">;
  allOhbox: EngineMessage[];
  consentView: ConsentPartition | null;
  folders: FolderEntity[];
  parked: ReadonlySet<string>;
  partition: { fresh: EngineMessage[]; seen: EngineMessage[] };
  piles: { replyLater: TriagePileEntry[] };
  presented: EntityReader;
  receipts: EngineMessage[];
  /** The inline reply's id, closed by the route transition with every other overlay. */
  setReplyTo: Dispatch<SetStateAction<string | null>>;
}

/** The record the shell composes with. Consumers destructure it: a memo may not depend on it. */
export type ShellOpenState = ReturnType<typeof useShellOpenState>;

export function useShellOpenState({
  engine, reader, derived, route, t, toast, mutateAndReport, mailState, screener,
  allOhbox, consentView, folders, parked, partition, piles, presented, receipts, setReplyTo,
}: ShellOpenStateInput) {

  /* ── view state ── */
  const [ohboxSel, setOhboxSel] = useState<string | null>(null);
  const [readsCur, setReadsCur] = useState<string | null>(null);
  const [receiptsCur, setReceiptsCur] = useState<string | null>(null);
  const [scnSel, setScnSel] = useState<Record<ScreenerSegmentId, string | null>>({
    waiting: null,
    screened: null,
    spam: null,
  });
  const [screenerFull, setScreenerFull] = useState(false);
  /**
   * OPEN SETTINGS ON A NAMED PANE — the Screener's "start a plan" offer, and any later link that
   * promises a section. It is the ROUTE now: `#/settings/<pane>` names the pane, so the request
   * needs no state, no one-shot clear, and no ref tracking when the view went away — the whole
   * apparatus that used to live here existed because the pane could not be said in the URL.
   * (Its subtlest failure is gone with it: the request was read once at the view's MOUNT, so an
   * offer pressed while Settings was already open changed nothing. A hash assignment reaches a
   * mounted view the same as an unmounted one.) The bare `#/settings` stays reserved for the
   * `?settings=` deep link — see `Route.settingsPane`.
   */
  const openSettingsPane = useStableCallback((pane: PaneId): void => {
    goSettings(pane);
  });
  /**
   * The reader is a message now, not a boolean. `readerOpen: boolean`
   * rendering `selectedOhbox` made the overlay a property of one pile:
   * nothing outside the Ohbox could open a message, and a message in a
   * folder with no view could not be opened at all — where three of the
   * four reported search defects met. An id, not the `EngineMessage`: the
   * mirror re-issues entities per delta, so a held object would stop
   * tracking read state, tags and triage the moment the reader is open.
   */
  const [readerFor, setReaderFor] = useState<string | null>(null);
  /**
   * An open that has to SURVIVE the route transition it travels with (the `frPending`
   * shape, and for the same reason).
   *
   * `openMessage` navigates and opens in one gesture. The route-transition effect below
   * closes every overlay when the view changes — `setReaderFor(null)` included — so an
   * open written directly would be erased by the navigation that was meant to carry it.
   * The effect honours this flag in the same pass, after its own clear, so the order is a
   * rule rather than a race between two `setState`s and a `hashchange`.
   */
  const [readerPending, setReaderPending] = useState<string | null>(null);
  /**
   * THE ONE MESSAGE THE READER MAY SHOW WITHOUT A MIRROR ROW BEHIND IT.
   *
   * Written by `openMessage` from the row its caller handed in, and read only when
   * `reader.get("message", readerFor)` answers nothing — see `readerMessage`. One entry, keyed on
   * its own id, and never a source for anything but the reader: mutations, search and the piles
   * all read the mirror, which is what keeps this from becoming a second, staler mirror of one.
   */
  const [readerOffMirror, setReaderOffMirror] = useState<EngineMessage | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  /**
   * THE QUICK-LOOK PREVIEW — a message id and the attachment on screen, or `null`.
   *
   * It lives up here beside the reader for the same two reasons: the overlay is the shell's,
   * not any one pile's, and it must DERIVE-CLOSE when the open message changes. The engine
   * revokes an attachment's `blob:` URLs the moment `selectedOhbox` moves (see `attachments.ts`),
   * so an overlay left open across that switch would render dead bytes — the effect below closes
   * it in the same pass.
   */
  const [previewFor, setPreviewFor] = useState<{ messageId: string; attachmentId: string } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [senderMenu, setSenderMenu] = useState<SenderMenuState | null>(null);

  const [senderAudit, setSenderAudit] = useState<SenderAuditState | null>(null);
  /* The subject-rule sheet — the finer sibling of the sender popover, opened from a message's
     title. It lives here for the reason every overlay here does: `MessagePane` is mounted TWICE
     while the reader is open, so a sheet held per-pane would be two sheets. */
  const [subjectRule, setSubjectRule] = useState<SubjectRuleState | null>(null);
  /* The action bar's open destination strip (Move / Resurface / the delete confirm) — held
     here for the mounted-twice reason the reply draft is; keyed by message id so it can never
     render over another message's bar. See `message-chrome.tsx` (`barPanel`). */
  const [barPanel, setBarPanel] = useState<{ messageId: string; panel: MessageBarPanel } | null>(null);

  // The tag-collapse flag lives in `ShellRail`, not here — see its header. Holding it on this
  // top-level component is what made toggling it re-render the whole mailbox view (~5s).
  const [picker, setPicker] = useState<TagPickerState | null>(null);
  /**
   * WHO THE OPEN TAG PICKER IS ACTUALLY FOR.
   *
   * `TagPickerState` carries a single `forId` and belongs to another module, so the
   * SET a bulk tag edit acts on is held beside it rather than inside it. `null` means "the
   * one message in `picker.forId`", which is every existing caller; a list means the pick
   * set, and the two things the shell supplies — `assigned` and `onToggle` — are computed
   * over it. The picker component itself is unchanged and does not know the difference.
   */
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  const [chipState, setChipState] = useState<ReadsChipState>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [jump, setJump] = useState<{ view: "reads" | "receipts"; id: string } | null>(null);
  /**
   * THE STREAM CLOSE REQUEST — `jump`'s counterpart, and deliberately the same shape.
   *
   * A one-shot "close this card": the URL stopped claiming a stream reading, so the view is asked
   * to collapse the ONE card the bar had claimed. Cleared on the view's acknowledgement, exactly
   * as `jump` is, so it is a request in flight and never a mirror of what is expanded — expansion
   * stays the card's own, and this shell keeps no register of it.
   */
  const [closeCard, setCloseCard] = useState<{ view: "reads" | "receipts"; id: string } | null>(null);
  /**
   * Absolute-time stamps — a momentary, view-scoped flip, not a setting.
   * Clicking any stamp flips every stamp on screen to the exact date — the
   * open message (`absoluteTime` on `MessageChrome`) and every list row
   * (`rowStamp`), from one boolean: a reader who asked for exact dates
   * asked it of the mail in front of them, and rows disagreeing with the
   * open message would answer twice. Deliberately not persisted, reset on
   * every view switch: carrying it further would be the interface
   * remembering a glance nobody asked it to keep.
   */
  const [absoluteTime, setAbsoluteTime] = useState(false);
  useEffect(() => {
    setAbsoluteTime(false);
  }, [route.view]);
  /* ONE callback, stable, for both halves — the chrome's `onToggleAbsoluteTime` and every list's
     `onToggleTime`. Two arrow literals would be two identities, and the row prop is handed to six
     memoizable views. */
  const toggleAbsoluteTime = useStableCallback(() => setAbsoluteTime((v) => !v));
  /**
   * The row a search hit landed on — so the user can SEE where they were
   * taken. Reported: opening a search result "brings me to the mail in the
   * screener but does not highlight / select it" — the routing was right,
   * the arrival silent, and on the Screener (rows are senders) that is
   * indistinguishable from being dropped at the top of a queue of
   * strangers. Holds the id the destination view puts in `data-id` (the
   * message id in three views, the sender row's id in the Screener);
   * cleared once the flash has run.
   */
  const [located, setLocated] = useState<string | null>(null);
  const [fr, setFr] = useState<{ step: number; items: TriagePileEntry[] } | null>(null);
  /**
   * "Start a Reply Run once we are on Triage", as an intent rather than a
   * race. `f` and the palette did `go("triage"); setTimeout(startFR, 130)`,
   * betting the route-transition effect (which clears every overlay,
   * `setFr(null)` included) would run first; any extra render moved the
   * deadline, so with a row selected the effect wiped the just-opened
   * overlay and `f` silently did nothing. A flag the effect itself honours
   * cannot lose the race: the clear and the re-arm are one pass, in order,
   * however many times React re-renders.
   */
  const [frPending, setFrPending] = useState(false);
  /**
   * What the user typed in the run, keyed by MESSAGE. It was keyed by step
   * index and nothing read it — the overlay wrote and `onDone` dispatched
   * without looking. A step index is re-issued by the next run over a pile
   * that has moved, so "step 0's text" is a different person's answer
   * tomorrow; the message id is the only stable name, and it is the key
   * `writeReplyDraft`, `sendKeyOf` and `settle` already use — the run
   * shares one scratch buffer with the inline editor.
   */
  const [frValues, setFrValues] = useState<Record<string, RichValue>>({});
  const [frDone, setFrDone] = useState<Set<string>>(() => new Set());
  const [ribbonGone, setRibbonGone] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("ohmail.demo-ribbon") === "gone") setRibbonGone(true);
    } catch {
      /* storage blocked — the ribbon stays */
    }
  }, []);

  /**
   * What is open in the Ohbox — and `null` until somebody opens something.
   * A `?? allOhbox[0]` here made an untouched Ohbox report the newest
   * unread as "open", and this value decides which body is FETCHED, which
   * attachments are held, and which message `s`/`e`/`r` act on — arriving
   * at the Ohbox fetched a message and left it one keypress from a
   * read-marking departure. The rule: a fallback may decide what is
   * displayed; it may never drive seen-machinery — and here the display IS
   * an open, so there is nothing left for a fallback to be innocent of.
   */
  /* The surface first, then the mirror by the SAME id — the door `readerMessageFor` opens for
     every other route. Not a fallback to a different message: the cursor names an id, and a row
     the mirror holds is never an empty pane. Asked of `presented` and never of `reader`: the
     mirror's reader deliberately still holds a message inside its delete-undo window, and a
     fallback on it kept the acted row "open" for the render in which the list drops it, so the
     after-verb advance never fired (measured, `after-verb.test.tsx`). `null` only for no cursor
     or a miss, which `ohboxGone` then classifies. */
  const selectedOhbox = allOhbox.find((m) => m.id === ohboxSel)
    ?? (ohboxSel === null ? null : presented.get<EngineMessage>("message", ohboxSel) ?? null);

  /**
   * THE READING COLUMN'S OWN "GONE", and it needs its own question: the column renders from the
   * SELECTED ROW, so a tombstone takes the row out of `allOhbox` and `selectedOhbox` answers
   * `null` — indistinguishable from a resting column with nobody's message in it, which is what
   * the reader saw. The cursor still names the id, so the mirror can still be asked.
   */
  const ohboxGone = selectedOhbox === null && ohboxSel !== null && engine.messageIsGone(ohboxSel);

  /**
   * DERIVE-CLOSE the Quick-Look overlay when the message it belongs to stops being the open
   * one — a different row selected, a view change, the reader closed. `attachments` are held
   * for `selectedOhbox` only and their `blob:` URLs are revoked the moment it moves, so a
   * preview left standing across the switch would render revoked bytes. Closing is derived from
   * the selection rather than remembered at every call site that can change it.
   */
  const previewSelection = useRef<string | null>(null);
  useEffect(() => {
    const before = previewSelection.current;
    previewSelection.current = selectedOhbox?.id ?? null;
    if (!previewFor) return;
    /*
     * Members of the ACTIVE conversation keep their previews under a standing selection: the seam
     * holds lists and bytes for the whole conversation, and a focused-id-only test closed a
     * sibling's overlay in the same breath its eye opened it. Two bounds keep the widened guard
     * honest: ANY selection move closes the overlay (the seam's cleanup revokes the conversation's
     * byte state on exactly that trigger), and `version` is a dependency, so a previewed sibling a
     * drain deletes or rethreads no longer holds its overlay open. The previous selection is a ref
     * — bookkeeping, not a render input.
     */
    const held =
      before === (selectedOhbox?.id ?? null) &&
      selectedOhbox != null &&
      (previewFor.messageId === selectedOhbox.id ||
        threadOf(reader, selectedOhbox.id).some((m) => m.id === previewFor.messageId));
    if (!held) setPreviewFor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFor, selectedOhbox?.id, derived]);

  /**
   * What the reader is showing, read from the mirror on every render.
   *
   * `?? null` and never a fallback to `selectedOhbox`: the reader shows the message it was
   * opened on or it shows nothing. A fallback here would re-create the defect
   * `OhboxView.open` documents — the sheet swapping to a message nobody opened the moment
   * the list re-partitioned underneath it.
   */
  const readerAnswer: ReaderAnswer = readerMessageFor(
    readerFor,
    (id) => reader.get<EngineMessage>("message", id),
    readerOffMirror,
    (id) => engine.messageIsGone(id),
  );
  /**
   * The reader is standing on a message the mirror has TOMBSTONED — another mail client moved or
   * deleted it. Split out rather than widened through: everything below asks `readerMessage` for a
   * row, and a string in that variable would be a row-shaped lie at ten call sites.
   */
  const readerGone = readerAnswer === "gone";
  const readerMessage: EngineMessage | null = readerGone ? null : readerAnswer;

  /**
   * THE OHBOX'S ARMED READ — reported by `OhboxView.onReadArmed`, held here for ONE consumer:
   * the reader sheet's `MessagePane`, whose read-state verb derives from `message.unread`. The
   * Ohbox commits reading on departure, so while a message is open the store still says unread —
   * and the sheet went on offering "Mark read" over a message the reader was reading. The view
   * flips its own column and rows; the sheet is mounted HERE, so the fact travels up. A report
   * of view-local presentation state, never a second writer of read-state: nothing else may
   * read it.
   */
  const [ohboxArmedRead, setOhboxArmedRead] = useState<string | null>(null);
  /**
   * The sheet's message, with read state as the list behind it draws it —
   * the same pair `OhboxView.effUnread` applies, shared through
   * `presentsUnread` so sheet and row cannot disagree: a RESURFACED message
   * reads unread whatever its stored flag says (owner ruling 2026-08-31),
   * so the sheet offers "Mark as read" — the deliberate verb that spends
   * the pin; an ARMED read reads read, so the sheet offers "Mark unread"
   * while the departure write waits — and the arm does not spend a pin.
   */
  const sheetPresentsUnread =
    readerMessage != null && (isResurfaced(readerMessage) || (readerMessage.unread && readerMessage.id !== ohboxArmedRead));
  const sheetMessage: EngineMessage | null =
    readerMessage != null && readerMessage.unread !== sheetPresentsUnread
      ? { ...readerMessage, unread: sheetPresentsUnread }
      : readerMessage;

  /**
   * Is the reading column absent? Below the active layout's breakpoint (`narrow.ts` — 900px
   * classic, 721px zero) `app.css`/`zero-layout.css` set `display:none` on it, so a
   * split-pane selection shows the user nothing and "opened" has to mean the reader sheet.
   * One predicate, used by `openReply` (which had it inline) and by `openMessage` — now the
   * shared module's, so the Zero ladder moves every call site at once.
   */

  /**
   * Opening the reader — the one gate. A live walk at 1440 found the message painted twice: the
   * split's reading column AND a modal over it. `readColumnHidden` is what "opened" means at a
   * width whose reading column is `display:none`; `openReply` and `openMessage` already ask it,
   * and `OhboxView.open` was the one path that did not — ↵ and a second click opened the sheet
   * at every width. Gated here and not in the view: a view asking the media query itself would
   * be a second copy of the predicate. The view's contract stays "open this message"; the id
   * still travels — this narrows WHETHER, never WHAT.
   */
  const enterReader = useStableCallback((messageId: string) => {
    if (readColumnHidden()) setReaderFor(messageId);
  });

  /**
   * Read-state, for every view — one call site for one mutation. "Seen" used to mean three
   * things: Reads dispatched `feed_mark_seen`, Receipts kept an unpersisted React Set, the
   * Ohbox dispatched nothing. All three now write the same row and the worker puts `\Seen` on
   * the user's own IMAP server. `via` is a pass-through: a surface that marks read on the
   * reader's behalf labels itself `"glance"` and the engine alone acts on it (a pin survives
   * being looked at); absent means deliberate. The forward is easy to lose and impossible to
   * typecheck, so `test/resurface-now-shell.test.ts` asserts the label reaches the adapter.
   */
  const markSeen = useStableCallback((ids: string[], unread: boolean, via?: "glance"): Promise<boolean> => {
    if (ids.length === 0) return Promise.resolve(false);
    /* Through the shell's one dispatch seam, with NO sentence of its own: the read state is its
       own confirmation on the row, and the callers that DO say something (the bulk verbs, the
       resurface release) say it from the verdict this answers with. */
    return mutateAndReport({ kind: "mark_seen", messageIds: ids, unread, ...(via ? { via } : {}) }, null);
  });

  /**
   * "Mark all read" for a whole view. Unlike {@link markSeen} it CHUNKS at
   * {@link MARK_SEEN_CHUNK} (a full view can exceed the route's 200-id
   * cap); each chunk is its own mutation and Idempotency-Key; `\Seen` lands
   * via the worker. It answers with a true-undo toast rather than a
   * confirm — the product's pattern for a verb that is usually meant: the
   * undo flips exactly the ids this press flipped, so mail already read
   * before the press stays read (a blanket "mark everything unread" would
   * not). Held longer than the default toast.
   */
  const markAllRead = useStableCallback((ids: string[]) => {
    if (ids.length === 0) return;
    dispatchMarkAllRead((m) => engine.mutate(m), ids);
    toast(t("markAll.done", { count: ids.length }), {
      action: t("markAll.undo"),
      onAction: () => { dispatchMarkAll((m) => engine.mutate(m), ids, true); },
      duration: 6000,
    });
  });

  /* ── route transitions: overlays close, pending screener work lands ── */
  const prevRoute = useRef(route);
  /**
   * WHERE SEARCH WAS ENTERED FROM — Escape's way back out.
   *
   * Search is the one view a keyboard user is dropped INTO with focus in a text field, so
   * every letter types and the view bindings are their only exit. Esc's second press (the
   * first clears the query — see `SearchView`) returns HERE rather than to a hard-coded
   * Ohbox, because `/` works from every pile and "close what is open" must hand back the
   * screen it opened over. A ref, not state: nothing renders it.
   */
  const searchFrom = useRef<Route | null>(null);
  useEffect(() => {
    const prev = prevRoute.current;
    if (prev.view !== route.view || prev.screenerSegment !== route.screenerSegment || prev.tagId !== route.tagId) {
      if (route.view === "search" && prev.view !== "search") searchFrom.current = prev;
      screener.flush();
      setReaderFor(null);
      setPicker(null);
      setPickerIds(null);
      setFr(null);
      setRailOpen(false);
      setSenderMenu(null);
      // The subject sheet is anchored to a message in the view being left, so it closes with the
      // rest of the overlays. Left open it would float over the new view holding a token count read
      // from a sender the reader is no longer looking at.
      setSubjectRule(null);
      setShortcutsOpen(false);
      setReplyTo(null);
      if (route.view !== "screener") setScreenerFull(false);
      // …and only then honour a pending Reply Run, so the clear above cannot undo it.
      if (route.view === "triage" && frPending) {
        setFrPending(false);
        // NOT `setFrValues({})` — see `startFR`. Wiping the map here is the same data loss.
        setFr({ step: 0, items: piles.replyLater });
      }
      // …and a pending OPEN, for exactly the same reason. `openMessage` sets both
      // the destination and the intent to open before the hash changes; the clear above runs
      // first, so without this an Ohbox hit tapped at 390px would navigate and then close the
      // reader it had just asked for, which is the shape the Reply Run already paid for once.
      if (readerPending) {
        setReaderFor(readerPending);
        setReaderPending(null);
      }
    }
    prevRoute.current = route;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  /**
   * The per-card sweep writer for Reads — ids ONLY, never an anchor. The waterline is "new since last visit": it must
   * hold still for the whole visit and move exactly once, on the way out ({@link commitFeedSeen}). This used to
   * re-send the current anchor with every dwell-mark, which meant a first mark on a line-less pile MINTED a line
   * mid-visit and the partition reshuffled under the reader. BATCHED — one mutation per pause, not per card. Every
   * mutation bumps the mirror version and a bump re-derives the whole selector chain over the whole mirror, which
   * `seen-batch.ts` measured as 8× the blocked main-thread time of the identical scroll on an all-read pile.
   */

  /**
   * The batchers live for the SHELL, not the view, so marks pending across a view switch still flush; the leave seams
   * below (`commitFeedSeen`, `pagehide`) drain them first so a departing visit's glances are on the wire before — and
   * never instead of — the anchored commit.
   */
  const readsSeenBatch = useMemo(
    () =>
      createSeenBatcher((ids) => {
        void engine.mutate({ kind: "feed_mark_seen", view: "reads", messageIds: ids });
      }),
    [engine],
  );
  /** Receipts' per-card glance marks, batched the same way (see `readsSeenBatch`). */
  const receiptsSeenBatch = useMemo(
    () =>
      createSeenBatcher((ids) => {
        void engine.mutate({ kind: "mark_seen", messageIds: ids, unread: false, via: "glance" });
      }),
    [engine],
  );
  const readsMarkSeen = useStableCallback((id: string) => readsSeenBatch.add(id));
  const receiptsMarkSeen = useStableCallback((id: string) => receiptsSeenBatch.add(id));
  /**
   * The dying-tab drain — `StreamShell`'s own pagehide argument, applied to the batch: the
   * engine's durable outbox persists the dispatched verb before the wire, so a flush in the
   * tab's last milliseconds is deliverable on the next boot. Unmount drains too (the desktop
   * shell is torn down without a pagehide when a window is programmatically rebuilt).
   */
  useEffect(() => {
    const drain = (): void => {
      readsSeenBatch.flushNow();
      receiptsSeenBatch.flushNow();
    };
    window.addEventListener("pagehide", drain);
    return () => {
      window.removeEventListener("pagehide", drain);
      drain();
    };
  }, [readsSeenBatch, receiptsSeenBatch]);

  /**
   * THE LEAVE-COMMIT, both streams — one anchored `feed_mark_seen` per departure, the
   * reliability floor under the per-card observers. The views hand up the anchor ("the top
   * of what was on screen") and the unread ids their final screen covered; this reads the
   * CURRENT meta at invocation time (the view is unmounting; its render-time partition is
   * already history) and skips entirely when nothing would change — a leave that flips
   * nothing and moves nothing is not worth a wire round-trip and the drain that follows it.
   */
  const commitFeedSeen = useStableCallback((view: FeedView) =>
    (commit: FeedSeenCommit) => {
      // The departing visit's pending glance marks go first — see `readsSeenBatch`.
      (view === "reads" ? readsSeenBatch : receiptsSeenBatch).flushNow();
      const held = engine.read().get<WaterlineMeta>("view_meta", waterlineIdOf(view));
      if (commit.messageIds.length === 0 && held?.newestSeenId === commit.upToId) return;
      void engine.mutate({
        kind: "feed_mark_seen",
        view,
        upToId: commit.upToId,
        messageIds: commit.messageIds,
      });
    });
  /**
   * THE TWO VIEWS' COMMITS RE-APPLY `commitFeedSeen` ON EVERY CALL, and that is the whole point of them not being
   * memos. `commitFeedSeen` is a factory: calling it returns an inner closure over THIS render's `engine` and glance
   * batches. As `useMemo(() => commitFeedSeen("reads"), [commitFeedSeen])` these were computed once — and once
   * `commitFeedSeen` has a stable identity, once is FOREVER, so both would have kept the first render's inner closure
   * and marked mail seen against a dead engine and dead batches for the life of the tab. Nothing would have thrown;
   * the marks would simply have stopped landing. Applying the factory inside the call is what keeps it current: the
   * stable callback forwards to the newest body, which builds a fresh inner closure over the current engine, which is
   * then invoked.
   */

  /**
   * Guarded by a test that re-renders with a second engine and asserts the mark reaches THAT one, with the memoised
   * shape kept beside it as the control that tells the two apart.
   */
  const commitReadsSeen = useStableCallback((commit: FeedSeenCommit) => commitFeedSeen("reads")(commit));
  const commitReceiptsSeen = useStableCallback((commit: FeedSeenCommit) => commitFeedSeen("receipts")(commit));

  /**
   * The Screener row that speaks for `m`, in `segment`.
   *
   * The Screener's rows are SENDERS, not messages: a derived row's id is the newest held
   * message from that address (`screener-state.ts`), which is almost never the message
   * somebody clicked in a search result. Matching on `senderKey` is therefore the only
   * lookup that can land on the right row, and it is the same key the selectors and the
   * server group by. Null when this client holds no row for them — the caller navigates
   * without a selection rather than inventing one.
   */
  const screenerRowFor = useStableCallback((m: EngineMessage, segment: ScreenerSegmentId): string | null => {
    const want = senderKey(m.from.address);
    const rows =
      segment === "waiting"
        ? screener.waiting
        : segment === "screened"
          ? screener.screenedOut
          : screener.spam.map((r) => r.sender);
    return rows.find((r) => senderKey(r.from.address) === want)?.id ?? null;
  });

  /**
   * Open it where it lives — the one answer, finished.
   */

  /**
   * Reported as "search does not allow a message to be opened"; the literal claim was wrong (a `SearchHit` is a real
   * `<button>` and has always called this) — what was wrong is everything AFTER the routing decision: this set a view
   * and a cursor and stopped, so on three of five destinations the user arrived at a list and had to find the thing
   * they had just clicked, and on the fourth at a pane that is `display:none` at their screen width. ohbox — the
   * split pane IS the open on a desktop; under 900px the reading column is hidden, so the reader sheet is what
   * "opened" means, exactly as `OhboxView`'s own tap handler decided. reads/receipts — cursor plus a `jump`, which
   * extends the mounted run through the card, anchors the stream on it and OPENS it (`ReadsView`,
   * `StreamShell.scrollTo`): a card the stream merely scrolled near is not the message the reader clicked.
   */

  /**
   * screener/screened/spam — now SELECTS THE SENDER as well as navigating: the segment alone was the misroute the
   * ruling named third, a consent surface dropping you at a queue of strangers when you asked about one of them.
   * Reached whenever the PRESENTATION is the Screener — not the same set as "physically in a Screener folder": an
   * undecided sender's INBOX mail lands here, the whole of the presentation fix (`openTargetFor`); a hit whose sender
   * the queue holds no row for routes to the reader instead of a rowless queue.
   */

  /**
   * History, or a folder this client has no view for — the reader, over wherever you are: History is a REACHABLE case
   * now (a dormant-undecided message presents there, `placeOf` null, belongs to no pile), and the defensive half
   * remains — `Folder` is a closed union and `VIEW_OF_FOLDER` total, so an unknown folder cannot reach here from the
   * wire; its answer is the same, the message itself.
   */
  /**
   * DOES THAT PILE HOLD THIS MESSAGE — asked of the SAME lists the views render.
   *
   * Not of the mirror and not of `placeOf`: the question is whether the surface about to be
   * navigated to can show the row, and only the built list answers that. An archive-only search
   * hit (a row `GET /search` returned and this device's mirror does not hold) is in none of them,
   * and `openTargetFor` then opens it in the reader rather than navigating to a pile it is not in.
   */
  const pileHolds = useStableCallback((view: "ohbox" | "reads" | "receipts", id: string): boolean => {
    if (view === "ohbox") return allOhbox.some((m) => m.id === id);
    if (view === "receipts") return receipts.some((m) => m.id === id);
    return partition.fresh.some((m) => m.id === id) || partition.seen.some((m) => m.id === id);
  });

  const openMessage = useStableCallback((m: EngineMessage) => {
    // `consentView?.placeOf` is what turns "open it where its FOLDER is" into "open it where
    // it is PRESENTED" — the same map SearchView labels the hit's chip from, so the arrival
    // and the chip can no longer disagree. Undefined on demo/desktop, where folder is place.
    // `pileHolds` is the second half: presentation says WHERE, the pile says WHETHER.
    const target = openTargetFor(
      m,
      readColumnHidden(),
      screenerRowFor,
      consentView?.placeOf,
      parked,
      pileHolds,
      // The mailbox's own folders (mailbox-scoped, like every folder-shaped surface): a hit
      // living in one navigates to its folder view instead of dead-ending in Search — but
      // ONLY when the PRESENTED mirror holds the row under that folder, which is exactly
      // what the folder view renders. An archive-only hit (GET /search reaching past this
      // device's window) falls to the reader, which carries the off-mirror row with it.
      (hit, folder) => {
        const f = folders.find((x) => x.mailboxId === hit.mailboxId && x.name === folder);
        if (!f) return null;
        const held = presented.get<EngineMessage>("message", hit.id);
        return held && held.folder === folder ? f.id : null;
      },
    );
    switch (target.kind) {
      case "ohbox":
        setOhboxSel(target.id);
        // The reader, and via `readerPending` because `go` is about to clear it.
        if (target.reader) setReaderPending(target.id);
        setLocated(target.id);
        go("ohbox");
        return;
      case "stream":
        (target.view === "reads" ? setReadsCur : setReceiptsCur)(target.id);
        setJump({ view: target.view, id: target.id });
        setLocated(target.id);
        go(target.view);
        return;
      case "screener":
        // `target.row` is non-null by construction (see `OpenTarget`): a rowless screener hit
        // is routed to the reader by `openTargetFor`, never here.
        setScnSel((s) => ({ ...s, [target.segment]: target.row }));
        // The SENDER row's id, not the message's: that is what this view puts in
        // `data-id`, and the flash has to name the thing on screen.
        setLocated(target.row);
        goScreener(target.segment);
        return;
      case "folder":
        // The canonical folder deep-link WITH the open-message tail, in one hash write: the
        // route↔open-state mirror then opens the reader over the folder view (the same
        // overlay a tag hit gets), so the message is on screen in the folder that holds it.
        setLocated(target.id);
        window.location.hash = `#/folder/${target.folderId}/m/${target.id}`;
        return;
      default:
        // No navigation, so no `readerPending` is needed: nothing will clear this. This is the "folder no view owns"
        // arm, the History arm and the PARKED arm — a message presented in History, or filed into a bottom pile,
        // belongs to no list, so the reader opens over wherever you are, exactly as HistoryView's own row does — and
        // now also the arm for a hit no pile holds at all (an archive-only search result), which must still open the
        // message it named. The row travels with the open so the reader has something to show even when the mirror
        // holds none — see `readerOffMirror`. Set unconditionally: the mirror's own row wins whenever there is one,
        // so this is only ever consulted for a message there is no other copy of.
        setReaderOffMirror(m);
        setReaderFor(target.id);
    }
  });

  /**
   * The open message lives in the URL — `#/<view>/m/<id>` (`Route.messageId`): the bar claims the reading on screen,
   * so a reload restores it, Back walks out of it, and a copied link hands somebody the exact message; before this, a
   * reload booted to the bare view. One effect, arbitrated by who moved — a two-way mirror with two writers is a
   * loop, so the refs below remember the last agreed pair and let the side that changed win. The ROUTE moved
   * (Back/Forward, a typed link, a reload) → apply it to the open state: the Ohbox selection (plus the sheet at a
   * narrow width), a stream's cursor-with-jump, or the reader overlay. An id the mirror does not hold yet WAITS (the
   * effect re-runs per delta — a reload restores before the boot drain finishes), and an id the mirror never produces
   * drops out of the bar once the mail state settles.
   */

  /**
   * The STATE moved (a click, j/k, an open, a close) → reflect it into the bar (`reflectMessage`): an OPEN pushes, so
   * history walks readings; a move or a close REPLACES, so a `j`-walk does not bury the view under fifty entries.
   */

  /**
   * What restoring does not do: arm a read. The restore sets the selection and the surfaces, never calls the view's
   * `open`, so nothing is marked read by arriving — reloading IS a leave-and-revisit, the departure's own commit
   * (`pagehide`) already spent the last reading, and the restored message re-arms only the way any on-screen message
   * does. The session-order lease starts fresh, as any reload starts it. What the bar mirrors is deliberately narrow:
   * the reader overlay on any message view, and the Ohbox's own selection (at a split width the column IS the open).
   * A stream's expanded card is a scroll posture, not shell state, so in-place stream reading does not rewrite the
   * URL — but a stream deep link RESTORES through the same cursor-plus-jump a search arrival uses.
   */
  // The last pair the two sides agreed on — `view|id`, because the SAME message deep-linked on
  // a DIFFERENT view is a route move (the overlay must open there), not a state echo.
  const routeMsgAgreed = useRef<string>("|");
  const lastMirroredView = useRef<Route["view"] | null>(null);
  useEffect(() => {
    // A VIEW CHANGE is the one commit where `readerFor` may be a value already condemned: the
    // transition effect above queues `setReaderFor(null)` in this same commit, and reflecting
    // the closure's stale reader into the NEW view's bare route would push `m/<old>` and then
    // restore the old reading over the destination. One pass of silence for the reader on a
    // view change; the next run reads the settled value.
    const viewChanged = lastMirroredView.current !== route.view;
    lastMirroredView.current = route.view;
    const allowed = route.view !== "settings" && route.view !== "compose"
      && route.view !== "drafts" && route.view !== "screener";
    if (!allowed) { routeMsgAgreed.current = "|"; return; }
    const agreedKey = `${route.view}|${route.messageId ?? ""}`;
    // What the bar may claim RIGHT NOW. The Ohbox selection counts only at a split width —
    // on a phone the list shows no reading, so the sheet alone is the open there, and closing
    // it must take the claim out of the bar with it.
    const openOnScreen: string | null =
      (viewChanged ? null : readerFor)
      ?? (route.view === "ohbox" && !readColumnHidden() ? ohboxSel : null);
    // ── the route moved: apply it ─────────────────────────────────────────────────────────
    if (agreedKey !== routeMsgAgreed.current) {
      const id = route.messageId;
      if (id === null) {
        // BOTH HALVES, READ BEFORE THE OVERWRITE ON THE NEXT LINE. The id the bar was claiming
        // is the one to close, and it exists only in this ref until `agreedKey` replaces it —
        // reading it afterwards would close the empty string, i.e. nothing, for ever.
        const [cameFrom, leftId] = routeMsgAgreed.current.split("|");
        routeMsgAgreed.current = agreedKey;
        if (cameFrom === route.view) {
          // The id was dropped IN PLACE — Back walked out of the reading on this same view:
          // close what the URL no longer claims. The stream cursor goes with it, AND the card
          // the bar was claiming: the stream has a controlled close now, so the view collapses
          // that card through its own pill. Only that one — a second card the reader expanded
          // themselves is scroll posture this bar never claimed, and it stays open.
          setReaderFor(null);
          if (route.view === "ohbox") setOhboxSel(null);
          if (route.view === "reads") setReadsCur(null);
          if (route.view === "receipts") setReceiptsCur(null);
          if (leftId && (route.view === "reads" || route.view === "receipts")) {
            setCloseCard({ view: route.view, id: leftId });
          }
          return;
        }
        // A fresh ARRIVAL at a bare view — ordinary navigation, `openMessage`'s own `go()`
        // included — closes nothing: the selection the opener just set is the state the
        // reflection arm below will put INTO the bar, not a leftover to clear.
      } else {
      const m = reader.get<EngineMessage>("message", id);
      const held =
        route.view === "ohbox" || route.view === "reads" || route.view === "receipts"
          ? pileHolds(route.view, id)
          : null;
      // Not in the mirror YET — or in it while its pile is still deriving (a reload restores
      // against a boot the drain is still filling): WAIT, unagreed, so the `derived` dep
      // re-runs this per delta. Once the mail state is settled the answer is final: a row the
      // mirror never produces is not this mirror's to restore — normalize the bar back to the
      // place and stay put (a link from another account's mirror, a deleted message) — and a
      // settled row a pile genuinely does not hold opens in the overlay below.
      if (!m || (held === false && !mailState.settled)) {
        // The erase needs BOTH: a settled mail state AND a mirror that actually holds mail.
        // `settled` alone can precede the first hydration (the demo world settles before its
        // fixtures land), and erasing a reload's claim against a momentarily-empty mirror is
        // the restore failing to itself.
        if (!m && mailState.settled && reader.list<EngineMessage>("message").length > 0) {
          routeMsgAgreed.current = `${route.view}|`;
          reflectMessage(route, null);
        }
        return;
      }
      if (route.view === "ohbox" && held) {
        setOhboxSel(id);
        // The overlay either IS this reading (narrow) or must not stand over it: at a split
        // width a stale reader left by an earlier off-pile route would sit over the column
        // and re-claim the bar on a later pass.
        setReaderFor(readColumnHidden() ? id : null);
        setLocated(id);
      } else if ((route.view === "reads" || route.view === "receipts") && held) {
        (route.view === "reads" ? setReadsCur : setReceiptsCur)(id);
        setJump({ view: route.view, id });
        setReaderFor(null); // same stale-overlay rule as the ohbox arm
        setLocated(id);
      } else {
        // Every other message view — and a settled pile that does not hold the row: the overlay.
        setReaderFor(id);
      }
        routeMsgAgreed.current = agreedKey;
        return;
      }
    }
    // ── the state moved: reflect it ───────────────────────────────────────────────────────
    if (openOnScreen !== route.messageId) {
      routeMsgAgreed.current = `${route.view}|${openOnScreen ?? ""}`;
      reflectMessage(route, openOnScreen);
    }
    // `route` is a fresh object per hash: the fields below are the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.messageId, route.view, readerFor, ohboxSel, derived, mailState.settled, pileHolds, reader]);

  /**
   * Locate the row, in whichever view it landed. One DOM effect and not four props: a search hit can land in four
   * view shapes, and threading a `locatedId` through all four is four props, four effects and four chances for the
   * fifth view to be added without one. All four already agree on a contract: every row is `.row[data-id="<id>"]`,
   * and each view already finds its own cursor that way — this is a fifth reader of an established selector, not a
   * new coupling, and a view added later is located without being taught anything. It retries because `openMessage`
   * sets the cursor and CHANGES THE ROUTE in one gesture: the destination view has not mounted when this first runs,
   * so a single query would miss every time.
   */

  /**
   * It re-tries on animation frames for a short bounded window and then gives up — a hit whose row never appears is a
   * message no longer in that pile, and flashing nothing is the honest outcome. The class is removed on a timer AND
   * on unmount, so leaving the view mid-flash cannot leave a row permanently marked.
   */
  useEffect(() => {
    if (!located) return;
    let raf = 0;
    let done = false;
    const deadline = Date.now() + LOCATE_TIMEOUT_MS;
    let clear: ReturnType<typeof setTimeout> | undefined;
    let found: Element | null = null;

    const look = () => {
      if (done) return;
      /**
       * THE ROW THAT SHOWS THE MESSAGE, which is not always the row that IS the message.
       * The Ohbox folds a conversation into one row carrying its lead's `data-id` — so a hit
       * on any OTHER member matched nothing here, timed out, and the arrival flashed nothing
       * (the reported half of TRI-F2's "no highlight"). Folded rows declare their members in
       * `data-ids` (space-separated; `~=` is the attribute selector built for exactly that
       * list shape), and the exact-id match stays first so a singleton row wins over a fold
       * that happens to contain the same message twice-rendered.
       */
      const row =
        typeof document === "undefined"
          ? null
          : (document.querySelector(`.view .row[data-id="${CSS.escape(located)}"]`) ??
             document.querySelector(`.view .row[data-ids~="${CSS.escape(located)}"]`));
      if (row) {
        done = true;
        found = row;
        row.scrollIntoView({ block: "center" });
        row.classList.add("is-located");
        clear = setTimeout(() => {
          row.classList.remove("is-located");
          setLocated(null);
        }, LOCATE_FLASH_MS);
        return;
      }
      if (Date.now() > deadline) {
        done = true;
        setLocated(null);
        return;
      }
      raf = requestAnimationFrame(look);
    };
    raf = requestAnimationFrame(look);

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      if (clear) clearTimeout(clear);
      found?.classList.remove("is-located");
    };
  }, [located]);

  const startFR = useStableCallback(() => {
    // NO `setFrValues({})`. Keyed by message, what is in that map is a reply somebody wrote
    // and has not sent — a run that begins by erasing it is the bug this change exists to end,
    // one keystroke earlier. A delivered reply is removed by `onSendSettled`, and nothing else
    // has the standing to.
    setFr({ step: 0, items: piles.replyLater });
  });

  /**
   * The message the current view has under the cursor, whichever view that is.
   *
   * `s` and `e` mean the same thing everywhere or they mean nothing; without one answer to
   * "which message?" they would have to be re-declared per view with per-view semantics,
   * which is the state the keyboard registry exists to end.
   */
  const focused: EngineMessage | null =
    /**
     * AN OPEN READER IS THE CURSOR, WHATEVER VIEW IT IS OVER. First, and deliberately: the reader is the innermost
     * thing on screen, so a message verb pressed while it is open acts on the message being READ. NO GUARD FAILS IF
     * THIS LINE IS DELETED, and that is stated rather than hidden — the same honesty `OhboxView.pinnedUnread` uses
     * about its own key. Every path that opens the reader today also sets the pile's cursor to the same message
     * (`OhboxView.open`, `openMessage`'s Ohbox arm, `openReply` on mobile), so the two cannot yet disagree. What
     * makes the reader generalisable is precisely that it no longer has to be an Ohbox message; the first surface
     * that opens it over a pile with its own cursor would make this load-bearing, and it is cheaper to be right now
     * than to find out then. Coherence, not a fixed bug — nothing observable changes today.
     */
    readerMessage ??
    (route.view === "ohbox"
      ? selectedOhbox
      : route.view === "reads"
        ? (readsCur ? (reader.get<EngineMessage>("message", readsCur) ?? null) : null)
        : route.view === "receipts"
          ? (receiptsCur ? (reader.get<EngineMessage>("message", receiptsCur) ?? null) : null)
          : null);

  /**
   * DOES THE LOCAL MIRROR HOLD THIS ROW? — Forward's gate: `openForward` reads the message out of the mirror and
   * returns silently when it is absent, so the verb is withheld rather than offered and guaranteed to fail. Declared
   * here rather than inline in the chrome because `⇧F`'s binding needs it too, and two spellings of one question is
   * how the key and the button come to disagree — the rule `canSend` and `replyAllRecipients` are held to.
   */
  const mirrorHolds = useStableCallback((id: string): boolean => reader.get<EngineMessage>("message", id) != null);
  /** Does the VERB READER hold this row — the mirror, or a History/Search page (`engine.verbRead`)? Delete's gate. */
  const verbHolds = useStableCallback((id: string): boolean => engine.verbRead().get<EngineMessage>("message", id) != null);

  /* A half-open destination strip must not carry over when the cursor moves — the same rule
     the pane enforced per mount while it owned the state (see `useBarPanel`). */
  const focusedId = focused?.id ?? null;
  useEffect(() => setBarPanel(null), [focusedId]);

  /**
   * Put the cursor on the first row — the first press of a message verb on a list that has rows and no cursor. See
   * `keymap.tsx#DisabledReason` for the dispatcher's half. A press and not an arrival: `selectedOhbox` records what
   * happened when a list opened with a cursor already placed — `?? allOhbox[0]` meant an untouched Ohbox reported its
   * newest unread as "the open one", fetched a body, and put somebody's mail in the reading column on arrival; ⌫ is
   * that hazard with a delete on the end. So nothing is placed until somebody presses, and the press that places
   * performs nothing. It answers `false` more often than it looks: three views, the three whose cursor this shell
   * holds, the SAME three `focused` reads — anything else and the ring lands on a row the verb does not act on;
   * `route.view`, not `effectiveView`, because that is what `focused` reads.
   */

  /**
   * The ROWS AND THE SELECTOR, per route, and nothing else: the placement itself — first row, the
   * DOM check, the scroll nudge, the one line — is `placeFirstRow`'s, the same call every other
   * list view makes. An unnamed route hands over an empty list, which declines; `route.view`, not
   * `effectiveView`, because that is what `focused` reads. Focus does not move: the person is
   * already on the keyboard, and `.row.sel` is the ring the list already draws.
   */
  const sayCursorPlaced = useCursorHint();
  const placeCursor = useStableCallback((label: string): boolean => {
    const current = focused?.id ?? null;
    const host: CursorHost =
      route.view === "ohbox"
        ? { rows: allOhbox, current, scope: ".view", select: setOhboxSel }
        : route.view === "reads"
          ? { rows: [...partition.fresh, ...partition.seen], current, scope: ".view", select: setReadsCur }
          : route.view === "receipts"
            ? { rows: receipts, current, scope: ".view", select: setReceiptsCur }
            : { rows: [], current, scope: ".view", select: () => {} };
    return placeFirstRow(host, label, sayCursorPlaced);
  });
  /* `global`: the claim a VIEW holding its own cursor beats, so a split view places its own row
     rather than this shell declining for a route it holds no cursor for. */
  useCursorPlacer(placeCursor, "global");

  return {
    absoluteTime,
    barPanel,
    chipState,
    closeCard,
    commitReadsSeen,
    commitReceiptsSeen,
    enterReader,
    focused,
    fr,
    frDone,
    frValues,
    jump,
    markAllRead,
    markSeen,
    mirrorHolds,
    verbHolds,
    ohboxGone,
    openMessage,
    picker,
    pickerIds,
    previewFor,
    railOpen,
    readerFor,
    readerGone,
    readerMessage,
    readsCur,
    readsMarkSeen,
    receiptsCur,
    receiptsMarkSeen,
    ribbonGone,
    scnSel,
    screenerFull,
    searchFrom,
    searchQuery,
    selectedOhbox,
    senderAudit,
    senderMenu,
    setBarPanel,
    setChipState,
    setCloseCard,
    setFr,
    setFrDone,
    setFrPending,
    setFrValues,
    setJump,
    setOhboxArmedRead,
    setOhboxSel,
    setPicker,
    setPickerIds,
    setPreviewFor,
    setRailOpen,
    setReaderFor,
    setReaderOffMirror,
    setReadsCur,
    setReceiptsCur,
    setRibbonGone,
    setScnSel,
    setScreenerFull,
    setSearchQuery,
    setSenderAudit,
    setSenderMenu,
    setShortcutsOpen,
    setSubjectRule,
    sheetMessage,
    shortcutsOpen,
    startFR,
    subjectRule,
    toggleAbsoluteTime,
  };
}
