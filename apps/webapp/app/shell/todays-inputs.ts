/**
 * TODAY'S VIEWS, FED FROM THE HOST CONTRACT. The one place the contract is read back under the old shell's names:
 * a pure function of the host and the two nodes the contract does not carry. A wire is read back as the very object
 * the shell handed in (what it carries beside its verbs rides on it unchanged); `none` is `undefined`, and nothing
 * is defaulted. Two answers that contradict each other throw at mount, naming both keys.
 */
import type { ReactNode } from "react";
import { NONE, type FeatureEntry, type HostContract, type None } from "@ohmail/app/host";
import type { OlderBodyWire } from "@ohmail/client-engine";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import type { AwayTransport } from "./AwayResponderRow";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { DraftReplyWire } from "./draft-reply";
import type { GapLettersTransport } from "./GapLettersNotice";
import type { SupportHost } from "./HelpContactPane";
import type { JunkWire } from "@ohmail/app-logic/screener/junk-window";
import type { FreshnessProbe, MailboxProbe } from "@ohmail/app-logic/mail-state/mail-state-binding";
import type { SuggestStanding } from "@ohmail/app-logic/screener/no-suggestion";
import type { NotificationHost } from "./notification-settings";
import type { OrganizerNoticeTransport } from "./OrganizerNotice";
import type { ProfileImportTransport } from "./ProfileImportCard";
import type { ImageDoor } from "./remote-images";
import type { SenderSuggestion, SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";
import type { TrashWire } from "./trash-window";

/** What the Screener's own suggest control is handed. */
export interface ScreenerSuggestCtx {
  senders: string[];
  resuggestable: string[];
  unanswered: number;
  absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
  absorbStanding: (standing: SuggestStanding | null) => void;
}

/** What today's views take from a shell that the host contract does not carry. Every shell answers every key. */
export interface TodaysNodes {
  /** The Screener's own suggest control, where the shell brings one. Leaves with `screener`. */
  readonly screenerSuggest: ((ctx: ScreenerSuggestCtx) => ReactNode) | None;
  /** The desktop's own Settings pane, named in the desktop's words. Leaves with `settings`. */
  readonly desktopPane: { readonly label: string } | None;
}
export const NO_TODAYS: TodaysNodes = { screenerSuggest: NONE, desktopPane: NONE };

/** Today's types of the wires, by contract key. */
interface TodaysWires {
  organizerNotice: OrganizerNoticeTransport;
  gapLetters: GapLettersTransport;
  liveBody: LiveBodyWire;
  away: AwayTransport;
  profileImport: ProfileImportTransport;
  consent: ConsentTransport;
  images: ImageDoor;
  olderBody: OlderBodyWire;
  junk: JunkWire;
  trash: TrashWire;
  suggest: SuggestWire;
  draftReply: DraftReplyWire;
  firstRun: FirstRunHost;
}

/** A wire under today's type, or `undefined` where the shell said `none`. The one cast. */
function wireOf<K extends keyof TodaysWires>(host: HostContract, key: K): TodaysWires[K] | undefined {
  const wire = host.wires[key];
  return wire === NONE ? undefined : (wire as unknown as TodaysWires[K]);
}

const entry = (feature: FeatureEntry | None): ReactNode | undefined => (feature === NONE ? undefined : feature.render());

/** The old names, each as `ShellInner` and the two hosts above it take it. */
export interface TodaysInputs {
  managedService: boolean;
  mailboxFacts: MailboxProbe | undefined;
  mirrorFreshness: FreshnessProbe | undefined;
  organizerNoticeTransport: OrganizerNoticeTransport | undefined;
  gapLettersTransport: GapLettersTransport | undefined;
  sendSurfaceMaxTotalBytes: number | null | undefined;
  accountSection: ReactNode | undefined;
  mailboxSection: ReactNode | undefined;
  aiSection: ReactNode | undefined;
  billingSection: ReactNode | undefined;
  storageSection: ReactNode | undefined;
  storageCard: ReactNode | undefined;
  liveBodyWire: LiveBodyWire | undefined;
  invitesSection: ReactNode | undefined;
  securitySection: ReactNode | undefined;
  aboutSection: ReactNode | undefined;
  support: SupportHost | undefined;
  desktopSection: { label: string; node: ReactNode } | undefined;
  devicesSection: ReactNode | undefined;
  defaultMailSection: ReactNode | undefined;
  stageCard: ReactNode | undefined;
  notificationHost: NotificationHost | undefined;
  screeningSection: ReactNode | undefined;
  actRulesUnmarked: boolean;
  screenerSuggest: ((ctx: ScreenerSuggestCtx) => ReactNode) | undefined;
  awayTransport: AwayTransport | undefined;
  awayIsLocal: boolean;
  awayOnHost: string | undefined;
  profileImportTransport: ProfileImportTransport | undefined;
  consentTransport: ConsentTransport | undefined;
  imageWire: ImageDoor | undefined;
  imagesFromComputer: boolean;
  olderBodyWire: OlderBodyWire | undefined;
  junkWire: JunkWire | undefined;
  trashWire: TrashWire | undefined;
  suggestWire: SuggestWire | undefined;
  draftReplyWire: DraftReplyWire | undefined;
  firstRun: FirstRunHost | undefined;
  onUnread: ((unread: number) => void) | undefined;
}

function contradiction(a: string, b: string, what: string): Error {
  return new Error(`the host contract contradicts itself: ${a} and ${b} (${what})`);
}

function supportOf(host: HostContract): SupportHost | undefined {
  if (host.features.help === NONE) return undefined;
  const build = host.device.build;
  if (build.surface === "pairedPage") throw contradiction("features.help", "device.build.surface", "a paired page has no Help pane");
  if (build.surface === "phone") throw contradiction("features.help", "device.build.surface", "the phone mounts none of today's views");
  return {
    surface: build.surface,
    version: build.version,
    commit: build.commit,
    accountId: host.session.account,
    mailtoLeaves: build.mailtoLeaves,
  };
}

function desktopOf(host: HostContract, todays: TodaysNodes): TodaysInputs["desktopSection"] {
  if (host.features.desktop === NONE) return undefined;
  if (todays.desktopPane === NONE) throw contradiction("features.desktop", "todays.desktopPane", "the pane stands without its name");
  return { label: todays.desktopPane.label, node: host.features.desktop.render() };
}

function consentOf(host: HostContract): ConsentTransport | undefined {
  const consent = wireOf(host, "consent");
  if (consent !== undefined && typeof consent.foldersStorable !== "boolean") {
    throw contradiction("wires.consent", "wires.consent.foldersStorable", "the flag is not a boolean");
  }
  return consent;
}

function firstRunOf(host: HostContract): FirstRunHost | undefined {
  const firstRun = wireOf(host, "firstRun");
  if (firstRun === undefined) return undefined;
  if (typeof firstRun.door !== "string") throw contradiction("wires.firstRun", "wires.firstRun.door", "the door is not named");
  if (firstRun.door !== host.capabilities.firstRunDoor) {
    throw contradiction("wires.firstRun.door", "capabilities.firstRunDoor", `${firstRun.door} against ${host.capabilities.firstRunDoor}`);
  }
  return firstRun;
}

/** The old shell's inputs, read off the host contract. Pure: the same host gives the same inputs. */
export function todaysInputs(host: HostContract, todays: TodaysNodes): TodaysInputs {
  const { capabilities: can, features, reads, device } = host;
  const away = can.awayRunsOn;
  const ceiling = can.sendCeiling;
  return {
    managedService: can.service === "managed",
    /* Read back under today's types, as the wires are: each shell hands in today's probe itself. */
    mailboxFacts: reads.mailboxes === NONE ? undefined : (reads.mailboxes as MailboxProbe),
    mirrorFreshness: reads.copyAge === NONE ? undefined : (reads.copyAge as FreshnessProbe),
    organizerNoticeTransport: wireOf(host, "organizerNotice"),
    gapLettersTransport: wireOf(host, "gapLetters"),
    sendSurfaceMaxTotalBytes: ceiling === "strict" ? undefined : ceiling === "mailbox" ? null : ceiling,
    accountSection: entry(features.account),
    mailboxSection: entry(features.mailboxes),
    aiSection: entry(features.ai),
    billingSection: entry(features.subscription),
    storageSection: entry(features.storage),
    storageCard: entry(features.storageCard),
    liveBodyWire: wireOf(host, "liveBody"),
    invitesSection: entry(features.invites),
    securitySection: entry(features.security),
    aboutSection: entry(features.about),
    support: supportOf(host),
    desktopSection: desktopOf(host, todays),
    devicesSection: entry(features.devices),
    defaultMailSection: entry(features.defaultMail),
    stageCard: entry(features.stageCard),
    notificationHost: device.notifications === NONE ? undefined : (device.notifications as NotificationHost),
    screeningSection: entry(features.screener),
    actRulesUnmarked: !can.rulesMarked,
    screenerSuggest: todays.screenerSuggest === NONE ? undefined : todays.screenerSuggest,
    awayTransport: wireOf(host, "away"),
    awayIsLocal: away === "thisComputer",
    awayOnHost: typeof away === "object" ? away.host : undefined,
    profileImportTransport: wireOf(host, "profileImport"),
    consentTransport: consentOf(host),
    imageWire: wireOf(host, "images"),
    imagesFromComputer: can.unsubscribeFrom === "computer",
    olderBodyWire: wireOf(host, "olderBody"),
    junkWire: wireOf(host, "junk"),
    trashWire: wireOf(host, "trash"),
    suggestWire: wireOf(host, "suggest"),
    draftReplyWire: wireOf(host, "draftReply"),
    firstRun: firstRunOf(host),
    onUnread: device.badge === NONE ? undefined : device.badge,
  };
}
