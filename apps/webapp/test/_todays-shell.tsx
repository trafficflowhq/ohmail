/**
 * THE OLD SHELL'S DOOR, FOR THE TESTS THAT MOUNT TODAY'S VIEWS. The product's door took 49 inputs; the three entries
 * now build a host contract and mount the frame (`TodaysFrame`). A view's test still says what it mounts in the old
 * names, so this file reads those names back into a contract (`hostFromTodaysInputs`) and the two nodes the contract
 * does not carry (`todaysFromInputs`), and mounts the same provider and frame an entry does. It never runs `webHost`,
 * `desktopHost` or `pairedHost`: the entries' own tests and the journeys prove those.
 *
 * The old door's one default lives here and nowhere else: an absent `managedService` is the managed service.
 *
 * AND THE OLD SHELL'S FALLBACK FOR THE CONSENT WIRE lives here and nowhere else: the browser's own client where the
 * page has one, and with it the review of who you write to, as the web's own host answers. It is for the tests that
 * mount the web's views and name no wire; a test that hands `NONE` has none. No shell does this: each hands its own
 * wire or says `none`.
 */
import { createElement as h, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useLocale, useMessages, useTimeZone } from "next-intl";
import {
  CANNOT, FEATURE_NAMES, NONE,
  type FeatureEntry, type FeatureName, type FrameSupplies, type HostContract, type HostSession, type LinkedDraft, type LinkIn, type None,
  type ReaderEntry, type Signal,
} from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { HostConnection } from "@ohmail/app-logic/doors/host-connection";
import type { LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import type { OlderBodyWire } from "@ohmail/client-engine";
import type { AwayTransport } from "../app/shell/AwayResponderRow";
import type { ComposePrefill } from "@ohmail/app-logic/writing/compose";
import { apiConfigured } from "../app/api-client";
import { CLOUD_CONSENT, CLOUD_SEED_REVIEW } from "../app/(product)/mailbox/consent-over-api";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { DraftReplyWire } from "../app/shell/draft-reply";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { EngineProvider, useEngine, type OwnerResolver, type ProvidedEngine } from "../app/shell/engine";
import type { GapLettersTransport } from "../app/shell/GapLettersNotice";
import type { SupportHost } from "../app/shell/HelpContactPane";
import type { JunkWire } from "../app/shell/junk-window";
import type { FreshnessProbe, MailboxProbe } from "@ohmail/app-logic/mail-state/mail-state-binding";
import type { NotificationHost } from "../app/shell/notification-settings";
import type { OrganizerNoticeTransport } from "../app/shell/OrganizerNotice";
import type { ProfileImportTransport } from "../app/shell/ProfileImportCard";
import type { ImageDoor } from "../app/shell/remote-images";
import type { SuggestWire } from "../app/shell/screener-suggest";
import type { TrashWire } from "../app/shell/trash-window";
import { TodaysFrame } from "../app/shell/TodaysFrame";
import type { ScreenerSuggestCtx, TodaysNodes } from "../app/shell/todays-inputs";
import { useTodaysSupplies } from "../app/shell/todays-supplies";

/** The scope this harness hands where a test names none: an account of its own, never a key's word for nobody. */
export const HARNESS_SCOPE = "acc-harness";

/** The old door's inputs, by their old names. */
export interface TodaysShellProps {
  /**
   * The scope the host hands; absent: the storage owner the test named, else the harness's own; null: a host with no
   * scope. The harness never sets the storage owner itself.
   */
  scope?: string | null;
  demo?: boolean;
  engine?: ProvidedEngine;
  resolveOwner?: OwnerResolver;
  onConfirmed?: (accountId: string) => void;
  drawMail?: "now" | "wait";
  mailboxFacts?: MailboxProbe;
  organizerNoticeTransport?: OrganizerNoticeTransport;
  gapLettersTransport?: GapLettersTransport;
  mirrorFreshness?: FreshnessProbe;
  hostConnection?: HostConnection;
  sessionRefused?: boolean;
  sendSurfaceMaxTotalBytes?: number | null;
  accountSection?: ReactNode;
  mailboxSection?: ReactNode;
  aiSection?: ReactNode;
  billingSection?: ReactNode;
  storageSection?: ReactNode;
  storageCard?: ReactNode;
  liveBodyWire?: LiveBodyWire;
  accountNotice?: ReactNode;
  invitesSection?: ReactNode;
  securitySection?: ReactNode;
  aboutSection?: ReactNode;
  support?: SupportHost;
  desktopSection?: { label: string; node: ReactNode };
  devicesSection?: ReactNode;
  defaultMailSection?: ReactNode;
  stageCard?: ReactNode;
  notificationHost?: NotificationHost;
  screeningSection?: ReactNode;
  actRulesUnmarked?: boolean;
  screenerSuggest?: (ctx: ScreenerSuggestCtx) => ReactNode;
  awayTransport?: AwayTransport;
  awayIsLocal?: boolean;
  awayOnHost?: string | null;
  profileImportTransport?: ProfileImportTransport;
  /** The consent wire the test's host hands; `NONE` says it has none; absent: the web's own where the page has a client. */
  consentTransport?: ConsentTransport | None;
  imageWire?: ImageDoor;
  imagesFromComputer?: boolean;
  olderBodyWire?: OlderBodyWire;
  junkWire?: JunkWire;
  trashWire?: TrashWire;
  suggestWire?: SuggestWire;
  draftReplyWire?: DraftReplyWire;
  firstRun?: FirstRunHost;
  mailtoDraft?: ComposePrefill | null;
  onMailtoDraftSeeded?: () => void;
  onUnread?: (unread: number) => void;
  managedService?: boolean;
  /** The host's way back to a live session (Sign in, Reload); none where the case hands none. Hand a stable one. */
  recover?: HostSession["recover"];
  /**
   * The reader a case's host hands in place of the shell's own, for a case that stands a reading column of its own
   * parts; absent: the shell's (`todaysReader`) where the composition stands, none where it does not. Hand one made
   * once (at module scope), as a shell does.
   */
  reader?: ReaderEntry;
}

const orNone = <T,>(value: T | undefined | null): T | None => (value === undefined || value === null ? NONE : value);
const entryOf = (name: FeatureName, node: ReactNode | undefined): FeatureEntry | None =>
  (node === undefined ? NONE : { name, render: () => node });
const constant = <T,>(value: T): Signal<T> => ({ read: () => value, subscribe: () => () => undefined });

/** The two nodes the contract does not carry, as the old door was handed them. */
export function todaysFromInputs(props: TodaysShellProps): TodaysNodes {
  return {
    screenerSuggest: props.screenerSuggest ?? NONE,
    desktopPane: props.desktopSection ? { label: props.desktopSection.label } : NONE,
  };
}

/** The old door's inputs as a host contract: what `todaysInputs` reads back is what was handed in. */
export function hostFromTodaysInputs(
  props: TodaysShellProps, engine: HostContract["engine"], frame: FrameSupplies, linkIn: LinkIn | None,
): HostContract {
  const ceiling = props.sendSurfaceMaxTotalBytes;
  const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, NONE])) as Record<FeatureName, FeatureEntry | None>;
  Object.assign(features, {
    account: entryOf("account", props.accountSection),
    mailboxes: entryOf("mailboxes", props.mailboxSection),
    ai: entryOf("ai", props.aiSection),
    subscription: entryOf("subscription", props.billingSection),
    storage: entryOf("storage", props.storageSection),
    storageCard: entryOf("storageCard", props.storageCard),
    invites: entryOf("invites", props.invitesSection),
    security: entryOf("security", props.securitySection),
    about: entryOf("about", props.aboutSection),
    desktop: entryOf("desktop", props.desktopSection?.node),
    devices: entryOf("devices", props.devicesSection),
    defaultMail: entryOf("defaultMail", props.defaultMailSection),
    stageCard: entryOf("stageCard", props.stageCard),
    screener: entryOf("screener", props.screeningSection),
    help: props.support ? { name: "help", render: () => null } : NONE,
  });
  const support = props.support;
  const consent = props.consentTransport ?? (apiConfigured() ? CLOUD_CONSENT : NONE);
  /* What the old shell stands above the panes is handed on with today's own places, the ones the frame keeps, and never
     beside others: a test that draws panes of its own in the frame mounts no old shell over them. */
  const todays = Object.values(frame.places).some((place) => place !== NONE && place.panes.kind === "wide" && place.panes.kept === true);
  return {
    engine,
    session: {
      resolve: NONE, confirmed: NONE, state: props.sessionRefused === true ? "refused" : NONE,
      /* Whose partition the views write in: the scope the test hands, else the storage owner it named (the demo's own
         where it mounts the demo), else the harness's own account. */
      scope: props.scope !== undefined ? props.scope : storageOwner() ?? HARNESS_SCOPE,
      account: support?.accountId ?? null, signOut: NONE, recover: frame.recover,
    },
    reads: { mailboxes: orNone(props.mailboxFacts), copyAge: orNone(props.mirrorFreshness), access: NONE },
    wires: {
      organizerNotice: orNone(props.organizerNoticeTransport),
      gapLetters: orNone(props.gapLettersTransport),
      liveBody: orNone(props.liveBodyWire),
      away: orNone(props.awayTransport),
      profileImport: orNone(props.profileImportTransport),
      consent,
      images: orNone(props.imageWire),
      olderBody: orNone(props.olderBodyWire),
      junk: orNone(props.junkWire),
      trash: orNone(props.trashWire),
      suggest: orNone(props.suggestWire),
      draftReply: orNone(props.draftReplyWire),
      firstRun: orNone(props.firstRun),
      seedReview: apiConfigured() ? CLOUD_SEED_REVIEW : NONE,
      screening: NONE, autoFiled: NONE, folderSummary: NONE, ownModelAutoSuggest: NONE, connect: NONE, mailboxes: NONE,
    } as unknown as HostContract["wires"],
    capabilities: {
      ...CANNOT,
      service: props.managedService === false ? "self" : "managed",
      sendCeiling: ceiling === undefined ? "strict" : ceiling === null ? "mailbox" : ceiling,
      rulesMarked: props.actRulesUnmarked !== true,
      awayRunsOn: props.awayIsLocal === true ? "thisComputer" : props.awayOnHost ? { host: props.awayOnHost } : CANNOT.awayRunsOn,
      unsubscribeFrom: props.imagesFromComputer === true ? "computer" : "service",
      foldersStorable: consent === NONE ? CANNOT.foldersStorable : consent.foldersStorable,
      firstRunDoor: props.firstRun?.door ?? CANNOT.firstRunDoor,
    },
    features: {
      ...features, places: frame.places, stages: frame.stages, reader: props.reader ?? (todays ? frame.reader : NONE), above: todays ? frame.above : NONE,
    } as HostContract["features"],
    device: {
      build: support
        ? { surface: support.surface, version: support.version ?? null, commit: support.commit ?? null, mailtoLeaves: support.mailtoLeaves !== false }
        : { surface: "web", version: null, commit: null, mailtoLeaves: true },
      notifications: orNone(props.notificationHost),
      badge: orNone(props.onUnread),
      language: NONE, openLink: NONE, pickFile: NONE, saveFile: NONE, defaultMail: NONE, textSize: NONE, fold: NONE, liveTheme: NONE,
      address: frame.address, window: frame.window, appearance: frame.appearance,
    },
    signals: {
      hostConnection: props.hostConnection ? constant(props.hostConnection) : NONE,
      linkIn,
      sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE, droppedFiles: NONE,
      posture: NONE, insets: NONE, keyboard: NONE, back: NONE, wake: NONE,
    },
  } as HostContract;
}

/** A mail link handed in as the old prop: each new object is offered once, and the prop hears when it was taken. */
function useLinkIn(draft: ComposePrefill | null | undefined, seeded: (() => void) | undefined): LinkIn {
  const slot = useRef<{ held: LinkedDraft | null; listeners: Set<() => void>; seeded?: () => void } | null>(null);
  if (slot.current === null) slot.current = { held: null, listeners: new Set() };
  slot.current.seeded = seeded;
  const offered = useRef<ComposePrefill | null>(null);
  const linkIn = useMemo((): LinkIn => {
    const s = slot.current!;
    return {
      take() {
        const taken = s.held;
        s.held = null;
        if (taken !== null) s.seeded?.();
        return taken;
      },
      subscribe(arrived) {
        s.listeners.add(arrived);
        return () => { s.listeners.delete(arrived); };
      },
    };
  }, []);
  if (draft && offered.current !== draft) {
    offered.current = draft;
    slot.current.held = draft;
  }
  useEffect(() => {
    if (draft) for (const arrived of [...slot.current!.listeners]) arrived();
  }, [draft]);
  /* Always a link door, never `none`: the old door's prop comes and goes as a host offers a link and takes it back,
     and the adapter holds a link it has taken until the shell seeds it. */
  return linkIn;
}

function HarnessFrame(props: TodaysShellProps) {
  const engine = useEngine();
  const frame = useTodaysSupplies(props.recover ?? NONE);
  const linkIn = useLinkIn(props.mailtoDraft, props.onMailtoDraftSeeded);
  const host = useMemo(() => hostFromTodaysInputs(props, engine, frame, linkIn), [props, engine, frame, linkIn]);
  const todays = useMemo(() => todaysFromInputs(props), [props.screenerSuggest, props.desktopSection]);
  const locale = useLocale() === "de" ? "de" : "en";
  const messages = useMessages();
  const timeZone = useTimeZone() ?? "UTC";
  return h(TextProvider, { locale, messages: messages as never, timeZone, children: h(TodaysFrame, { host, todays }) });
}

const noSubscription = () => () => {};

/** The old door: today's views in the frame, as an entry mounts them. Drawn in a browser only, as the product is. */
export function AppShell(props: TodaysShellProps) {
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  if (!hydrated) return h("div", { className: "gate", "aria-busy": "true" });
  const { demo = false, engine, resolveOwner, onConfirmed, drawMail } = props;
  return h(
    EngineProvider,
    {
      demo,
      ...(engine ? { engine } : {}),
      ...(resolveOwner ? { resolveOwner } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(drawMail ? { drawMail } : {}),
    } as never,
    h(HarnessFrame, props),
  );
}
