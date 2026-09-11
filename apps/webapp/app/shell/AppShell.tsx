"use client";

/**
 * The ohmail client shell: rail + views over ONE engine, the reader
 * exhale, the Reply Run, the ⌘K palette, the tag picker and
 * the demo ribbon. Every list, count and mutation runs through
 * @ohmail/client-engine — the shell only owns view state.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  DEMO_NOW,
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  addressBook,
  bodyOf,
  consentPartition,
  isResurfaced,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  feedPartition,
  receiptsByDay,
  waterlineIdOf,
  draftsList,
  scheduledSendsList,
  rulesList,
  senderKey,
  sendingMailboxId,
  tagsCrossView,
  threadOf,
  threadParticipantsIndex,
  threadSubject,
  parkedMessageIds,
  triagePiles,
  type ComposeAttachment,
  type ConsentPartition,
  draftBodyKnown,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type FeedView,
  type Folder,
  type OhmailView,
  type WaterlineMeta,
  type SearchHit,
  type FolderEntity,
  type TagDTO,
  type TriagePileEntry,
} from "@ohmail/client-engine";
import {
  Button,
  CommandPalette,
  FocusReplyOverlay,
  Icon,
  Kbd,
  RailNav,
  Reader,
  SettingsSection,
  useCommandPalette,
  useTheme,
  useToast,
  type Command,
  type RailGroup,
  type RailNavProps,
} from "@ohmail/ui";
import {
  EngineProvider,
  useDemoMode, useResolvedDemoMode,
  useEngine,
  useEngineVersion,
  useSyncStatus,
  type OwnerResolver,
  type ProvidedEngine,
} from "./engine";
import { PullNewMail, usePullNewMail } from "./PullNewMail";
import { useOlderMail } from "./older-mail";
import { PLACE_LABEL, avatarHue, hueOf, initialsOf, placeLabel, resurfaceLabel, tomorrowNine } from "./format";
import { activeFormatLocale, activeFormatZone } from "./locale";
import { displayAddress, displayDomain } from "./idn";
import { MessagePane, type BulkAction, type MessageAction } from "./MessagePane";
import { AttachmentPreview } from "../components/AttachmentPreview";
import { dispatchMarkAll, dispatchMarkAllRead } from "./read-all";
import { useMessageAttachments } from "./attachments";
import { useRemoteImages } from "./remote-images";
import { useConsentState, type ConsentTransport } from "./consent-state";
import { FirstRun, type FirstRunDecideSubject } from "./FirstRun";
import type { FirstRunHost } from "./first-run-host";
import type { OnboardingFacts } from "./onboarding";
import { readBootCache, writeBootCache } from "./boot-cache";
import { readOwner } from "./owner-cookie";
import { useAppLocale } from "./LocaleContext";
import { useScreenerState } from "./screener-state";
import { useJunkWindow, type JunkWire } from "./junk-window";
import { useOlderBody, type OlderBodyWire } from "./older-body";
import { syncMayRead } from "./sync-scheduler";
import { useScreenerSuggestions, type SenderSuggestion, type SuggestWire } from "./screener-suggest";
import { AutoSuggestRow } from "./AutoSuggestRow";
import { ScreeningSection } from "./ScreeningSection";
import { DormancyRow } from "./DormancyRow";
import {
  useComposeAutosave, reopenWouldOverwrite, type ComposeFate,
} from "./compose-autosave";
import { RemoteImagesRow } from "./RemoteImagesRow";
import { TrackingPixelsRow } from "./TrackingPixelsRow";
import { AutoUnsubscribeRow } from "./AutoUnsubscribeRow";
import { FoldersRow } from "./FoldersRow";
import { SignaturesRow } from "./SignaturesRow";
import { FoldersRailGroup } from "./FoldersRailGroup";
import { useFolderVerbs } from "./folder-verbs";
import { folderTailVerdict, folderUnreadCounts } from "./folders";
import { AwayResponderRow, type AwayTransport } from "./AwayResponderRow";
import { AwayNotice, useAwayNotice } from "./AwayNotice";
import { OhmarchyOffer, useOhmarchyOffer } from "./OhmarchyOffer";
import type { ApplyFaceAllDevices } from "./FaceRow";
import { ProfileImportCard, useProfileImport, type ProfileImportTransport } from "./ProfileImportCard";
import {
  COMPOSE_SEND_KEY, heldRowUnverified, inlineForwardKey, SEND_IN_FLIGHT_PHASES,
  sendPendingInOutbox, useMailSend, readReplyDraft, writeReplyDraft,
  readReplyMeta, writeReplyMeta, type SendState,
} from "./mail-send";
import { attachSendLockDraft, holdOf } from "./send-lock";
import {
  clearComposeDraft,
  composePlan,
  composeSessionId,
  readComposeDraft,
  readComposeRow,
  writeComposeDraft,
  writeComposeRow,
  writeComposeSession,
  EMPTY_COMPOSE,
  type ComposeFields,
  type ComposePrefill,
  type MailSend as MailSendMutation,
} from "./compose";
import { appendRich, EMPTY_RICH, isRichEmpty, type RichValue } from "./rich-text";
import {
  SIG_FOLLOWING, effectiveSignature, effectiveSignatureHtml, withSignature,
  type SignatureState,
} from "./signature";
import { useDraftReply, type DraftedReply } from "./draft-reply";
import { RichEditor } from "./RichEditor";
import { TagPicker, placePicker, type TagPickerState } from "./TagPicker";
import { KeymapProvider, useCursorPlacer, useKeyBindings, useModGlyph, type KeyBinding } from "./keymap";
import { createSeenBatcher } from "./seen-batch";
import { readColumnHidden, readColumnHiddenFor, watchZeroPushTier, zeroPushTier } from "./narrow";
import { ZoneCursor, currentZone, setRailSummon } from "./zone-nav";
import "./zone-cursor.css";
import { ColumnHandles } from "./ColumnHandles";
import { ShortcutSheet } from "./ShortcutSheet";
import { SyncBar } from "./SyncBar";
import { HostConnectionLine } from "./HostConnectionLine";
import type { HostConnection } from "./host-connection";
import { UnsavedChanges } from "./UnsavedChanges";
import { UpdateNotice } from "./UpdateNotice";
import { DurabilityNotice } from "./DurabilityNotice";
import { MailStateProvider, useMailState, type FreshnessProbe, type MailboxProbe } from "./MailStateProvider";
/* The ONE stand-down predicate, aggregated over the roster: what may the Screener do here, and
   what changed about who organizes these mailboxes that nobody has acknowledged? Settings →
   Mailboxes renders its own state line from the same `readerStandDown` underneath. */
import {
  organizerNotices, readerMoveRefusal, rosterStateOf, screenerMode,
  type RosterState,
} from "./mail-state";
/* Backspace/Delete → Trash, and the window in which it has not happened yet. See the module. */
import { deleteKeyBindings, hideMessages, restoreDispatch, useDeleteIntentReplay, useDeleteUndo } from "./delete-undo";
import { isModalOpen } from "./modal-gate";
import { useStableCallback } from "./stable-callback";
/* The once-per-change line above the Ohbox, and the shape of the press that ends it. */
import { OrganizerNotice, type OrganizerNoticeTransport } from "./OrganizerNotice";
/* The OS-answer seam, threaded to `SettingsView` for the hosts that must inject one. */
import type { NotificationHost } from "./notification-settings";
import { ViewBoundary } from "./ViewBoundary";
import {
  formatRecipientChips,
  optionsFromFacts,
  optionsFromMirror,
  replyAllRecipients,
  replyEnvelopeOnWire,
  replyEnvelopePlan,
  replyRecipients,
  resolveComposeFrom,
  resolveReplyFrom,
  type ReplyEnvelopeEdit,
} from "./compose-from";
import { MessageChromeProvider, type MessageBarPanel } from "./message-chrome";
import { SenderMenu, type SenderMenuState } from "./SenderMenu";
import { SenderAuditPanel, type SenderAuditState } from "./SenderAuditPanel";
import { attributeMessages } from "./sender-audit";
import {
  dispatchScreeningChange,
  planScreeningChange,
  senderScreening,
  worstStatus,
  type ScreeningDest,
  type ScreeningScope,
} from "./sender-screening";
import { SubjectRuleSheet, type SubjectRuleState } from "./SubjectRuleSheet";
import { planSubjectRule, subjectRuleContext, subjectRuleToast, type TermField } from "./subject-rule";
import { senderHitOf } from "./sender-hit";
import { forwardEnvelopePlan, forwardSend } from "./forward-send";
import {
  go, goFolder, goScreener, goSettings, goTag, goTriage, nameFirstRunMailbox, reflectMessage,
  useHashRoute,
  type Route, type ScreenerSegmentId, type TriagePileId,
} from "./routing";
import { HistoryView } from "../views/HistoryView";
import { SeedReviewView } from "../views/SeedReviewView";
import { OhboxView, type OhboxReplyDone } from "../views/OhboxView";
import { ReadsView, type ReadsChipState } from "../views/ReadsView";
import { ReceiptsView } from "../views/ReceiptsView";
import { ScreenerView } from "../views/ScreenerView";
import { SearchView } from "../views/SearchView";
import { AddressView } from "../views/AddressView";
import { SettingsView, type MailboxEntity, type NotificationsMeta, type PaneId } from "../views/SettingsView";
import { TagView } from "../views/TagView";
import { FolderView } from "../views/FolderView";
import { TrashView } from "../views/TrashView";
import { useTrashPage } from "./trash-page";
import { useTrashWindow, type TrashWire } from "./trash-window";
import { TriageView } from "../views/TriageView";
import { ComposeView } from "../views/ComposeView";
import { DraftsView } from "../views/DraftsView";
import { reconcileWakeRegistration, updateNotifyWords } from "./notification-settings.js";
import { usePersistedFlag, UI_KEYS } from "./persisted-ui.js";
import { durableSessionSet } from "./durable";

interface ReadsAiChipEntity {
  afterId: string;
  label: string;
  approvedLabel: string;
  correctedLabel: string;
}

/*
 * The typing guard used to live here and be threaded into five views as a prop. It is now
 * `isTypingTarget` in `keymap.tsx`, applied once by the one listener — a guard that every
 * caller has to remember to apply is a guard one caller will eventually forget.
 */

/**
 * The stable name of a Reply Run entry: the message it stands for, or its title when it has
 * none (fixture-only `triage_item` rows, which nothing can be sent in reply to).
 *
 * `TriageView` already keys its done-marks this way. Naming it once means the map of typed
 * replies, the done set and the pile row cannot drift apart over what counts as "this item".
 */
const frKeyOf = (item: TriagePileEntry): string => item.messageId ?? item.title;

/**
 * THE RAIL ROW ↔ THE TRIAGE PILE, stated once.
 *
 * The rail's ids are historical (`triage`, `triage-aside`, `triage-resurface`) and the route's
 * are the piles' own names (`reply`, `aside`, `resurface`), so exactly one place converts. It
 * used to be `if (id.startsWith("triage")) go("triage")` — a conversion that threw the answer
 * away, which is the whole of the reported defect.
 */
const TRIAGE_PILE_OF_RAIL: Record<string, TriagePileId> = {
  triage: "reply",
  "triage-aside": "aside",
  "triage-resurface": "resurface",
};
const RAIL_OF_TRIAGE_PILE: Record<TriagePileId, string> = {
  reply: "triage",
  aside: "triage-aside",
  resurface: "triage-resurface",
};

/**
 * The rail ids the number keys reach, and the ONLY hand-written part of that feature: which
 * rows are piles. The ORDER is not written here — it is read off `railGroups` — so this list
 * cannot put `3` on the wrong row, only include or exclude a row from being numbered.
 */
const PILE_IDS: string[] = ["ohbox", "reads", "receipts", "screener", ...Object.keys(TRIAGE_PILE_OF_RAIL)];
/** The `g` chord's label key per numbered rail row — one sentence for both chords to a place. */
const PILE_CHORD_LABEL: Record<string, "shortcuts.goOhbox" | "shortcuts.goReads" | "shortcuts.goReceipts" | "shortcuts.goScreener" | "shortcuts.goLater" | "shortcuts.goParked" | "shortcuts.goResurface"> = {
  ohbox: "shortcuts.goOhbox",
  reads: "shortcuts.goReads",
  receipts: "shortcuts.goReceipts",
  screener: "shortcuts.goScreener",
  triage: "shortcuts.goLater",
  "triage-aside": "shortcuts.goParked",
  "triage-resurface": "shortcuts.goResurface",
};

/** The `boot-cache.ts` scope for the account's own addresses. See `ownAddresses` below. */
const OWN_ADDRESSES_BOOT_SCOPE = "own-addresses";

/**
 * The memo key for {@link ShellInner}'s `ownAddresses` — see there for why
 * the addresses and not the facts row. Sorted and lower-cased so the same
 * set in a different order, or with different server casing, is one key.
 * JSON, never a join character: a literal NUL join once made `file` report
 * this source as `data` and every grep-family tool skip it in silence.
 * JSON escapes its own delimiters, so no two distinct lists can produce
 * one string, and every byte of the result is printable.
 */
function ownAddressKey(
  facts: ReadonlyArray<{ address: string }> | null,
  remembered: readonly string[] | null,
): string {
  const list = facts?.map((m) => m.address) ?? remembered ?? [];
  return JSON.stringify([...list].map((a) => a.trim().toLowerCase()).sort());
}

/** A cached address list an older build wrote degrades to "no cache", never to mixed types. */
function acceptAddressList(parsed: unknown): string[] | null {
  if (!Array.isArray(parsed)) return null;
  return parsed.every((x): x is string => typeof x === "string") ? parsed : null;
}

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
 * "No conversation of people here", as ONE array for the whole app.
 *
 * Most rows in most lists are not threads, so this is the answer nearly every lookup gives. A
 * fresh `[]` each time would be a new prop identity on every render of every row — see
 * `participantsOf`.
 */
const NO_PARTICIPANTS: { initials: string; hue: number }[] = [];

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
export function readerMessageFor(
  readerFor: string | null,
  fromMirror: (id: string) => EngineMessage | undefined,
  offMirror: EngineMessage | null,
): EngineMessage | null {
  if (!readerFor) return null;
  const mine = fromMirror(readerFor);
  if (mine) return mine;
  return offMirror?.id === readerFor ? offMirror : null;
}

/**
 * The body-hydration callback, as a factory whose one job is watchable:
 * FORWARD the caller's options to the engine. Inline it was
 * `(id) => engine.hydrateBody(id)` — dropping `{ retry: true }` from four
 * consumers' retry buttons, and the engine re-asks a FAILED body only
 * under that flag, so every retry button was inert: a body that 500'd
 * could not be recovered without a reload. The declared type accepted
 * `opts` and the implementation ignored them — a named unit now, with
 * `test/hydrate-body-retry.test.ts` watching the forward.
 */
export function makeHydrateBody(
  engine: { hydrateBody: (messageId: string, opts?: { retry?: boolean; urgent?: boolean }) => unknown },
): (messageId: string, opts?: { retry?: boolean; urgent?: boolean }) => void {
  return (messageId, opts) => {
    void engine.hydrateBody(messageId, opts);
  };
}

/**
 * WHETHER A DRAFT MAY BE OPENED YET — a named unit for the reason `makeHydrateBody` is.
 *
 * A bounded sync page can carry a draft row without its text, and the stale-resume freshen
 * applies page 1 over the mirror on every session older than five minutes. Seeded as "" that row
 * is an empty editor whose next autosave PUT replaces what the person wrote. So an unknown body
 * is fetched (`GET /drafts/:id`, one read) and the editor opens only with the text in hand; a
 * read that cannot answer opens nothing and says so, because every other arm shows the message
 * as shorter than it is.
 */
export async function openDraftDecision(
  draft: EngineDraft,
  io: {
    readDraftBody: (draftId: string) => Promise<string | null>;
    openWithBody: (draft: EngineDraft, body: string) => void;
    unavailable: () => void;
  },
): Promise<void> {
  if (draftBodyKnown(draft)) {
    /* `?? ""` is unreachable past the predicate and is the type's, not a default: an empty string
       is a KNOWN body and takes this arm, which is what lets somebody clear a draft. */
    io.openWithBody(draft, draft.body ?? "");
    return;
  }
  const text = await io.readDraftBody(draft.id);
  if (text === null) { io.unavailable(); return; }
  io.openWithBody({ ...draft, body: text }, text);
}

/**
 * The THREAD-hydration callback, a named unit for the same reason `makeHydrateBody` is.
 *
 * The forward that matters here is the ARRAY: an inline `(ids) => engine.hydrateThread(ids)` is
 * the same shape that once silently dropped `{ retry }`, and the failure mode is quieter — a
 * dropped or truncated id list produces a thread whose last siblings sit on a loading note for
 * ever, with nothing on screen or in the suite to say which call was short.
 */
export function makeHydrateThread(
  engine: { hydrateThread: (messageIds: string[]) => unknown },
): (messageIds: string[]) => void {
  return (messageIds) => {
    void engine.hydrateThread(messageIds);
  };
}

/**
 * The tags EVERY message in `ids` carries — the intersection, not the union.
 *
 * The picker renders a tag as assigned or not, and pressing an assigned one REMOVES it. Over
 * a set, "any of them has it" would therefore draw a half-applied tag as done, and the next
 * press would strip it from the two that had it instead of adding it to the eight that did
 * not — the opposite of what the row appears to offer. One message is the one-element case
 * of the same rule, so there is one derivation and no branch.
 */
function tagsOnAll(reader: EntityReader, ids: string[]): string[] {
  const lists = ids.map((id) => reader.get<EngineMessage>("message", id)?.labels ?? []);
  if (lists.length === 0) return [];
  return lists.reduce<string[]>(
    (acc, labels) => acc.filter((tagId) => labels.includes(tagId)),
    [...lists[0]!],
  );
}

/**
 * The rail, and the tag-collapse state that belongs to it. `tagsOpen` as `AppShell` state
 * caused the ~5s tag collapse twice over: the toggle re-rendered the whole shell (hundreds of
 * list rows), and the controlled `open` was baked into a `groups` memo whose deps did not list
 * it, so the group only caught up when something unrelated recomputed the memo. Holding the
 * state here re-renders only this component and `RailNav`, and `open` is injected fresh per
 * render. Persistence stays the shell's job (`RailNav` is shared with the desktop, which has no
 * localStorage); `usePersistedFlag` is SSR-safe and its post-mount read re-renders only the
 * rail.
 */
/**
 * Where the "Get ohmail for desktop" prompt may appear — the signed-in
 * browser, only. `desktop` is the shell's platform tell: the desktop app
 * injects `desktopSection` (the pane only a native process can have), so
 * its presence IS "this build is the desktop app" — the prompt cannot show
 * inside the app it invites people to install. `demo` is excluded because
 * the demo is a shop window, and the shell renders only for the demo or a
 * validated session, so `!demo` in a browser is a signed-in reader. Pure
 * and exported so a test drives the branch as a value.
 */
export function showDesktopCta(opts: { demo: boolean; desktop: boolean }): boolean {
  return !opts.demo && !opts.desktop;
}

/**
 * localStorage key for a one-time dismissal of the desktop prompt.
 *
 * The stored value is `"1"` — `usePersistedFlag`'s own true — and the key predates the flag
 * moving up to `AppShell`, so installs that dismissed under the old in-component read keep
 * their dismissal.
 */
export const DESKTOP_CTA_DISMISSED = "ohmail.desktopCtaDismissed";

/**
 * HOW LONG THE CURSOR HINT STANDS — the one line the first press of a message verb on a
 * cursorless list shows (`placeCursor`). Shorter than the toast's 2600 ms default, because this
 * one carries no action to reach for and the second press is meant to follow it immediately.
 *
 * Exported so a guard reads the number rather than restating it: a hint that outlives the press
 * it explains, or vanishes before it can be read, is a difference a test should be able to see.
 */
export const CURSOR_HINT_MS = 2400;

/**
 * A subtle, dismissible line at the foot of the rail: "Get ohmail for
 * desktop", linking to the site's download section in a new tab.
 * CONTROLLED — the dismissal state lives in `AppShell`
 * (`usePersistedFlag`), and that placement is a fix: when this component
 * owned the flag it answered dismissal by rendering `null`, but `AppShell`
 * had already judged the footer slot non-empty for its sake, leaving a
 * dead padded band under the Command row on every dismissed install. The
 * component that decides whether the slot exists must know what is in it.
 */
export function DesktopCta({ href, label, dismissLabel, onDismiss }: {
  href: string;
  label: string;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div className="rail-desktop-cta">
      <a className="rail-desktop-cta-link" href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
      <button
        type="button"
        className="rail-desktop-cta-x"
        aria-label={dismissLabel}
        onClick={onDismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

function ShellRail({ groups, footer, offerDesktopCta, hostConnection, ...rest }: RailNavProps & {
  /**
   * The paired desktop's standing line — the third member of the footer
   * slot, beside the account address and the desktop prompt. In this slot
   * and not the sync slot because of what the two mean: the sync slot's
   * every state clears itself; this one is where the rail says whose mail
   * this is, and on a paired desktop that is "that computer's copy" —
   * whether that computer answers belongs to the same line (`rail.css`,
   * beside `.rail-host`). It also makes the slot non-empty on its own,
   * which is why `fullFooter` counts three things now.
   */
  hostConnection?: HostConnection;
  /**
   * Is the "Get ohmail for desktop" prompt on offer at all (the pure platform branch —
   * `showDesktopCta`)? The DISMISSAL is this component's own state, held HERE for `tagsOpen`'s
   * exact reason: `usePersistedFlag`'s post-mount read is a state write, and on the shell it
   * re-rendered the active hundreds-of-rows view once per mount on EVERY install that had
   * dismissed the prompt — plus once more on the × itself. Down here it re-renders the rail.
   */
  offerDesktopCta?: boolean;
}) {
  const t = useTranslations();
  const [tagsOpen, setTagsOpen] = usePersistedFlag(UI_KEYS.tagsOpen, true);
  const [ctaDismissed, dismissCta] = usePersistedFlag(DESKTOP_CTA_DISMISSED, false);
  const withTagState = useMemo<RailGroup[]>(
    () =>
      groups.map((g) =>
        g.tags ? { ...g, tags: { ...g.tags, open: tagsOpen, onOpenChange: setTagsOpen } } : g,
      ),
    [groups, tagsOpen, setTagsOpen],
  );
  /* The footer slot is DECIDED where the last of its contents is known: `RailNav` keeps a
     padded `.rail-mail` box around any truthy footer, so this must be `undefined` — not an
     empty fragment — when neither the account line nor a live prompt will render. The old
     arrangement had `DesktopCta` answer its dismissal with `null` from inside the slot, and
     the box stood empty under the Command row (measured live at 14px). */
  const cta = offerDesktopCta && !ctaDismissed ? (
    <DesktopCta
      href="/#download"
      label={t("rail.getDesktop")}
      dismissLabel={t("rail.getDesktopDismiss")}
      onDismiss={() => dismissCta(true)}
    />
  ) : null;
  const host = hostConnection ? <HostConnectionLine connection={hostConnection} /> : null;
  const fullFooter = footer || cta || host ? (
    <>
      {footer}
      {host}
      {cta}
    </>
  ) : undefined;
  return <RailNav groups={withTagState} {...rest} footer={fullFooter} />;
}

/**
 * `demo` here is the SERVER's answer, and it is only a floor — `EngineProvider` re-derives
 * the mode from the real URL on the client and publishes what the engine was actually built
 * in. The chrome below reads THAT (`useDemoMode`), so the ribbon and the frozen demo clock
 * can never disagree with the adapter the data is coming from.
 */
export function AppShell({
  demo,
  engine,
  resolveOwner,
  onConfirmed,
  mailboxFacts,
  organizerNoticeTransport,
  mirrorFreshness,
  hostConnection,
  sendSurfaceMaxTotalBytes,
  accountSection,
  mailboxSection,
  aiSection,
  billingSection,
  invitesSection,
  securitySection,
  aboutSection,
  desktopSection,
  devicesSection,
  defaultMailSection,
  notificationHost,
  screeningSection,
  screenerSuggest,
  awayTransport,
  awayIsLocal,
  awayOnHost,
  profileImportTransport,
  consentTransport,
  olderBodyWire,
  junkWire,
  trashWire,
  suggestWire,
  firstRun,
  mailtoDraft,
  onMailtoDraftSeeded,
  onUnread,
}: {
  demo: boolean;
  /**
   * AN ENGINE THE HOST BUILT ITSELF — the desktop app's seam, and nobody else's.
   *
   * `EngineProvider` normally decides what engine this shell runs on: fixtures for the demo, a
   * network client for a signed-in tab. The desktop app's mail comes from a process on the same
   * machine over a channel that is not `fetch`, and this file is compiled into a browser tab as
   * well as into that app — so the app builds the engine where the channel is and passes the
   * finished object through. See {@link ProvidedEngine}; `demo` still wins over it.
   */
  engine?: ProvidedEngine;
  resolveOwner?: OwnerResolver;
  /**
   * Threaded to {@link EngineProvider.onConfirmed} — the Cloud client's binding, committed by the
   * arm that has already believed the answer rather than by the classifier that produced it.
   * Absent on the desktop and the demo, like `resolveOwner`.
   */
  onConfirmed?: (accountId: string) => void;
  /**
   * "What state are this account's mailboxes in?", as a function the SHELL does not know how
   * to answer — the seventh injected prop, and the same seam as `resolveOwner` for the same
   * reason: `scripts/publish-desktop.mjs` DENYs `app/api-client`, so this shared shell may not
   * call `GET /mailboxes`. The Cloud client supplies one from `(product)/mailbox/CloudShell`;
   * Desktop and the demo supply nothing, and the sync strip then withholds every mailbox-keyed
   * state rather than guessing one. See `MailStateProvider` — a probe MUST reject on failure,
   * because an empty array is a claim about the account.
   */
  mailboxFacts?: MailboxProbe;
  /**
   * "Acknowledge the organizer notice on this mailbox" — the eighth injected prop, on
   * `mailboxFacts`'s rule and for its reason: the publish DENYs `app/api-client` here, so this
   * shell cannot reach `POST /mailboxes/:id/organizer-notice/dismiss` on either door.
   *
   * ABSENT WITHHOLDS THE NOTICE ENTIRELY, and that is the design rather than a fallback. A line
   * saying a mailbox changed hands, with no way to acknowledge it, is a warning that stands for
   * ever — the one thing this notice may never become. Settings -> Mailboxes keeps the permanent
   * state line and the controls on every door regardless.
   */
  organizerNoticeTransport?: OrganizerNoticeTransport;
  /**
   * "How old is the mail this window renders?", answered by the HOST's own mirror — the
   * desktop's seam and nobody else's, `mailboxFacts`'s shape for `mailboxFacts`'s reason. The
   * desktop's window engine drains the sidecar's LOCAL feed and is always current relative to
   * it, so the engine's own freshness cannot say the desktop is behind the hosted account —
   * the sidecar's `GET /mirror/freshness` can, and this probe is how it reaches the sync
   * strip's "as of <time> · catching up" arm. Absent everywhere else: the web reads the
   * engine's own verdict. See `MailStateProvider`'s `FreshnessProbe` for the failure contract.
   */
  mirrorFreshness?: FreshnessProbe;
  /**
   * "Is the computer this window reads through answering?" — the desktop's seam only; a browser
   * tab is never paired to anybody's laptop. Present means there is something wrong to say;
   * absent covers a browser tab, the other desktop doors, AND a healthy paired host — three
   * situations that must render identically, or the one state worth noticing becomes a change of
   * wording instead of the arrival of a warning (`host-connection.ts` has the shape and the
   * sixty-second grace). It also silences the sync strip's `stale` sentence — "catching up" is
   * an activity claim, and with the other machine off nothing is catching up; the ladder still
   * derives `stale`, only the sentence is withheld.
   */
  hostConnection?: HostConnection;
  /**
   * The host's own ceiling on attachment bytes in one send — declared by the host because only
   * the host knows its transport. The form-side twin of `sendSurfaceMaxTotalBytes`, same three
   * states (`composeAttachCap` holds the rule): absent = an undeclared host (every browser tab)
   * and resolves to the strict constant; `null` = the desktop's standalone door, where the only
   * real ceiling is the mailbox's own SIZE announcement; a number = a host naming its limit. NOT
   * passed on the desktop's cloud door — it forwards sends verbatim to the hosted API, so an
   * uncapped declaration would promise what the forward must refuse (`DesktopGate`;
   * `desktop-attach-cap.test.ts` guards both halves).
   */
  sendSurfaceMaxTotalBytes?: number | null;
  /**
   * The host's Settings → Account pane, injected rather than imported — the same seam as
   * `resolveOwner`, and see `views/SettingsView.tsx` for why it has to be one.
   *
   * Absent on a STANDALONE desktop install, which has no account. The desktop's HOSTED door does
   * supply one, and it is a different node rather than the same one: erasure is a step-up
   * ceremony no desktop session can satisfy, so what it offers is the way to the browser.
   */
  accountSection?: ReactNode;
  /** The host's Settings → Mailboxes pane. Same seam. */
  mailboxSection?: ReactNode;
  /**
   * The host's Settings → Subscription pane (plan, AI switch, and the way to invoices).
   *
   * Same seam and the same standalone rule as {@link accountSection}: absent where there is
   * nothing to bill, supplied on the desktop's hosted door, where the plan and the AI switch are
   * ordinary forwarded calls and only checkout and the portal are a door out.
   */
  aiSection?: ReactNode;
  billingSection?: ReactNode;
  /**
   * The host's Settings → Invites pane — who else may join a self-host server. Same seam as
   * {@link securitySection}; only the self-host Cloud client supplies one (the mint routes
   * exist on that composition alone), so managed tabs and every desktop door pass nothing
   * and the nav entry does not exist there. See `views/SettingsView.tsx`.
   */
  invitesSection?: ReactNode;
  securitySection?: ReactNode;
  /**
   * The BODY of the (i) panel for a live account. Same seam again, and it has to be: the
   * facts worth showing there — which mailbox is connected and when it last synced — come
   * from `GET /mailboxes`, which this shared shell may not call. Absent ⇒ the demo body.
   */
  aboutSection?: ReactNode;
  /**
   * The pane only a shell with a native process behind it can have: which
   * door this install came in by, which mailbox it opens, and the actions
   * that change either — every one a call to the desktop shell, which this
   * file cannot make (it also compiles into a browser tab). Injected like
   * {@link accountSection} and its mirror image: absent on the web (no
   * shell), where Account is absent on the desktop (no account). Carries
   * its own `label` — the words are the desktop's vocabulary. NOT gated on
   * `demo`: the pane describes the INSTALL, not an account, and is as true of a window showing sample mail.
   */
  desktopSection?: { label: string; node: ReactNode };
  /**
   * Settings → Devices — pairing this account's mail onto other devices,
   * injected in whichever shape the host has: the desktop's host mode
   * (serve this install's mail over the user's own tailnet) or the Cloud
   * client's server-side ceremony (mint a pairing QR, list and revoke
   * devices, gated on `/hello` announcing `features.pairing`).
   * Demo-masked like the other account panes, no longer exempt: the
   * exemption's premise ended when the Cloud client grew its node, and an
   * unmasked seam let `?demo=1` grow the one pane whose every verb mints or revokes a real credential.
   */
  devicesSection?: ReactNode;
  /**
   * ONE ROW AT THE FOOT OF SETTINGS → GENERAL, WHEN THE HOST IS AN APP THE OS CAN PREFER — the
   * desktop's, and nobody else's. "Which app opens mailto links" is a question about a COMPUTER,
   * so a browser tab passes nothing and the row does not exist there; the desktop supplies its
   * detect-and-request row (`DesktopDefaultMail.tsx`), whose every read and verb is a shell
   * command. On General rather than the Desktop pane because it is where somebody thinking
   * "mail links open the wrong app" would look — beside language and appearance.
   */
  defaultMailSection?: ReactNode;
  /**
   * Where the operating system's notification answer comes from, when it
   * is not this page's. Absent means the browser's own reader
   * (`Notification.permission` IS the OS answer in a tab). The desktop
   * window holds no notification permission and cannot acquire one — its
   * shell asks the platform on first use — so it injects a host that says
   * so, and the pane grows one sentence about who has the last word.
   * Measured cost of the gap: a master switch that could not be turned on,
   * with no sentence anywhere. See `apps/desktop/src/notify-host.ts`.
   */
  notificationHost?: NotificationHost;
  /**
   * The Screener pane's own controls, when the host has its own — the
   * desktop's, and nobody else's. This shell's `ScreeningSection` reads and
   * writes through `app/api-client`, which is not in the desktop build:
   * there every control asked, was refused, and drew nothing, so the pane
   * existed in the nav and was blank when opened. A host with its own
   * transport hands in its own section. Present ⇒ this shell's own section
   * is not built. Never both.
   */
  screeningSection?: ReactNode;
  /**
   * The Screener's suggest control, when the host has its own — the desktop's. The control this
   * shell builds asks a server what a set of senders would cost, because a hosted account
   * spends an allowance; a standalone install spends nothing and reaches its own model over a
   * channel this file cannot use — a different control, handed in ({@link desktopSection}'s
   * seam). `absorb` is what makes an injected control possible: there is exactly one suggestion
   * overlay and all its consumers read it, so a host lands answers there or nothing can display
   * them. Present ⇒ this shell's own control is not offered.
   */
  screenerSuggest?: (ctx: {
    /** Waiting senders with no answer yet, in queue order — what a purchase would buy. */
    senders: string[];
    /**
     * Waiting senders that ALREADY have one — what a re-ask would cover.
     *
     * Handed over for the same reason this shell's own control takes both: a queue that has been
     * worked through has an empty buy list and a full re-ask list, and a control given only the
     * first has nothing to say on exactly the account that has used the feature most. A host that
     * ignores it is free to; a host that cannot see it has no choice.
     */
    resuggestable: string[];
    absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
  }) => ReactNode;
  /**
   * The away responder's two calls, when the host has its own wire. A transport and not a section: the responder must
   * not have two implementations — one `PUT /away-responder` whose `updatedAt` IS the enablement episode the worker's
   * at-most-once record files under; a second copy would be a second definition of when an episode begins, visible as a
   * correspondent answered twice. The desktop needs it because `apiConfigured()` is false in every desktop build; the
   * hosted door forwards with the bearer. The standalone door runs the SAME implementation (`runAwayResponderPass` in
   * `@trafficflow/services`) with its own SMTP dial — replies go out while ohmail is open, the pane says exactly that.
   * Two-runners safety is structural: the lease, the organizer JOIN, and a UNIQUE reservation on (account, message).
   * Absent ⇒ the hosted client, gated on `autoOptIn.supported`.
   */
  awayTransport?: AwayTransport;
  /**
   * IS THE AWAY CONTROL ON THE STANDALONE DOOR? — passed straight through to
   * `AwayResponderRow.local`, where it decides one sentence: "Replies are sent while ohmail is open
   * on this computer."
   *
   * Separate from {@link awayTransport} being present, because the two answer different questions —
   * the transport says "this host has its own wire", which is true on BOTH desktop doors, and this
   * says "the replies leave from this machine", which is true on only one of them. Collapsing them
   * would put the standalone sentence on the hosted desktop pane, where it is false.
   */
  awayIsLocal?: boolean;
  /**
   * The other computer this install reads through, when it is a paired
   * desktop — the away responder's third promise. `awayIsLocal` says which
   * machine must be awake for a reply to go out, as a boolean; a paired
   * desktop is a third answer — the row and the drain are the HOST's, so
   * the machine to leave running is neither ours nor "the service", and
   * naming it is the content of the sentence. Absent everywhere else;
   * `AwayResponderRow` prefers it over `awayIsLocal` when both arrive,
   * which `awayDoorFor` makes unreachable in this app.
   */
  awayOnHost?: string | null;
  /**
   * The profile import's three calls, when the host has its own wire — the desktop, on BOTH doors
   * ({@link awayTransport}'s seam; `apiConfigured()` is false in every desktop build, so the shell's
   * own check never ran there). Live on the standalone door too, a fact about where the routes are
   * served: the confirm flow's three verbs are mounted on the local engine's own table, so a
   * standalone install asking is an install asking itself; the hosted door forwards with the bearer
   * (`profileImportDoorFor` in the desktop's `doors.ts` holds the rule). A transport, not a section:
   * the card, counts, fingerprint-as-consent and durable dismissal must have ONE implementation.
   * Absent ⇒ the hosted client, which is what a browser tab has.
   */
  profileImportTransport?: ProfileImportTransport;
  /**
   * `GET /consent` and its four writes, when the host has its own wire — the desktop's hosted door. Injected for
   * {@link awayTransport}'s reason with a wider blast radius: with `apiConfigured()` false, `consent.known`
   * stayed false for the life of the process and FOUR controls were withheld from an install mirroring a real
   * account — the dormancy dial, auto-suggest, auto-unsubscribe, and the account's interface language. A
   * transport, not sections, and one reason is sharper: `autoSuggest` is the only flag that authorises SPENDING,
   * and the spender reads it off this one hook — a host writing the flag its own way would leave that copy stale
   * in the direction that costs money. The standalone door hands in nothing: no account, no row —
   * `consent.standalone`, every control withheld structurally rather than offered dead.
   */
  consentTransport?: ConsentTransport;
  /**
   * THE REACH-PAST BODY WIRE, when the host has its own — the desktop on its HOSTED door. The
   * shared shell's default is the browser's Cloud client (decided inside `older-body.ts`, which
   * owns the api-client import); the desktop aliases that client to a refusing stub, so without
   * this wire a reach-past row's body there has no door at all. Same transport-not-a-control
   * rule as {@link consentTransport}: the states and their sentences are decided in
   * `older-body.ts` and only the bytes' route is injected.
   */
  olderBodyWire?: OlderBodyWire;
  /**
   * The junk window's wire, when the host has its own — the desktop, both doors. The shared
   * shell's default is the browser's Cloud client (`junk-window.ts` owns the import); the
   * desktop aliases that client to a refusing stub, so without this wire the Screener's third
   * segment stayed the flag-off Spam pile. Same transport-not-a-control rule as {@link
   * olderBodyWire}: only the bytes' route is injected. The hosted door forwards (Junk is never
   * mirrored); on the standalone door the flag in front of the segment cannot be STORED — one
   * field is missing (§17), see {@link ConsentTransport.foldersStorable} — so the control stays
   * withheld by the same gate as a flag-off browser.
   */
  junkWire?: JunkWire;
  /**
   * THE LIVE TRASH WINDOW'S WIRE, on the same terms as {@link junkWire}: the desktop aliases the
   * Cloud client to a refusing stub, so without a wire handed in the section reports "no server"
   * and is withheld. Both desktop doors serve `/trash/window*` — the standalone one from
   * `localRoutes`, the hosted one through the relay — so the wire is handed in on both.
   */
  trashWire?: TrashWire;
  /**
   * The Screener's two spend calls, when the host has its own wire — the
   * desktop's hosted door. Distinct from {@link screenerSuggest}, which
   * hands in a whole control: this is the wire the SHELL's machinery runs
   * on, needed for the part `CloudSuggest` structurally cannot do —
   * `autoOptIn.supported` gates the Settings opt-in row. Supplying it also
   * lets the overlay hydrate from `GET /screener` — answers the account
   * already paid for, which a desktop relaunch used to lose. Absent ⇒ the
   * hosted client; `false` on standalone: no account, no ledger, no spend.
   */
  suggestWire?: SuggestWire;
  /**
   * THE FIRST-RUN STAGE'S DOOR — the calls setup makes, from the surface that can make them.
   *
   * Absent ⇒ THE STAGE DOES NOT EXIST on this surface, structurally, and `#/first-run` renders
   * the Ohbox behind it and nothing else. That is the honest state for the demo (a fixture world
   * with no mailbox to connect and no account to stamp) and for any host that has not wired the
   * calls yet — the alternative, a dialog whose buttons refuse, is the built-tested-unreachable
   * shape this whole wave is written against.
   */
  firstRun?: FirstRunHost;
  /**
   * A compose the host was handed from outside — the desktop's mailto seam. The OS delivers a
   * `mailto:` click to the desktop shell, the parsed fields arrive here, and the shell seeds
   * the compose form the way `writeTo` and `openDraft` do — same release-first rule, same chip
   * formatting — then navigates to compose. `onMailtoDraftSeeded` is called once the form holds
   * the fields so the host drops its copy; a draft left in the prop would re-seed on every
   * remount over whatever was typed since. Fields are plain bounded text (the desktop's
   * `mailto.ts` is the one place a mailto is read); the body seeds as plain text (`html: ""`,
   * `openDraft`'s rule).
   */
  mailtoDraft?: ComposePrefill | null;
  onMailtoDraftSeeded?: () => void;
  /**
   * How many pieces of mail are waiting — published for a surface outside
   * the page (a dock icon). Deliberately the Ohbox rail number and not a
   * sum of every rail count: the Screener's waiting senders are people to
   * decide about rather than mail to read, and a badge counting them would
   * ask for attention the product spent two years learning not to ask for.
   * A callback, not a return value — the only consumer is a native shell
   * outside this tree. Absent in every browser tab.
   */
  onUnread?: (unread: number) => void;
}) {
  return (
    <EngineProvider demo={demo} engine={engine} resolveOwner={resolveOwner} onConfirmed={onConfirmed}>
      {/* ONE keydown listener for the whole client. Outside `ShellInner` so
          every view mounted under it can declare bindings into the same table, which is
          also the table the `?` sheet is generated from. */}
      <KeymapProvider>
        {/* The derived focus zone, reflected as `:root[data-zone]` for the tile-cursor CSS
            (`zone-cursor.css`). See `ZoneCursor`. */}
        <ZoneCursor />
        <MailStateHost probe={mailboxFacts} freshnessProbe={mirrorFreshness}>
          <ShellInner
            mailboxFacts={mailboxFacts}
            organizerNoticeTransport={organizerNoticeTransport}
            hostConnection={hostConnection}
            sendSurfaceMaxTotalBytes={sendSurfaceMaxTotalBytes}
            accountSection={accountSection}
            mailboxSection={mailboxSection}
            aiSection={aiSection}
            billingSection={billingSection}
            invitesSection={invitesSection}
            securitySection={securitySection}
            aboutSection={aboutSection}
            desktopSection={desktopSection}
            devicesSection={devicesSection}
            defaultMailSection={defaultMailSection}
            {...(notificationHost ? { notificationHost } : {})}
            screeningSection={screeningSection}
            screenerSuggest={screenerSuggest}
            awayTransport={awayTransport}
            awayIsLocal={awayIsLocal}
            awayOnHost={awayOnHost}
            profileImportTransport={profileImportTransport}
            consentTransport={consentTransport}
            olderBodyWire={olderBodyWire}
            junkWire={junkWire}
            trashWire={trashWire}
            suggestWire={suggestWire}
            firstRun={firstRun}
            mailtoDraft={mailtoDraft}
            onMailtoDraftSeeded={onMailtoDraftSeeded}
            onUnread={onUnread}
          />
        </MailStateHost>
      </KeymapProvider>
    </EngineProvider>
  );
}

/**
 * The mail-state provider, hoisted above `ShellInner`. As the outermost
 * element of `ShellInner`'s return, the shell PROVIDED the mailbox facts
 * and could not read them — fine while consumers were leaves, wrong once
 * the From line needed the facts on the wire: `sendReply` and the compose
 * plan are built in `ShellInner`, and a fact the shell cannot see is one
 * the mutation cannot carry. `mirrored` moved up because the provider
 * needs it. Nothing else moved; the existing consumers read a context,
 * not a position.
 */
function MailStateHost({ probe, freshnessProbe, children }: { probe?: MailboxProbe; freshnessProbe?: FreshnessProbe; children: ReactNode }) {
  const engine = useEngine();
  const version = useEngineVersion();
  /**
   * EVERY message in the MIRROR — Screener, Reads and Receipts included, not the Ohbox's rows.
   *
   * The progress signal. `MailStateProvider` folds it into a stateful growth reducer, and two
   * surfaces each sampling their own could disagree about whether the mirror is growing, so it
   * is sampled exactly once — here. The engine calls `notify()` once per drained page, so this
   * is live with no extra plumbing.
   */
  const mirrored = useMemo(() => engine.read().list("message").length, [engine, version]);
  return (
    <MailStateProvider probe={probe} freshnessProbe={freshnessProbe} mirrored={mirrored}>
      {children}
    </MailStateProvider>
  );
}

function ShellInner({ mailboxFacts, organizerNoticeTransport, hostConnection, sendSurfaceMaxTotalBytes, accountSection, mailboxSection, aiSection, billingSection, invitesSection, securitySection, aboutSection, desktopSection, devicesSection, defaultMailSection, notificationHost, screeningSection, screenerSuggest, awayTransport, awayIsLocal, awayOnHost, profileImportTransport, consentTransport, olderBodyWire, junkWire, trashWire, suggestWire, firstRun, mailtoDraft, onMailtoDraftSeeded, onUnread }: {
  /** The pull settle watch's read — the same probe `MailStateHost` above provides the strip. */
  mailboxFacts?: MailboxProbe;
  /** See `AppShell`'s prop of this name — absent withholds the organizer notice. */
  organizerNoticeTransport?: OrganizerNoticeTransport;
  /** See `AppShell`'s prop of this name — present only on a paired desktop with something wrong. */
  hostConnection?: HostConnection;
  /** The host's surface declaration for the attach ceiling — see `AppShell`'s prop of this name. */
  sendSurfaceMaxTotalBytes?: number | null;
  accountSection?: ReactNode;
  mailboxSection?: ReactNode;
  aiSection?: ReactNode;
  billingSection?: ReactNode;
  invitesSection?: ReactNode;
  securitySection?: ReactNode;
  aboutSection?: ReactNode;
  desktopSection?: { label: string; node: ReactNode };
  devicesSection?: ReactNode;
  defaultMailSection?: ReactNode;
  /** See the outer prop of the same name. */
  notificationHost?: NotificationHost;
  screeningSection?: ReactNode;
  screenerSuggest?: (ctx: {
    senders: string[];
    resuggestable: string[];
    absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
  }) => ReactNode;
  awayTransport?: AwayTransport;
  awayIsLocal?: boolean;
  awayOnHost?: string | null;
  profileImportTransport?: ProfileImportTransport;
  consentTransport?: ConsentTransport;
  /** The reach-past body wire — see the outer prop of the same name. */
  olderBodyWire?: OlderBodyWire;
  /** The Junk window's wire — see the outer prop of the same name. */
  junkWire?: JunkWire;
  /** The live Trash window's wire — see the outer prop of the same name. */
  trashWire?: TrashWire;
  suggestWire?: SuggestWire;
  /** The first-run stage's door — see the outer prop of the same name. */
  firstRun?: FirstRunHost;
  mailtoDraft?: ComposePrefill | null;
  onMailtoDraftSeeded?: () => void;
  onUnread?: (unread: number) => void;
}) {
  const demo = useDemoMode();
  /* For EFFECT GATES only — see `useResolvedDemoMode`. Never rendered: reading it in output
     would reintroduce the hydration mismatch `useDemoMode` exists to prevent. */
  const resolvedDemo = useResolvedDemoMode();
  const t = useTranslations();
  /* THE REPLY RUN'S WORDS. `FocusReplyOverlay` has none of its own — it is a composite, and
     composites read no catalogue. The progress line takes both numbers as arguments because not
     every language puts them in this order. */
  const frCopy = useMemo(
    () => ({
      ariaLabel: t("triage.runAria"),
      empty: t("triage.runEmpty"),
      emptyBack: t("triage.runBack"),
      progress: (step: number, total: number) => t("triage.runProgress", { step, total }),
      placeholder: t("triage.runPlaceholder"),
      replyAria: t("triage.runReplyAria"),
      exit: t("triage.runExit"),
    }),
    [t],
  );
  const engine = useEngine();
  const version = useEngineVersion();
  /**
   * The account's mailboxes as `GET /mailboxes` reported them, or `null` for "we cannot see"
   * (Desktop, demo, a Cloud tab before its first poll). Read here — rather than provided here,
   * as it once was — so the From line and the mutation it describes come from one source.
   */
  /**
   * `settled` travels to the piles as a PROP, not through `useMailState()`
   * at their top level — a hard constraint: `test/ohbox-read-state.test.ts`
   * mounts `OhboxView` under `KeymapProvider` alone, and `useMailState`
   * throws without a provider by design. A hook at the view's top would
   * take that harness down on mount in every branch. Still derived exactly
   * once, up here, from the one binding; a prop is how a derivation
   * reaches a component that must be mountable alone.
   */
  const {
    mailboxes: facts, rosterProbed, state: mailState, refresh: refreshFacts,
  } = useMailState();
  /**
   * Every filing dispatch goes through here. A filing decision writes `folder_state`; the strip
   * reports the outstanding work from `GET /mailboxes`, which is polled every 30 s and on
   * nothing else — so the sentence after a press was up to thirty seconds stale. A helper rather
   * than a call at each door because there are five doors with five shapes
   * (`test/filing-refresh-on-decision.test.tsx` pins every filing dispatch to it). Chained AFTER
   * the settle, never at the press — a press-time read reports the pre-decision number. A
   * rejection still refreshes: the rolled-back overlay leaves exactly what a fresh read says.
   * `refreshFacts` has a constant identity (a ref at the provider).
   */
  const fileAndRefresh = useStableCallback(<T,>(dispatch: Promise<T>): Promise<T> => {
    dispatch.then(refreshFacts, refreshFacts);
    return dispatch;
  });
  /**
   * THE MIRROR AS IT IS. Where each message physically sits on the server.
   *
   * Every mutation, every body open and the search index read from THIS reader and never from
   * the projected one below. A mutation reads a message's current folder to work out what it
   * is moving from; handing it a presentation would make it move from a place the server has
   * never heard of.
   */
  const reader = engine.read();
  const toast = useToast();
  /**
   * Delete, with the window in which it has not happened yet — see `delete-undo.ts` for why
   * Undo on this verb is a delayed commit. Declared here, above `presented`, because the held
   * ids are what that projection subtracts: the row leaves every pile on the press, and the
   * mutation that would do that is what the window postpones. The roster rides a ref written in
   * an EFFECT: assigning during render publishes a value a concurrent render may discard — a
   * role that never committed, exposed to a key handler that did. The refusal asks about THIS
   * MESSAGE'S mailbox, never the account (`readerMoveRefusal`); `[mailboxId]` so single and
   * bulk arms are one code path.
   */
  /* THE STATE, not the array. `mailboxes: null` collapses "no probe on this shell" (the desktop,
     the demo) with "the probe has not answered", and those are opposite answers for a write gate
     — see `rosterStateOf`. The resting value is `pending`, which refuses: a shell that HAS a probe
     starts there, and one that has none is corrected by the effect on its first commit. */
  const rosterRef = useRef<RosterState>({ kind: "pending" });
  const deleting = useDeleteUndo({
    /* THE FIFTH DOOR, WRAPPED AT THE DEP AND NOT AT THE PRESS. The delete arm below opens a
       window rather than dispatching, so the mutation leaves from `delete-undo.ts` — after the
       undo window closes, and for a selection in a batch. Wrapping the injected dispatcher is
       the only place that covers both, and `test/filing-refresh-on-decision.test.tsx` pins this
       line by name: nothing conflicts here, so a census that only read this file would have gone
       vacuous for `message_delete` instead of red. */
    mutate: (messageId) => fileAndRefresh(engine.mutate({ kind: "message_delete", messageId })),
    toast,
    copy: {
      deleted: t("ohbox.toastDeleted"),
      undo: t("screener.toastUndo"),
      undone: t("ohbox.deleteUndone"),
      failed: t("ohbox.deleteFailed"),
      /* SAID WHEN THE JAR REFUSED THE RECORD — the press acts at once and offers no undo.
         `session` rather than `ohbox`: it is the same sentence the Screener says. */
      noUndo: t("session.noUndoHere"),
      /* THE PLURAL SET, for a press over a selection. Separate sentences rather than one string
         with a number in it: the singular is what the key has said since it shipped, and it stays
         word for word so nothing about the one-message press moves. */
      deletedMany: (count) => t("ohbox.toastDeletedMany", { count }),
      undoneMany: (count) => t("ohbox.deleteUndoneMany", { count }),
      failedMany: (count) => t("ohbox.deleteFailedMany", { count }),
    },
    /* EVERY mailbox the press touches, asked once. A nullish id becomes `""`, which the predicate
       refuses as an id no roster row carries — the same answer, reached without a second branch
       here that could drift from the one inside it. */
    refusal: (mailboxIds) => readerMoveRefusal(
      rosterRef.current,
      mailboxIds.map((id) => id ?? ""),
      refusalCopy,
    ),
  });
  /**
   * Restore, held the same way the delete is — a second window over the same machinery. Two
   * windows, not one queue: a held delete subtracts from `presented`, a held restore subtracts
   * from the TRASH page, which is off-mirror — one shared held set would make each surface hide
   * the other's rows. The refusal is the same organizer question, asked at the press. The
   * dispatch is `restoreDispatch` over `engine.restoreFromTrash` — NOT `engine.mutate`, which
   * rejects a mutation over a tombstoned row (`delete-undo.ts` has the argument). The toast
   * names the SERVER's answer (`restoreTo` off the response): the origin folder can disappear
   * between the page and the press.
   */
  const restoring = useDeleteUndo({
    verb: "restore",
    /* THE DISPATCH RAISES THE PLACE SENTENCE, because that is the one moment the place is known
       — see `restoreDispatch`, where the alternative (a second call at the press) is named as
       the thing that would silently cancel the undo window.
       AND IT SAYS "Restoring", never "Restored": the server's answer is a QUEUED intent
       (`pending`), the mail server performs the move on the organizer's next turn, and the row
       comes back when that landing is observed. The sentence this used to say claimed a
       completed restore seconds before anything had moved, so an outage left the person told
       their mail was back while it sat in Trash. The place is still the server's answer. */
    mutate: (messageId, pressId) => fileAndRefresh(
      restoreDispatch(
        (id, opts) => engine.restoreFromTrash(id, opts),
        (restoreTo) => toast(t("trash.toastRestoringTo", { place: placeLabel(restoreTo) })),
      )(messageId, pressId),
    ),
    toast,
    copy: {
      /* THE PLACE IS NOT KNOWN AT THE PRESS. The window's `deleted` sentence is said the moment
         the row is hidden, and the destination arrives with the server's answer seconds later —
         so this one says what is TRUE then ("Restoring…") and the arm that reads the response
         says where it went. A sentence naming a place before the server has answered would be
         the false-state failure this whole seam exists to avoid. */
      deleted: t("trash.restoring"),
      undo: t("screener.toastUndo"),
      undone: t("trash.toastRestoreUndone"),
      failed: t("trash.toastRestoreFailed"),
      /* THE SAME SENTENCE THE DELETE WINDOW SAYS: a refused jar takes the undo away, not the
         restore. Required by `DeleteUndoCopy` so no window can offer an undo it cannot honour. */
      noUndo: t("session.noUndoHere"),
    },
    refusal: (mailboxIds) => readerMoveRefusal(
      rosterRef.current,
      mailboxIds.map((id) => id ?? ""),
      refusalCopy,
    ),
  });

  /**
   * WHAT A KILLED TAB LEFT BEHIND, finished at the next launch. The other half of the durable
   * record `delete-intents.ts` keeps; without it the journal would grow and nothing would act on
   * it, which is a durable record of nothing. Demo excluded: the fixture world has no server to
   * carry a delete to, and replaying one there would mutate a demo somebody is looking at.
   */
  useDeleteIntentReplay(
    /* THROUGH `fileAndRefresh`, LIKE EVERY OTHER FILING DISPATCH — and this line is a fix rather
       than a transcription. The replay used to read `(m) => engine.mutate(m)`, which carried no
       `kind:` literal, so `filing-refresh-on-decision.test.tsx`'s census could not SEE it: a
       filing dispatch invisible to the guard that exists to find exactly that. Naming the verb
       here made the census name it, and the census was right — a replayed delete moves mail, so
       the count the filing strip renders is stale until the facts are re-read. */
    (messageId) => fileAndRefresh(engine.mutate({ kind: "message_delete", messageId })),
    () => Date.now(),
    !demo,
    /* THE RESTORE'S REPLAY, wired only where the transport exists. Omitted, `delete-undo.ts`
       DROPS a stranded restore rather than sending it — never falling through to the delete,
       which would delete the message somebody asked to put back. `trashAvailable()` is the same
       answer the palette row and the chord read, so the surface cannot offer a verb whose
       replay would be dropped. */
    engine.trashAvailable()
      ? (messageId, pressId) => fileAndRefresh(
          /* THE PRESS ID IS THE REPLAY'S WHOLE POINT HERE: this dispatch runs at the next launch
             for a press whose response was lost, so it goes out under that press's own key and
             the server answers it as already applied instead of "not in Trash". */
          restoreDispatch((id, opts) => engine.restoreFromTrash(id, opts))(messageId, pressId),
        )
      : undefined,
  );
  const refusalCopy = useMemo(
    () => ({
      named: (name: string) => t("screener.readerMoveRefused", { name }),
      unknown: () => t("screener.readerMoveRefusedUnknown"),
    }),
    [t],
  );

  /** Which mailboxes a set of messages lives in — first-seen order, de-duplicated. An
   *  unresolvable message contributes `""`, which the predicate refuses as an unknown id. */
  const mailboxesOf = useStableCallback(
    (ids: readonly string[]): string[] => {
      const out: string[] = [];
      for (const id of ids) {
        const mb = reader.get<EngineMessage>("message", id)?.mailboxId ?? "";
        if (!out.includes(mb)) out.push(mb);
      }
      return out;
    },
  );

  const theme = useTheme();
  const route = useHashRoute();
  // The registry owns ⌘K (see `keymap.tsx`). Leaving the hook's own binding on as well
  // would toggle twice per keypress, which cancels out and never opens the palette.
  const palette = useCommandPalette({ bindKey: false });
  // ONE pull flight per tab, shared by the rail and topbar copies of the button — two hooks
  // would each carry their own `pulling`, and a resize mid-pull would reveal an idle-looking
  // copy that accepts a second POST while the hidden one still polls. The settle watch rides
  // `mailboxFacts` — the SAME injected probe the sync strip reads — so the button works on
  // every door that has one: the Cloud client, the desktop window, the served host-client.
  // See `PullNewMail.tsx`.
  const pullBinding = usePullNewMail(mailboxFacts);
  const now = useMemo(() => (demo ? DEMO_NOW : new Date()), [demo]);

  /* ── consent: what is PRESENTED, as opposed to where it sits ────────────────────────────
   *
   * Mail is shown by who sent it and whether the user has decided about them, not by which
   * folder the mail server has it in. A consented sender's whole backlog appears in the Ohbox
   * while every message of it is still physically in the Screener folder, and mail from
   * senders who went quiet years ago and were never screened presents in History. Nothing
   * moves; this is a filter over the same mirror.
   */
  /**
   * THE SETTINGS STAMP off the mirror — the `settings` entity's `updatedAt`, recomputed per
   * version bump. The entity is the sync channel's doorbell for consent-settings writes made on
   * ANY surface (`change-log.ts` says why it exists); `useConsentState` re-asks `GET /consent`
   * whenever it moves, which is what lets a folders flip or an image-posture change made in
   * another window reach THIS one within normal sync latency instead of at the next boot. The
   * record's CONTENT is deliberately not read beyond the stamp — the live consent read stays the
   * one authority, so the two cannot drift.
   */
  const settingsStamp = useMemo(() => {
    const rows = engine.read().entries<{ updatedAt?: string }>("settings");
    if (rows.length === 0) return null;
    return String(rows[0]?.entity?.updatedAt ?? "");
    // `version` is the subscription; the reader object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, version]);
  const consent = useConsentState(!demo, consentTransport, settingsStamp);
  /**
   * The sync loop's posture, for the folders group's third render: `bootstrapping` is "no drain
   * has yet completed for this engine", which is exactly the window in which ZERO folder
   * entities means "cannot judge yet" rather than "the account has none".
   */
  const syncStatus = useSyncStatus();
  /**
   * The account's language wins over this device's — riding the `GET /consent` this shell
   * already makes. Both preferences are needed: localStorage is what a standalone install and
   * the sign-in screen have; the account column is what makes "my mail is in German" true on a
   * machine that has never seen this account. `adoptLocale`, never `setLocale` — the latter
   * WRITES the account, and adopting a value that came FROM the account would PATCH it back on
   * every boot of every tab. Null means the account has no preference and the device stands (no
   * `else` arm: this effect only moves the language TOWARDS an account's answer). Absent
   * provider = demo and unit tests; nothing to adopt into.
   */
  const localeControls = useAppLocale();
  const accountLocale = consent.locale;
  const adoptLocale = localeControls?.adoptLocale;
  const activeLocale = localeControls?.locale;
  useEffect(() => {
    if (!adoptLocale || accountLocale === null || accountLocale === activeLocale) return;
    void adoptLocale(accountLocale);
  }, [adoptLocale, accountLocale, activeLocale]);
  /**
   * The account's face, adopted the same way — same `GET /consent` read, into
   * `adoptAccountFace` (which mirrors it to storage so the next boot's init script stamps it
   * pre-paint). Never a write: PATCHing back a value that came from the account is the loop
   * `adoptLocale` warns about. Two deliberate differences from the locale effect: null IS
   * adopted once known — it clears the device's mirror of a previous account answer, else a
   * revoked choice keeps re-skinning this device from a stale copy; and the device's own
   * explicit pin still outranks what is adopted (the provider's resolution order).
   */
  const adoptAccountFace = theme.adoptAccountFace;
  const accountThemeFace = consent.themeFace;
  /* `themeFaceKnown`, NOT `known` (review-caught): the boot cache can make `known` true with
     the face still resting null, and adopting THAT null would wipe this device's mirror of
     the account's real answer on every warm boot whose live read is slow. */
  const themeFaceKnown = consent.themeFaceKnown;
  const consentStandalone = consent.standalone;
  useEffect(() => {
    /* A STANDALONE door has no account, so it may not wear one (review-caught, desktop):
       the provider outlives the desktop's door switch, and the departed cloud account's
       adopted face — in memory AND in the `ohmail.face.account` mirror — would otherwise
       skin the standalone mailbox, and the next relaunch, with an answer nobody on this
       door ever gave. Adopting null clears both. The web never takes this arm (its cloud
       client is always reachable); the device's own pin is untouched either way. */
    if (consentStandalone) {
      adoptAccountFace(null);
      return;
    }
    if (!themeFaceKnown) return;
    adoptAccountFace(accountThemeFace);
  }, [adoptAccountFace, accountThemeFace, themeFaceKnown, consentStandalone]);
  /**
   * Being woken, reconciled at boot — the sign-in counterpart of the sign-out revoke. Sign-out
   * drops this browser's push row; the channels in localStorage and the OS permission survive it
   * (a per-install preference), so signing back in showed every switch ON over no registration,
   * with closed-browser notices silently off — and the only reconcile was `SettingsView`'s mount
   * effect. Here instead: the shell boots exactly once per sign-in, and `!demo` IS the signed-in
   * reader. No state is written from here — the pane owns the delivery sentence, and a boot-effect
   * `setState` makes every act-less test print warnings. Bounded internally; never awaited (it
   * joins a queue of fetches with no timeout).
   */
  useEffect(() => {
    /* `resolvedDemo`, NOT `demo` — review-caught, and the difference is one render wide.
       `useDemoMode` returns the SERVER snapshot on the hydration render so the markup matches;
       a prerendered route bakes `searchParams = {}`, so on a `?demo=1` page that snapshot is
       FALSE while the client answer is true. This effect fires on that commit. Gated on `demo`
       it therefore ran on a demo page — issuing `GET /push/vapid-key` and `POST
       /push/subscriptions` from the one surface whose promise is that nothing leaves the tab. */
    if (resolvedDemo) return;
    void reconcileWakeRegistration(t("settings.notifyClosedBody"));
    // Boot and door only. `t` is deliberately not a dependency here: it changes identity on a
    // locale adoption, and re-running the whole reconcile then would cost a second announce.
    // The words are followed up by the relabel effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDemo]);
  /**
   * The worker's words follow the account's language — the locale is
   * adopted after boot. `GET /consent` answers well after this shell
   * mounts, so the reconcile above has already written the notify-state
   * body in the DEVICE's language; without this a German account on an
   * English device gets "New mail." until somebody opens Settings. A
   * RELABEL, not a reconcile: `updateNotifyWords` preserves the stored
   * `enabled` byte for byte — re-running the reconcile would recompute it
   * from an intent, which is how a previous user's surviving registration gets re-armed.
   */
  useEffect(() => {
    if (resolvedDemo) return;
    void updateNotifyWords("ohmail", t("settings.notifyClosedBody"));
  }, [resolvedDemo, t]);
  /**
   * "Apply for all devices" — the face's account write, folded to one nullable callback for
   * both consumers (the Settings scope line and the Option B offer). Null on the demo (no
   * session), before the first consent answer (a press racing the boot read would write over an
   * unknown stance), and on a transport that cannot store an account-wide face — each null
   * withholds the affordance structurally. The desktop's hosted door has the knob now
   * (`consentOverBridge.setThemeFace`); the gate stays for the STANDALONE window, which passes
   * no transport — the device pin is the whole of its appearance choice.
   */
  const applyFaceAllDevices: ApplyFaceAllDevices | null =
    !demo && themeFaceKnown && consent.setThemeFace !== null ? consent.setThemeFace : null;
  /* The Option B offer's gates (Linux default active, nothing chosen, dismissal) live in the
     hook — see OhmarchyOffer.tsx. */
  const faceOffer = useOhmarchyOffer(applyFaceAllDevices);
  /**
   * The seed review, offered once the server says it is owed — and dismissible. `seedConfirmedAt` is
   * null until somebody answers (also the post-reset state). It takes the stage because it decides
   * what the Ohbox contains. "Later" is a real answer, remembered per tab; nothing is gated on
   * completing it — an account that never does screens every stranger, the old behaviour. "Not now" is
   * not "never", and neither is "Done": dismissing once left the screen unreachable for the tab's
   * life, confirming for the account's — wrong once a second mailbox brings a second address book. The
   * Settings entry sets `seedReopened`, `confirmSeed` writes only who is new, and the review
   * recomputes from whatever mailboxes are attached when opened.
   */
  const [seedDismissed, setSeedDismissed] = useState(false);
  const [seedReopened, setSeedReopened] = useState(false);
  /**
   * The review needs the browser's Cloud client; no injected wire substitutes. `consent.known`
   * was the whole gate while "the server answered" and "this bundle can call the server" were
   * one fact; a host transport splits them — `known` goes true on the desktop's hosted door
   * while `SeedReviewView` still imports `app/api-client` DIRECTLY, so the review would have
   * taken the whole stage there, unable to load or complete. Offered where the client that runs
   * it exists: the browser. The same fact gates `seedSection` below, and it is why {@link
   * ConsentState.cloudClient} is published separately from `standalone`.
   */
  const seedSupported = consent.cloudClient;
  const seedOwed = !demo && consent.known && seedSupported
    && (seedReopened || (consent.seedConfirmedAt === null && !seedDismissed));
  /**
   * The account's own addresses, from `GET /mailboxes` — passed explicitly,
   * not left to the default. `consentPartition` falls back to the mirror's
   * `mailbox` entities, and a live `/sync` feed carries none: an empty set
   * on exactly the surface that matters, so the user is not recognised as
   * themselves and their own mail (a note to self, a cross-account
   * forward) queues in their own Screener. The demo's mirror DOES hold
   * mailbox rows, so no fixture test could have shown this.
   */
  /**
   * …AND THE BOOT USES THE DEVICE'S COPY OF THAT ANSWER. `facts` is a round trip away on every
   * load, and a partition computed with an empty own-set for that interval would present the
   * user's own recent self-mail in their own Screener — the same boot-window defect the consent
   * cache below closes, on this input. So the addresses ride the same per-account boot cache:
   * written whenever `GET /mailboxes` has answered, read while `facts` is still null, keyed by
   * the remembered account id, and never applied over a live answer (`facts` wins the `??`).
   * An address list neither authorises nor loads anything — it only stops the account being
   * treated as a stranger to itself for the first round trip.
   */
  const [rememberedOwn, setRememberedOwn] = useState<string[] | null>(null);
  useEffect(() => {
    if (demo) return;
    const owner = readOwner();
    if (owner === null) return;
    if (facts) {
      writeBootCache(OWN_ADDRESSES_BOOT_SCOPE, owner, facts.map((m) => m.address));
      return;
    }
    const cached = readBootCache(OWN_ADDRESSES_BOOT_SCOPE, owner, acceptAddressList);
    if (cached !== null) setRememberedOwn(cached);
  }, [demo, facts]);
  /**
   * Keyed on the addresses, not the facts row. `consentView` depends on nothing else about a
   * mailbox, and keyed on `facts` it rebuilt the whole-mirror partition whenever ANY field
   * moved — `pendingMoves` decrements on every poll for hours on a fresh mailbox. A STRING of
   * the sorted, lower-cased addresses rather than the identity of `facts`: the provider's
   * equality gate stops the poll that learned nothing, this stops the poll that learned
   * something the partition does not care about. Sorted and lower-cased is the KEY only — the
   * value keeps the server's order and case; nothing downstream may see a folded address.
   */
  const ownAddresses = useMemo(
    () => facts?.map((m) => m.address) ?? rememberedOwn ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownAddressKey(facts, rememberedOwn)],
  );
  /**
   * THE ACCOUNT'S OWN NAME FOR ONE OF ITS ADDRESSES — what the "me" recipient chip wears
   * (viewer redesign). `GET /mailboxes` carries `displayName` per mailbox (nullable; OAuth connects
   * fill it from the provider's id_token, IMAP connects only when the user typed a label), and
   * that is the ONLY name the shell can honestly claim as the account's: the signup name
   * (`users.displayName`) never reaches `app/shell/**`, which may not call the API directly.
   * Null — no label, no facts (the demo, the desktop) — and the chip shows the bare address
   * rather than an invented name.
   */
  const ownNameOf = useStableCallback((address: string): string | null => {
    const key = address.trim().toLowerCase();
    const label = facts
      ?.find((m) => m.address.trim().toLowerCase() === key)
      ?.displayName?.trim();
    return label ? label : null;
  });
  const consentView: ConsentPartition | null = useMemo(
    // The demo is not partitioned — consent derives from rules and the
    // fixture world has none, so the partition would empty the curated world into History. Nothing
    // is partitioned before the account's window is known: `consent.known` is false until `GET
    // /consent` lands or the boot applies the account's CACHED last answer (`boot-cache.ts` —
    // without it every reload resurrected already-decided senders). A tab that cannot know shows
    // MORE, never less. The desktop (`consent.standalone`) partitions anyway: there is no stored
    // window to guess at, so the default IS the truth — read as "not yet known" it killed the
    // cutline for the whole desktop tier. The baseline rides the
    // same `GET /consent` answer as the window: one fetch, both halves.
    () =>
      demo || !(consent.known || consent.standalone)
        ? null
        : consentPartition(reader, {
            now,
            dormancyDays: consent.dormancyDays,
            baselineAt: consent.screeningBaselineAt,
            // THE MODE, or the window it names is resolved and then ignored (mail 0083). The
            // server's router has honoured `all_time` since the column landed; this partition is
            // what the Screener queue and the History placement are actually built from on the
            // client, so without this line the Settings control writes a value the open tab —
            // and, on a standalone install, the whole product — never reads.
            screeningScope: consent.screeningScope,
            ownAddresses,
            // The History-lens gate (spec §16.5): the CONSENT answer, not the mirror's folder
            // entities — stale entities after a missed disable must not keep the lens on.
            foldersEnabled: consent.foldersEnabled,
          }),
    [
      demo, consent.known, consent.standalone, reader, version, now, consent.dormancyDays,
      consent.screeningBaselineAt, consent.screeningScope, ownAddresses, consent.foldersEnabled,
    ],
  );
  /**
   * The same mirror, with every message sitting where it is PRESENTED.
   *
   * Fed to the pile selectors and to nothing else. They group by folder, and after this
   * projection grouping by folder IS grouping by place — which is what lets History exist
   * without a single server-side move. History's own contents are absent from it entirely and
   * are read from `consentView.history`.
   */
  const presented = useMemo(
    /* …MINUS ANYTHING INSIDE ITS UNDO WINDOW. `hideMessages` returns the base reader unwrapped
       while nothing is held, which is every render but the few seconds after a Delete, so the
       normal path pays nothing and keeps its memo identities. It is composed HERE and not into
       `reader` for `presentationReader`'s own reason: the mirror's reader is what every mutation,
       body open and search reads, and a delete that has not happened yet must still be there. */
    () => hideMessages(consentView ? presentationReader(reader, consentView) : reader, deleting.held),
    [reader, consentView, deleting.held],
  );

  /**
   * Mail from beyond what this device kept — one keyset page at a time, on
   * an explicit ask. The browser's mirror is a window over a server that
   * still holds everything, so the bottom of a pile is a boundary, not an
   * end; see `older-mail.ts` for why nothing fires speculatively and the
   * rows are never written to the mirror. Inert on a client whose mirror
   * IS the mailbox: `listOlderAvailable()` is false for the demo and the
   * standalone desktop, and the view renders no control.
   */
  /** The open folder's entity id, for the reach-past hook below — route-derived, shell-early. */
  /**
   * The Trash page — off-mirror, fetched on arrival, dropped on leaving.
   * `route.view`, not `effectiveView`: this is a fetch, and `effectiveView`
   * is derived from things that can withhold the stage (the seed screen) —
   * rendering the seed screen over Trash should not throw away an arrived
   * page, and coming back should not need a second fetch. The held-restore
   * ids are subtracted here rather than in the view — one place, so the
   * list and the rail count cannot disagree.
   */
  const trashPage = useTrashPage(engine, route.view === "trash", restoring.held);
  /**
   * THE LIVE TRASH WINDOW — the mail server's own \Trash, read beside the mirrored deletes and
   * never written anywhere. Gated exactly as the Junk window is: the hook is called
   * unconditionally and what is CONDITIONAL is `active`, so nothing is read in the demo, with
   * "Use folders" off, before the first seed, or away from the view. The PROP below adds
   * `supported` — a build whose api client is a refusing stub would otherwise hold a permanent
   * loading state over the section.
   */
  const trashWindow = useTrashWindow(
    !demo && consent.foldersEnabled && !seedOwed && route.view === "trash",
    trashWire,
  );
  const folderIdForOlder = route.view === "folder" ? (route.folderId ?? undefined) : undefined;
  /**
   * Deliberately no client-derived boundary for the folder reach-past. The obvious one — the
   * folder's oldest mirrored row — is wrong on a windowed mirror whose held rows are not
   * contiguous (pinned rows, the labeled tail): an outlier below the window would become the
   * boundary and every unmirrored row between would be skipped, permanently. So page one starts
   * at the folder's newest and the view's id-filter drops what the mirror already renders —
   * overlap-and-deduplicate, cost extra presses, failure mode none. The wire's `startBelow`
   * stays for a future contiguous-edge derivation; nothing arms it today.
   */
  const folderOlderBoundary = undefined;
  /** The open folder entity, read ONCE per render for the reach-past pieces below: the verdicts
   *  judge against it, and its absence marks the unjudgeable gap the epoch tracker watches. */
  const folderEntityForOlder =
    folderIdForOlder ? reader.get<FolderEntity>("folder", folderIdForOlder) : undefined;
  /**
   * THE FOLDER TAIL'S SCOPE EPOCH — bumps when the open folder's entity RE-ENTERS the mirror
   * after an absence (the flag toggled off and on over an open folder URL). While the entity
   * is absent every verdict is "hold" and no latch moves; moves that end in a window prune
   * during that gap erase their own evidence, so when the entity returns the hook drops its
   * pages and latches and the tail re-earns its rows from the server — the one authority the
   * gap did not silence. A ref mutated in render, transition-edged so StrictMode's double
   * invoke cannot double-bump; a folder change resets the tracker (the hook resets on the id
   * change anyway).
   */
  const folderTailEpoch = useRef({ folderId: undefined as string | undefined, present: false, epoch: 0 });
  {
    const t = folderTailEpoch.current;
    const present = folderEntityForOlder !== undefined;
    if (t.folderId !== folderIdForOlder) folderTailEpoch.current = { folderId: folderIdForOlder, present, epoch: 0 };
    else if (present && !t.present) { t.epoch += 1; t.present = true; }
    else if (!present && t.present) t.present = false;
  }
  const older = useOlderMail(engine, "ohbox", version);
  /**
   * The open FOLDER's reach past the mirror window (the folders foundation) — `older`'s twin,
   * keyed to the folder entity id so leaving a folder resets its paging. Called with an
   * undefined id whenever no folder is open, which the transport reads as "no list"
   * (unavailable) — hooks must be unconditional, the scope may be absent.
   */
  const folderOlder = useOlderMail(
    engine, "folder", version, folderIdForOlder, folderOlderBoundary,
    /* The per-render verdicts — `folderTailVerdict` is the pure, branch-tested word (see the
       hook's `suppress` for what each verdict does to the latch): in this folder ⇒ hidden and
       un-latched (an observed return); shown elsewhere by the LIVE entity ⇒ banned; entity
       absent ⇒ held, latches untouched; not held at all ⇒ the fetched copy shows. The
       unjudgeable entity-absent gap is settled by `folderTailEpoch` above, not by memory. */
    (id) => folderTailVerdict(reader.get<EngineMessage>("message", id), folderIdForOlder, folderEntityForOlder),
    folderTailEpoch.current.epoch,
  );

  /* Engine-derived world. Every memo below is a whole-mirror pass keyed
   * `[presented, version]`: `presented` because a new consent projection is
   * a different mirror, `version` because the projection cannot carry a
   * cache of its own. These rebuild when what they derive from changes —
   * the mirror, the overlay on it (`useEngineVersion` merges it), or where
   * consent presents the rows — never read them as "only when a message
   * changed". Every rebuild is retained as long as the render scope that
   * made it, so every callback here reads through a ref
   * (`stable-callback.ts` is the account of that mechanism). */
  const ohbox = useMemo(() => ohboxView(presented), [presented, version]);
  const partition = useMemo(() => feedPartition(presented, "reads"), [presented, version]);
  /**
   * Receipts is a FLAT list, exactly as Reads is — no day headings.
   *
   * `receiptsByDay` stays the source because it is the ordering: newest day first, and newest
   * within a day. Flattening it here preserves that order exactly and leaves the view with no
   * grouping concept at all. The selector's `label` is no longer rendered anywhere; it is the
   * boundary the sort is defined by, not a heading.
   */
  const receipts = useMemo(
    () => receiptsByDay(presented, now).flatMap((g) => g.items),
    [presented, version, now],
  );
  /**
   * Receipts' OWN waterline partition — `view_meta` "receipts_waterline", independent of
   * Reads' by construction (`waterlineIdOf`). `feedPartition` walks `messagesIn` in the same
   * date order the day-flatten above preserves, so `fresh.length` is a junction into
   * `receipts` and not a parallel ordering that could drift.
   */
  const receiptsPartition = useMemo(
    () => feedPartition(presented, "receipts"),
    [presented, version],
  );
  const piles = useMemo(() => triagePiles(presented), [presented, version]);
  /**
   * WHICH MAIL IS PARKED IN A BOTTOM PILE — the same derivation `piles` above is built from
   * (`selectors.ts#parkedMessageIds`), so the set and the lists cannot disagree about it.
   *
   * Read by `openTargetFor`, which must not route a parked message to the Ohbox: no Ohbox group
   * lists one, so the arrival would select nothing and flash nothing. See that function.
   */
  const parked = useMemo(() => parkedMessageIds(presented), [presented, version]);
  const tagGroups = useMemo(() => tagsCrossView(presented), [presented, version]);
  /**
   * History: dormant, undecided, and read by construction. Newest first.
   *
   * Every row is stamped with `physicalFolder`, which the projection does not do for History
   * (it removes those messages rather than re-placing them). That stamp is the single rule the
   * reading pane goes by: **if a message carries one, what you are looking at is not where it
   * is, and the pane says where it is.** Without it, History would be the one place in the
   * product that shows mail somewhere other than its folder and does not admit to it.
   */
  const history = useMemo(
    /* MINUS ANYTHING INSIDE ITS UNDO WINDOW. History is built by `consentPartition` over the
       MIRROR's reader, so `presented`'s projection never reaches it — and a row held for delete
       stayed listed here for the whole window while the toast said it had moved (review finding).
       The subtraction is the same held set every other view is filtered by. */
    () => (consentView?.history ?? [])
      .filter((m) => !deleting.held.has(m.id))
      .map((m) => ({ ...m, physicalFolder: m.folder })),
    [consentView, deleting.held],
  );
  /**
   * EVERY MESSAGE IN THE MIRROR — the first pull's numerator, and the same number
   * `MailStateHost` folds into the growth reducer one level up.
   *
   * Read again here rather than lifted out of `useMailState`, because that context publishes the
   * count it was CONSTRUCTED with and this component is inside it; the two are the same
   * expression over the same reader at the same version, so they cannot disagree.
   */
  const mirroredCount = useMemo(() => reader.list("message").length, [reader, version]);
  const tags = useMemo(() => reader.list<TagDTO>("tag"), [reader, version]);
  /**
   * THE MAILBOX'S OWN FOLDERS — `folder` entities off `/sync` (FOLDERS-SPEC.md §4), present in
   * the mirror only while the account's "Use folders" flag is on, and gated AGAIN here on the
   * consent answer: the flag is the authority, the entities are data. A tab that has not yet
   * heard the flag renders the pre-feature rail; a tab whose mirror still holds entities after
   * the flag went off renders none. Both directions err towards today's interface.
   */
  const folders = useMemo(
    () => (consent.foldersEnabled ? reader.list<FolderEntity>("folder") : []),
    [reader, version, consent.foldersEnabled],
  );

  /**
   * THE FOLDER VERBS (stage 2) — engine dispatch + the delete confirm's summary read, from the
   * sibling hook (`folder-verbs.ts` carries the api-client boundary argument). Built
   * unconditionally (hooks may not be conditional); HANDED to the rail group only on a live,
   * folders-on account — the demo keeps the read-only group, and a flag-off rail renders no
   * group at all.
   */
  const folderVerbs = useFolderVerbs(engine, toast);

  /**
   * The account's PARTICIPATING mailboxes for the rail group's sections — what lets a mailbox
   * with zero folders still offer `+ New folder`. Participation is the per-mailbox dial
   * (spec §17: only the EXCEPTIONS travel) and the stood-down state: a `disabled` mailbox is
   * another organizer's, and a command Cloud's worker will never execute must not be offered.
   */
  const folderMailboxes = useMemo(
    () =>
      (facts ?? [])
        .filter((f) => f.status !== "disabled" && !(f.id in consent.folderMailboxesOff))
        .map((f) => ({ id: f.id, label: f.address })),
    [facts, consent.folderMailboxesOff],
  );
  /**
   * Per-folder unread, ONE PASS over the presented mirror — the tag counts' derivation and the
   * spec's "no server-side count column" decision. Keyed `mailboxId|path`; the rail rolls a
   * collapsed parent's descendants up from this same map, so there is one source and no second
   * number to drift.
   */
  const folderUnread = useMemo(
    () => (consent.foldersEnabled ? folderUnreadCounts(presented.list<EngineMessage>("message")) : new Map<string, number>()),
    [presented, version, consent.foldersEnabled],
  );
  /** The open folder entity, and its mail — `tagGroup`'s twin, up here so every piece of route
   *  chrome (the rail highlight, the mobile title, the fallback view) derives from ONE answer
   *  to "does the folder the URL names exist". Absent ⇒ the Ohbox renders, and the chrome says
   *  so too. */
  const openFolder =
    route.view === "folder" ? folders.find((f) => f.id === route.folderId) : undefined;
  const folderMessages = useMemo(
    () =>
      openFolder
        ? presented
            .list<EngineMessage>("message")
            .filter((m) => m.mailboxId === openFolder.mailboxId && m.folder === openFolder.name)
            .sort((a, b) => {
              const at = a.date ? new Date(a.date).getTime() : 0;
              const bt = b.date ? new Date(b.date).getTime() : 0;
              return bt - at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
            })
        : [],
    [presented, version, openFolder],
  );
  /** Every rule the consent gate has written, newest first. */
  const rules = useMemo(() => rulesList(reader), [reader, version]);
  const mailboxes = useMemo(
    () => reader.list<MailboxEntity>("mailbox"),
    [reader, version],
  );
  const draft = useMemo(
    () => reader.get<EngineDraft>("draft", "draft-compose") ?? null,
    [reader, version],
  );
  const aiChip = useMemo(
    () => reader.get<ReadsAiChipEntity>("view_meta", "reads_ai_chip") ?? null,
    [reader, version],
  );
  const account = useMemo(
    () => reader.get<{ email: string }>("view_meta", "account") ?? null,
    [reader, version],
  );
  /** The demo's VIP block; `/sync` cannot emit `view_meta`, so a live account gets null. */
  const notifications = useMemo(
    () => reader.get<NotificationsMeta>("view_meta", "notifications") ?? null,
    [reader, version],
  );
  /**
   * Suggestions for the Screener — bought explicitly, never as a side effect of looking.
   *
   * `active` defers the one read this makes (what has already been bought) until the Screener
   * is actually open, and the DEMO is excluded outright: `?demo=1` promises that nothing
   * leaves the tab, and a suggestion fetched from a server would break that promise even
   * though it costs nothing. Two hooks rather than one because the mirror owns the rows and
   * this owns the advice about them; `useScreenerState` joins the second onto the first.
   */
  const suggestions = useScreenerSuggestions({
    active: !demo && route.view === "screener",
    // The opt-in, straight off `GET /consent`. `consent.autoSuggest` is false until the server
    // has said otherwise — on the demo, on a failed fetch, and against an API from before mail
    // 0040 — so the automatic purchase cannot happen on a guess.
    autoSuggest: consent.autoSuggest,
    toast,
    /* The host's own wire where there is one — see {@link suggestWire}. Spread rather than passed
       as `undefined`, so an absent prop leaves the hook on its documented default rather than
       being handed a hole. */
    ...(suggestWire ? { wire: suggestWire } : {}),
  });
  /**
   * `presented`, NOT `engine.read()` — the Screener is the cutline's own
   * surface. Every other pile is built from the projected reader; this one
   * grouped by physical folder, and the queue's whole question is "who is
   * still owed a decision", which the partition answers. The hook keeps the
   * raw mirror for its mutations (`useScreenerState`'s `presented`
   * parameter). Consequence: `screener.unsuggestedSenders` feeds the
   * metered auto-suggest batch, so the cutline also stops the spender from
   * being offered senders it already ruled out.
   */
  /**
   * Will screening a sender out also unsubscribe from their list, on this build, for this
   * account? The single answer every disclosure reads (the sender sheet's confirm, the
   * Screener's toasts), so sentence and sending cannot come apart. Two independent facts:
   * `consent.autoUnsubscribe` — the account's switch (mail 0054), resting TRUE so a failed `GET
   * /consent` keeps the disclosure; and `!consent.standalone` — the build: a standalone install
   * wires no unsubscribe service, so a warning there would name a request it cannot make. The
   * demo is not excluded: its job is to show what the product does.
   */
  const autoUnsubscribeDiscloses = consent.autoUnsubscribe && !consent.standalone;
  /**
   * WHAT THE SCREENER MAY DO HERE — organizer, pending, or blocked.
   *
   * The rule is `screenerMode` in `mail-state.ts`, beside the `readerStandDown` it is built on —
   * the same predicate Settings → Mailboxes renders its banner from, so the two surfaces cannot
   * come to describe one state differently. Memoised on the polled facts and nothing else; the
   * function is pure and has its own table test.
   */
  const screenerRole = useMemo(() => screenerMode(facts), [facts]);
  /* …AND THE DELETE KEY READS THE SAME ROSTER, one mailbox at a time. In an EFFECT rather than
     during render (review finding): a render that yields and is discarded must not publish a
     roster to a committed key handler. The initial `null` is the safe value — `readerMoveRefusal`
     refuses on it, which is what a destructive verb should do before it knows. */
  useEffect(() => { rosterRef.current = rosterStateOf(rosterProbed, facts); }, [rosterProbed, facts]);
  /**
   * WHAT CHANGED ABOUT WHO ORGANIZES THESE MAILBOXES, AND HAS NOT BEEN ACKNOWLEDGED.
   *
   * `organizerNotices` in `mail-state.ts` is the rule, memoised on the polled rows. The list is
   * usually empty — a change is a rare event — so this costs a filter over the roster per poll.
   */
  const organizerChanges = useMemo(() => organizerNotices(facts), [facts]);
  /**
   * How "Mark read" reaches the organizer-notice row, or `null` where nothing can — and `null`
   * withholds the line (a notice that cannot be acknowledged is a standing warning; Settings →
   * Mailboxes keeps the permanent controls). Injected, never imported: the publish script
   * denies `app/api-client` to this shared shell, so one route (`POST
   * /mailboxes/:id/organizer-notice/dismiss`) rides two transports. `refreshFacts` on success
   * so the line leaves on the answer; a rejection is passed through — the component puts the
   * line back. A stable callback, not a `useMemo` closure: a memoized closure pins its render's
   * whole scope (`stable-callback.ts`).
   */
  const acknowledgeOrganizerNotice: OrganizerNoticeTransport = useStableCallback(async (id: string) => {
    const answer = await organizerNoticeTransport?.(id);
    refreshFacts();
    return answer;
  });
  const screener = useScreenerState(
    engine, version, toast, suggestions.suggestions, presented, autoUnsubscribeDiscloses,
    // The SAME addresses `consentView` was built from — the queue's rows and the partition's
    // reckoning read one list, so the reader is never a row in their own Screener.
    screenerRole, suggestions.outstandingDecisions, ownAddresses,
  );
  /**
   * The opt-in's quote, bound to the SAME list the automatic batch will slice.
   *
   * Called unconditionally, unlike `forSenders` — which is bound inside the Screener branch of
   * the render below. That asymmetry is the whole reason `autoOptIn` takes the list as an
   * argument instead of reading the queue `forSenders` captures: a tab that opened Settings
   * without ever visiting the Screener has captured nothing, and a quote read from that empty
   * queue would price a ten-sender batch at zero. It writes no refs and schedules nothing, so
   * calling it every render is free.
   */
  const autoOptIn = suggestions.autoOptIn(screener.unsuggestedSenders);
  /* The first-run flow's facts, gathered from the four places they live:
   * the polled `GET /mailboxes` row, `GET /consent`, the door's AI posture,
   * and the Screener queue — `deriveOnboardingStep` is pure over them.
   * Which mailbox: the one the ROUTE names (`#/first-run?mailbox=<id>`),
   * and the first row only when it names none — `facts[0]` alone rendered
   * the FIRST mailbox's state (and consent write) on a run about the
   * second. An id the list does not hold falls back to the first row, the
   * router's rule: a claim the data does not support is corrected, never
   * 404'd. `null` still means "none connected" — except an ADD run before its create answers; see below.
   */
  const namedFirstRunRow = facts === null || route.firstRunMailboxId === null
    ? null
    : facts.find((m) => m.id === route.firstRunMailboxId) ?? null;
  /**
   * An add run has no mailbox until its create answers — AND until the facts say so. On an
   * install that already holds mailboxes the `?? facts[0]` fallback would show a statement about
   * a mailbox the person already has. The condition is not "the hash names no mailbox":
   * `onConnected` writes the new id to the hash instantly, but `facts` holds the pre-create list
   * until `refreshFacts` round-trips, and in that window the consent press was live and would
   * have posted `organize` for mailbox #1 with mailbox #2's window. So an add run is pending
   * until the facts hold its named row: the form stays, `mailboxId` is null, nothing to address —
   * also the honest answer when `GET /mailboxes` is failing.
   */
  /* Not the add run's problem alone: the re-run names a mailbox too
   * (`#/first-run/again?mailbox=<id>`), and if the poller drops that row,
   * `?? facts[0]` silently resolved the run to mailbox #1 — the same
   * wrong-mailbox `organize` write through a different door. The rule is
   * about the HASH: a run that names a mailbox is about that mailbox or
   * about none. The `facts[0]` fallback survives only for a hash that
   * names none — a first run, or an add run before its create answers. */
  const namedRowMissing = route.firstRunMailboxId !== null && namedFirstRunRow === null;
  const addPending = namedRowMissing || (route.firstRunAdd && route.firstRunMailboxId === null);
  /**
   * THE MAILBOX THIS RUN IS ABOUT. The row the ROUTE names, and the first row only when the hash
   * names none — the router's own rule for every id it carries: a claim the data does not support
   * is corrected in the shell, never 404'd. An ADD run never takes the fallback; see above.
   */
  const firstRunMailbox = facts === null || addPending
    ? null
    : namedFirstRunRow ?? facts[0] ?? null;
  /** The holder's "since" instant as a DATE in the app's own language — see the mount below. */
  const holderSince = useMemo(() => {
    const iso = firstRunMailbox?.organizedBy?.since;
    if (!iso) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return at.toLocaleDateString(activeFormatLocale(), {
      dateStyle: "medium", timeZone: activeFormatZone(),
    });
  }, [firstRunMailbox]);
  const onboardingFacts: OnboardingFacts | null = useMemo(() => {
    if (!firstRun || facts === null) return null;
    return {
      door: firstRun.door,
      mailbox: firstRunMailbox === null ? null : {
        organizerRole: firstRunMailbox.organizerRole,
        organizedBy: firstRunMailbox.organizedBy,
        organizerState: firstRunMailbox.organizerState,
        // THE STAMP THAT ORDERS TWO READS — see `OnboardingMailbox.organizerEventAt`. Forwarded
        // untouched on the same rule as the two below: absent is a build that predates the
        // column and null is a mailbox nothing has happened to, and the rule that reads it
        // treats both as "no ordering evidence" rather than as evidence of anything.
        organizerEventAt: firstRunMailbox.organizerEventAt,
        // FORWARDED UNTOUCHED, both of them. `mailbox-facts.ts` states the rule and the two
        // measured failures behind it: absent and null are different answers on these fields,
        // and a `?? null` at this seam is what destroyed the distinction the last two times.
        organizeConsentedAt: firstRunMailbox.organizeConsentedAt,
        initialImportCompletedAt: firstRunMailbox.initialImportCompletedAt,
      },
      account: { onboardingCompletedAt: consent.onboardingCompletedAt },
      ai: firstRun.ai,
      queuedSenders: screener.waitingCount,
    };
  }, [firstRun, facts, firstRunMailbox, consent.onboardingCompletedAt, screener.waitingCount]);
  /**
   * The one sender the guided decision is about — the head of the real
   * queue, decided through the real `ScreenerState`, not a fabricated card:
   * the first decision a person makes in the flow IS a decision — same
   * mutation, same rule, same move as one taken in the Screener a minute
   * later; a mock would teach a gesture that does something else. `null`
   * when the queue is empty, which the derivation reads as "skip this step
   * silently" — a guided first decision over nothing is a dead end.
   */
  const firstRunDecide: FirstRunDecideSubject | null = useMemo(() => {
    const row = screener.waiting[0];
    if (!row || "pinned" in row) return null;
    return {
      name: row.from.name ?? row.from.address,
      address: row.from.address,
      held: row.held.length,
      /* THE SCREENER'S OWN CAPTION, not a second sentence written for this card. `heldCaption`
         carries the first-contact time and `heldCaptionAll` does not, which is exactly the split
         `ScreenerView` makes over the same rows — one held message has no "first contact" to
         distinguish from its own arrival. */
      since: row.held.length > 1
        ? t("screener.heldCaption", { count: row.held.length, time: row.held[0]?.time ?? "" })
        : t("screener.heldCaptionAll", { count: row.held.length }),
      onDecide: (dest, opts) =>
        screener.decide(row, dest, { read: opts.markRead, scope: opts.scope }),
    };
  }, [screener, t]);

  /**
   * THE LIVE JUNK WINDOW (FOLDERS-SPEC.md §16.2) — the Screener's third segment, flag-on.
   *
   * The hook is called unconditionally (it is a hook); what is CONDITIONAL is `active` — the
   * first page is read lazily on the segment's first entry, and nothing is ever fetched while
   * "Use folders" is off, in the demo, or away from the segment. The PROP below is gated the
   * same way plus on `autoOptIn.supported` (the shell's one answer to "is there a server to
   * ask", the same read the suggest control uses): absent, `ScreenerView` renders the
   * flag-off segment byte-identically to before the window existed (§16.7).
   */
  const junkWindow = useJunkWindow(
    !demo && consent.foldersEnabled && !seedOwed
      && route.view === "screener" && route.screenerSegment === "spam",
    toast,
    junkWire,
  );
  /**
   * Is there anywhere for the away responder to be stored — the one gate
   * the control, its Ohbox notice and its Settings entry all read, so the
   * three can only agree. True two ways, the two installs with a hosted
   * account behind them: `autoOptIn.supported` (`wire.configured()` — the
   * browser on the hosted API, or a host-supplied {@link suggestWire}), or
   * a host-injected transport — the desktop's hosted door, whose window
   * cannot open a socket but whose engine forwards the endpoint. See
   * {@link awayTransport} for why the standalone door reaches neither branch.
   */
  const awaySupported = autoOptIn.supported || awayTransport !== undefined;
  /**
   * THE AWAY RESPONDER'S ONE SHELL FACT — is it on, and for whom. One `GET /away-responder`
   * per tab, held HERE so the Ohbox notice reads shell state on every visit rather than
   * costing a round trip per mount; the settings row's `onChanged` echo (bound below, beside
   * `awaySection`) keeps it current for a same-tab edit. Gated exactly as `awaySection` is:
   * no server, no read, no notice — and see `AwayNotice.tsx` for why a failed read stays
   * silent rather than guessing. Down the host's wire where there is one, for the reason
   * {@link awayTransport} gives.
   */
  /* `resolvedDemo`, NOT `demo` — the same one-render-wide difference this file already records
     for the wake registration above, found again by review on this gate. `useDemoMode` returns
     the SERVER snapshot on the hydration render so the markup matches, and a prerendered route
     bakes `searchParams = {}`; on a `?demo=1` page that snapshot is FALSE while the client answer
     is true. Gated on `demo`, this hook began `GET /away-responder` on that commit — and the
     effect's cleanup cannot retract a request already sent. The demo's promise is that nothing
     leaves the tab, so one render of it is one too many. Effect-only gate, which is exactly what
     `useResolvedDemoMode` is for; nothing here is rendered from it. */
  const awayNotice = useAwayNotice(!resolvedDemo && awaySupported, awayTransport);
  /**
   * Settings found on a mailbox — the portable profile's confirm moment,
   * held by the shell. One check per mailbox per tab (plus a slow,
   * visibility-gated beat); the card renders over the stage only when the
   * server says a document is genuinely waiting on a yes or no. Gated on
   * `!demo` alone — the hook re-checks `apiConfigured()` itself, so a build
   * with a refusing stub asks nothing unless its host wired a transport,
   * which the desktop does on both doors ({@link profileImportTransport}).
   */
  const profileImportOffer = useProfileImport(!demo, facts, profileImportTransport);

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
  /* The modifier's cap on this keyboard — the three hand-written caps below read it. */
  const modCap = useModGlyph();
  const [senderAudit, setSenderAudit] = useState<SenderAuditState | null>(null);
  /* The subject-rule sheet — the finer sibling of the sender popover, opened from a message's
     title. It lives here for the reason every overlay here does: `MessagePane` is mounted TWICE
     while the reader is open, so a sheet held per-pane would be two sheets. */
  const [subjectRule, setSubjectRule] = useState<SubjectRuleState | null>(null);
  /* The action bar's open destination strip (Move / Resurface / the delete confirm) — held
     here for the mounted-twice reason the reply draft is; keyed by message id so it can never
     render over another message's bar. See `message-chrome.tsx` (`barPanel`). */
  const [barPanel, setBarPanel] = useState<{ messageId: string; panel: MessageBarPanel } | null>(null);
  /* The inline reply. The id and the text live HERE, not in `MessagePane`, because
     that pane is mounted twice whenever the reader is open — see `message-chrome.tsx`. */
  const [replyTo, setReplyTo] = useState<string | null>(null);
  /**
   * Whether the open editor answers EVERYONE on the message (reply all). Set by every open —
   * `openReply(id, all)` — and read only while `replyTo` is non-null, so a stale `true` after
   * a close can never address anybody. The RECIPIENTS are not stored: `sendReply` resolves
   * `replyAllRecipients` at send time from the same facts the head renders, which is what
   * keeps the claim on screen and the envelope on the wire one decision.
   */
  const [replyAll, setReplyAll] = useState(false);
  /**
   * WHAT THE OPEN EDITOR IS — a reply, or the inline forward. Set by every open (`openReply`,
   * `openForward`), read only while `replyTo` is non-null (the `replyAll` discipline), and it
   * decides the editor's face (`InlineReply.mode`), the scratch-buffer key (`replyDraftKey` —
   * a half-written reply and a forward note on the SAME message are different texts), and
   * which mutation `sendReply` builds.
   */
  const [replyMode, setReplyMode] = useState<"reply" | "forward">("reply");
  const [replyBody, setReplyBody] = useState<RichValue>(EMPTY_RICH);
  /**
   * THE REPLY'S AUDIENCE AS EDITED — `null` while the computed envelope stands, which is
   * every reply whose head nobody pressed. It lives HERE beside `replyBody` because the pane
   * is mounted twice, and it RESETS whenever the editor retargets or changes mode: an edit
   * belongs to the message (and the audience) it was made on, and carrying it to the next
   * reply would address somebody else's mail with it. The effect covers every path that
   * moves `replyTo` — open, close, settle, forward, the Reply Run — without each of them
   * having to remember.
   */
  const [replyEnvelope, setReplyEnvelope] = useState<ReplyEnvelopeEdit | null>(null);
  useEffect(() => {
    // A FORWARD OPENS WITH THE ROWS ALREADY SHOWING, EMPTY — its audience is the user's to
    // pick and never derived (`forwardEnvelopePlan`), so a collapsed head would name nobody
    // and hide the one thing Send is waiting for. A reply keeps `null`: the computed audience
    // stands until the head is pressed, exactly as before.
    setReplyEnvelope(replyMode === "forward" ? { to: "", cc: "", bcc: "" } : null);
  }, [replyTo, replyAll, replyMode]);
  /**
   * THE REPLY'S PICKED SENDER and THE FILES IT WILL CARRY — both PER-MESSAGE and both stored
   * nowhere. The From pick overrides the mailbox the message arrived in (`resolveReplyFrom`); the
   * attachments ride the `mail_send` mutation and NEVER the `localStorage` reply scratch, which
   * serialises only the body (`mail-send.ts`). They live HERE beside `replyBody` for the
   * mounted-twice reason, and they RESET on `replyTo` alone — not on `replyAll` like the envelope:
   * a From choice and a file belong to the MESSAGE, and toggling reply/reply-all is still the same
   * message answered from the same address with the same files. Closing the editor and a settled
   * send both null `replyTo`, so this one effect is also the close and the post-send clear.
   */
  const [replyFromId, setReplyFromId] = useState<string | null>(null);
  const [replyAttachments, setReplyAttachments] = useState<ComposeAttachment[]>([]);
  /**
   * THE REPLY'S SIGNATURE BLOCK STATE and ITS SUBJECT AS EDITED — both per-message, both
   * stored nowhere (the reply scratch serialises only the body). The signature follows the
   * resolved sender until the reader strikes or edits the block (`signature.ts`); the subject
   * is `null` while the derived `Re:` one stands, which keeps the untouched reply's wire
   * byte-identical. They live HERE for the mounted-twice reason and RESET with the pick and
   * the files below: a strike and a retitle belong to the message they were made on.
   */
  const [replySig, setReplySig] = useState<SignatureState>(SIG_FOLLOWING);
  const [replySubjectEdit, setReplySubjectEdit] = useState<string | null>(null);
  /**
   * RETARGETING HYDRATES RATHER THAN BLIND-RESETS: closing a half-written
   * reply nulls `replyTo`, and a reset that forgot the per-message meta made Escape drop the
   * retitled subject and resurrect a struck signature while the body survived. The meta lives
   * beside the body scratch under the same lane key (`replyMetaKey`), written by the two
   * setters below and cleared by `settle` — so close-and-reopen restores all three halves of
   * the editor or none, and a settled send spends them together.
   */
  useEffect(() => {
    setReplyFromId(null);
    setReplyAttachments([]);
    if (replyTo !== null) {
      const meta = readReplyMeta(replyMode === "forward" ? inlineForwardKey(replyTo) : replyTo);
      setReplySig(meta.sig ?? SIG_FOLLOWING);
      // The subject edit is the REPLY's; a forward carries its own `Fwd:` subject.
      setReplySubjectEdit(replyMode === "reply" ? meta.subject ?? null : null);
    } else {
      setReplySig(SIG_FOLLOWING);
      setReplySubjectEdit(null);
    }
  }, [replyTo, replyMode]);
  /** The two persisting setters — state and scratch move together, or a reopen lies. */
  const onReplySig = useStableCallback((next: SignatureState) => {
    setReplySig(next);
    if (replyTo === null) return;
    const lane = replyMode === "forward" ? inlineForwardKey(replyTo) : replyTo;
    writeReplyMeta(lane, {
      ...readReplyMeta(lane),
      ...(next.kind === "following" ? { sig: undefined } : { sig: next }),
    });
  });
  const onReplySubject = useStableCallback((subject: string) => {
    setReplySubjectEdit(subject);
    if (replyTo === null) return;
    const lane = replyMode === "forward" ? inlineForwardKey(replyTo) : replyTo;
    writeReplyMeta(lane, { ...readReplyMeta(lane), subject });
  });
  /**
   * The compose form lives up here rather than in `ComposeView`: the view
   * is mounted only while `#/compose` is the route, so state inside it is
   * erased by navigating away and back — a message written twice. Same
   * reason the reply body is held here, and it lets one `onSendSettled`
   * clear whichever surface delivered. The `localStorage` mirror on top is
   * for a reload, read after mount (`persisted-ui.ts`: an initializer read
   * makes server and client render different markup, and React keeps the
   * server's — the saved draft would be read and silently discarded).
   */
  const [compose, setCompose] = useState<ComposeFields>(EMPTY_COMPOSE);
  /**
   * THE FORM, READ BY A CALLBACK THAT OUTLIVES THE RENDER IT WAS MADE IN.
   *
   * `openDraft` has to know whether there is unsaved text on screen before it opens a held row
   * over it, and putting `compose` in that callback's dependency array would rebuild it on every
   * keystroke — a memoized callback pins its whole render scope, and this file is where a
   * megabyte-per-hour retention chain was measured. The ref is the shape that rule prescribes.
   */
  const composeRef = useRef<ComposeFields>(EMPTY_COMPOSE);
  composeRef.current = compose;
  useEffect(() => {
    const saved = readComposeDraft();
    if (saved.to || saved.subject || saved.body) setCompose(saved);
  }, []);
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

  const allOhbox = useMemo(
    () => [...ohbox.resurfaced, ...ohbox.newForYou, ...ohbox.previouslySeen],
    [ohbox],
  );
  /**
   * The conversation's people for a row's lead circles — bound to the
   * presented reader here (the views have no reader), mapped to
   * `{initials, hue}` with the same helpers every avatar uses. Built once
   * per version, not once per row: every mail list draws these circles, and
   * the per-thread selector's mirror scan would be O(mirror × rows) for a
   * decoration — one pass fills the map, a row's lookup is `Map.get`. The
   * empty answer is a shared constant so a thread with no people gives the
   * same array reference per render (a fresh `[]` defeats memos below).
   */
  const participantIndex = useMemo(() => {
    const out = new Map<string, { initials: string; hue: number }[]>();
    for (const [threadId, people] of threadParticipantsIndex(presented))
      out.set(
        threadId,
        people.map((a) => ({ initials: initialsOf(a.name || a.address), hue: avatarHue(a.address) })),
      );
    return out;
  }, [presented, version]);
  const participantsOf = useStableCallback((threadId: string) => participantIndex.get(threadId) ?? NO_PARTICIPANTS);
  /**
   * THE CONVERSATION'S STORED NAME, for the Ohbox's grouped rows — bound here for the same
   * reason `participantsOf` is: the view has no reader of its own. The mirror's thread row
   * carries the subject the server named the thread with, prefixes already stripped, so the
   * grouped row says "Webshop" where its members say "Re: Webshop". `null` while the thread
   * row has not synced; the view falls back to the newest member's subject.
   */
  const threadSubjectOf = useStableCallback((threadId: string) => threadSubject(presented, threadId));
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
  const selectedOhbox = allOhbox.find((m) => m.id === ohboxSel) ?? null;

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
  }, [previewFor, selectedOhbox?.id, version]);

  /**
   * What the reader is showing, read from the mirror on every render.
   *
   * `?? null` and never a fallback to `selectedOhbox`: the reader shows the message it was
   * opened on or it shows nothing. A fallback here would re-create the defect
   * `OhboxView.open` documents — the sheet swapping to a message nobody opened the moment
   * the list re-partitioned underneath it.
   */
  const readerMessage: EngineMessage | null = readerMessageFor(
    readerFor,
    (id) => reader.get<EngineMessage>("message", id),
    readerOffMirror,
  );

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

  const waitingLive = screener.waiting.filter((w) => !screener.isExiting(w.id));

  /**
   * Read-state, for every view — one call site for one mutation. "Seen" used to mean three
   * things: Reads dispatched `feed_mark_seen`, Receipts kept an unpersisted React Set, the
   * Ohbox dispatched nothing. All three now write the same row and the worker puts `\Seen` on
   * the user's own IMAP server. `via` is a pass-through: a surface that marks read on the
   * reader's behalf labels itself `"glance"` and the engine alone acts on it (a pin survives
   * being looked at); absent means deliberate. The forward is easy to lose and impossible to
   * typecheck, so `test/resurface-now-shell.test.ts` asserts the label reaches the adapter.
   */
  const markSeen = useStableCallback((ids: string[], unread: boolean, via?: "glance") => {
    if (ids.length === 0) return;
    void engine.mutate({ kind: "mark_seen", messageIds: ids, unread, ...(via ? { via } : {}) });
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

  /**
   * Body hydration, wired once. Both reads read `engine.read()` at
   * invocation time and are keyed on `engine` alone, NOT `version` — a new
   * identity per mirror delta would re-fire every dependent view effect per
   * delta. `hydrateBody` is `makeHydrateBody(engine)` so the forward of the
   * caller's `{ retry }` option is a named, tested unit (an inline closure
   * once silently dropped it). It swallows nothing: the engine's outcome is
   * a record the UI renders, so `void` states there is no promise worth
   * awaiting, not a discarded error.
   */
  const engineHydrateBody = useMemo(() => makeHydrateBody(engine), [engine]);
  const hydrateThread = useMemo(() => makeHydrateThread(engine), [engine]);

  /**
   * The reach-past body door, spliced in at the one seam every pane reads.
   * A reach-past row is deliberately not a mirror row, and the engine's
   * body machinery keys on the mirror — `hydrateBody` for such an id was a
   * silent no-op with a Retry that re-ran it. The split is decided here,
   * per invocation, against the live mirror: mirror-resident ids take the
   * engine's path; others take the session door (`older-body.ts` — fetched
   * on show, never persisted). Per invocation matters: a drain can bring a
   * reach-past row into the mirror mid-session, and from that moment the engine's path owns it.
   */
  // Destructured so `hydrateBody` can depend on the STABLE dispatch alone — the door's `bodyFor`
  // changes identity when an answer lands (that is how panes learn), and riding the whole object
  // would re-fire the urgent-selection effects once per delivered body for nothing.
  /* The identity predicate, read at REQUEST time rather than at render time — a cookie can be
     rewritten by a sign-in in another tab between the render that built this closure and the
     press that uses it, and the whole point of the check is to catch exactly that. The identity is
     stable and the answer inside is always live — which matters more here than it looks: the door
     below is built once by `useState`, so it holds this function for the life of the shell. */
  const mayReadOlderBody = useStableCallback(() => syncMayRead(engine));
  const { open: openOlderBody, bodyFor: olderBodyFor } =
    useOlderBody(!demo, olderBodyWire, mayReadOlderBody);
  const hydrateBody = useStableCallback((messageId: string, opts?: { retry?: boolean; urgent?: boolean }) => {
    if (engine.read().get<EngineMessage>("message", messageId) !== undefined) {
      engineHydrateBody(messageId, opts);
      return;
    }
    openOlderBody(messageId, opts?.retry ? { retry: true } : {});
  });
  const bodyOfMessage = useStableCallback((m: EngineMessage) => {
    if (engine.read().get<EngineMessage>("message", m.id) !== undefined) {
      return bodyOf(engine.read(), m);
    }
    return olderBodyFor(m);
  });

  /*
   * Attachments for the OPEN message only, and released when it changes.
   *
   * The release is not tidiness: the engine hands out `blob:` URLs, and a URL nobody revokes
   * outlives the message that owned it for the life of the tab.
   */
  const attachments = useMessageAttachments(engine, selectedOhbox?.id ?? null, {
    onDownloadAllFailed: () => toast(t("ohbox.toastDownloadAllFailed")),
  });

  /*
   * The spy-pixel blocker's consent half. NOT keyed on the open message: consent is a
   * decision about a message and it outlives the selection, so a reader who loads images,
   * moves on and comes back does not have to press again.
   *
   * The failure sentence is the SERVER'S, through `messageOf`. There is no `en.json` key for
   * it deliberately: `api-client.ts`'s header is explicit that re-deriving these sentences in
   * the client is how somebody is told the wrong reason, and a consent write can fail for
   * reasons this shell has no way to enumerate.
   */
  /*
   * `mode` is resolved from the SAME `useConsentState` the Settings toggle writes through, so
   * flipping the setting re-renders the open message with the new mode instead of leaving this
   * tab on the value it started with — the argument `dormancySection` makes about the dial.
   *
   * `blockRemoteImages` is TRUE at rest, so everything that is not a successful read of a server
   * that reported no opt-out — a failed fetch, an API older than mail 0048, the demo, a build with
   * no API — arrives here as `"manual"` and keeps the per-message button. See `consent-state.ts`.
   */
  const remoteImages = useRemoteImages({
    // `/img` is fetched by the browser from an `<img src>`, so the account boundary in `api()`
    // never sees it. Same predicate as every other direct reader — see `syncMayRead`.
    mayRead: mayReadOlderBody,
    onFailed: (message) => toast(message),
    mode: consent.blockRemoteImages ? "manual" : "auto",
    // The pixel switch rides the same hook for the same reason `mode` does: the Settings row and
    // the open message read one `useConsentState`, so flipping it re-sanitizes what is on screen.
    // `blockTrackingPixels` rests TRUE, so every unknown arrives as "do not load".
    loadPixels: !consent.blockTrackingPixels,
  });

  /**
   * The Screener's unsubscribe passthrough (C) — `engine.unsubscribe`, or ABSENT on the demo.
   *
   * Withheld when `demo`, so a screened-out / spam preview offers no unsubscribe control on a
   * client with no server (`engine.unsubscribe` would answer `null` anyway — the FixturesAdapter
   * serves none — and an undefined callback is what keeps the control from rendering at all,
   * the same posture `remoteImages` takes). A refusal REJECTS with the server's own sentence,
   * which the view renders verbatim rather than re-deriving.
   */
  const onUnsubscribe = useMemo(
    () => (demo ? undefined : (id: string) => engine.unsubscribe(id)),
    [demo, engine],
  );

  /**
   * The Ohbox's split-pane selection IS the intent: selecting a row renders the message in full
   * anatomy, so the selected body is fetched on selection (a truncation inside that anatomy
   * reads as a short email, not a missing body). In the shell rather than `OhboxView` for
   * `message-chrome.tsx`'s reason: the pane mounts twice while the reader is open, and the test
   * harness mounts the view with no `EngineProvider`. `urgent`, and only the two selection
   * effects pass it: this message IS the screen and must not queue behind the four-wide limiter.
   * It is deliberately not `retry`, which would re-ask a refusing server from a re-running
   * effect — the billed poll the failed-guard prevents.
   */
  useEffect(() => {
    if (selectedOhbox) hydrateBody(selectedOhbox.id, { urgent: true });
  }, [selectedOhbox?.id, hydrateBody]);

  /**
   * The reader's own message is hydrated too — the gap that made History
   * snippet-only. The effect above covers the split-pane selection; a
   * message opened straight into the reader sheet (History's `onOpen`, and
   * every width whose reading column is hidden) was never reached by it, so
   * the pane rendered `bodyOf` over an un-hydrated mirror. Keyed on
   * `readerFor` as the selection effect is keyed on `selectedOhbox.id`;
   * `hydrateBody` is single-flight and idempotent, so the overlap when the
   * reader shows an Ohbox message costs nothing.
   */
  useEffect(() => {
    if (readerFor) hydrateBody(readerFor, { urgent: true });
  }, [readerFor, hydrateBody]);

  // The engine's `unread` IS the answer now — the client-side overlay that used to sit on top of
  // it is gone. The optimistic overlay already makes the flip instant, and unlike the `Set` it
  // survives a reload, because it is backed by a row.
  const receiptsIsUnread = useStableCallback((m: EngineMessage) => m.unread);
  const receiptsUnread = receipts.filter(receiptsIsUnread).length;
  /**
   * What the rail counts for the streams: "new since last visit" — the fresh side of each
   * view's line, still unread on the server ({@link FeedPartition.newCount} holds the
   * argument). Never a bare unread count (the piles carry no per-row unread status), and never
   * bare `fresh.length` — the line is per-device and that number once differed by thirteen
   * between two clients over a fully read pile. `rail.readsTitle` says it in full ("12 new
   * since you were here"). `receiptsUnread` survives for Mark-all-read only — that control is
   * about `\Seen` on the user's other clients, not this pile's newness.
   */
  const readsNew = partition.newCount;
  const receiptsNew = receiptsPartition.newCount;

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

  /* ── shared actions ── */
  const openTagPicker = useStableCallback((messageId: string, anchor: HTMLElement | null) => {
    setPickerIds(null);
    setPicker({ forId: messageId, ...placePicker(anchor) });
  });

  /**
   * THE INLINE REPLY.
   *
   * Opening it does NOT change the route and does not close the reader: that is the whole
   * complaint. The draft is restored from `localStorage` on open, so a reload lands you
   * back in the same half-written sentence.
   */
  /**
   * The scratch-buffer key for the OPEN editor. A forward's note and a half-written reply to
   * the same message are different texts with different fates, so they must not share a
   * `localStorage` slot — the prefix is the whole of the separation, and both sides of it
   * (the open's read, `onReplyBody`'s write) derive it from here.
   */
  const replyDraftKey = useStableCallback((mode: "reply" | "forward", messageId: string): string =>
    mode === "forward" ? inlineForwardKey(messageId) : messageId);

  const openReply = useStableCallback((messageId: string, all = false) => {
    // The mode travels with the open, never separately: a Reply press while a reply-all
    // editor is up on the same message is an explicit narrowing, and vice versa.
    setReplyAll(all);
    setReplyMode("reply");
    setReplyTo(messageId);
    setReplyBody(readReplyDraft(messageId));
    // MOBILE. Under 900px the reading column is `display:none` (app.css), so an inline
    // reply would mount into a pane nobody can see and `r` would look broken — measured on
    // the shipped build at 390px. There, the reader IS the open message, so open it.
    if (readColumnHidden()) setReaderFor(messageId);
  });

  /**
   * The inline forward — the reply dock in forward mode, inside the thread.
   * Replaces the navigation `forwardMessage` used to make (forwarding one
   * message of a conversation meant leaving it for the compose screen).
   * The wire is unchanged — the same `mail_send { forwardOf }`, the server
   * builds the quote and streams the original's attachments, recipients are
   * the user's — only the surface moved: the reply's editor, docked at the
   * thread's foot. The `no_forward` refusal stays client-side courtesy AND
   * server-side law.
   */
  const openForward = useStableCallback((messageId: string) => {
    const m = engine.read().get<EngineMessage>("message", messageId);
    if (!m) return;
    if (m.sensitivity?.no_forward) {
      toast(t("compose.forwardRefused"));
      return;
    }
    setReplyAll(false);
    setReplyMode("forward");
    setReplyTo(messageId);
    setReplyBody(readReplyDraft(replyDraftKey("forward", messageId)));
    // The same mobile rule `openReply` states: below 900px the dock lives in the reader.
    if (readColumnHidden()) setReaderFor(messageId);
  });

  const closeReply = useStableCallback(() => setReplyTo(null));

  /**
   * Reply is a toggle on the verbs that say "Reply" — the pill and `r`/`⇧R`.
   * Pressing the verb that opened the editor closes it; the draft survives,
   * as it survives Cancel and Escape. The MODE is part of the identity:
   * Reply pressed while a reply-all editor is up is an explicit narrowing,
   * not a close — only the same verb on the same message toggles.
   * Retargeting paths (a panel's ⋯ menu, a sibling's footer verbs, the
   * drafter) stay on `openReply`: "reply to THIS message" is not a toggle.
   */
  const toggleReply = useStableCallback((messageId: string, all = false) => {
    // The MODE is part of the editor's identity: Reply pressed while the FORWARD dock is up on
    // the same message is a switch to the reply, not a close — only the same verb on the same
    // message in the same mode toggles.
    if (replyTo === messageId && replyAll === all && replyMode === "reply") {
      setReplyTo(null);
      return;
    }
    openReply(messageId, all);
  });

  const onReplyBody = useStableCallback((next: RichValue) => {
    setReplyBody(next);
    // The mode-aware key — a forward note must never overwrite a reply draft. See
    // `replyDraftKey`.
    if (replyTo) writeReplyDraft(replyDraftKey(replyMode, replyTo), next);
  });

  /* ── buying a drafted reply ───────────────────────────────────────────────────────────── */

  /**
   * WHAT IS IN THE EDITOR RIGHT NOW, as refs.
   *
   * `onDraft` runs when the server answers, which can be seconds after the press, and the
   * person who pressed is usually still typing. A callback closed over `replyBody` would be
   * holding the text as it was at press time, so "add the draft below what I wrote" would
   * silently drop every keystroke made while the request was out. Refs are read at call time,
   * which is the only moment the question has a correct answer — and they also let `onDraft`
   * be identity-stable, so the confirm button is not rebound on every keystroke.
   */
  const replyBodyRef = useRef(replyBody);
  replyBodyRef.current = replyBody;
  const replyToRef = useRef(replyTo);
  replyToRef.current = replyTo;
  /** The mode, readable from settle handlers and draft arrivals — same idiom as `replyToRef`. */
  const replyModeRef = useRef(replyMode);
  replyModeRef.current = replyMode;

  /**
   * A DRAFT THAT ARRIVED ON TOP OF SOMETHING ALREADY WRITTEN, and has not been placed yet.
   *
   * It is NOT cleared when the editor closes. The AI action has been spent by the time this
   * exists, and dropping the result because somebody pressed Escape would be charging for
   * something and then throwing it away — reopening the reply on that message asks the
   * question again. It is cleared when the question is answered, and when a send for that
   * message settles, which is the one moment the draft is genuinely moot.
   */
  const [pendingDraft, setPendingDraft] =
    useState<{ draft: DraftedReply; messageId: string } | null>(null);

  /** Open the reply on `messageId` and put `next` in it — memory, buffer and mobile alike. */
  const placeDraft = useStableCallback((messageId: string, next: RichValue) => {
    // An arriving draft keeps the audience the editor already has on this message — a
    // reply-all someone bought a draft for must not silently narrow to the sender alone —
    // and resets to a plain reply when it opens the editor on a different message.
    setReplyAll((prev) => replyToRef.current === messageId && prev);
    // A drafted REPLY places into a REPLY editor, whatever the dock is doing right now: with
    // the forward dock up on the same message, placing into `replyBody` without flipping the
    // mode would put generated reply text into the forward's note and send it as one. The
    // forward's own note is safe in its `fwd:` scratch.
    setReplyMode("reply");
    setReplyTo(messageId);
    setReplyBody(next);
    writeReplyDraft(messageId, next);
    // Same mobile rule `openReply` states: under 900px the reading column is display:none,
    // so an editor mounted there is one nobody can see.
    if (readColumnHidden()) setReaderFor(messageId);
  });

  /**
   * The draft arrives. It goes into the editor and nowhere else: no
   * mutation, nothing sent, no triage state moved — a generated draft is
   * not an answered message, and the Reply Run's debt is discharged by a
   * send settling and nothing else (`onSendSettled`); asserted in
   * `draft-reply-wiring.test.tsx`. An empty editor takes the draft
   * directly; a non-empty one is asked, and keeps its text until answered.
   */
  const onDraft = useStableCallback((draft: DraftedReply, messageId: string) => {
    // The FORWARD dock's body is not "existing reply text": when the open editor is the
    // forward on this message, the reply's own scratch is the honest source.
    const existing =
      replyToRef.current === messageId && replyModeRef.current === "reply"
        ? replyBodyRef.current
        : readReplyDraft(messageId);
    if (isRichEmpty(existing)) {
      placeDraft(messageId, draft);
      return;
    }
    // The reply is opened either way, so the question is asked beside the text it is about
    // rather than in a dialog over a message that is not on screen.
    placeDraft(messageId, existing);
    setPendingDraft({ draft, messageId });
  });

  const draftReply = useDraftReply({ onDraft });

  const resolveDraft = useStableCallback((mode: "replace" | "append") => {
    if (!pendingDraft) return;
    const { draft, messageId } = pendingDraft;
    const existing =
      replyToRef.current === messageId && replyModeRef.current === "reply"
        ? replyBodyRef.current
        : readReplyDraft(messageId);
    placeDraft(messageId, mode === "replace" ? draft : appendRich(existing, draft));
    setPendingDraft(null);
  });

  const draftReplyChrome = useMemo(
    () => ({ control: draftReply, pending: pendingDraft, resolve: resolveDraft }),
    [draftReply, pendingDraft, resolveDraft],
  );

  /**
   * Sending. The state machine, retry driver and triage clear live in `mail-send.ts`; this only
   * says what "settled" means to the shell. For a reply: close the editor only if it is still
   * open on that same message — a retry's confirmation can arrive after the user moved on, and
   * closing then would discard a different half-written reply. For a compose: empty the form
   * (the localStorage half is cleared by the send machine itself). A Reply Run step is
   * discharged HERE and only here: the press only sends, `settle` calls this on a confirmation
   * and nothing else, so a step is left behind only by a reply that exists — two discharge
   * rules is how a FAILED send still clears the debt.
   */
  /**
   * The autosave hook's endings, through refs — not decoration:
   * `onSendSettled` and `discardDraft` are declared here and
   * `useComposeAutosave` is called two hundred lines below (it needs the
   * resolved From options). Naming `autosave` directly in a callback body
   * is a temporal-dead-zone reference TypeScript accepts inside a closure
   * but cannot join a dependency array. The refs are assigned once the hook
   * exists (`attachments.ts`'s shape). `settleComposeRef` is invariant T's
   * one function — every ending of a bound compose goes through it.
   */
  const settleComposeRef = useRef<(fate: ComposeFate) => void>(() => {});
  const releaseDraftIdRef = useRef<string | null>(null);
  const releaseBindingRef = useRef<() => void>(() => {});
  /** Late-bound for the same reason as {@link settleComposeRef} — see below where it is assigned. */
  const openMessageRef = useRef<(m: EngineMessage) => void>(() => {});
  /**
   * WHICH DRAFT ROW SEEDED WHICH REPLY EDITOR — `message id → draft id`, written by `openDraft`
   * when a reply draft opens in its message's own inline editor. The inline reply has no
   * autosave, so a send from that editor creates its own row; without this map the seeded row
   * would survive the delivery as a phantom draft — the sent message sitting in Drafts under
   * "haven't sent", reopenable with Send live. Entries leave when the send settles (discarded
   * below) or when the row is discarded from the Drafts list (`discardDraft`).
   */
  const replySeedDrafts = useRef(new Map<string, string>());
  /*
   * The compose recovery is gone, and its absence is the fix. `recoverySeed`
   * seeded an `unverified` or stranded `sending` draft's text into a FRESH
   * row — exactly what invariant S(2) forbids: a message whose first send
   * may already be delivered, re-sent under a key the server cannot
   * recognise. Such a row is PARKED now (`holdOf` parks every non-`draft`
   * status), so the branch cannot be entered and the ref and its clears are
   * removed rather than left as a dead arm. Instead: the row is listed in
   * Drafts with the warning, and Try again replays the ORIGINAL key — the one repeat the server can recognise.
   */

  /**
   * The reply that most recently settled, handed to `OhboxView` for the animate-to-Earlier gesture
   * — the Ohbox's one deliberate mid-session move: the answered row slides to "Earlier" and is
   * marked read. Set only for a reply: a compose answers nothing and moves no row out of "New for
   * you".
   */
  const [replyDone, setReplyDone] = useState<OhboxReplyDone | null>(null);

  const onSendSettled = useStableCallback((key: string, m: MailSendMutation) => {
    if (key === COMPOSE_SEND_KEY) {
      /* Invariant T(b), and this is the one implementation of it: the live
         confirmed path and the reload path both call `settleCompose` now
         (they used to clear the compose in different statements and
         drifted — a delivered message sat in the composer). It RELEASES
         when the send used the row and DISCARDS when it did not
         (`autosave.settled`'s judgement): deleting a row the send used
         would destroy the account's record of an outgoing mail, while a
         send pressed before the first save made its own row. The surface
         half — emptying the form, arriving at the list — is `onCleared`. */
      settleComposeRef.current({
        kind: "sentByMirror", rowId: m.draftId ?? null, toList: m.sendAt ? "drafts" : "ohbox",
      });
      /**
       * And the message is sent, so the compose is over. It used to stay on screen after a
       * confirmed send — an emptied form and a toast, the reader wondering whether to press
       * Send again. Navigate on the CONFIRMATION, not the press: by then the engine has
       * materialised the optimistic Sent copy from the server's `{status:"sent"}` answer, so
       * the Ohbox this lands on already holds the message ("Earlier" ranks a sent message by
       * its send time). A failed send never reaches here — the compose stays put with its text.
       * The selection clears too: arriving with an earlier visit's message open would put a
       * stranger's mail in the reading column.
       */
      return;
    }
    /**
     * AN INLINE FORWARD SETTLED — close the dock and nothing else. A forward is NOT an answer:
     * it marks nothing read, discharges no triage debt (`settle`'s discharge lives in the
     * reply branch), and hands the Ohbox no `replyDone` gesture — forwarding a message to a
     * colleague is not being done with it. The scratch note is already cleared by `settle`
     * (the lane doubles as the suffix).
     */
    if (key.startsWith("fwd:")) {
      const forwarded = key.slice(4);
      // Close ONLY the editor this settlement is about: a late forward confirmation must not
      // take down a REPLY the user has since opened on the same message.
      setReplyTo((cur) =>
        cur === forwarded && replyModeRef.current === "forward" ? null : cur,
      );
      return;
    }
    // A reply seeded from a draft row settled: the row's message has been delivered (the send
    // wrote its own row), so the seed is a phantom draft now — see `replySeedDrafts`.
    const seeded = replySeedDrafts.current.get(key);
    if (seeded) {
      replySeedDrafts.current.delete(key);
      void engine.mutate({ kind: "draft_discard", draftId: seeded });
      writeReplyMeta(`draft:${seeded}`, {}); // the phantom row's block state dies with it
    }
    // A reply settled. `key` is the answered message's id (`sendKeyOf`), which is exactly the row
    // that should move from "New for you" to "Earlier" — so hand it to the Ohbox for the gesture.
    setReplyDone({ messageId: key, at: new Date().toISOString() });
    // The mirror-image of the fwd: guard above: a late REPLY confirmation must not close a
    // FORWARD newly opened on the same message.
    setReplyTo((cur) => (cur === key && replyModeRef.current === "reply" ? null : cur));
    // A reply to this message has been delivered, so a drafted alternative to it is moot.
    // This is the ONLY thing that discards an unplaced draft other than answering the
    // question, because the AI action behind it has already been spent.
    setPendingDraft((p) => (p?.messageId === key ? null : p));

    /**
     * Guarded on the item the run is STANDING ON, not on "a run is open". A confirmation can arrive from a flush
     * minutes after the press — by which time the user may have skipped past that message, or closed the run and
     * started a second one over a fresh snapshot of a pile that has moved. Advancing on the key alone would step over
     * a message nobody answered, which is the same lie in a rarer form. A late confirmation for a message the run is
     * no longer on still discharges the debt (`settle` does that), and simply does not move a cursor that has gone
     * elsewhere. `fr` is closed over rather than read from a ref because `useMailSend` re-points `settledRef` on
     * every render, so what runs here is always the latest committed run.
     */
    const item = fr ? fr.items[fr.step] : undefined;
    if (!fr || !item || item.messageId !== key) return;
    setFrDone((s) => new Set(s).add(key));
    // The typed text is spent. `settle` has already removed the `localStorage` half.
    setFrValues((vals) => {
      if (!(key in vals)) return vals;
      const { [key]: _delivered, ...rest } = vals;
      return rest;
    });
    setFr({ ...fr, step: fr.step + 1 });
  });
  const mailSend = useMailSend(engine, toast, onSendSettled);
  /**
   * The body comes from REACT STATE, not from `readReplyDraft`. Private mode refuses the
   * `localStorage` write, so re-reading the scratch buffer at press time would send an empty
   * reply — or, with the empty guard in place, refuse to send at all — for anyone browsing
   * privately. The editor is only reachable while `replyTo` is this message, so the guard
   * below is a belt on the same waistband.
   */
  /**
   * WHICH ADDRESSES THIS ACCOUNT CAN SEND FROM. The rule is `compose-from.ts`; this is the one place the two sources
   * of mailboxes are reconciled. `GET /mailboxes` when we have it — it is the only source that knows an address is
   * `disabled`, and the only one with a `createdAt` to order by. The mirror's `"mailbox"` entities otherwise, which
   * is the demo and the Desktop: `"mailbox"` is not an `EntityType` in the change log, so those rows exist only where
   * the FixturesAdapter seeded them. An EMPTY list is "nothing can be named", and every consumer below renders no
   * From line and puts nothing extra on the wire rather than guessing. That is the Desktop, and it is also a Cloud
   * tab in the moment before its first poll lands.
   */
  const fromOptions = useMemo(
    () => (facts ? optionsFromFacts(facts) : optionsFromMirror(mailboxes)),
    [facts, mailboxes],
  );

  /**
   * The body comes from REACT STATE, not from `readReplyDraft`: private mode refuses the `localStorage` write, so
   * re-reading the scratch buffer at press time would send an empty reply — or refuse to send at all — for anyone
   * browsing privately. The editor is only reachable while `replyTo` is this message, so the guard below is a belt on
   * the same waistband. It names a mailbox only to OVERRIDE one: a reply sends from the mailbox the message arrived
   * in, already derived by `Engine.enrich` from the parent, so the ordinary case adds nothing. `mailboxId` is
   * attached only when the resolved sender is NOT the parent's — the parent's mailbox is disabled or gone and
   * `resolveReplyFrom` named a substitute (`InlineReply` saying so on screen), or the reader picked an address in the
   * From selector (`replyFromId`); wire and sentence come from the same call over the same override.
   */

  /**
   * When nothing can be named the field stays off — `sendingMailboxId`'s newest-message guess is a COMPOSE fallback
   * and must never reach a reply.
   */

  /**
   * The envelope reads `ownAddresses`, and it must be the CURRENT one: a callback that captured
   * it once would answer with the identity the account had when the closure was made — on a
   * cold tab the empty list, the unknown-reader envelope — for as long as the closure lived.
   * `useStableCallback` makes that unrepresentable rather than a dependency array: the body is
   * rebuilt every render and reached through a ref, so there is no capture to go stale and no
   * list of names to keep in step with the reads above.
   */
  const sendReply = useStableCallback((messageId: string) => {
    if (messageId !== replyTo) return;
    const parent = reader.get<EngineMessage>("message", messageId) ?? null;
    const parentMailbox = parent?.mailboxId ?? null;
    const from = resolveReplyFrom(fromOptions, parentMailbox, replyFromId);
    /**
     * THE SIGNATURE, DERIVED EXACTLY AS THE BLOCK RENDERS IT — same state, same map, same
     * resolved sender — and sealed into the mutation by `withSignature` at THIS press, so a
     * send mid-edit ships the block's current text and never a torn mix. `null` (struck,
     * empty, sender stores none, signatures not yet server-confirmed) leaves the mutation
     * byte-identical to one built before signatures existed.
     */
    const sigText = effectiveSignature(
      replySig,
      consent.signaturesKnown ? consent.signatures : {},
      from.mailboxId,
    );
    /**
     * AND THE MARKUP HALF, from the SAME state and the SAME resolved sender (mail 0098). It is
     * non-null only while the block is showing what the mailbox stores, which is exactly when
     * the block renders the document rather than the text — so the html part of the message
     * carries what was on screen. `null` takes the escaped-text path, byte-identical to the
     * send this line did not exist for.
     */
    const sigHtml = effectiveSignatureHtml(
      replySig,
      consent.signaturesKnown ? consent.signaturesHtml : {},
      from.mailboxId,
    );
    /**
     * THE INLINE FORWARD'S ARM — the same builder the editor's lock judged
     * (`forwardSend`/`forwardEnvelopePlan`, one derivation), sent on the INLINE surface so
     * the outcome lands on the dock's own lane (`inlineForwardKey`) rather than the compose
     * form's. Recipients are the user's edit alone; the server quotes the original and
     * streams its attachments (`mail_send.forwardOf`). Nothing below this block changes for
     * a reply.
     */
    if (replyMode === "forward") {
      if (!parent) return;
      mailSend.send(
        // The signature seals into the forward's note, and the server appends the quoted
        // original AFTER the body it is handed (`send-service.ts`) — so the block the editor
        // showed sits ABOVE the quoted history in what the recipient reads.
        withSignature(forwardSend(parent, {
          body: replyBody.text,
          ...(replyBody.html ? { html: replyBody.html } : {}),
          // The resolved sender, or the receiving mailbox — the editor's lock judged the
          // same fallback (`InlineReply`), so the button and the wire agree everywhere the
          // facts are unreadable.
          mailboxId: from.mailboxId ?? parent.mailboxId,
          ...(replyAttachments.length > 0 ? { attachments: replyAttachments } : {}),
          plan: forwardEnvelopePlan(replyEnvelope, fromOptions.map((o) => o.address)),
        }), sigText, sigHtml),
        { surface: "inline" },
      );
      return;
    }
    // WHO IT IS ADDRESSED TO — `replyEnvelopePlan`, ONE derivation for the head, the lock and this wire. Untouched
    // (`replyEnvelope === null`) it is exactly the old inline resolution: `replyAllRecipients` for a reply-all (the
    // same call that let the button render), `replyRecipients` for the self-authored plain case, nothing otherwise so
    // `Engine.enrich` keeps deriving `[parent.from]` — and never a Bcc, which no reply derives. EDITED, the user's
    // strings are the envelope: To/Cc/Bcc parsed by the compose form's own parser, a typo emptying the whole set so
    // `canSend` refuses it (the same rule `composePlan` enforces, arriving on the same predicate). `ownAddresses`,
    // and NOT `fromOptions` — which is what this line used to pass, and the sentence above ("the same call that let
    // the button render") was true of the call and false of its argument.

    // `fromOptions` answers "what may this account send AS": it falls back to the MIRROR's mailbox rows where `GET
    // /mailboxes` is absent, which is exactly the demo and the desktop shell. `ownAddresses` falls back to `[]`
    // there. So on those two surfaces the bar's predicate computed with an unknown reader while this line computed
    // with a known one, and a self-authored message could show Reply all over an envelope the send then resolved to
    // the plain reply. One question, one source.
    const plan = replyEnvelopePlan(parent, ownAddresses, replyAll, replyEnvelope);
    mailSend.send(withSignature({
      kind: "mail_send",
      inReplyTo: messageId,
      // The PLAIN half in `body`, always — it is what `canSend` judges and what the
      // optimistic row shows. The markup, when there is any, goes in `html` and the adapter
      // sends it INSTEAD of `body`, so the recipient's plaintext part is the server's own
      // rendering of the same markup rather than this client's second opinion.
      body: replyBody.text,
      ...(replyBody.html ? { html: replyBody.html } : {}),
      // OVERRIDE ENRICH ONLY TO CHANGE THE SENDER. `Engine.enrich` derives the parent's mailbox
      // (`engine.ts:1899`), so the ordinary reply attaches NOTHING and the envelope is unchanged
      // byte-for-byte. `mailboxId` rides only when the resolved sender is genuinely NOT the
      // parent's — a substitution (parent gone/disabled) or an explicit pick of a different
      // address. The last term is what keeps a bare default off the wire: with no facts and no
      // pick, `resolveReplyFrom` still names a fallback id, and forcing THAT would put a guess on
      // the wire the old `from.substituted` path left to `enrich` — which is the byte-identity
      // the untouched-reply guard pins.
      ...(from.mailboxId !== null &&
          from.mailboxId !== parentMailbox &&
          (from.substituted || replyFromId !== null)
        ? { mailboxId: from.mailboxId }
        : {}),
      // FILES, when the user attached any — carried to the send request and stored nowhere
      // (`ComposeAttachment`). Absent on a plain reply, so the untouched mutation is unchanged.
      ...(replyAttachments.length > 0 ? { attachments: replyAttachments } : {}),
      // THE SUBJECT, only when the reader retitled it — `null` attaches nothing, so the
      // untouched reply's mutation stays byte-identical and `Engine.enrich` derives the
      // `Re:` subject exactly as before. Threading never reads this text: the server sends
      // `In-Reply-To`/`References` from the parent row whatever the subject says.
      ...(replySubjectEdit !== null ? { subject: replySubjectEdit } : {}),
      ...replyEnvelopeOnWire(plan),
    }, sigText, sigHtml), { heldRow: heldReplyRow(messageId) });
  });

  /**
   * THE COMPOSE PLAN — the mutation, the rejected recipients and the empty-subject note, all derived in one place
   * from the form (`compose.ts`). The mailbox is resolved here rather than left to `Engine.enrich`, even though
   * enrich would fill a value: the BUTTON has to know whether a mailbox exists, because offering Send on an account
   * with nothing to send from is the inert affordance Compose used to be. One derivation, two consumers — the same
   * discipline as `canSend`. AND IT IS NO LONGER `sendingMailboxId` THAT DECIDES: `sendingMailboxId` answers with the
   * mailbox of the account's NEWEST MESSAGE, which on an account with two connected addresses flips the From line
   * every time the other one receives mail.
   */

  /**
   * It survives only as the last resort for the case `resolveComposeFrom` cannot speak to — no facts and no seeded
   * mirror rows — where it is still better than refusing to send, and where there is no From line on screen for it to
   * contradict.
   */
  /**
   * ── AND THE RECIPIENT MOVES IT, WHILE NOBODY HAS PICKED ─────────────────────────────────
   *
   * `compose.to` is passed so a message addressed to a domain this account itself sends from
   * leaves from THAT address (`domainMatchedFrom`) — the two-businesses case, where the oldest
   * connected mailbox is the wrong company half the time. It is still a derived default: nothing
   * writes `compose.fromMailboxId`, so it re-derives as the recipients change and the selector
   * overrides it, and the id reaches the wire through `composeMailbox` below exactly as the
   * oldest-connected default does. One resolution, one From line, one `mailboxId`.
   */
  const composeFrom = useMemo(
    () => resolveComposeFrom(fromOptions, compose.fromMailboxId, compose.to),
    [fromOptions, compose.fromMailboxId, compose.to],
  );
  const composeMailbox = composeFrom.mailboxId ?? sendingMailboxId(reader);
  /**
   * THE COMPOSE FORM IS A ROW ON THE ACCOUNT — see `compose-autosave.ts`.
   *
   * `active` is the route, so a timer armed by the last keystroke cannot write a draft after the
   * user has left. It stays armed while Compose is open and nowhere else; leaving mid-sentence
   * loses at most the last two seconds to the account, and nothing at all to the local buffer,
   * which is written on every keystroke and is what a reload restores from.
   */
  const autosave = useComposeAutosave({
    engine,
    fields: compose,
    mailboxId: composeMailbox,
    active: route.view === "compose",
    /* THE PRESS-BEFORE-FIRST-SAVE RACE, CLOSED FROM THE WRITE SIDE. While a send of this surface's
       message is on the wire, the armed save must not CREATE a row: the send that carried none
       makes the adapter create one, and a create here would be the second row for one message.
       Read off the lane's live phase rather than a ref, so it clears with the outcome.

       AND OFF THE DURABLE OUTBOX BESIDE IT, which is the half a phase cannot supply: React state
       starts empty on every mount, so a RELOAD inside that window came back with no row, no phase
       and no reason to wait — and the timer created the second row while the replay was still
       carrying the first. `version` is in this component's render path, so the read re-runs as the
       queue drains. */
    sendInFlight: SEND_IN_FLIGHT_PHASES.has(mailSend.stateOf(COMPOSE_SEND_KEY).phase)
      || sendPendingInOutbox(engine, COMPOSE_SEND_KEY)
      /* AND THE WINDOW NEITHER OF THOSE CAN SEE: a send restored from the last session leaves the
         queue BEFORE it is dispatched, so the outbox reads empty for the whole replay — measured —
         while the composer holds the text whose fate is being decided. The record answers it and
         releases itself at the settle. */
      || mailSend.restoredPending(COMPOSE_SEND_KEY),
    /* THE SURFACE HALF OF INVARIANT T's CLEAR. The hook owns the binding and ends it; emptying
       the form, dropping the reading selection and arriving at the list are this component's
       state, so they are passed in rather than moved. A SEND-LATER confirm lands on the Drafts
       view's Scheduled group — the Ohbox has nothing to show for mail that has not left, and
       arriving at a list that visibly holds the promise is what makes "Scheduled for Fri 18:00"
       a fact rather than a toast. */
    onCleared: (toList) => {
      setCompose(EMPTY_COMPOSE);
      setOhboxSel(null);
      go(toList);
    },
  });
  settleComposeRef.current = autosave.settleCompose;
  releaseDraftIdRef.current = autosave.draftId;
  releaseBindingRef.current = autosave.release;
  /**
   * THE BLOCK STATE FOLLOWS THE ROW. While autosave holds a row, the compose
   * form's signature state mirrors into the editor meta under `draft:<rowId>` — the handle a
   * reload cannot lose — so reopening the same row from Drafts (before or after a reload)
   * restores a struck or edited block. `following` stores nothing: absence IS the resting
   * state, and the meta dies with the row (`settle`, discard, cancel).
   */
  useEffect(() => {
    if (!autosave.draftId) return;
    const sig = compose.sig;
    writeReplyMeta(
      `draft:${autosave.draftId}`,
      sig && sig.kind !== "following" ? { sig } : {},
    );
  }, [autosave.draftId, compose.sig]);

  /**
   * The drafts list, and the two things a row can do. `draftsList` lists what the user can
   * still act on: `draft` rows, plus `unverified` and stranded-`sending` ones — a send that did
   * not confirm holds the only copy of its text, and hiding it made an undelivered message
   * invisible on every surface; `sent` rows and live sends stay out. Opening one: a draft that
   * answers a message THIS DEVICE HOLDS opens in that message's inline editor, where its
   * conversation is on screen; anything else opens in Compose. `repliesHere` is the same
   * predicate the row is labelled from, so badge and destination cannot disagree.
   */

  /**
   * Opening a compose draft ADOPTS its id, so the next autosave PUTs the opened row rather than creating a second
   * beside it. Opening an UNCONFIRMED send does NOT adopt, with two endings: a row this browser holds no unresolved
   * record for is STRANDED (another device sent it, or the record was resolved) — the server refuses to send a row
   * past `draft` again, so the text is recovered into a fresh row (`recoverySeed`) and the stranded one discarded
   * once the fresh send confirms; a row this browser IS still waiting on is PARKED — no fresh row, no fresh session,
   * the record's identity restored and Send refused with the warning. The parked branch decides from the RECORD,
   * never the row's status.
   */

  /**
   * And opening a reply does not adopt: the inline editor has no autosave — a per-message scratch buffer — so there
   * is nothing to adopt the id INTO, and adopting it into the COMPOSE hook would point the next compose at a reply
   * row. The draft's text seeds the editor, the row stays, and sending creates its own row — stated because it is the
   * one place the "one row birth-to-sent" rule does not yet reach.
   */
  const drafts = useMemo(() => draftsList(reader), [reader, version]);
  /**
   * ── THE UNCONFIRMED REPLY ROW THIS MESSAGE ALREADY HAS ──────────────────────────────────
   *
   * The inline reply editor is a per-message scratch buffer and carries no row, so its press asked
   * the hold about `null` and got `free` — while the row the previous press created sat at
   * `unverified` and the Drafts list said so. This is the only name that surface has for it.
   *
   * `status !== "draft"` because an ordinary draft cannot be held, and `draftsList` is the same
   * reading the Drafts door shows, so the two doors cannot disagree about which row is held.
   */
  const heldReplyRow = useStableCallback((messageId: string): string | null =>
    drafts.find((d) => d.inReplyToMessageId === messageId && d.status !== "draft")?.id ?? null);
  const draftRepliesHere = useStableCallback(
    (d: EngineDraft): boolean =>
      d.inReplyToMessageId != null && reader.get<EngineMessage>("message", d.inReplyToMessageId) != null,
  );
  /**
   * A DRAFT IS NEVER OPENED WITH A BODY THIS CLIENT DOES NOT HAVE: A bounded sync page can carry a draft row without
   * its text (`EngineDraft.body` is `null` then), and the resume freshen applies page 1 over the mirror on every
   * session older than five minutes. Seeded as "" that row becomes an empty editor, and autosave's next PUT writes
   * the blank over what the person actually wrote. So the text is asked for — `GET /drafts/:id`, one read, the route
   * the AI draft already reads back — and the editor opens only once it has arrived. If it cannot be had, the draft
   * does not open and the row says so; a refusal is the only honest arm, because every other one presents a message
   * as shorter than it is.
   */
  const openDraft = useStableCallback((d: EngineDraft) => {
    void openDraftDecision(d, {
      readDraftBody: (id) => engine.readDraftBody(id),
      openWithBody: (row, body) => { openDraftWithBody(row, body); },
      unavailable: () => { toast(t("drafts.bodyUnavailable")); },
    });
  });
  /**
   * OPEN A DRAFT WHOSE TEXT IS KNOWN. `body` is a parameter and not read off the row, so the
   * type carries the invariant: this door cannot be reached with a body the mirror does not
   * hold — {@link openDraft} above is the one that decides.
   */
  const openDraftWithBody = useStableCallback(
    (d: EngineDraft, body: string) => {
      const parent = d.inReplyToMessageId
        ? reader.get<EngineMessage>("message", d.inReplyToMessageId)
        : null;
      /**
       * THE HOLD IS ASKED FIRST, AND THE REPLY ARM IS WHY: This used to be computed BELOW the reply arm, which meant
       * a held REPLY never reached it: a draft whose parent message is in the mirror was seeded straight into the
       * inline reply editor with Send live, and `replySeedDrafts` marked it for discard on the next confirmed reply.
       * So the one row that must not be re-sent — a message we could not confirm the delivery of — was the one row
       * that opened with a Send button and a second copy of its text, while the same draft opened from the Drafts
       * list was correctly parked. The row in the report that found this IS a reply, which is how it slipped past
       * every check. Moving the read above the arm makes the hold a property of OPENING THE ROW rather than of which
       * surface happens to open it.
       */

      /**
       * A held reply now takes the held view below — the banner, the two verbs, the frozen text — like any other held
       * row.
       */
      const heldRow = readComposeRow();
      const hold = holdOf(engine, {
        lane: COMPOSE_SEND_KEY,
        draftId: d.id,
        session: heldRow !== null && heldRow === d.id ? composeSessionId() : null,
      });
      const parked = hold.kind !== "free";
      if (parent && !parked) {
        /* The message's own inline editor, seeded with what was written. `openMessageRef` and
           not `openMessage` directly: that callback needs the screener row map and the consent
           partition and is therefore declared far below this one, so the reference is late-bound
           for the same reason `settleComposeRef` is. */
        setReplyBody({ text: body, html: "" });
        setReplyTo(parent.id);
        /* REMEMBER WHICH ROW SEEDED THIS EDITOR. The inline reply has no autosave, so the send
           will create its own row — and without this note the seeded row would stay in Drafts
           as a copy of a message that has been delivered, reopenable with Send live: the
           double-send bait. `onSendSettled` discards it when a reply to THIS message confirms. */
        replySeedDrafts.current.set(parent.id, d.id);
        openMessageRef.current(parent);
        return;
      }
      // `formatRecipientChips`, never a bare join: the seeded string must end in a separator
      // or the LAST stored recipient reopens as raw text in the input — no ×, typing appends
      // to the address — while the others are chips.
      const seeded: ComposeFields = {
        to: formatRecipientChips(d.to),
        cc: formatRecipientChips(d.cc),
        bcc: formatRecipientChips(d.bcc),
        subject: d.subject,
        body,
        // NO `html`. The row stores the markup the server derived its plain part FROM, and the
        // mirror's `EngineDraft` does not carry it — seeding the rich editor from `body` would
        // silently flatten a formatted draft to text and then save the flattening back over it.
        // Plain text is the honest reading of what this client holds.
        html: "",
        fromMailboxId: d.mailboxId,
        // No `forwardOf`, and it cannot be otherwise: `forwardOf` rides the SEND request, never
        // the draft row (`send-service.ts` reads it from the request body), so the `drafts`
        // table has no column to remember it and an `EngineDraft` carries nothing to read back.
        // A forward abandoned to autosave and reopened is therefore a plain compose whose
        // subject still says "Fwd:" — the honest reading of what the account stored, and better
        // than the alternative: quoting the original into the draft body would put a copy of
        // somebody else's message — possibly a redacted sensitive one — into a stored row, the
        // exact thing the server-side quote prevents. Recorded because the fix is a schema
        // change, not a line in this function.

        // The signature block's state survives exactly as far as this device knows it (review
        // rounds 1–3). The `drafts` row stores prose and no block state, so a draft reopened
        // from ANOTHER device re-offers the block in its resting `following` state — visibly,
        // strikeable again, never silently inside the prose. On THIS device the state lives in
        // the editor meta under the ROW's id (`draft:<id>`, see `ReplyEditorMeta`) — the one
        // handle that survives a reload and names the same message; rounds 2–3 killed both
        // weaker keys (the in-memory autosave id, empty after reload; a content key, since
        // local and server-derived text legitimately differ). The meta lane leads; the
        // in-memory state is the fallback for the row autosave still holds, because storage can
        // refuse (a private window) and a same-session reopen must not resurrect a struck block.
        ...((): Partial<ComposeFields> => {
          if (d.status !== "draft") return {};
          // LIVE STATE IS AUTHORITATIVE for the row the composer still holds:
          // storage can hold an OLDER value than what is on screen right now if a later write
          // was refused (quota exhaustion is the measured case), and `??` would prefer that
          // stale stored value over the newer in-memory edit. Only for a row autosave does NOT
          // hold — a different device's draft, or a stranded row this session never opened —
          // does the stored meta speak at all.
          const sig = autosave.draftId === d.id ? compose.sig : readReplyMeta(`draft:${d.id}`).sig;
          return sig && sig.kind !== "following" ? { sig } : {};
        })(),
      };
      /**
       * IS THIS ROW A MESSAGE WE ARE STILL WAITING TO LEARN THE FATE OF?: Asked FIRST — before the form is touched —
       * because it decides which of the doors below this is, and one of them does not open at all. `holdOf` and not a
       * reading of its own: the SAME question is asked when a reload brings this surface back (`compose-autosave.ts`)
       * and when Send is pressed, and the three answering differently was a duplicate delivery each time. It answers
       * with the record's own names as well as a verdict, because "yes" is not enough here — the parked branch has to
       * put the message's identity BACK, which means knowing what it was. THE SESSION IS ASKED ABOUT ONLY WHEN THE
       * ROW BEING OPENED IS THE ONE THIS COMPOSE IS HOLDING. Passing it unconditionally would park every draft in the
       * account behind one unresolved send, because the session names whichever message the composer has open.
       */

      /**
       * Passing it NEVER misses the message whose record names a session and no row: a send pressed before the first
       * save has only `compose:<session>`, autosave then creates the row moments later, and nothing had attached it
       * to the record — so the row that appears in Drafts belonged to a parked message that the row alone could not
       * identify. `readComposeRow` is the link: that row IS this compose's row, so this compose's session speaks for
       * it.
       */
      /**
       * AND IT DOES NOT OPEN OVER SOMETHING SOMEBODY IS STILL WRITING: The parked door deliberately does NOT re-mint
       * the compose session or clear the scratch buffer — that is what keeps the reopened message recognisable as
       * itself. The cost is that `writeComposeDraft` below then overwrites the buffer of whatever WAS on screen, and
       * that buffer is the only copy of a message the account has not been given yet. Measured on the release
       * candidate: write s2, reopen the held s1, and s2's text was gone with nothing having asked. Saving s2 first is
       * not the alternative — that is a write, and this door has no business writing a row on the way through. So the
       * reopen is REFUSED and says why. Only against unsaved text, and only for a row this composer is not already
       * holding: reopening the very row on screen changes nothing about it.
       */
      if (parked && reopenWouldOverwrite(composeRef.current, seeded)) {
        toast(t("drafts.heldReopenBlocked"));
        return;
      }
      setCompose(seeded);
      /**
       * A DIFFERENT MESSAGE, SO A DIFFERENT COMPOSE SESSION. The id is what parks an unresolved send (`compose.ts`),
       * and leaving it in place made one session span every draft this surface opened: a send of the FIRST one that
       * came back unverified then parked whichever draft replaced it, with the warning above a refused Send button.
       * Cleared before the new buffer is written, so the next read of `composeSessionId` mints a fresh id. NOT for a
       * parked row, and that exception is the whole of the defect above. Re-minting is what makes the reopened
       * message a NEW one, and a new message is exactly what the record must not be told: both names it carries — the
       * row and the session — would be off the message at once, the park could not recognise it, Send would light up,
       * and one press would deliver a second copy under a fresh key. Measured end to end, recipient total 2.
       */

      /**
       * `unknown` keeps the session for the same reason, on weaker evidence: this browser cannot read its own record,
       * so it cannot say the message is new either.
       */
      if (!parked) clearComposeDraft();
      writeComposeDraft(seeded);
      if (parked) {
        /**
         * The held message, reopened as itself. No new row, no re-minted session, nothing released and nothing
         * deleted: the record still names this message, so `canSend` refuses the press and the surface shows the
         * sentence that is true about it. Not adopted either, whatever the row's status: a row past `draft` refuses
         * every PUT (`SendService` reserves only from `status='draft'`), and a row still at `draft` is deliberately
         * not adopted, so this branch has ONE behaviour rather than two that differ by a status nobody on this path
         * acts on.
         */

        /**
         * This is also where the recovery door used to be: a stranded `sending` row took a third branch that seeded
         * the text into a FRESH row and sent that — invariant S(2) forbids it (the row whose send is most likely in
         * flight is the last one to send again), and `holdOf` calls every non-`draft` status parked, so the branch is
         * unreachable and gone rather than left as a dead arm.
         */

        /**
         * The identity is RESTORED, not merely left alone. "Left alone" was true only for the door the user came
         * through immediately: any door in between (writing to a contact, a mail link) legitimately mints a new
         * session, so the browser arrives back holding NEITHER of the record's names — the park was recognised but
         * presented under a session the record never heard of: no warning, Send live, one press, a second copy. So
         * both names go back: the record's own session (what `canSend` compares against), and the row, HELD
         * (`writeComposeRow`) and not adopted — the composer takes no row, so nothing PUTs to it and a Discard cannot
         * delete it, while the save effect's create block reads the held id and mints nothing beside it.
         */

        /**
         * `autosave.release()` first, because it clears the held row on its way past and would otherwise erase what
         * is written next; a hold with no session of its own leaves the current session standing — it is named by its
         * row, which is the id being held.
         */
        autosave.release();
        writeComposeRow(hold.kind === "parked" ? hold.draftId ?? d.id : d.id);
        if (hold.kind === "parked" && hold.session != null) writeComposeSession(hold.session);
      } else {
        /* FREE, so it is an ordinary draft and it is adopted: the next autosave PATCHes the row
           that was opened rather than creating a second one beside it. `holdOf` answers `free`
           only for a row the mirror positively calls `draft`, so there is no second arm here for
           a status this branch would have to decide about. */
        autosave.adopt(d.id, seeded);
      }
      go("compose");
    },
  );
  /**
   * THE SCHEDULED SENDS (mail 0077), and their two verbs: The list is every `scheduled` draft, soonest first
   * (`scheduledSendsList`). CANCEL flips the row back to an ordinary draft; the interesting outcome is the refusal —
   * the server's claim got there first and the mail is leaving — which is reported in its own sentence rather than
   * pretending the cancel landed (the overlay rolls back with the rejection, so the row on screen never falsely reads
   * "cancelled"). EDIT is cancel-then-open, in that order and gated on the cancel confirming, because a `scheduled`
   * row is frozen on the server (`DraftsService.update` refuses it) and adopting one for autosave would point every
   * PUT at a 409.
   */
  const scheduled = useMemo(() => scheduledSendsList(reader), [reader, version]);
  /**
   * ONLY `confirmed` IS A CANCELLATION. `queued` means the wire refused retryably and the intent is parked — the
   * appointment STILL EXISTS server-side and its clock is still running, so saying "cancelled" (or opening the editor
   * over it) would be the row promising something the server has not done, on the one surface whose whole content is
   * a promise about time. The queued sentence says exactly that state; `rolled_back` is the server's own refusal (the
   * claim won — "already being sent"). The overlay follows the same truth: a queued mutation keeps its optimistic
   * effect, so the row shows un-scheduled while the banner says the cancel has not landed — user-always-wins, with
   * the sentence carrying the doubt.
   */
  const cancelOutcomeToast = useStableCallback((res: { status: string }) => {
    toast(res.status === "confirmed"
      ? t("drafts.scheduleCancelled")
      : res.status === "queued"
        ? t("drafts.scheduleCancelQueued")
        : t("drafts.scheduleCancelTooLate"));
  });
  const cancelSchedule = useStableCallback(
    (draftId: string) => {
      void engine.mutate({ kind: "draft_schedule_cancel", draftId }).then(cancelOutcomeToast);
    },
  );
  const editScheduled = useStableCallback(
    (d: EngineDraft) => {
      void engine.mutate({ kind: "draft_schedule_cancel", draftId: d.id }).then((res) => {
        if (res.status !== "confirmed") {
          // NOT opened: adopting a row whose appointment may still stand would point autosave
          // at a frozen row (409 per PUT) and let edits race a send the user believes stopped.
          cancelOutcomeToast(res);
          return;
        }
        // The row is a plain draft now, confirmed; hand `openDraft` the same reading so it
        // ADOPTS rather than treating the row as a stranded send.
        openDraft({ ...d, status: "draft", sendAt: null });
      });
    },
  );
  /**
   * A PERSON ANSWERS FOR A SEND WE COULD NOT CONFIRM: The one sanctioned exit from the hold, and the reason a held
   * row is no longer a dead end. It asks `holdOf` NOTHING, deliberately: every other write site in this shell asks
   * the predicate because it is about to change a message somebody may already have received, and this one is the
   * opposite — it is how the reader tells us WHICH of those two worlds we are in. Gating it on the hold would make
   * the hold unliftable, which is the defect. No toast on success. The row itself is the answer: it either leaves the
   * list (`arrived`) or turns into an ordinary draft with Discard live (`not_arrived`), and saying so in a toast as
   * well would be narrating what the reader can see. A refusal is reported, because that is the case where the screen
   * does NOT change.
   */
  const resolveHeldSend = useStableCallback(
    (draftId: string, outcome: "arrived" | "not_arrived") => {
      void engine.mutate({ kind: "draft_resolve", draftId, outcome }).then((res) => {
        if (res.status === "confirmed") return;
        // A resolve that did not land leaves the row held; the overlay has already rolled back,
        // so the note above it still reads "not confirmed" and the verbs are still there.
        toast(t("drafts.resolveFailed"));
      });
    },
  );
  /**
   * ── WHERE A LANE'S REPLY HAS GOT TO, THE ROW INCLUDED ───────────────────────────────────
   *
   * `mailSend.stateOf` alone reads the durable RECORD, which a sweep, a seven-day TTL or another
   * device can leave this browser without — and the reply reported in the field had been held for
   * a month. The server's `unverified` on the row is the witness that outlives all three, so the
   * same projection the compose form renders through is applied here.
   *
   * A forward's lane (`fwd:<id>`) names no reply row, so it passes through untouched.
   */
  const replySendState = useStableCallback((lane: string): SendState => {
    const state = mailSend.stateOf(lane);
    const row = heldReplyRow(lane);
    if (row === null) return state;
    return heldRowUnverified(
      state, row, holdOf(engine, { lane, draftId: row, session: null }), null, lane,
    );
  });
  const discardDraft = useStableCallback(
    (draftId: string) => {
      /**
       * THE LIST'S DELETE IS A WRITE SITE, AND IT WAS THE ONE NOT COUNTED: Every other `draft_discard` in the shell
       * goes through the autosave hook, which asks the predicate. This one is a person pressing Delete on a row in
       * the list and it fired straight at the wire. For a row with a send on record the server refuses it by name
       * now, so the mutation rolled back and the row came SILENTLY back — the same ending the 500 used to give, and
       * the reason "a discard that cannot happen says why" was true only from the composer. THE SESSION IS ASKED
       * ABOUT ONLY FOR THE ROW THIS COMPOSE IS HOLDING — `openDraft`'s rule, for its reason: passing it
       * unconditionally would park every draft in the account behind one unresolved send, because the session names
       * whichever message the composer has open.
       */

      /**
       * `unknown` is refused with `parked`: a delete cannot be taken back, and a browser that cannot read its own
       * record has no evidence this row is free.
       */
      const heldRow = readComposeRow();
      const hold = holdOf(engine, {
        lane: COMPOSE_SEND_KEY,
        draftId,
        session: heldRow !== null && heldRow === draftId ? composeSessionId() : null,
      });
      if (hold.kind !== "free") {
        toast(t("drafts.heldDiscardBlocked"));
        return;
      }
      /* ── NOTHING IS FORGOTTEN BEFORE THE SERVER HAS ANSWERED — invariant T ─────────────────
         The three statements below used to run the moment the mutation was dispatched, on the
         assumption that a delete asked for is a delete done. It is not: a send can reserve the row
         between the local check above and this request reaching the server (the service decides
         under the row lock), and the 409 that comes back RESTORES the row in the mirror — while
         the binding had already been dropped. The compose then sat populated with that message's
         text holding no row, and two seconds later wrote a second one for it.
         So the release, the block state and the reply seed all move inside the CONFIRMED branch,
         and the refusal restores the binding instead. */
      void engine.mutate({ kind: "draft_discard", draftId }).then((res) => {
        if (res.status === "rolled_back" && res.error?.code === "send_recorded") {
          /* THE RACE, ANSWERED THE SAME WAY the local check answers it — and the row comes back,
             so the compose that was bound to it is bound to it again. */
          settleComposeRef.current({ kind: "restoredBy409", rowId: draftId });
          toast(t("drafts.heldDiscardBlocked"));
          return;
        }
        if (res.status !== "confirmed") return;
        // The row's life ends; the block state keyed to it goes with it.
        writeReplyMeta(`draft:${draftId}`, {});
        // The compose form may be holding the very row that was just deleted — discarding from the
        // list while it is open would otherwise leave autosave PATCHing a row that is gone, and
        // the next pause would report a 404 nobody could act on.
        if (releaseDraftIdRef.current === draftId) releaseBindingRef.current();
        // The reply editor may be holding it too — a settle after this delete must not delete twice.
        for (const [msgId, dId] of replySeedDrafts.current) {
          if (dId === draftId) replySeedDrafts.current.delete(msgId);
        }
      });
    },
  );
  /* `autosave.draftId` goes on the mutation, so Send uses the row autosave already wrote instead
     of creating a second one — the whole point of one draft from first keystroke to delivery. */
  const plan = useMemo(
    () => composePlan(compose, composeMailbox, autosave.draftId),
    [compose, composeMailbox, autosave.draftId],
  );
  const onComposeFields = useStableCallback((next: ComposeFields) => {
    setCompose(next);
    writeComposeDraft(next);
  });
  /**
   * A SECOND PRESS AFTER `unverified` IS A FRESH SEND, AND IT HAS TO BUILD A FRESH ROW. The warning's contract
   * ("check your Sent folder before retrying") predates autosave, and autosave silently broke it for Compose: the
   * plan still carried the row's id, the row is `unverified`, and `SendService` refuses any key on a row past `draft`
   * — so the retry answered 409 "cannot be sent from status 'unverified'" forever. The press releases the stranded
   * row (kept, as the record of the unconfirmed first attempt — it is in Drafts saying so) and sends WITHOUT a row
   * id, so the adapter writes a fresh draft and a fresh reservation: exactly what the inline reply has always done.
   * When this send confirms, `onSendSettled` discards the stranded copy. AND THIS PATH IS NOT REACHED FOR A MESSAGE
   * THIS BROWSER IS STILL WAITING ON.
   */

  /**
   * "The next press is a deliberate fresh send" was the whole contract once and is no longer: while an unresolved
   * record names the message, `canSend` refuses the press, so there is no second press to build a row for. What
   * arrives here is a message with no such record — the stranded row above, or a record already resolved. A fresh
   * send of a message whose outcome nobody knows is precisely the duplicate delivery, and it is refused rather than
   * rebuilt.
   */
  const sendCompose = useStableCallback((sendAt?: string) => {
    /**
     * THE SIGNATURE, DERIVED EXACTLY AS THE BLOCK RENDERS IT — the form's own state, the server-confirmed map, and
     * the SAME `composeFrom.mailboxId` the block was handed — sealed at this press by `withSignature`, so a send
     * mid-edit ships the block's current text and never a torn mix. `null` (struck, empty, sender stores none,
     * signatures not yet confirmed) leaves the mutation byte-identical to one built before signatures existed.
     * Deliberately NOT serialized into `plan.mutation` itself: `canSend` judges the TYPED body, and a signature must
     * never light Send up over an empty message.
     */

    /**
     * SEND LATER (mail 0077) is the SAME press with `sendAt` on the mutation — the one send machine keeps its lock
     * and its rules, the adapter turns the field into an appointment instead of a delivery, and the recovery branch
     * below applies identically (a recovered unverified message may be scheduled as legitimately as it may be
     * resent).
     */
    const sigText = effectiveSignature(
      compose.sig ?? SIG_FOLLOWING,
      consent.signaturesKnown ? consent.signatures : {},
      composeFrom.mailboxId,
    );
    // The markup half, same state, same resolved sender (mail 0098) — see the reply arm above.
    const sigHtml = effectiveSignatureHtml(
      compose.sig ?? SIG_FOLLOWING,
      consent.signaturesKnown ? consent.signaturesHtml : {},
      composeFrom.mailboxId,
    );
    const withWhen = (m: MailSendMutation): MailSendMutation =>
      sendAt ? { ...m, sendAt } : m;
    /**
     * NO FRESH-KEY RESEND AFTER AN UNVERIFIED SEND. This used to shed the draft id and send again. Every part of that
     * was the duplicate: a send with no draft id creates a NEW draft, `useMailSend` mints a NEW key for it, and the
     * server's uniqueness is `(account_id, idempotency_key)` — so the second reservation collides with nothing and
     * both can deliver the same message. `unverified` is terminal-UNKNOWN, not failed. The reservation may already
     * have gone. The send therefore parks: `canSend` refuses while the phase stands, the durable lock keeps the
     * original key rather than releasing it, and the person is shown that it needs checking. A retry that reuses the
     * key is safe; nothing here may invent a new one.
     */
    mailSend.send(withWhen(withSignature(plan.mutation, sigText, sigHtml)));
  });

  /**
   * ABANDONING THE COMPOSE — the row, the buffer and the form, in that order. `ComposeView` decides whether to ask
   * first (`worthSaving`); this is what happens once the answer is yes, and it has to be the shell's because the
   * draft id is. All three copies of the message are named here on purpose — the account row (`autosave.discard`),
   * the `localStorage` scratch buffer (`clearComposeDraft`) and the in-memory form — because leaving any one of them
   * is a message the user threw away coming back: the row would sit in Drafts, and the buffer would refill the form
   * the next time Compose opened. `discard` is not awaited. It is fire-and-forget for the same reason `discardDraft`
   * above is: the delete is queued through the engine, which owns the retry, and holding the view open until the wire
   * answers would make leaving a message feel like a network operation.
   */
  const cancelCompose = useStableCallback(() => {
    if (autosave.draftId) writeReplyMeta(`draft:${autosave.draftId}`, {});
    void autosave.discard();
    setCompose(EMPTY_COMPOSE);
    clearComposeDraft();
    go("ohbox");
  });

  /**
   * WRITE TO ONE PERSON — the contact popover's Write verb (viewer redesign). A NEW message with the To line
   * prefilled, in the same `Name <address>` shape `openDraft`'s `line()` writes and `parseRecipients` reads back. The
   * ADDRESS is the stored wire form — the chip decodes only its face — so what reaches the envelope is what the
   * mirror holds. IT RELEASES THE AUTOSAVE FIRST: This seeds a NEW message. Without the release, `composePlan` would
   * still carry the `draftId` of whatever the form last held — an unrelated draft, possibly one opened from the
   * drafts list — so this send would overwrite that row and send from it. `openDraft` adopts for exactly the opposite
   * reason; this is the same rule read the other way round.
   */

  /**
   * (The rule used to be stated on `forwardMessage`, the compose-seeding forward this shell no longer has — Forward
   * is the thread's inline dock now, `openForward`, and never touches the compose form at all.)
   */
  const writeTo = useStableCallback(
    (address: string, name?: string) => {
      const seeded: ComposeFields = {
        ...EMPTY_COMPOSE,
        // The chips form: a prefilled recipient is settled, so it must open as a chip, not as
        // raw text in the input — the same rule as `openDraft`.
        to: formatRecipientChips([{ name: name ?? null, address }]),
      };
      /* ── A NEW-MESSAGE DOOR MUST NOT ORPHAN A HELD MESSAGE ───────────────────────────────
         This re-mints the compose session (below), which is right for a new message and is how a
         held one loses a name: a send pressed before the first save is recorded as
         `compose:<session>` alone, so once that session is replaced the record names nothing this
         browser can find, the row sits in Drafts looking ordinary, and reopening it takes the
         ordinary door with Send live. Binding the row the surface is holding onto the record
         first leaves the park reachable by ROW, which is the name that survives every door. */
      const outgoing = readComposeRow();
      const held = holdOf(engine, {
        lane: COMPOSE_SEND_KEY, draftId: outgoing, session: composeSessionId(),
      });
      if (held.kind === "parked" && held.session !== null) {
        attachSendLockDraft(COMPOSE_SEND_KEY, [`compose:${held.session}`], outgoing);
      }
      autosave.release();
      setCompose(seeded);
      // A NEW message, so a new compose session — see `openDraft` and `compose.ts`. Without it
      // this message inherited the identity of whatever the form last held, and an unresolved
      // send of THAT message parked this one: the unconfirmed warning, and Send refused, over a
      // message nobody had ever pressed Send on.
      clearComposeDraft();
      writeComposeDraft(seeded);
      // An open inline reply would otherwise sit under the compose the route change opens —
      // one editor at a time.
      setReplyTo(null);
      go("compose");
    },
  );

  /**
   * A MAILTO CLICK, DELIVERED — the host's `mailtoDraft` prop becoming the compose form. The same five steps as
   * `writeTo`, for the same reasons, one field at a time: release first (or the plan still carries an unrelated
   * draft's id and the send overwrites that row), drop any recovery, seed, persist, close an open inline reply,
   * navigate. Recipients go through the chip formatter so a prefilled address opens settled rather than as raw text;
   * the body is plain text and `html` stays empty, `openDraft`'s rule for a body with no stored HTML. An EFFECT
   * rather than a handler because the trigger is a prop from outside this tree — the OS handed the host a link, the
   * host handed the fields down. `onMailtoDraftSeeded` tells the host to drop its copy, so a remount cannot seed the
   * same click twice over whatever the person typed since.
   */
  useEffect(() => {
    if (!mailtoDraft) return;
    const chips = (list: string[]): string =>
      formatRecipientChips(list.map((address) => ({ name: null, address })));
    const seeded: ComposeFields = {
      ...EMPTY_COMPOSE,
      to: chips(mailtoDraft.to),
      cc: chips(mailtoDraft.cc),
      bcc: chips(mailtoDraft.bcc),
      subject: mailtoDraft.subject,
      body: mailtoDraft.body,
    };
    // The same binding `writeTo` does, for the same reason and in the same order — this door is
    // that one, opened by the operating system rather than by a click inside the app.
    const outgoing = readComposeRow();
    const held = holdOf(engine, {
      lane: COMPOSE_SEND_KEY, draftId: outgoing, session: composeSessionId(),
    });
    if (held.kind === "parked" && held.session !== null) {
      attachSendLockDraft(COMPOSE_SEND_KEY, [`compose:${held.session}`], outgoing);
    }
    autosave.release();
    setCompose(seeded);
    // A new compose session, for the reason `writeTo` states — this door is the same one, opened
    // by the operating system rather than by a click inside the app.
    clearComposeDraft();
    writeComposeDraft(seeded);
    setReplyTo(null);
    go("compose");
    onMailtoDraftSeeded?.();
  }, [mailtoDraft, autosave, go, onMailtoDraftSeeded]);

  /**
   * SCREENING FROM ANYWHERE — one call site for every surface. The plan comes from `sender-screening.ts`, which
   * decides whether the endpoint can be used at all; this only dispatches it and tells the truth about what happened.
   * THE RULE'S OUTCOME IS AWAITED, AND ONLY THE RULE'S: This used to toast on click for every outcome, which was
   * survivable while the only claim was "your mail moved" — a `move` that fails rolls its own row back on screen. It
   * stopped being survivable the moment the sentence started claiming something about FUTURE mail: the rules
   * surface's first cut printed "Rule revoked" over a 403 on a live account, and the fixtures adapter never refuses,
   * so every test was green. So `plan.ruleMutations` — and nothing else — is awaited, and `screeningToast` picks the
   * sentence from what the server actually said.
   */

  /**
   * The branch lives beside the sentences in `sender-screening.ts`, never here.
   */
  const changeScreening = useStableCallback((
    messageId: string,
    dest: ScreeningDest,
    scope: ScreeningScope = "sender",
    makeRule = true,
    // The contact-chip override (viewer redesign): the sheet resolved a To/Cc address, so the
    // dispatch must resolve the SAME one — a plan computed from the message id alone would
    // preview one person's mail and move the sender's.
    address?: string,
  ) => {
    setSenderMenu(null);
    const sender = senderScreening(reader, messageId, address);
    if (!sender) return;
    const plan = planScreeningChange(sender, dest, scope, makeRule);
    const place = PLACE_LABEL[dest] ?? dest;
    // The SUBJECT of the sentence follows the scope, or a domain decision would report
    // itself as being about the one address the user happened to click.
    const who = scope === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address);
    if (plan.mutations.length === 0) {
      toast(t("screening.toastAlready", { sender: who, place }));
      return;
    }
    void dispatchScreeningChange(plan, (m) => engine.mutate(m)).then((key) => {
      toast(t(`screening.${key}`, { sender: who, place, count: plan.moved }));
    });
  });

  /**
   * Open the detail view for whichever scope the sheet was showing.
   *
   * The rows are attributed HERE, at open time, rather than inside the panel: the panel then
   * holds a plain snapshot and cannot re-derive a different answer on a re-render caused by a
   * sync drain landing mid-read. The sheet closes, because the panel replaces it.
   */
  const openSenderAudit = useStableCallback((messageId: string, scope: ScreeningScope, address?: string) => {
    setSenderMenu(null);
    const sender = senderScreening(reader, messageId, address);
    if (!sender) return;
    setSenderAudit({
      title: scope === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address),
      domain: scope === "domain",
      rows: attributeMessages(reader, sender.scopes[scope].messages),
    });
  });

  /**
   * `address` is the contact-chip override (viewer redesign): the sheet then resolves that To/Cc
   * address rather than the message's sender — see `SenderMenuState.address`. Every caller
   * that predates chips passes two arguments and gets the sender, unchanged.
   */
  const openSenderMenu = useStableCallback((messageId: string, anchor: HTMLElement | null, address?: string) => {
    setSenderMenu({ messageId, address, ...placePicker(anchor) });
  });

  /**
   * OPEN THE SUBJECT-RULE SHEET — from a message's title, and from the sender popover's last row.
   * `chrome.openSubjectRule` has been a declared seam with nothing behind it since the reading surface landed; this
   * fills it. The anchor is the pressed element where there is one — the title button dispatches
   * `openSubjectRule(id)` with no element, so the sheet is placed by `placePicker(null)`, exactly as a
   * keyboard-invoked tag picker is. It CLOSES the sender popover, because the subject sheet replaces it: they answer
   * the same question about different halves of one message and two open sheets is two questions.
   */
  const openSubjectRule = useStableCallback((messageId: string, anchor: HTMLElement | null = null) => {
    setSenderMenu(null);
    setSubjectRule({ messageId, ...placePicker(anchor) });
  });

  /**
   * ── THE TWO GATES THE SPLIT VIEWS' MESSAGE VERBS BORROW ────────────────────────────────
   *
   * Folder, Tag and History declare the nine message verbs over their OWN cursor
   * (`useMessageVerbs`), because the bindings below act on `focused` and a split view's cursor
   * is state this shell cannot see. Two of those verbs are gated on facts that live here and
   * nowhere else, so they are resolved here and passed down rather than re-derived in three view
   * files — which is how the `?` sheet comes to advertise a delete the bar refuses to draw.
   *
   * `canDeleteMessage` is the delete strip's OWN render gate, verbatim from the `d` binding
   * below: the mirror actually holding the row. `canReplyAllTo` is `replyAllRecipients`
   * against the account's addresses — the same call the bar's button and the `⇧R` binding
   * both make, and the one `sendReply` resolves again at send time.
   *
   * ── WHY "USE FOLDERS" IS NOT A TERM HERE ANY MORE ─────────────────────────────────────
   *
   * It used to be the first term, and that was wrong twice over. Delete is a MOVE to the mail
   * server's OWN \Trash — a system folder every account already has, discovered at connect
   * beside \Junk — and never to a folder the user made, so the user-FOLDERS foundation flag
   * was never a fact about whether this verb can run: the server's `message_delete` has never
   * read it. And the same verb over a SELECTION never read it either (`OhboxView`'s bulk
   * delete opens on `picked.size > 0` and nothing else), so one account could file a pile to
   * Trash by picking it and could not file the row under the cursor — measured live on a
   * folders-off account before this change: the selection press produced "Moved to Trash."
   * and a `DELETE /messages/:id`, the cursor press produced nothing at all, no toast, no
   * sentence and no request. Two admissions for one verb is what made that possible, so this
   * is now the one admission both doors ask, and it asks only what it can act on.
   *
   * The flag is still supplied on the chrome and still read where it IS a fact: the folders
   * rail group, the folder views, and Move-to-folder.
   */
  const canDeleteMessage = useStableCallback((m: EngineMessage): boolean =>
    reader.get<EngineMessage>("message", m.id) != null);
  const canReplyAllTo = useStableCallback((m: EngineMessage): boolean => replyAllRecipients(m, ownAddresses) !== null);

  /**
   * WRITE THE TWO-TERM RULE, AND SAY ONLY WHAT THE SERVER CONFIRMED. The plan comes from `subject-rule.ts`; this
   * dispatches it. The RULE mutation is awaited and the moves are not — the same split `dispatchScreeningChange`
   * documents at length, for the same reason: a `move` that fails rolls its own row back on screen, while "future
   * mail files there too" is a claim about the server that a refusal falsifies. The fixtures adapter never refuses,
   * so a toast fired on click would be green in every test and wrong on a live account. Dispatched here rather than
   * inside the sheet so the sheet stays a pure render of a plan, and so the awaiting is testable without a DOM.
   */
  const confirmSubjectRule = useStableCallback((messageId: string, term: string, dest: ScreeningDest, field: TermField = "subject") => {
    setSubjectRule(null);
    const ctx = subjectRuleContext(reader, messageId);
    if (!ctx) return;
    const plan = planSubjectRule(ctx, term, dest, field);
    const place = PLACE_LABEL[dest] ?? dest;
    const rules = plan.ruleMutations.map((m) => engine.mutate(m));
    for (const m of plan.mutations) {
      if (!plan.ruleMutations.includes(m)) void engine.mutate(m);
    }
    void Promise.all(rules).then((results) => {
      const key = subjectRuleToast(plan, worstStatus(results));
      // The count is `matched`, not `outOfPlace`: the sentence is about the mail the rule NAMES,
      // which is what the confirm row showed. Reporting the smaller number afterwards would read
      // as the rule having done less than it said. The confirmed sentence names the FIELD the
      // term reads (mail 0052), because "in the subject" about a text rule is a false claim.
      toast(t.has(`screening.${key}`)
        ? t(`screening.${key}`, { sender: displayAddress(ctx.address), place, count: plan.matched, term: plan.term })
        : key === "subjectAlready"
          ? `You already had that rule. Nothing changed.`
          : key === "subjectRuleFailed"
            ? `That rule wasn't saved. Nothing has moved.`
            : key === "subjectRuleQueued"
              ? `Rule saved here. We'll send it when you're back online.`
              : plan.field === "body"
                ? `Mail from ${displayAddress(ctx.address)} with »${plan.term}« in the text now files to ${place}.`
                : `Mail from ${displayAddress(ctx.address)} with »${plan.term}« in the subject now files to ${place}.`);
    });
  });

  /**
   * Clicking a sender's circle or address, on ANY surface that shows one.
   *
   * ONE capture-phase handler on the stage rather than one per view: `MessageRow` renders a
   * `<button>`, so a second interactive control cannot be nested inside it, and every list
   * in the product already stamps `data-id` with a message id. Capture runs before the
   * row's own click, so this opens the screening popover INSTEAD of moving the cursor.
   * Shift is left alone — that gesture belongs to the Ohbox's range selection.
   *
   * ── AND THE READING SURFACES, NOT ONLY THE LISTS ────────────────────────────────────────
   *
   * The selector used to be `.row`-only, so screening a sender was reachable from every LIST
   * and from the reading pane (which wires `onSender` itself), and from nowhere in Reads or
   * Receipts — the two views whose whole content is mail from senders you might want to stop
   * hearing from. The address was right there on every card, rendered in the same grey as the
   * rows', and clicking it selected the card. A gesture that works on four surfaces and
   * silently does nothing on the fifth is worse than one that does not exist.
   *
   * `.scast` stamps `data-sid` where a row stamps `data-id`; the anchor handed to `placePicker`
   * is the card, exactly as it is the row. `stopPropagation` here is what keeps the card's own
   * `onSelect` from also firing, which is the same reason it is here for rows.
   *
   * The hit test itself is `sender-hit.ts` — a pure function of one element, so which elements
   * count as "the sender" can be asserted without standing up an engine and a router.
   */
  const onStageClickCapture = useStableCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.shiftKey) return;
    const hit = senderHitOf(e.target as HTMLElement);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    openSenderMenu(hit.id, hit.anchor);
  });

  const revokeRule = useStableCallback((ruleId: string) => engine.mutate({ kind: "rule_delete", ruleId }));

  const retargetRule = useStableCallback((ruleId: string, destination: Folder) => engine.mutate({ kind: "rule_update", ruleId, destination }));

  const toggleTag = useStableCallback((messageId: string, tagId: string, assigned: boolean) => {
    const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
    void engine.mutate({ kind: "tag_assign", messageId, tagId, assigned });
    toast(assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }));
  });

  /**
   * The same verb over a SET — and it is `tag_assign` fanned out. No new bulk mutation kind: `tag_assign` is
   * per-message on the wire, the round trips are one per message that actually CHANGES, and a selection is a handful
   * of rows rather than a pile. Inventing a bulk kind would mean a second server route to keep honest for a cost
   * nobody has measured — the brief asks for a measurement before that claim, and there is none, so the fan-out
   * stands. Messages that already agree with the target state are skipped. `tag_assign` is idempotent, so this is not
   * correctness — it is not asking a server to restate forty things it already holds.
   */
  const bulkToggleTag = useStableCallback((ids: string[], tagId: string, assigned: boolean) => {
    const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
    const targets = ids.filter((id) => {
      const m = reader.get<EngineMessage>("message", id);
      return m != null && m.labels.includes(tagId) !== assigned;
    });
    if (targets.length === 0) return;
    for (const messageId of targets) {
      void engine.mutate({ kind: "tag_assign", messageId, tagId, assigned });
    }
    if (targets.length === 1) {
      toast(assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }));
      return;
    }
    toast(
      assigned
        ? t("tag.toastTaggedMany", { name, count: targets.length })
        : t("tag.toastUntaggedMany", { name, count: targets.length }),
    );
  });

  /**
   * A TAG DROPPED ON THE RAIL — apply, never toggle.
   *
   * The rail-drop gesture (`shell/drag-file.ts`, wired in `OhboxView`) names its tag by the
   * row it landed on, so it needs no picker; what it must NOT have is a second tagging
   * semantic. This is `bulkToggleTag` in the apply direction and nothing else: the same
   * per-message `tag_assign`, the same skip of members that already carry it, the same
   * sentence at the end. A drop can never REMOVE a tag — the drop's meaning is "put it
   * here", and the picker remains the place where a tag is taken off.
   */
  const dropTag = useStableCallback((ids: string[], tagId: string) => bulkToggleTag(ids, tagId, true));

  /**
   * Mint a tag and put it on this message. ONE mutation, not two. The shell cannot call the API directly —
   * `scripts/publish-desktop.mjs` DENYs `app/api-client` from this shared shell — so the engine is the only wire, and
   * `tag_assign` carries the new name rather than a second `tag_create` verb: a create that succeeded followed by an
   * assign that failed would leave an empty tag the user never asked for, and the two-request version has no
   * transaction to undo it. The id is minted HERE so the optimistic effect paints the same tag the database stores.
   * If the name already exists the server's row wins and this id is simply never seen — the chip then appears on the
   * next drain under the real id, which is why nothing here asserts the tag is visible yet.
   */
  const createTag = useStableCallback((messageId: string, name: string) => {
    void engine.mutate({
      kind: "tag_assign", messageId, tagId: crypto.randomUUID(), assigned: true, createName: name,
    });
    toast(t("tag.toastTagged", { name }));
  });

  /**
   * THE TAG, WITHOUT A MESSAGE: Reported as: the sidebar should let you add tags, and Settings → Tags is not
   * implemented. Both had one cause — `tag_assign`'s tag-or-create was the only way to mint a tag, so a name had to
   * be attached to a message to exist, and there was no rename or delete verb at all. `POST /tags`, `PATCH /tags/:id`
   * and `DELETE /tags/:id` had been mounted the whole time with no caller; these three are the callers. The id is
   * minted here for the optimistic row only. `POST /tags` lets the DATABASE choose the id (unlike tag-or-create,
   * which mints under the client's), so this uuid names a row that lives exactly as long as the overlay — see the
   * mutation's own comment.
   */
  const createTagAlone = useStableCallback((name: string) => {
    void engine.mutate({ kind: "tag_create", tagId: crypto.randomUUID(), name });
    toast(t("tag.toastCreated", { name }));
  });

  const renameTag = useStableCallback((tagId: string, name: string) => {
    void engine.mutate({ kind: "tag_rename", tagId, name });
    toast(t("tag.toastRenamed", { name }));
  });

  /**
   * The name is read BEFORE the mutation. Afterwards the optimistic effect has already
   * tombstoned the row, so `reader.get` answers undefined and the sentence would be about a
   * tag it could not name.
   */
  const deleteTag = useStableCallback((tagId: string) => {
    const name = reader.get<TagDTO>("tag", tagId)?.name ?? "";
    void engine.mutate({ kind: "tag_delete", tagId });
    toast(t("tag.toastDeleted", { name }));
  });
  /**
   * Recolour a tag. NO toast, deliberately: the dot changes colour in place, which is the
   * confirmation — a "Recoloured Invoices" toast would restate a change the eye already saw. The
   * picker only ever passes a renderable hue (`TAG_HUES`), and the server accepts exactly those,
   * so this cannot store a colour nothing can draw.
   */
  const recolorTag = useStableCallback((tagId: string, hue: string) => {
    void engine.mutate({ kind: "tag_recolor", tagId, hue });
  });
  const tagAdmin = useMemo(
    () => ({ onCreate: createTagAlone, onRename: renameTag, onRecolor: recolorTag, onDelete: deleteTag }),
    [createTagAlone, renameTag, recolorTag, deleteTag],
  );

  const onMessageAction = useStableCallback(
    (action: MessageAction, m: EngineMessage) => {
      switch (action) {
        case "reply":
          // Inline, in place. This used to be `setReaderOpen(false); go("compose")` —
          // the message you were answering left the screen as you started answering it.
          // A TOGGLE: the same button on the same open editor closes it (see `toggleReply`).
          toggleReply(m.id);
          break;
        case "reply_all":
          // The same editor, opened over the whole audience. The bar only dispatches this
          // where `replyAllRecipients` admitted a control (see `MessagePane.ActionBar`), and
          // `sendReply` resolves that same call again for the wire. A toggle like plain Reply.
          toggleReply(m.id, true);
          break;
        case "forward":
          /**
           * THE BAR'S FORWARD, answered by the seam the panel ⋯ menus have always dispatched.
           *
           * NOT `toggleReply`-shaped, deliberately: `openForward` REFUSES a `no_forward` original
           * with a toast, and a toggle would read that refusal as "the editor is already open on
           * this message, close it" on the second press. It is also not a second implementation —
           * one open, one refusal, one scratch lane.
           */
          openForward(m.id);
          break;
        case "draft":
          /**
           * IT NOW ASKS THE DRAFTER, and it used to navigate to Compose.
           *
           * `setReaderFor(null); go("compose")` took the message off the screen and left the
           * user in an empty compose form with no draft in it and nothing having been
           * requested — `POST /messages/:id/draft` has been live for months with no caller.
           * The reply editor is opened first so the offer has somewhere to render and so the
           * price sits beside the box the text will land in; the offer spends nothing until
           * it is confirmed.
           */
          // The open KEEPS the audience an editor already holds on this message — a drafted
          // text bought for a reply-all must not silently narrow the envelope to the sender.
          openReply(m.id, replyTo === m.id && replyAll);
          draftReply.open(m.id);
          break;
        /**
         * THE THREE HORIZONS ARE TOGGLES — the way OUT of a pile: The wire has carried `state:"none"` since the
         * triage route shipped (`TriageWireState`; `TriageService.setState` accepts it) and NOTHING in the UI ever
         * dispatched it: the footer only switched piles, the ⋯ menu and ⌘K had no verb, and the key that filed a
         * message answered a re-press with a toast about being already queued. One mis-key was irreversible until
         * reply or resurface. So the verb that put a message IN a pile takes it out again — the same convention `r`
         * (reply editor) and `u` (read state) already keep, reached from the same three places at once because the
         * key, the footer button and the palette all dispatch through here. The toast states the direction each press
         * actually took.
         */
        case "later":
          if (m.triage?.state === "reply_later") {
            void engine.mutate({ kind: "triage_set", messageId: m.id, state: "none" });
            toast(t("ohbox.toastUnqueued"));
          } else {
            void engine.mutate({ kind: "triage_set", messageId: m.id, state: "reply_later" });
            toast(t("ohbox.toastQueued"));
          }
          break;
        case "aside":
          if (m.triage?.state === "set_aside") {
            void engine.mutate({ kind: "triage_set", messageId: m.id, state: "none" });
            toast(t("ohbox.toastUnparked"));
          } else {
            void engine.mutate({ kind: "triage_set", messageId: m.id, state: "set_aside" });
            toast(t("ohbox.toastAside"));
          }
          break;
        case "unread":
          /**
           * THE READ TOGGLE'S FALLBACK ARM, and it is deliberately not the normal path.
           *
           * In the product the bar's switch presses `u` itself, so this is reached only
           * where that binding does not exist — the desktop shell, or a pane mounted with no
           * keymap provider. It goes through the same `markSeen` every other read-state path
           * in this file goes through, which is what keeps "one call site for one mutation"
           * true; what it CANNOT do from here is set `OhboxView`'s `pinnedUnread`, which is
           * exactly why the button prefers the key. See `ActionBar` in `MessagePane.tsx`.
           */
          // `!m.unread` is the DESIRED state, written the way `OhboxView.toggleUnread`
          // writes it — one expression for "flip it", not two that could drift apart.
          markSeen([m.id], !m.unread);
          break;
        case "resurface": {
          // A message already scheduled: the horizon-less verb CLEARS the booking rather than
          // silently re-dating it — the toggle rule above, and the only way to take back a
          // resurface that the popover's picker cannot offer (it has no "cancel this" row).
          if (m.triage?.state === "bubbled_up") {
            void engine.mutate({ kind: "triage_set", messageId: m.id, state: "none" });
            toast(t("ohbox.toastResurfaceCleared"));
            break;
          }
          // The horizon-less default — the keyboard's `b` and the palette. The popover on the
          // bar dispatches `resurface:<iso>` instead, handled in `default` below. TOMORROW at
          // 09:00, the picker's own first dated preset — it was next Friday, a horizon the
          // picker never offers, so the key's outcome could not be reproduced (or predicted)
          // from the control that documents the verb.
          const when = tomorrowNine(now);
          void engine.mutate({
            kind: "triage_set",
            messageId: m.id,
            state: "bubbled_up",
            bubbleUpAt: when,
          });
          toast(t("ohbox.toastResurface", { when: resurfaceLabel(when) }));
          break;
        }
        case "delete": {
          /**
           * THE DELETE VERB — a move to the provider's native \Trash, NEVER an expunge
           * (FOLDERS-SPEC.md §16.3; `packages/core/src/adapters/imap-types.ts`, the third
           * user-commanded write). Still the ONE dispatch site: the confirm strip the ⋯ menu
           * opens (`MessagePane.ActionBar`) and the Backspace/Delete keys both arrive here, so
           * there is one ceremony and one sentence however the delete was asked for.
           *
           * ── AND IT NOW CARRIES AN UNDO, WHICH IT DID NOT ────────────────────────────────
           *
           * What stood here was: "there is no un-delete on the wire, so the ask happens BEFORE
           * the act and no Undo is offered after it". The first half is still true — nothing in
           * `EngineMutation` brings a deleted row back — and the second half is what changed:
           * the press no longer dispatches, it opens a window. `delete-undo.ts` hides the row
           * at once, the toast carries Undo for `UNDO_MS`, and the mutation goes out only when
           * that window closes. An Undo inside it cancels a delete that never happened, which
           * is the only undo this wire can honour, and it is the Screener's own answer to the
           * identical fork (its endpoint has no un-decide either).
           *
           * A READER IS REFUSED BEFORE ANY OF THAT, in `refuseMove`'s exact words: a delete is
           * a folder move against mail another install is arranging, and the channel a reader's
           * decisions travel has no vocabulary for moving mail. Nothing is hidden and nothing
           * reaches the wire — see `readerMoveRefusal`.
           *
           * The reader sheet is closed on the way, and only for THIS message: the mirror still
           * holds the row for the length of the window, so `readerMessage` would otherwise keep
           * a sheet standing over mail every list has already let go of.
           */
          /* THE REFUSAL DECIDES FIRST, and the sheet closes only if the press acted. Reversed,
             a refused reader delete closed the reading sheet over the very message it had just
             declined to touch — the person is left looking at a list, told nothing moved, with
             the message they were reading gone from the screen (review finding). */
          if (deleting.remove({ id: m.id, mailboxId: m.mailboxId }) && readerFor === m.id) {
            setReaderFor(null);
          }
          break;
        }
        case "restore": {
          /**
           * RESTORE — the Trash pane's one primary verb, and `⇧⌫` there.
           *
           * ── HELD, EXACTLY AS THE DELETE IS ───────────────────────────────────────────────
           *
           * There is no un-restore on the wire (a second press would 409 `not_in_trash`, which
           * is true but is not an undo), so the only undo this wire can honour is the delayed
           * commit — the row leaves the Trash list at the press, the toast carries Undo for
           * `UNDO_MS`, and `POST /messages/:id/restore` goes out when the window closes. The
           * `restoring` window above owns all of that.
           *
           * ── AND THE PLACE IS NAMED BY THE SERVER, AFTERWARDS ─────────────────────────────
           *
           * The row's own `restoreTo` is what the LIST was rendered with, and the origin folder
           * can be deleted between the page and the press — so the place sentence is raised by
           * the window's DISPATCH, when the server has answered, rather than here. Raising it
           * here would need a second `restoreFromTrash` call at the press, which would issue the
           * request immediately and cancel the undo window with every guard still green; see
           * `restoreDispatch`. A press that never reaches the server raises no place sentence at
           * all — the window's `failed` arm says the mail is still in Trash, which is the truth.
           *
           * The reader sheet closes only if the press ACTED, which is the delete arm's own
           * ordering and for its measured reason: reversed, a refused reader restore closed the
           * sheet over the very message it had declined to touch.
           */
          if (restoring.remove({ id: m.id, mailboxId: m.mailboxId }) && readerFor === m.id) {
            setReaderFor(null);
          }
          break;
        }
        case "resurface_now":
          /**
           * "NOW" IS A STATE, NOT A DATE, and that is the only thing separating this arm from the one above it.
           * `bubbled_up` with a past `bubbleUpAt` would pin nothing until a bubble-up pass ran, and the pass is not a
           * promise this product can make at this latency — it is gated inside the worker's cycle, and a standalone
           * desktop install runs no worker at all. So the mutation asks for the state the schedule exists to reach,
           * the server writes it in one transaction, and `ohboxView.resurfaced` has the row on the next drain. No
           * `bubbleUpAt`: there is no schedule to spend.
           */
          void engine.mutate({ kind: "triage_set", messageId: m.id, state: "resurfaced" });
          toast(t("ohbox.toastResurfaceNow"));
          break;
        case "resurface_done": {
          /**
           * THE DELIBERATE RELEASE, NAMED — "Done" on a resurfaced or scheduled message. FOR A PINNED MESSAGE IT IS
           * ONE MUTATION AND IT ALREADY EXISTED: a deliberate `mark_seen` (no `via`) spends the pin in the same act
           * on both sides of the wire (`spentResurface` in the overlay, `MessageService.spendResurface` in the
           * route's transaction), stamps `lastReadAt`, and the row files at the top of "Earlier" — the choreography
           * `OhboxView.slideOut` already draws. Nothing new is dispatched for it, deliberately: a second wire verb
           * for the same release would be two writers of one fact. FOR A SCHEDULED MESSAGE (`bubbled_up`, sitting in
           * the Resurface pile) the release has an extra half: the booking is cleared FIRST (`triage_set: none` — the
           * same un-triage the horizon toggles use), then the same deliberate read files it.
           */

          /**
           * Same end state, never a new one: unscheduled, read, top of "Earlier". Skipping the clear would leave the
           * pile listing a message the reader just said they were done with.
           */
          if (m.triage?.state === "bubbled_up") {
            void engine.mutate({ kind: "triage_set", messageId: m.id, state: "none" });
          }
          markSeen([m.id], false);
          toast(t("ohbox.toastResurfaceDone"));
          break;
        }
        default: {
          // RESURFACE AT A CHOSEN INSTANT — the bar's popover feeds the day here. The wire has
          // always carried an arbitrary `bubbleUpAt`; this is the caller that fills it with
          // something other than the Friday default, and `resurfaceLabel` states whichever day
          // it is.
          if (action.startsWith("resurface:")) {
            const when = action.slice("resurface:".length);
            void engine.mutate({
              kind: "triage_set",
              messageId: m.id,
              state: "bubbled_up",
              bubbleUpAt: when,
            });
            toast(t("ohbox.toastResurface", { when: resurfaceLabel(when) }));
            break;
          }
          // `move:<view>` — the destination travels with the action. Before
          // this the whole branch was a toast reading "Demo — Move isn't wired yet.",
          // rendered on live accounts; the mutation was already on the wire.
          const view = action.slice("move:".length) as OhmailView;
          const folder = FOLDER_OF_VIEW[view];
          if (!folder || folder === m.folder) break;
          /**
           * A READER MOVES NOTHING, AND HEARS SO BEFORE ANYTHING LEAVES. This arm used to dispatch and let the server
           * refuse: the row left the list, the request was declined, the engine rolled the optimistic overlay back,
           * and the message reappeared a beat later with no sentence explaining why. The rule was already written
           * once and asked by three other callers — the Screener's own bar, the delete window, and the SELECTION's
           * move — so it is asked here in the same words, from the same helper, at the same moment: at the press,
           * before the wire. `roleRef` and not `screenerRole`: the refusal answers with the role at PRESS time, which
           * is the whole reason that ref exists.
           */
          const refusedMove = readerMoveRefusal(
            rosterRef.current,
            [m.mailboxId ?? ""],
            refusalCopy,
          );
          if (refusedMove !== null) {
            toast(refusedMove);
            break;
          }
          void fileAndRefresh(engine.mutate({ kind: "move", messageId: m.id, folder }));
          toast(t("ohbox.toastMoved", { place: PLACE_LABEL[view] ?? view }));
          break;
        }
      }
    },
  );

  /**
   * THE SAME VERBS, PRESSED FROM A STREAM CARD.
   *
   * Reads and Receipts read in the card and mount no `ReadingPane` at all, which is exactly why
   * they had no verbs; they have the Ohbox's bar now (`MessageActionBar`), and every action on
   * it means here what it means there — this delegates and invents nothing.
   *
   * The ONE thing it has to add is a place for an answer to be written. `reply` and `draft` open
   * the inline editor, and that editor renders inside a message pane; a stream has none, so
   * pressing Reply on a card would set a draft nobody can see and look like a dead button. The
   * reader sheet IS a message pane over the current message, so it is raised first and the
   * editor lands in it. Ordering does not matter — both are state setters, batched into one
   * render — but it reads in the order it happens.
   *
   * Every other action is a mutation with a toast and needs no surface, so it is passed straight
   * through and the card the reader is on stays where it is.
   *
   * `forward` is in the same list as `reply` for the same reason and not a fourth case: the inline
   * forward IS the reply dock in forward mode (`openForward`), so it needs the identical pane.
   * Left out, pressing Forward on a Reads or Receipts card would set `replyTo` with nothing
   * mounted to render it — the dead-button shape this list exists to prevent.
   */
  const onStreamAction = useStableCallback((action: MessageAction, m: EngineMessage) => {
    if (action === "reply" || action === "reply_all" || action === "forward" || action === "draft") {
      setReaderFor(m.id);
    }
    onMessageAction(action, m);
  });

  /**
   * THE SELECTION'S VERBS: The requirement: a selection must offer more than mark unseen, mark read and Escape — it
   * needs the sender's screening and its tags too. The count was exact: ⇧U and Escape, in one view. The vocabulary is
   * the ACTION BAR's, not a second one invented for bulk — the same three horizons, the same two filing verbs, the
   * same read state. Reply is the one verb that is dropped, because "reply to eleven messages" is not a thing the
   * product can mean. Everything here dispatches through the ordinary engine path, one mutation per message, and says
   * ONE sentence at the end. A per-message toast over a selection of forty is not feedback, it is a denial of service
   * on your own screen.
   */
  /**
   * THE SELECTION'S VERBS — and whether the selection SURVIVES the press.
   *
   * It returns a boolean now, and the boolean is the refusal. Every verb here used to end the
   * selection unconditionally, because every verb here used to happen; a reader's Move does
   * not, and a set cleared by a press that did nothing leaves the person to rebuild it before
   * they can try the verb that would have worked. `true` ⇒ dispatched, clear the pick;
   * `false` ⇒ refused at the press, keep it. The Ohbox reads exactly that.
   *
   * ── A READER IS REFUSED HERE, BEFORE THE WIRE, AND ONCE ─────────────────────────────────
   *
   * `move:*` used to dispatch one `move` per message with no role check at all: the rows left
   * the list, the server refused each of them, and they came back — a rollback per message,
   * after the fact, for a decision the client could have answered instantly. The rule already
   * existed one module over (`readerMoveRefusal`, which `screener-state.ts#refuseMove` and the
   * delete window both ask), so this asks it too: ONE toast, nothing dispatched, the pick kept.
   *
   * WHICH VERBS. Filing verbs only — `move:*` here, `screen` in `onBulkScreen`, `delete`
   * through the window's own `refusal`. Read, Unread, Tag and the three horizons are NOT folder
   * moves and are not refused: a reader "reads, searches, marks read and sends"
   * (`screener.moveBarWhy`), and refusing those would withhold presses that work.
   */
  const onBulkAction = useStableCallback(
    (action: BulkAction, ids: string[]): boolean => {
      if (ids.length === 0) return false;
      if (action === "delete") {
        /* ONE WINDOW, ONE TOAST, ONE UNDO FOR THE SET — `delete-undo.ts` keyed by press. The
           reader refusal is the window's own (`refusal`, resolved at the press), so this arm
           does not repeat it: two spellings of one verdict is the drift that helper exists to
           end. The ASK — the confirm strip for `d` and the menu item, nothing for ⌫/⌦ — has
           already happened in the view; the window is still the only dispatch site. */
        return deleting.remove(
          ids.map((id) => ({ id, mailboxId: reader.get<EngineMessage>("message", id)?.mailboxId })),
        );
      }
      if (action === "read" || action === "unread") {
        // The batch mutation, unchanged: one request, one transaction, one intent.
        markSeen(ids, action === "unread");
        toast(
          t(action === "unread" ? "ohbox.toastBulkUnread" : "ohbox.toastBulkRead", {
            count: ids.length,
          }),
        );
        return true;
      }
      if (action === "later" || action === "aside" || action === "resurface") {
        const state = action === "later" ? "reply_later" : action === "aside" ? "set_aside" : "bubbled_up";
        // The same default the single-message verb uses — the picker's first dated preset.
        const when = action === "resurface" ? tomorrowNine(now) : null;
        for (const messageId of ids) {
          void engine.mutate({
            kind: "triage_set",
            messageId,
            state,
            ...(when ? { bubbleUpAt: when } : {}),
          });
        }
        toast(
          action === "resurface"
            ? t("ohbox.toastBulkResurface", { count: ids.length, when: resurfaceLabel(when!) })
            : t(action === "later" ? "ohbox.toastBulkLater" : "ohbox.toastBulkAside", {
                count: ids.length,
              }),
        );
        return true;
      }
      // A READER MOVES NOTHING, and hears so before anything leaves — asked of EVERY mailbox
      // this selection spans, through the three-state roster. The WHOLE press is refused.
      const refused = readerMoveRefusal(rosterRef.current, mailboxesOf(ids), refusalCopy);
      if (refused !== null) {
        toast(refused);
        return false;
      }
      // `move:<view>` — the destination travels with the action, exactly as it does for one
      // message. A message already in the destination is not re-moved: the count in
      // the toast is what CHANGED, which is the only count worth reporting.
      const view = action.slice("move:".length) as OhmailView;
      const folder = FOLDER_OF_VIEW[view];
      let moved = 0;
      for (const messageId of ids) {
        const m = reader.get<EngineMessage>("message", messageId);
        if (!m || m.folder === folder) continue;
        void fileAndRefresh(engine.mutate({ kind: "move", messageId, folder }));
        moved++;
      }
      toast(t("ohbox.toastBulkMoved", { count: moved, place: PLACE_LABEL[view] ?? view }));
      return true;
    },
  );

  /**
   * THE BULK SCREENING PLAN — grouped by SENDER, because that is what screening is about. A screener decision is not
   * a per-message action, and a selection routinely mixes the two cases the single-sender path already distinguishes:
   * a sender still WAITING is decided through `POST /screener/:id`, which promotes a **rule that governs all their
   * future mail**; a sender whose mail has left the Screener is a composition of `move`s with no lasting effect at
   * all. Ten messages from six senders, two of them waiting, is two permanent consent records and four one-off moves
   * — and a naive bulk apply would report "10 messages moved" and never mention the two. So this returns the counts
   * SEPARATELY and the surface states them before committing.
   */

  /**
   * `planScreeningChange` per sender, never a bulk shortcut: forty senders decided through a path that skips
   * `screener_decide` would fork the consent record from the one `screener-service.decide` writes. NOTE THE COUNT
   * THIS DELIBERATELY REPORTS. The plan moves every message the mirror holds from that sender, not only the ones that
   * were picked — that IS what screening a sender means, and it is precisely why the number has to be on screen
   * before the button commits.
   */
  const planBulkScreening = useStableCallback((ids: string[], dest: ScreeningDest) => {
    const seen = new Set<string>();
    const plans: EngineMutation[] = [];
    let senders = 0;
    let messages = 0;
    let rules = 0;
    for (const id of ids) {
      const s = senderScreening(reader, id);
      if (!s || seen.has(s.key)) continue;
      seen.add(s.key);
      /**
       * `makeRule: false`, EXPLICITLY. The single-sender sheet makes a rule by
       * default; bulk does not, and the reason is its own confirm copy — `bulkConfirm`
       * promises *"No rule is made, so future mail is unchanged"* and `bulkConfirmRules`
       * counts only the senders the SCREENER will rule on. Letting the default through here
       * would have made both sentences false for up to forty senders at once, silently, and
       * would have claimed rules whose outcome this path does not await. Owed, not dropped:
       * bulk rule-creation needs its own confirm copy and its own three-outcome reporting.
       */
      const plan = planScreeningChange(s, dest, "sender", false);
      if (plan.mutations.length === 0) continue;
      senders++;
      messages += plan.moved;
      if (plan.rule) rules++;
      plans.push(...plan.mutations);
    }
    return { senders, messages, rules, mutations: plans };
  });

  const onBulkScreen = useStableCallback(
    (ids: string[], dest: ScreeningDest): boolean => {
      /* SCREENING A SET IS FILING IT, so it answers a reader the way every other filing verb
         does — at the press, once, with nothing dispatched and the selection kept. The
         sentence is `readerMoveRefusal`'s, the same one the Move arm, the delete window and
         the Screener's own bar use. The confirm row is BEHIND this: a reader never reaches a
         ceremony whose commit cannot happen. */
      const refused = readerMoveRefusal(rosterRef.current, mailboxesOf(ids), refusalCopy);
      if (refused !== null) {
        toast(refused);
        return false;
      }
      const plan = planBulkScreening(ids, dest);
      const place = PLACE_LABEL[dest] ?? dest;
      if (plan.mutations.length === 0) {
        toast(t("screening.toastBulkNothing", { place }));
        return true;
      }
      for (const m of plan.mutations) void engine.mutate(m);
      // Two sentences because there are two outcomes, and the second one is permanent. The
      // single-sender path already says which happened; this keeps that vocabulary and adds
      // the only thing bulk introduces — that a selection can contain both.
      toast(
        plan.rules > 0
          ? t("screening.toastBulkRuled", {
              place,
              senders: plan.senders,
              count: plan.messages,
              rules: plan.rules,
            })
          : t("screening.toastBulkMoved", {
              place,
              senders: plan.senders,
              count: plan.messages,
            }),
      );
      return true;
    },
  );

  /** Tag a whole selection: the shell's picker, pointed at a set. See `pickerIds`. */
  const openBulkTagPicker = useStableCallback((ids: string[], anchor: HTMLElement | null) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
    setPicker({ forId: ids[0]!, ...placePicker(anchor) });
  });

  /**
   * The four callbacks the bulk bar takes, as one stable object.
   *
   * `screenPreview` deliberately drops the mutation list `planBulkScreening` also returns:
   * the confirm row renders on every keystroke of a re-render and must not be able to
   * dispatch anything. Committing is `screen`, which recomputes from the same function — so
   * the numbers on screen and the mutations that run come from one derivation, and a
   * selection that changed between the two cannot commit a plan nobody was shown.
   */
  const bulkVerbs = useMemo(
    () => ({
      run: onBulkAction,
      tag: openBulkTagPicker,
      screenPreview: (ids: string[], dest: ScreeningDest) => {
        const { senders, messages, rules } = planBulkScreening(ids, dest);
        return { senders, messages, rules };
      },
      screen: onBulkScreen,
    }),
    [onBulkAction, openBulkTagPicker, planBulkScreening, onBulkScreen],
  );

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
   * OPEN IT WHERE IT LIVES — the one answer, finished.
   *
   * Reported as "search does not allow a message to be opened; it should open the message
   * where it lives". The literal claim was wrong — a `SearchHit` is a real `<button>` and has
   * always called this. What was wrong is everything AFTER the routing
   * decision, and it is the same seam in every arm: this function set a view and a cursor
   * and then stopped, so on three of the five destinations the user arrived at a list and
   * had to find the thing they had just clicked, and on the fourth they arrived at a pane
   * that is `display:none` at their screen width.
   *
   *   · **ohbox** — the split pane IS the open, so the cursor is enough… on a desktop. Under
   *     900px the reading column is hidden, so the reader sheet is what "opened" means
   *     there, exactly as `OhboxView`'s own tap handler already decided.
   *   · **reads / receipts** — cursor plus a `jump`, which extends the mounted run through the
   *     card, anchors the stream on it and OPENS it (`ReadsView`, `StreamShell.scrollTo`). These
   *     piles open in place, and "open" here is the card expanded with its verbs up — a card the
   *     stream merely scrolled near is not the message the reader clicked.
   *   · **screener / screened / spam** — now SELECTS THE SENDER as well as navigating. The
   *     segment alone was the misroute the ruling named third: a consent surface that drops
   *     you at a queue of strangers when you asked about one of them. Reached whenever the
   *     PRESENTATION is the Screener, which is not the same set as "physically in a Screener
   *     folder" — an undecided sender's INBOX mail lands here, which is the whole of the
   *     presentation fix (`openTargetFor`). A hit whose sender the queue holds NO row for is
   *     routed to the reader instead of a rowless queue — see `openTargetFor`.
   *   · **History, or a folder this client has no view for** — the reader, over wherever you
   *     are. History is now a REACHABLE case, not just the defensive one: a dormant-undecided
   *     message presents in History (`placeOf` is `null`), belongs to no pile, and so opens in
   *     the reader exactly as HistoryView's own row does. The defensive half remains — `Folder`
   *     is a closed union and `VIEW_OF_FOLDER` is total, so an unknown folder cannot reach here
   *     from the wire — and its answer is the same: the message itself.
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
  /* Assigned here so `openDraft`, which is declared several hundred lines above this, can open a
     reply draft in its own conversation. See {@link openMessageRef}. */
  openMessageRef.current = openMessage;

  /**
   * ═══ THE OPEN MESSAGE LIVES IN THE URL ════════════════════════════════════════════════════
   *
   * `#/<view>/m/<id>` (`Route.messageId`): the bar claims the reading on screen, so a RELOAD
   * restores it, Back walks out of it, and a copied link hands somebody the exact message.
   * Before this, a reload booted to the bare view and the open message was simply gone — the
   * URL knew the place and not the reading.
   *
   * ONE EFFECT, ARBITRATED BY WHO MOVED. The route and the open state mirror each other, and a
   * two-way mirror with two writers is a loop; the refs below remember the last agreed pair, so
   * each run knows which side changed and lets THAT side win:
   *
   *   · the ROUTE moved (Back/Forward, a typed link, a reload) → apply it to the open state —
   *     the Ohbox selection (plus the sheet at a narrow width, the same rule `openMessage`'s
   *     ohbox arm applies), a stream's cursor-with-jump, or the reader overlay for every other
   *     view. An id the mirror does not hold yet WAITS (the effect re-runs per delta) — a
   *     reload restores before the boot drain finishes filling the mirror — and an id the
   *     mirror never produces (another account's message, a deleted row) drops out of the bar
   *     once the mail state settles, rather than erroring or restoring somebody else's reading.
   *   · the STATE moved (a click, j/k, an open, a close) → reflect it into the bar
   *     (`reflectMessage`): an OPEN pushes, so history walks readings; a move between messages
   *     or a close REPLACES, so a `j`-walk does not bury the view under fifty entries.
   *
   * WHAT RESTORING DOES NOT DO: arm a read. The restore sets the selection and the surfaces;
   * it never calls the view's `open`, so nothing is marked read by arriving — reloading IS a
   * leave-and-revisit, the departure's own commit (`pagehide`) already spent the last reading,
   * and the restored message re-arms only the way any on-screen message does (the dwell, or an
   * explicit open). The session-order lease starts fresh, exactly as any reload starts it.
   *
   * WHAT THE BAR MIRRORS, deliberately narrow: the reader overlay on any message view, and the
   * Ohbox's own selection (at a split width the column IS the open). A stream's expanded card
   * is a scroll posture, not shell state, so in-place stream reading does not rewrite the URL —
   * but a stream deep link RESTORES through the same cursor-plus-jump a search arrival uses.
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
      // against a boot the drain is still filling): WAIT, unagreed, so the `version` dep
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
  }, [route.messageId, route.view, readerFor, ohboxSel, version, mailState.settled, pileHolds, reader]);

  /**
   * ═══ LOCATE THE ROW, IN WHICHEVER VIEW IT LANDED ══════════════════════════════════════
   *
   * ── WHY THIS IS ONE DOM EFFECT AND NOT FOUR PROPS ─────────────────────────────────────
   *
   * A search hit can land in four view shapes — the Ohbox's split pane, the two skim streams,
   * and the Screener's sender queue — and threading a `locatedId` through all four would be
   * four props, four effects and four chances for the fifth view to be added without one.
   *
   * All four already agree on a contract this can use instead: every row is
   * `.row[data-id="<id>"]`, and each view already finds its own cursor that way to scroll it
   * (`ReadsView`, `ReceiptsView`, `ScreenerView`) or to anchor the screening popover
   * (`OhboxView`, and `AppShell`'s own `s` binding). This is a fifth reader of an established
   * selector, not a new coupling — and it means a view added later is located correctly
   * without being taught anything.
   *
   * ── WHY IT RETRIES ────────────────────────────────────────────────────────────────────
   *
   * `openMessage` sets the cursor and CHANGES THE ROUTE in the same gesture. The destination
   * view has not mounted when this effect first runs, so a single query would miss every time
   * — the row appears a frame or two later, after the hash change, the route effect and the
   * view's own render. It re-tries on animation frames for a short bounded window and then
   * gives up rather than looping: a hit whose row never appears is a message that is no longer
   * in that pile, and flashing nothing is the honest outcome.
   *
   * The class is removed on a timer AND on unmount, so leaving the view mid-flash cannot
   * leave a row permanently marked.
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
   * DOES THE LOCAL MIRROR HOLD THIS ROW? — one definition, two consumers. The reader can show rows the mirror
   * deliberately does not hold: an archive-only hit opened from Search reaches past it. A verb whose implementation
   * reads the local row must then be withheld rather than offered and guaranteed to fail — Delete (`message_delete`
   * acts on a local row) and Forward (`openForward` reads the message out of the engine and returns silently when it
   * is absent) both need exactly this question answered. Declared here rather than inline in the chrome because
   * `⇧F`'s binding needs it too, and two spellings of "is this row in the mirror" is how the key and the button come
   * to disagree — the same one-derivation rule `canSend` and `replyAllRecipients` are held to.
   */
  const mirrorHolds = useStableCallback((id: string): boolean => reader.get<EngineMessage>("message", id) != null);

  /* A half-open destination strip must not carry over when the cursor moves — the same rule
     the pane enforced per mount while it owned the state (see `useBarPanel`). */
  const focusedId = focused?.id ?? null;
  useEffect(() => setBarPanel(null), [focusedId]);

  /**
   * PUT THE CURSOR ON THE FIRST ROW — the first press of a message verb on a list that has rows
   * and no cursor on any of them. See `keymap.tsx#DisabledReason` for the dispatcher's half.
   *
   * ── WHY A PRESS AND NOT AN ARRIVAL ──────────────────────────────────────────────────────────
   *
   * `selectedOhbox` above records what happened the last time a list opened with a cursor already
   * on something: `?? allOhbox[0]` meant an Ohbox nobody had touched reported its newest unread as
   * "the open one", which fetched a body from the user's own server and put somebody's mail in the
   * reading column on arrival. ⌫ is that hazard with a delete on the end of it — a key whose first
   * press files the top message because a list happened to be under it. So nothing is placed until
   * somebody presses something, and the press that places performs nothing.
   *
   * ── AND WHY IT ANSWERS `false` MORE OFTEN THAN IT LOOKS ─────────────────────────────────────
   *
   * Three views, the three whose cursor this shell holds, and the SAME three `focused` reads —
   * anything else and the ring would land on a row the pressed verb does not act on. `route.view`
   * and not `effectiveView`, again because that is what `focused` reads: a `tag` route with no
   * group renders the Ohbox while `focused` stays null, and placing an Ohbox cursor for a verb
   * that would act on nothing is the one outcome worth refusing.
   *
   * The DOM row is read because the scroll needs the element, and the null-check that comes with
   * it earns its keep twice: it is what a click would have hit, so this stays on the click's own
   * path, and it is `null` for a surface that holds a list in state without rendering it (the
   * seed screen owes a first run over a mirror that may already carry rows). A `false` consumes
   * nothing: the keypress stays exactly as inert as it was, which is what an empty list should
   * feel like.
   */
  const placeCursor = useStableCallback((label: string): boolean => {
    if (focused != null) return false;
    const first =
      route.view === "ohbox"
        ? (allOhbox[0] ?? null)
        : route.view === "reads"
          ? (partition.fresh[0] ?? partition.seen[0] ?? null)
          : route.view === "receipts"
            ? (receipts[0] ?? null)
            : null;
    if (first == null) return false;
    const row = document.querySelector<HTMLElement>(`.view .row[data-id="${CSS.escape(first.id)}"]`);
    if (row == null) return false;
    if (route.view === "ohbox") setOhboxSel(first.id);
    else if (route.view === "reads") setReadsCur(first.id);
    else setReceiptsCur(first.id);
    /* The same nudge a click's selection gets — `block: "nearest"`, the whole list's convention
       (`ReadsView`, `ReceiptsView`, `TriageView`). Optional-chained on the METHOD, not the node:
       jsdom mounts these views without implementing it (`RulesView`'s precedent). */
    row.scrollIntoView?.({ block: "nearest" });
    /* ONE LINE, THE VERB THE NEXT PRESS RUNS, and the toast primitive's own live region announces
       it (`role="status" aria-live="polite"`). No action button: there is nothing to undo about a
       cursor, and an Undo beside it would read as "put the mail back". Focus does not move — the
       person is already on the keyboard, and `.row.sel` is the ring the list already draws. */
    toast(t("cursor.placed", { label }), { duration: CURSOR_HINT_MS });
    return true;
  });
  useCursorPlacer(placeCursor);


  /**
   * ESCAPE HAS ONE OWNER, and this ORDERED LIST is it.
   *
   * Before the registry, Escape was handled by `Reader` (close), `AppShell` (the (i)
   * panel), `OhboxView` (clear the selection), `ScreenerView` (leave the mobile preview)
   * and the palette input — five listeners with no agreed order, which is why the reply
   * editor could not simply add a sixth. `Reader` now takes `closeOnEscape={false}` and
   * this closes the innermost thing that is open.
   *
   * ── IT USED TO BE TWO LISTS, AND THAT WAS THE BUG UNDERNEATH ───────────────────────
   *
   * An `if/else if` cascade decided WHAT Escape closes, and a parallel boolean expression
   * beside it decided WHETHER Escape was live at all. Two enumerations of the same eight
   * overlays, and every new overlay had to be added to both — a drift the type system
   * cannot see, in the binding whose whole job is precedence. One array now answers both
   * questions: `find` gives the innermost open overlay, and its absence IS "nothing is
   * open". Adding an overlay is one line in one place, and forgetting it makes Escape
   * inert for that overlay, which is visible on first use rather than subtly wrong.
   *
   * Order is innermost-first and is the list's own order — the palette sits over the sheet,
   * which sits over a popover, which sits over the reader.
   *
   * ── AND IT IS NOT THE DESTRUCTIVE-KEY GATE, WHICH IT BRIEFLY WAS ───────────────────
   *
   * Backspace/Delete read this array for one revision, on the reasoning that the one list
   * of what Escape closes is the one list of what is open. The premise was false: this
   * enumerates the overlays THE SHELL OWNS, and first run was never in it (Escape is not
   * how you leave first run) while a message More menu CANNOT be — its open state lives
   * inside the component, below the shell. Both were reachable: Delete fired under them.
   * The gate asks the DOM instead (`modal-gate.ts#isModalOpen`), which is the only form of
   * the question a surface added later answers without anybody editing a list. This array
   * is Escape's, and only Escape's.
   */
  const escapeLayers: Array<[open: boolean, close: () => void]> = [
    [palette.open, palette.closePalette],
    [shortcutsOpen, () => setShortcutsOpen(false)],
    // Above the popover: the audit panel is opened FROM the sheet and replaces it, so it is
    // the innermost thing on screen whenever it exists.
    [senderAudit != null, () => setSenderAudit(null)],
    // Above the sender popover for the same reason the audit panel is: the subject sheet is opened
    // FROM it and replaces it, so whenever both flags could be true the subject sheet is the thing
    // on screen. (It closes the popover on open, so in practice they are never both set — the
    // ordering is here so that stays a property of this list rather than of one callback.)
    [subjectRule != null, () => setSubjectRule(null)],
    [senderMenu != null, () => setSenderMenu(null)],
    [picker != null, () => setPicker(null)],
    [fr != null, () => setFr(null)],
    // The 390px navigation drawer. It sits over the deck and intercepts every press until it
    // is dismissed, so while it is open it is the innermost thing a keyboard user is looking
    // at that is not one of the anchored popovers above — Escape closed everything else in
    // this list and left exactly this one standing (the backdrop tap was the only way out).
    [railOpen, () => setRailOpen(false)],
    // The action bar's open destination strip (Move / Resurface / the delete confirm). Above
    // the reply editor and the reader because it stands OVER the bar inside them — a strip
    // opened by `m` or `d` is the innermost question on screen, and Escape answering it must
    // not close the editor or the sheet underneath instead.
    [barPanel != null, () => setBarPanel(null)],
    [replyTo != null, () => setReplyTo(null)],
    [readerFor != null, () => setReaderFor(null)],
  ];
  const closeInnermost = escapeLayers.find(([open]) => open)?.[1] ?? null;

  /**
   * AN OPEN OVERLAY OWNS ESCAPE WHILE IT IS OPEN.
   *
   * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
   *
   * The Ohbox's "clear the selection" is a VIEW binding and Escape's cascade was a GLOBAL
   * one, so a picked set outranked the cascade UNCONDITIONALLY: with two rows selected,
   * Escape cleared the selection instead of closing the `?` sheet, the ⌘K palette or the
   * screening popover the user was actually looking at. It had been patched once, for the
   * reply editor only, by teaching the Ohbox's binding to stand down when
   * `chrome.replyTo != null` — a predicate in a view, naming one shell overlay out of
   * eight. That is the shape that rots: the view cannot see the other seven, and the next
   * overlay added would not be in the condition either.
   *
   * ── THE RULE ───────────────────────────────────────────────────────────────────────
   *
   * A third scope, ABOVE view layers (`keymap.tsx`), holding exactly one binding: Escape,
   * live only while something is open. So the precedence is stated as what it actually is
   * — an open overlay is inner to a selection — instead of being re-derived per case:
   *
   *   · nothing open  ⇒ this is disabled, the registry falls through to the view layer,
   *                     and Escape clears the selection exactly as before;
   *   · anything open ⇒ this wins over every view binding there will ever be, closes the
   *                     innermost overlay, and the selection survives untouched.
   *
   * It cannot rot the way the per-case predicate did, because no view names an overlay any
   * more and this binding names none either: it is gated by `escapeLayers` above, the same
   * single list that decides what Escape closes. An overlay that Escape can close is
   * therefore an overlay that outranks a selection, by construction and not by memory.
   */
  useKeyBindings(
    [
      {
        chord: "Escape",
        group: "app",
        label: t("shortcuts.escape"),
        inInput: true,
        disabled: closeInnermost == null,
        run: () => closeInnermost?.(),
      },
    ],
    "overlay",
  );

  /**
   * THE LAYOUT CYCLE — `w` flips classic ⇄ Zero (OHMARCHY-PLAN §3b), registered like every other chord so the `?`
   * sheet and the palette document it from the one registry. FACE-INDEPENDENT, BY DECISION (lane E close-out): layout
   * is the contract's own second axis, orthogonal to the face by construction — the zero stylesheet speaks only in
   * tokens, so paper resolves the same arrangement through its calm values — and §4's acceptance criterion runs the
   * keyboard walkthrough in BOTH layouts, which would be a test of a hidden state under a face gate. The DEFAULT
   * stays classic on every face and every platform; zero is only ever this device's explicit choice (`ohmail.layout`
   * — the contract gives layout no account wire, and none is added here).
   */
  const cycleLayout = useStableCallback(() => {
    theme.setLayout(theme.layout === "zero" ? "classic" : "zero");
  });

  /**
   * The Zero drawer summon (zone-nav's module seam): under zero the sub-900px rail is a
   * docked icon ribbon (off canvas under 392px), and `h`/← toward it means "summon the full
   * drawer" — §12's one meaning for `h`; the ribbon itself never auto-floats. Registered
   * ONLY while zero is active, so classic's keyboard behavior does not move.
   */
  useEffect(() => {
    if (theme.layout !== "zero") return;
    setRailSummon(() => setRailOpen(true));
    return () => setRailSummon(null);
  }, [theme.layout]);

  /**
   * THE LAYOUT-CYCLE RECONCILE (review finding, round 1). The narrow-only surfaces — the reader
   * sheet and the Screener's full preview — exist because the column they duplicate is off
   * screen; a layout change that BRINGS the column back would otherwise leave them standing
   * fixed over the very split they duplicate (the double-render defect `enterReader`'s one
   * gate exists to prevent). Asked with the NEW layout's own answer
   * (`readColumnHiddenFor`), because the attribute stamp lands in the provider's effect,
   * which runs after this one.
   *
   * ON THE TRANSITION ONLY (review finding, round 2): a sheet can stand at a WIDE width by
   * design — `openMessage` raises it for a message no standing column can show (an
   * archive-only search hit, a parked message from History) — and a wide→wide cycle must
   * not take the only visible copy of a message away. So the clear fires exactly when this
   * cycle turns a hidden column into a standing one; every other direction is left as a
   * window resize across the breakpoint leaves it.
   *
   * BOTH ANSWERS AT THE CURRENT WIDTH (review finding, round 3). What is remembered across
   * cycles is the previous LAYOUT, never its answer: this effect only re-runs when the
   * layout changes, so a remembered boolean describes the viewport as it was at the last
   * cycle, and any resize since makes it a lie. The measured hole: mount classic at 1280
   * (column standing → `false` remembered), resize to 800 where classic hides the column
   * and a reader sheet legitimately opens, then press `w` — Zero at 800 stands both tiles,
   * so the new answer is "standing", but the stale `false` reads the cycle as standing→
   * standing and skips the clear, leaving the sheet fixed over the very column it
   * duplicates. Asking `readColumnHiddenFor` for BOTH layouts here evaluates both against
   * the width the visitor is actually at (the function matches its media query at call
   * time), which makes the comparison a question about the layouts alone and removes the
   * time dependency that produced the bug.
   */
  const prevCycleLayout = useRef<"classic" | "zero" | null>(null);
  useEffect(() => {
    const before = prevCycleLayout.current;
    prevCycleLayout.current = theme.layout;
    if (before === null || before === theme.layout) return;
    if (readColumnHiddenFor(before) && !readColumnHiddenFor(theme.layout)) {
      setReaderFor(null);
      setScreenerFull(false);
    }
  }, [theme.layout]);

  /**
   * The Zero PUSH TIER, subscribed (review finding, round 2): the sheet's ARIA claim and the
   * lateral-exit gate below both follow this fact, and a render-time read goes stale when
   * `w` restamps the layout with the sheet still open, or a resize crosses 391/392.
   */
  const [pushTier, setPushTier] = useState(false);
  useEffect(() => {
    setPushTier(zeroPushTier());
    return watchZeroPushTier(setPushTier);
  }, []);

  /**
   * FOCUS LEAVES THE DRAWER WITH THE DRAWER (review finding, round 2): a summoned drawer can
   * hold real focus, and closing it (Escape, scrim, ≡) merely translates the rail off
   * canvas — focus would stay in invisible navigation and the zone would keep reporting
   * "rail". The selected row is where the walk came from; failing that, a blur releases
   * focus to the body, which IS the list zone by derivation.
   */
  const prevRailOpen = useRef(railOpen);
  useEffect(() => {
    const was = prevRailOpen.current;
    prevRailOpen.current = railOpen;
    if (!was || railOpen) return;
    const rail = document.querySelector(".rail");
    const el = document.activeElement;
    if (rail && el instanceof HTMLElement && rail.contains(el)) {
      const row = document.querySelector<HTMLElement>(".view .row.sel");
      if (row) row.focus();
      else el.blur();
    }
  }, [railOpen]);

  /* The Zero sheet's lateral-exit gate: the PUSH tier only (review finding, round 2) — at
     the floating tier (≤391) Zero stands on classic's full-screen modal, whose one exit is
     Escape. `pushTier` is the subscribed fact above, so the gate follows `w` and resizes. */
  const zeroSheetUp = pushTier && readerFor != null;

  /**
   * NO CURSOR IS ITS OWN REASON — spread into every `message` binding below whose `disabled` begins `focused ==
   * null`. See `keymap.tsx#DisabledReason` and `placeCursor` above. EMPTY when a cursor exists, so a verb resting for
   * its own reason keeps falling through: `⇧R` on a message with nobody else on it, `⇧F` on a `no_forward` one or a
   * row the mirror does not hold, `d` with the folders foundation off. Placing a cursor for one of those would show a
   * sentence promising a second press that cannot work. NOT on `f`, `mod+Enter` or the two Zero exits: none of them
   * rests on a cursor (an empty Answer Later pile, no run in flight, no reply open, no sheet up), and `p` is an `app`
   * verb — the dispatcher's rule is scoped to `message` for exactly that reason.
   */
  const noCursor = focused == null ? ({ disabledReason: "no_cursor" } as const) : {};

  /* ── the global key map. Views declare their own; see `keymap.tsx` for precedence. ── */
  const globalKeys: KeyBinding[] = [
    { chord: "g o", group: "navigate", label: t("shortcuts.goOhbox"), run: () => go("ohbox") },
    { chord: "g r", group: "navigate", label: t("shortcuts.goReads"), run: () => go("reads") },
    { chord: "g e", group: "navigate", label: t("shortcuts.goReceipts"), run: () => go("receipts") },
    { chord: "g s", group: "navigate", label: t("shortcuts.goScreener"), run: () => go("screener") },
    /* ── THE REST OF THE `g` LEADER (the ohmarchy keymap, Phase 1) ──────────────────────
       The prototype's grammar reaches every place through `g`; the shipping leader stopped
       at five. The three triage horizons take the pile's own initial (Later / Parked /
       resurface-Back — the prototype's letters), and the three app places take theirs
       (`g ,` for Settings is the editor convention the prototype adopted). Two prototype
       rows are deliberately NOT here: `g c` said Receipts, but `g e` shipped first and c
       is Compose everywhere else in the app — the shipping key wins; and `g /` duplicated
       `/`, which is already global — a second spelling would be sheet noise, not grammar. */
    { chord: "g l", group: "navigate", label: t("shortcuts.goLater"), run: () => goTriage("reply") },
    { chord: "g p", group: "navigate", label: t("shortcuts.goParked"), run: () => goTriage("aside") },
    { chord: "g b", group: "navigate", label: t("shortcuts.goResurface"), run: () => goTriage("resurface") },
    { chord: "g d", group: "navigate", label: t("shortcuts.goDrafts"), run: () => go("drafts") },
    { chord: "g h", group: "navigate", label: t("shortcuts.goHistory"), run: () => go("history") },
    /* `g t` — the destination-row rule: ONE message for the chord, the palette row and the `?`
       sheet, so the three lists of the same instruction cannot drift by a word. `disabled` where
       the client has no Trash transport (the demo), which keeps the sheet LISTING it — "a
       shortcut that vanishes from the documentation when the list is empty is a shortcut nobody
       learns" — with the reason on the row. */
    {
      chord: "g t",
      group: "navigate",
      label: t("shortcuts.goTrash"),
      disabled: !engine.trashAvailable(),
      disabledReason: "trash_unavailable",
      run: () => go("trash"),
    },
    { chord: "g ,", group: "navigate", label: t("shortcuts.goSettings"), run: () => go("settings") },
    { chord: "/", group: "navigate", label: t("shortcuts.search"), run: () => go("search") },
    {
      /* Pull new mail — the doorbell's own verb, from the keyboard. The SAME single-flight
         `pull` the two PullNewMail buttons press, so the latch, the settle watch and the
         honest toast apply identically; `available` is the binding's own gate (demo and
         cloudless builds render no doorbell, and the key disappears with the button). */
      chord: "p",
      group: "app",
      label: t("shortcuts.pull"),
      disabled: !pullBinding.available || pullBinding.pulling,
      run: () => pullBinding.pull(),
    },
    { chord: "c", group: "app", label: t("shortcuts.compose"), run: () => go("compose") },
    {
      chord: "f",
      group: "message",
      label: t("shortcuts.replyRun"),
      disabled: piles.replyLater.length === 0,
      run: () => {
        setFrPending(true);
        go("triage");
      },
    },
    {
      chord: "r",
      group: "message",
      label: t("shortcuts.reply"),
      /**
       * LIVE WHEREVER THE PILL THAT ADVERTISES IT IS — which is `focused`'s whole contract. This was `route.view !==
       * "ohbox" || selectedOhbox == null`, so a message opened out of Search rendered a Reply pill printing `r` (the
       * pill reads this registry, and a disabled binding still owns its chord) over a key that did nothing. The
       * reader sheet IS a message pane; a verb pressed while it is open acts on the message being read — the rule
       * `focused` already states. On the two skim streams the key takes the card button's own path
       * (`onStreamAction`), which raises the reader first so the editor has a pane to land in. A TOGGLE, as before:
       * `r` on the open editor closes it.
       */
      disabled: focused == null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        if (readerMessage != null || route.view === "ohbox") toggleReply(focused.id);
        else onStreamAction("reply", focused);
      },
    },
    {
      // `shift+r` — the shifted variant of the verb it widens, the convention `shift+u`
      // already set. Inert wherever `r` is, and ADDITIONALLY on a message whose audience is
      // the sender alone: `replyAllRecipients` is the bar's own visibility predicate, so the
      // key and the button appear and disappear together.
      chord: "shift+r",
      group: "message",
      label: t("shortcuts.replyAll"),
      disabled: focused == null || replyAllRecipients(focused, ownAddresses) === null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        if (readerMessage != null || route.view === "ohbox") toggleReply(focused.id, true);
        else onStreamAction("reply_all", focused);
      },
    },
    {
      /**
       * FORWARD — `⇧F`, and NOT the `f` a mail client usually gives it.
       *
       * `f` is taken, by the Reply Run over the Answer Later pile (declared above, and again in
       * `TriageView`), and moving a shipped chord to make room for a new one is the more expensive
       * change of the two. `⇧F` is the shifted variant of a bare letter that already means
       * something adjacent, which is the convention `⇧R` (reply all) and `⇧U` set — so it reads as
       * "the other thing F does" rather than as an arbitrary pick, and the `?` sheet prints it
       * beside `r` and `⇧R` in the same `message` group.
       *
       * Its `disabled` carries the SAME TWO predicates the bar's button does
       * (`MessagePane.ActionBar#canForward`) — `sensitivity.no_forward`, which the send path
       * answers with a 403, and the mirror, because `openForward` below reads the row out of the
       * engine and returns silently when it is absent. So the key and the control appear and
       * disappear together: the discipline `⇧R` keeps against `replyAllRecipients`, and the reason
       * the pill's keycap can be generated from this registry rather than typed at the call site.
       *
       * NOT a toggle — see `openForward`, which answers a refused message with a toast that a
       * second-press-closes verb would swallow.
       *
       * ── WHERE IT IS LIVE, AND WHERE IT IS NOT ────────────────────────────────────────────
       *
       * `focused` is the reader (over any view), the Ohbox, Reads and Receipts. On a WIDE split in
       * Triage, Folder, Tag or History the message on screen is that view's own local cursor,
       * which the shell cannot see — so this binding is inert there while the pill still prints
       * the keycap. That is not specific to Forward: `r`, `⇧R`, `a`, `e`, `b`, `s`, `t`, `m` and
       * `d` are all inert on those three of the four views for the same reason, and `TriageView`
       * is the one that already fixes it by declaring its own bindings over `shown` ("views
       * declare their own"). Forward joins that list THERE rather than adding a fourth silent
       * chord; Folder, Tag and History declare no message verbs at all, which is a pre-existing
       * gap across every verb and not this one's to close.
       */
      chord: "shift+f",
      group: "message",
      label: t("shortcuts.forward"),
      disabled:
        focused == null ||
        focused.sensitivity?.no_forward === true ||
        mirrorHolds(focused.id) === false,
      ...noCursor,
      run: () => {
        if (!focused) return;
        if (readerMessage != null || route.view === "ohbox") openForward(focused.id);
        else onStreamAction("forward", focused);
      },
    },
    {
      /* SEND, INSIDE THE REPLY RUN. The overlay's Done button and this chord are one path —
         the run below mirrors `onDone` (AppShell's FocusReplyOverlay wiring) verbatim, so
         the no-message refusal and the shared scratch buffer behave identically. Declared
         BEFORE the inline reply's `mod+Enter` because the run's overlay stands over
         everything while it is open; both are `disabled`-gated on disjoint states, so the
         dispatcher's first-enabled rule is what actually decides. `inInput` for the same
         reason as the reply's: the run's editor holds focus, which is the whole use case. */
      chord: "mod+Enter",
      group: "message",
      label: t("shortcuts.frSend"),
      inInput: true,
      disabled: fr == null || fr.step >= fr.items.length,
      run: () => {
        if (!fr || fr.step >= fr.items.length) return;
        const item = fr.items[fr.step]!;
        if (!item.messageId) return;
        const v = frValues[frKeyOf(item)] ?? EMPTY_RICH;
        mailSend.send({
          kind: "mail_send",
          inReplyTo: item.messageId,
          body: v.text,
          ...(v.html ? { html: v.html } : {}),
        });
      },
    },
    {
      // SENDING FROM THE KEYBOARD. `inInput` is not optional: the editor takes focus the moment it opens, so without
      // it the one place the shortcut is for is the one place it would not fire — the same reasoning Escape's binding
      // already carries. `mod+Enter` and not bare `Enter`, because the field is a multi-line editor where Enter is a
      // new paragraph. The four views bind bare `Enter` as "open the row" and none of them sets `inInput`, so the
      // typing guard already keeps them out of this editor (`isTypingTarget` answers true for a `contenteditable` as
      // it did for the textarea); this chord does not collide with any of them. The rich editor does not swallow it.

      // ProseMirror's keymap handles `Enter` and `Shift-Enter` and has no `Mod-Enter` binding, so the event is not
      // consumed and reaches the document listener this registry hangs on — which is why the chord stays here rather
      // than being reimplemented inside the editor's own `onKeyDown`. It calls the same `sendReply` the button does,
      // so the send lock, the empty-body guard and the whole failure surface apply identically — there is no second
      // path to SMTP.
      chord: "mod+Enter",
      group: "message",
      label: t("shortcuts.sendReply"),
      inInput: true,
      disabled: replyTo == null,
      run: () => replyTo && sendReply(replyTo),
    },
    {
      chord: "s",
      group: "message",
      label: t("shortcuts.screen"),
      disabled: focused == null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        openSenderMenu(
          focused.id,
          document.querySelector<HTMLElement>(`.view .row[data-id="${CSS.escape(focused.id)}"]`),
        );
      },
    },
    {
      // `f` starts a Reply Run over the Answer Later pile, and until this binding there
      // was NO keyboard way to put anything INTO that pile — `later` was reachable only from
      // the reader's action menu. A keyboard user could start a run they could not fill, and
      // `f` sat permanently `disabled` for them. Found while writing the guard for it, which is
      // blocked on exactly this.
      //
      // `a` for Answer, next to the pile's own name. Free: the bound set was
      // ? / b c e f r s, `g`-prefixed jumps, mod+k and Escape.
      chord: "a",
      group: "message",
      label: t("shortcuts.answerLater"),
      disabled: focused == null,
      ...noCursor,
      run: () => focused && onMessageAction("later", focused),
    },
    {
      chord: "e",
      group: "message",
      // ohmail has no Archive: "out of the way, still here" is the Park pile. Naming it
      // Park rather than Archive is the honest mapping, not a missing feature.
      label: t("shortcuts.park"),
      disabled: focused == null,
      ...noCursor,
      run: () => focused && onMessageAction("aside", focused),
    },
    {
      chord: "b",
      group: "message",
      label: t("shortcuts.resurface"),
      disabled: focused == null,
      ...noCursor,
      run: () => focused && onMessageAction("resurface", focused),
    },
    {
      /* MOVE — opens the bar's destination strip on the focused message (`barPanel`, the
         chrome-held state every mount of that bar renders), where the pane lands focus on
         the first destination so `m` then ↵ files. A toggle, the `r` convention. Declared
         HERE, not in the bar, so the sheet documents it even while nothing is open. */
      chord: "m",
      group: "message",
      label: t("shortcuts.move"),
      disabled: focused == null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        setBarPanel((p) =>
          p?.panel === "move" && p.messageId === focused.id
            ? null
            : { messageId: focused.id, panel: "move" },
        );
      },
    },
    {
      /**
       * DELETE — the prototype's two-press ceremony: the first `d` ASKS (the same confirm strip the ⋯ menu opens,
       * focus landing on Cancel), the second CONFIRMS by clicking the strip's own danger button — the ONE dispatch
       * site of `"delete"` stays that button, so a gate closing under the ask cannot ghost-delete (gate gone ⇒ strip
       * gone ⇒ nothing to click). The gate is the strip's own render gate (the mirror holds the row), so the sheet
       * never advertises a delete the bar would refuse to draw. THIS `disabled` IS WHAT THE `?` SHEET PRINTS, so it
       * is half the defect and not a mirror of it: with "Use folders" off the sheet drew this row greyed and the
       * strip could not be opened at all, while the same verb over a selection worked. It reads the mirror alone now,
       * exactly like `canDeleteMessage` above and the strip itself.
       */
      chord: "d",
      group: "message",
      label:
        barPanel?.panel === "delete" ? t("shortcuts.deleteConfirm") : t("shortcuts.deleteAsk"),
      disabled:
        focused == null
        || reader.get<EngineMessage>("message", focused.id) == null,
      ...noCursor,
      /* A HELD KEY IS ONE PRESS. Key auto-repeat would otherwise walk the whole ceremony on
         its own — the first repeat opens the ask, a later repeat confirms it — turning a
         finger resting on `d` into an un-undoable delete (review finding, round 1). The
         second press of the ceremony must be a second PHYSICAL press. */
      when: (e) => !e.repeat,
      run: () => {
        if (!focused) return;
        if (barPanel?.panel === "delete" && barPanel.messageId === focused.id) {
          document.querySelector<HTMLButtonElement>(".abar-delete .abar-danger")?.click();
        } else {
          setBarPanel({ messageId: focused.id, panel: "delete" });
        }
      },
    },
    /**
     * BACKSPACE AND DELETE — the keys the mail apps everybody arrives from already use, filing the focused message to
     * Trash in one press with Undo in the toast. They are not a second delete: both run `onMessageAction("delete",
     * …)`, the ONE dispatch site `d`'s confirm button also reaches, so there is one ceremony, one refusal and one
     * sentence. WHY THEY DO NOT ASK FIRST, WHILE `d` DOES. `d`'s two-press ceremony exists because a delete used to
     * be unrecoverable the instant it dispatched. It is not any more — the press opens an undo window
     * (`delete-undo.ts`) — so a key whose whole point is one press does not need a strip in front of it. `d` keeps
     * its ask because a keycap on a bar button that deletes on a single press is a different promise; both now land
     * in the same window.
     */

    /**
     * The gate is `d`'s own, deliberately: the sheet must not advertise on one row a delete the row beside it would
     * refuse to draw. It is the mirror holding the row and nothing else — see `canDeleteMessage` for why "Use
     * folders" stopped being a term.
     */
    ...deleteKeyBindings({
      focused,
      label: t("shortcuts.deleteKey"),
      canDelete:
        focused != null
        && reader.get<EngineMessage>("message", focused.id) != null
        /* NOT IN TRASH. The message is already there, so ⌫ has nothing to move it to, and
           deleting twice is not a thing this product can do — it never erases mail. Refused as
           `disabled` (with the reason, which the `?` sheet prints on the row) rather than by
           withholding the binding: withholding it would let the key fall through to whatever is
           behind, and would take the two keycaps out of the documentation exactly where a reader
           is most likely to reach for them. */
        && route.view !== "trash",
      disabledReason: "no_erase",
      run: (m) => onMessageAction("delete", m),
    }),
    /* ⇧⌫ — RESTORE, and only in Trash. The mirror image of ⌫: the key that removes mail from a
       pile is the key that brings it back from the bin, one modifier apart, so the two are one
       gesture to learn. Listed at every route so the sheet documents it (the rule above), inert
       everywhere else with no reason attached — a key that is simply not applicable here needs
       no sentence, where one that CANNOT EVER work does. */
    {
      chord: "shift+Backspace",
      group: "message",
      label: t("trash.restoreKey"),
      disabled: route.view !== "trash" || focused == null,
      /* A HELD KEY IS ONE PRESS, and a question on screen owns the key — `deleteKeyBindings`'
         own two `when` conditions, for its own two measured reasons: Backspace repeats faster
         than any key somebody leans on, and `isModalOpen` is a DOM read that cannot be a
         `disabled` flag because the More menu opens without the shell re-rendering. */
      when: (e) => !e.repeat && !isModalOpen(e.view?.document ?? document),
      run: () => {
        if (focused) onMessageAction("restore", focused);
      },
    },
    {
      chord: "mod+k",
      group: "app",
      label: t("shortcuts.palette"),
      inInput: true,
      run: () => palette.toggle(),
    },
    /* LEAVE-THE-READER, the Zero sheet's lateral exit (review finding, round 1): under zero the
       sheet is the one-tile bands' reading SLOT, and `h`/← toward the list must mean "put
       the list back" — §12's one meaning, where classic's sheet (a true modal) rightly
       cedes ← and keeps Escape. Registered here because closing the sheet is shell state;
       zone-nav's own ← stays gated by `noReaderOverlay` and these win the dispatch first.
       Escape is unchanged (the overlay ladder already closes the sheet). */
    {
      chord: "ArrowLeft",
      group: "navigate",
      label: t("shortcuts.zoneList"),
      disabled: !zeroSheetUp,
      // The drawer outranks the sheet while it holds focus (review finding, round 2): with
      // both standing, ← belongs to the drawer walk, not to closing the reader behind it.
      when: () => currentZone() !== "rail",
      run: () => setReaderFor(null),
    },
    {
      chord: "h",
      group: "navigate",
      label: t("shortcuts.zoneList"),
      disabled: !zeroSheetUp,
      when: () => currentZone() !== "rail",
      run: () => setReaderFor(null),
    },
    {
      chord: "w",
      group: "app",
      label: t("shortcuts.layout"),
      run: cycleLayout,
    },
    {
      chord: "?",
      group: "app",
      label: t("shortcuts.sheet"),
      inWriting: true, // the sheet moves no mail, and it is where Compose's own chords are documented
      run: () => setShortcutsOpen((o) => !o),
    },
    /* Escape is NOT here. It is registered above, in the `overlay` scope, because an open
       overlay has to outrank a view's bindings and a global one does not. */
  ];
  useKeyBindings(globalKeys, "global");

  /* ── the palette command map (every command from the prototype) ── */
  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      /* THE DESTINATION ROWS READ THE REGISTRY'S OWN WORDING (`shortcuts.*`), not a second copy
         of it. The palette and the `?` sheet are two lists of the same instruction, and while
         each had its own message they drifted: the palette said "Go to Ohbox" and the sheet said
         "Go to the Ohbox", one word apart, reported as the two lists disagreeing. Reads and
         Receipts were byte-identical twins waiting to do the same thing. One message per
         destination, in the namespace the binding labels live in. */
      { id: "go-ohbox", label: t("shortcuts.goOhbox"), keys: ["g", "o"], run: () => go("ohbox") },
      { id: "go-reads", label: t("shortcuts.goReads"), keys: ["g", "r"], run: () => go("reads") },
      { id: "go-receipts", label: t("shortcuts.goReceipts"), keys: ["g", "e"], run: () => go("receipts") },
      { id: "go-screener", label: t("palette.openScreener"), keys: ["g", "s"], run: () => go("screener") },
      { id: "scn-screened", label: t("palette.screenerScreened"), run: () => goScreener("screened") },
      { id: "scn-spam", label: t("palette.screenerSpam"), run: () => goScreener("spam") },
      {
        id: "fr",
        label: t("palette.startFR"),
        keys: ["f"],
        run: () => {
          setFrPending(true);
          go("triage");
        },
      },
      { id: "search", label: t("palette.search"), keys: ["/"], run: () => go("search") },
      { id: "compose", label: t("palette.newMessage"), keys: ["c"], run: () => go("compose") },
      {
        /* THE DESTINATION ROW, reading the registry's own wording (`shortcuts.goTrash`) exactly
           as the four rows above it do — one message per destination, in the namespace the
           binding labels live in. Declared `disabled` where the client has no Trash transport
           rather than silently absent: a row that is missing teaches nothing, and a row that
           says why is how somebody learns the demo has no mailbox behind it. */
        id: "go-trash",
        label: t("shortcuts.goTrash"),
        keys: ["g", "t"],
        disabled: !engine.trashAvailable(),
        run: () => go("trash"),
      },
      { id: "settings", label: t("palette.openSettings"), run: () => go("settings") },
    ];
    /* THE TWO ROWS THAT ACT ON THE OPEN MESSAGE, and they say so when there is none.
       Both bodies were already `if (selectedOhbox)`, so with nothing open the row ran and
       nothing happened — a command that answers a click with silence. The keyboard twins
       have always declared it (`t` in `OhboxView`, `b` below, both `disabled` on an absent
       selection); these are the same commands reached the other way, so they carry the same
       declaration rather than a second opinion about when they work. */
    tags.forEach((tag, i) => {
      list.push({
        id: `tag-${tag.id}`,
        label: t("palette.tagToggle", { name: tag.name }),
        icon: "tag",
        ...(i === 0 ? { keys: ["t"] } : {}),
        disabled: selectedOhbox == null,
        run: () => {
          if (selectedOhbox) {
            toggleTag(selectedOhbox.id, tag.id, !selectedOhbox.labels.includes(tag.id));
          }
        },
      });
    });
    for (const tag of tags) {
      list.push({
        id: `goto-tag-${tag.id}`,
        label: t("palette.goTag", { name: tag.name }),
        icon: "tag",
        run: () => goTag(tag.id),
      });
    }
    list.push({ id: "theme", label: t("palette.toggleTheme"), run: () => theme.toggle() });
    /* The demo's own ruling for layout controls: "palette and hotkeys only" — no rail
       button, no Settings row (named in the 3b close-out). */
    list.push({ id: "layout", label: t("palette.cycleLayout"), keys: ["w"], run: cycleLayout });
    list.push({
      id: "resurface",
      label: t("palette.resurfaceSel"),
      keys: ["b"],
      disabled: selectedOhbox == null,
      run: () => {
        if (selectedOhbox) onMessageAction("resurface", selectedOhbox);
      },
    });
    return list;
  }, [t, tags, selectedOhbox, toggleTag, theme, onMessageAction, startFR, engine]);

  /**
   * THE ONE NUMBER A NATIVE SHELL IS TOLD — see `AppShell`'s `onUnread`.
   *
   * Published from the same value the Ohbox's rail row renders, so the dock icon and the rail
   * can never disagree about how much is waiting. In an effect rather than during render because
   * the consumer is outside React: it puts a badge on a window, and doing that while rendering is
   * a side effect in the middle of one.
   */
  useEffect(() => {
    onUnread?.(ohbox.newForYou.length);
  }, [onUnread, ohbox.newForYou.length]);

  /* ── the rail ── */
  const railGroups: RailGroup[] = useMemo(
    () => [
      {
        items: [
          {
            id: "ohbox",
            label: t("rail.ohbox"),
            count: ohbox.newForYou.length,
            hot: true,
            title: t("rail.ohboxTitle", {
              unread: ohbox.newForYou.length,
              total: allOhbox.length,
            }),
          },
          /* The streams count "new since last visit" — the fresh side of each view's own
             waterline — never unread. See the `readsNew` derivation for the whole argument. */
          {
            id: "reads",
            label: t("rail.reads"),
            count: readsNew,
            title: t("rail.readsTitle", { count: readsNew }),
          },
          {
            id: "receipts",
            label: t("rail.receipts"),
            count: receiptsNew,
            title: t("rail.readsTitle", { count: receiptsNew }),
          },
        ],
      },
      {
        items: [
          {
            id: "screener",
            label: t("rail.screener"),
            count: screener.waitingCount,
            hot: true,
            title: t("rail.screenerTitle", { count: screener.waitingCount }),
          },
        ],
      },
      {
        /* NO HEADING over the three horizons — owner decision, 2026-08-22 (FOLDERS-SPEC.md
           §16.4): the group's spacing differentiates it, exactly as it does for the Ohbox and
           Screener groups above. The `rail.triage` KEY is deliberately still in both catalogues —
           `viewTitles` below titles the mobile view with it, so the locale files keep their
           shape. */
        items: [
          { id: "triage", label: t("rail.replyLater"), count: piles.replyLater.length },
          { id: "triage-aside", label: t("rail.setAside"), count: piles.setAside.length },
          { id: "triage-resurface", label: t("rail.resurface"), count: piles.resurface.length },
        ],
      },
      // TAGS ARE THEIR OWN GROUP, not a sub-item of Triage. They were nested under it, which
      // said the wrong thing about what they are: triage piles are three fixed places a
      // message can sit, and tags are a cross-cutting dimension over every view. Filing the
      // second under the first made tags read as a fourth pile. Own group, own label, and it
      // stands even when empty — a collapsed group with a count of zero is how someone learns
      // the feature exists. (This comment used to quote "Tags (never folders)"; that invariant
      // was deliberately relaxed on 2026-08-22 — tags stay cross-cutting, and the mailbox's own
      // FOLDERS became an optional, off-by-default sibling group directly below.)
      {
        // No group label: `TagsGroup` renders its own heading, so setting both printed
        // "Tags" twice in the rail. Caught in the live walkthrough.
        items: [],
        tags: {
          label: t("rail.tags"),
          defaultOpen: true,
          // `open` / `onOpenChange` are injected by `ShellRail`, which owns the persisted collapse
          // flag. They are deliberately NOT here: this object is memoized without `tagsOpen` in its
          // deps, so a value read here would freeze — the stale-`open` half of the ~5s bug. Keeping
          // them out also keeps the flag off this top-level component, so a toggle never re-renders
          // the view. `RailNav` stays uncontrolled-by-default for the Desktop, which has no storage.
          items: tagGroups.map((g) => ({
            id: g.tag.id,
            label: g.tag.name,
            hue: hueOf(g.tag),
            count: g.messages.length,
          })),
          /* "New tag" is a first-class inline affordance now, not a data row and not a dialog:
             `RailNav` owns a `+ New tag` trigger that swaps for an input IN PLACE, plus an
             empty-state invite when there are no tags yet. The duplicate check stays HERE
             because the server's unique index is on `lower(name)` — offering a name that already
             exists would promise a tag the server answers 409 for — and it runs against the
             WHOLE tag set (`tags`), so a tag that sits on no message still blocks its own name.
             `createTagAlone` is the standalone `tag_create` verb: no message, unlike the picker's
             tag-or-create, which is exactly the thing the sidebar does not have to hand. */
          create: {
            label: t("rail.tagNew"),
            placeholder: t("tag.newPlaceholder"),
            emptyHint: t("rail.tagEmpty"),
            onCreate: createTagAlone,
            duplicate: {
              taken: (name: string) =>
                tags.some((tg) => tg.name.toLowerCase() === name.toLowerCase()),
              label: (name: string) => t("tag.newTaken", { name }),
            },
          },
        },
      },
      /* FOLDERS — the mailbox's own folders, DIRECTLY BELOW TAGS, collapsible, unnumbered
         (FOLDERS-SPEC.md §3 "the rail"; owner decision 3). Rendered ONLY while "Use folders"
         is on: spread conditionally rather than as an empty group, so a flag-off rail is
         BYTE-IDENTICAL to the pre-feature rail — no extra `.rgroup`, nothing — which is the
         parity claim `test/folders-rail.test.tsx` pins. The group is a host-authored subtree
         (`RailGroup.custom`) because its shape — a tree with an opened-set, roll-up counts,
         mailbox sections, a filter past twelve roots — is this feature's, not the design
         system's; it renders in the rail's own vocabulary. `numberNav` reads `items`, so the
         group contributes nothing to the number keys, exactly as Tags does. */
      ...(consent.foldersEnabled
        ? [{
            items: [],
            custom: (
              <FoldersRailGroup
                folders={folders}
                unread={folderUnread}
                verbs={demo ? undefined : folderVerbs}
                accountMailboxes={demo ? undefined : folderMailboxes}
                /* The third render (the folder-delivery review): with the flag ON and ZERO
                   entities, "no folders on your server" and "the first drain has not finished"
                   are different sentences — `bootstrapping` is exactly that window, and
                   `consent.known` false is the same window for the flag itself (a cache-painted
                   boot). Unsettled renders the skeleton; settled-and-empty renders the honest
                   empty line. The flag-OFF render stays the spread above: no group at all. */
                settled={consent.known && !syncStatus.bootstrapping}
                /* The ACCOUNT's mailbox count, not the entity-derived one: two connected
                   mailboxes where only one has folders still section, or the lone tree is
                   ambiguous (spec §14). `facts` is the host's probe; null (demo, standalone)
                   falls back to what the entities show. */
                mailboxCount={facts?.length}
                activeFolderId={route.view === "folder" ? (route.folderId ?? undefined) : undefined}
                onNavigate={(id) => {
                  setRailOpen(false);
                  goFolder(id);
                }}
              />
            ),
          }]
        : []),
      /**
       * TRASH, WHILE YOU ARE IN IT: A `custom` group spread into the rail ONLY while Trash is the route, positioned
       * after the Folders group (after Tags when folders are off) and before the dock — the rail's lower part. It
       * disappears the moment the route leaves, because the memo's deps carry `route.view` and the group is a
       * conditional spread rather than a hidden node: outside Trash the rail is BYTE-IDENTICAL to today, no extra
       * `.rgroup`, nothing — the parity shape `test/folders-rail.test.tsx` already pins for the Folders group, pinned
       * again for this one. `items: []`, so `numberNav` reads nothing here and the digits are unchanged. A place
       * reached by ⌘K and `g t` does not earn a number, and taking one would renumber every pile below it while
       * somebody is standing in Trash.
       */
      ...(route.view === "trash"
        ? [{
            items: [],
            custom: (
              <div className="rgroup rsub trash-rail" data-testid="rail-trash">
                <div className="frow">
                  {/* The twisty column as an empty SPACER, exactly as a leaf folder row uses
                      it: it is what makes this label align with the folder labels above rather
                      than sitting 14px to their left. */}
                  <span className="ftw" />
                  <button
                    type="button"
                    className="ritem on"
                    aria-current="page"
                    data-rail-id="trash"
                    title={t("rail.trashTitle")}
                    onClick={() => {
                      setRailOpen(false);
                      go("trash");
                    }}
                  >
                    <Icon name="folder" className="fglyph" />
                    <span className="flabel">{t("rail.trash")}</span>
                    {/* THE PAGE'S ROW COUNT, and never "hot": nothing in Trash is new for
                        anybody, and an accent number here would read as a demand. Empty while
                        the first page is in flight — a `0` would claim the bin is empty before
                        the server has answered. */}
                    <span className="cnt num">
                      {trashPage.items.length > 0 ? trashPage.items.length : ""}
                    </span>
                  </button>
                </div>
              </div>
            ),
          }]
        : []),
      {
        items: [
          /**
           * HISTORY CARRIES NO COUNT, AND THAT IS A PROPERTY RATHER THAN A STYLE CHOICE. A sender with ANY unread
           * mail is active whatever its age, so nothing unread can reach History — the engine's cutline guarantees it
           * by construction. A place that cannot contain anything unread has nothing to demand, so a badge here would
           * be a number that is always the size of the past and never a call to act. `count` is therefore ABSENT
           * rather than zero: `RailNav` renders an absent count as nothing at all, and a literal `0` would draw a
           * badge saying nothing is there. `rail-history.test.tsx` asserts the key is missing, because a future edit
           * adding `count: history.length` would look like an improvement.
           */
          { id: "history", label: t("rail.history"), title: t("rail.historyTitle") },
          { id: "search", label: t("rail.search"), kbdHint: "/" },
          /* DRAFTS CARRIES A COUNT and History deliberately does not, and the difference is what
             the number would mean. History's count would be the size of the past — always there,
             never a call to act. A draft is an unfinished thing this account started, so the
             count is exactly a call to act, and zero of them is a row worth having anyway: it is
             how somebody learns their half-written mail is on the account rather than in one
             browser. `count` is therefore present even at zero, unlike History's absent key. */
          { id: "drafts", label: t("rail.drafts"), count: drafts.length },
          { id: "settings", label: t("rail.settings") },
        ],
      },
    ],
    [
      t, ohbox.newForYou.length, allOhbox.length, readsNew, receiptsNew, screener.waitingCount, piles,
      tagGroups, tags, createTagAlone, consent.foldersEnabled, consent.known, folders,
      folderUnread, folderVerbs, folderMailboxes, demo, syncStatus.bootstrapping, route.view,
      route.folderId, facts,
      /* The count the transient entry renders. `route.view` is already here (the spread's own
         condition), so this is the only new dependency the entry needs. */
      trashPage.items.length,
    ],
  );

  /**
   * THE NUMBER KEYS: `1`…`N` reach the piles in the order the rail lists them. Requested as navigation that does not
   * need the mouse and does not need a two-key sequence — `g o` / `g r` / `g e` / `g s` already exist but only cover
   * four destinations and none of the triage horizons. DERIVED FROM THE RAIL, NOT WRITTEN OUT BESIDE IT: The numbers
   * ARE the menu order, so they are read off `railGroups` rather than declared in a parallel list. A hand-written
   * table would be a second enumeration of the nav — the shape the (i) panel's hand-typed key list had, and the one
   * the `?` sheet is generated to avoid — and it would go wrong the first time a group gained an item. Only the PILES
   * are numbered: the three streams, the Screener and the three triage horizons. Tags is a collapsible group whose
   * contents are the user's own and change; Search has `/` and Settings is not somewhere you flick to.
   */

  /**
   * `slice(0, 9)` because there is no key `10` — a tenth pile would simply not be numbered rather than silently
   * shifting the rest.
   */
  const numberNav = useMemo(
    () =>
      railGroups
        .flatMap((g) => g.items)
        .filter((item) => PILE_IDS.includes(item.id))
        .slice(0, 9),
    [railGroups],
  );

  /**
   * ── DISCOVERABILITY, WITHOUT A BADGE ON EVERY ROW AND WITHOUT A MESSAGE ────────────────
   *
   * A shortcut nobody knows about is not a feature, and a badge on every row forever is
   * clutter charged to every user so that a few learn something once. Two layers, both quiet:
   *
   *   1. the `?` sheet lists them, free, because the bindings above declare their own labels
   *      and the sheet is generated from the registry;
   *   2. the row itself shows its keycap ON HOVER AND ON KEYBOARD FOCUS — you learn the key by
   *      pointing at, or tabbing to, the row it belongs to. `navKey` rides on every numbered
   *      row; `RailNav` reveals it only for the row under the pointer or focus and hides it
   *      otherwise, so the resting rail carries counts and no keycaps. `RailNav` also clears the
   *      reveal on click, so a tap that navigates does not leave a keycap standing where a touch
   *      device has no pointer-leave to come.
   *
   * The `?` sheet ALSO paints every keycap at once while it is open (`kbdHint`), because the
   * moment somebody is asking "what are the keys" the answer belongs on the things as well as
   * in the list. `kbdHint` wins over the per-row reveal when both are set — see `RailItem`.
   *
   * There used to be a third layer: a one-time dismissible strip after a handful of rail
   * clicks. It was removed — a line of chrome telling you a faster way exists is louder than
   * the thing it points at, and the hover/focus keycap teaches the same fact without a message.
   */
  const railGroupsWithHints = useMemo(
    () =>
      railGroups.map((g) => ({
        ...g,
        items: g.items.map((item) => {
          const n = numberNav.findIndex((x) => x.id === item.id);
          if (n < 0) return item;
          const key = String(n + 1);
          // `navKey` is the always-attached hover/focus reveal; `kbdHint` is the louder
          // all-at-once reveal the `?` sheet asks for. Both name the same key.
          return shortcutsOpen ? { ...item, navKey: key, kbdHint: key } : { ...item, navKey: key };
        }),
      })),
    [railGroups, numberNav, shortcutsOpen],
  );

  useKeyBindings(
    numberNav.map((item, i) => ({
      chord: String(i + 1),
      group: "navigate" as const,
      // THE SAME SENTENCE THE `g` CHORD USES for this place, so the sheet folds the two chords
      // into one row ("1 · g o  Go to the Ohbox") instead of listing every destination twice
      // under two spellings. A rail row with no `g` chord (a tag, a folder) keeps the generic
      // "Go to {pile}" over the rail's own label.
      label: PILE_CHORD_LABEL[item.id] ? t(PILE_CHORD_LABEL[item.id]!) : t("shortcuts.goPile", { pile: item.label }),
      /* A HELD DIGIT IS ONE NAVIGATION. Auto-repeat re-running a jump is never wanted — and
         it was exploitable across a boundary: hold `1` with compose's send-later picker
         open, the first press schedules and CLOSES the picker, and the repeats then fell
         through to THIS binding and navigated away from the message being scheduled
         (review finding, round 2). A repeat falls through to nothing (no digit is a
         sequence prefix), so it simply does not fire. */
      when: (e: KeyboardEvent) => !e.repeat,
      run: () => {
        // The SAME conversion the rail handler uses, from the same table. A `startsWith`
        // test here would be a second opinion about which rows are triage rows.
        const pile = TRIAGE_PILE_OF_RAIL[item.id];
        if (pile) goTriage(pile);
        else go(item.id as "ohbox");
      },
    })),
    "global",
  );

  const activeRailId =
    route.view === "folder"
      // A folder URL whose entity is missing (feature off, folder gone) renders the Ohbox —
      // so the rail highlights the Ohbox too, and the chrome never claims a view that is not
      // on screen. With the entity present the folder row itself carries the highlight.
      ? (openFolder ? undefined : "ohbox")
      : route.view === "tag"
      ? undefined
      : route.view === "triage"
        // The row for the pile that is actually open. Hard-coded to `"triage"` before, which
        // is why the rail lit Answer Later however you arrived.
        ? RAIL_OF_TRIAGE_PILE[route.triagePile]
        : route.view === "compose"
          ? undefined
          : route.view;

  const viewTitles: Record<string, string> = {
    ohbox: t("rail.ohbox"),
    reads: t("rail.reads"),
    receipts: t("rail.receipts"),
    screener: t("rail.screener"),
    triage: t("rail.triage"),
    history: t("rail.history"),
    search: t("rail.search"),
    compose: t("rail.compose"),
    drafts: t("rail.drafts"),
    settings: t("rail.settings"),
  };
  const mobileTitle =
    route.view === "tag"
      ? (tagGroups.find((g) => g.tag.id === route.tagId)?.tag.name ?? t("rail.tags"))
      : route.view === "folder"
        // The missing-folder fallback renders the Ohbox, so the title says Ohbox — the same
        // one-answer rule the rail highlight follows.
        ? (openFolder?.name ?? t("rail.ohbox"))
        : (viewTitles[route.view] ?? t("rail.ohbox"));

  /* ── views ── */
  const tagGroup =
    route.view === "tag" ? tagGroups.find((g) => g.tag.id === route.tagId) : undefined;
  /**
   * `"seed"` matches no view below, which is how the review screen TAKES the stage instead of
   * appearing above a pile. Stated here rather than by guarding each of the ten renders: a
   * condition repeated ten times is nine chances to forget it, and the tenth view added later
   * would render underneath the screen with nobody noticing.
   */
  const effectiveView = seedOwed
    ? "seed"
    : route.view === "tag" && !tagGroup
      ? "ohbox"
      : route.view === "folder" && !openFolder
        ? "ohbox"
        : route.view;

  const frFinished = fr != null && fr.step >= fr.items.length;
  const frItem = fr && !frFinished ? fr.items[fr.step] : undefined;
  /** The step's send, off the one machine — the run is a caller of it, not a second one. */
  const frSend = frItem?.messageId ? mailSend.stateOf(frItem.messageId) : null;

  /**
   * A REPLY BEGUN BEFORE A RELOAD IS STILL OWED. Seeded from the same per-message scratch buffer the inline editor
   * uses, so a run resumed in a new tab finds the sentence that was already written. Read AFTER mount rather than in
   * the state initializer, for the hydration reason `persisted-ui.ts` spells out: reading storage during render makes
   * the server and the client produce different markup and React keeps the server's, so the saved text would be read
   * and then silently discarded. Never overwrites what is already in memory. The map is the live editor; the buffer
   * is only its backup, and a key present with an empty string means "this one has been opened", not "this one is
   * unknown".
   */
  useEffect(() => {
    const id = frItem?.messageId;
    if (!id) return;
    setFrValues((vals) => (id in vals ? vals : { ...vals, [id]: readReplyDraft(id) }));
  }, [frItem?.messageId]);

  /**
   * A SEND THE RUN MADE THAT DID NOT LAND MUST SAY SO. `FocusReplyOverlay` renders a card and two buttons and has no
   * status line, so the run's only other feedback for a failure is the step NOT advancing — which is silence to
   * somebody who pressed Done and is waiting. The inline editor's four status strings say exactly the same four
   * things, so they are reused rather than re-worded, and none of them claims a delivery: `settle`'s toast is the
   * only sentence in the app that does, and it fires only on a confirmation. Keyed on the PHASE moving, not on
   * `t`/`toast` identity — a render-keyed effect here would re-announce the same failure on every keystroke.
   */
  const frPhase = frSend?.phase ?? "idle";
  const frCode = frSend?.code;
  useEffect(() => {
    if (frPhase === "idle" || frPhase === "sending") return;
    // The failed arm never quotes the wire — `SendStatus.tsx` carries the whole argument (a
    // real subscriber read "Nicht gesendet: authentication required", the API middleware's own
    // 401 text). Same catalog keys, same code-not-text branching, one contract on both surfaces.
    toast(
      frPhase === "queued"
        ? t("reply.statusQueued")
        : frPhase === "unverified"
          ? t("reply.statusUnverified")
          : frCode === "mailbox_disabled"
            ? t("reply.statusMailboxDisabled")
            : t("reply.statusFailed"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frPhase, frCode]);

  /**
   * THE CONVERSATION, for whichever message a pane is rendering.
   *
   * `engine.read()` is called at INVOCATION time, not closed over, so the callback is
   * stable across version bumps — the chrome context below would otherwise churn for every
   * consumer on every delta — while what it returns is always the current mirror, including
   * the optimistic overlay. A `useMemo` keyed on `version` would give the same freshness and
   * a new identity every bump; a `useMemo` that forgot `version` would go stale, which is
   * exactly the bug `senderMenuFor` carries a `version` dep to avoid.
   */
  const conversationOf = useStableCallback((messageId: string) => threadOf(engine.read(), messageId));

  /**
   * The address book for the reply's recipient rows — the same ranked selector the compose
   * To field builds, derived when a reply OPENS rather than per keystroke or per delta: the
   * set of people this account has corresponded with does not change while somebody types a
   * name, which is `ComposeView`'s own once-per-mount reasoning keyed to the editor instead
   * of the route. Own addresses are excluded for the reason compose excludes the sender:
   * suggesting somebody their own address as a recipient is noise.
   */
  const replyBook = useMemo(
    () => (replyTo !== null ? addressBook(engine.read(), { exclude: ownAddresses }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, replyTo, ownAddresses],
  );

  const chrome = useMemo(
    () => ({
      ownAddresses,
      // The reader's Delete verb is gated on the folders foundation flag (§16.3/§16.7) — the
      // same server-confirmed value the rail's Folders group reads.
      foldersEnabled: consent.foldersEnabled,
      // …and on the mirror actually HOLDING the row: an off-mirror archive hit (Search's
      // reach-past reader) has no local row for `message_delete` to act on, so the verb is
      // withheld there rather than offered and guaranteed to fail (review finding).
      // ONE definition, shared with `⇧F`'s own gate — see `mirrorHolds` above.
      mirrorHolds,
      absoluteTime,
      onToggleAbsoluteTime: toggleAbsoluteTime,
      replyTo, replyAll, replyMode, replyBody, onReplyBody, closeReply, sendReply,
      // The audience edit and its book — held here for the mounted-twice reason the reply
      // body is, applied by `InlineReply`, sent by `sendReply` above from the same state.
      replyEnvelope,
      onReplyEnvelope: setReplyEnvelope,
      // The picked sender and the reply's files — held here for the mounted-twice reason the body
      // is, resolved by `InlineReply` and put on the wire by `sendReply` from the same state.
      replyFromId,
      onReplyFrom: setReplyFromId,
      replyAttachments,
      onReplyAttachments: setReplyAttachments,
      // The signature block's state and the account's stored map — held here for the
      // mounted-twice reason the body is; `sendReply` serializes the same derivation the
      // block renders. The map travels only once server-confirmed, so a block can never be
      // drawn (or serialized) from a guess.
      replySig,
      onReplySig,
      signatures: consent.signaturesKnown ? consent.signatures : undefined,
      // The MARKUP half beside it (mail 0098), gated on the same flag: the two maps arrive
      // in one response, so a surface that has one has both and a second gate could only
      // ever disagree with this one.
      signaturesHtml: consent.signaturesKnown ? consent.signaturesHtml : undefined,
      // The subject as edited — `null` keeps the untouched reply's wire byte-identical.
      replySubjectEdit,
      onReplySubject,
      // The host's surface declaration rides beside the reply's files because it is the other
      // half of the same ceiling: `InlineReply` states and refuses against
      // `composeAttachCap(from.maxMessageBytes, THIS)`, the exact pair the send will enforce.
      sendSurfaceMaxTotalBytes,
      addressBook: replyBook,
      /**
       * THE SIBLING VERBS, no longer dormant. `MessageCard` has rendered a Reply/Forward footer on every expanded
       * conversation sibling since the thread surface landed, and both buttons were declared OPTIONAL on the chrome
       * so the footer simply did not appear until a shell supplied them. Nothing did, so a reader looking back at an
       * older message in a thread had no way to answer it without first making it the focused one — the exact detour
       * the footer exists to remove. `openReply` is the SAME callback the focused message's action bar runs, passed
       * straight through: one reply machine, retargeted by id, so the mobile rule it carries (under 900px the reading
       * column is `display:none`, so open the reader) holds for a sibling too. Any second implementation here would
       * be a copy of that rule waiting to drift.
       */
      openReply,
      forward: openForward,
      /**
       * WHERE THIS LANE'S REPLY HAS GOT TO, WITH THE ROW'S OWN WITNESS IN IT — see
       * `replySendState`. One reading of the hold, two surfaces.
       */
      replySendState: replySendState,
      /** The held reply's way out, on the door the reader actually opens — see `DraftsView`. */
      replyHeldResolve: (messageId: string) => {
        const row = heldReplyRow(messageId);
        return row === null ? null : { draftId: row, onResolve: resolveHeldSend };
      },
      // The offer and the draft waiting to be placed travel with the reply draft, and for the
      // same reason: `MessagePane` is mounted TWICE while the reader is open, and an offer
      // held per-pane would be two offers, each able to spend an AI action the other one
      // knew nothing about.
      draftReply: draftReplyChrome,
      openSenderMenu,
      // The "me" chip's identity and the contact popover's two verbs (viewer redesign). Write seeds
      // a compose; the Screener entry is the WIDENED openSenderMenu — the chip's address rides
      // as the override, so the sheet resolves the To/Cc person and not the message's sender.
      ownNameOf,
      writeTo,
      screenAddress: (messageId: string, address: string, anchor: HTMLElement | null) =>
        openSenderMenu(messageId, anchor, address),
      // The title press. The seam was declared with no implementation, so the viewer rendered the
      // subject as a plain heading; supplying it is what turns the title into the control.
      openSubjectRule: (messageId: string) => openSubjectRule(messageId, null),
      openAttachmentPreview: (messageId: string, attachmentId: string) =>
        setPreviewFor({ messageId, attachmentId }),
      conversationOf,
      bodyOf: bodyOfMessage, hydrateBody, hydrateThread,
      attachments, remoteImages,
      // The action bar's open destination strip — held here for the mounted-twice reason the
      // reply draft is (a strip opened by key in the column must be the strip the sheet
      // shows). Keyed by message id in the value itself; cleared on focus moves below.
      barPanel, setBarPanel,
    }),
    [ownAddresses, absoluteTime, toggleAbsoluteTime, replyTo, replyAll, replyMode, replyBody, onReplyBody, closeReply, sendReply, mailSend, draftReplyChrome,
      replyEnvelope, replyFromId, replyAttachments, replySig, replySubjectEdit,
      onReplySig, onReplySubject,
      consent.signatures, consent.signaturesHtml, consent.signaturesKnown,
      sendSurfaceMaxTotalBytes, replyBook,
      openSenderMenu, ownNameOf, writeTo, openReply, openForward, openSubjectRule,
      conversationOf, bodyOfMessage, hydrateBody, hydrateThread, attachments, remoteImages,
      consent.foldersEnabled, reader, barPanel],
  );

  // Resolved here rather than inside the popover so a sender whose last message has just
  // been moved out from under it closes the popover instead of rendering an empty one.
  const senderMenuFor = useMemo(
    () => (senderMenu ? senderScreening(reader, senderMenu.messageId, senderMenu.address) : null),
    [senderMenu, reader, version],
  );

  // Same shape and the same `version` dep as above, for the same reason: a message whose row has
  // just been moved out from under the sheet closes it rather than rendering an empty one, and a
  // memo that forgot `version` would show a stale token count after a sync drain.
  const subjectRuleFor = useMemo(
    () => (subjectRule ? subjectRuleContext(reader, subjectRule.messageId) : null),
    [subjectRule, reader, version],
  );

  /**
   * THE TWO APP-LEVEL CONTROLS, AT THE FOOT OF THE RAIL.
   *
   * They were a fixed capsule floating bottom-centre over every view. That cost two things: a
   * clearance band at the bottom of every scrolling surface so the last row was not under the
   * pill (132px, in four stylesheets), and two controls permanently on top of somebody's mail.
   * Neither acts on mail — one opens the palette, one switches the theme — so they belong with
   * the rest of the app's own chrome, which is the rail.
   *
   * Written in the RAIL'S vocabulary, not in a component of their own: `.ritem` rows with the
   * keycap in `.cnt`, exactly as the Search row carries "/". A row that looks like a rail row
   * and is a rail row needs no new idiom to learn and no second stylesheet to keep in step.
   *
   * ONE LINE, NOT TWO. Command keeps the full-width row and its keycap; the theme control is an
   * icon at the right end of that same line. Two stacked rows spent a second line of the rail's
   * foot on a control that is a single glyph's worth of meaning, and pushed the account line up
   * by that much on every viewport.
   *
   * The theme button is therefore the one thing here WITHOUT visible text, so it carries its
   * name twice over: `aria-label` for assistive tech and the palette-less keyboard path, `title`
   * for the pointer user who needs to identify a lone glyph. Dropping either leaves a button
   * whose only description is a sun. The palette still carries the same action by name
   * ("Toggle light / dark"), so nothing about switching the theme is reachable only by icon.
   *
   * On a phone these ride the navigation drawer, which is the same rail. See `touch-keys.css`
   * for why the keycap goes away there and the Command label does not.
   */
  const railDock = (
    <>
      <button type="button" className="ritem dock-cmd" onClick={palette.openPalette}>
        {t("dock.command")}
        <span className="cnt">
          <Kbd>{modCap}K</Kbd>
        </span>
      </button>
      <button
        type="button"
        className="ritem dock-theme"
        onClick={theme.toggle}
        aria-label={t("dock.theme")}
        title={t("dock.theme")}
      >
        <Icon name="sun" />
      </button>
    </>
  );

  return (
    // `MailStateProvider` used to open here. It is now ABOVE this component
    // (`MailStateHost`) so the shell can READ the mailbox facts as well as publish them — see
    // the note there. Every surface that reports mailbox state is still inside it.
    <MessageChromeProvider value={chrome}>
    <div className="app-root">
      <div className="shell">
        {demo && !ribbonGone ? (
          <div className="demo-ribbon">
            <span>
              {t.rich("ribbon.label", { b: (chunks) => <b>{chunks}</b> })}
            </span>
            <button
              type="button"
              onClick={() => {
                setRibbonGone(true);
                // Dismissed for this render either way; a refused jar is announced once.
                durableSessionSet("ohmail.demo-ribbon", "gone", "demo.ribbon");
              }}
            >
              {t("ribbon.dismiss")}
            </button>
          </div>
        ) : null}

        {/* A FAILING SYNC, IN EVERY VIEW. Renders nothing while the loop is healthy,
            and nothing at all in the demo or on the desktop. A sibling of the deck rather
            than a child of any view, so it is outside every list's scroller and no view can
            forget it — see `SyncBar.tsx` for why that placement is the fix and the sentence
            is not.

            THE NARROW-WIDTH COPY. Above 900px the rail is standing and carries this line
            itself (`sync` on the rail below); this one is hidden there by `app.css`. Under
            900px the rail is a drawer that is closed most of the time, so the strip and the
            corner pill are the only way the mailbox can speak, and they keep the job. */}
        <SyncBar hostOffline={hostConnection != null} />

        {/* THE COMPUTER THIS WINDOW READS THROUGH, when it is not answering — the narrow-width
            copy, on `SyncBar`'s rule and hidden above 901px by the same single query. It sits
            BELOW the sync strip deliberately: the strip is chrome about a process, this is a
            statement about what the window can do, and a standing fact under a transient reads
            in the right order. Absent from the DOM in every other case. */}
        {hostConnection ? (
          <HostConnectionLine connection={hostConnection} variant="shell" />
        ) : null}

        {/* CHANGES THE SERVER WOULD NOT TAKE. Beside the sync line rather than inside it, because
            `SyncBar` renders nothing when sync has nothing to say — which is exactly the state an
            abandoned change is most likely to be in: the mailbox is fine, one verb is not. Absent
            from the DOM when there are none, like every other strip the shell mounts once. */}
        <UnsavedChanges variant="shell" />

        {/*
            A NEWER OHMAIL, IN EVERY VIEW. The strip's sibling and its argument: rendered once by the shell so no view
            can forget it, outside every list's scroller, and absent from the DOM whenever there is nothing to say.
            What is on offer differs by door — a build this origin is already serving, or a signed release the desktop
            shell has fetched and verified — and this shell knows neither; `app-update.ts` holds the one offer and the
            once-a-day restraint on saying it. HELD WHILE A MESSAGE IS BEING WRITTEN. A strip appearing above somebody
            mid-sentence moves the layout under their cursor, and the press it offers throws the draft's window away.
            The offer is not withdrawn and not re-decided — it is simply not drawn until the compose is closed.
          */}
        <UpdateNotice quiet={effectiveView === "compose"} />

        {/* THIS BROWSER IS NOT KEEPING DECISIONS — the same slot and the same argument as the
            strip above: a fact about the app rather than about a pile. Said once per session and
            absent from the DOM until a durable write has actually been refused. */}
        <DurabilityNotice />

        <div className="topbar">
          <button
            type="button"
            className="tb-btn"
            aria-label={t("rail.openNav")}
            onClick={() => setRailOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <b>{mobileTitle}</b>
          {/* The worker doorbell, under 900px — the rail (whose foot carries the wide-width
              copy of this button) is a closed drawer here, and a refresh affordance inside a
              closed drawer is one nobody is told about. See `PullNewMail.tsx`. */}
          <PullNewMail variant="topbar" binding={pullBinding} />
          <button type="button" className="tb-btn" onClick={palette.openPalette}>
            {modCap}K
          </button>
        </div>

        <div className="deck">
          <ShellRail
            className={railOpen ? "open" : undefined}
            /* The default mark plus the Zero ribbon's ≡ — one hidden button, revealed ONLY
               by zero-layout.css at ribbon widths (`app.css` hides it everywhere at rest, so
               classic renders exactly what it rendered). At 722–899 and 392–721 the rail is
               a docked 52px ribbon and this is its drawer summon (`h`'s pointer twin); in
               the open drawer the same button reads as the way back. */
            wordmark={
              <>
                <b>
                  <em>oh</em>mail
                </b>
                <button
                  type="button"
                  className="rail-expand"
                  /* The name follows the action (review finding, round 1): open at rest, close
                     while the drawer stands — a toggle whose label says the wrong verb
                     reads backwards to a screen reader. */
                  aria-label={railOpen ? t("rail.closeNav") : t("rail.openNav")}
                  aria-expanded={railOpen}
                  onClick={() => setRailOpen((o) => !o)}
                >
                  <Icon name="menu" />
                </button>
              </>
            }
            composeLabel={t("rail.compose")}
            onCompose={() => {
              setRailOpen(false);
              go("compose");
            }}
            composeActive={route.view === "compose"}
            groups={railGroupsWithHints}
            activeId={activeRailId}
            onNavigate={(id) => {
              setRailOpen(false);
              // THE FIX. This was `if (id.startsWith("triage")) go("triage")`, which threw
              // away which of the three rows had been pressed — so Park and Resurface both
              // opened Answer Later, and the rail lit Answer Later either way.
              const pile = TRIAGE_PILE_OF_RAIL[id];
              if (pile) goTriage(pile);
              else go(id as "ohbox");
            }}
            activeTagId={route.tagId ?? undefined}
            onNavigateTag={(id) => {
              setRailOpen(false);
              goTag(id);
            }}
            mailboxesLabel={t("rail.mailboxes")}
            mailboxes={mailboxes.map((m) => ({
              name: (m as { name?: string }).name ?? displayAddress(m.address),
              hint: (m as { railHint?: string }).railHint ?? m.provider,
            }))}
            dock={railDock}
            /* THE MAILBOX'S OWN LINE, at the foot of the rail and above the dock. The same
               component and the same derivation as the strip below the topbar — one of the two
               is showing at any width, never both (see `SyncBar.tsx`). */
            sync={
              <>
                {/* The worker doorbell, above the mailbox's own line — an affordance beside the
                    status it acts on. Renders nothing in the demo and on builds with no Cloud
                    base; see `PullNewMail.tsx` for the honest-settle contract. */}
                <PullNewMail variant="rail" binding={pullBinding} />
                <SyncBar variant="rail" hostOffline={hostConnection != null} />
                {/* Same component at rail width — its own layout collapses under 520px, so the
                    rail does not need a second variant. */}
                <UnsavedChanges variant="rail" />
              </>
            }
            /**
             * The account line at the foot of the rail. The "Get ohmail for desktop" prompt shares that slot in the
             * signed-in BROWSER only, and it travels as the PURE platform branch (`offerDesktopCta` — never the
             * desktop app, never the demo); its DISMISSAL is `ShellRail`'s own persisted state, held down there so
             * the post-mount storage read re-renders the rail and not this whole component (see `ShellRail`). The two
             * contents do not coexist — `account` is a demo-only fixture (`/sync` emits no `view_meta`), and the
             * prompt shows only when `!demo`.
             */

            /**
             * `ShellRail` hands `RailNav` an `undefined` footer when NOTHING will render: `RailNav` keeps a padded
             * `.rail-mail` box for any truthy footer, so a footer whose every child renders null is a dead band under
             * the Command row — the exact defect the dismissal used to cause from inside `DesktopCta`.
             */
            footer={
              account?.email ? <span className="rail-mail-addr">{account.email}</span> : undefined
            }
            {...(hostConnection ? { hostConnection } : {})}
            offerDesktopCta={showDesktopCta({ demo, desktop: desktopSection != null })}
            ariaLabel={t("rail.ariaMain")}
          />

          {/* THE TWO COLUMN SEPARATORS. Rendered BETWEEN the rail and the stage because that
              is where they belong in the tab order — rail, the seam that resizes it, then the
              mail. They are out of flow (`position: absolute` in `column-handles.css`), so the
              deck's two-track grid is untouched by a third child; the list's own handle is
              portalled from here into whichever split view's list column is standing, because
              that column's left edge is a resolved grid track no `calc()` can name. See
              `ColumnHandles.tsx`. */}
          <ColumnHandles />

          <main className="stage" onClickCapture={onStageClickCapture}>
            {/* SETTINGS FOUND ON A MAILBOX — floated over whichever view (or the seed review)
                is up, never replacing it: an offer somebody may answer in a week must not gate
                today's mail. Above the seed deliberately, because the two overlap in subject —
                imported rules ARE screening decisions, and someone restoring a configured
                mailbox should meet the restore before the from-scratch consent walk. */}
            {profileImportOffer.offer ? (
              <ProfileImportCard
                offer={profileImportOffer.offer}
                phase={profileImportOffer.phase}
                onImport={profileImportOffer.importNow}
                onNotNow={profileImportOffer.notNow}
                onAcknowledge={profileImportOffer.acknowledge}
              />
            ) : null}
            {/* THE SEED REVIEW TAKES THE STAGE while it is owed. It decides what the Ohbox
                contains, so answering it before reading the piles is the order that makes the
                piles mean something — and "Later" leaves immediately, because it is an offer
                and not a gate. `window.location.reload()` on success rather than a local state
                flip: the confirmation wrote rules the mirror has not seen yet, and a shell
                that re-partitioned before the next sync drain would show the old answer with
                a new heading over it. */}
            {seedOwed ? (
              <SeedReviewView
                onDone={() => {
                  setSeedDismissed(true);
                  setSeedReopened(false);
                  if (typeof window !== "undefined") window.location.reload();
                }}
                /* Nothing was written, so nothing needs re-reading. The offer stands next
                   time this tab loads — it is not remembered on the server, because "not
                   now" is not an answer to "shall I let these people through" — and
                   Settings holds the door open for the rest of this one. */
                onLater={() => { setSeedDismissed(true); setSeedReopened(false); }}
              />
            ) : null}

            {/* THE VIEW, INSIDE A BOUNDARY. A render throw in any pile degrades to an in-pane
                failure card with the rail and the sync strip still standing, rather than Next's
                whole-tab "Application error". Keyed on `effectiveView` so navigating to another
                pile — still reachable, because the rail survived — clears a failed view. */}
            <ViewBoundary
              key={effectiveView}
              onError={(error) => console.error("[view] render failed", effectiveView, error)}
              fallback={
                <section className="view view-fail">
                  <div className="view-fail-card">
                    <h1>{t("viewError.title")}</h1>
                    <p>{t("viewError.body")}</p>
                    <Button
                      onClick={() => {
                        if (typeof window !== "undefined") window.location.reload();
                      }}
                    >
                      {t("viewError.action")}
                    </Button>
                  </div>
                </section>
              }
            >
            {effectiveView === "ohbox" ? (
              <OhboxView
                replyDone={replyDone}
                demo={demo}
                /* THE AWAY-RESPONDER NOTICE — the one state in which this product sends mail
                   on its own, made visible on the pane its owner actually reads. Same gate as
                   the settings row (`awaySection` below): absent on the demo, absent on a
                   standalone install, and absent unless the SERVER's own row says it is on.
                   `awayNotice.on` resting false means the fail-shape is a missing courtesy
                   line, never a false claim that replies are going out. */
                standingNotice={
                  (() => {
                    /* THE AWAY LINE IS THE LIST'S FIRST BLOCK, not a header tenant — see
                       `OhboxView.standingNotice` for why it moved and `AwayNotice` for the form
                       it takes by width. Its three-part gate is unchanged. */
                    const away = demo || !awaySupported || !awayNotice.on
                      ? null
                      : (
                        <AwayNotice
                          audience={awayNotice.audience}
                          throttle={awayNotice.throttle}
                          /* The pile scope, so the line states WHICH mail is answered and not
                             only who. Projected through the engine's own `awayEffectivePiles`
                             inside `useAwayNotice`, never re-derived here. */
                          piles={awayNotice.piles}
                        />
                      );
                    return away ?? undefined;
                  })()
                }
                noticeSection={
                  (() => {
                    /* Two possible lines share the header slot: the Option B ohmarchy offer
                       (above, so a fresh Linux sign-in sees it first) and the organizer notice.
                       Each keeps its own gate; the slot is undefined only when both are absent,
                       so OhboxView's spacing never reserves an empty band. */
                    /**
                     * ONE ASK AT A TIME ON A FIRST RUN: MEASURED on the released 0.13.7: at +15 s after connecting a
                     * mailbox a person faced THREE asks at once — the setup flow's modal, the OS "Open email links
                     * with ohmail?" prompt stacked over the flow's own Continue and Cancel row, and this banner
                     * behind both. `route.firstRun` is the stage's own gate (see the mount below), so this is the
                     * same condition rather than a second opinion about it. WAITS, not withheld: `faceOffer.eligible`
                     * is unchanged and the banner is there the moment the flow closes — a first run is the one visit
                     * where somebody has a screen full of decisions already.
                     */
                    const offer = faceOffer.eligible && applyFaceAllDevices !== null
                      && !route.firstRun
                      ? <OhmarchyOffer apply={applyFaceAllDevices} onDone={faceOffer.dismiss} />
                      : null;
                    /**
                     * AND THE ORGANIZER NOTICE, THE SLOT'S OTHER TENANT: Below the offer, and the order is the amount
                     * of decision each one asks for: the offer proposes something, this reports something that
                     * already happened. (The away line, which states a standing setting, is the list's first block
                     * now — `standingNotice` above.) Its own gate is inside the component (it renders nothing without
                     * an unacknowledged change), so the only thing decided here is whether there is any way to
                     * acknowledge — see `acknowledgeOrganizerNotice`. Withheld on the demo, which has no row to stamp
                     * and no other install to change hands with.
                     */

                    /**
                     * THE TRANSPORT ITSELF is the condition, not the callback: the callback is stable and always
                     * present (it holds no render scope, which is why), so the honest question is whether either door
                     * supplied a way to write the stamp. A notice that cannot be acknowledged is withheld.
                     */
                    const organizer = demo || organizerNoticeTransport === undefined
                      ? null
                      : (
                        <OrganizerNotice
                          notices={organizerChanges}
                          onAcknowledge={acknowledgeOrganizerNotice}
                        />
                      );
                    return offer === null && organizer === null
                      ? undefined
                      : <>{offer}{organizer}</>;
                  })()
                }
                resurfaced={ohbox.resurfaced}
                newForYou={ohbox.newForYou}
                previouslySeen={ohbox.previouslySeen}
                threadParticipants={participantsOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                threadSubject={threadSubjectOf}
                tags={tags}
                now={now}
                selectedId={selectedOhbox?.id ?? null}
                onSelect={setOhboxSel}
                /* The ID travels, and that is not tidiness. This was `() => setReaderOpen(true)`
                   against a reader hard-wired to `selectedOhbox`, so the indirection hid a
                   staleness: `OhboxView.open` calls `onSelect(id)` and this in the SAME tick,
                   so the shell's `selectedOhbox` here is still the PREVIOUS row. With the
                   reader holding an id of its own, reading that stale value would open the
                   message the user was on before the one they tapped.

                   It is `enterReader` and no longer `setReaderFor` — see the gate above. */
                onEnterReader={enterReader}
                onMarkSeen={markSeen}
                /* The view's armed read, held for the reader sheet's verb — see `ohboxArmedRead`. */
                onReadArmed={setOhboxArmedRead}
                /* WHICH MESSAGE THE SHEET IS SHOWING, so the view can tell when it CLOSES.
                   Reading is committed on the way out of a message, and at a width with no
                   reading column dismissing the sheet is the way out — often the only one, since
                   a phone reader taps in, reads, and taps back without ever moving the cursor.
                   The view owns that decision, including the width test that makes a desktop
                   sheet-close not a departure; the shell owns the sheet, so the state has to
                   travel. Nothing else in the view reads it. */
                readerId={readerFor}
                doorbellInitials={waitingLive.map((w) => w.initial)}
                doorbellHues={waitingLive.map((w) => avatarHue(w.from.address))}
                doorbellCount={screener.waitingCount}
                /* May this view state its emptiness as a fact yet? Derived once in
                   `mail-state.ts`; see `MailState.settled`. */
                settled={mailState.settled}
                onDoorbell={() => go("screener")}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                onDropTag={dropTag}
                bulk={bulkVerbs}
                /* Mail from beyond what this device kept — see `shell/older-mail.ts`. Built in
                   the shell because the hook needs the engine, and this view is mounted without
                   one by several tests. It is inert on a client whose mirror IS the mailbox. */
                older={older}
                onMarkAllRead={markAllRead}
              />
            ) : null}

            {effectiveView === "reads" ? (
              <ReadsView
                threadParticipants={participantsOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                partition={partition}
                tags={tags}
                now={now}
                cur={readsCur}
                onCur={setReadsCur}
                aiChip={aiChip}
                chipState={chipState}
                onChipState={setChipState}
                markSeen={readsMarkSeen}
                onLeaveSeen={commitReadsSeen}
                bodyOf={bodyOfMessage}
                hydrateBody={hydrateBody}
                remoteImages={remoteImages}
                jumpTo={jump?.view === "reads" ? jump.id : null}
                onJumped={() => setJump(null)}
                closeTo={closeCard?.view === "reads" ? closeCard.id : null}
                onClosed={() => setCloseCard(null)}
                onAction={onStreamAction}
                onMarkAllRead={markAllRead}
              />
            ) : null}

            {effectiveView === "receipts" ? (
              <ReceiptsView
                threadParticipants={participantsOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                messages={receipts}
                waterline={receiptsPartition.waterline}
                /* THE LINE'S POSITION, NOT THE BADGE. `freshCount` slices this view's list —
                   it is `receiptsPartition.fresh.length`, the count of rows ABOVE the anchor,
                   and the waterline is drawn between the two halves it cuts. `receiptsNew`
                   (the rail's number) is the same prefix INTERSECTED with what is still unread
                   on the server, which is smaller whenever this device's line is stale — and
                   passing it here would slide the line up over rows that are genuinely above
                   it. Two questions, two numbers, and only one of them is positional. */
                freshCount={receiptsPartition.fresh.length}
                /* …and the badge, separately: what the pane's headline SAYS. Same field as the
                   rail (`receiptsNew`), so the two numbers on screen cannot disagree. */
                newCount={receiptsNew}
                tags={tags}
                now={now}
                cur={receiptsCur}
                onCur={setReceiptsCur}
                unreadCount={receiptsUnread}
                isUnread={receiptsIsUnread}
                /* The per-card dwell mark — a glance, like Reads' `readsMarkSeen`, batched the
                   same way, and labelled so the engine holds a resurfaced row's pin back from
                   it (the label rides the batcher's one mutation). */
                markSeen={receiptsMarkSeen}
                onLeaveSeen={commitReceiptsSeen}
                bodyOf={bodyOfMessage}
                hydrateBody={hydrateBody}
                remoteImages={remoteImages}
                jumpTo={jump?.view === "receipts" ? jump.id : null}
                onJumped={() => setJump(null)}
                closeTo={closeCard?.view === "receipts" ? closeCard.id : null}
                onClosed={() => setCloseCard(null)}
                onAction={onStreamAction}
                onMarkAllRead={markAllRead}
              />
            ) : null}

            {effectiveView === "screener" ? (
              <ScreenerView
                state={screener}
                /**
                 * Bound HERE, at the render, to the exact list the state computed this frame — so the set that gets
                 * priced and the set that gets bought are one list rather than two computations that agree today.
                 * WITHHELD WHEREVER THERE IS NO SERVER TO ASK, and `demo` was never the whole of that. The desktop
                 * app is not the demo — it shows somebody's real mail — and it has no Cloud API at all, so this
                 * control rendered there, offered a button, and answered every press with "that did not work": a
                 * control with nothing behind it, which is the one thing this surface must never be. The condition is
                 * now the same one `AutoOptInControl.supported` uses, and the host that DOES have a way to ask brings
                 * its own control below.
                 */

                /**
                 * Read off `autoOptIn.supported` rather than by calling `apiConfigured()` here, so "is there a server
                 * to ask" has ONE answer in this file and this shared shell keeps its standing rule of not importing
                 * the Cloud API client.
                 */
                /* BOTH HALVES OF THE QUEUE, and the second one is why the control no longer
                   vanishes on a worked account. `unsuggestedSenders` is what a purchase buys;
                   `suggestedSenders` is what a re-ask covers, and it is the count the resting
                   state states. Bound at the same render for the same reason the first is —
                   the set that gets priced and the set that gets bought are one list. */
                suggest={
                  demo || !autoOptIn.supported || screenerSuggest
                    ? undefined
                    : suggestions.forSenders(
                        screener.unsuggestedSenders,
                        screener.suggestedSenders,
                      )
                }
                /* THE HOST'S OWN CONTROL, when it has one — see the prop's declaration. It is
                   bound to the same list and lands its answers in the same overlay, so the
                   rows, the count and "Apply all" cannot tell where the advice came from. */
                suggestNode={
                  demo || !screenerSuggest
                    ? undefined
                    : screenerSuggest({
                        senders: screener.unsuggestedSenders,
                        resuggestable: screener.suggestedSenders,
                        absorb: suggestions.absorb,
                      })
                }
                segment={route.screenerSegment}
                selection={scnSel}
                onSelect={(segment, id) => setScnSel((s) => ({ ...s, [segment]: id }))}
                /* Same flag, same reason — the Screener's "No one's waiting." and its
                   "all clear" meta are the same claim the Ohbox was making. */
                settled={mailState.settled}
                hydrateBody={hydrateBody}
                /* The reading pane's remote-image consent chrome, so a held preview blocks
                   and gates images exactly as the pane does. Absent on the demo. */
                remoteImages={remoteImages}
                /* Unsubscribe, server-side, for the screened-out / spam previews. Absent on
                   the demo — the control is simply not offered where nothing can serve it. */
                onUnsubscribe={onUnsubscribe}
                /* The live Junk window — present only with "Use folders" on and a server to
                   read it from (§16.2/§16.7). Absent, the segment is the flag-off Spam pile.
                   `junkWindow.supported` is `apiConfigured()` answered by the hook's own
                   module, NOT `autoOptIn.supported`: the hosted desktop's suggest wire makes
                   the broader read true while its api client is the refusing stub, which
                   rendered a permanent loading state over the hidden Spam segment. */
                junk={
                  !demo && consent.foldersEnabled && junkWindow.supported ? junkWindow : undefined
                }
                full={screenerFull}
                onFull={setScreenerFull}
              />
            ) : null}

            {effectiveView === "triage" ? (
              <TriageView
                threadParticipants={participantsOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                piles={piles}
                pile={route.triagePile}
                onPile={goTriage}
                frDone={frDone}
                onStartFR={startFR}
                /**
                 * THE MESSAGE BEHIND A PILE ENTRY, read from the SAME reader the piles came
                 * from.
                 *
                 * `presented` and not `reader`: the piles are built over the presentation
                 * projection, so resolving an entry through the raw mirror would answer with a
                 * message sitting in a different place than the row the user clicked — the one
                 * discrepancy a two-pane view makes visible. `null` for a `triage_item` with no
                 * backing message, which the view renders as a static row.
                 */
                messageOf={(id) => presented.get<EngineMessage>("message", id) ?? null}
                tags={tags}
                now={now}
                /* The reader sheet, in place — the narrow width, where there is no column.
                   `setReaderFor` and not `openMessage`, for History's reason: a parked message
                   presents in no pile, so "open it where it lives" would navigate away from the
                   view that was showing it. */
                onOpen={(m) => setReaderFor(m.id)}
                hydrateBody={hydrateBody}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
              />
            ) : null}

            {effectiveView === "tag" && tagGroup ? (
              <TagView
                threadParticipants={participantsOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                tag={tagGroup.tag}
                messages={tagGroup.messages}
                tags={tags}
                now={now}
                /**
                 * IN PLACE — `setReaderFor`, not `openMessage`. A tag is a lens over every pile,
                 * and `openMessage` follows a row OUT of the lens into its home view (a tagged
                 * Receipt threw you into Receipts), the jump-away this replaces.
                 * The reader reads the message straight from the mirror over the tag, and the
                 * split layout reads it in the column instead — either way the tag stays up.
                 * The body hydrates through the `readerFor`-keyed effect, as History's does.
                 */
                onOpen={(m) => setReaderFor(m.id)}
                hydrateBody={hydrateBody}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                /* The verbs this view declares for itself — see `useMessageVerbs`. */
                onScreen={openSenderMenu}
                canDelete={canDeleteMessage}
                canReplyAll={canReplyAllTo}
                /* The same rename/delete verbs Settings uses — a tag is managed from its page. */
                admin={tagAdmin}
              />
            ) : null}

            {effectiveView === "folder" && openFolder ? (
              <FolderView
                threadParticipants={participantsOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                folder={openFolder}
                messages={folderMessages}
                tags={tags}
                /* The URL's open message — the reveal target: a deep search hit must mount
                   and select its row, or the locator polls for a row the window never built. */
                locateId={route.messageId}
                /* The reach past this device's window, keyed to THIS folder — and the reason
                   the empty state can be said at all (spec: never claim an empty folder until
                   the source is exhausted). */
                older={folderOlder}
                now={now}
                /* IN PLACE — `setReaderFor`, TagView's reason: the folder IS the message's place,
                   and `openMessage` would route it to a pile it does not present in. The row
                   TRAVELS with the open (`setReaderOffMirror`): a reach-past row is not in the
                   mirror, and a reader that can only resolve mirror ids would stay closed on
                   exactly the mail the reach-past just fetched. The mirror's own row still wins
                   whenever it exists — see `readerMessageFor`. */
                onOpen={(m) => { setReaderOffMirror(m); setReaderFor(m.id); }}
                hydrateBody={hydrateBody}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                /* The verbs this view declares for itself — see `useMessageVerbs`. */
                onScreen={openSenderMenu}
                canDelete={canDeleteMessage}
                canReplyAll={canReplyAllTo}
              />
            ) : null}

            {effectiveView === "history" ? (
              <HistoryView
                threadParticipants={participantsOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                messages={history}
                tags={tags}
                now={now}
                /**
                 * The reader, IN PLACE — not `openMessage`, and the difference is a defect
                 * rather than a preference.
                 *
                 * `openMessage` answers "open it where it lives", and where a History message
                 * lives is the INBOX — so it would navigate to the Ohbox and select a row that
                 * is not in the Ohbox's list, because the whole point of History is that this
                 * message does not present there. The reader takes an id and reads the message
                 * straight from the mirror, so it works for a message belonging to no pile.
                 *
                 * `setReaderFor` and not `enterReader`: in the SOLO list there is no reading
                 * column at any width, so the sheet is the only reading surface — the gate that
                 * suppresses the sheet where a column exists would leave the solo list unable to
                 * open anything. The split layout has a column and reads there instead; the
                 * sheet is only its mobile fallback, where the column is `display:none` and this
                 * is again the one surface. Either way the body hydrates through the
                 * `readerFor`-keyed effect above.
                 *
                 * It is what makes decide-on-encounter work: the pane renders the full body and
                 * thread, and the sender menu inside it offers the screening decision with the
                 * sender's count and the explicit retro-apply — the same affordance as
                 * everywhere else, reached from the mail that prompted the thought.
                 */
                onOpen={(m) => setReaderFor(m.id)}
                /* The split reading column hydrates its own selection, the way ReadsView does. */
                hydrateBody={hydrateBody}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                /* The verbs this view declares for itself — see `useMessageVerbs`. */
                onScreen={openSenderMenu}
                canDelete={canDeleteMessage}
                canReplyAll={canReplyAllTo}
                onMarkAllRead={markAllRead}
              />
            ) : null}

            {effectiveView === "search" ? (
              <SearchView
                engine={engine}
                version={version}
                now={now}
                query={searchQuery}
                onQuery={setSearchQuery}
                onOpen={(hit: SearchHit) => openMessage(hit.message)}
                /* The chip on a hit answers "where do I go to find this again?", and for a
                   History message the folder and the place are different answers. The INDEX is
                   deliberately not projected — mail in History must stay searchable. */
                placeOf={consentView?.placeOf}
                onServerSearch={() => toast(t("search.toastServer"))}
                /* Esc's second press (the first clears the box) — back to the view `/` was
                   pressed in, falling to the Ohbox when this tab's session began in Search. */
                onExit={() => {
                  const back = searchFrom.current;
                  if (!back || back.view === "search" || (back.view === "tag" && !back.tagId)
                    || (back.view === "folder" && !back.folderId)) go("ohbox");
                  else if (back.view === "tag") goTag(back.tagId!);
                  else if (back.view === "folder") goFolder(back.folderId!);
                  else if (back.view === "screener") goScreener(back.screenerSegment);
                  else if (back.view === "triage") goTriage(back.triagePile);
                  else go(back.view);
                }}
              />
            ) : null}

            {/*
                `#/address/<addr>` — EVERYTHING FROM AND TO ONE CORRESPONDENT. The route parsed, the view existed, and
                every address control linked to it before this branch: `effectiveView` had no `address` case, so
                following an address put NOTHING on the stage under a URL naming a person. Nothing failed anywhere —
                the router was right, the view's own suite was green over a hand-mounted `AddressView`, and the
                address bar said what had been asked for. Seven props and no derivation here. `AddressView` composes
                the two halves of the answer itself through `shell/address-view.ts`, so this is a mount and not a
                place where a projection is computed: a whole-mirror derivation in the same render scope as this
                file's memoized callbacks is what the webview leak was made of.
              */}
            {effectiveView === "address" ? (
              <AddressView
                engine={engine}
                version={version}
                now={now}
                /* `parseHash` refuses an address branch with an empty segment, so this fallback
                   is unreachable from the router — and it is the shape the contract states a
                   corner for (a blank address is an answered question, not a pending one), which
                   is why it is written rather than asserted away with a `!`. */
                address={route.address ?? ""}
                onOpen={(hit: SearchHit) => openMessage(hit.message)}
                /* The same map Search labels a hit's chip from — "where do I go to find this
                   again?", which for a History message is not the folder. */
                placeOf={consentView?.placeOf}
                /* Escape is the step BACK, not a destination: `goAddress` is a hash assignment
                   and stacks a history entry (see `routing.ts`), so a reader who followed an
                   address out of Reads is returned to Reads and the keystroke agrees with the
                   browser's own Back. A tab whose only entry IS this hash — a pasted link, a
                   reload — has nothing behind it, and stepping back there would leave the
                   product on a keystroke meaning "close this"; the Ohbox is the floor. */
                onExit={() => {
                  if (window.history.length > 1) window.history.back();
                  else go("ohbox");
                }}
              />
            ) : null}

            {effectiveView === "compose" ? (
              <ComposeView
                engine={engine}
                draft={draft}
                fields={compose}
                onFields={onComposeFields}
                from={composeFrom}
                sendSurfaceMaxTotalBytes={sendSurfaceMaxTotalBytes}
                /* Server-confirmed only — before the live consent read lands the block cannot
                   render, so a signature is never drawn (or serialized) from a guess. */
                signatures={consent.signaturesKnown ? consent.signatures : undefined}
                signaturesHtml={consent.signaturesKnown ? consent.signaturesHtml : undefined}
                plan={plan}
                /* The row this compose is HOLDING decides too, not only the jar — see
                   `heldRowUnverified`. Read at render from the drafts the mirror holds, so it
                   arms and disarms with the data rather than with a flag somebody has to
                   remember to clear. */
                /* The hold is computed ONCE, here, and projected onto the send state — see
                   `heldRowUnverified`, which no longer reads the row itself. The row this compose
                   is holding is the persisted one, not the hook's: a parked reopen holds a row it
                   deliberately did not adopt. */
                send={heldRowUnverified(
                  mailSend.stateOf(COMPOSE_SEND_KEY),
                  readComposeRow(),
                  holdOf(engine, {
                    lane: COMPOSE_SEND_KEY,
                    draftId: readComposeRow(),
                    session: composeSessionId(),
                  }),
                  composeSessionId(),
                )}
                /* THE HOLD, AND THIS IS ITS ONE PRODUCER — pinned by the census.
                   The composer came up holding a message a send from the last session is still
                   carrying. Editing it there would change what the durable record names, and the
                   next press would mint a fresh Idempotency-Key for mail already on its way: the
                   server collapses two presses only under ONE key, so that is a second copy at the
                   recipient. Held rather than warned, because a warning is something to read past
                   and this cannot be taken back. `restoredPending` is keyed on WHICH MESSAGE, so a
                   new message started on the same lane is never held. */
                locked={mailSend.restoredPending(COMPOSE_SEND_KEY)
                  ? { sentence: t("compose.sendingFromLastSession") }
                  : null}
                onSend={sendCompose}
                onSendLater={sendCompose}
                onCancel={cancelCompose}
                /* THE HELD COMPOSE'S WAY OUT — the row this form is holding, and the same
                   callback the Drafts list's verbs dispatch. A held message with no row of its
                   own has nothing the server could resolve. */
                heldResolve={((): { draftId: string; onResolve: typeof resolveHeldSend } | null => {
                  const row = readComposeRow();
                  return row === null ? null : { draftId: row, onResolve: resolveHeldSend };
                })()}
              />
            ) : null}

            {effectiveView === "drafts" ? (
              <DraftsView
                drafts={drafts}
                scheduled={scheduled}
                now={now}
                onOpen={openDraft}
                onDiscard={discardDraft}
                onResolve={resolveHeldSend}
                onCancelSchedule={cancelSchedule}
                onEditScheduled={editScheduled}
                repliesHere={draftRepliesHere}
              />
            ) : null}

            {effectiveView === "trash" ? (
              <TrashView
                page={trashPage}
                live={
                  !demo && consent.foldersEnabled && trashWindow.supported ? trashWindow : undefined
                }
                tags={tags}
                threadParticipants={participantsOf}
                now={now}
                /* The URL's open message (`#/trash/m/<id>`) — a link into one deleted message,
                   which is the reveal target the window has to mount. */
                locateId={route.messageId}
                onOpen={(m) => setReaderFor(m.id)}
                hydrateBody={hydrateBody}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
              />
            ) : null}

            {effectiveView === "settings" ? (
              <SettingsView
                applyFaceAllDevices={applyFaceAllDevices}
                notifications={notifications}
                tags={tags}
                tagCounts={Object.fromEntries(
                  tagGroups.map((g) => [g.tag.id, g.messages.length]),
                )}
                rules={{ items: rules, onRevoke: revokeRule, onRetarget: retargetRule }}
                /* Rename and delete. Not gated on `demo`, unlike the four injected panes:
                   both are ordinary engine mutations, so the FixturesAdapter serves them out
                   of `mutationEffects` and the demo is correct with no special case. */
                tagAdmin={tagAdmin}
                /* `demo` is the ENGINE's answer, not the server's floor (see the note on
                   AppShell): `?demo=1` runs on fixtures with no session and no account, so
                   an Account pane there would offer to erase something that does not
                   exist. */
                /* Same demo rule again: Security is nothing but step-up ceremonies against a
                   session `?demo=1` does not have. */
                securitySection={demo ? undefined : securitySection}
                /* Same demo rule: every verb in the Invites pane is a step-up ceremony against a
                   session `?demo=1` does not have, and the pane exists only where the self-host
                   Cloud client wired it. */
                invitesSection={demo ? undefined : invitesSection}
                accountSection={demo ? undefined : accountSection}
                /* NOT demo-gated, and that is deliberate — see `AppShell`'s prop. The desktop
                   shell runs this client in demo mode, so gating this the way the four panes
                   above are gated would remove the pane from the only surface that has one. A
                   browser tab passes nothing, so `?demo=1` on the web still has no such pane. */
                desktopSection={desktopSection}
                /* The desktop's default-mail row on General — `desktopSection`'s rule: only the
                   desktop supplies one, a browser tab passes nothing, so there is nothing for
                   `?demo=1` to leak. */
                defaultMailSection={defaultMailSection}
                {...(notificationHost ? { notificationHost } : {})}
                /**
                 * DEMO-MASKED, unlike `desktopSection` directly above — and this line used to read
                 * `devicesSection={devicesSection}` with a comment whose premise ("a browser tab passes nothing") the
                 * Cloud Devices pane retired. With the seam unmasked, `?demo=1` in a signed-in browser grew a Devices
                 * entry — the one account pane that leaked — and opened onto the REAL device list with a live mint
                 * verb, every verb a cookie-authenticated credential mutation inside a UI that promises fixtures and
                 * zero network. The Cloud host also gates its node on the same flag (`useDevicePairing(demo)`), so
                 * this mask is the shared shell's own guarantee, not the only one.
                 */

                /**
                 * The desktop is unaffected: its gate wires the pane only on the standalone door with an engine
                 * behind it, which is never a `demo` render (a demo render there means the sample mount, whose shell
                 * reports no status for `hostDoorFor` to say "local" about).
                 */
                devicesSection={demo ? undefined : devicesSection}
                /* Same rule: `?demo=1` has no session, so "connect a mailbox" there would
                   be a form posting to a server this tab is not talking to. The demo keeps
                   the fixture list, which is the honest thing for it to show. */
                mailboxSection={demo ? undefined : mailboxSection}
                /* THE DOOR BACK TO THE REVIEW. Built here rather than injected from
                   `CloudShell` like the four panes above it, because the only thing it does
                   is flip this component's own state — the review is a stage view, not a
                   settings form, so the entry has to be able to reach `seedOwed`. Absent on
                   the demo for the same reason the others are: there is no server to read a
                   sent folder from. */
                seedSection={demo || !seedSupported ? undefined : {
                  label: t("seed.settingsLabel"),
                  /* No `SettingsSection` of its own — the Screener pane wraps the whole thing, and
                     this renders under its `seed.settingsLabel` subhead at the foot of it. */
                  node: (
                    <>
                      <p className="set-note-inline">{t("seed.reopenBody")}</p>
                      <div className="gate-actions">
                        <Button onClick={() => setSeedReopened(true)}>
                          {t("seed.reopenAction")}
                        </Button>
                      </div>
                    </>
                  ),
                }}
                /**
                 * THE AUTO-WORK OPT-IN. Built here rather than injected from `CloudShell` for the reason
                 * `seedSection` gives — it needs shell state — but a different piece of it: the flag has to be
                 * written through the SAME `useConsentState` the Screener's spender reads (`suggestions` above), or
                 * turning it off in Settings leaves this tab still authorised and the next Screener open buys a batch
                 * the user just revoked. `autoOptIn` is bound to `screener.unsuggestedSenders` here, at the render,
                 * so the set that is priced is the set that will be bought. `supported` is `wire.configured()`.
                 */

                /**
                 * It used to be `apiConfigured()` and this comment used to name that, which made it false of BOTH
                 * desktop doors: the row was withheld from a hosted install that has an account, an allowance and a
                 * balance behind it, for want of a way to ask — `CloudSuggest.tsx` states the consequence from the
                 * other side ("the setting that authorises it is written from a Settings row this app does not
                 * render"). A host that hands in a {@link suggestWire} has that way, and this is the row. A
                 * STANDALONE install hands in none: no server, no account, nothing to buy. `demo` is withheld for the
                 * same reason as every other injected pane.
                 */
                autoSuggestSection={
                  demo || !autoOptIn.supported ? undefined : (
                    <AutoSuggestRow
                      on={consent.autoSuggest}
                      since={consent.autoSuggestAt}
                      control={autoOptIn}
                      setAutoSuggest={consent.setAutoSuggest}
                    />
                  )
                }
                /* The host's own section wins where there is one. On the desktop this shell's
                   `ScreeningSection` reaches an API client that is not in that build and renders
                   nothing at all, which is a Screener pane present in the nav and blank when
                   opened. See `AppShell`'s prop. */
                /* "USE FOLDERS" — the folders feature's master toggle (FOLDERS-SPEC.md §6).
                   Built here, not injected, for `dormancySection`'s reason: it must write through
                   the SAME `useConsentState` the rail group and the folder views above are gated
                   on, or a flipped switch would leave this tab's rail where it was. Gated on
                   `consent.known` for the two rows' flash argument (a switch drawn before the
                   server answered shows OFF to an account that turned it ON). Absent on the demo.
                   Present on the desktop's hosted door, where `known` becomes true through its
                   transport.

                   AND GATED ON `foldersStorable` AS WELL, which is the clause the comment here
                   used to make as a claim about the standalone door — *"absent on a standalone
                   install (no consent row anywhere)"* — that stopped being true when the screening
                   window reached that door. `consentRoutes` are mounted on `localRoutes` now, so
                   the standalone engine answers `GET /consent` and `known` goes true; what it does
                   NOT serve is a single folder verb, so `packages/api`'s `withoutFoldersFlag`
                   forces the flag off on the read and drops it silently on the write. The pane
                   drew anyway: a master switch that flipped, stored nothing and snapped back, over
                   a per-mailbox list that governed nothing.

                   THE CAPABILITY IS DECLARED BY THE TRANSPORT, and that is where it can be
                   declared TRUTHFULLY on exactly one of the four wires — the standalone door's.
                   The sentence here used to end "because only the thing that built the wire knows
                   which route table is behind it", which is a claim about all of them and is false
                   of three: the browser's constant cannot interrogate its server, and the
                   desktop's hosted wire serves BOTH the managed door and the self-host one, which
                   is the same `{ mode: "cloud" }` pointed at a different table. See
                   {@link ConsentTransport.foldersStorable} for what each wire can honestly say and
                   for the `/hello` word that would settle all four at the server. */
                foldersSection={demo || !consent.known || !consent.foldersStorable ? undefined : (
                  <FoldersRow
                    on={consent.foldersEnabled}
                    /* THE NUDGE — mobile's folders-flag coordinator learned this first: the
                       flip RIDES THE DELTA, so without an immediate drain the rail answers on
                       the wake stream's schedule, and on a stream that is refused or mid-
                       reconnect that is the full safety cadence with the switch already ON.
                       One drain per confirmed write, after the echo — a refused write drains
                       nothing. The rethrow keeps the row's failed state working. */
                    setFoldersEnabled={async (enabled) => {
                      const r = await consent.setFoldersEnabled(enabled);
                      void engine.syncOnce().catch(() => { /* the poll owns retries */ });
                      return r;
                    }}
                    mailboxes={facts ?? undefined}
                    mailboxesOff={consent.folderMailboxesOff}
                    mailboxesKnown={consent.folderMailboxesKnown}
                    setMailboxFoldersEnabled={async (mailboxId, enabled) => {
                      const r = await consent.setMailboxFoldersEnabled(mailboxId, enabled);
                      void engine.syncOnce().catch(() => { /* the poll owns retries */ });
                      return r;
                    }}
                  />
                )}
                /* SIGNATURES — per-mailbox sign-off text (mail 0075). Built here, not injected,
                   for `foldersSection`'s reason: it must write through the SAME `useConsentState`
                   every compose surface's signature block reads, or a saved signature would not
                   reach an open composer until the next boot. Gated on `signaturesKnown` (the
                   editors render server-confirmed values only — a pane drawn before the live
                   read landed would show empty editors over stored text) and on the mailbox
                   facts being readable (an editor for an unnameable mailbox is a control over
                   nothing). Absent on the demo and wherever no consent row is reachable. */
                signaturesSection={
                  demo || !consent.signaturesKnown || !facts || facts.length === 0 ? undefined : (
                    <SignaturesRow
                      mailboxes={facts}
                      signatures={consent.signatures}
                      signaturesHtml={consent.signaturesHtml}
                      setMailboxSignature={consent.setMailboxSignature}
                    />
                  )
                }
                screeningSection={demo ? undefined : (screeningSection ?? <ScreeningSection />)}
                /* THE DORMANCY DIAL. Like `autoSuggestSection`, built here rather than injected from
                   `CloudShell` because it must write through the SAME `useConsentState` the
                   partition memo reads (`consentPartition` above is keyed on `consent.dormancyDays`),
                   or a moved dial would leave this tab counting with the stale window. Gated on
                   `consent.known` so it renders only once the server's real window has landed —
                   showing the RESTING default first and snapping to the stored value is the
                   wrong-then-right flash `ScreeningSection` avoids by loading before it draws. Absent
                   on the demo (`useConsentState(!demo)` never fetches, so `known` stays false). */
                dormancySection={demo || !consent.known ? undefined : (
                  <DormancyRow days={consent.dormancyDays} scope={consent.screeningScope}
                    setDormancyDays={consent.setDormancyDays} />
                )}
                /**
                 * REMOTE IMAGES. Gated on `consent.known` for a sharper version of the dial's reason: the resting
                 * value is MANUAL, so drawing the row before the server has answered would show a switch in the OFF
                 * position to an account whose stored setting is ON — and somebody who then left it alone would
                 * believe they had chosen the state they were merely shown. Absent on the demo (no server). AND ON
                 * EVERY DESKTOP DOOR, INCLUDING THE HOSTED ONE, which is the clause a `consentTransport` made
                 * necessary: `known` becomes true there, and this row would then govern a mechanism that does not
                 * exist in the window.
                 */

                /**
                 * Consented images load through `GET /img` on THIS ORIGIN — the proxy is what keeps the reader's
                 * address away from the sender, and the same-origin url is what carries the session cookie and
                 * satisfies the frame's `img-src 'self'`. A window under `connect-src 'none'` has no such origin and
                 * `useRemoteImages` hands back nothing at all there (`remote-images.ts`), so the switch would store a
                 * preference and change no picture. `cloudClient` is exactly that build fact, and it is checked
                 * rather than `remoteImages !== undefined` only because it names WHY.
                 */
                remoteImagesSection={demo || !consent.known || !consent.cloudClient ? undefined : (
                  <>
                    <RemoteImagesRow
                      blocked={consent.blockRemoteImages}
                      setBlockRemoteImages={consent.setBlockRemoteImages}
                    />
                    {/* THE PIXEL SWITCH, under the same gate for the same reasons: it governs the
                        proxy's treatment of a beacon, and a window with no proxy has nothing for
                        it to govern. Rests ON (blocked), so the `known` guard here protects the
                        opposite flash from the row above: drawing it before the server answers
                        would show ON to an account that turned it off. */}
                    <TrackingPixelsRow
                      blocked={consent.blockTrackingPixels}
                      setBlockTrackingPixels={consent.setBlockTrackingPixels}
                    />
                  </>
                )}
                /**
                 * AUTO-UNSUBSCRIBE ON SCREEN-OUT. Gated on BOTH `consent.known` and `autoOptIn.supported`, and each
                 * gate answers a different question. `known` is the flash argument the two rows above make, pointing
                 * the other way: this switch rests ON, so drawing it before the server has answered would show it ON
                 * to an account that turned it OFF — and somebody who then left it alone would believe they had
                 * chosen the state they were merely shown. `supported` is the structural one, and it is why this is
                 * not simply `known`: a STANDALONE install wires no unsubscribe service into its screener at all, so
                 * nothing there could be switched off, and a control drawn on that build would store nothing and
                 * govern nothing.
                 */

                /**
                 * It used to read `apiConfigured()`, which also excluded the desktop's HOSTED door — where the
                 * screening decisions this flag qualifies are forwarded to the account and the hosted pass is what
                 * sends the request, so the switch governs exactly what it says it does. That door hands in a wire;
                 * the standalone door hands in none and is still excluded. Withheld from the demo like every other
                 * injected pane.
                 */
                autoUnsubscribeSection={demo || !consent.known || !autoOptIn.supported ? undefined : (
                  <AutoUnsubscribeRow
                    on={consent.autoUnsubscribe}
                    setBlockAutoUnsubscribe={consent.setBlockAutoUnsubscribe}
                  />
                )}
                /**
                 * THE AWAY RESPONDER — its OWN Settings section since it became the one control in the product that
                 * makes the app send mail unprompted, and a menu is where people look for that. This node IS that
                 * pane: absent ⇒ no pane and no nav entry, which is the whole of how the Cloud-only rule is expressed
                 * on screen. Gated on `awaySupported` and NOT on `consent.known`, unlike the two rows above: it holds
                 * no consent state and loads its own row, so it has nothing to flash the wrong way round.
                 */

                /**
                 * But the "is there anywhere to store this" gate is required, and for a stronger reason than the
                 * auto-suggest row's — the SENDER is a pass in the hosted worker, so a standalone install drawing
                 * this control would store a configuration that answers nobody, which is the built-and-unreachable
                 * shape this whole surface exists to remove, reintroduced one layer up. See `awaySupported` for the
                 * two ways it is true, and {@link awayTransport} for why the desktop's HOSTED door is one of them and
                 * its standalone door is not. The `onChanged` echo is how the Ohbox notice above hears a same-tab
                 * save without a refetch — the row reports what the SERVER answered, never what a click asked for,
                 * into the one `useAwayNotice` state the shell holds.
                 */
                awaySection={demo || !awaySupported ? undefined : (
                  <AwayResponderRow onChanged={awayNotice.update} transport={awayTransport} local={awayIsLocal ?? false} host={awayOnHost ?? null} />
                )}
                aiSection={demo ? undefined : aiSection}
                billingSection={demo ? undefined : billingSection}
                /* ABOUT — the one injected pane the demo also gets, because the demo has
                   something true to say here and no API to say it with. The live body comes
                   from the Cloud client (which mailbox, synced when, which build, and who
                   publishes this); the demo body is the two sentences that describe the
                   fixture world, which are only correct there. */
                aboutSection={
                  demo ? (
                    <SettingsSection>
                      <p className="set-note-inline">{t("about.p1")}</p>
                      <p className="set-note-inline">{t("about.p2")}</p>
                      <p className="set-note-inline">{t("about.keys")}</p>
                    </SettingsSection>
                  ) : (
                    aboutSection
                  )
                }
                /* THE ROUTE'S PANE — `#/settings/<pane>` controls the section; the bare hash
                   leaves the view's own deep-link logic (`?settings=`) in charge. A nav click
                   writes the hash (`goSettings`), so sections stack in history and Back/Forward
                   walk them. The Screener's offer travels the same road now — see
                   `openSettingsPane`. */
                pane={route.settingsPane ?? undefined}
                onSelectPane={goSettings}
              />
            ) : null}
            </ViewBoundary>
          </main>
        </div>
      </div>

      {railOpen ? (
        <div
          className="rail-bg open"
          aria-label={t("rail.closeNav")}
          onClick={() => setRailOpen(false)}
        />
      ) : null}

      {/* READING — the exhale. Escape is the registry's (see `escapeCascade`): with the
          reader owning it too, closing the inline reply would also close the message it
          was quoting, in the same keypress. */}
      <Reader
        open={readerMessage != null}
        ariaLabel={t("reader.pane")}
        returnHint={t("reader.hintReturn")}
        closeOnEscape={false}
        /* NON-MODAL exactly at the Zero push tier (review finding, round 1): there the sheet is
           the reading TILE beside a live, operable ribbon, and `aria-modal` would tell
           assistive tech that chrome is unreachable. Under 392 the same sheet is the
           full-screen classic model and stays modal. `pushTier` is SUBSCRIBED (review
           finding, round 2) — it follows `w` and a resize across the band with the sheet
           still standing. */
        modal={!pushTier}
        onClose={() => setReaderFor(null)}
        /* The on-screen back control's accessible name — the stylesheet shows the control at
           phone width, where the esc hint is suppressed for coarse pointers and the backdrop
           does not read as tappable. The component's own default is English. */
        closeLabel={t("reader.back")}
      >
        {sheetMessage ? (
          <MessagePane
            /* Presented state, not stored state — see `ohboxArmedRead`. The ACTIONS still act on
               the real message: `sheetMessage` differs only in the `unread` the verb derives
               from, and `onMessageAction` receives the same id either way. */
            message={sheetMessage}
            tags={tags}
            now={now}
            onAction={(a) => onMessageAction(a, sheetMessage)}
            onAddTag={openTagPicker}
          />
        ) : (
          <span />
        )}
      </Reader>

      {/* QUICK LOOK — the attachment preview, above the reader. Mounted only while open, so its
          overlay-scope key bindings (Esc/←/→/↑/↓) exist exactly when it does, and its pdf.js
          document is torn down on close. Gated on a non-empty ready list so the derive-close
          transition never flashes an empty panel. */}
      {previewFor && attachments
        ? (() => {
            // `includeInlineImages: true` — the overlay's item list MUST be able to find the id it
            // was opened on, and an INLINE image (a picture attached `Content-Disposition: inline`,
            // shown in the message body) is a real, clickable tile in the strip whenever the body
            // renders as text (`MessagePane` lists them with `includeInlineImages: nativeBody`). The
            // overlay used to build its list WITHOUT inline images, so clicking such a picture found
            // no matching item — and when the message carried nothing BUT inline images the list was
            // empty and the overlay silently declined to open. Including them makes every tile the
            // strip can show openable, and it is the superset in every other case.
            const view = attachments.itemsOf(previewFor.messageId, { includeInlineImages: true });
            const previewItems = view.state === "ready" ? view.items : [];
            if (previewItems.length === 0) return null;
            return (
              <AttachmentPreview
                items={previewItems}
                activeId={previewFor.attachmentId}
                onActiveIdChange={(id) =>
                  setPreviewFor({ messageId: previewFor.messageId, attachmentId: id })
                }
                ensure={(aid, opts) => attachments.ensure(previewFor.messageId, aid, opts)}
                blobOf={(aid) => attachments.blobOf(previewFor.messageId, aid)}
                onDownload={(aid) => attachments.open(previewFor.messageId, aid)}
                onClose={() => setPreviewFor(null)}
              />
            );
          })()
        : null}

      {/* Reply Run */}
      <FocusReplyOverlay
        open={fr != null}
        step={fr?.step ?? 0}
        total={fr?.items.length ?? 0}
        message={
          frItem
            ? {
                subject: frItem.subtitle ?? "",
                from: frItem.title,
                preview: frItem.preview ?? "",
              }
            : undefined
        }
        /* THE SAME EDITOR THE INLINE REPLY USES, handed in rather than reimplemented.
           The run writes into the same per-message buffer, so anything less than the same
           grammar here would read somebody's formatted reply as flattened text and then
           store the flattening over it — see `FocusReplyOverlay`'s `editor` prop.

           Keyed on the step's message for the reason `InlineReply` keys its own: a document,
           a selection and an undo history all belong to one message, and stepping forward is
           exactly the moment they must not be carried over. */
        editor={
          frItem ? (
            <RichEditor
              key={frKeyOf(frItem)}
              className="fr-editor"
              ariaLabel={t("reply.editorAria")}
              placeholder={t("reply.placeholder")}
              autoFocus
              editable={frPhase !== "sending" && frPhase !== "queued"}
              value={frValues[frKeyOf(frItem)] ?? EMPTY_RICH}
              onChange={(v) => {
                setFrValues((vals) => ({ ...vals, [frKeyOf(frItem)]: v }));
                // Mirrored into the SAME per-message buffer the inline editor writes and
                // `settle` clears — so the run's text survives a reload exactly as the
                // editor's does, and a reply begun in one surface can be finished in the other.
                if (frItem.messageId) writeReplyDraft(frItem.messageId, v);
              }}
            />
          ) : undefined
        }
        /**
         * DONE SENDS. That is all it does.
         *
         * Through `useMailSend` and never `engine.mutate({kind:"mail_send"})`: the lock that
         * makes a second press within one tick a no-op is a ref inside that hook
         * (`mail-send.ts:203-215`, which names a Reply Run step as exactly the caller a
         * button's `disabled` cannot save), and a second key is a second reservation and a
         * second delivery to a real person. The send path never delivers twice.
         *
         * ── AN EMPTY TEXTAREA ───────────────────────────────────────────────────────────
         *
         * Nothing happens: no send, no advance, no discharge. `canSend` already refuses a
         * blank body — the server would accept and post one (`drafts-service.ts:167-171`) —
         * and Skip is the affordance for moving on without writing. Letting Done fall through
         * to Skip would put back a second way to leave a step having sent no mail, which is
         * the shape of the bug this change removes; the run stays put instead, and the pile
         * keeps the reminder.
         *
         * An entry with no `messageId` is refused for the same reason twice over: there is no
         * message to reply to, so there is nothing to send and nothing that could be paid.
         */
        onDone={() => {
          if (!frItem?.messageId) return;
          const v = frValues[frKeyOf(frItem)] ?? EMPTY_RICH;
          mailSend.send({
            kind: "mail_send",
            inReplyTo: frItem.messageId,
            // Same split as `sendReply`, and it has to be the same: the run and the inline
            // editor share one scratch buffer, so a reply begun in one and finished in the
            // other must go out as the same message either way.
            body: v.text,
            ...(v.html ? { html: v.html } : {}),
          });
        }}
        onSkip={() => fr && setFr({ ...fr, step: fr.step + 1 })}
        onClose={() => setFr(null)}
        doneLabel={
          frPhase === "sending" ? (
            t("reply.sending")
          ) : (
            <>
              {t("triage.frDone")}
              {/* The verb's chord (the run's own ⌘↵ binding) — the always-on-caps law. */}
              <Kbd>{modCap} ↵</Kbd>
            </>
          )
        }
        /* REFUSED FOR THE WINDOW THE EDITOR IS ALREADY READ-ONLY IN — `frPhase`, one derivation
           for both. The run and this message's inline editor are one lane on purpose, so the
           lock that keeps one press to one delivery would otherwise leave Done inert under a
           label reading "Sending…". Never a lane of its own: two keys for one message are two
           reservations and two copies at the recipient. */
        donePending={frPhase === "sending" || frPhase === "queued"}
        skipLabel={t("triage.frSkip")}
        copy={frCopy}
      />

      {/* Command palette */}
      <CommandPalette
        open={palette.open}
        onClose={palette.closePalette}
        commands={commands}
        placeholder={t("palette.placeholder")}
        emptyHint={t("palette.empty")}
        ariaLabel={t("palette.ariaLabel")}
        footNavigate={t("palette.footNavigate")}
        footRun={t("palette.footRun")}
        footClose={t("palette.footClose")}
      />

      {/* Tag picker */}
      {picker ? (
        <TagPicker
          state={picker}
          tags={tags}
          /* Over a SET, a tag is "assigned" only when EVERY message carries it.
             The alternative — any — would render a half-applied tag as done, so pressing it
             would remove it from the two that had it instead of adding it to the eight that
             did not. `pickerIds` is null for every single-message caller, which is the
             one-element case of the same rule. */
          assigned={tagsOnAll(reader, pickerIds ?? [picker.forId])}
          onToggle={(tagId, assigned) =>
            bulkToggleTag(pickerIds ?? [picker.forId], tagId, assigned)
          }
          onCreate={(name) => { createTag(picker.forId, name); setPicker(null); }}
          onClose={() => { setPicker(null); setPickerIds(null); }}
        />
      ) : null}

      {/* Sender screening — reachable from every list and every open message. */}
      {senderAudit ? (
        <SenderAuditPanel state={senderAudit} onClose={() => setSenderAudit(null)} />
      ) : null}
      {senderMenuFor ? (
        <SenderMenu
          state={senderMenu!}
          sender={senderMenuFor}
          // The address override travels on EVERY dispatch off this sheet, or the sheet would
          // show the chip's person and rule on the message's sender — the cc-chip guard names
          // this exact seam.
          onChoose={(dest, scope, makeRule) => changeScreening(senderMenu!.messageId, dest, scope, makeRule, senderMenu!.address)}
          autoUnsubscribe={autoUnsubscribeDiscloses}
          onOpenDetail={(scope) => openSenderAudit(senderMenu!.messageId, scope, senderMenu!.address)}
          // The subject sheet resolves the message's SENDER (`subjectRuleContext`), so under an
          // override the row is withheld rather than offered about somebody the sheet never named.
          onSubjectRule={senderMenu!.address == null ? () => openSubjectRule(senderMenu!.messageId, null) : undefined}
          onClose={() => setSenderMenu(null)}
        />
      ) : null}
      {/* The finer sibling: from this address AND with this in the subject. Resolved above so a
          sender whose last message has just been moved closes the sheet instead of rendering an
          empty one. */}
      {subjectRuleFor ? (
        <SubjectRuleSheet
          /* Keyed by message: the sheet prefills its editable match from the subject ONCE per
             mount, so a title press while another message's sheet is open must remount rather
             than carry the previous message's edit into this one's field. */
          key={subjectRule!.messageId}
          state={subjectRule!}
          ctx={subjectRuleFor}
          onConfirm={(term, dest, field) => confirmSubjectRule(subjectRule!.messageId, term, dest, field)}
          onClose={() => setSubjectRule(null)}
        />
      ) : null}

      {/* ── THE FIRST-RUN STAGE ────────────────────────────────────────────────────────────
          Over the app, at `#/first-run`, and gated on FOUR things rather than on the route
          alone:

           · `firstRun` — a door that can actually make the calls. Absent on the demo.
           · `route.firstRun` — the person asked for it, or an entry point sent them. The stage
             never opens itself; a dialog that appears over somebody's mail unbidden is the
             thing every entry point is written to avoid.
           · `onboardingFacts` — `GET /mailboxes` has answered. Null is "we cannot see", and
             the flow's second row reads a null mailbox as "none connected", which over an
             unreachable API would open setup on an account with five mailboxes.
           · `consent.known` — `GET /consent` has answered. `onboardingCompletedAt` RESTS null,
             and null means "never been through setup", so rendering before the wire replies
             would put a setup dialog over a finished account on every cold boot.

          The last two are the same rule twice: this overlay's resting inputs both read as
          "nothing has happened yet", so it may only be drawn on answers, never on defaults. */}
      {firstRun && route.firstRun && onboardingFacts && consent.known ? (
        <FirstRun
          host={firstRun}
          facts={onboardingFacts}
          mailboxId={firstRunMailbox?.id ?? null}
          /* WHICH mailbox this run is about, for the one screen that has to name it — the
             mailbox step once a mailbox exists, where the form is withheld and a statement
             stands in its place. */
          {...(firstRunMailbox?.address ? { mailboxAddress: firstRunMailbox.address } : {})}
          /**
           * WHEN THE HOLDER BECAME THE ORGANIZER, IN WORDS — AND NOTHING PASSED IT: `FirstRunProps.organizedSince` is
           * interpolated into `mailboxes.readerSince*` by two screens (the claim question's banner, and now a
           * reader's summary), and this mount — the only one there is — never supplied it. Both rendered "Since  ·
           * ohmail Cloud." with a blank where the date belongs, which is a sentence that reads as a bug about the
           * mailbox rather than about the copy. Withheld when the DTO names no instant, so the screens keep their own
           * "we do not know" arm instead of printing an empty one. A DATE, with no clock on it, and the same
           * formatting the desktop pane uses for the same sentence: this is a standing fact somebody reads once, and
           * a timestamp on it invites watching a heartbeat that is deliberately not persisted.
           */
          {...(holderSince ? { organizedSince: holderSince } : {})}
          serverMessageCount={firstRunMailbox?.serverMessageCount}
          /* The counters. `screened` is what the mirror holds MINUS what History lists —
             everything that has been through the screening partition — and `history` is that
             list's own length. Both are derived from the SAME presented reader the views
             render, so the numbers on this screen and the numbers in the rail cannot
             disagree. Clamped at zero: `history` is a projection over the mirror and a race
             between the two reads must not print a negative. */
          pull={{
            screened: Math.max(0, mirroredCount - history.length),
            history: history.length,
            mirrorCount: mirroredCount,
          }}
          decide={firstRunDecide}
          /* THE RE-RUN INTENT, off the route. See `Route.firstRunRerun`: it cannot be derived,
             because a finished account derives to "nothing to do" — which is right for a boot
             and wrong for somebody who just asked to run setup again. */
          rerun={route.firstRunRerun}
          /* THE ADD INTENT, off the route for the same reason the re-run's is: an install that
             has been through setup derives to "nothing to do", which is right for a boot and
             wrong for the press beside a list of mailboxes. It also carries the connect MODE —
             see `FirstRunHost.connect`, where the word is required and has no default. */
          add={route.firstRunAdd}
          /* WHICH ROW THE ADD RUN JUST MADE. The route is where "the mailbox this run is about"
             is written down, and an add run's hash names none until this fires — so the id goes
             into the hash and every later screen reads the mailbox that was added. A REPLACE
             rather than an assignment: the create is not a place somebody navigated to, and a
             history entry there would make Back walk into a form for a mailbox that now exists. */
          onConnected={nameFirstRunMailbox}
          /**
           * WHAT THE ACCOUNT ALREADY STORED, so a re-run shows the state it is about to change. `dormancyDays` is
           * always a number on this object; `screeningScope` rests `window`, which is what every build did before the
           * mode existed. AND ONLY WHERE SOMETHING IS ACTUALLY STORED, WHICH THIS PASSED UNCONDITIONALLY:
           * `FirstRunProps.screening` is documented "Absent on a first run, where there is nothing stored to show",
           * and this handed it the RESTING values on every run. Those rest at `DEFAULT_DORMANCY_DAYS` (60),
           * `initialWindow` snaps a stored 60 to the nearest offered rung, and 60 is nearer 90 than 365 — so a fresh
           * first run showed "90 days" pre-selected while the row beside it read "One year · usual".
           */

          /**
           * Measured on the released 0.13.6, on a fresh HOME: nobody had chosen 60, and the control was reporting a
           * product default as the person's own answer. `screeningBaselineAt` is the truth-condition for "an answer
           * exists": it is written by the consent transaction and by the first screener decision, and by nothing
           * else, and it rests null (the one consent field deliberately NOT filled in with a plausible value — see
           * `ConsentState.screeningBaselineAt`). Withheld, `initialWindow` answers 365, which is the number the flow
           * stores.
           */
          {...(consent.screeningBaselineAt
            ? { screening: { dormancyDays: consent.dormancyDays, scope: consent.screeningScope } }
            : {})}
          /* RE-READ `GET /mailboxes` — the route every write in this flow changes (the create,
             the claim, the consent stamp). The account's consent row re-reads itself: every
             consent-settings write appends a `settings` change row, the wake channel rings, and
             the stamp `useConsentState` watches moves on the next drain. So the two halves
             refresh by different mechanisms and neither is polled harder for this screen. */
          onRefresh={refreshFacts}
          onLeave={() => go("ohbox")}
        />
      ) : null}

            {/* The `?` sheet — generated from the registry above, never hand-written. */}
      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* THE (i) PANEL IS GONE, AND ITS CONTENT IS NOT.
          It was a floating button opening a dialog over the mail, holding three facts
          that are settings — which mailbox is connected, when it last synced, which build —
          and it was the only place they were readable. Facts do not need an overlay. They
          are a Settings pane now (`aboutSection`, below), which is where somebody looks for
          them and where they can be linked to; the two controls that act on what is on
          screen rather than describe it are at the foot of the rail (`railDock`). */}
    </div>
    </MessageChromeProvider>
  );
}
