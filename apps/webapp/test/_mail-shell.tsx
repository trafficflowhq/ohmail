/**
 * THE SHELL'S DOOR, FOR THE TESTS: the frame over a host that hands the mail ground and the mail places, as every
 * browser entry mounts it (`useMailSupplies` of the mail entry, then the frame). Nothing of today's shell is
 * mounted: no composition above the panes, no view of today's in a pane, no key registry of a shell.
 *
 * A test says what its host answers in the old door's input names (`TodaysShellProps`), read into a contract here
 * (`hostFromTodaysInputs`), so a file written against the old door reads the same over this one. What is not seated
 * on the ground yet is not there: its address leads to the Ohbox. It never runs `webHost`, `desktopHost` or
 * `pairedHost`: the entries' own tests and the journeys prove those.
 *
 * The old door's one default lives here and nowhere else: an absent `managedService` is the managed service.
 *
 * AND THE OLD DOOR'S FALLBACK FOR THE CONSENT WIRE lives here and nowhere else: the browser's own client where the
 * page has one, and with it the review of who you write to, as the web's own host answers. It is for the tests that
 * mount the web's shell and name no wire; a test that hands `NONE` has none. No shell does this: each hands its own
 * wire or says `none`. THE JUNK WIRE AND THE SUGGESTION WIRE the same way: the browser's own client where the page
 * has one.
 *
 * THE SAME FOR THE PICTURE WIRE: the web's own, through this origin's proxy, where the page has a client and the test
 * names none; a test that hands `NONE` has no picture door.
 */
import { createElement as h, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  CANNOT, FEATURE_NAMES, NONE,
  type Appearance, type FeatureEntry, type FeatureName, type AwayWire as AwayTransport, type FrameSupplies, type GapLettersWire, type HostContract, type HostDevice,
  type HostSession, type JunkWire, type LinkedDraft, type OrganizerNoticeWire, type SuggestWire, type TrashWire,
  type LinkIn, type None, type ReaderEntry, type Signal,
} from "@ohmail/app/host";
import { NO_PANE_PARTS, useMailSupplies, type MailHostParts, type MailPaneParts } from "@ohmail/app/mail";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { HostConnection } from "@ohmail/app-logic/doors/host-connection";
import type { LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import type { OlderBodyWire } from "@ohmail/client-engine";
import { useOptionalTheme } from "@ohmail/ui";
import type { ComposePrefill } from "@ohmail/app-logic/writing/compose";
import { apiConfigured } from "../app/api-client";
import { CLOUD_CONSENT, CLOUD_SEED_REVIEW } from "../app/(product)/mailbox/consent-over-api";
import { WEB_IMAGES } from "../app/(product)/mailbox/image-wire";
import { MAILBOXES_NOTICES } from "../app/shell/browser-mail";
import { useAppLocale } from "../app/shell/LocaleContext";
import { BROWSER_READER, MailFrame as BrowserMailFrame } from "../app/shell/browser-mail";
import { WebContactScreening } from "../app/(product)/mailbox/WebContactScreening";
import { useAccountNotices } from "../app/(product)/mailbox/web-supplies";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { EngineProvider, useEngine, type OwnerResolver, type ProvidedEngine } from "../app/shell/engine";
import { DEMO_DAY } from "../app/shell/engine-config";
import type { SupportHost } from "../app/(product)/mailbox/HelpContactPane";
import { cloudWire as CLOUD_JUNK } from "../app/(product)/mailbox/junk-wire";
import type { FreshnessProbe, MailboxProbe } from "@ohmail/app-logic/mail-state/mail-state-binding";
import type { NotificationHost } from "../app/shell/notification-settings";
import type { ProfileImportTransport } from "../app/shell/ProfileImportCard";
import type { ImageDoor } from "../app/shell/remote-images";
import { CLOUD_WIRE as CLOUD_SUGGEST } from "../app/(product)/mailbox/suggest-wire";
import { fakePane, ok, row } from "../../../packages/app/test/mailboxes/pane/support.js";

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
  organizerNoticeTransport?: OrganizerNoticeWire;
  gapLettersTransport?: GapLettersWire;
  mirrorFreshness?: FreshnessProbe;
  hostConnection?: HostConnection;
  sessionRefused?: boolean;
  sendSurfaceMaxTotalBytes?: number | null;
  accountSection?: ReactNode;
  mailboxSection?: ReactNode;
  /**
   * The Mailboxes entry says its notices (the organizer's change, the gap's offer) as every host's entry does
   * (`MAILBOXES_NOTICES`). The same synthetic mailbox facts feed the reachable Settings list.
   * Absent: the entry is the section alone, as the old door had it.
   */
  mailboxesNotices?: boolean;
  /** The account's strip says its notices as the web's entry does (`useAccountNotices`); absent: no strip. */
  accountNotices?: boolean;
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
  desktopOffer?: {
    surface?: HostDevice["build"]["surface"];
    url: string | null;
    openLink: HostDevice["openLink"];
  };
  desktopSection?: { label: string; node: ReactNode };
  devicesSection?: ReactNode;
  defaultMailSection?: ReactNode;
  stageCard?: ReactNode;
  stageNotice?: NonNullable<FeatureEntry["notice"]>;
  notificationHost?: NotificationHost;
  screeningSection?: ReactNode;
  actRulesUnmarked?: boolean;
  awayTransport?: AwayTransport;
  awayIsLocal?: boolean;
  awayOnHost?: string | null;
  profileImportTransport?: ProfileImportTransport;
  /** The consent wire the test's host hands; `NONE` says it has none; absent: the web's own where the page has a client. */
  consentTransport?: ConsentTransport | None;
  /** The picture wire the test's host hands; `NONE` says it has none; absent: the web's own where the page has a client. */
  imageWire?: ImageDoor | None;
  imagesFromComputer?: boolean;
  olderBodyWire?: OlderBodyWire;
  junkWire?: JunkWire | None;
  trashWire?: TrashWire;
  suggestWire?: SuggestWire | None;
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
  /** A host can withhold a place while still handing the remaining mail features. */
  places?: Partial<FrameSupplies["places"]>;
}

const orNone = <T,>(value: T | undefined | null): T | None => (value === undefined || value === null ? NONE : value);
const entryOf = (name: FeatureName, node: ReactNode | undefined): FeatureEntry | None =>
  (node === undefined ? NONE : { name, render: () => node });
const constant = <T,>(value: T): Signal<T> => ({ read: () => value, subscribe: () => () => undefined });

/** The old door's inputs as a host contract: what `todaysInputs` reads back is what was handed in. */
export function hostFromTodaysInputs(
  props: TodaysShellProps, engine: HostContract["engine"], frame: FrameSupplies, linkIn: LinkIn | None,
): HostContract {
  const mailboxWire = props.mailboxesNotices === true
    ? {
        ...fakePane().wire,
        list: async () => ok(((await props.mailboxFacts?.()) ?? []).map((m) => row(m.id, m.address))),
      }
    : NONE;
  const ceiling = props.sendSurfaceMaxTotalBytes;
  const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, NONE])) as Record<FeatureName, FeatureEntry | None>;
  Object.assign(features, {
    account: entryOf("account", props.accountSection),
    mailboxes: props.mailboxesNotices === true
      ? { name: "mailboxes", render: () => props.mailboxSection ?? null, notice: MAILBOXES_NOTICES }
      : entryOf("mailboxes", props.mailboxSection),
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
    stageCard: props.stageNotice === undefined
      ? entryOf("stageCard", props.stageCard)
      : { name: "stageCard", render: (): null => null, notice: props.stageNotice },
    screener: entryOf("screener", props.screeningSection),
    help: props.support ? { name: "help", render: () => null } : NONE,
    accountStrip: props.accountNotices === true
      ? { name: "accountStrip", render: () => null, notice: useAccountNotices }
      : NONE,
  });
  const support = props.support;
  const desktopOffer = props.desktopOffer;
  const consent = props.consentTransport ?? (apiConfigured() ? CLOUD_CONSENT : NONE);
  /* What the old shell stands above the panes is handed on with today's own places, the ones the frame keeps, and never
     beside others: a test that draws panes of its own in the frame mounts no old shell over them. */
  return {
    engine,
    session: {
      resolve: NONE, confirmed: NONE, state: props.sessionRefused === true ? "refused" : NONE,
      /* Whose partition the views write in: the scope the test hands, else the storage owner it named (the demo's own
         where it mounts the demo), else the harness's own account. */
      scope: props.scope !== undefined ? props.scope : storageOwner() ?? HARNESS_SCOPE,
      mirrorAccount: null,
      account: support?.accountId ?? null, accountAddress: null, signOut: NONE, recover: frame.recover,
      today: props.demo === true ? DEMO_DAY : NONE,
    } satisfies HostSession,
    reads: { mailboxes: orNone(props.mailboxFacts), copyAge: orNone(props.mirrorFreshness), access: NONE },
    wires: {
      organizerNotice: orNone(props.organizerNoticeTransport),
      gapLetters: orNone(props.gapLettersTransport),
      liveBody: orNone(props.liveBodyWire),
      away: orNone(props.awayTransport),
      profileImport: orNone(props.profileImportTransport),
      consent,
      images: props.imageWire ?? (apiConfigured() ? WEB_IMAGES : NONE),
      olderBody: orNone(props.olderBodyWire),
      junk: props.junkWire ?? (apiConfigured() ? CLOUD_JUNK : NONE),
      trash: orNone(props.trashWire),
      suggest: props.suggestWire ?? (apiConfigured() ? CLOUD_SUGGEST : NONE),
      draftReply: orNone(props.draftReplyWire),
      firstRun: orNone(props.firstRun),
      seedReview: apiConfigured() ? CLOUD_SEED_REVIEW : NONE,
      calendar: NONE,
      screening: NONE, autoFiled: NONE, folderSummary: NONE, ownModelAutoSuggest: NONE, connect: NONE, mailboxes: mailboxWire,
    } as unknown as HostContract["wires"],
    capabilities: {
      ...CANNOT,
      mailboxes: mailboxWire === NONE ? NONE : "here",
      service: props.managedService === false ? "self" : "managed",
      sendCeiling: ceiling === undefined ? "strict" : ceiling === null ? "mailbox" : ceiling,
      rulesMarked: props.actRulesUnmarked !== true,
      awayRunsOn: props.awayIsLocal === true ? "thisComputer" : props.awayOnHost ? { host: props.awayOnHost } : CANNOT.awayRunsOn,
      unsubscribeFrom: props.imagesFromComputer === true ? "computer" : "service",
      foldersStorable: consent === NONE ? CANNOT.foldersStorable : consent.foldersStorable,
      firstRunDoor: props.firstRun?.door ?? CANNOT.firstRunDoor,
    },
    features: {
      ...features, places: props.places === undefined ? frame.places : { ...frame.places, ...props.places },
      stages: frame.stages, overs: frame.overs,
      reader: props.reader ?? frame.reader, above: frame.above,
    } as HostContract["features"],
    device: {
      build: {
        surface: desktopOffer?.surface ?? support?.surface ?? "web",
        version: support?.version ?? null,
        commit: support?.commit ?? null,
        mailtoLeaves: support?.mailtoLeaves !== false,
        desktopDownload: desktopOffer?.url ?? null,
      },
      notifications: orNone(props.notificationHost),
      badge: orNone(props.onUnread),
      language: NONE, openLink: desktopOffer?.openLink ?? NONE, pickFile: NONE, saveFile: NONE, defaultMail: NONE, textSize: NONE, fold: NONE, liveTheme: NONE,
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

/** What only the host can hand the Account section of Settings: its doors (the web's own are `WEB_PANE_PARTS`). */
type AccountDoors = Exclude<MailPaneParts["account"], typeof NONE>;

/**
 * The door's own inputs beside the old door's names. `accountDoors`: the Account section's doors a test hands, the
 * web's real ones or doubles; with them the host answers for the account here and hands its `account` feature, so
 * Settings stands with its Account section. Absent: no section's door, and no Settings.
 */
export type MailShellProps = TodaysShellProps & {
  readonly accountDoors?: AccountDoors;
  readonly general?: MailPaneParts["general"];
  readonly folders?: MailPaneParts["folders"];
  readonly webContactScreening?: boolean;
  readonly contactScreening?: MailHostParts["contactScreening"];
};

/** The host's `account` feature where the account's doors are handed: the section itself is the panes record's. */
const ACCOUNT_FEATURE = { name: "account", render: () => null } as const;

function MailFrame(props: MailShellProps) {
  const engine = useEngine();
  /* The look the test's theme stands under, as an entry reads it; a mount with no theme stands in paper, light. */
  const theme = useOptionalTheme();
  const face = theme?.face ?? "paper";
  const scheme = theme?.resolved ?? "light";
  const look: Appearance = useMemo(() => ({ face, scheme }), [face, scheme]);
  /* The host's own parts, one record read at the mount as an entry's is: the web's reader, and what a host alone
     hands the first run: the test's own second-factor prompt where its first-run door names one (as the old door
     handed it), and nothing else. */
  const [own] = useState((): MailHostParts => {
    const prompt = props.firstRun?.stepUp?.prompt;
    return {
      reader: BROWSER_READER,
      ...(props.webContactScreening ? { contactScreening: WebContactScreening } : {}),
      ...(props.contactScreening ? { contactScreening: props.contactScreening } : {}),
      stageParts: {
        firstRun: { factor: prompt ? (ask) => prompt(ask) : NONE, pair: NONE, aiProvider: NONE, calendar: NONE },
      },
      paneParts: {
        ...NO_PANE_PARTS,
        general: props.general ?? NONE,
        folders: props.folders ?? NONE,
        mailboxes: props.mailboxesNotices === true ? { factor: NONE, calendar: NONE } : NONE,
        account: props.accountDoors ?? NONE,
      },
    };
  });
  const frame = useMailSupplies(window, look, props.recover ?? NONE, own);
  const linkIn = useLinkIn(props.mailtoDraft, props.onMailtoDraftSeeded);
  const doors = props.accountDoors !== undefined;
  const controls = useAppLocale();
  const host = useMemo((): HostContract => {
    const made = hostFromTodaysInputs(props, engine, frame, linkIn);
    /* What the mail entry hands is handed on whole: its places, its stages, the ground above them, and the reading
       column (a test's own where it names one). Where the account's doors are handed, the host answers for the
       account here, as the web's does. */
    return {
      ...made,
      ...(doors ? { capabilities: { ...made.capabilities, account: "here" } } : {}),
      device: {
        ...made.device,
        language: props.general && controls ? { locale: controls.locale, adoptLocale: controls.adoptLocale } : NONE,
      },
      features: {
        ...made.features,
        ...(doors ? { account: ACCOUNT_FEATURE } : {}),
      },
    };
  }, [props, engine, frame, linkIn, doors, controls]);
  return h(BrowserMailFrame, { host });
}

const noSubscription = () => () => {};

/** The new shell as an entry mounts it: its engine, then the frame over the mail ground. Drawn in a browser only. */
export function MailShell(props: MailShellProps) {
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
    h(MailFrame, props),
  );
}
