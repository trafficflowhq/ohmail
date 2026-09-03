/**
 * THE STANDALONE WINDOW'S OWN WORDS — every sentence outside the shared shell, in one table.
 *
 * The mail client in this window is `AppShell`, and it reads `messages/{en,de}.json` like the
 * browser does. Around it sits a second interface that the browser has no equivalent of: the door
 * chooser a fresh install opens with, the gate's apology, the boot line, Settings → Desktop and
 * Settings → About, and the mailto ask. Every string in those was an English literal, so a German
 * install read a German rail beside an English door — and nothing could tell, because a literal is
 * invisible to `tsc` and to a suite that renders in English.
 *
 * ── WHY ONE TABLE AND NOT `useTranslations` IN EACH PANE ────────────────────────────────────
 *
 * Half of this copy is produced by functions that are not components and cannot call a hook:
 * `bootSentence` maps an engine phase to a sentence, `errorSentence` turns a throw into one,
 * `credentialLine`/`engineWhy`/`engineLine` are switch tables inside Settings → Desktop, and
 * `mailboxRowWhy` is shared by two panes from a module with no React in it. `liveCopy`
 * (`app/shell/locale.ts`) is the route those four already have in the shared shell: getters over
 * the active catalogue, with the English sentence below as the resting answer.
 *
 * Using it for the components as well buys a second thing that matters more than symmetry: these
 * panes are rendered BARE in two dozen unit tests, with no intl provider above them, and
 * `useTranslations` throws without one. A table keeps every one of those renders working and
 * English, and the German arrives from the catalogue at runtime — which is the same bargain
 * `MessageBody`, `AttachmentStrip` and `BodyText` struck for the same reason.
 *
 * ── WHAT HOLDS THIS AND `desktopDoor` TOGETHER ──────────────────────────────────────────────
 *
 * `test/desktop-door-copy.test.ts`: the key set here is EXACTLY the namespace's, every plain
 * sentence is byte-identical to `en.json`, and with a German catalogue set the same table answers
 * German. Drift in either direction is red — a copy edit made in one place and not the other
 * would otherwise put one sentence in the app and a different one in every test asserting on it.
 *
 * The namespace is on `vite.config.ts`'s {@link WINDOW_ONLY_NAMESPACES}: the served host client
 * mounts none of these files (proved from its import graph in `test/desktop-messages.test.ts`),
 * so shipping it to a phone would be payload that can never be rendered there.
 */
import { liveCopy } from "../../webapp/app/shell/locale.js";

import { MACHINE_WORD } from "./platform.js";

/**
 * THE ENGLISH, AND THE SHAPE OF THE NAMESPACE.
 *
 * Flat, deliberately: `liveCopy` addresses one key per member, so a nested group would be
 * unreachable through it and the namespace would need two access routes. The prefixes carry the
 * grouping instead — `door*`/`local*`/`server*`/`cloud*` for the chooser, `about*`, `install*`,
 * `cred*`/`engine*` for Settings → Desktop, `mailto*`, `gate*`, `boot*`.
 */
const EN = {
  /* ── THE MACHINE'S OWN WORD ──────────────────────────────────────────────────────────────
     `platform.ts` resolves "Mac" / "PC" / "computer" from the platform the artifact was BUILT
     for. Two of the three are proper nouns and travel; the third is an ordinary noun and does
     not — German capitalises it, and an untranslated "computer" in the middle of a German
     sentence is the small tell that gives away a half-translated screen. So the word is a key
     like every other, and {@link machineWord} is the one place that picks which. */
  machineMac: "Mac",
  machinePc: "PC",
  machineComputer: "computer",

  /* ── THE DOOR CHOOSER: which machine does the organizing ─────────────────────────────────── */
  chooserTitle: "Which mailbox is this?",
  chooserGroupAria: "Which machine does the organizing",
  doorLocalName: (machine: string) => `On this ${machine}`,
  doorLocalSay: "Your own IMAP mailbox, organized right here. Nothing is sent anywhere.",
  doorServerName: "Your own server",
  doorServerLead: "Self-hosted ohmail Cloud.",
  doorServerSay: "A server you run does the organizing; this app keeps a copy.",
  doorCloudName: "ohmail Cloud",
  doorCloudSay: "Our hosted service does the organizing; this app keeps a copy.",
  doorsTravel:
    "Move between these anytime. Your rules and settings live in your own mailbox and travel "
    + "with you — the mailbox is always the master.",

  /* ── DOOR ONE: the person's own IMAP server, opened from this machine ────────────────────── */
  localTitle: "Your own mailbox",
  localLead: (machine: string) =>
    `This computer connects to your mail server directly. Your password is stored on this `
    + `${machine}, encrypted under a key held in the keychain, and is never sent to us.`,
  localAddress: "Mailbox address",
  localPassword: "Mailbox password",
  localPasswordHint:
    "For most providers this is an app password rather than the password you sign in with — the "
    + "note above your provider says which.",
  localImapHost: "Incoming server (IMAP)",
  localImapPort: "IMAP port",
  localSmtpHost: "Outgoing server (SMTP)",
  localSmtpPort: "SMTP port",
  localUser: "Username, if it is not the address",
  localOpening: "Opening your mailbox…",
  localOpen: "Open this mailbox",

  /* ── DOOR TWO: a server the person runs ──────────────────────────────────────────────────── */
  serverAskLead:
    "Give the address you open ohmail at in a browser. This app will check that your server is "
    + "there before it asks for anything else.",
  serverSignInLead: (machine: string) =>
    `Signing in happens in the mail engine on this ${machine} — the password and the code go `
    + "straight there and are not kept anywhere else.",
  serverOrigin: "Your server's address",
  serverOriginPlaceholder: "https://ohmail.example.com",
  serverAddress: "Your ohmail address on that server",
  /* SPLIT AROUND THE FILE NAME, which is a constant rather than a word: `OPERATOR_CA_FILE` is
     rendered as code between the two halves. Two keys rather than one with a placeholder because
     the name has to keep its `<code>` treatment, and a placeholder would render it as prose. */
  serverCaHintBefore:
    "If your server issues its own certificates, put its root certificate in a file named",
  serverCaHintAfter:
    "in this app's data folder first. ohmail verifies certificates and has no way to skip that.",
  serverReached: (server: string, address: string) => `Reached ${server}. Signing in as ${address}.`,
  serverChecking: "Checking your server…",
  serverContinue: "Continue",

  /* ── DOOR THREE: a hosted ohmail account ─────────────────────────────────────────────────── */
  cloudTitle: "Sign in to ohmail Cloud",
  cloudLeadSignIn: (machine: string) =>
    `The copy of your mail on this ${machine} is where you left it. Signing in happens in the `
    + "mail engine on this machine — the password and the code go straight there and are not "
    + "kept anywhere else.",
  cloudLead:
    "Your account is organized on our servers and this app keeps a copy. Signing in happens in "
    + "the mail engine on this machine — the password and the code go straight there and are not "
    + "kept anywhere else.",
  cloudAddress: "Your ohmail address",
  cloudBrowserHint:
    "Your browser opens ohmail.app. Sign in there if you are not already, then press “Open "
    + "ohmail” on that page and this app comes forward signed in.",
  cloudOpenBrowser: "Open ohmail.app",
  cloudHandoffLabel: "Or type the code the page shows",
  cloudHandoffHint: "The code works once and lasts a couple of minutes.",
  cloudUsePassword: "Use my password instead",
  cloudUseBrowser: "Sign in with browser",
  /* The one sentence the chooser says about the machine rather than about the mailbox. */
  noBrowser: (machine: string) =>
    `This ${machine} would not open a browser. The page is at ohmail.app/link-desktop.`,
  browserSignInFailed: "The browser sign-in could not be started.",

  /* ── SHARED BY MORE THAN ONE CARD ────────────────────────────────────────────────────────── */
  password: "Password",
  totpLabel: "Code from your authenticator app",
  signIn: "Sign in",
  signingIn: "Signing in…",
  signOut: "Sign out",
  back: "Back",
  cancel: "Cancel",
  reload: "Reload",
  mailboxLabel: "Mailbox",
  doorNotChosen: "Not chosen",
  doorNoneWhy: "No mailbox has been chosen on this install yet.",

  /* ── SETTINGS → ABOUT ────────────────────────────────────────────────────────────────────── */
  aboutAppLabel: "ohmail for desktop",
  aboutAppWhy: "The build running in this window.",
  aboutPublisher: "Published by",
  aboutPublisherWhy: "The company that writes and signs this app.",
  aboutLicence: "Licence",
  aboutLicenceWhy:
    "Free software. The source of this app is published, and you may build it yourself.",
  aboutInstallHead: "This install",
  aboutOpenedThrough: "Opened through",
  aboutDoorLocalValue: "Your own mail server",
  aboutDoorCloudValue: "An ohmail Cloud account",
  aboutDoorCloudWhy:
    "A hosted account. The organizing happens on our servers and this app keeps a copy.",
  aboutDoorLocalWhy:
    "This computer opens your mailbox directly. Nothing about your mail is sent to us.",
  aboutMailNote:
    "Your mail lives in your mailbox, on your own server. ohmail files it into folders there, "
    + "where every other mail app you own can see them, and keeps a copy on this computer so the "
    + "app is fast and works offline. Stop using ohmail and your mail is exactly where you left "
    + "it.",
  aboutLinksCloud:
    "Privacy and the list of companies we rely on: ohmail.app/privacy and "
    + "ohmail.app/subprocessors. Source: github.com/trafficflowhq/ohmail.",
  aboutLinksLocal: "Privacy: ohmail.app/privacy. Source: github.com/trafficflowhq/ohmail.",

  /* ── WHAT THIS INSTALL DOES WITH THE MAILBOX IT NAMES — see `install-role.ts` ────────────── */
  mailboxWhyOrganizes: "The mailbox this copy of ohmail organizes.",
  mailboxWhyReadsNamed: (name: string) =>
    `The mailbox this copy of ohmail reads. ${name} organizes it.`,
  mailboxWhyReads: "The mailbox this copy of ohmail reads. Another ohmail organizer organizes it.",

  /* ── SETTINGS → DESKTOP ──────────────────────────────────────────────────────────────────── */
  paneLabel: "Desktop",
  installConnectedThrough: "Connected through",
  doorCloudWhy:
    "A hosted ohmail account. The organizing happens on our servers and this app keeps a copy.",
  doorLocalWhy:
    "Your own mail server, opened by this computer. Nothing about your mail is sent to us.",
  credCloudLabel: "Account session",
  credCloudLiveValue: "Signed in",
  credCloudLiveWhy: "This install holds a session for your hosted account.",
  credCloudOutValue: "Signed out",
  credCloudOutWhy: "There is no session for this account on this machine. Sign in again below.",
  credCloudCheckingValue: "Checking",
  credCloudCheckingWhy: "The mail engine has not answered about this account's session yet.",
  credReadyValue: "Stored",
  credReadyWhy: (machine: string) => `Sealed under a key in this ${machine}'s keychain, and working.`,
  credAbsentValue: "Not stored",
  credAbsentWhy: (machine: string) =>
    `No mailbox password is stored on this ${machine}, so nothing is being synced yet.`,
  credUnreadableValue: "Needs re-entering",
  credUnreadableWhy:
    "Something is stored, and this install's key does not open it. Entering it again seals it "
    + "afresh; no mail is affected.",
  credForeignValue: "Server changed",
  credForeignWhy:
    "The stored password was set up for a different mail server than this install is now using, "
    + "so it has not been sent to the server it is set to. Open the mailbox settings, confirm the "
    + "server you want and enter its password; no mail is affected.",
  credUnknownValue: "Unknown",
  credUnknownWhy:
    "The mail engine did not say, which happens when it is newer than this window. Nothing is "
    + "wrong.",
  engineLabel: "Mail engine",
  engineWhyStarting:
    "The process that opens your mailbox is coming up. Nothing is being synced until it does.",
  engineWhyStopped:
    "The process that opens your mailbox is not running, so nothing is being synced.",
  engineWhyFailed: "The process that opens your mailbox stopped and did not come back.",
  engineWhyNoKey: (machine: string) =>
    `This ${machine}'s keystore would not answer, so the stored password cannot be opened.`,
  engineWhyUnknown:
    "The mail engine did not say what it is doing, which happens when it is newer than this "
    + "window.",
  engineRunning: "Running",
  engineStarting: "Starting…",
  engineRestarting: "Restarting…",
  engineStopped: "Stopped",
  engineFailed: "Stopped and did not come back",
  /* THE MACHINE'S WORD, WHERE IT USED TO SAY "computer" REGARDLESS. The sentence one row above
     already resolved it; this one did not, so a Windows install read "This computer's keystore"
     beside "This PC's keystore would not answer, so …". One fact, one word. */
  engineNoKey: (machine: string) => `This ${machine}'s keystore would not answer`,
  engineNotConfigured: "No mailbox chosen",
  engineUnknown: "Not in this build",
  installChangingHead: "Changing this install",
  installSignInAgain: "Sign in again",
  installSignInAgainWhy:
    "Your hosted session has gone. Signing in happens in the mail engine on this machine.",
  installSwitch: "Switch mailbox",
  installSwitchWhy: (machine: string) =>
    `Open a different mail server, or move between this ${machine} and your hosted account. The `
    + "copy of your mail from this one is frozen where it is rather than deleted, so coming back "
    + "does not cost a full re-sync.",
  installSwitchAction: "Switch…",
  installSignOutConfirm: "Sign out of this mailbox?",
  installSignOutConfirmWhy: (machine: string) =>
    `The copy of your mail already on this ${machine} stays where it is. What is cleared is the `
    + "login — the stored password, or the session for your hosted account — and which door this "
    + "install came in by. Nothing is removed from your mail server.",
  installSigningOut: "Signing out…",
  installSignOutWhy: (machine: string) =>
    `Clears the login and forgets which mailbox this is. Your mail stays on this ${machine} and `
    + "on your server.",
  installPasswordNote:
    "Your password never passes through the app's window or its settings file: it goes straight "
    + "to the mail engine, which seals it under a key held in this computer's keychain.",

  /* ── SETTINGS → GENERAL: the mailto row, and the one-time ask over the mail ──────────────── */
  mailtoLabel: "Default mail app",
  mailtoIsDefaultWhy: "Email links on this computer open a new message in ohmail.",
  mailtoWhy: "Which app opens email links (mailto) on this computer.",
  mailtoAsking: "Asking…",
  mailtoMakeDefault: "Make default",
  mailtoAskingSystem: "Asking the system…",
  mailtoAskTitle: "Open email links with ohmail?",
  mailtoAskBody:
    "Clicking an email address anywhere on this computer would start a new message here. You can "
    + "change this later in Settings.",
  mailtoNotNow: "Not now",
  mailtoDone: "Done",
  mailtoAfterDialog: "macOS is applying the change — confirm its dialog if one appears.",
  mailtoAfterSettings: "Windows Settings is open — choose ohmail under Default apps.",
  mailtoAfterSet: "Mail links on this computer open in ohmail now.",
  mailtoAfterPending: "The change was sent to your desktop, and it has not taken effect yet.",
  mailtoAfterSent: "The request was sent.",
  mailtoStateOther: "Another app",
  mailtoStateUnknown: "Not known",
  mailtoStateChecking: "Checking…",

  /* ── THE GATE, THE BOOT AND THE THINGS THAT GO WRONG ─────────────────────────────────────── */
  gateCannotOpen: "ohmail cannot open your mailbox",
  gateFoot:
    "Your mail is untouched. It is on your own server, or in your hosted account, and this app "
    + "has not changed either.",
  gateTryAgain: "Try again",
  gateSessionGone:
    "You were signed out of your hosted account, so this install stopped receiving new mail. "
    + "What was already here is kept; sign in again to reconnect.",
  gateOpening: "Opening…",
  bootCreatingStore: "Setting up your local mail store…",
  bootOpeningStore: "Opening your local mail store…",
  bootReplayingWal: "Replaying recent changes…",
  bootMigrating: "Updating your local mail store…",
  bootCompacting: "Compacting your local mail store — one-time maintenance…",
  errorUnknown: "Something went wrong and said nothing about what.",
  errorRefused: (status: string) => `The request was refused (${status}).`,
  /* The OS notification's body. ICU plural, because German's plural rule is English's here and
     the one-vs-many split is the whole of the sentence. */
  notifyNewMail: (count: number) =>
    count === 1 ? "One new message for you." : `${count} new messages for you.`,
};

/**
 * The live view of the `desktopDoor` namespace. Read it, never the constant above: every member
 * is a getter (or a formatter) over whatever catalogue the host has set, so the same object
 * answers English before a provider exists and German after one does.
 */
export const DOOR_COPY: typeof EN = liveCopy("desktopDoor", EN, {
  doorLocalName: ["machine"],
  localLead: ["machine"],
  serverSignInLead: ["machine"],
  serverReached: ["server", "address"],
  cloudLeadSignIn: ["machine"],
  noBrowser: ["machine"],
  mailboxWhyReadsNamed: ["name"],
  credReadyWhy: ["machine"],
  credAbsentWhy: ["machine"],
  engineWhyNoKey: ["machine"],
  engineNoKey: ["machine"],
  installSwitchWhy: ["machine"],
  installSignOutConfirmWhy: ["machine"],
  installSignOutWhy: ["machine"],
  errorRefused: ["status"],
  notifyNewMail: ["count"],
});

/**
 * THE WORD FOR THE MACHINE THIS BUILD RUNS ON, in the reader's language.
 *
 * `machineWordOf` (in `platform.ts`) answers the English word and is the fact; this maps that
 * fact onto a catalogue key. Kept here rather than there because `platform.ts` is a pure
 * statement about the build with no catalogue in it, and a test drives every platform through it
 * from one machine.
 */
export function machineWord(): string {
  switch (MACHINE_WORD) {
    case "Mac": return DOOR_COPY.machineMac;
    case "PC": return DOOR_COPY.machinePc;
    default: return DOOR_COPY.machineComputer;
  }
}
