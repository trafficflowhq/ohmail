/**
 * THE PHONE SHELL'S ANSWER TO THE HOST CONTRACT, in its four settings: a phone paired to the managed
 * service, to a server its operator runs, or to a desktop, and a phone whose own engine organizes its
 * mailbox. A pure reading of what native told the page (`ShellConfig`) and what the page built. Where
 * the plan names a target the phone does not reach yet (a read, a wire, a feature), the answer is the
 * contract's word for "cannot" until the change that wires it hands its transport in.
 */
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import {
  CANNOT, NONE,
  type DeviceNotifications, type FrameSupplies, type HostContract, type HostSignals,
} from "@ohmail/app/host";
import { consentVia } from "@ohmail/app-logic/consent/consent-wire";
import type { ShellSetting } from "../../src/shell/bridge-kinds";
import { accountFetch } from "./account-fetch";
import { phoneAwayWire } from "./account-data-panes";
import type { bridgeFetch } from "./bridge-fetch";
import { readPhoneMailboxes } from "./mailboxes-wire";

type Engine = HostContract["engine"];
type Supplied<T> = Exclude<T, typeof NONE>;

/** What the page knows before it mounts, from native's `config`. */
export interface PhoneFacts {
  readonly setting: ShellSetting;
  readonly serverName?: string;
  readonly scope: string;
  /** The account the server named at pairing; native asks the server again at every start. */
  readonly accountId: string;
  readonly build: { readonly version: string | null; readonly commit: string | null };
}

/** What the page hands in: the native ceremonies as acts, the notice reader, the frame's supplies, the bridge's signals. */
export interface PhoneSupplies {
  /** Native's sign-out ceremony. Never the page's own: the credential is not the page's. */
  readonly signOut: () => Promise<void>;
  readonly notifications: DeviceNotifications;
  readonly calendar?: CalendarPort;
  /** What every shell hands the frame: the places it mounts, the address, the window, the look, the way back. */
  readonly frame: FrameSupplies;
  /** The page's existing scoped transport, to the phone's own engine or its paired server. */
  readonly mailFetch?: ReturnType<typeof bridgeFetch>;
  readonly accountFetch?: ReturnType<typeof accountFetch>;
  readonly mailboxWires?: Pick<HostContract["wires"], "mailboxes" | "connect">;
  readonly search?: HostContract["capabilities"]["searchBy"];
  readonly signals: {
    readonly linkIn: Supplied<HostSignals["linkIn"]>;
    readonly posture: Supplied<HostSignals["posture"]>;
    readonly insets: Supplied<HostSignals["insets"]>;
    readonly keyboard: Supplied<HostSignals["keyboard"]>;
    readonly back: Supplied<HostSignals["back"]>;
    readonly wake: Supplied<HostSignals["wake"]>;
  };
}

const SERVICE = { managed: "managed", selfHosted: "self", desktopHost: "ownComputer", standalone: "ownComputer" } as const;

export function phoneHost(engine: Engine, facts: PhoneFacts, has: PhoneSupplies): HostContract {
  const { setting } = facts;
  const { mailFetch } = has;
  const own = setting === "standalone";
  const calendar = has.frame.calendar !== NONE && has.calendar !== undefined;
  const settings = has.mailboxWires !== undefined || calendar;
  const managesAccount = settings && (setting === "managed" || setting === "selfHosted");
  return {
    engine,
    session: {
      resolve: NONE,
      confirmed: NONE,
      // A paired phone's session can be refused by its server; the phone's own mailbox has no server to refuse it.
      state: own || setting === "desktopHost" ? NONE : "live",
      scope: facts.scope,
      // A hosted account stands behind a phone paired to a server; a desktop's door and the phone's own engine have none.
      account: setting === "managed" || setting === "selfHosted" ? facts.accountId : null,
      mirrorAccount: null,
      accountAddress: null, accountDisplayName: null,
      signOut: own ? NONE : has.signOut,
      recover: has.frame.recover,
      today: NONE,
    },
    reads: {
      mailboxes: mailFetch ? ({ counts } = {}) => readPhoneMailboxes(mailFetch, counts) : NONE,
      copyAge: NONE,
      access: NONE,
    },
    wires: {
      organizerNotice: NONE, gapLetters: NONE, liveBody: NONE, away: has.accountFetch ? phoneAwayWire(has.accountFetch) : NONE, profileImport: NONE,
      consent: mailFetch ? consentVia(mailFetch) : NONE,
      images: NONE, olderBody: NONE, junk: NONE, trash: NONE, suggest: NONE, draftReply: NONE, firstRun: NONE,
      screening: NONE, autoFiled: NONE, seedReview: NONE, folderSummary: NONE, ownModelAutoSuggest: NONE,
      connect: has.mailboxWires?.connect ?? NONE, mailboxes: has.mailboxWires?.mailboxes ?? NONE,
      calendar: has.calendar ?? NONE,
    },
    capabilities: {
      service: SERVICE[setting],
      // A phone never links out to a purchase.
      prices: CANNOT.prices,
      sendCeiling: CANNOT.sendCeiling,
      awayRunsOn: !has.accountFetch ? CANNOT.awayRunsOn
        : setting === "desktopHost" ? facts.serverName ? { host: facts.serverName } : CANNOT.awayRunsOn
        : own ? "thisPhone" : "service",
      rulesMarked: true,
      imagesFrom: CANNOT.imagesFrom,
      unsubscribeFrom: setting === "managed" || setting === "selfHosted" ? "service" : "computer",
      foldersStorable: has.mailboxWires !== undefined && mailFetch !== undefined,
      suggest: CANNOT.suggest,
      pairing: managesAccount ? "account" : CANNOT.pairing,
      account: managesAccount ? "here" : own ? CANNOT.account : "signOutOnly",
      firstRunDoor: CANNOT.firstRunDoor,
      mailboxes: has.mailboxWires?.mailboxes && has.mailboxWires.mailboxes !== NONE
        ? own ? "here" : "resyncOnly"
        : CANNOT.mailboxes,
      language: "install",
      searchBy: has.search ?? (own ? "people" : CANNOT.searchBy),
      products: calendar ? "calendar" : CANNOT.products,
    },
    features: {
      account: managesAccount ? { name: "account", render: () => null } : NONE,
      mailboxes: has.mailboxWires ? { name: "mailboxes", render: () => null } : NONE,
      ai: managesAccount && has.mailboxWires ? { name: "ai", render: () => null } : NONE,
      subscription: managesAccount ? { name: "subscription", render: () => null } : NONE,
      storage: managesAccount ? { name: "storage", render: () => null } : NONE, storageCard: NONE, accountStrip: NONE,
      invites: managesAccount ? { name: "invites", render: () => null } : NONE,
      security: managesAccount ? { name: "security", render: () => null } : NONE,
      about: has.mailboxWires ? { name: "about", render: () => null } : NONE,
      desktop: NONE, devices: settings ? { name: "devices", render: () => null } : NONE,
      defaultMail: NONE, stageCard: NONE,
      screener: has.mailboxWires ? { name: "screener", render: () => null } : NONE,
      help: has.mailboxWires ? { name: "help", render: () => null } : NONE,
      places: has.frame.places,
      stages: has.frame.stages,
      overs: has.frame.overs,
      reader: has.frame.reader,
      above: has.frame.above,
      calendar: has.frame.calendar,
    },
    device: {
      build: {
        surface: "phone",
        version: facts.build.version,
        commit: facts.build.commit,
        mailtoLeaves: true,
        desktopDownload: null,
      },
      notifications: has.notifications,
      badge: NONE,
      language: NONE,
      openLink: NONE,
      pickFile: NONE,
      saveFile: NONE,
      defaultMail: NONE,
      address: has.frame.address,
      window: has.frame.window,
      appearance: has.frame.appearance,
      textSize: NONE,
      fold: NONE,
      liveTheme: NONE,
    },
    signals: {
      hostConnection: NONE,
      linkIn: has.signals.linkIn,
      sessionState: NONE,
      copyAge: NONE,
      access: NONE,
      updateOffer: NONE,
      droppedFiles: NONE,
      posture: has.signals.posture,
      insets: has.signals.insets,
      keyboard: has.signals.keyboard,
      back: has.signals.back,
      wake: has.signals.wake,
    },
  };
}
