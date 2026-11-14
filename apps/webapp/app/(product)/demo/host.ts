/**
 * THE DEMO'S ANSWER TO THE HOST CONTRACT: invented mail, and nothing behind it. Every wire, read, feature and signal
 * is `none`, so no hosted call can be made from the invented world; every capability is written out, none spread.
 * It lives in the web shell, not in a test package, while the web app ships the demo; it leaves with the demo. Its
 * scope is the demo's own partition, never none: a page that embeds the demo on the same origin must not find the
 * demo's words in the keys every mount without an owner shares.
 */
import { CANNOT, FEATURE_NAMES, NONE, type FrameSupplies, type HostCapabilities, type HostContract } from "@ohmail/app/host";
import { DEMO_STORAGE_OWNER } from "@ohmail/app-logic/storage/storage-owner";
import { browserNotificationHost } from "../../shell/notification-settings";

const WIRES = [
  "organizerNotice", "gapLetters", "liveBody", "away", "profileImport", "consent", "images", "olderBody", "junk",
  "trash", "suggest", "draftReply", "firstRun", "screening", "autoFiled", "seedReview", "folderSummary",
  "ownModelAutoSuggest", "connect", "mailboxes", "calendar",
] as const;

/** What the demo's page says of itself: which service it shows, and what a send from it may carry. */
export interface DemoSays {
  readonly service: HostCapabilities["service"];
  readonly sendCeiling: HostCapabilities["sendCeiling"];
}

export function demoHost(engine: HostContract["engine"], frame: FrameSupplies, says: DemoSays): HostContract {
  return {
    engine,
    session: { resolve: NONE, confirmed: NONE, state: NONE, scope: DEMO_STORAGE_OWNER, account: null, recover: NONE, signOut: NONE },
    reads: { mailboxes: NONE, copyAge: NONE, access: NONE },
    wires: Object.fromEntries(WIRES.map((wire) => [wire, NONE])) as unknown as HostContract["wires"],
    capabilities: {
      service: says.service,
      prices: CANNOT.prices,
      sendCeiling: says.sendCeiling,
      awayRunsOn: CANNOT.awayRunsOn,
      rulesMarked: true,
      imagesFrom: CANNOT.imagesFrom,
      unsubscribeFrom: CANNOT.unsubscribeFrom,
      foldersStorable: CANNOT.foldersStorable,
      suggest: CANNOT.suggest,
      pairing: CANNOT.pairing,
      account: CANNOT.account,
      firstRunDoor: CANNOT.firstRunDoor,
      mailboxes: CANNOT.mailboxes,
      language: CANNOT.language,
      // The demo asks no server: no hello, so no person on the wire.
      searchBy: CANNOT.searchBy,
      products: CANNOT.products,
    },
    features: {
      ...(Object.fromEntries(FEATURE_NAMES.map((name) => [name, NONE])) as Record<(typeof FEATURE_NAMES)[number], typeof NONE>),
      places: frame.places,
      stages: frame.stages,
      overs: frame.overs,
      reader: NONE,
      above: frame.above,
      calendar: frame.calendar,
    },
    device: {
      build: { surface: "web", version: null, commit: null, mailtoLeaves: true },
      notifications: browserNotificationHost,
      badge: NONE, language: NONE, openLink: NONE, pickFile: NONE, saveFile: NONE, defaultMail: NONE,
      textSize: NONE, fold: NONE, liveTheme: NONE,
      address: frame.address, window: frame.window, appearance: frame.appearance,
    },
    signals: {
      hostConnection: NONE, linkIn: NONE, sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE, droppedFiles: NONE,
      // A page in a browser: the browser owns the window's edges, its keyboard and its back.
      posture: NONE, insets: NONE, keyboard: NONE, back: NONE, wake: NONE,
    },
  };
}
