"use client";

/**
 * The ohmail client shell: rail + views over ONE engine, the reader
 * exhale, the Reply Run, the ⌘K palette, the tag picker and
 * the demo ribbon. Every list, count and mutation runs through
 * @ohmail/client-engine — the shell only owns view state.
 */
import {
  useCallback,
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
  forwardSubject,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  feedPartition,
  receiptsByDay,
  waterlineIdOf,
  draftsList,
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
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type FeedView,
  type Folder,
  type OhmailView,
  type WaterlineMeta,
  type SearchHit,
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
  useDemoMode,
  useEngine,
  useEngineVersion,
  type OwnerResolver,
  type ProvidedEngine,
} from "./engine";
import { useOlderMail } from "./older-mail";
import { PLACE_LABEL, avatarHue, hueOf, initialsOf, resurfaceLabel, tomorrowNine } from "./format";
import { displayAddress, displayDomain } from "./idn";
import { MessagePane, type BulkAction, type MessageAction } from "./MessagePane";
import { AttachmentPreview } from "../components/AttachmentPreview";
import { dispatchMarkAll, dispatchMarkAllRead } from "./read-all";
import { useMessageAttachments } from "./attachments";
import { useRemoteImages } from "./remote-images";
import { useConsentState, type ConsentTransport } from "./consent-state";
import { readBootCache, writeBootCache } from "./boot-cache";
import { readOwner } from "./owner-cookie";
import { useAppLocale } from "./LocaleContext";
import { useScreenerState } from "./screener-state";
import { useScreenerSuggestions, type SenderSuggestion, type SuggestWire } from "./screener-suggest";
import { AutoSuggestRow } from "./AutoSuggestRow";
import { ScreeningSection } from "./ScreeningSection";
import { DormancyRow } from "./DormancyRow";
import { useComposeAutosave } from "./compose-autosave";
import { RemoteImagesRow } from "./RemoteImagesRow";
import { AutoUnsubscribeRow } from "./AutoUnsubscribeRow";
import { AwayResponderRow, type AwayTransport } from "./AwayResponderRow";
import { AwayNotice, useAwayNotice } from "./AwayNotice";
import { ProfileImportCard, useProfileImport, type ProfileImportTransport } from "./ProfileImportCard";
import { COMPOSE_SEND_KEY, useMailSend, readReplyDraft, writeReplyDraft } from "./mail-send";
import {
  clearComposeDraft,
  composePlan,
  readComposeDraft,
  writeComposeDraft,
  EMPTY_COMPOSE,
  type ComposeFields,
  type MailSend as MailSendMutation,
} from "./compose";
import { appendRich, EMPTY_RICH, isRichEmpty, type RichValue } from "./rich-text";
import { useDraftReply, type DraftedReply } from "./draft-reply";
import { RichEditor } from "./RichEditor";
import { TagPicker, placePicker, type TagPickerState } from "./TagPicker";
import { KeymapProvider, useKeyBindings, type KeyBinding } from "./keymap";
import { ShortcutSheet } from "./ShortcutSheet";
import { SyncBar } from "./SyncBar";
import { MailStateProvider, useMailState, type MailboxProbe } from "./MailStateProvider";
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
import { MessageChromeProvider } from "./message-chrome";
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
import {
  go, goScreener, goTag, goTriage, useHashRoute,
  type Route, type ScreenerSegmentId, type TriagePileId,
} from "./routing";
import { HistoryView } from "../views/HistoryView";
import { SeedReviewView } from "../views/SeedReviewView";
import { OhboxView, type OhboxReplyDone } from "../views/OhboxView";
import { ReadsView, type ReadsChipState } from "../views/ReadsView";
import { ReceiptsView } from "../views/ReceiptsView";
import { ScreenerView } from "../views/ScreenerView";
import { SearchView } from "../views/SearchView";
import { SettingsView, type MailboxEntity, type NotificationsMeta, type PaneId } from "../views/SettingsView";
import { TagView } from "../views/TagView";
import { TriageView } from "../views/TriageView";
import { ComposeView } from "../views/ComposeView";
import { DraftsView } from "../views/DraftsView";
import { usePersistedFlag, UI_KEYS } from "./persisted-ui.js";

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

/** The `boot-cache.ts` scope for the account's own addresses. See `ownAddresses` below. */
const OWN_ADDRESSES_BOOT_SCOPE = "own-addresses";

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
  | { kind: "reader"; id: string };

/**
 * @param narrow   the reading column is `display:none` — under 900px, `app.css`.
 * @param rowFor   the Screener row that speaks for this sender, or null when none is held. A
 *                 null answer routes the hit to the READER, not to a rowless Screener queue —
 *                 see the screener arm.
 * @param placeOf  the consent cutline's presentation map, or undefined when there is no
 *                 partition (demo, desktop, or before `GET /consent` lands). See below.
 * @param holds    does that pile actually hold this message? Optional; absent means "no pile
 *                 knowledge", which routes exactly as this function did before it existed — the
 *                 state a harness mounted without a shell is in. See below.
 *
 * ── PRESENTATION BEFORE PHYSICAL FOLDER, OR THE HIT LANDS IN THE WRONG PILE ──────────────
 *
 * The consent cutline SHOWS a message somewhere other than its folder without moving it on the
 * server: an active-undecided sender's INBOX mail presents in the Screener, a dormant one's in
 * History, and a decided sender's Screener mail presents in the Ohbox. `SearchView` already
 * reads `consentView.placeOf` to label a hit's chip with where it lives — but opening the hit
 * routed by `m.folder`, so a message presenting in the Screener was navigated to the Ohbox,
 * where its row does not exist and the locate flash times out against a pile it was never in.
 * The reported "brings me to the mail in the screener but does not select it" was the SAME hit
 * on the day its folder happened to agree with its presentation; this is the day it does not.
 *
 * So consult `placeOf` first. It is total over the mirror (`consent-cutline.ts`), so a `get`
 * that returns `undefined` means "no partition considered this message" — demo/desktop, or a
 * folder outside the presented set — and only THEN is the physical folder the honest answer.
 * `null` is History, which is pile-less by construction: a message there belongs to no list, so
 * the reader is the only surface that can show it — the same choice `HistoryView`'s own `onOpen`
 * makes, and the reason there is no "history" list-row to locate.
 *
 * ── AND PARKED MAIL IS PILE-LESS IN THE SAME SENSE ────────────────────────────────────────
 *
 * @param parked `parkedMessageIds` — mail the reader filed under Answer Later, Set aside or
 * Resurface. Since a mail is in exactly one pile, no Ohbox group lists these rows
 * (`selectors.ts#OhboxView`), so the `ohbox` arm below would name a surface that cannot show the
 * message — the one thing this function's type exists to prevent. Without this arm, clicking a
 * search hit for a message you had answered-later navigated to the Ohbox, found no row, selected
 * nothing and flashed nothing: the identical dead end the `placeOf` paragraph above describes,
 * reached through triage state instead of through consent.
 *
 * Answered with the READER for the reason History is: the surface that needs no list. Routing to
 * the pile itself would be better and is deliberately not done here — `OpenTarget` has no triage
 * arm, the Triage view shows one message per pile behind a segmented control rather than a
 * locatable list, and inventing that navigation is a larger change than the hole needs.
 *
 * ── AND THE PILE HAS TO ACTUALLY HOLD IT, WHICH `placeOf` CANNOT ANSWER ───────────────────
 *
 * The Screener arm has always asked this question (`rowFor`), and `parked` above is the same
 * question asked of one specific reason a row is absent. `holds` is the GENERAL form of it, put to
 * the very lists the views render, and there are two ways for a message to need it.
 *
 * The reachable one is the ARCHIVE. Search runs two passes and the second is `GET /search` over
 * the whole corpus, which returns mail this device's mirror does not hold at all (`SearchView`
 * marks those hits, and the browser's mirror is a window over a server that keeps everything —
 * see `older-mail.ts`). `placeOf` is built from the mirror, so it says nothing about such a row
 * and the hit routes by the folder on the wire item: the shell then navigates to Reads, sets a
 * cursor to an id no card and no row carries, and the reader is left looking at a pile with the
 * message they asked for nowhere in it. The Ohbox arm is the same — `selectedOhbox` is a `find`
 * over the pile, so it resolves to null and the reading column shows nothing.
 *
 * The second is any disagreement between a presentation map and the list a selector actually
 * built. It should not happen; the point of asking is that it does not have to be trusted.
 *
 * `holds` is that question, and the answer for a message no pile holds is the same one History and
 * a parked row get: the reader, in place. Search must open what it found.
 */
export function openTargetFor(
  m: EngineMessage,
  narrow: boolean,
  rowFor: (m: EngineMessage, segment: ScreenerSegmentId) => string | null,
  placeOf?: ReadonlyMap<string, Folder | null>,
  parked?: ReadonlySet<string>,
  holds?: (view: "ohbox" | "reads" | "receipts", id: string) => boolean,
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
  // A folder no view owns. `Folder` is a closed six-member union today, so this is not
  // reachable from the wire — see `openMessage` for why it is written anyway.
  return { kind: "reader", id: m.id };
}

/**
 * WHAT THE READER SHOWS — the mirror's own row, else the row the opener carried in with it.
 *
 * A named unit for the reason `makeHydrateBody` below is one: it used to be
 * `reader.get("message", readerFor) ?? null` inline, and that `?? null` is the difference between
 * a message opening and a click doing nothing at all.
 *
 * `GET /search` answers over the whole archive while this device's mirror is a window over it
 * (`older-mail.ts`, and the engine prunes what nothing is looking at), so a search hit can name a
 * message no local row exists for — `SearchView` marks those hits on screen. For one of those the
 * mirror answers `undefined`, the reader's `open` prop was therefore false, and the sheet never
 * came up: the reported "clicking it does not open it", in the one arm that has no pile to blame.
 *
 * The fallback is keyed on the ID, so a held row can never be shown for a different open. What it
 * renders is exactly what the archive returned — sender, subject, date, and `bodyOf`'s honest
 * `snippet` state — because a body cannot be fetched for a message the mirror has no row for
 * (`OhmailEngine.bodyPlan` skips it). Opening what search found is the requirement; a snippet is
 * the fidelity this device has for a row it does not hold, and it says so rather than showing an
 * empty sheet.
 *
 * The mirror WINS whenever it has the row: it carries the optimistic overlay and this device's own
 * triage and flag state, while the carried row is a snapshot from before whatever the reader just
 * did — the same precedence `SearchView`'s merge keeps for the same reason.
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
 * THE BODY-HYDRATION CALLBACK, as a factory whose one job is watchable: FORWARD the caller's
 * options to the engine.
 *
 * This lived inline as `(messageId) => engine.hydrateBody(messageId)` — dropping the second
 * argument. Every consumer's type is `(id, opts?: { retry?: boolean }) => void` and four of them
 * (`MessagePane`, `ScreenerView`, `ReadsView`, `ReceiptsView`) pass `{ retry: true }` from a
 * human pressing "try again". `OhmailEngine.hydrateBody` re-asks a FAILED body ONLY under that
 * flag (`engine.ts` — an automatic trigger must never re-poll a server that refused, because a
 * retry loop nobody asked for is API cost with nobody behind it), so with the flag dropped every
 * retry button in the app was inert: a held message whose
 * body 500'd could not be recovered without reloading the tab, and in the Screener that is a
 * consent decision left standing on a one-line snippet. The declared type accepted `opts` and the
 * implementation ignored them — the "type-level guard that silently does not guard", so it is a
 * named unit now, with `test/hydrate-body-retry.test.ts` watching the forward.
 */
export function makeHydrateBody(
  engine: { hydrateBody: (messageId: string, opts?: { retry?: boolean; urgent?: boolean }) => unknown },
): (messageId: string, opts?: { retry?: boolean; urgent?: boolean }) => void {
  return (messageId, opts) => {
    void engine.hydrateBody(messageId, opts);
  };
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
 * THE RAIL, AND THE TAG-COLLAPSE STATE THAT BELONGS TO IT.
 *
 * `tagsOpen` used to be `AppShell` state, and it caused the ~5s tag collapse two ways at once:
 *
 *  1. It re-rendered the WHOLE shell. Toggling a rail group has nothing to do with the mail, but
 *     `setTagsOpen` sat on the top-level component, so every toggle re-rendered the active view —
 *     on a full mailbox that is the hundreds-of-rows list, and that reconciliation is the wait.
 *  2. It did not even respond. `open: tagsOpen` / `onOpenChange: setTagsOpen` were baked into
 *     `AppShell`'s `groups` `useMemo`, whose deps did NOT list `tagsOpen`, so the controlled
 *     `open` prop was frozen — the group only "caught up" when some unrelated change happened to
 *     recompute that memo, which is what made the collapse feel like it lagged by seconds.
 *
 * Holding the state HERE fixes both. A toggle re-renders only this component and `RailNav`, never
 * `AppShell` and never the view beside it; and `open` is injected fresh on every render, so there
 * is no memo to go stale. Persistence stays the shell's job because `RailNav` is shared with the
 * Desktop, which has no `localStorage` — `usePersistedFlag` is SSR-safe and its post-mount read
 * now re-renders only the rail. The `groups` handed in still carry `defaultOpen`; this injects the
 * live `open`/`onOpenChange` onto whichever group owns the Tags sub-list.
 */
/**
 * WHERE THE "GET OHMAIL FOR DESKTOP" PROMPT MAY APPEAR — the signed-in browser, and only there.
 *
 * `desktop` is the shell's own platform tell: the desktop app injects `desktopSection` (the pane
 * only a native process can have), so its presence IS "this build is the desktop app" — the same
 * signal the Settings nav already reads. A `desktopSection` is never handed to the Cloud shell, so
 * the prompt cannot show inside the app it is inviting people to install. `demo` is excluded
 * because the demo is a shop window, not an account, and the shell only ever renders for the demo
 * or a validated session — so `!demo` in a browser is a signed-in reader. Pure and exported so the
 * platform branch is a value a test can drive, not a JSX condition it has to reach through a shell.
 */
export function showDesktopCta(opts: { demo: boolean; desktop: boolean }): boolean {
  return !opts.demo && !opts.desktop;
}

/** localStorage key for a one-time dismissal of the desktop prompt. */
const DESKTOP_CTA_DISMISSED = "ohmail.desktopCtaDismissed";

/**
 * A subtle, dismissible line at the foot of the rail: "Get ohmail for desktop", linking to the
 * download section of the site (a new tab, so the reader's mailbox stays open). The dismissal is
 * persisted — a promo dismissed should stay dismissed — and read AFTER mount rather than during
 * render, so a server pass and its hydration agree before the effect quietly hides it.
 */
export function DesktopCta({ href, label, dismissLabel }: { href: string; label: string; dismissLabel: string }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(DESKTOP_CTA_DISMISSED) === "1") setDismissed(true);
    } catch {
      // A blocked or absent localStorage just means the line stays offerable — never a throw.
    }
  }, []);
  if (dismissed) return null;
  return (
    <div className="rail-desktop-cta">
      <a className="rail-desktop-cta-link" href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
      <button
        type="button"
        className="rail-desktop-cta-x"
        aria-label={dismissLabel}
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(DESKTOP_CTA_DISMISSED, "1");
          } catch {
            // Dismissal that cannot persist still hides the line for this session.
          }
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

function ShellRail({ groups, ...rest }: RailNavProps) {
  const [tagsOpen, setTagsOpen] = usePersistedFlag(UI_KEYS.tagsOpen, true);
  const withTagState = useMemo<RailGroup[]>(
    () =>
      groups.map((g) =>
        g.tags ? { ...g, tags: { ...g.tags, open: tagsOpen, onOpenChange: setTagsOpen } } : g,
      ),
    [groups, tagsOpen, setTagsOpen],
  );
  return <RailNav groups={withTagState} {...rest} />;
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
  mailboxFacts,
  sendSurfaceMaxTotalBytes,
  accountSection,
  mailboxSection,
  billingSection,
  invitesSection,
  securitySection,
  aboutSection,
  desktopSection,
  devicesSection,
  screeningSection,
  screenerSuggest,
  awayTransport,
  profileImportTransport,
  consentTransport,
  suggestWire,
  aiCredits,
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
   * THE HOST'S OWN CEILING ON ATTACHMENT BYTES IN ONE SEND — what the pipeline a send from this
   * window rides can carry, declared by the host because only the host knows its transport.
   *
   * The form-side twin of the `sendSurfaceMaxTotalBytes` every send handler's service bag
   * declares, with the same three states (`composeAttachCap` holds the rule): ABSENT is a host
   * that has not declared itself — every browser tab, whose sends ride the hosted API's
   * serverless request body — and resolves to the strict constant; `null` is the desktop's
   * STANDALONE door, where the compose form, the send handler and the SMTP dial are one process
   * and the only real ceiling is the sending mailbox's own `SIZE` announcement; a number is a
   * host naming its own transport's limit.
   *
   * NOT passed on the desktop's CLOUD door, deliberately: that door forwards
   * `POST /drafts/:id/send` verbatim to the hosted API, so its sends stand under exactly the
   * body limit the constant expresses, and an uncapped declaration there would promise
   * attachments the forwarded send must refuse. See `DesktopGate` for the declaration and
   * `apps/desktop/test/desktop-attach-cap.test.ts` for the guard on both halves.
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
   * THE PANE THAT ONLY A SHELL WITH A NATIVE PROCESS BEHIND IT CAN HAVE.
   *
   * Which door this install came in by, which mailbox it opens, and the three actions that
   * change either. Every one of those is a call to the desktop shell — a native command or a
   * request down the pipe it holds — so the code cannot live here: this file is compiled into
   * the desktop app and into a browser tab, and the browser tab has no shell to call. Injected
   * for the same reason {@link accountSection} is, and it is the mirror image of that one:
   * absent on the web because there is no shell, where Account is absent on the desktop
   * because there is no account.
   *
   * It carries its own `label`, like the sent-mail review's entry does, because the words
   * belong to the desktop's vocabulary and this shared file does not own them.
   *
   * NOT gated on `demo`, unlike the four panes above it, and that is the whole difference: the
   * pane describes the INSTALL rather than an account, so it is as true of a window showing
   * sample mail as of one showing somebody's own. A `demo ? undefined : …` here would withhold
   * it from the surface it exists for on exactly the launches where somebody is most likely to
   * go looking for it.
   */
  desktopSection?: { label: string; node: ReactNode };
  /**
   * SETTINGS → DEVICES — the desktop app's host mode, injected. Serve this install's mail to the
   * user's other devices over their own tailnet, pair a phone with a QR, revoke a pairing.
   *
   * The same seam as {@link desktopSection} and gated one step tighter by the HOST, not here:
   * the desktop gate wires it only on the standalone door, because host mode publishes the
   * mailbox THIS computer opens. Absent everywhere else — every browser tab, the hosted door,
   * the demo — so the nav entry cannot exist where the shell behind it could not serve.
   */
  devicesSection?: ReactNode;
  /**
   * THE SCREENER PANE'S OWN CONTROLS, WHEN THE HOST HAS ITS OWN — the desktop's, and nobody else's.
   *
   * The same seam as {@link screenerSuggest} and for the same reason. This shell builds
   * `ScreeningSection` for the Screener pane, and every control in it reads and writes through
   * `app/api-client` — which is not part of the desktop build. There the section renders NOTHING:
   * each control asks for its value, is refused, and draws nothing, so the pane existed in the nav
   * and was blank when opened. A host with its own transport hands in its own section instead.
   *
   * Present ⇒ this shell's own section is not built. Never both.
   */
  screeningSection?: ReactNode;
  /**
   * THE SCREENER'S SUGGEST CONTROL, WHEN THE HOST HAS ITS OWN — the desktop's, and nobody else's.
   *
   * The control this shell builds asks a server what a set of senders would cost and shows the
   * number before it offers a button, because a hosted account spends an allowance. A standalone
   * install spends nothing: the model belongs to whoever installed it, reached over a channel this
   * file cannot use. Its control is therefore a different control rather than the same one with
   * different words, and it is handed in — the same seam as {@link desktopSection}, for the same
   * reason, with the two extra capabilities a Settings pane does not need.
   *
   * `absorb` is what makes an injected control possible at all: there is exactly one suggestion
   * overlay on screen and the rows, the count, "Apply all" and Enter-accept all read it, so a host
   * that answers senders its own way lands them there or they are answers nothing can display.
   *
   * Present ⇒ this shell's own control is not offered. Never both.
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
   * THE AWAY RESPONDER'S TWO CALLS, WHEN THE HOST HAS ITS OWN WIRE — the desktop on its HOSTED
   * door, and nobody else.
   *
   * ── WHY A TRANSPORT AND NOT A SECTION, WHICH IS HOW EVERY OTHER DESKTOP SEAM HERE WORKS ─────
   *
   * Because the responder must not have two implementations. `screeningSection` and
   * `screenerSuggest` are handed over as NODES because the desktop's versions of those are genuinely
   * different controls — a standalone install's model is not a hosted account's allowance, and a
   * pane about a local engine is not a pane about a subscription. The responder is the same control
   * over the same hosted row: one `PUT /away-responder`, whose `updatedAt` IS the enablement episode
   * the worker's at-most-once record is filed under. A second copy of this control would be a second
   * definition of when an episode begins, and the visible failure — a correspondent answered twice —
   * would show up in somebody's mailbox rather than in a suite. So only the wire is injected.
   *
   * ── WHY THE DESKTOP NEEDS ONE AT ALL ────────────────────────────────────────────────────────
   *
   * `apiConfigured()` is FALSE in every desktop build, both doors: `apps/desktop/vite.config.ts`
   * aliases `app/api-client` to a stub whose value exports refuse, so the gate below withheld this
   * control from the hosted door as well as the standalone one. That was right for one of them and
   * wrong for the other. A desktop install on the HOSTED door is mirroring a real account: its
   * window cannot open a socket (`connect-src 'none'`), but its mail engine holds the account's
   * session, serves no `/away-responder` locally, and forwards it to Cloud with the bearer. The row
   * that is written is the hosted account's own, and the hosted worker sends from it — exactly as
   * for a browser tab.
   *
   * ── AND WHY A STANDALONE INSTALL STILL GETS NOTHING ─────────────────────────────────────────
   *
   * That is a product boundary rather than a missing transport, and it is structural: the sender is
   * a pass in the hosted service, whose module map deliberately does not publish it — a rule that
   * service's own build holds rather than one somebody remembers. An always-on
   * replier cannot live in an application that only runs while its window is open, and both installs
   * organize the SAME mailbox under one lease — two responders would keep two separate at-most-once
   * records and answer the same correspondent twice. So the standalone door wires no transport, this
   * shell offers no control, and `SettingsView` grows no nav entry.
   *
   * Absent ⇒ the hosted client, which is what a browser tab has, gated on `autoOptIn.supported`.
   */
  awayTransport?: AwayTransport;
  /**
   * THE PROFILE IMPORT'S THREE CALLS, WHEN THE HOST HAS ITS OWN WIRE — the desktop, on BOTH of
   * its doors, and nobody else.
   *
   * The same seam as {@link awayTransport}, injected for the same reason — `apiConfigured()` is
   * false in every desktop build, so the shell's own check never ran there — and with the
   * sharper irony: the STANDALONE desktop is the tier whose whole story is "connect the mailbox
   * and the settings it travelled with are waiting", and it was the one tier that never asked.
   *
   * Unlike the responder, this wire is live on the standalone door too, and the difference is a
   * fact about where the routes are served rather than a policy choice: the confirm flow's three
   * verbs are mounted on the LOCAL engine's own table and answered out of the store on this
   * machine (the mailbox dial rides the sealed credential), so a standalone install asking is an
   * install asking ITSELF. On the HOSTED door the engine forwards the three routes to the
   * account with the bearer, exactly as it forwards the responder's two. `profileImportDoorFor`
   * in the desktop's `doors.ts` is where the door rule lives, as a pure function a test drives.
   *
   * A TRANSPORT and not a section, for {@link awayTransport}'s reason: the card, the counts, the
   * fingerprint-as-consent and the durable dismissal must have ONE implementation — a second
   * copy would be a second definition of what "answered" means, and the failure (the same
   * document asking twice, or applying content nobody was shown) lands in somebody's settings
   * rather than in a suite. Absent ⇒ the hosted client, which is what a browser tab has.
   */
  profileImportTransport?: ProfileImportTransport;
  /**
   * `GET /consent` AND ITS FOUR WRITES, WHEN THE HOST HAS ITS OWN WIRE — the desktop on its
   * HOSTED door, and nobody else.
   *
   * The same seam as {@link awayTransport} and injected for the same reason, with a wider blast
   * radius: `apiConfigured()` is false in every desktop build, so this shell's `GET /consent`
   * never ran there, `consent.known` was false for the life of the process, and FOUR controls
   * were withheld from an install that is mirroring a real account — the dormancy dial, the
   * auto-suggest opt-in, auto-unsubscribe, and (through `consent.locale`) the account's own
   * choice of interface language. Every one of those is stored on the hosted account and reached
   * by forwarding, exactly as the away responder is.
   *
   * A TRANSPORT and not a set of sections, for the reason {@link awayTransport} gives and one
   * sharper: `autoSuggest` is the only flag in this product that authorises SPENDING, and the
   * spender (`useScreenerSuggestions` above) reads it off this one hook. A host that wrote the
   * flag its own way would leave that copy stale, and the direction that costs money is OFF —
   * revoked in Settings, still authorised in the Screener.
   *
   * The STANDALONE door hands in nothing, and that is a product boundary rather than a missing
   * wire: it has no account, so there is no row to read and nowhere to put a window, a watermark
   * or a consent instant. Absent ⇒ `consent.standalone`, and every control above is withheld
   * structurally rather than offered dead.
   */
  consentTransport?: ConsentTransport;
  /**
   * THE SCREENER'S TWO SPEND CALLS, WHEN THE HOST HAS ITS OWN WIRE — the desktop on its HOSTED
   * door, and nobody else.
   *
   * Distinct from {@link screenerSuggest}, which hands in a whole CONTROL, and the two are not
   * alternatives: that one is the Screener's own purchase ladder, whose desktop version already
   * exists (`CloudSuggest`). This is the wire the SHELL's copy of the machinery runs on, and it
   * is needed for the part `CloudSuggest` structurally cannot do — `autoOptIn.supported`, which
   * is `wire.configured()` and which gates the Settings opt-in row. `CloudSuggest` says so
   * itself: *"the setting that authorises it is written from a Settings row this app does not
   * render"*. This is that row's wire.
   *
   * Supplying it also lets the shell's overlay HYDRATE from `GET /screener` — the answers the
   * account has already paid for — which on the desktop had never been read, so a relaunch lost
   * every suggestion until it was bought again.
   *
   * Absent ⇒ the hosted client, which is what a browser tab has, and `false` on a standalone
   * install: no account, no ledger, no spend control.
   */
  suggestWire?: SuggestWire;
  /**
   * WHAT THE ACCOUNT'S AI ALLOWANCE IS DOING, said where AI actions are bought.
   *
   * The same seam as {@link screenerSuggest} and for the identical reason: the answer comes from
   * `GET /billing/subscription`, and this shared shell may not call `app/api-client` — it is
   * published, and the mirror does not contain that module. A standalone install has no account
   * and no allowance, so it hands in nothing and the line simply does not exist there.
   *
   * A FUNCTION rather than a node, because the offer this line makes ("start a plan") is
   * worthless without somewhere to land, and WHERE it lands is this file's business. `go()` is a
   * module export the Cloud client could import — the constraint is not reachability, it is that
   * "Settings, on the Subscription pane" is a two-part act here: a hash change AND a one-shot
   * pane request the settings view reads at its own mount. A node that only had `go()` would land
   * people on General; a node given both would be a second copy of the shell's navigation living
   * outside it. So the shell hands down the finished act and the injected node presses it.
   */
  aiCredits?: (ctx: { onStartPlan: () => void }) => ReactNode;
  /**
   * HOW MANY PIECES OF MAIL ARE WAITING FOR YOU — published, for a surface outside the page.
   *
   * The number the Ohbox's rail row already shows, handed out so a shell that has a dock icon
   * can put it on one. It is deliberately that number and not a sum of every count in the rail:
   * the Screener's waiting senders are people to decide about rather than mail to read, and a
   * badge that counted them would ask for attention the product spent two years learning not to
   * ask for.
   *
   * A callback and not a return value, because the only consumer is a native shell and the shell
   * is not in this tree. Absent everywhere else, which is every browser tab — nothing on the web
   * has an icon to write on.
   */
  onUnread?: (unread: number) => void;
}) {
  return (
    <EngineProvider demo={demo} engine={engine} resolveOwner={resolveOwner}>
      {/* ONE keydown listener for the whole client. Outside `ShellInner` so
          every view mounted under it can declare bindings into the same table, which is
          also the table the `?` sheet is generated from. */}
      <KeymapProvider>
        <MailStateHost probe={mailboxFacts}>
          <ShellInner
            sendSurfaceMaxTotalBytes={sendSurfaceMaxTotalBytes}
            accountSection={accountSection}
            mailboxSection={mailboxSection}
            billingSection={billingSection}
            invitesSection={invitesSection}
            securitySection={securitySection}
            aboutSection={aboutSection}
            desktopSection={desktopSection}
            devicesSection={devicesSection}
            screeningSection={screeningSection}
            screenerSuggest={screenerSuggest}
            awayTransport={awayTransport}
            profileImportTransport={profileImportTransport}
            consentTransport={consentTransport}
            suggestWire={suggestWire}
            aiCredits={aiCredits}
            onUnread={onUnread}
          />
        </MailStateHost>
      </KeymapProvider>
    </EngineProvider>
  );
}

/**
 * The mail-state provider, hoisted ABOVE `ShellInner`.
 *
 * It used to be the outermost element of `ShellInner`'s own return, which meant the shell
 * PROVIDED the mailbox facts and could not read them. That was fine while the only consumers
 * were leaves — the strip, the Ohbox's empty pane, the injected Settings rows — and stopped
 * being fine the moment the From line needed the same facts on the WIRE: `sendReply` and the
 * compose plan are built in `ShellInner`, and a fact the shell cannot see is a fact the mutation
 * cannot carry. Moving the plan down into the views instead would have split the rule across
 * two components and left `sendReply` — whose signature is frozen behind `message-chrome.tsx` —
 * with no mechanism at all.
 *
 * `mirrored` moved up with it because the provider needs it and nothing else did.
 *
 * Nothing else changed position: `MessageChromeProvider` is still inside `ShellInner`, and the
 * three existing consumers read a context rather than a position, so none of them notices.
 */
function MailStateHost({ probe, children }: { probe?: MailboxProbe; children: ReactNode }) {
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
    <MailStateProvider probe={probe} mirrored={mirrored}>
      {children}
    </MailStateProvider>
  );
}

function ShellInner({ sendSurfaceMaxTotalBytes, accountSection, mailboxSection, billingSection, invitesSection, securitySection, aboutSection, desktopSection, devicesSection, screeningSection, screenerSuggest, awayTransport, profileImportTransport, consentTransport, suggestWire, aiCredits, onUnread }: {
  /** The host's surface declaration for the attach ceiling — see `AppShell`'s prop of this name. */
  sendSurfaceMaxTotalBytes?: number | null;
  accountSection?: ReactNode;
  mailboxSection?: ReactNode;
  billingSection?: ReactNode;
  invitesSection?: ReactNode;
  securitySection?: ReactNode;
  aboutSection?: ReactNode;
  desktopSection?: { label: string; node: ReactNode };
  devicesSection?: ReactNode;
  screeningSection?: ReactNode;
  screenerSuggest?: (ctx: {
    senders: string[];
    resuggestable: string[];
    absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
  }) => ReactNode;
  awayTransport?: AwayTransport;
  profileImportTransport?: ProfileImportTransport;
  consentTransport?: ConsentTransport;
  suggestWire?: SuggestWire;
  aiCredits?: (ctx: { onStartPlan: () => void }) => ReactNode;
  onUnread?: (unread: number) => void;
}) {
  const demo = useDemoMode();
  const t = useTranslations();
  const engine = useEngine();
  const version = useEngineVersion();
  /**
   * The account's mailboxes as `GET /mailboxes` reported them, or `null` for "we cannot see"
   * (Desktop, demo, a Cloud tab before its first poll). Read here — rather than provided here,
   * as it once was — so the From line and the mutation it describes come from one source.
   */
  /**
   * `settled` travels to the piles as a PROP and not through `useMailState()` at their top
   * level, and that is a hard constraint rather than a preference: `test/ohbox-read-state.test.ts`
   * mounts `OhboxView` under `KeymapProvider` alone, and `useMailState` THROWS without a
   * provider by design (`MailStateProvider`'s header argues why a resting default would be
   * worse). A hook at the top of the view would take that harness down on mount, in every
   * branch, whether or not the list was empty.
   *
   * It is still derived exactly once, up here, from the one binding, which is the rule the
   * mail-state ladder established. A prop is how a derivation reaches a component that must be mountable alone.
   */
  const { mailboxes: facts, state: mailState } = useMailState();
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
  const theme = useTheme();
  const route = useHashRoute();
  // The registry owns ⌘K (see `keymap.tsx`). Leaving the hook's own binding on as well
  // would toggle twice per keypress, which cancels out and never opens the palette.
  const palette = useCommandPalette({ bindKey: false });
  const now = useMemo(() => (demo ? DEMO_NOW : new Date()), [demo]);

  /* ── consent: what is PRESENTED, as opposed to where it sits ────────────────────────────
   *
   * Mail is shown by who sent it and whether the user has decided about them, not by which
   * folder the mail server has it in. A consented sender's whole backlog appears in the Ohbox
   * while every message of it is still physically in the Screener folder, and mail from
   * senders who went quiet years ago and were never screened presents in History. Nothing
   * moves; this is a filter over the same mirror.
   */
  const consent = useConsentState(!demo, consentTransport);
  /**
   * THE ACCOUNT'S LANGUAGE WINS OVER THIS DEVICE'S — the whole of the account-tied half, and it
   * rides the `GET /consent` this shell already makes rather than a request of its own.
   *
   * The two preferences exist for different reasons and both are needed. `localStorage` is what a
   * STANDALONE install has (there is no account to store anything on) and what the SIGN-IN screen
   * has (there is no account yet). The account column is what makes "my mail is in German" true on
   * a machine that has never seen this account — a borrowed laptop, a second browser, a fresh
   * install. So when both exist the account is the authority, which is this effect.
   *
   * `adoptLocale`, never `setLocale`: on the Cloud client the latter WRITES the account, so adopting
   * a value that came FROM the account would PATCH it back on every boot of every tab — and a
   * failed write of a value nobody changed would reject into a control nobody touched. See
   * `LocaleControls.adoptLocale`.
   *
   * Null means the account has no preference and the device's choice stands, which is why there is
   * no `else` arm here: this effect can only ever move the language TOWARDS what an account said.
   * `adoptLocale` is a no-op when the two already agree, so the steady state is one comparison per
   * consent read and nothing else.
   *
   * Absent provider (`locale === null`) is the demo and the unit tests, which have no locale
   * machinery at all — nothing to adopt into, and no error worth raising.
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
   * THE SEED REVIEW, OFFERED ONCE THE SERVER SAYS IT IS OWED — and dismissible.
   *
   * `seedConfirmedAt` is null until somebody has answered the review, which is also the state
   * a reset puts an account back into. The screen takes over the stage rather than sitting in
   * a corner, because it is the step that decides what the Ohbox contains and a mailbox that
   * has not been through it presents almost everything through the Screener.
   *
   * "Later" is a real answer and is remembered for this tab only. Nothing about the product is
   * gated on completing it — an account that never does simply screens every stranger, which
   * is the old behaviour and not a broken one — so a modal nobody could leave would be a wall
   * in front of somebody's mail for a step that is an offer.
   *
   * ── "NOT NOW" IS NOT "NEVER", AND NEITHER IS "DONE" ───────────────────────────────────────
   *
   * `seedReopened` is the door back, and there has to be one. Dismissing used to leave the
   * screen unreachable for the rest of the tab's life, and CONFIRMING left it unreachable for
   * the rest of the account's — `seedConfirmedAt` was set and nothing ever unset it short of
   * wiping every screening decision on the account. Connecting a second mailbox is the case
   * that makes that wrong rather than merely awkward: it brings a second address book of
   * people the user has written to, and the screen that consents to them was walled off. The
   * Settings entry sets this, `confirmSeed` writes only who is new, and the review recomputes
   * itself from whatever mailboxes are attached when it is opened.
   */
  const [seedDismissed, setSeedDismissed] = useState(false);
  const [seedReopened, setSeedReopened] = useState(false);
  /**
   * THE REVIEW NEEDS THE BROWSER'S CLOUD CLIENT, and no injected wire substitutes for it.
   *
   * `consent.known` used to be the whole gate, and it was sufficient for exactly as long as
   * "the server answered" and "this bundle can call the server" were one fact. A host with its
   * own {@link consentTransport} splits them: `known` becomes true on the desktop's hosted door,
   * and `SeedReviewView` still imports `app/api-client` DIRECTLY — `seedReview`, `confirmSeed`,
   * a ceremony's worth of calls no transport carries. Without this clause an account that has
   * never answered the review would have had it take the WHOLE STAGE of the desktop window, on
   * top of its mail, unable to load its own candidates and unable to be completed.
   *
   * So the review is offered where the client that runs it exists, which is the browser. This is
   * the same fact `seedSection` is gated on below — the settings door back to a screen that
   * cannot open is a door to nothing — and it is why {@link ConsentState.cloudClient} is
   * published separately from `standalone`.
   */
  const seedSupported = consent.cloudClient;
  const seedOwed = !demo && consent.known && seedSupported
    && (seedReopened || (consent.seedConfirmedAt === null && !seedDismissed));
  /**
   * The account's OWN addresses, from `GET /mailboxes` — passed EXPLICITLY and not left to
   * the default.
   *
   * `consentPartition` falls back to the mirror's `mailbox` entities, and a live `/sync` feed
   * carries none: the fallback is an empty set on exactly the surface that matters. With an
   * empty set the user is not recognised as themselves, and their own mail — a note to
   * themselves, a forward from another account — lands in their own Screener queue asking
   * whether they would like to hear from themselves. The demo's mirror DOES hold mailbox rows,
   * so no fixture test could ever have shown this.
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
  const ownAddresses = useMemo(
    () => facts?.map((m) => m.address) ?? rememberedOwn ?? [],
    [facts, rememberedOwn],
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
  const ownNameOf = useCallback(
    (address: string): string | null => {
      const key = address.trim().toLowerCase();
      const label = facts
        ?.find((m) => m.address.trim().toLowerCase() === key)
        ?.displayName?.trim();
      return label ? label : null;
    },
    [facts],
  );
  const consentView: ConsentPartition | null = useMemo(
    // THE DEMO IS NOT PARTITIONED, and this is a fact about the data rather than a shortcut.
    //
    // Consent is derived from rules, and the fixture world has none — nobody has ever screened
    // anybody in it, because there is no server to screen against. Run over that mirror the
    // partition is right and useless: every read message older than the window is undecided
    // and dormant, so the whole curated world empties into History and the tour has nothing to
    // show. The fixture placements were AUTHORED to demonstrate the piles; they are not a
    // record of decisions this model can read, and pretending otherwise is what would be
    // dishonest here.
    //
    // AND NOTHING IS PARTITIONED BEFORE THE ACCOUNT'S WINDOW IS KNOWN. `consent.known` is
    // false until `GET /consent` lands — or, on a device that has held this account before,
    // until the boot applies the account's CACHED last answer (`consent-state.ts`,
    // `boot-cache.ts`), which is what stops every reload presenting the raw piles for the
    // whole consent round trip: measured live, the Screener resurrected the same set of
    // already-decided senders on every boot and held them until the answer arrived, however
    // many /sync drains completed first. A tab with NO cache and no answer still partitions
    // nothing, for ever if the endpoint never answers. That refusal is about GUESSED windows:
    // partitioning on a default the account may not be using would move mail out of the piles
    // and into History, and a request that simply failed would silently hide somebody's mail.
    // The cache is not a guess — it is the account's own stored window, one session old at
    // most — while unpartitioned remains what the product did before consent existed, so a tab
    // that cannot know degrades to showing MORE, never less.
    //
    // ── UNLESS THERE IS NO SERVER TO ANSWER, WHICH IS THE DESKTOP ────────────────────────
    //
    // `consent.standalone` is that case and only that case: a build with no Cloud API behind
    // it, where the fetch above never runs and `known` is false for the life of the process.
    // The known-gate's reason does not reach it — there IS no stored window to guess at, so
    // `DEFAULT_DORMANCY_DAYS` (what `consent.dormancyDays` already holds) is not a default
    // standing in for the truth, it is the truth. Read as "the answer has not arrived", the
    // gate switched the cutline off for the whole desktop tier: the Screener drew over the raw
    // mirror, there was no History pile at all, and every sender a backfill had already filed
    // into the Screener folder queued for ever. `screener-state.ts`'s past-the-gate branch was
    // inert there too — it only fires on a row the projection marked, and nothing was
    // projected.
    //
    // The web path is untouched. A browser tab with no API base never reaches this line:
    // `createEngine` throws `EngineUnarmedError` rather than serve fixtures to a live account.
    //
    // ── THE BASELINE RIDES THE SAME ANSWER AS THE WINDOW ─────────────────────────────────
    //
    // `consent.screeningBaselineAt` comes from the same `GET /consent` body as
    // `consent.dormancyDays`, so the two halves of the cutoff — `(baseline ?? now) - days` —
    // cannot be measured from different fetches. It is null on the desktop and on every account
    // that has never decided anything, which selects the pre-0056 sliding window rather than a
    // guess; see `consent-state.ts`.
    () =>
      demo || !(consent.known || consent.standalone)
        ? null
        : consentPartition(reader, {
            now,
            dormancyDays: consent.dormancyDays,
            baselineAt: consent.screeningBaselineAt,
            ownAddresses,
          }),
    [
      demo, consent.known, consent.standalone, reader, version, now, consent.dormancyDays,
      consent.screeningBaselineAt, ownAddresses,
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
    () => (consentView ? presentationReader(reader, consentView) : reader),
    [reader, consentView],
  );

  /**
   * MAIL FROM BEYOND WHAT THIS DEVICE KEPT — one keyset page at a time, on an explicit ask.
   *
   * The browser's mirror is a window over a server that still holds everything, so the bottom of
   * a pile is a boundary rather than an end. This is how the Ohbox reaches past it; see
   * `older-mail.ts` for why nothing fires speculatively and why the rows are never written to
   * the mirror.
   *
   * Inert on a client whose mirror IS the mailbox: `listOlderAvailable()` is false for the demo
   * and for the standalone desktop client, and the view renders no control at all in that case.
   */
  const older = useOlderMail(engine, "ohbox", version);

  /* ── engine-derived world (recomputed exactly when the mirror moves) ── */
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
    () => (consentView?.history ?? []).map((m) => ({ ...m, physicalFolder: m.folder })),
    [consentView],
  );
  const tags = useMemo(() => reader.list<TagDTO>("tag"), [reader, version]);
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
   * `presented`, NOT `engine.read()` — the Screener is the cutline's own surface.
   *
   * Every other pile above is built from the projected reader; this was the one that grouped by
   * the folder the mail server happens to hold a message in. The queue's whole question is "who
   * is still owed a decision", and that is what the partition answers. The hook keeps the raw
   * mirror for its mutations — see the `presented` parameter on `useScreenerState`.
   *
   * Consequence worth naming here, at the call site: `screener.unsuggestedSenders` feeds the
   * metered auto-suggest batch below, so this also stops the spender from being offered senders
   * the cutline had already ruled out as not-work.
   */
  /**
   * WILL SCREENING A SENDER OUT ALSO UNSUBSCRIBE FROM THEIR LIST, ON THIS BUILD, FOR THIS ACCOUNT?
   *
   * The single answer every disclosure in this shell reads — the sender sheet's pre-click confirm
   * and the Screener's toasts — so the sentence and the sending can never come apart. Two
   * conditions, and they are independent facts rather than belt and braces:
   *
   *  · `consent.autoUnsubscribe` — the ACCOUNT's switch (mail 0054), which is what the server
   *    itself reads at the seam. Resting TRUE, so a failed `GET /consent` keeps the disclosure
   *    exactly as it was before the switch existed rather than silently dropping it.
   *  · `!consent.standalone` — the BUILD. A standalone install wires no unsubscribe service into
   *    its screener at all (`apps/sidecar`'s bag has no `unsubscribe` entry), so a decision there
   *    sends nothing whatever the account row says. Without this clause the desktop would warn
   *    about a request it structurally cannot make.
   *
   * The demo is deliberately NOT excluded: `standalone` is false there, and the demo's job is to
   * show what the product does.
   */
  const autoUnsubscribeDiscloses = consent.autoUnsubscribe && !consent.standalone;
  const screener = useScreenerState(
    engine, version, toast, suggestions.suggestions, presented, autoUnsubscribeDiscloses,
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
  /**
   * IS THERE ANYWHERE FOR THE AWAY RESPONDER TO BE STORED — the one gate the control, its Ohbox
   * notice and its Settings entry all read, so those three can only agree.
   *
   * TWO ways to be true, and they are the two installs that have a hosted account behind them:
   *
   *  · `autoOptIn.supported` is `wire.configured()` — the browser talking to the hosted API, OR a
   *    host that handed in a {@link suggestWire}. It used to be exactly `apiConfigured()` and this
   *    line used to say so; a host wire is what widened it, and the widening is in the same
   *    direction and for the same installs, so this clause covers strictly more of what it always
   *    meant. Read off the opt-in rather than by calling `apiConfigured()` here because this
   *    shared shell does not import the Cloud API client at all;
   *  · a host handed in a transport — the desktop on its HOSTED door, whose window cannot open a
   *    socket but whose engine forwards this endpoint to the account. See {@link awayTransport},
   *    which also states why the STANDALONE door deliberately reaches neither branch.
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
  const awayNotice = useAwayNotice(!demo && awaySupported, awayTransport);
  /**
   * SETTINGS FOUND ON A MAILBOX — the portable profile's confirm moment, held by the shell.
   *
   * One check per mailbox per tab (plus a slow, visibility-gated beat) against a server answer
   * that is one indexed read in the resting case; the card renders over the stage only when the
   * server says a document is genuinely waiting on this person's yes or no. Gated on `!demo`
   * alone — the hook re-checks `apiConfigured()` itself, so a build where the Cloud client is a
   * refusing stub asks nothing UNLESS its host wired a transport of its own, which the desktop
   * now does on both doors ({@link profileImportTransport}): the standalone engine answers the
   * three verbs out of the store on this machine, the hosted door forwards them to the account.
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
   * A ONE-SHOT REQUEST FOR WHICH SETTINGS PANE TO OPEN ON, set by a link that promises one.
   *
   * The Screener's AI-credit line offers "start a plan", and an offer that lands on Settings →
   * General is an offer that has not been kept. `SettingsView` reads this once, at ITS mount, so
   * it decides where the person starts and never where they stay.
   *
   * It has to be CLEARED, and WHEN is the whole difficulty. The settings view unmounts when the
   * user navigates away (`effectiveView === "settings" ? … : null`), so a value left set would
   * re-select Subscription on every later visit to Settings — a link pressed once quietly
   * becoming a preference.
   *
   * **Clearing "whenever the route is not settings" is the version that does not work**, and it
   * fails in the one direction that matters. `openSettingsPane` sets the request and then calls
   * `go()`, which writes `location.hash`; the hashchange is asynchronous, so the very next render
   * still has the OLD route. That effect would fire with `route.view === "screener"`, clear the
   * request, and the settings view would mount a moment later with nothing to read — the offer
   * silently landing on General, which is exactly the broken promise it exists to prevent.
   *
   * So the clear is on the way OUT, tracked by a ref: arm while the settings view is up, clear on
   * the first render after it goes. `null` hands the choice back to the deep-link parameter,
   * which is what every other mount uses.
   */
  const [settingsPane, setSettingsPane] = useState<PaneId | null>(null);
  const settingsWasOpen = useRef(false);
  const openSettingsPane = useCallback((pane: PaneId): void => {
    setSettingsPane(pane);
    go("settings");
  }, []);
  useEffect(() => {
    if (route.view === "settings") { settingsWasOpen.current = true; return; }
    if (!settingsWasOpen.current) return;
    settingsWasOpen.current = false;
    setSettingsPane(null);
  }, [route.view]);
  /**
   * THE READER IS A MESSAGE NOW, NOT A BOOLEAN.
   *
   * It was `readerOpen: boolean` rendering `selectedOhbox`, which made the overlay a
   * property of ONE pile: nothing outside the Ohbox could open a message, and a message in
   * a folder this client has no view for could not be opened at all. `openMessage` — the
   * one answer to "open it where it lives" — therefore had no way to finish the job for
   * search hits, which is where three of the four reported defects met: one missing call.
   *
   * An id and not the `EngineMessage`: the mirror re-issues entities on every delta, so a
   * held object would be a snapshot that stops tracking read-state, tags and triage the
   * moment the reader is open — exactly the window in which they change.
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
    setReplyEnvelope(null);
  }, [replyTo, replyAll]);
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
  useEffect(() => {
    setReplyFromId(null);
    setReplyAttachments([]);
  }, [replyTo]);
  /**
   * THE COMPOSE FORM, and why it lives up here rather than in `ComposeView`.
   *
   * The view is mounted only while `#/compose` is the route, so state inside it is erased by
   * navigating to the Ohbox and back — which is a message the user has to write twice. Holding
   * it in the shell is the same reason the reply body is held here, and it is also what lets
   * ONE `onSendSettled` clear whichever surface just delivered.
   *
   * The `localStorage` mirror on top of that is for a RELOAD, and it is read after mount for
   * the hydration reason `persisted-ui.ts` spells out: reading storage in the initializer makes
   * the server and client render different markup, and React resolves that by keeping the
   * server's — so the saved draft would be read and then silently discarded.
   */
  const [compose, setCompose] = useState<ComposeFields>(EMPTY_COMPOSE);
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
   * ── ABSOLUTE-TIME STAMPS — A MOMENTARY, VIEW-SCOPED FLIP, NOT A SETTING ────────────────────
   *
   * Clicking any stamp flips every stamp on screen to the exact date and time — in the open
   * message (see `absoluteTime` on `MessageChrome`, read by `MessageHeader`/`MessageCard`) and,
   * from the same boolean, on every LIST ROW of the six mail lists (`rowStamp`, threaded to each
   * view below). One state and not two: a reader who has asked for exact dates has asked the
   * question of the mail in front of them, and a list whose rows disagreed with the message open
   * beside them would be answering it twice.
   *
   * It is deliberately NOT persisted, and it resets on every view switch: it answers "let me read
   * the exact dates on THIS", so carrying it to the next pile — or across a reload — would be the
   * interface remembering a glance nobody asked it to keep. In-memory state covers reload and
   * re-open for free; the effect below covers moving between rail views.
   */
  const [absoluteTime, setAbsoluteTime] = useState(false);
  useEffect(() => {
    setAbsoluteTime(false);
  }, [route.view]);
  /* ONE callback, stable, for both halves — the chrome's `onToggleAbsoluteTime` and every list's
     `onToggleTime`. Two arrow literals would be two identities, and the row prop is handed to six
     memoizable views. */
  const toggleAbsoluteTime = useCallback(() => setAbsoluteTime((v) => !v), []);
  /**
   * THE ROW A SEARCH HIT LANDED ON — so the user can SEE where they were taken.
   *
   * Reported as: opening a search result "brings me to the mail in the screener but does not
   * highlight / select it". The routing was right and the arrival was silent: `openMessage`
   * set each view's cursor and navigated, and the user was handed a list with a cursor
   * somewhere in it and no indication which row they had just asked for. On the Screener,
   * where rows are SENDERS and the list is long, that is indistinguishable from having been
   * dropped at the top of a queue of strangers.
   *
   * This holds the id that the destination view puts in `data-id` — the message id in three
   * views, the SENDER row's id in the Screener — and is cleared once the flash has run.
   */
  const [located, setLocated] = useState<string | null>(null);
  const [fr, setFr] = useState<{ step: number; items: TriagePileEntry[] } | null>(null);
  /**
   * "Start a Reply Run once we are on Triage", as an INTENT rather than a race.
   *
   * `f` and the palette both did `go("triage"); setTimeout(startFR, 130)`. The route-transition
   * effect below clears every overlay — `setFr(null)` included — whenever the view changes, so
   * that 130 ms was a bet that the effect would run first. Any extra render moves the deadline:
   * with a row selected the effect landed AFTER the timeout and wiped the state that had just
   * opened the overlay, so `f` navigated to Triage and then silently did nothing. It was filed
   * as "a selection blocks the Reply Run"; the selection was only the cheapest way to buy
   * enough renders to lose the race.
   *
   * A flag the effect itself honours cannot lose it: the clear and the re-arm are one pass, in
   * that order, however many times React re-renders on the way.
   */
  const [frPending, setFrPending] = useState(false);
  /**
   * WHAT THE USER TYPED IN THE RUN, KEYED BY MESSAGE.
   *
   * This was `Record<number, string>` — keyed by the STEP INDEX — and nothing in the file read
   * it: the overlay wrote into it and `onDone` dispatched `triage_set → none` without ever
   * looking. Both halves are fixed here, and the re-keying is not cosmetic. A step index is
   * re-issued by the next run over a pile that has since moved, so "step 0's text" is a
   * different person's answer tomorrow; the message id is the only stable name for what was
   * written. It is also the key `writeReplyDraft`, `sendKeyOf` and `settle` already use, which
   * is what lets the run share one scratch buffer with the inline editor rather than inventing
   * a second one that `settle` would not know to clear.
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
   * THE CONVERSATION'S PEOPLE, for a row's lead circles — bound to the presented reader here
   * because the views have no reader of their own, and mapped to `{initials, hue}` with the same
   * helpers every other avatar in the app uses, so a face is the same colour everywhere.
   *
   * BUILT ONCE PER VERSION, NOT ONCE PER ROW, and that is the whole reason the index selector
   * exists. Every mail list in the app draws these circles now — Ohbox, Reads, Receipts, History,
   * Triage, Tag — so the per-thread selector's mirror scan would run once per mounted row per
   * render: O(mirror × rows), on the largest structure the client holds, for a decoration. One
   * pass fills the map; a row's lookup is a `Map.get`, and the mapped shape is built here so a
   * render allocates nothing per row either.
   *
   * The empty answer is a SHARED CONSTANT so that a thread with no conversation of people in it
   * gives the same array reference on every render — a fresh `[]` per row per render is a new
   * prop identity, which is exactly what defeats a memo further down.
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
  const participantsOf = useCallback(
    (threadId: string) => participantIndex.get(threadId) ?? NO_PARTICIPANTS,
    [participantIndex],
  );
  /**
   * THE CONVERSATION'S STORED NAME, for the Ohbox's grouped rows — bound here for the same
   * reason `participantsOf` is: the view has no reader of its own. The mirror's thread row
   * carries the subject the server named the thread with, prefixes already stripped, so the
   * grouped row says "Webshop" where its members say "Re: Webshop". `null` while the thread
   * row has not synced; the view falls back to the newest member's subject.
   */
  const threadSubjectOf = useCallback(
    (threadId: string) => threadSubject(presented, threadId),
    [presented, version],
  );
  /**
   * WHAT IS OPEN IN THE OHBOX — and `null` until somebody opens something.
   *
   * There was a `?? allOhbox[0]` on the end of this, so an Ohbox nobody had touched reported the
   * newest unread message as "the open one". That is not a display detail: this value decides
   * which body is FETCHED (the hydration effect below), which attachments are held and revoked,
   * and which message `s`, `e`, `r` and the reader act on. Arriving at the Ohbox therefore
   * fetched a message from the user's own server and put it in the reading column, and the row
   * was then one keypress away from a departure that marks it read.
   *
   * The dwell already refuses to arm from a selection nobody made (`OhboxView.dwellOn`), which
   * stopped the runaway; it did not stop the product opening mail on its own. The rule the
   * runaway fix was written under — "a fallback may decide what is DISPLAYED; it may never
   * drive seen-machinery" — holds for the piles whose lists do not re-partition on read and
   * where no leave-commit runs (Tag, History, Reads, Receipts keep theirs). Here the display
   * IS an open, so there is nothing left for a fallback to be innocent of.
   */
  const selectedOhbox = allOhbox.find((m) => m.id === ohboxSel) ?? null;

  /**
   * DERIVE-CLOSE the Quick-Look overlay when the message it belongs to stops being the open
   * one — a different row selected, a view change, the reader closed. `attachments` are held
   * for `selectedOhbox` only and their `blob:` URLs are revoked the moment it moves, so a
   * preview left standing across the switch would render revoked bytes. Closing is derived from
   * the selection rather than remembered at every call site that can change it.
   */
  useEffect(() => {
    if (previewFor && previewFor.messageId !== selectedOhbox?.id) setPreviewFor(null);
  }, [previewFor, selectedOhbox?.id]);

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
   * Is the reading column absent? Under 900px `app.css` sets `display:none` on it, so a
   * split-pane selection shows the user nothing and "opened" has to mean the reader sheet.
   * One predicate, used by `openReply` (which had it inline) and by `openMessage`.
   */
  const readColumnHidden = useCallback(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(max-width: 900px)").matches === true,
    [],
  );

  /**
   * OPENING THE READER — THE ONE GATE.
   *
   * A live walk at 1440 found the reading experience rendered TWICE: the message painted in
   * the split's 752px column AND a 660px modal over it, with the ghost of that column — and
   * a second action bar — legible behind the sheet. The sheet is not a bigger view of the
   * message; it is a NARROWER duplicate of one already on screen.
   *
   * The rule was never in doubt, only unenforced: `readColumnHidden` is what "opened" means
   * on a width whose reading column is `display:none`, and `openReply` and `openMessage`
   * both already ask it. `OhboxView.open` was the one path that did not — it called
   * `onEnterReader` unconditionally, so ↵ and a second click on the selected row opened the
   * sheet at every width.
   *
   * IT IS GATED HERE AND NOT IN THE VIEW, deliberately. A view that asked the media query
   * itself would be a second copy of the predicate, live in one place and drifting from the
   * two that already exist — the shape the keyboard registry deleted from the (i) panel and
   * the action bar deleted from its own labels. The view's contract stays "the user asked to open this message"; what
   * that MEANS at a given width is the shell's answer, given once.
   *
   * The id still travels (see the call site): this narrows WHETHER, never WHAT.
   */
  const enterReader = useCallback(
    (messageId: string) => {
      if (readColumnHidden()) setReaderFor(messageId);
    },
    [readColumnHidden],
  );

  const waitingLive = screener.waiting.filter((w) => !screener.isExiting(w.id));

  /**
   * READ-STATE, for every view.
   *
   * One call site for one mutation. Before this, "seen" meant three different things depending
   * on where you were standing: Reads dispatched `feed_mark_seen`, Receipts kept an unpersisted
   * React `Set` that a reload erased, and the Ohbox dispatched nothing at all — opening a
   * message left it bold forever. All three now write the same row, and the worker puts `\Seen`
   * on the user's own IMAP server, which is what makes the state survive the product.
   *
   * ── `via` IS A PASS-THROUGH, and no decision is taken here ──────────────────────────────
   *
   * A surface that marks mail read on the reader's BEHALF — the Ohbox's dwell commit, the
   * Receipts per-card mark — labels itself `"glance"`, and the engine is the single place that
   * acts on the label: it drops resurfaced ids from a glance, so a pin survives being merely
   * looked at. Absent means deliberate, which is every other caller of this (the read pill,
   * `⇧I`, bulk, read-all), and those spend pins exactly as they always have.
   *
   * Forwarding it is easy to lose and impossible to typecheck — a two-parameter callback is
   * assignable where three are expected — so `test/resurface-now-shell.test.ts` asserts the label
   * arrives at the adapter rather than trusting this line.
   */
  const markSeen = useCallback(
    (ids: string[], unread: boolean, via?: "glance") => {
      if (ids.length === 0) return;
      void engine.mutate({ kind: "mark_seen", messageIds: ids, unread, ...(via ? { via } : {}) });
    },
    [engine],
  );

  /**
   * "Mark all read" for a whole view. Unlike {@link markSeen}, this CHUNKS at
   * {@link MARK_SEEN_CHUNK} because a full-view selection can exceed the route's 200-id cap; each
   * chunk is a separate mutation with its own Idempotency-Key. The write reaches `\Seen` via the
   * worker; the API opens no IMAP. `dispatchMarkAllRead` is a no-op on an empty list.
   *
   * ── IT ANSWERS WITH AN UNDO, because the press is one click over hundreds ────────────────
   *
   * The button fired instantly, silently and irreversibly: no confirmation, no toast, and at
   * three hundred unread the only way back was marking each row unread by hand. A confirm
   * dialog is the wrong ceremony for a verb that is usually meant — the product's own pattern
   * is the TRUE-UNDO toast (`ToastHost`: the toast carries the action, it fires at most once).
   * The undo flips exactly the ids this press flipped, through the same chunked walk
   * (`dispatchMarkAll`, unread direction), so what it restores is precisely what was taken —
   * mail that was already read before the press stays read, which a blanket "mark everything
   * unread" would get wrong. Held longer than the default toast, since reading "Marked 312
   * read" and deciding takes longer than a confirmation glance.
   */
  const markAllRead = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      dispatchMarkAllRead((m) => engine.mutate(m), ids);
      toast(t("markAll.done", { count: ids.length }), {
        action: t("markAll.undo"),
        onAction: () => { dispatchMarkAll((m) => engine.mutate(m), ids, true); },
        duration: 6000,
      });
    },
    [engine, toast, t],
  );

  /**
   * BODY HYDRATION, WIRED ONCE.
   *
   * Both reads read `engine.read()` at INVOCATION time — the same discipline `conversationOf`
   * documents below — and both are keyed on `engine` alone, NOT on `version`: a new identity every
   * mirror delta would re-fire every view effect that depends on `hydrateBody` once per delta.
   *
   * `hydrateBody` is `makeHydrateBody(engine)` (see its docblock) so that the FORWARD of the
   * caller's `{ retry }` option is a named, tested unit rather than an inline closure that once
   * silently dropped it. It swallows nothing: `OhmailEngine.hydrateBody` never rejects — its
   * outcome is a record the UI renders rather than an exception thrown at a React effect — so the
   * `void` inside the factory states there is no promise worth awaiting, not a discarded error.
   */
  const hydrateBody = useMemo(() => makeHydrateBody(engine), [engine]);
  const hydrateThread = useMemo(() => makeHydrateThread(engine), [engine]);
  const bodyOfMessage = useCallback(
    (m: EngineMessage) => bodyOf(engine.read(), m),
    [engine],
  );

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
    onFailed: (message) => toast(message),
    mode: consent.blockRemoteImages ? "manual" : "auto",
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
   * THE OHBOX'S SPLIT-PANE SELECTION IS THE INTENT.
   *
   * Selecting a row IS opening the message here — the reading column renders it in full
   * message anatomy, which is precisely why the snippet-only bug was hardest to see in this
   * pile: a truncation inside that anatomy reads as a short email rather than as a missing
   * body. So the selected message's body is fetched, one id, on selection.
   *
   * It lives in the shell rather than in `OhboxView` for the reason `message-chrome.tsx`
   * gives: the pane is mounted twice while the reader is open, `test/ohbox-read-state.test.ts`
   * mounts the view with no `EngineProvider`, and the dwell machinery in that view is not
   * something this change may reach into. The reader sheet shows the same message, so opening
   * it needs no second trigger.
   *
   * `urgent`, AND ONLY THE TWO SELECTION EFFECTS PASS IT. This is the one message that IS the
   * screen, so it must not queue behind the four-wide body limiter while a Screener preview's
   * backlog — bodies nobody is looking at — drains ahead of it. It is deliberately not `retry`:
   * that flag would also re-ask a server that already refused, on an effect that re-runs, which
   * is the billed poll `hydrateBody`'s failed-guard exists to prevent.
   */
  useEffect(() => {
    if (selectedOhbox) hydrateBody(selectedOhbox.id, { urgent: true });
  }, [selectedOhbox?.id, hydrateBody]);

  /**
   * THE READER'S OWN MESSAGE IS HYDRATED TOO — the gap that made History snippet-only.
   *
   * The effect above covers the split-pane selection (`selectedOhbox`). A message opened
   * STRAIGHT into the reader sheet was never reached by it: History's `onOpen` sets
   * `readerFor` directly, and every width whose reading column is hidden opens the sheet
   * rather than a selection. So the pane rendered `bodyOf` over an un-hydrated mirror — a
   * `snippet`, with no html for `MessageBody` to render — which is exactly the inconsistency
   * routing every surface through one viewer is meant to close. Keyed on `readerFor` for the
   * same reason the selection effect is keyed on `selectedOhbox.id`; `hydrateBody` is
   * single-flight and idempotent, so the overlap when the reader shows an Ohbox message costs
   * nothing.
   */
  useEffect(() => {
    if (readerFor) hydrateBody(readerFor, { urgent: true });
  }, [readerFor, hydrateBody]);

  // The engine's `unread` IS the answer now — the client-side overlay that used to sit on top of
  // it is gone. The optimistic overlay already makes the flip instant, and unlike the `Set` it
  // survives a reload, because it is backed by a row.
  const receiptsIsUnread = useCallback((m: EngineMessage) => m.unread, []);
  const receiptsUnread = receipts.filter(receiptsIsUnread).length;
  /**
   * WHAT THE RAIL COUNTS FOR THE STREAMS: "new since last visit" — the fresh side of each
   * view's line — never an unread count. Reads and Receipts carry no per-row unread status,
   * so an unread badge there would be a number derived from a signal the piles themselves no
   * longer show, and it would keep demanding attention for mail that is simply old. The
   * fresh count is the line's own statement, it goes quiet when a visit ends, and
   * `rail.readsTitle` ("{count} new") has said exactly this all along. `receiptsUnread`
   * above survives for Mark-all-read only (Reads computes its own inside the view) — that
   * control is about `\Seen` on the user's other clients, not about this pile's newness.
   */
  const readsNew = partition.fresh.length;
  const receiptsNew = receiptsPartition.fresh.length;

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
  const openTagPicker = useCallback((messageId: string, anchor: HTMLElement | null) => {
    setPickerIds(null);
    setPicker({ forId: messageId, ...placePicker(anchor) });
  }, []);

  /**
   * THE INLINE REPLY.
   *
   * Opening it does NOT change the route and does not close the reader: that is the whole
   * complaint. The draft is restored from `localStorage` on open, so a reload lands you
   * back in the same half-written sentence.
   */
  const openReply = useCallback((messageId: string, all = false) => {
    // The mode travels with the open, never separately: a Reply press while a reply-all
    // editor is up on the same message is an explicit narrowing, and vice versa.
    setReplyAll(all);
    setReplyTo(messageId);
    setReplyBody(readReplyDraft(messageId));
    // MOBILE. Under 900px the reading column is `display:none` (app.css), so an inline
    // reply would mount into a pane nobody can see and `r` would look broken — measured on
    // the shipped build at 390px. There, the reader IS the open message, so open it.
    if (readColumnHidden()) setReaderFor(messageId);
  }, [readColumnHidden]);

  const closeReply = useCallback(() => setReplyTo(null), []);

  /**
   * REPLY IS A TOGGLE ON THE VERBS THAT SAY "Reply" — the pill's button and the `r`/`⇧R` keys.
   * Pressing the verb that opened the editor closes it again; the draft survives, exactly as
   * it survives Cancel and Escape (`closeReply` and the scratch buffer's own rule).
   *
   * The MODE is part of the identity, which is what keeps the narrowing `openReply` documents:
   * Reply pressed while a reply-ALL editor is up on the same message is an explicit narrowing
   * (and vice versa), not a close — only the same verb on the same message toggles. Retargeting
   * paths (a panel's ⋯ menu, a sibling's footer verbs, the drafter) stay on `openReply`, because
   * "reply to THIS message" is not a toggle.
   */
  const toggleReply = useCallback((messageId: string, all = false) => {
    if (replyTo === messageId && replyAll === all) {
      setReplyTo(null);
      return;
    }
    openReply(messageId, all);
  }, [replyTo, replyAll, openReply]);

  const onReplyBody = useCallback(
    (next: RichValue) => {
      setReplyBody(next);
      if (replyTo) writeReplyDraft(replyTo, next);
    },
    [replyTo],
  );

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
  const placeDraft = useCallback(
    (messageId: string, next: RichValue) => {
      // An arriving draft keeps the audience the editor already has on this message — a
      // reply-all someone bought a draft for must not silently narrow to the sender alone —
      // and resets to a plain reply when it opens the editor on a different message.
      setReplyAll((prev) => replyToRef.current === messageId && prev);
      setReplyTo(messageId);
      setReplyBody(next);
      writeReplyDraft(messageId, next);
      // Same mobile rule `openReply` states: under 900px the reading column is display:none,
      // so an editor mounted there is one nobody can see.
      if (readColumnHidden()) setReaderFor(messageId);
    },
    [readColumnHidden],
  );

  /**
   * THE DRAFT ARRIVES. It goes into the editor and NOWHERE ELSE.
   *
   * No mutation is dispatched, nothing is sent, and no triage state moves — a generated draft
   * is not an answered message, and the Reply Run's debt is discharged by a send settling and
   * by nothing else (`onSendSettled`). That separation is asserted rather than described; see
   * `draft-reply-wiring.test.tsx`.
   *
   * An empty editor takes the draft directly, because there is no question to ask. A non-empty
   * one is asked, and keeps its text until it is answered.
   */
  const onDraft = useCallback(
    (draft: DraftedReply, messageId: string) => {
      const existing =
        replyToRef.current === messageId ? replyBodyRef.current : readReplyDraft(messageId);
      if (isRichEmpty(existing)) {
        placeDraft(messageId, draft);
        return;
      }
      // The reply is opened either way, so the question is asked beside the text it is about
      // rather than in a dialog over a message that is not on screen.
      placeDraft(messageId, existing);
      setPendingDraft({ draft, messageId });
    },
    [placeDraft],
  );

  const draftReply = useDraftReply({ onDraft });

  const resolveDraft = useCallback(
    (mode: "replace" | "append") => {
      if (!pendingDraft) return;
      const { draft, messageId } = pendingDraft;
      const existing =
        replyToRef.current === messageId ? replyBodyRef.current : readReplyDraft(messageId);
      placeDraft(messageId, mode === "replace" ? draft : appendRich(existing, draft));
      setPendingDraft(null);
    },
    [pendingDraft, placeDraft],
  );

  const draftReplyChrome = useMemo(
    () => ({ control: draftReply, pending: pendingDraft, resolve: resolveDraft }),
    [draftReply, pendingDraft, resolveDraft],
  );

  /**
   * SENDING. The state machine, the retry driver and the triage clear all live in
   * `mail-send.ts`; this only says what "the send settled" means to the shell.
   *
   * For a reply: close the editor, but ONLY if it is still open on that same message. A
   * confirmation can arrive from a retry long after the user moved on, and closing whatever
   * editor happens to be open then would discard a different half-written reply.
   *
   * For a compose: empty the form. The scratch buffer in `localStorage` is cleared by the send
   * machine itself (it must happen even if this view is long gone); this is the in-memory half,
   * and without it the fields would still be full of a message that has already been delivered.
   *
   * ── AND FOR A REPLY RUN STEP: THIS IS WHERE IT IS DISCHARGED ────────────────────────────
   *
   * `onDone` used to dispatch `triage_set → none` at PRESS time and step forward, with no send
   * anywhere. Adding a send while keeping that would have left TWO independent discharge
   * rules, and two discharge rules is exactly how a FAILED send still clears the debt — the
   * same bug wearing the fix as a costume. So the press only sends, and everything that means
   * "this one is dealt with" happens here: `settle` calls this on a CONFIRMATION and on
   * nothing else, so a step is left behind only by a reply that exists. The triage state
   * itself is cleared by `settle` in `mail-send.ts`, which is now the only rule
   * that clears one.
   */
  /**
   * THE AUTOSAVE HOOK'S `release`, THROUGH A REF, AND THE REF IS NOT DECORATION.
   *
   * `onSendSettled` is declared here and `useComposeAutosave` is called two hundred lines below
   * it — it needs `composeMailbox`, which needs the resolved From options, which need the
   * mailboxes. Naming `autosave` directly in the callback body would be a temporal-dead-zone
   * reference that TypeScript accepts (it is inside a closure) and that cannot be put in the
   * dependency array without throwing at render. The ref is assigned once the hook exists, which
   * is the shape `attachments.ts` uses for the same reason.
   */
  const releaseDraft = useRef<(sentDraftId: string | null) => void>(() => {});
  /** Late-bound for the same reason as {@link releaseDraft} — see below where it is assigned. */
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
  /**
   * THE STRANDED ROW A COMPOSE IS RECOVERING — an `unverified` (or stale-`sending`) draft whose
   * text was seeded into Compose, or the row a send just left in `unverified`. The compose does
   * NOT adopt it: adopting would point autosave and Send at a row the server refuses to send
   * again (`SendService` takes only `status='draft'`), so the recovery writes a FRESH row and
   * this ref remembers the stranded one. Discharged when the fresh send CONFIRMS — the moment
   * the message is known delivered, the stranded copy of it is a phantom and is discarded, the
   * `replySeedDrafts` rule one surface over. Cleared without discarding when the user abandons
   * the recovery (cancel, a different draft, a forward): nothing got delivered, so the record
   * of the unconfirmed send stays in Drafts.
   */
  const recoverySeed = useRef<string | null>(null);

  /**
   * The reply that most recently settled, handed to `OhboxView` for the animate-to-Earlier gesture
   * — the Ohbox's one deliberate mid-session move: the answered row slides to "Earlier" and is
   * marked read. Set only for a reply: a compose answers nothing and moves no row out of "New for
   * you".
   */
  const [replyDone, setReplyDone] = useState<OhboxReplyDone | null>(null);

  const onSendSettled = useCallback((key: string, m: MailSendMutation) => {
    if (key === COMPOSE_SEND_KEY) {
      setCompose(EMPTY_COMPOSE);
      /* THE RECOVERED MESSAGE IS DELIVERED, so the stranded row it was recovered from is a
         phantom copy of a sent mail and goes — see `recoverySeed`. Only on a CONFIRMED send:
         this callback fires on nothing else. */
      const seeded = recoverySeed.current;
      if (seeded && seeded !== m.draftId) {
        recoverySeed.current = null;
        void engine.mutate({ kind: "draft_discard", draftId: seeded });
      }
      /* RELEASED WHEN THE SEND USED THE ROW, DISCARDED WHEN IT DID NOT — `autosave.settled`
         judges by the settled mutation's own `draftId`. A send that carried the row turned it
         into a sent message (`SendService` moved it to `sent`), and deleting that would destroy
         the account's record of an outgoing mail; a send pressed while the first save was still
         on the wire carried NO id, made its own row, and the one autosave then adopted is a
         phantom draft — the sent message sitting in Drafts, reopenable with Send live. */
      releaseDraft.current(m.draftId ?? null);
      /**
       * ── AND THE MESSAGE IS SENT, SO THE COMPOSE IS OVER ────────────────────────────────
       *
       * Compose used to stay on screen after a confirmed send: the form emptied and the view
       * did not change, so the only thing that said the mail had gone was a toast, and the
       * reader was left staring at a blank compose form wondering whether to press Send again.
       * `cancelCompose` has always navigated (`go("ohbox")`); the successful path did not.
       *
       * ON THE CONFIRMATION AND NOT ON THE PRESS, which is the whole reason this can be here
       * rather than in `sendCompose`. The Ohbox this lands on already holds the message: the
       * engine materialises the optimistic Sent copy from the server's own `{status:"sent"}`
       * answer, and `dispatch` now does that the instant that answer arrives rather than behind
       * a reconciliation drain — so by the time this callback runs, the row is in the mirror and
       * "Earlier" renders it first (`readTimeOf` ranks a sent message by when it was sent).
       * Navigating at press time would show an Ohbox that does NOT yet hold it, and a message
       * appearing a second after the list did is the flicker this is avoiding. A send that fails
       * never reaches here at all — the compose stays put with its text, which is where somebody
       * has to be to decide what to do about it.
       *
       * The selection is cleared with it. Arriving at a list with a message open from an
       * earlier visit puts a stranger's mail in the reading column at the moment the reader is
       * looking for their own — and the row this arrival is about is at the top of the list,
       * unselected, exactly as arriving anywhere else in the product leaves it.
       */
      setOhboxSel(null);
      go("ohbox");
      return;
    }
    // A reply seeded from a draft row settled: the row's message has been delivered (the send
    // wrote its own row), so the seed is a phantom draft now — see `replySeedDrafts`.
    const seeded = replySeedDrafts.current.get(key);
    if (seeded) {
      replySeedDrafts.current.delete(key);
      void engine.mutate({ kind: "draft_discard", draftId: seeded });
    }
    // A reply settled. `key` is the answered message's id (`sendKeyOf`), which is exactly the row
    // that should move from "New for you" to "Earlier" — so hand it to the Ohbox for the gesture.
    setReplyDone({ messageId: key, at: new Date().toISOString() });
    setReplyTo((cur) => (cur === key ? null : cur));
    // A reply to this message has been delivered, so a drafted alternative to it is moot.
    // This is the ONLY thing that discards an unplaced draft other than answering the
    // question, because the AI action behind it has already been spent.
    setPendingDraft((p) => (p?.messageId === key ? null : p));

    /*
     * Guarded on the item the run is STANDING ON, not on "a run is open". A confirmation can
     * arrive from a flush minutes after the press — by which time the user may have skipped
     * past that message, or closed the run and started a second one over a fresh snapshot of
     * a pile that has moved. Advancing on the key alone would step over a message nobody
     * answered, which is the same lie in a rarer form. A late confirmation for a message the
     * run is no longer on still discharges the debt (`settle` does that), and simply does not
     * move a cursor that has gone elsewhere.
     *
     * `fr` is closed over rather than read from a ref because `useMailSend` re-points
     * `settledRef` on every render, so what runs here is always the latest committed run.
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
  }, [fr, engine]);
  const mailSend = useMailSend(engine, toast, onSendSettled);
  /**
   * The body comes from REACT STATE, not from `readReplyDraft`. Private mode refuses the
   * `localStorage` write, so re-reading the scratch buffer at press time would send an empty
   * reply — or, with the empty guard in place, refuse to send at all — for anyone browsing
   * privately. The editor is only reachable while `replyTo` is this message, so the guard
   * below is a belt on the same waistband.
   */
  /**
   * WHICH ADDRESSES THIS ACCOUNT CAN SEND FROM. The rule is `compose-from.ts`; this
   * is the one place the two sources of mailboxes are reconciled.
   *
   * `GET /mailboxes` when we have it — it is the only source that knows an address is
   * `disabled`, and the only one with a `createdAt` to order by. The mirror's `"mailbox"`
   * entities otherwise, which is the demo and the Desktop: `"mailbox"` is not an `EntityType`
   * in the change log, so those rows exist only where the FixturesAdapter seeded them.
   *
   * An EMPTY list is "nothing can be named", and every consumer below renders no From line and
   * puts nothing extra on the wire rather than guessing. That is the Desktop, and it is also a
   * Cloud tab in the moment before its first poll lands.
   */
  const fromOptions = useMemo(
    () => (facts ? optionsFromFacts(facts) : optionsFromMirror(mailboxes)),
    [facts, mailboxes],
  );

  /**
   * The body comes from REACT STATE, not from `readReplyDraft`. Private mode refuses the
   * `localStorage` write, so re-reading the scratch buffer at press time would send an empty
   * reply — or, with the empty guard in place, refuse to send at all — for anyone browsing
   * privately. The editor is only reachable while `replyTo` is this message, so the guard
   * below is a belt on the same waistband.
   *
   * ── AND IT NAMES A MAILBOX ONLY TO OVERRIDE ONE ─────────────────────────────────────────
   *
   * A reply sends from the mailbox the message arrived in, and `Engine.enrich` already derives
   * that from the parent (`engine.ts:671`) — so the ordinary case adds NOTHING here and the
   * envelope is unchanged. `mailboxId` is attached only when the resolved sender is NOT the
   * parent's: the parent's mailbox is `disabled` or gone and `resolveReplyFrom` named a substitute
   * (`InlineReply` SAYING SO on screen), or the reader picked a different address in the From
   * selector (`replyFromId`). The wire and the sentence come from the same call over the same
   * override, which is the point of it being a pure function.
   *
   * When nothing can be named the field stays off and `enrich` behaves exactly as before —
   * `sendingMailboxId`'s newest-message guess is a COMPOSE fallback and must never reach a
   * reply, where it would silently answer from an address the sender never wrote to.
   */
  const sendReply = useCallback(
    (messageId: string) => {
      if (messageId !== replyTo) return;
      const parent = reader.get<EngineMessage>("message", messageId) ?? null;
      const parentMailbox = parent?.mailboxId ?? null;
      const from = resolveReplyFrom(fromOptions, parentMailbox, replyFromId);
      // WHO IT IS ADDRESSED TO — `replyEnvelopePlan`, ONE derivation for the head, the lock
      // and this wire. Untouched (`replyEnvelope === null`) it is exactly the old inline
      // resolution: `replyAllRecipients` for a reply-all (the same call that let the button
      // render), `replyRecipients` for the self-authored plain case, nothing otherwise so
      // `Engine.enrich` keeps deriving `[parent.from]` — and never a Bcc, which no reply
      // derives. EDITED, the user's strings are the envelope: To/Cc/Bcc parsed by the compose
      // form's own parser, a typo emptying the whole set so `canSend` refuses it (the same
      // rule `composePlan` enforces, arriving on the same predicate).
      const plan = replyEnvelopePlan(
        parent,
        fromOptions.map((o) => o.address),
        replyAll,
        replyEnvelope,
      );
      mailSend.send({
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
        ...replyEnvelopeOnWire(plan),
      });
    },
    [mailSend, replyTo, replyAll, replyBody, replyEnvelope, replyFromId, replyAttachments, reader, version, fromOptions],
  );

  /**
   * THE COMPOSE PLAN — the mutation, the rejected recipients and the empty-subject note, all
   * derived in one place from the form (`compose.ts`).
   *
   * The mailbox is resolved here rather than left to `Engine.enrich`, even though enrich would
   * fill a value: the BUTTON has to know whether a mailbox exists, because offering Send on an
   * account with nothing to send from is the inert affordance Compose used to be. One derivation, two
   * consumers — the same discipline as `canSend`.
   *
   * ── AND IT IS NO LONGER `sendingMailboxId` THAT DECIDES ─────────────────────────────────
   *
   * `sendingMailboxId` answers with the mailbox of the account's NEWEST MESSAGE, which on an
   * account with two connected addresses flips the From line every time the other one receives
   * mail. It survives only as the last resort for the case `resolveComposeFrom` cannot speak
   * to — no facts and no seeded mirror rows — where it is still better than refusing to send,
   * and where there is no From line on screen for it to contradict.
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
  });
  releaseDraft.current = autosave.settled;

  /**
   * THE DRAFTS LIST, and the two things a row can do.
   *
   * `draftsList` lists what the user can still act on: `draft` rows, plus `unverified` and
   * stranded-`sending` ones — a send that did not confirm holds the only copy of its text, and
   * a list that hid it made an undelivered message invisible on every surface. `sent` rows and
   * live sends stay out (see the selector's own header).
   *
   * ── OPENING ONE ────────────────────────────────────────────────────────────────────────
   *
   * A draft that answers a message THIS DEVICE HOLDS opens in that message's own inline editor,
   * where the conversation it belongs to is on screen. Anything else — a compose, or a reply
   * whose parent has not synced here — opens in Compose. `repliesHere` is the same predicate the
   * row is labelled from, so the badge and the destination cannot disagree.
   *
   * Opening a compose draft ADOPTS its id, so the very next autosave PATCHes the row that was
   * opened rather than creating a second one beside it. Opening an UNCONFIRMED send does NOT
   * adopt — see `recoverySeed`: the server refuses to send a row past `draft` again, so the
   * text is recovered into a fresh row and the stranded one is discarded only once the fresh
   * send confirms.
   *
   * ── AND OPENING A REPLY DOES NOT ADOPT ─────────────────────────────────────────────────
   *
   * The inline reply editor has no autosave — it is a per-message scratch buffer — so there is
   * nothing to adopt the id INTO, and adopting it into the COMPOSE hook would point the next
   * compose at a reply row. The draft's text seeds the editor and the row stays as it is; sending
   * the reply creates its own row, exactly as it did before. Stated because it is the one place
   * the "one row birth-to-sent" rule does not yet reach, and a reader will otherwise assume it
   * was an oversight.
   */
  const drafts = useMemo(() => draftsList(reader), [reader, version]);
  const draftRepliesHere = useCallback(
    (d: EngineDraft): boolean =>
      d.inReplyToMessageId != null && reader.get<EngineMessage>("message", d.inReplyToMessageId) != null,
    [reader, version],
  );
  const openDraft = useCallback(
    (d: EngineDraft) => {
      const parent = d.inReplyToMessageId
        ? reader.get<EngineMessage>("message", d.inReplyToMessageId)
        : null;
      if (parent) {
        /* The message's own inline editor, seeded with what was written. `openMessageRef` and
           not `openMessage` directly: that callback needs the screener row map and the consent
           partition and is therefore declared far below this one, so the reference is late-bound
           for the same reason `releaseDraft` is. */
        setReplyBody({ text: d.body, html: "" });
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
        body: d.body,
        // NO `html`. The row stores the markup the server derived its plain part FROM, and the
        // mirror's `EngineDraft` does not carry it — seeding the rich editor from `body` would
        // silently flatten a formatted draft to text and then save the flattening back over it.
        // Plain text is the honest reading of what this client holds.
        html: "",
        fromMailboxId: d.mailboxId,
        // NO `forwardOf`, and it cannot be otherwise: `forwardOf` rides the SEND request, never the
        // draft row (`send-service.ts` reads it from the request body), so the `drafts` table has no
        // column that could remember it and an `EngineDraft` carries nothing to read back. A forward
        // abandoned to autosave and reopened from the drafts list is therefore a plain compose whose
        // subject still says "Fwd:" — the original is not quoted into it. That is the honest reading
        // of what the account stored, and it is preferable to the alternative on offer: quoting the
        // original into the draft body at write time would put a copy of somebody else's message —
        // possibly a redacted sensitive one — into a stored row, which is the exact thing the
        // server-side quote exists to prevent. Recorded here because a reader will otherwise take it
        // for an oversight, and because the fix is a schema change, not a line in this function.
      };
      setCompose(seeded);
      writeComposeDraft(seeded);
      if (d.status === "draft") {
        recoverySeed.current = null;
        autosave.adopt(d.id, seeded);
      } else {
        /* AN UNCONFIRMED SEND, RECOVERED — NOT ADOPTED. The row is `unverified` or a stranded
           `sending`: the server refuses to send it again under any key (`SendService` reserves
           only from `status='draft'`), and adopting it would point every autosave PUT and the
           Send press at that refusal. So the TEXT is seeded, the first pause writes a fresh
           row, and the send delivers that one — the deliberate fresh send the unverified copy
           has always promised. The stranded row stays in Drafts as the record of what is not
           known until the fresh send CONFIRMS, at which point `onSendSettled` discards it. */
        recoverySeed.current = d.id;
        autosave.release();
      }
      go("compose");
    },
    [draftRepliesHere, autosave, go, reader, version],
  );
  const discardDraft = useCallback(
    (draftId: string) => {
      void engine.mutate({ kind: "draft_discard", draftId });
      // The compose form may be holding the very row that was just deleted — discarding from the
      // list while it is open would otherwise leave autosave PATCHing a row that is gone, and the
      // next pause would report a 404 nobody could act on.
      if (autosave.draftId === draftId) autosave.release();
      // The reply editor may be holding it too — a settle after this delete must not delete twice.
      for (const [msgId, dId] of replySeedDrafts.current) {
        if (dId === draftId) replySeedDrafts.current.delete(msgId);
      }
      // And so may a compose recovery — same rule, same reason.
      if (recoverySeed.current === draftId) recoverySeed.current = null;
    },
    [engine, autosave],
  );
  /* `autosave.draftId` goes on the mutation, so Send uses the row autosave already wrote instead
     of creating a second one — the whole point of one draft from first keystroke to delivery. */
  const plan = useMemo(
    () => composePlan(compose, composeMailbox, autosave.draftId),
    [compose, composeMailbox, autosave.draftId],
  );
  const onComposeFields = useCallback((next: ComposeFields) => {
    setCompose(next);
    writeComposeDraft(next);
  }, []);
  /**
   * A SECOND PRESS AFTER `unverified` IS A FRESH SEND, AND IT HAS TO BUILD A FRESH ROW.
   *
   * The warning's contract ("check your Sent folder before retrying"; the next press is a
   * deliberate fresh send) predates autosave, and autosave silently broke it for Compose: the
   * plan still carried the row's id, the row is `unverified`, and `SendService` refuses any
   * key on a row past `draft` — so the deliberate retry answered 409 "cannot be sent from
   * status 'unverified'" forever. The press now releases the stranded row (kept, as the record
   * of the unconfirmed first attempt — it is in Drafts saying so) and sends WITHOUT a row id,
   * so the adapter writes a fresh draft and a fresh reservation: exactly what the inline reply
   * has always done. When this send confirms, `onSendSettled` discards the stranded copy.
   */
  const sendCompose = useCallback(() => {
    if (mailSend.stateOf(COMPOSE_SEND_KEY).phase === "unverified" && autosave.draftId) {
      recoverySeed.current = autosave.draftId;
      autosave.release();
      const { draftId: _stranded, ...fresh } = plan.mutation;
      mailSend.send(fresh);
      return;
    }
    mailSend.send(plan.mutation);
  }, [mailSend, plan, autosave]);

  /**
   * ABANDONING THE COMPOSE — the row, the buffer and the form, in that order.
   *
   * `ComposeView` decides whether to ask first (`worthSaving`); this is what happens once the
   * answer is yes, and it has to be the shell's because the draft id is. All three copies of the
   * message are named here on purpose — the account row (`autosave.discard`), the `localStorage`
   * scratch buffer (`clearComposeDraft`) and the in-memory form — because leaving any one of them
   * is a message the user threw away coming back: the row would sit in Drafts, and the buffer
   * would refill the form the next time Compose opened.
   *
   * `discard` is not awaited. It is fire-and-forget for the same reason `discardDraft` above is:
   * the delete is queued through the engine, which owns the retry, and holding the view open
   * until the wire answers would make leaving a message feel like a network operation.
   */
  const cancelCompose = useCallback(() => {
    void autosave.discard();
    // An abandoned RECOVERY is only abandoned: the fresh copy this compose made goes (above),
    // but the stranded row it was recovering stays in Drafts — nothing got delivered, so the
    // record of the unconfirmed send is still the truth.
    recoverySeed.current = null;
    setCompose(EMPTY_COMPOSE);
    clearComposeDraft();
    go("ohbox");
  }, [autosave, go]);

  /**
   * FORWARDING A MESSAGE — the compose surface's entry, and the client half of the sensitive gate.
   *
   * ── IT SEEDS THE ORDINARY COMPOSE FORM, IT DOES NOT BUILD A MESSAGE ─────────────────────
   *
   * All this puts on screen is a `Fwd: …` subject, no recipients, an empty body and the original's
   * id in `forwardOf`. The quoted original, its attachments and the `no_forward` refusal are all
   * the server's (`send-service.ts`), so nothing here reads the original's BODY — which is the
   * point: a client that assembled the quote itself would be the one seam a redacted sensitive body
   * could leave the account through, and this shell never holds the unredacted bytes anyway.
   *
   * Recipients are deliberately EMPTY rather than pre-filled from the original: a forward goes to
   * somebody the user picks, and seeding the original's sender is how a "forward this to my
   * colleague" turns into a reply nobody meant to send.
   *
   * ── THE `no_forward` CHECK IS HERE AND ALSO ON THE SERVER, AND BOTH ARE NEEDED ──────────
   *
   * The server's is the authoritative one — a client's silence is not a guarantee. This one exists
   * so the refusal is legible: a user who presses Forward on an OTP learns why immediately, rather
   * than writing a message, picking a recipient, pressing Send and collecting a 403 on a draft that
   * can never be sent. The reason is the same in both places and the flag is the same flag.
   *
   * ── IT RELEASES THE AUTOSAVE FIRST ─────────────────────────────────────────────────────
   *
   * A forward is a NEW message. Without the release, `composePlan` would still carry the
   * `draftId` of whatever the form last held — an unrelated draft, possibly one opened from the
   * drafts list — so the forward would overwrite that row and send from it. `openDraft` adopts for
   * exactly the opposite reason; this is the same rule read the other way round.
   */
  const forwardMessage = useCallback(
    (messageId: string) => {
      const m = engine.read().get<EngineMessage>("message", messageId);
      if (!m) return;
      if (m.sensitivity?.no_forward) {
        toast(t("compose.forwardRefused"));
        return;
      }
      const seeded: ComposeFields = {
        ...EMPTY_COMPOSE,
        subject: forwardSubject(m.subject),
        forwardOf: messageId,
      };
      autosave.release();
      recoverySeed.current = null; // a forward replaces whatever the form held, a recovery included
      setCompose(seeded);
      writeComposeDraft(seeded);
      // The inline editor may be open on the message being forwarded; leaving it open would put a
      // reply box and a forward on screen for the same message. The route change closes the reader
      // by itself (the view-transition effect above), so only this needs saying.
      setReplyTo(null);
      go("compose");
    },
    [engine, toast, t, autosave, go],
  );

  /**
   * WRITE TO ONE PERSON — the contact popover's Write verb (viewer redesign).
   *
   * A NEW message with the To line prefilled, in the same `Name <address>` shape `openDraft`'s
   * `line()` writes and `parseRecipients` reads back. The ADDRESS is the stored wire form —
   * the chip decodes only its face — so what reaches the envelope is what the mirror holds.
   * The release-first rule is `forwardMessage`'s, for the same reason: without it the compose
   * would adopt whatever draft row the form last held and send over it.
   */
  const writeTo = useCallback(
    (address: string, name?: string) => {
      const seeded: ComposeFields = {
        ...EMPTY_COMPOSE,
        // The chips form: a prefilled recipient is settled, so it must open as a chip, not as
        // raw text in the input — the same rule as `openDraft`.
        to: formatRecipientChips([{ name: name ?? null, address }]),
      };
      autosave.release();
      recoverySeed.current = null; // same as `forwardMessage`: the form's contents are replaced
      setCompose(seeded);
      writeComposeDraft(seeded);
      // An open inline reply would otherwise sit under the compose the route change opens —
      // the same two-editors rule `forwardMessage` states.
      setReplyTo(null);
      go("compose");
    },
    [autosave, go],
  );

  /**
   * SCREENING FROM ANYWHERE — one call site for every surface.
   *
   * The plan comes from `sender-screening.ts`, which decides whether the endpoint can be
   * used at all; this only dispatches it and tells the truth about what happened.
   *
   * ── THE RULE'S OUTCOME IS AWAITED, AND ONLY THE RULE'S ──────────────────────────────────
   *
   * This used to toast on click for every outcome, which was survivable while the only claim
   * was "your mail moved" — a `move` that fails rolls its own row back on screen. It stopped
   * being survivable the moment the sentence started claiming something about FUTURE mail:
   * the rules surface's first cut printed "Rule revoked" over a 403 on a live account, and the fixtures
   * adapter never refuses, so every test was green. So `plan.ruleMutations` — and nothing else
   * — is awaited, and `screeningToast` picks the sentence from what the server actually said.
   * The branch lives beside the sentences in `sender-screening.ts`, never here.
   */
  const changeScreening = useCallback(
    (
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
    },
    [engine, reader, toast, t],
  );

  /**
   * Open the detail view for whichever scope the sheet was showing.
   *
   * The rows are attributed HERE, at open time, rather than inside the panel: the panel then
   * holds a plain snapshot and cannot re-derive a different answer on a re-render caused by a
   * sync drain landing mid-read. The sheet closes, because the panel replaces it.
   */
  const openSenderAudit = useCallback(
    (messageId: string, scope: ScreeningScope, address?: string) => {
      setSenderMenu(null);
      const sender = senderScreening(reader, messageId, address);
      if (!sender) return;
      setSenderAudit({
        title: scope === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address),
        domain: scope === "domain",
        rows: attributeMessages(reader, sender.scopes[scope].messages),
      });
    },
    [reader],
  );

  /**
   * `address` is the contact-chip override (viewer redesign): the sheet then resolves that To/Cc
   * address rather than the message's sender — see `SenderMenuState.address`. Every caller
   * that predates chips passes two arguments and gets the sender, unchanged.
   */
  const openSenderMenu = useCallback(
    (messageId: string, anchor: HTMLElement | null, address?: string) => {
      setSenderMenu({ messageId, address, ...placePicker(anchor) });
    },
    [],
  );

  /**
   * OPEN THE SUBJECT-RULE SHEET — from a message's title, and from the sender popover's last row.
   *
   * `chrome.openSubjectRule` has been a declared seam with nothing behind it since the reading
   * surface landed; this fills it. The anchor is the pressed element where there is one — the title
   * button dispatches `openSubjectRule(id)` with no element, so the sheet is placed by
   * `placePicker(null)`, exactly as a keyboard-invoked tag picker is.
   *
   * It CLOSES the sender popover, because the subject sheet replaces it: they answer the same
   * question about different halves of one message and two open sheets is two questions.
   */
  const openSubjectRule = useCallback((messageId: string, anchor: HTMLElement | null = null) => {
    setSenderMenu(null);
    setSubjectRule({ messageId, ...placePicker(anchor) });
  }, []);

  /**
   * WRITE THE TWO-TERM RULE, AND SAY ONLY WHAT THE SERVER CONFIRMED.
   *
   * The plan comes from `subject-rule.ts`; this dispatches it. The RULE mutation is awaited and the
   * moves are not — the same split `dispatchScreeningChange` documents at length, for the same
   * reason: a `move` that fails rolls its own row back on screen, while "future mail files there
   * too" is a claim about the server that a refusal falsifies. The fixtures adapter never refuses,
   * so a toast fired on click would be green in every test and wrong on a live account.
   *
   * Dispatched here rather than inside the sheet so the sheet stays a pure render of a plan, and so
   * the awaiting is testable without a DOM.
   */
  const confirmSubjectRule = useCallback(
    (messageId: string, term: string, dest: ScreeningDest, field: TermField = "subject") => {
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
    },
    [engine, reader, toast, t],
  );

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
  const onStageClickCapture = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (e.shiftKey) return;
      const hit = senderHitOf(e.target as HTMLElement);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      openSenderMenu(hit.id, hit.anchor);
    },
    [openSenderMenu],
  );

  const revokeRule = useCallback(
    (ruleId: string) => engine.mutate({ kind: "rule_delete", ruleId }),
    [engine],
  );

  const retargetRule = useCallback(
    (ruleId: string, destination: Folder) => engine.mutate({ kind: "rule_update", ruleId, destination }),
    [engine],
  );

  const toggleTag = useCallback(
    (messageId: string, tagId: string, assigned: boolean) => {
      const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
      void engine.mutate({ kind: "tag_assign", messageId, tagId, assigned });
      toast(assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }));
    },
    [engine, tags, toast, t],
  );

  /**
   * The same verb over a SET — and it is `tag_assign` fanned out.
   *
   * No new bulk mutation kind: `tag_assign` is per-message on the wire, the round trips are
   * one per message that actually CHANGES, and a selection is a handful of rows rather than
   * a pile. Inventing a bulk kind would mean a second server route to keep honest for a cost
   * nobody has measured — the brief asks for a measurement before that claim, and there is
   * none, so the fan-out stands.
   *
   * Messages that already agree with the target state are skipped. `tag_assign` is
   * idempotent, so this is not correctness — it is not asking a server to restate forty
   * things it already holds.
   */
  const bulkToggleTag = useCallback(
    (ids: string[], tagId: string, assigned: boolean) => {
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
    },
    [engine, reader, tags, toast, t],
  );

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
  const dropTag = useCallback(
    (ids: string[], tagId: string) => bulkToggleTag(ids, tagId, true),
    [bulkToggleTag],
  );

  /**
   * Mint a tag and put it on this message.
   *
   * ONE mutation, not two. The shell cannot call the API directly — `scripts/publish-desktop.mjs`
   * DENYs `app/api-client` from this shared shell — so the engine is the only wire, and
   * `tag_assign` carries the new name rather than a second `tag_create` verb: a create that
   * succeeded followed by an assign that failed would leave an empty tag the user never asked
   * for, and the two-request version has no transaction to undo it.
   *
   * The id is minted HERE so the optimistic effect paints the same tag the database stores. If
   * the name already exists the server's row wins and this id is simply never seen — the chip
   * then appears on the next drain under the real id, which is why nothing here asserts the
   * tag is visible yet.
   */
  const createTag = useCallback(
    (messageId: string, name: string) => {
      void engine.mutate({
        kind: "tag_assign", messageId, tagId: crypto.randomUUID(), assigned: true, createName: name,
      });
      toast(t("tag.toastTagged", { name }));
    },
    [engine, toast, t],
  );

  /**
   * ═══ THE TAG, WITHOUT A MESSAGE ═══════════════════════════════════════════════════════
   *
   * Reported as: the sidebar should let you add tags, and Settings → Tags is not implemented.
   * Both had one cause — `tag_assign`'s tag-or-create was the only way to mint a tag, so a
   * name had to be attached to a message to exist, and there was no rename or delete verb at
   * all. `POST /tags`, `PATCH /tags/:id` and `DELETE /tags/:id` had been mounted the whole
   * time with no caller; these three are the callers.
   *
   * The id is minted here for the optimistic row only. `POST /tags` lets the DATABASE choose
   * the id (unlike tag-or-create, which mints under the client's), so this uuid names a row
   * that lives exactly as long as the overlay — see the mutation's own comment.
   */
  const createTagAlone = useCallback(
    (name: string) => {
      void engine.mutate({ kind: "tag_create", tagId: crypto.randomUUID(), name });
      toast(t("tag.toastCreated", { name }));
    },
    [engine, toast, t],
  );

  const renameTag = useCallback(
    (tagId: string, name: string) => {
      void engine.mutate({ kind: "tag_rename", tagId, name });
      toast(t("tag.toastRenamed", { name }));
    },
    [engine, toast, t],
  );

  /**
   * The name is read BEFORE the mutation. Afterwards the optimistic effect has already
   * tombstoned the row, so `reader.get` answers undefined and the sentence would be about a
   * tag it could not name.
   */
  const deleteTag = useCallback(
    (tagId: string) => {
      const name = reader.get<TagDTO>("tag", tagId)?.name ?? "";
      void engine.mutate({ kind: "tag_delete", tagId });
      toast(t("tag.toastDeleted", { name }));
    },
    [engine, reader, toast, t],
  );
  /**
   * Recolour a tag. NO toast, deliberately: the dot changes colour in place, which is the
   * confirmation — a "Recoloured Invoices" toast would restate a change the eye already saw. The
   * picker only ever passes a renderable hue (`TAG_HUES`), and the server accepts exactly those,
   * so this cannot store a colour nothing can draw.
   */
  const recolorTag = useCallback(
    (tagId: string, hue: string) => {
      void engine.mutate({ kind: "tag_recolor", tagId, hue });
    },
    [engine],
  );
  const tagAdmin = useMemo(
    () => ({ onCreate: createTagAlone, onRename: renameTag, onRecolor: recolorTag, onDelete: deleteTag }),
    [createTagAlone, renameTag, recolorTag, deleteTag],
  );

  const onMessageAction = useCallback(
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
         * ═══ THE THREE HORIZONS ARE TOGGLES — the way OUT of a pile ═══════════════════════
         *
         * The wire has carried `state:"none"` since the triage route shipped
         * (`TriageWireState`; `TriageService.setState` accepts it) and NOTHING in the UI ever
         * dispatched it: the footer only switched piles, the ⋯ menu and ⌘K had no verb, and
         * the key that filed a message answered a re-press with a toast about being already
         * queued. One mis-key was irreversible until reply or resurface.
         *
         * So the verb that put a message IN a pile takes it out again — the same convention
         * `r` (reply editor) and `u` (read state) already keep, reached from the same three
         * places at once because the key, the footer button and the palette all dispatch
         * through here. The toast states the direction each press actually took.
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
        case "resurface_now":
          /**
           * "NOW" IS A STATE, NOT A DATE, and that is the only thing separating this arm from
           * the one above it.
           *
           * `bubbled_up` with a past `bubbleUpAt` would pin nothing until a bubble-up pass ran,
           * and the pass is not a promise this product can make at this latency — it is gated
           * inside the worker's cycle, and a standalone desktop install runs no worker at all.
           * So the mutation asks for the state the schedule exists to reach, the server writes
           * it in one transaction, and `ohboxView.resurfaced` has the row on the next drain.
           * No `bubbleUpAt`: there is no schedule to spend.
           */
          void engine.mutate({ kind: "triage_set", messageId: m.id, state: "resurfaced" });
          toast(t("ohbox.toastResurfaceNow"));
          break;
        case "resurface_done": {
          /**
           * THE DELIBERATE RELEASE, NAMED — "Done" on a resurfaced or scheduled message.
           *
           * FOR A PINNED MESSAGE IT IS ONE MUTATION AND IT ALREADY EXISTED: a deliberate
           * `mark_seen` (no `via`) spends the pin in the same act on both sides of the wire
           * (`spentResurface` in the overlay, `MessageService.spendResurface` in the route's
           * transaction), stamps `lastReadAt`, and the row files at the top of "Earlier" — the
           * choreography `OhboxView.slideOut` already draws. Nothing new is dispatched for it,
           * deliberately: a second wire verb for the same release would be two writers of one
           * fact.
           *
           * FOR A SCHEDULED MESSAGE (`bubbled_up`, sitting in the Resurface pile) the release
           * has an extra half: the booking is cleared FIRST (`triage_set: none` — the same
           * un-triage the horizon toggles use), then the same deliberate read files it. Same end
           * state, never a new one: unscheduled, read, top of "Earlier". Skipping the clear
           * would leave the pile listing a message the reader just said they were done with.
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
          void engine.mutate({ kind: "move", messageId: m.id, folder });
          toast(t("ohbox.toastMoved", { place: PLACE_LABEL[view] ?? view }));
          break;
        }
      }
    },
    [engine, toast, t, now, openReply, toggleReply, markSeen, draftReply, replyTo, replyAll],
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
   */
  const onStreamAction = useCallback(
    (action: MessageAction, m: EngineMessage) => {
      if (action === "reply" || action === "reply_all" || action === "draft") setReaderFor(m.id);
      onMessageAction(action, m);
    },
    [onMessageAction],
  );

  /**
   * ═══ THE SELECTION'S VERBS ══════════════════════════════════════════════════════════
   *
   * The requirement: a selection must offer more than mark unseen, mark read and Escape — it
   * needs the sender's screening and its tags too. The count was exact: ⇧U and Escape, in
   * one view.
   *
   * The vocabulary is the ACTION BAR's, not a second one invented for bulk — the same three
   * horizons, the same two filing verbs, the same read state. Reply is the one verb that is
   * dropped, because "reply to eleven messages" is not a thing the product can mean.
   *
   * Everything here dispatches through the ordinary engine path, one mutation per message,
   * and says ONE sentence at the end. A per-message toast over a selection of forty is not
   * feedback, it is a denial of service on your own screen.
   */
  const onBulkAction = useCallback(
    (action: BulkAction, ids: string[]) => {
      if (ids.length === 0) return;
      if (action === "read" || action === "unread") {
        // The batch mutation, unchanged: one request, one transaction, one intent.
        markSeen(ids, action === "unread");
        toast(
          t(action === "unread" ? "ohbox.toastBulkUnread" : "ohbox.toastBulkRead", {
            count: ids.length,
          }),
        );
        return;
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
        return;
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
        void engine.mutate({ kind: "move", messageId, folder });
        moved++;
      }
      toast(t("ohbox.toastBulkMoved", { count: moved, place: PLACE_LABEL[view] ?? view }));
    },
    [engine, reader, markSeen, toast, t, now],
  );

  /**
   * THE BULK SCREENING PLAN — grouped by SENDER, because that is what screening is about.
   *
   * A screener decision is not a per-message action, and a selection routinely mixes the two
   * cases the single-sender path already distinguishes: a sender still WAITING is decided
   * through `POST /screener/:id`, which promotes a **rule that governs all their future
   * mail**; a sender whose mail has left the Screener is a composition of `move`s with no
   * lasting effect at all. Ten messages from six senders, two of them waiting, is two
   * permanent consent records and four one-off moves — and a naive bulk apply would report
   * "10 messages moved" and never mention the two.
   *
   * So this returns the counts SEPARATELY and the surface states them before committing.
   * `planScreeningChange` per sender, never a bulk shortcut: forty senders decided through a
   * path that skips `screener_decide` would fork the consent record from the one
   * `screener-service.decide` writes.
   *
   * NOTE THE COUNT THIS DELIBERATELY REPORTS. The plan moves every message the mirror holds
   * from that sender, not only the ones that were picked — that IS what screening a sender
   * means, and it is precisely why the number has to be on screen before the button commits.
   */
  const planBulkScreening = useCallback(
    (ids: string[], dest: ScreeningDest) => {
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
    },
    [reader],
  );

  const onBulkScreen = useCallback(
    (ids: string[], dest: ScreeningDest) => {
      const plan = planBulkScreening(ids, dest);
      const place = PLACE_LABEL[dest] ?? dest;
      if (plan.mutations.length === 0) {
        toast(t("screening.toastBulkNothing", { place }));
        return;
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
    },
    [engine, planBulkScreening, toast, t],
  );

  /** Tag a whole selection: the shell's picker, pointed at a set. See `pickerIds`. */
  const openBulkTagPicker = useCallback((ids: string[], anchor: HTMLElement | null) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
    setPicker({ forId: ids[0]!, ...placePicker(anchor) });
  }, []);

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
   * The per-card sweep writer for Reads — ids ONLY, never an anchor. The waterline is "new
   * since last visit": it must hold still for the whole visit and move exactly once, on the
   * way out ({@link commitFeedSeen}). This used to re-send the current anchor with every
   * dwell-mark, which meant a first mark on a line-less pile MINTED a line mid-visit and the
   * partition reshuffled under the reader.
   */
  const readsMarkSeen = useCallback(
    (id: string) => {
      void engine.mutate({ kind: "feed_mark_seen", view: "reads", messageIds: [id] });
    },
    [engine],
  );

  /**
   * THE LEAVE-COMMIT, both streams — one anchored `feed_mark_seen` per departure, the
   * reliability floor under the per-card observers. The views hand up the anchor ("the top
   * of what was on screen") and the unread ids their final screen covered; this reads the
   * CURRENT meta at invocation time (the view is unmounting; its render-time partition is
   * already history) and skips entirely when nothing would change — a leave that flips
   * nothing and moves nothing is not worth a wire round-trip and the drain that follows it.
   */
  const commitFeedSeen = useCallback(
    (view: FeedView) =>
      (commit: { upToId: string; messageIds: string[] }) => {
        const held = engine.read().get<WaterlineMeta>("view_meta", waterlineIdOf(view));
        if (commit.messageIds.length === 0 && held?.newestSeenId === commit.upToId) return;
        void engine.mutate({
          kind: "feed_mark_seen",
          view,
          upToId: commit.upToId,
          messageIds: commit.messageIds,
        });
      },
    [engine],
  );
  const commitReadsSeen = useMemo(() => commitFeedSeen("reads"), [commitFeedSeen]);
  const commitReceiptsSeen = useMemo(() => commitFeedSeen("receipts"), [commitFeedSeen]);

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
  const screenerRowFor = useCallback(
    (m: EngineMessage, segment: ScreenerSegmentId): string | null => {
      const want = senderKey(m.from.address);
      const rows =
        segment === "waiting"
          ? screener.waiting
          : segment === "screened"
            ? screener.screenedOut
            : screener.spam.map((r) => r.sender);
      return rows.find((r) => senderKey(r.from.address) === want)?.id ?? null;
    },
    [screener.waiting, screener.screenedOut, screener.spam],
  );

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
  const pileHolds = useCallback(
    (view: "ohbox" | "reads" | "receipts", id: string): boolean => {
      if (view === "ohbox") return allOhbox.some((m) => m.id === id);
      if (view === "receipts") return receipts.some((m) => m.id === id);
      return partition.fresh.some((m) => m.id === id) || partition.seen.some((m) => m.id === id);
    },
    [allOhbox, receipts, partition.fresh, partition.seen],
  );

  const openMessage = useCallback(
    (m: EngineMessage) => {
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
        default:
          // No navigation, so no `readerPending` is needed: nothing will clear this. This is the
          // "folder no view owns" arm, the History arm and the PARKED arm — a message presented
          // in History, or filed into a bottom pile, belongs to no list, so the reader opens over
          // wherever you are, exactly as HistoryView's own row does — and now also the arm for a
          // hit no pile holds at all (an archive-only search result), which must still open the
          // message it named.
          //
          // The row travels with the open so the reader has something to show even when the
          // mirror holds none — see `readerOffMirror`. Set unconditionally: the mirror's own row
          // wins whenever there is one, so this is only ever consulted for a message there is no
          // other copy of.
          setReaderOffMirror(m);
          setReaderFor(target.id);
      }
    },
    [readColumnHidden, screenerRowFor, consentView?.placeOf, parked, pileHolds],
  );
  /* Assigned here so `openDraft`, which is declared several hundred lines above this, can open a
     reply draft in its own conversation. See {@link openMessageRef}. */
  openMessageRef.current = openMessage;

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

  const startFR = useCallback(() => {
    // NO `setFrValues({})`. Keyed by message, what is in that map is a reply somebody wrote
    // and has not sent — a run that begins by erasing it is the bug this change exists to end,
    // one keystroke earlier. A delivered reply is removed by `onSendSettled`, and nothing else
    // has the standing to.
    setFr({ step: 0, items: piles.replyLater });
  }, [piles.replyLater]);

  /**
   * The message the current view has under the cursor, whichever view that is.
   *
   * `s` and `e` mean the same thing everywhere or they mean nothing; without one answer to
   * "which message?" they would have to be re-declared per view with per-view semantics,
   * which is the state the keyboard registry exists to end.
   */
  const focused: EngineMessage | null =
    /**
     * AN OPEN READER IS THE CURSOR, WHATEVER VIEW IT IS OVER.
     *
     * First, and deliberately: the reader is the innermost thing on screen, so a message
     * verb pressed while it is open acts on the message being READ.
     *
     * NO GUARD FAILS IF THIS LINE IS DELETED, and that is stated rather than hidden — the
     * same honesty `OhboxView.pinnedUnread` uses about its own key. Every path that opens
     * the reader today also sets the pile's cursor to the same message (`OhboxView.open`,
     * `openMessage`'s Ohbox arm, `openReply` on mobile), so the two cannot yet disagree.
     * What makes the reader generalisable is precisely that it no longer has to be an Ohbox
     * message; the first surface that opens it over a pile with its own cursor would make
     * this load-bearing, and it is cheaper to be right now than to find out then. Coherence,
     * not a fixed bug — nothing observable changes today.
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

  /* ── the global key map. Views declare their own; see `keymap.tsx` for precedence. ── */
  const globalKeys: KeyBinding[] = [
    { chord: "g o", group: "navigate", label: t("shortcuts.goOhbox"), run: () => go("ohbox") },
    { chord: "g r", group: "navigate", label: t("shortcuts.goReads"), run: () => go("reads") },
    { chord: "g e", group: "navigate", label: t("shortcuts.goReceipts"), run: () => go("receipts") },
    { chord: "g s", group: "navigate", label: t("shortcuts.goScreener"), run: () => go("screener") },
    { chord: "g t", group: "navigate", label: t("shortcuts.goTriage"), run: () => go("triage") },
    { chord: "/", group: "navigate", label: t("shortcuts.search"), run: () => go("search") },
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
       * LIVE WHEREVER THE PILL THAT ADVERTISES IT IS — which is `focused`'s whole contract.
       *
       * This was `route.view !== "ohbox" || selectedOhbox == null`, so a message opened out
       * of Search rendered a Reply pill printing `r` (the pill reads this registry, and a
       * disabled binding still owns its chord) over a key that did nothing. The reader sheet
       * IS a message pane; a verb pressed while it is open acts on the message being read —
       * the rule `focused` already states. On the two skim streams the key takes the card
       * button's own path (`onStreamAction`), which raises the reader first so the editor
       * has a pane to land in. A TOGGLE, as before: `r` on the open editor closes it.
       */
      disabled: focused == null,
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
      run: () => {
        if (!focused) return;
        if (readerMessage != null || route.view === "ohbox") toggleReply(focused.id, true);
        else onStreamAction("reply_all", focused);
      },
    },
    {
      // SENDING FROM THE KEYBOARD. `inInput` is not optional: the editor takes
      // focus the moment it opens, so without it the one place the shortcut is for is the one
      // place it would not fire — the same reasoning Escape's binding already carries.
      //
      // `mod+Enter` and not bare `Enter`, because the field is a multi-line editor where
      // Enter is a new paragraph. The four views bind bare `Enter` as "open the row" and none
      // of them sets `inInput`, so the typing guard already keeps them out of this editor
      // (`isTypingTarget` answers true for a `contenteditable` as it did for the textarea);
      // this chord does not collide with any of them.
      //
      // The rich editor does not swallow it. ProseMirror's keymap handles `Enter` and
      // `Shift-Enter` and has no `Mod-Enter` binding, so the event is not consumed and reaches
      // the document listener this registry hangs on — which is why the chord stays here
      // rather than being reimplemented inside the editor's own `onKeyDown`.
      //
      // It calls the same `sendReply` the button does, so the send lock, the empty-body guard
      // and the whole failure surface apply identically — there is no second path to SMTP.
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
      run: () => focused && onMessageAction("later", focused),
    },
    {
      chord: "e",
      group: "message",
      // ohmail has no Archive: "out of the way, still here" is the Park pile. Naming it
      // Park rather than Archive is the honest mapping, not a missing feature.
      label: t("shortcuts.park"),
      disabled: focused == null,
      run: () => focused && onMessageAction("aside", focused),
    },
    {
      chord: "b",
      group: "message",
      label: t("shortcuts.resurface"),
      disabled: focused == null,
      run: () => focused && onMessageAction("resurface", focused),
    },
    {
      chord: "mod+k",
      group: "app",
      label: t("shortcuts.palette"),
      inInput: true,
      run: () => palette.toggle(),
    },
    {
      chord: "?",
      group: "app",
      label: t("shortcuts.sheet"),
      run: () => setShortcutsOpen((o) => !o),
    },
    /* Escape is NOT here. It is registered above, in the `overlay` scope, because an open
       overlay has to outrank a view's bindings and a global one does not. */
  ];
  useKeyBindings(globalKeys, "global");

  /* ── the palette command map (every command from the prototype) ── */
  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: "go-ohbox", label: t("palette.goOhbox"), keys: ["g", "o"], run: () => go("ohbox") },
      { id: "go-reads", label: t("palette.goReads"), keys: ["g", "r"], run: () => go("reads") },
      { id: "go-receipts", label: t("palette.goReceipts"), keys: ["g", "e"], run: () => go("receipts") },
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
  }, [t, tags, selectedOhbox, toggleTag, theme, onMessageAction, startFR]);

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
        label: t("rail.triage"),
        items: [
          { id: "triage", label: t("rail.replyLater"), count: piles.replyLater.length },
          { id: "triage-aside", label: t("rail.setAside"), count: piles.setAside.length },
          { id: "triage-resurface", label: t("rail.resurface"), count: piles.resurface.length },
        ],
      },
      // TAGS ARE THEIR OWN GROUP, not a sub-item of Triage. They were nested under it, which
      // said the wrong thing about what they are: triage piles are three fixed places a
      // message can sit, and tags are a cross-cutting dimension over every view (invariant:
      // "Tags (never folders)"). Filing the second under the first made tags read as a fourth
      // pile. Own group, own label, and it stands even when empty — a collapsed group with a
      // count of zero is how someone learns the feature exists.
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
      {
        items: [
          /**
           * HISTORY CARRIES NO COUNT, AND THAT IS A PROPERTY RATHER THAN A STYLE CHOICE.
           *
           * A sender with ANY unread mail is active whatever its age, so nothing unread can
           * reach History — the engine's cutline guarantees it by construction. A place that
           * cannot contain anything unread has nothing to demand, so a badge here would be a
           * number that is always the size of the past and never a call to act.
           *
           * `count` is therefore ABSENT rather than zero: `RailNav` renders an absent count as
           * nothing at all, and a literal `0` would draw a badge saying nothing is there.
           * `rail-history.test.tsx` asserts the key is missing, because a future edit adding
           * `count: history.length` would look like an improvement.
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
    [t, ohbox.newForYou.length, allOhbox.length, readsNew, receiptsNew, screener.waitingCount, piles, tagGroups, tags, createTagAlone],
  );

  /**
   * ═══ THE NUMBER KEYS ══════════════════════════════════════════════════════════════════
   *
   * `1`…`N` reach the piles in the order the rail lists them. Requested as navigation that
   * does not need the mouse and does not need a two-key sequence — `g o` / `g r` / `g e` /
   * `g s` already exist but only cover four destinations and none of the triage horizons.
   *
   * ── DERIVED FROM THE RAIL, NOT WRITTEN OUT BESIDE IT ──────────────────────────────────
   *
   * The numbers ARE the menu order, so they are read off `railGroups` rather than declared in
   * a parallel list. A hand-written table would be a second enumeration of the nav — the shape
   * the (i) panel's hand-typed key list had, and the one the `?` sheet is generated to avoid —
   * and it would go wrong the first time a group gained an item.
   *
   * Only the PILES are numbered: the three streams, the Screener and the three triage
   * horizons. Tags is a collapsible group whose contents are the user's own and change; Search
   * has `/` and Settings is not somewhere you flick to. `slice(0, 9)` because there is no key
   * `10` — a tenth pile would simply not be numbered rather than silently shifting the rest.
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
      // The rail's own label, so the sheet and the rail cannot disagree about what `3` is.
      label: t("shortcuts.goPile", { pile: item.label }),
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
    route.view === "tag"
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
      : route.view;

  const frFinished = fr != null && fr.step >= fr.items.length;
  const frItem = fr && !frFinished ? fr.items[fr.step] : undefined;
  /** The step's send, off the one machine — the run is a caller of it, not a second one. */
  const frSend = frItem?.messageId ? mailSend.stateOf(frItem.messageId) : null;

  /**
   * A REPLY BEGUN BEFORE A RELOAD IS STILL OWED.
   *
   * Seeded from the same per-message scratch buffer the inline editor uses, so a run resumed
   * in a new tab finds the sentence that was already written. Read AFTER mount rather than in
   * the state initializer, for the hydration reason `persisted-ui.ts` spells out: reading
   * storage during render makes the server and the client produce different markup and React
   * keeps the server's, so the saved text would be read and then silently discarded.
   *
   * Never overwrites what is already in memory. The map is the live editor; the buffer is only
   * its backup, and a key present with an empty string means "this one has been opened", not
   * "this one is unknown".
   */
  useEffect(() => {
    const id = frItem?.messageId;
    if (!id) return;
    setFrValues((vals) => (id in vals ? vals : { ...vals, [id]: readReplyDraft(id) }));
  }, [frItem?.messageId]);

  /**
   * A SEND THE RUN MADE THAT DID NOT LAND MUST SAY SO.
   *
   * `FocusReplyOverlay` renders a card and two buttons and has no status line, so the run's
   * only other feedback for a failure is the step NOT advancing — which is silence to somebody
   * who pressed Done and is waiting. The inline editor's four status strings say exactly the
   * same four things, so they are reused rather than re-worded, and none of them claims a
   * delivery: `settle`'s toast is the only sentence in the app that does, and it fires only on
   * a confirmation.
   *
   * Keyed on the PHASE moving, not on `t`/`toast` identity — a render-keyed effect here would
   * re-announce the same failure on every keystroke.
   */
  const frPhase = frSend?.phase ?? "idle";
  const frReason = frSend?.reason;
  useEffect(() => {
    if (frPhase === "idle" || frPhase === "sending") return;
    toast(
      frPhase === "queued"
        ? t("reply.statusQueued")
        : frPhase === "unverified"
          ? t("reply.statusUnverified")
          : t("reply.statusFailed", { reason: frReason ?? t("reply.reasonUnknown") }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frPhase, frReason]);

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
  const conversationOf = useCallback(
    (messageId: string) => threadOf(engine.read(), messageId),
    [engine],
  );

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
      absoluteTime,
      onToggleAbsoluteTime: toggleAbsoluteTime,
      replyTo, replyAll, replyBody, onReplyBody, closeReply, sendReply,
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
      // The host's surface declaration rides beside the reply's files because it is the other
      // half of the same ceiling: `InlineReply` states and refuses against
      // `composeAttachCap(from.maxMessageBytes, THIS)`, the exact pair the send will enforce.
      sendSurfaceMaxTotalBytes,
      addressBook: replyBook,
      /**
       * THE SIBLING VERBS, no longer dormant.
       *
       * `MessageCard` has rendered a Reply/Forward footer on every expanded conversation sibling
       * since the thread surface landed, and both buttons were declared OPTIONAL on the chrome so
       * the footer simply did not appear until a shell supplied them. Nothing did, so a reader
       * looking back at an older message in a thread had no way to answer it without first making
       * it the focused one — the exact detour the footer exists to remove.
       *
       * `openReply` is the SAME callback the focused message's action bar runs, passed straight
       * through: one reply machine, retargeted by id, so the mobile rule it carries (under 900px
       * the reading column is `display:none`, so open the reader) holds for a sibling too. Any
       * second implementation here would be a copy of that rule waiting to drift.
       */
      openReply,
      forward: forwardMessage,
      replySendState: mailSend.stateOf,
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
    }),
    [ownAddresses, absoluteTime, toggleAbsoluteTime, replyTo, replyAll, replyBody, onReplyBody, closeReply, sendReply, mailSend, draftReplyChrome,
      replyEnvelope, replyFromId, replyAttachments, sendSurfaceMaxTotalBytes, replyBook,
      openSenderMenu, ownNameOf, writeTo, openReply, forwardMessage, openSubjectRule,
      conversationOf, bodyOfMessage, hydrateBody, hydrateThread, attachments, remoteImages],
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
          <Kbd>⌘K</Kbd>
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
                try {
                  sessionStorage.setItem("ohmail.demo-ribbon", "gone");
                } catch {
                  /* fine — dismissed for this render only */
                }
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
        <SyncBar />

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
          <button type="button" className="tb-btn" onClick={palette.openPalette}>
            ⌘K
          </button>
        </div>

        <div className="deck">
          <ShellRail
            className={railOpen ? "open" : undefined}
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
            sync={<SyncBar variant="rail" />}
            /* The account line at the foot of the rail — and, in the signed-in BROWSER only, the
               quiet "Get ohmail for desktop" prompt (never in the desktop app, never the demo:
               see `showDesktopCta`). The two do not coexist — `account` is a demo-only fixture
               (`/sync` emits no `view_meta`), and the prompt shows only when `!demo`. */
            footer={
              account?.email || showDesktopCta({ demo, desktop: desktopSection != null }) ? (
                <>
                  {account?.email ? <span className="rail-mail-addr">{account.email}</span> : null}
                  {showDesktopCta({ demo, desktop: desktopSection != null }) ? (
                    <DesktopCta
                      href="/#download"
                      label={t("rail.getDesktop")}
                      dismissLabel={t("rail.getDesktopDismiss")}
                    />
                  ) : null}
                </>
              ) : undefined
            }
            ariaLabel={t("rail.ariaMain")}
          />

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
                noticeSection={
                  demo || !awaySupported || !awayNotice.on
                    ? undefined
                    : <AwayNotice audience={awayNotice.audience} />
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
                jumpTo={jump?.view === "reads" ? jump.id : null}
                onJumped={() => setJump(null)}
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
                freshCount={receiptsNew}
                tags={tags}
                now={now}
                cur={receiptsCur}
                onCur={setReceiptsCur}
                unreadCount={receiptsUnread}
                isUnread={receiptsIsUnread}
                /* The per-card dwell mark — a glance, like Reads' `readsMarkSeen`, and labelled
                   so the engine holds a resurfaced row's pin back from it. */
                markSeen={(id) => markSeen([id], false, "glance")}
                onLeaveSeen={commitReceiptsSeen}
                bodyOf={bodyOfMessage}
                hydrateBody={hydrateBody}
                jumpTo={jump?.view === "receipts" ? jump.id : null}
                onJumped={() => setJump(null)}
                onAction={onStreamAction}
                onMarkAllRead={markAllRead}
              />
            ) : null}

            {effectiveView === "screener" ? (
              <ScreenerView
                state={screener}
                /* Bound HERE, at the render, to the exact list the state computed this
                   frame — so the set that gets priced and the set that gets bought are one
                   list rather than two computations that agree today.

                   WITHHELD WHEREVER THERE IS NO SERVER TO ASK, and `demo` was never the whole
                   of that. The desktop app is not the demo — it shows somebody's real mail —
                   and it has no Cloud API at all, so this control rendered there, offered a
                   button, and answered every press with "that did not work": a control with
                   nothing behind it, which is the one thing this surface must never be. The
                   condition is now the same one `AutoOptInControl.supported` uses, and the
                   host that DOES have a way to ask brings its own control below.

                   Read off `autoOptIn.supported` rather than by calling `apiConfigured()` here,
                   so "is there a server to ask" has ONE answer in this file and this shared
                   shell keeps its standing rule of not importing the Cloud API client. */
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
                /* WHAT THE ALLOWANCE IS DOING, under the control that spends it. Bound here
                   rather than inside the view for the reason every injected node is: the answer
                   comes from the Cloud API, which this shared file may not call. The offer's
                   destination is bound HERE too — `openSettingsPane("billing")` — so the shell
                   keeps its routing and the injected node keeps its transport. Withheld on the
                   demo, which has no account and therefore no allowance to describe. */
                aiCreditNode={
                  demo || !aiCredits
                    ? undefined
                    : aiCredits({ onStartPlan: () => openSettingsPane("billing") })
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
                /* The same rename/delete verbs Settings uses — a tag is managed from its page. */
                admin={tagAdmin}
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
                  if (!back || back.view === "search" || (back.view === "tag" && !back.tagId)) go("ohbox");
                  else if (back.view === "tag") goTag(back.tagId!);
                  else if (back.view === "screener") goScreener(back.screenerSegment);
                  else if (back.view === "triage") goTriage(back.triagePile);
                  else go(back.view);
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
                plan={plan}
                send={mailSend.stateOf(COMPOSE_SEND_KEY)}
                onSend={sendCompose}
                onCancel={cancelCompose}
              />
            ) : null}

            {effectiveView === "drafts" ? (
              <DraftsView
                drafts={drafts}
                now={now}
                onOpen={openDraft}
                onDiscard={discardDraft}
                repliesHere={draftRepliesHere}
              />
            ) : null}

            {effectiveView === "settings" ? (
              <SettingsView
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
                /* Same posture as `desktopSection`, one seam over: the pane is about this
                   INSTALL's role, the HOST decides where it exists (the desktop gate wires it
                   only on the standalone door), and a browser tab passes nothing. */
                devicesSection={devicesSection}
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
                /* THE AUTO-WORK OPT-IN. Built here rather than injected from `CloudShell` for
                   the reason `seedSection` gives — it needs shell state — but a different piece
                   of it: the flag has to be written through the SAME `useConsentState` the
                   Screener's spender reads (`suggestions` above), or turning it off in Settings
                   leaves this tab still authorised and the next Screener open buys a batch the
                   user just revoked. `autoOptIn` is bound to `screener.unsuggestedSenders` here,
                   at the render, so the set that is priced is the set that will be bought.

                   `supported` is `wire.configured()`. It used to be `apiConfigured()` and this
                   comment used to name that, which made it false of BOTH desktop doors: the row
                   was withheld from a hosted install that has an account, an allowance and a
                   balance behind it, for want of a way to ask — `CloudSuggest.tsx` states the
                   consequence from the other side ("the setting that authorises it is written
                   from a Settings row this app does not render"). A host that hands in a
                   {@link suggestWire} has that way, and this is the row. A STANDALONE install
                   hands in none: no server, no account, nothing to buy. `demo` is withheld for
                   the same reason as every other injected pane. */
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
                  <DormancyRow days={consent.dormancyDays} setDormancyDays={consent.setDormancyDays} />
                )}
                /* REMOTE IMAGES. Gated on `consent.known` for a sharper version of the dial's
                   reason: the resting value is MANUAL, so drawing the row before the server has
                   answered would show a switch in the OFF position to an account whose stored
                   setting is ON — and somebody who then left it alone would believe they had
                   chosen the state they were merely shown. Absent on the demo (no server).

                   AND ON EVERY DESKTOP DOOR, INCLUDING THE HOSTED ONE, which is the clause a
                   `consentTransport` made necessary: `known` becomes true there, and this row
                   would then govern a mechanism that does not exist in the window. Consented
                   images load through `GET /img` on THIS ORIGIN — the proxy is what keeps the
                   reader's address away from the sender, and the same-origin url is what carries
                   the session cookie and satisfies the frame's `img-src 'self'`. A window under
                   `connect-src 'none'` has no such origin and `useRemoteImages` hands back nothing
                   at all there (`remote-images.ts`), so the switch would store a preference and
                   change no picture. `cloudClient` is exactly that build fact, and it is checked
                   rather than `remoteImages !== undefined` only because it names WHY. */
                remoteImagesSection={demo || !consent.known || !consent.cloudClient ? undefined : (
                  <RemoteImagesRow
                    blocked={consent.blockRemoteImages}
                    setBlockRemoteImages={consent.setBlockRemoteImages}
                  />
                )}
                /* AUTO-UNSUBSCRIBE ON SCREEN-OUT. Gated on BOTH `consent.known` and
                   `autoOptIn.supported`, and each gate answers a different question.

                   `known` is the flash argument the two rows above make, pointing the other way:
                   this switch rests ON, so drawing it before the server has answered would show it
                   ON to an account that turned it OFF — and somebody who then left it alone would
                   believe they had chosen the state they were merely shown.

                   `supported` is the structural one, and it is why this is not simply `known`: a
                   STANDALONE install wires no unsubscribe service into its screener at all, so
                   nothing there could be switched off, and a control drawn on that build would
                   store nothing and govern nothing. It used to read `apiConfigured()`, which
                   also excluded the desktop's HOSTED door — where the screening decisions this
                   flag qualifies are forwarded to the account and the hosted pass is what sends
                   the request, so the switch governs exactly what it says it does. That door
                   hands in a wire; the standalone door hands in none and is still excluded.
                   Withheld from the demo like every other injected pane. */
                autoUnsubscribeSection={demo || !consent.known || !autoOptIn.supported ? undefined : (
                  <AutoUnsubscribeRow
                    on={consent.autoUnsubscribe}
                    setBlockAutoUnsubscribe={consent.setBlockAutoUnsubscribe}
                  />
                )}
                /* THE AWAY RESPONDER — its OWN Settings section since it became the one control in
                   the product that makes the app send mail unprompted, and a menu is where people
                   look for that. This node IS that pane: absent ⇒ no pane and no nav entry, which
                   is the whole of how the Cloud-only rule is expressed on screen.

                   Gated on `awaySupported` and NOT on `consent.known`, unlike the two rows above:
                   it holds no consent state and loads its own row, so it has nothing to flash the
                   wrong way round. But the "is there anywhere to store this" gate is required, and
                   for a stronger reason than the auto-suggest row's — the SENDER is a pass in the
                   hosted worker, so a standalone install drawing this control would store a
                   configuration that answers nobody, which is the built-and-unreachable shape this
                   whole surface exists to remove, reintroduced one layer up. See `awaySupported`
                   for the two ways it is true, and {@link awayTransport} for why the desktop's
                   HOSTED door is one of them and its standalone door is not.

                   The `onChanged` echo is how the Ohbox notice above hears a same-tab save
                   without a refetch — the row reports what the SERVER answered, never what a
                   click asked for, into the one `useAwayNotice` state the shell holds. */
                awaySection={demo || !awaySupported ? undefined : (
                  <AwayResponderRow onChanged={awayNotice.update} transport={awayTransport} />
                )}
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
                /* WHERE THE SCREENER'S OFFER LANDS. Read once at THIS view's mount and cleared
                   when the view goes away — see `settingsPane` above — so it decides the pane
                   exactly once and the person is free to click elsewhere afterwards. */
                initialPane={settingsPane ?? undefined}
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
        closeOnEscape={false}
        onClose={() => setReaderFor(null)}
        /* The on-screen back control's accessible name — the stylesheet shows the control at
           phone width, where the esc hint is suppressed for coarse pointers and the backdrop
           does not read as tappable. The component's own default is English. */
        closeLabel={t("reader.back")}
      >
        {readerMessage ? (
          <MessagePane
            message={readerMessage}
            tags={tags}
            now={now}
            onAction={(a) => onMessageAction(a, readerMessage)}
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
        doneLabel={frPhase === "sending" ? t("reply.sending") : t("triage.frDone")}
        skipLabel={t("triage.frSkip")}
      />

      {/* Command palette */}
      <CommandPalette
        open={palette.open}
        onClose={palette.closePalette}
        commands={commands}
        placeholder={t("palette.placeholder")}
        emptyHint={t("palette.empty")}
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
          state={subjectRule!}
          ctx={subjectRuleFor}
          onConfirm={(term, dest, field) => confirmSubjectRule(subjectRule!.messageId, term, dest, field)}
          onClose={() => setSubjectRule(null)}
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
