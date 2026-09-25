"use client";

/**
 * The ohmail client shell: rail + views over ONE engine, the reader
 * exhale, the Reply Run, the ⌘K palette, the tag picker and
 * the demo ribbon. Every list, count and mutation runs through
 * @ohmail/client-engine — the shell only owns view state.
 */
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  DEMO_NOW,
  FOLDER_OF_VIEW,
  addressBook,
  bodyOf,
  physicalFolderOf,
  UNDO_CLASS,
  sendingMailboxId,
  replySubject,
  forwardSubject,
  inverseMutations,
  sendAndDonePlanFor,
  threadOf,
  type ComposeAttachment,
  draftBodyKnown,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type MutationResult,
  pressVerdict,
  type Folder,
  type OhmailView,
  type SearchHit,
  type TagDTO,
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
  type IconName,
  type RailGroup,
  type RailNavProps,
  type ResolvedTheme,
  type ThemePreference,
} from "@ohmail/ui";
import {
  EngineProvider,
  useDemoMode, useResolvedDemoMode,
  useEngine,
  useDerivedVersion,
  useSearchIndexRevision,
  useSyncStatus,
  type OwnerResolver,
  type ProvidedEngine,
} from "./engine";
import { PullNewMail, usePullNewMail } from "./PullNewMail";
import { avatarHue } from "./format";
import { useDayClock } from "./day-clock";
import { activeFormatLocale, activeFormatZone } from "./locale";
import { displayAddress, displayDomain } from "./idn";
import { MessageGone, MessagePane, type BulkAction, type MessageAction } from "./MessagePane";
import { AttachmentPreview } from "../components/AttachmentPreview";
import { useMessageAttachments } from "./attachments";
import { useRemoteImages } from "./remote-images";
import { useConsentState, type ConsentTransport } from "./consent-state";
import { FirstRun, type FirstRunDecideSubject } from "./FirstRun";
import type { FirstRunHost } from "./first-run-host";
import type { OnboardingFacts } from "./onboarding";
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
  useComposeAutosave, reopenWouldOverwrite, type ComposeFate, type ComposeFlush,
} from "./compose-autosave";
import { RemoteImagesRow } from "./RemoteImagesRow";
import { TrackingPixelsRow } from "./TrackingPixelsRow";
import { AutoUnsubscribeRow } from "./AutoUnsubscribeRow";
import { FoldersRow } from "./FoldersRow";
import { SignaturesRow } from "./SignaturesRow";
import { useFolderVerbs } from "./folder-verbs";
import { junkFolderSaid } from "./folders";
import { AwayResponderRow, type AwayTransport } from "./AwayResponderRow";
import { AwayNotice, useAwayNotice } from "./AwayNotice";
import { OhmarchyOffer, useOhmarchyOffer } from "./OhmarchyOffer";
import type { ApplyFaceAllDevices } from "./FaceRow";
import { ProfileImportCard, useProfileImport, type ProfileImportTransport } from "./ProfileImportCard";
import {
  COMPOSE_SEND_KEY, heldRowUnverified, inlineForwardKey, promoteOrphanedReplyLane,
  REPLY_DRAFT_PREFIX, SEND_IN_FLIGHT_PHASES,
  sendPendingInDurableOutbox, sendPendingInOutbox, useMailSend, readReplyDraft, writeReplyDraft,
  readReplyMeta, writeReplyMeta, type LanePromotionPlan, type SendState,
} from "./mail-send";
import {
  accountOrganizer, firstRunCounts, firstRunSubject, screenerForMailbox,
} from "./first-run-subject";
import {
  attachSendLockDraft, holdOf, releaseSendLockForRow, unresolvedSendRows,
} from "./send-lock";
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
import { RichEditor, preloadRichEditor } from "./RichEditorLazy";
import { TagPicker, placePicker } from "./TagPicker";
/**
 * THE SCHEME CONTROL'S THREE STATES, as LOOKUP TABLES rather than comparisons. Light, dark and
 * auto are appearance vocabulary, and a `preference === "system"` here would be a new
 * appearance branch for the one-UI census to disposition; a table keyed on the preference is
 * the same answer with nothing to argue. `dock.themeAuto` is the only one that takes an
 * argument — "Auto (dark)" — and the other two ignore it.
 */
const SCHEME_GLYPH: Record<ThemePreference, IconName> = {
  light: "sun",
  dark: "moon",
  system: "auto",
};
const SCHEME_STATE_KEY: Record<ThemePreference, string> = {
  light: "dock.themeLight",
  dark: "dock.themeDark",
  system: "dock.themeAuto",
};
const SCHEME_WORD_KEY: Record<ResolvedTheme, string> = {
  light: "dock.schemeLight",
  dark: "dock.schemeDark",
};

import { KeymapProvider, useModGlyph } from "./keymap";
/* THE ONE CURSOR PLACER — the mechanism every list view shares; this shell is the `global`
   claimant, answering for the three views whose cursor it holds. See `cursor-placer.ts`. */
import { CURSOR_HINT_MS } from "./cursor-placer";
import type { ActedMarker } from "./after-verb";
import { ZoneCursor } from "./zone-nav";
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
} from "./mail-state";
/* Every press that changes mail leaves through here. See the module. */
import { useShellDispatch } from "./shell-dispatch";
/* The consent partition, the projection over it and every pile. See the module. */
import { useShellDerivations } from "./shell-derivations";
/* Selection, the reader, the route↔open mirror and what a visit has seen. See the module. */
import { useShellCompose } from "./shell-compose";
export { openDraftDecision } from "./shell-compose";
import { useShellOpenState } from "./shell-open-state";
/* Screening, tags and every message and bulk verb. See the module. */
import { useShellVerbs } from "./shell-verbs";
/* The global chords, the palette list and the rail. See the module. */
import { useShellKeys, frKeyOf, TRIAGE_PILE_OF_RAIL } from "./shell-keys";
import { useStableCallback } from "./stable-callback";
/* The once-per-change line above the Ohbox, and the shape of the press that ends it. */
import { OrganizerNotice, type OrganizerNoticeTransport } from "./OrganizerNotice";
/* The OS-answer seam, threaded to `SettingsView` for the hosts that must inject one. */
import type { NotificationHost } from "./notification-settings";
import { ViewBoundary } from "./ViewBoundary";
import { ViewFailCard } from "./ViewFailCard";
import {
  formatRecipientChips,
  optionsFromFacts,
  optionsFromMirror,
  replyEnvelopeOnWire,
  replyEnvelopePlan,
  replyRecipients,
  resolveComposeFrom,
  resolveReplyFrom,
  type ReplyEnvelopeEdit,
} from "./compose-from";
import { MessageChromeProvider, type BodyTarget } from "./message-chrome";
import { SenderMenu, type SenderMenuState } from "./SenderMenu";
import { SenderAuditPanel } from "./SenderAuditPanel";
import { attributeMessages } from "./sender-audit";
import {
  RETRO_DEFAULT_ON,
  dispatchScreeningChange,
  planScreeningChange,
  autoUnsubscribeDoor,
  screeningToast,
  senderScreening,
  splitRoutingPlan,
  worstStatus,
  type ScreeningDest,
  type ScreeningPlan,
  type ScreeningScope,
  type ScreeningToastKey,
} from "./sender-screening";
import { SubjectRuleSheet } from "./SubjectRuleSheet";
import { planSubjectRule, subjectRuleContext, subjectRuleToast, type TermField } from "./subject-rule";
import { senderHitOf } from "./sender-hit";
import { forwardEnvelopePlan, forwardSend } from "./forward-send";
import {
  go, goFolder, goScreener, goSettings, goTag, goTriage, nameFirstRunMailbox,
  useHashRoute,
  type Route,
} from "./routing";
import { beginSearch, markStartup, useUiVitals } from "./ui-vitals";
import { HistoryView } from "../views/HistoryView";
import { SeedReviewView } from "../views/SeedReviewView";
import { OhboxView, type OhboxReplyDone } from "../views/OhboxView";
import { ReadsView } from "../views/ReadsView";
import { ReceiptsView } from "../views/ReceiptsView";
import { ScreenerView } from "../views/ScreenerView";
import { SearchView } from "../views/SearchView";
import { AddressView } from "../views/AddressView";
import { TagView } from "../views/TagView";
import { FolderView } from "../views/FolderView";
import { TrashView } from "../views/TrashView";
import type { TrashWire } from "./trash-window";
import { TriageView } from "../views/TriageView";
import { DraftsView } from "../views/DraftsView";
import { reconcileWakeRegistration, updateNotifyWords } from "./notification-settings.js";
import { usePersistedFlag, UI_KEYS } from "./persisted-ui.js";
import { useSeedOffer } from "./seed-offer";
import { durableSessionSet } from "./durable";

/* THE TWO PANES THE FIRST PAINT NEVER SHOWS, split out of the first-load bundle. Lazy VALUE,
   static TYPES: the type imports above cost no bytes, and these factories are the only place
   the two modules may be named — the import-graph census
   (`test/first-load-defers-panes.test.ts`) refuses a static path back in. Both mount behind
   their existing `effectiveView` seams under one `Suspense` each. */
const ComposeView = lazy(async () => {
  /* THE EDITOR IN PARALLEL, not after it. Both chunks are needed the moment compose opens, and
     asking for them one after the other is a waterfall of two round trips; `preloadRichEditor`
     is the door's own factory, so this request is the one the `Suspense` inside it awaits. */
  preloadRichEditor();
  const mod = await import("../views/ComposeView");
  return { default: mod.ComposeView };
});
const SettingsView = lazy(() =>
  import("../views/SettingsView").then((m) => ({ default: m.SettingsView })));

/*
 * The typing guard used to live here and be threaded into five views as a prop. It is now
 * `isTypingTarget` in `keymap.tsx`, applied once by the one listener — a guard that every
 * caller has to remember to apply is a guard one caller will eventually forget.
 */

/* WHERE A MESSAGE OPENS, and WHAT THE READER SHOWS — the two decisions the open state is built
   on, pure and checkable without a browser. They live beside it in `shell-open-state.ts` now and
   are re-exported here, so the callers that already read them off this module keep one name. */
export { openTargetFor, readerMessageFor, type OpenTarget, type ReaderAnswer } from "./shell-open-state";

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
 * HOW LONG THE CURSOR HINT STANDS — re-exported from the module that owns the placement
 * (`cursor-placer.ts`), so the constant sits with the one line it times and every caller and
 * guard still reads it from here.
 */
export { CURSOR_HINT_MS };

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

/**
 * SEARCH'S OWN SUBSCRIPTION — the mirror it derives from, and the index that answers.
 *
 * It took the GLOBAL version while the index read `message_body`. The index no longer reads
 * bodies (`search.ts` — the archive is the body search), so the global version would re-run the
 * local pass for writes it cannot see: an open writes three body records and the eager pass one
 * per message, each of them a rebuild on the keystroke path. {@link useDerivedVersion} is the
 * honest key, and {@link useSearchIndexRevision} the other half — the index lags the mirror by
 * design, so a build settling changes the answer with no record having moved.
 */
function SearchViewLive(props: Omit<ComponentProps<typeof SearchView>, "version" | "indexRev">) {
  const version = useDerivedVersion();
  const indexRev = useSearchIndexRevision();
  return <SearchView {...props} version={version} indexRev={indexRev} />;
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
  sessionRefused,
  sendSurfaceMaxTotalBytes,
  accountSection,
  mailboxSection,
  aiSection,
  billingSection,
  accountNotice,
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
  imageWire,
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
   * call `GET /mailboxes`. The Cloud client supplies one from `(product)/mailbox/CloudShell` and
   * the desktop supplies its own (`DesktopGate`, over the local roster); the demo supplies
   * nothing, and the sync strip then withholds every mailbox-keyed state rather than guessing
   * one. See `MailStateProvider` — a probe MUST reject on failure,
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
   * The hosted session behind this window was REFUSED and the host's sign-in card is over the
   * shell saying why. The sync strip then says nothing: every pull is refused, and its failure
   * arm would read "Retrying" over a session nothing renews. Absent on every browser tab.
   */
  sessionRefused?: boolean;
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
   * ONE STRIP ABOVE THE APP ABOUT THE ACCOUNT ITSELF — a trial running out, a payment that
   * failed, a catch-up after the account reopened. Injected for the reason the panes above are:
   * the sentences come from `GET /account/access`, which this shared shell may not call, and the
   * desktop window has no hosted account to say any of it about. Absent ⇒ no strip, ever, which
   * is what keeps billing words structurally out of the desktop bundle.
   */
  accountNotice?: ReactNode;
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
    /** Waiting senders with no real suggestion (holds included) — the resting sentence's gate. */
    unanswered: number;
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
   * FETCH ONE REMOTE PICTURE'S BYTES THROUGH THIS SHELL'S DOOR, as a `data:` URI, or `null`
   * when the door refused. Supplied by a shell whose engine is reached over a pipe rather than
   * a port, where no `<img src>` can name the proxy; absent on the hosted client, which names
   * the proxy directly and is left exactly as it shipped.
   */
  imageWire?: (messageId: string, url: string) => Promise<string | null>;
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
            sessionRefused={sessionRefused === true}
            sendSurfaceMaxTotalBytes={sendSurfaceMaxTotalBytes}
            accountSection={accountSection}
            mailboxSection={mailboxSection}
            aiSection={aiSection}
            billingSection={billingSection}
            accountNotice={accountNotice}
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
            imageWire={imageWire}
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
  /* THE DERIVED STAMP, not the global version: the one thing this host computes is a count of
     messages, and a body landing moves neither the count nor anything under it. `children` is a
     stable element, so the provider re-rendering never reaches the shell — what this removes is
     the whole-mirror `list("message")` below, once per body publish. */
  const derived = useDerivedVersion();
  /**
   * EVERY message in the MIRROR — Screener, Reads and Receipts included, not the Ohbox's rows.
   *
   * What this DEVICE holds, and no longer the progress signal: the engine evicts past the window
   * as the pages land, so this pins at the window's floor while an import runs on. Sampled exactly
   * once — here — because two surfaces sampling their own could disagree about whether the mirror
   * is growing. The engine calls `notify()` once per drained page, so this is live with no extra
   * plumbing.
   */
  const mirrored = useMemo(() => engine.read().list("message").length, [engine, derived]);
  /**
   * AND HOW MUCH IT HAS TAKEN IN — the import's producer on this door. Counted at the sync
   * reader's own door, so eviction cannot move it; sampled on the SAME stamp as `mirrored`, so the
   * pair the provider derives from is read at one instant. The derived stamp and not the global
   * one for the same reason as the line above: a body landing moves neither number.
   */
  const received = useMemo(() => engine.receivedMessages(), [engine, derived]);
  return (
    <MailStateProvider probe={probe} freshnessProbe={freshnessProbe} mirrored={mirrored} received={received}>
      {children}
    </MailStateProvider>
  );
}

function ShellInner({ mailboxFacts, organizerNoticeTransport, hostConnection, sessionRefused, sendSurfaceMaxTotalBytes, accountSection, mailboxSection, aiSection, billingSection, accountNotice, invitesSection, securitySection, aboutSection, desktopSection, devicesSection, defaultMailSection, notificationHost, screeningSection, screenerSuggest, awayTransport, awayIsLocal, awayOnHost, profileImportTransport, consentTransport, imageWire, olderBodyWire, junkWire, trashWire, suggestWire, firstRun, mailtoDraft, onMailtoDraftSeeded, onUnread }: {
  /** The pull settle watch's read — the same probe `MailStateHost` above provides the strip. */
  mailboxFacts?: MailboxProbe;
  /** See `AppShell`'s prop of this name — absent withholds the organizer notice. */
  organizerNoticeTransport?: OrganizerNoticeTransport;
  /** See `AppShell`'s prop of this name — present only on a paired desktop with something wrong. */
  hostConnection?: HostConnection;
  /** See `AppShell`'s prop of this name — the strip yields while the host's sign-in card is up. */
  sessionRefused: boolean;
  /** The host's surface declaration for the attach ceiling — see `AppShell`'s prop of this name. */
  sendSurfaceMaxTotalBytes?: number | null;
  accountSection?: ReactNode;
  mailboxSection?: ReactNode;
  aiSection?: ReactNode;
  billingSection?: ReactNode;
  /** See `AppShell`'s prop of this name — absent withholds the account strip entirely. */
  accountNotice?: ReactNode;
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
    /** Waiting senders with no real suggestion (holds included) — the resting sentence's gate. */
    unanswered: number;
    absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
  }) => ReactNode;
  awayTransport?: AwayTransport;
  awayIsLocal?: boolean;
  awayOnHost?: string | null;
  profileImportTransport?: ProfileImportTransport;
  consentTransport?: ConsentTransport;
  /**
   * FETCH ONE REMOTE PICTURE'S BYTES THROUGH THIS SHELL'S DOOR, as a `data:` URI, or `null`
   * when the door refused. Supplied by a shell whose engine is reached over a pipe rather than
   * a port, where no `<img src>` can name the proxy; absent on the hosted client, which names
   * the proxy directly and is left exactly as it shipped.
   */
  imageWire?: (messageId: string, url: string) => Promise<string | null>;
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
  /**
   * THE KEY EVERY WHOLE-MIRROR PASS BELOW TAKES — the mirror's version minus the types no
   * derivation reads ({@link NOT_DERIVED_FROM}, which is the bodies).
   *
   * Counted before the split: one body publish — a single `message_body` record, no message,
   * rule, tag, draft or mailbox moved — cost TWENTY whole-mirror passes, against twenty-three
   * for a `/sync` page of two hundred messages. An open writes three and the eager pass one per
   * message, so most of what the window derived during an import was derived for nothing. The
   * surfaces that draw a body subscribe to it themselves (`body-slice.ts`).
   */
  const derived = useDerivedVersion();
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
    mailboxes: facts, rosterProbed, state: mailState, refresh: refreshFacts, pulled,
  } = useMailState();
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
   * THE DISPATCH SPINE — every press that changes mail leaves through `shell-dispatch.ts`: the
   * two undo windows, the routing window, the organizer's refusal vocabulary, the report doors
   * and the one armed Undo. Declared here, above `presented`, because the delete window's held
   * ids are what that projection subtracts.
   */
  const {
    fileAndRefresh, rosterRef, deleting, restoring, refusalCopy, routing,
    toastWithUndo, mutateAndReport, mutateSetAndReport, mailboxesOf, runArmedUndo,
  } = useShellDispatch({ engine, reader, toast, t, demo, refreshFacts });

  const theme = useTheme();
  /* THE SHELL TIMES ITSELF — startup marks, the three interaction percentiles and the frame
     sampler, reported every five minutes. Always on, no flag: an instrument that has to be turned
     on is one that was off during the incident. `ui-vitals.ts` carries the reasoning. */
  useUiVitals();
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
  /* The clock this shell RENDERS against — see `day-clock.ts` for why it is not a mount value. */
  const now = useDayClock(demo ? DEMO_NOW : null);
  /**
   * …and what a PRESS reads. The rendered clock is at most one watch interval old, which is a
   * minute in which a booking can be made for the wrong day; a press asks the clock itself.
   */
  const nowAt = useStableCallback((): Date => (demo ? DEMO_NOW : new Date()));

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
    // `derived` is the subscription; the reader object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, derived]);
  /* `resolvedDemo`, NOT `demo` — the third gate in this file to take the correction, and the
     same one-render-wide difference the wake registration and the away notice record above:
     a prerendered `?demo=1` page hydrates with `serverDemo === false`, so this issued
     `GET /consent` from a fixtures world, and an effect cleanup cannot recall a request. */
  const consent = useConsentState(!resolvedDemo, consentTransport, settingsStamp);
  /**
   * The sync loop's posture, for the folders group's third render: `bootstrapping` is "no drain
   * has yet completed for this engine", which is exactly the window in which ZERO folder
   * entities means "cannot judge yet" rather than "the account has none".
   */
  const syncStatus = useSyncStatus();
  /**
   * "COLD START TO A USABLE LIST" — the budget's own measure, marked once. MAIL ON SCREEN, not a
   * completed drain: keyed on `bootstrapping` this measured the first full sync cycle instead, and
   * on a settled 74k mailbox it read 30 324 ms where the rows were up at 5 619 ms — on the 0.19.0
   * runs whose first import was still running, 78 212 and 65 413 ms, a figure about the server's
   * pace reported as the wait a reader sits through. `pulled` is the mirror's own row count, so
   * the first render holding mail marks. An EMPTY mailbox still owes a drain before "nothing here"
   * is a fact, and `settled` is that case, which keeps a new account markable. `markStartup` takes
   * the first answer, so a re-mount cannot overwrite a cold figure.
   */
  useEffect(() => {
    if (pulled > 0 || mailState.settled) markStartup("listUsable");
  }, [pulled, mailState.settled]);
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
  /**
   * REMEMBER THE RESURFACE TIME (mail 0110) — the account write the horizon chooser makes after
   * it has dispatched, folded to one nullable callback. Null on the demo (no session) and on a
   * transport that cannot store one (the STANDALONE window, which passes none), and in both
   * cases the chooser keeps working on the product's 09:00 with nothing to persist. NOT gated on
   * a `known` flag, unlike the face above: nothing here writes over an unknown stance, because
   * this write only ever happens when a person has just picked an hour and pressed a horizon.
   */
  const rememberResurfaceTime = !demo ? consent.setResurfaceTime : null;
  /* The Option B offer's gates (Linux default active, nothing chosen, dismissal) live in the
     hook — see OhmarchyOffer.tsx. */
  const faceOffer = useOhmarchyOffer(applyFaceAllDevices);
  /* The seed review, offered once the server says it is owed; it takes the stage because it decides
     what the Ohbox contains. When it is owed, what "Not now" keeps and what nobody-to-decide does are
     `seed-offer.ts`'s. Settings reopens it; `confirmSeed` writes only who is new. */
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
  const seedOffer = useSeedOffer({
    demo, known: consent.known, supported: seedSupported, seedConfirmedAt: consent.seedConfirmedAt,
  });
  const seedOwed = seedOffer.owed;
  /**
   * THE WHOLE-MIRROR DERIVATIONS — the consent partition, the presentation projection and every
   * pile, count and lookup over them, in `shell-derivations.ts`. Below the dispatch spine whose
   * held ids the projection subtracts, above everything that reads a pile: the hooks keep the
   * order the regions they replace had.
   */
  const {
    ownAddresses, ownNameOf, mailboxLabelOf, consentView, presented, trashPage, trashWindow,
    older, folderOlder, ohbox, resurfacedRows, partition, receipts, receiptsPartition, piles,
    parked, tagGroups, history, tags, folders, folderMailboxes,
    folderUnread, openFolder, folderMessages, rules, mailboxes, draft, aiChip, account,
    notifications, allOhbox, ohboxCount, participantsOf, threadCountOf, threadSubjectOf, fallbackMailboxId,
    drafts, scheduled,
  } = useShellDerivations({
    engine, reader, derived, demo, resolvedDemo, now, facts, seedOwed, consent, route, trashWire,
    deleting, restoring, routing,
  });

  /**
   * THE FOLDER VERBS (stage 2) — engine dispatch + the delete confirm's summary read, from the
   * sibling hook (`folder-verbs.ts` carries the api-client boundary argument). Built
   * unconditionally (hooks may not be conditional); HANDED to the rail group only on a live,
   * folders-on account — the demo keeps the read-only group, and a flag-off rail renders no
   * group at all.
   */
  const folderVerbs = useFolderVerbs(engine, toast);

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
  const autoUnsub = autoUnsubscribeDoor({
    demo, known: consent.known, on: consent.autoUnsubscribe, standalone: consent.standalone,
  });
  const autoUnsubscribeDiscloses = autoUnsub.discloses;
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
    engine, derived, toast, suggestions.suggestions, presented, autoUnsubscribeDiscloses,
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
  /* The first-run flow's facts, from the polled `GET /mailboxes` row, `GET /consent`, the door's
   * AI posture and the Screener queue — `deriveOnboardingStep` is pure over them. WHICH mailbox
   * the run is about, and which of the four nothings it is when there is none, are
   * `first-run-subject.ts`'s: the answer this mount could not make before is `vanished`, and it
   * used to fall through to the connect form, whose mode is `seed`.
   */
  const firstRunSubjectNow = firstRunSubject(facts, route.firstRunMailboxId, route.firstRunAdd);
  const firstRunMailbox = firstRunSubjectNow.mailbox;
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
  /* THE RUN'S OWN SCREENER QUEUE. The guided decision took `screener.waiting[0]` whatever mailbox
   * that sender wrote to; `screenerForMailbox` carries the rule and its single-mailbox exemption. */
  const firstRunQueue = useMemo(() => screenerForMailbox(
    /* DECIDABLE ROWS ONLY, so the count below and the card cannot select different sets: the step
       is chosen by `queuedSenders > 0` and filled by `firstRunDecide`, which skips a pinned row. */
    screener.waiting.filter((row) => !("pinned" in row)),
    (id) => reader.get<EngineMessage>("message", id)?.mailboxId,
    firstRunMailbox?.id ?? null,
    (facts?.length ?? 0) > 1,
  ), [screener.waiting, reader, derived, firstRunMailbox, facts]);
  /* THE PULL SCREEN'S TWO COUNTERS, AND THE SUMMARY'S TWO ROWS. They were `mirroredCount -
   * history.length` and `history.length` — the install's — on a screen naming one mailbox.
   * ONLY WHILE THE STAGE IS OPEN: `reader.list("message")` materialises the whole mirror, which is
   * the cost the windowing work exists to keep off the render path.
   */
  const firstRunPull = useMemo(
    () => (route.firstRun && firstRunMailbox !== null
      ? firstRunCounts(reader.list<EngineMessage>("message"), history, firstRunMailbox.id)
      : { screened: 0, history: 0 }),
    [route.firstRun, reader, derived, history, firstRunMailbox],
  );
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
      /* THE COUNT AND THE CARD COME FROM ONE LIST, or an empty guided-decision card reaches the
         screen. Untouched on a single-mailbox install, where the Screener's own count is sharper
         (it subtracts rows mid-exit). */
      queuedSenders: (facts.length ?? 0) > 1 ? firstRunQueue.length : screener.waitingCount,
    };
  }, [firstRun, facts, firstRunMailbox, firstRunQueue, consent.onboardingCompletedAt,
    screener.waitingCount]);
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
    const row = firstRunQueue[0];
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
  }, [firstRunQueue, screener, t]);

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
   * WHAT TO SAY ABOUT THE PROVIDER'S JUNK FOLDER, and whether to offer the way in — the honest
   * half of JUNK-INVISIBLE, read by the rail's folders group and by search's empty state. The
   * subject is the account's own mailbox facts, because `\Junk` is excluded from the folder
   * inventory whole and no `folder` entity can ever carry it. The pointer rides the SAME gate
   * that decides whether the Screener's Junk segment exists, so neither surface can send
   * somebody to a segment this build withholds.
   */
  const junkSaid = useMemo(() => junkFolderSaid(facts ?? []), [facts]);
  const junkReadable = !demo && consent.foldersEnabled && junkWindow.supported;
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

  /* The modifier's cap on this keyboard — the three hand-written caps below read it. */
  const modCap = useModGlyph();
  /* The inline reply. The id and the text live HERE, not in `MessagePane`, because
     that pane is mounted twice whenever the reader is open — see `message-chrome.tsx`. */
  const [replyTo, setReplyTo] = useState<string | null>(null);
  /**
   * THE OPEN STATE — what is selected, what the reader shows, what the bar claims and what this
   * visit has spent, in `shell-open-state.ts`. Below `replyTo`, whose editor the route transition
   * closes with every other overlay, and above everything that reads a selection — `shell-compose.ts`
   * included, which is why it is called after this one.
   */
  const {
    absoluteTime, barPanel, chipState, closeCard, commitReadsSeen, commitReceiptsSeen, enterReader,
    focused, fr, frDone, frValues, jump, markAllRead, markSeen, mirrorHolds, verbHolds, ohboxGone, openMessage,
    picker, pickerIds, previewFor, railOpen, readerFor, readerGone, readerMessage, readsCur,
    readsMarkSeen, receiptsCur, receiptsMarkSeen, ribbonGone, scnSel, screenerFull, searchFrom,
    searchQuery, selectedOhbox, senderAudit, senderMenu, setBarPanel, setChipState, setCloseCard,
    setFr, setFrDone, setFrPending, setFrValues, setJump, setOhboxArmedRead, setOhboxSel, setPicker,
    setPickerIds, setPreviewFor, setRailOpen, setReaderFor, setReaderOffMirror, setReadsCur,
    setReceiptsCur, setRibbonGone, setScnSel, setScreenerFull, setSearchQuery, setSenderAudit,
    setSenderMenu, setShortcutsOpen, setSubjectRule, sheetMessage, shortcutsOpen, startFR,
    subjectRule, toggleAbsoluteTime,
  } = useShellOpenState({
    engine, reader, derived, route, t, toast, mutateAndReport, mailState, screener,
    allOhbox, consentView, folders, parked, partition, piles, presented, receipts, setReplyTo,
  });

  /**
   * WHERE A GONE MESSAGE CAN STILL BE READ — the LIVE Trash window over the provider's own
   * folder. `null` wherever that window reads nothing (`useTrashWindow`'s own gate: the demo,
   * "Use folders" off, a seed still owed), because a link into an empty room is worse than no
   * link. ohmail's own Trash list is not an option at any setting: it inner-joins the folder only
   * ohmail's delete verb writes, and this row was never deleted by ohmail.
   */
  const openTrashWindow = !demo && consent.foldersEnabled && !seedOwed
    ? () => go("trash")
    : null;

  const waitingLive = screener.waiting.filter((w) => !screener.isExiting(w.id));

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
  const bodyOfMessage = useStableCallback((m: BodyTarget) => {
    const live = engine.read().get<EngineMessage>("message", m.id);
    if (live !== undefined) return bodyOf(engine.read(), live);
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
    /* THE DESKTOP'S ONE SENTENCE ABOUT A DOWNLOAD. A browser announces its own downloads and this
       app cannot see that folder, so the seam speaks only for files the SHELL said it wrote — the
       count is its answer, never the number of files that were asked for. The key sits beside its
       twin `toastDownloadAllFailed` rather than in the `attachments` namespace: that namespace is
       held key-for-key against the STRIP's own `COPY` table (`locale-shim-parity.test.ts`), and a
       sentence only this file speaks would be a dead entry in it. */
    onSavedToDownloads: (count) => toast(t("ohbox.toastSavedToDownloads", { count })),
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
    /* THE PIPE-DOOR'S FETCHER. Supplied only by a shell whose engine has no origin a `src` can
       name (the desktop); absent here means the hosted mechanism, unchanged. It is what turns
       `apiConfigured()` from the question "can this client show a picture" into one of two
       ways of answering it. */
    fetchImage: imageWire,
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

  /**
   * REPLY, COMPOSE, DRAFTS AND SENDS — everything that puts words on the wire, in
   * `shell-compose.ts`. Below the open state, which is where its own first region already sat and
   * which it reads (`setReaderFor` for the narrow open); `replyTo` stays above both, because the
   * route transition closes the editor.
   */
  const {
    cancelCompose, cancelSchedule, closeCompose, closeReply, compose, composeCloseRefusal,
    confirmForward, forwardAsk, composeFrom, discardDraft, draftRepliesHere, draftReply, draftReplyChrome, editScheduled,
    heldReplyRow, discardRefusal, sendAgain, mailSend, onComposeFields, onReplyBody, onReplySig,
    onReplySubject, openDraft, openForward, openMessageRef, openReply, plan, replyAll,
    replyAttachments, replyBody, replyBook, replyDone, replyEnvelope, replyFromId, replyMode,
    pressSendAndDone, replySendState, replySig, replySubjectEdit, resolveHeldSend, sendCompose, sendReply,
    setReplyAttachments, setReplyEnvelope, setReplyFromId, toggleReply, writeTo,
  } = useShellCompose({
    engine, reader, t, toast, route, consent, facts, mailboxes, drafts, ownAddresses,
    fallbackMailboxId, replyTo, setReplyTo, setReaderFor, fr, setFr, setFrDone, setFrValues,
    setOhboxSel, mailtoDraft, onMailtoDraftSeeded, presented, mutateAndReport, toastWithUndo,
  });

  /**
   * SCREENING, TAGS AND THE MESSAGE AND BULK VERBS — every press that writes a mailbox, in
   * `shell-verbs.ts`. Below the composer, whose Reply, Forward and drafter the message verbs
   * dispatch; no effect moves with them, so this call site is decided by what they read and by
   * nothing else. `openTagPicker` travels with them.
   */
  const {
    bulkToggleTag, bulkVerbs, canDeleteMessage, canReplyAllTo, changeScreening, confirmSubjectRule,
    createTag, createTagAlone, dropTag, lastActed, onMessageAction, onStageClickCapture,
    onStreamAction, openSenderAudit, openSenderMenu, openSubjectRule, openTagPicker, retargetRule,
    revokeRule, tagAdmin, toggleTag,
  } = useShellVerbs({
    engine, reader, t, toast, consent, demo, nowAt, tags, ownAddresses,
    fileAndRefresh, toastWithUndo, mutateAndReport, mutateSetAndReport, mailboxesOf, refusalCopy,
    rosterRef, routing, deleting, restoring,
    markSeen, readerFor, setReaderFor, setPicker, setPickerIds, setSenderMenu, setSenderAudit,
    setSubjectRule,
    toggleReply, openForward, openReply, draftReply, replyAll, replyTo,
  });

  /* Assigned here so `openDraft`, which is declared several hundred lines above this, can open a
     reply draft in its own conversation. See {@link openMessageRef}. */
  openMessageRef.current = openMessage;

  /**
   * THE GLOBAL KEYS, THE PALETTE AND THE RAIL — the top of the graph, in `shell-keys.tsx`.
   * LAST, because everything in it reads what the five hooks above returned and nothing above
   * reads anything it declares. Its nine effects and its four `useKeyBindings` registrations
   * keep the order, the phase and the scope they have here.
   */
  const {
    activeRailId, commands, effectiveView, mobileTitle, narrowNow, pushTier, railGroupsWithHints,
    tagGroup,
  } = useShellKeys({
    engine, reader, demo, t, theme, route, palette, pullBinding, consent, syncStatus, mailState,
    facts, seedOwed, folderVerbs, screener, junkSaid, junkReadable, awaySupported, readsNew,
    receiptsNew,
    accountSection, mailboxSection, aiSection, billingSection, invitesSection, securitySection,
    aboutSection, desktopSection, devicesSection, onUnread,
    runArmedUndo,
    allOhbox, ohboxCount, presented, pressSendAndDone,
    drafts, folderMailboxes, folderMessages, folderOlder, folders, folderUnread, history,
    ohbox, openFolder, ownAddresses, partition, piles, receipts, scheduled, tagGroups, tags,
    trashPage,
    barPanel, focused, fr, frValues, mirrorHolds, picker, railOpen, readerFor, readerMessage,
    selectedOhbox, senderAudit, senderMenu, setBarPanel, setFr, setFrPending, setPicker, setRailOpen,
    setReaderFor, setScreenerFull, setSenderAudit, setSenderMenu, setShortcutsOpen, setSubjectRule,
    shortcutsOpen, startFR, subjectRule,
    mailSend, openForward, sendReply, toggleReply,
    createTagAlone, onMessageAction, onStreamAction, openSenderMenu, toggleTag,
    replyTo, setReplyTo,
  });

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
   * the optimistic overlay. A `useMemo` keyed on `derived` would give the same freshness and
   * a new identity every bump; a `useMemo` that forgot it would go stale, which is
   * exactly the bug `senderMenuFor` carries a `derived` dep to avoid.
   */
  const conversationOf = useStableCallback((messageId: string) => threadOf(engine.read(), messageId));

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
      // Delete's gate: the verb reader, so a History or Search row is deleted like any other.
      verbHolds,
      absoluteTime,
      onToggleAbsoluteTime: toggleAbsoluteTime,
      replyTo, replyAll, replyMode, replyBody, onReplyBody, closeReply, sendReply, forwardAsk, confirmForward,
      /* SEND + DONE — offered per message by the ENGINE's one rule, asked at every render so a
         source that is filed or finished in another window stops offering it. The press reads
         the mirror again: what is offered and what happens are the same question, asked twice
         because a render and a press are different moments.

         `presented` and NOT `reader`: the Ohbox this rule asks about is the one on screen
         (`ohboxView(presented)` above), where a message a rule presents under Reads or Receipts
         is not an Ohbox row at all — the raw mirror still has it in INBOX and would offer the
         action over a row the Ohbox does not show. */
      sendReplyAndDone: (messageId: string) =>
        (sendAndDonePlanFor(presented, messageId) === null ? null : () => pressSendAndDone(messageId)),
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
      /* The reading pane's delivery line — the same resolver the Reads surfaces take as a prop. */
      mailboxLabelOf,
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
      /* THE RESURFACE TIME AND ITS WRITER (mail 0110). The value is the account's, so the strip
         shows the same hour in the reading column and the reader sheet; the writer is the
         consent hook's own, NULL wherever no transport can store one, and it is handed over as
         fire-and-forget because the strip calls it after the resurface has already been
         dispatched — the message was the ask. A refusal is logged and the horizon stands. */
      /* The strip mints its horizons from THIS, at the press — see `MessageChrome.nowAt`. */
      nowAt,
      resurfaceTime: consent.resurfaceTime,
      onResurfaceTime: rememberResurfaceTime === null
        ? undefined
        : (hhmm: string) => {
          void rememberResurfaceTime(hhmm).catch((err: unknown) => {
            console.warn("[consent] the resurface time was not stored", err);
          });
        },
    }),
    [ownAddresses, absoluteTime, toggleAbsoluteTime, replyTo, replyAll, replyMode, replyBody, onReplyBody, closeReply, sendReply, mailSend, draftReplyChrome,
      forwardAsk, confirmForward, replyEnvelope, replyFromId, replyAttachments, replySig, replySubjectEdit,
      onReplySig, onReplySubject,
      consent.signatures, consent.signaturesHtml, consent.signaturesKnown,
      sendSurfaceMaxTotalBytes, replyBook,
      openSenderMenu, ownNameOf, mailboxLabelOf, writeTo, openReply, openForward, openSubjectRule,
      conversationOf, bodyOfMessage, hydrateBody, hydrateThread, attachments, remoteImages,
      consent.foldersEnabled, consent.resurfaceTime, rememberResurfaceTime, reader, barPanel, nowAt],
  );

  // Resolved here so a sender whose last message has just moved closes the popover instead of
  // rendering an empty one; the lists' partition rides in, so "Now in" names where rows are shown.
  const senderMenuFor = useMemo(
    () => (senderMenu ? senderScreening(engine.verbRead(), senderMenu.messageId, senderMenu.address, consentView?.placeOf) : null),
    [senderMenu, reader, derived, consentView],
  );

  // Same shape and the same `derived` dep as above, for the same reason: a message whose row has
  // just been moved out from under the sheet closes it rather than rendering an empty one, and a
  // memo that forgot it would show a stale token count after a sync drain.
  const subjectRuleFor = useMemo(
    () => (subjectRule ? subjectRuleContext(reader, subjectRule.messageId) : null),
    [subjectRule, reader, derived],
  );

  /**
   * The two app-level controls, at the foot of the rail. They were a fixed capsule floating bottom-centre over every
   * view, costing a clearance band at the bottom of every scrolling surface (132px, in four stylesheets) and two
   * controls permanently on top of somebody's mail. Neither acts on mail — one opens the palette, one switches the
   * theme — so they belong with the app's own chrome, the rail. Written in the RAIL'S vocabulary, not a component of
   * their own: `.ritem` rows with the keycap in `.cnt`, exactly as the Search row carries "/". One line, not two:
   * Command keeps the full-width row and its keycap; the theme control is an icon at the right end of that line — two
   * stacked rows spent a second line on a control worth a single glyph.
   */

  /* What the live region says after a press — empty at mount, so boot announces nothing. */
  const [schemeSaid, setSchemeSaid] = useState("");
  /**
   * The scheme control is the one thing here without visible text, so it carries its name twice:
   * `aria-label` for assistive tech and the palette-less keyboard path, `title` for the pointer
   * user identifying a lone glyph. The name states the STATE and the PRESS — "Theme: Auto (dark).
   * Press for Light" — because one glyph cycling three states is otherwise a button whose only
   * description is its current picture; the `role="status"` span below says the new state after a
   * press and nothing at mount. The palette carries all three states by name, so no scheme is
   * reachable only by icon, and Settings → General keeps the explicit picker. On a phone these
   * ride the navigation drawer, the same rail; see `touch-keys.css` for the keycap.
   */
  const schemeLabel = (preference: ThemePreference, resolved: ResolvedTheme): string =>
    t(SCHEME_STATE_KEY[preference], { resolved: t(SCHEME_WORD_KEY[resolved]) });
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
        onClick={() => {
          theme.cycle();
          setSchemeSaid(t("dock.themeNow", { state: schemeLabel(theme.next, theme.nextResolved) }));
        }}
        aria-label={t("dock.theme", {
          state: schemeLabel(theme.preference, theme.resolved),
          next: schemeLabel(theme.next, theme.nextResolved),
        })}
        title={t("dock.theme", {
          state: schemeLabel(theme.preference, theme.resolved),
          next: schemeLabel(theme.next, theme.nextResolved),
        })}
      >
        <Icon key={theme.preference} name={SCHEME_GLYPH[theme.preference]} className="scheme-glyph" />
      </button>
      {/* Empty at mount, so nothing is announced at boot; `sync-say` is the shell's own
          visually-hidden live region class. */}
      <span className="sync-say" role="status" aria-live="polite">
        {schemeSaid}
      </span>
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
        {sessionRefused ? null : <SyncBar hostOffline={hostConnection != null} />}

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

        {/* WHAT THE SERVICE SAYS ABOUT THIS ACCOUNT — the same slot and the same argument as the
            two strips above, and the same absence rule: nothing at all where the host supplied
            nothing, which is every desktop window and the demo. It is a NODE and not a state
            because the facts come from a door this shell may not knock on. */}
        {accountNotice}

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
                {sessionRefused ? null : <SyncBar variant="rail" hostOffline={hostConnection != null} />}
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
                  seedOffer.done();
                  if (typeof window !== "undefined") window.location.reload();
                }}
                /* Nothing was written, so nothing needs re-reading. Offered, "Not now" is kept
                   on this device; opened from Settings, leaving keeps nothing. */
                onLater={seedOffer.reopened ? seedOffer.done : seedOffer.later}
                /* Offered only: nobody to decide about hands the stage back. Opened from
                   Settings, the review says so itself. */
                onNothingToDecide={seedOffer.reopened ? undefined : seedOffer.nothingToDecide}
              />
            ) : null}

            {/* THE VIEW, INSIDE A BOUNDARY. A render throw in any pile degrades to an in-pane
                failure card with the rail and the sync strip still standing, rather than Next's
                whole-tab "Application error". Keyed on `effectiveView` so navigating to another
                pile — still reachable, because the rail survived — clears a failed view. */}
            <ViewBoundary
              key={effectiveView}
              onError={(error) => console.error("[view] render failed", effectiveView, error)}
              /* The card carries the build and the view, and can copy them with the error's
                 class — the facts a report needs, and nothing a message could leak. */
              fallback={(error) => <ViewFailCard view={effectiveView} error={error} />}
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
                resurfacedRows={resurfacedRows}
                newForYou={ohbox.newForYou}
                previouslySeen={ohbox.previouslySeen}
                threadParticipants={participantsOf}
                threadCountOf={threadCountOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                threadSubject={threadSubjectOf}
                tags={tags}
                now={now}
                selectedId={selectedOhbox?.id ?? null}
                lastActed={lastActed}
                /* The column's third answer — see `ohboxGone`. One prop, because "the message
                   this column was showing has been taken away" is one fact. */
                gone={ohboxGone ? { openTrash: openTrashWindow } : null}
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
                   `mail-state.ts`; see `MailState.settled` and `MailState.owed` — the pair the
                   shared `listSurface` reading asks, never one of them alone. */
                settled={mailState.settled}
                owed={mailState.owed}
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
                /* The pair every list states its counts and its emptiness from — see
                   `MailState.settled` and `MailState.owed`. */
                settled={mailState.settled}
                owed={mailState.owed}
                threadParticipants={participantsOf}
                /* Which address of yours a row arrived at, above one mailbox — see
                   `mailbox-label.ts`; the view resolves one string per row. */
                mailboxLabelOf={mailboxLabelOf}
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
                /* The pair every list states its counts and its emptiness from — see
                   `MailState.settled` and `MailState.owed`. */
                settled={mailState.settled}
                owed={mailState.owed}
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
                /* Which address of yours a stranger wrote to, above one mailbox — the resolver
                   Reads is handed; the view draws the badge and the sheet's sentence from it. */
                mailboxLabelOf={mailboxLabelOf}
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
                        /* The chips' "none" group, from the same state — the resting sentence may
                           only claim "all suggested" when this is zero. */
                        screener.waitingCount - screener.suggestedCount,
                        /* The queue's first derivation is deferred past first paint, and its
                           late delivery is the activation set, not a sender gain — the flag is
                           how `forSenders` tells the two apart. */
                        screener.queueSettled,
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
                        unanswered: screener.waitingCount - screener.suggestedCount,
                        absorb: suggestions.absorb,
                      })
                }
                /* WHY THE ROWS WITH NO ADVICE HAVE NONE. One fact, read once, rendered on every
                   such row — the refusal used to reach the person as a single toast under the
                   batch that discovered it while every waiting row went on saying "yet". */
                noSuggestionStanding={suggestions.standing}
                /* The opt-in fact behind the rows' "a suggestion is coming" — the same read the
                   hook spends under, so the sentence and the spend cannot disagree. */
                autoSuggest={consent.autoSuggest}
                segment={route.screenerSegment}
                selection={scnSel}
                onSelect={(segment, id) => setScnSel((s) => ({ ...s, [segment]: id }))}
                /* Same pair, same reason — the Screener's "No one's waiting." and its
                   "all clear" meta are the same claim the Ohbox was making. ANDed with the
                   queue's own settle: the first derivation is deferred past first paint, and
                   until it runs the queue is withheld, not empty. */
                settled={mailState.settled && screener.queueSettled}
                owed={mailState.owed}
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
                threadCountOf={threadCountOf}
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
                threadCountOf={threadCountOf}
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
                threadCountOf={threadCountOf}
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
                /* The store's timeline, through the engine; the mirror paints first. */
                engine={engine}
                version={derived}
                settled={mailState.settled}
                owed={mailState.owed}
                threadParticipants={participantsOf}
                threadCountOf={threadCountOf}
                absoluteTime={absoluteTime}
                onToggleTime={toggleAbsoluteTime}
                tags={tags}
                now={now}
                /* IN PLACE, and the row TRAVELS with the open: a store page's row is not a mirror
                   row, and a reader resolving mirror ids alone would stay closed on it (the
                   folder view's reach-past rule; the mirror's own row still wins). */
                onOpen={(m) => { setReaderOffMirror(m); setReaderFor(m.id); }}
                hydrateBody={hydrateBody}
                onAction={onMessageAction}
                onAddTag={openTagPicker}
                onScreen={openSenderMenu}
                canDelete={canDeleteMessage}
                canReplyAll={canReplyAllTo}
                held={deleting.held}
              />
            ) : null}

            {effectiveView === "search" ? (
              <SearchViewLive
                engine={engine}
                now={now}
                query={searchQuery}
                /* The search mark starts at the question and ends when SearchView paints its
                   first results for it — the budget's "first results < 500 ms". */
                onQuery={(q: string) => {
                  beginSearch();
                  setSearchQuery(q);
                }}
                onOpen={(hit: SearchHit) => openMessage(hit.message)}
                /* The chip on a hit answers "where do I go to find this again?", and for a
                   History message the folder and the place are different answers. The INDEX is
                   deliberately not projected — mail in History must stay searchable. */
                placeOf={consentView?.placeOf}
                /* The pass that does not exist — the provider's Junk folder is never mirrored,
                   so "Nothing here" is a claim about a corpus that excludes it. */
                junkSaid={junkSaid}
                junkReadable={junkReadable}
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
                version={derived}
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
              /* Lazy pane: the chunk loads on first open; nothing is painted for the tick it
                 takes, which is the same absence the branch renders for any other view. */
              <Suspense fallback={null}>
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
                /* LEAVING SAVES FIRST — see `closeCompose`. Escape and the close control take
                   this; every other exit takes the autosave hook's own belt. */
                onClose={closeCompose}
                closeNote={composeCloseRefusal}
                /* THE HELD COMPOSE'S WAY OUT — the row this form is holding, and the same
                   callback the Drafts list's verbs dispatch. A held message with no row of its
                   own has nothing the server could resolve. */
                heldResolve={((): { draftId: string; onResolve: typeof resolveHeldSend } | null => {
                  const row = readComposeRow();
                  return row === null ? null : { draftId: row, onResolve: resolveHeldSend };
                })()}
              />
              </Suspense>
            ) : null}

            {effectiveView === "drafts" ? (
              <DraftsView
                drafts={drafts}
                scheduled={scheduled}
                now={now}
                onOpen={openDraft}
                onDiscard={discardDraft}
                onResolve={resolveHeldSend}
                onSendAgain={sendAgain}
                /* Which row a refused Discard was about, and why — the list renders the sentence
                   in that row and focuses it. See `discardRefusal` above `discardDraft`. */
                refusal={discardRefusal}
                /* ROWS THIS BROWSER HOLDS BY A DURABLE RECORD, whatever the mirror says. The list
                   offered the resolve verbs on the row's own STATUS alone, so a row held by a
                   record the server never heard about — a send whose answer was lost, the case
                   `discardDraft`'s own predicate refuses — had the refusal and NO way out on
                   screen. `unresolvedSendRows` is `holdOf`'s own reading, called rather than
                   restated, and it is O(records) rather than O(drafts). Read here so it costs a
                   jar read only while this view is the route. */
                heldHere={unresolvedSendRows(COMPOSE_SEND_KEY)}
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
                threadCountOf={threadCountOf}
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
              /* Lazy pane — the compose branch above states the shape. */
              <Suspense fallback={null}>
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
                        <Button onClick={seedOffer.reopen}>
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
                /**
                 * "Use folders" — the folders feature's master toggle (FOLDERS-SPEC.md §6). Built here, not injected,
                 * for `dormancySection`'s reason: it must write through the SAME `useConsentState` the rail group and
                 * the folder views are gated on, or a flipped switch would leave this tab's rail where it was. Gated
                 * on `consent.known` for the flash argument (a switch drawn before the server answered shows OFF to
                 * an account that turned it ON); absent on the demo, present on the desktop's hosted door.
                 */

                /**
                 * Gated on `foldersStorable` as well — this used to claim "absent on a standalone install (no consent
                 * row anywhere)", which stopped being true when the screening window reached that door:
                 * `consentRoutes` are on `localRoutes` now, so `known` goes true, but not one folder verb is served —
                 * `withoutFoldersFlag` forces the flag off on the read and drops it on the write, and the pane drew a
                 * master switch that flipped, stored nothing and snapped back.
                 */

                /* The capability is the transport's declaration AND the server's own consent
                   read: a door that drops the flag (`withoutFoldersFlag` — the standalone
                   engine, a self-hosted server behind the browser or the desktop's hosted
                   wire) answers without `foldersEnabledAt`, so no switch is drawn there. See
                   {@link ConsentState.foldersStorable}. */
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
                      signatureSources={consent.signatureSources}
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
                /* GATED ON THE CAPABILITY, not on `cloudClient`. The old test asked "is this a
                   Cloud build", which answered the right question only for as long as the hosted
                   door was the only one that could fetch a picture. A desktop whose local door
                   now serves the proxy would have been refused its own switch by a build fact. */
                remoteImagesSection={demo || !consent.known || !remoteImages ? undefined : (
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
                autoUnsubscribeSection={!autoUnsub.control ? undefined : (
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
              </Suspense>
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
        /* OPEN FOR THE "GONE" ANSWER TOO — the sheet closing on a tombstone is precisely the
           silence this fixes: the message left and the surface said nothing. */
        open={readerMessage != null || readerGone}
        ariaLabel={t("reader.pane")}
        returnHint={t("reader.hintReturn")}
        closeOnEscape={false}
        /* MODAL ONLY AT NARROW WIDTHS. Full-screen classic under the layout's
           breakpoint stays modal; the Zero push tier is a TILE beside a live ribbon
           (review finding, round 1); and at desktop widths the sheet stands over a
           place-view with the rail operable beside it (app.css keeps its pointer events),
           so `aria-modal` there would tell assistive tech reachable chrome is not. Both
           facts are SUBSCRIBED — they follow `w` and resizes with the sheet standing. */
        modal={narrowNow && !pushTier}
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
        ) : readerGone ? (
          <MessageGone openTrash={openTrashWindow} />
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
            // `includeInlineParts: true` — the overlay's item list MUST be able to find the id it
            // was opened on, and an inline part is a real, clickable tile in the strip on every
            // rendering now (`MessagePane` lists them with the same flag). The overlay used to
            // build its list WITHOUT inline images, so clicking such a picture found no matching
            // item — and when the message carried nothing BUT inline images the list was empty
            // and the overlay silently declined to open.
            const view = attachments.itemsOf(previewFor.messageId, { includeInlineParts: true });
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
         * Done sends. That is all it does. Through `useMailSend` and never `engine.mutate({kind:"mail_send"})`: the
         * lock that makes a second press within one tick a no-op is a ref inside that hook (`mail-send.ts:203-215`,
         * which names a Reply Run step as exactly the caller a button's `disabled` cannot save), and a second key is
         * a second reservation and a second delivery. An empty textarea: nothing happens — no send, no advance, no
         * discharge. `canSend` already refuses a blank body (the server would accept and post one,
         * `drafts-service.ts:167-171`), and Skip is the affordance for moving on without writing; letting Done fall
         * through to Skip would put back a second way to leave a step having sent no mail — the shape of the bug this
         * change removes.
         */

        /**
         * An entry with no `messageId` is refused for the same reason twice over: nothing to send, and nothing that
         * could be paid.
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
          assigned={tagsOnAll(engine.verbRead(), pickerIds ?? [picker.forId])}
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
          onChoose={(dest, scope, makeRule, applyRetro) => changeScreening(senderMenu!.messageId, dest, scope, makeRule, applyRetro, senderMenu!.address)}
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
          onConfirm={(term, dest, field, applyRetro) => confirmSubjectRule(subjectRule!.messageId, term, dest, field, applyRetro)}
          onClose={() => setSubjectRule(null)}
        />
      ) : null}

      {/* The first-run stage — over the app, at `#/first-run`, gated on FOUR things rather than
          the route alone: `firstRun`, a door that can actually make the calls (absent on the
          demo); `route.firstRun`, the person asked for it — the stage never opens itself, since
          a dialog appearing over somebody's mail unbidden is the thing every entry point is
          written to avoid; `onboardingFacts`, `GET /mailboxes` has answered — null is "we
          cannot see", and over an unreachable API a null mailbox reads as "none connected",
          opening setup on an account with five mailboxes; and `consent.known`, `GET /consent`
          has answered — `onboardingCompletedAt` RESTS null, meaning "never been through setup".
          The last two are one rule twice: the overlay's resting inputs both read as "nothing
          has happened yet", so it may only be drawn on answers, never on defaults. */}
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
            ...firstRunPull,
            /* NOT a mirror row count: on a windowed mirror that number stops at the window's floor
               while the import runs on, so the bar froze, the rate read zero and no estimate ever
               appeared. `screened` above keeps it — both of its operands are projections over the
               same reader, and a difference between two populations is not a count. */
            pulled,
          }}
          decide={firstRunDecide}
          /* THE RUN NAMES A MAILBOX THIS INSTALL DOES NOT HOLD — the stage cannot derive it:
             `facts.mailbox` is null for a row that LEFT and for an install that never had one, and
             those two want opposite screens. */
          subjectVanished={firstRunSubjectNow.state === "vanished"}
          /* WHO ORGANIZES THIS ACCOUNT'S MAIL — the one holder the connect form can read, since the
             mailbox it is about does not exist yet. */
          accountOrganizer={accountOrganizer(facts)}
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
