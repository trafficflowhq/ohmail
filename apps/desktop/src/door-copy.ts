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
  /* "Nothing is sent anywhere." IS BYTE-IDENTICAL AND STAYS THAT WAY — `desktop-door-chooser`
     pins it against the fact that makes it true (`connect-src 'none'`). The third sentence is
     new and is also a fact about the code rather than a plan: `hostDoorFor` offers the Devices
     pane on this door and nowhere else, so a person choosing it can indeed let their other
     machines in later. It is said HERE because the door beneath it now offers the other side of
     the same arrangement, and somebody has to be able to tell which end they are standing at. */
  doorLocalSay:
    "Your own IMAP mailbox, organized right here. Nothing is sent anywhere. Other devices of "
    + "yours can use it later, under Settings → Devices.",
  /* ── DOOR TWO: ANOTHER COMPUTER OF THE PERSON'S OWN ──────────────────────────────────────
     THE PRODUCT NEVER SAYS "HOST" TO A PERSON, and this is where that rule is easiest to break.
     The other machine is "another computer", and inside a sentence it is "that computer" or the
     name this window derives from the address. The host's own pane already speaks that way
     ("Turn this computer into your own mail server") and so does the phone's door ("Your own
     computer"); a fourth vocabulary for the same machine, on the screen where somebody first
     meets it, would be the product explaining its own internals.

     The second sentence is the offline rule stated before anybody commits to it, in the person's
     terms rather than the protocol's: reads come from the copy, every write is refused. It is the
     one thing about this door that is not obvious from the tile above it. */
  doorHostName: "Another computer",
  doorHostSay: (machine: string) =>
    `ohmail on another computer of yours organizes; this ${machine} works through it. While that `
    + "computer is off, this one shows its copy and can change nothing.",
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

  /* ── THE HOST-JOIN CARD: paste the link, see what answered, then pair ────────────────────
     Two phases in one card, the self-hosted door's shape and for its reason: everything that can
     go wrong with a link goes wrong before anybody has committed to anything, and each failure
     becomes a sentence about the LINK rather than about a pairing that did not take.

     "Only the desktop app gives one out; the phone app cannot" is said in the lead rather than on
     the tile, because this is the moment somebody goes looking for the link — and looking on the
     wrong device is the mistake the sentence exists to prevent. */
  hostAskLead:
    "Paste the pairing link from ohmail on that computer — Settings → Devices → Add a device. "
    + "Only the desktop app gives one out; the phone app cannot.",
  hostLink: "Pairing link",
  /* A URL SHAPE, so it is deliberately identical in both catalogues — `serverOriginPlaceholder`
     is the precedent and the reason is the same: it is not a sentence, and translating the
     example would make it stop matching what the other computer actually hands out. It is a
     key rather than a literal because the copy census reads every rendered string, and a
     placeholder is rendered. */
  hostLinkPlaceholder: "https://…/pair#…",
  hostLinkHint: "It works once and expires five minutes after it was made.",
  hostCheck: "Check the link",
  hostChecking: "Reaching that computer…",
  hostReached: (host: string) => `Reached ${host}.`,
  /* SPLIT AROUND THE KEY, which is a value and not a word — it is rendered mono, in its own
     element, and must never wrap. Two keys rather than one placeholder for `serverCaHint`'s
     reason: a placeholder would render the characters as ordinary prose. */
  hostReachedLanBefore: "Over your network. Its key:",
  hostReachedLanAfter: "— the same characters as under Settings → Devices there.",
  hostReachedTs: (machine: string) =>
    `Over your Tailscale, with a certificate this ${machine} could verify.`,
  hostPairLead: (machine: string) =>
    `Pairing adds this ${machine} to that computer's Devices list, where it can be removed at any `
    + "time. Your mail then comes from that computer and a copy is kept here.",
  hostPair: "Pair",
  hostPairing: "Pairing…",
  hostLinkMissing: "Paste the pairing link first.",
  hostLinkShape:
    "That is not a pairing link. It looks like https://…/pair#… and comes from Settings → Devices "
    + "on that computer.",
  /* ── THE REFUSALS, ONE SENTENCE PER `kind` ───────────────────────────────────────────────
     The engine names WHAT it refused and this names what to do about it — the `guideKey`
     arrangement the Devices pane already uses. An engine sentence is English for ever (its prose
     is literals in another process), and a German install reading a German card should not drop
     into English at the one moment something went wrong. A kind this build has never heard of
     still gets the engine's own words rather than silence.

     Three of these are the phone's, ported with "phone" replaced by this machine's word. They are
     the same three refusals because they are refusals about the same ceremony, and two spellings
     of "that computer's key has changed" is how two surfaces come to disagree about what somebody
     should do next. */
  hostRefuseCleartext:
    "That link is a plain, unencrypted address, and ohmail will not send your mail over one. A "
    + "computer running ohmail gives out a secure link — take it from Settings → Devices there.",
  hostRefuseNoPin:
    "That link does not carry that computer's key, so ohmail cannot tell its connection apart "
    + "from anything else on your network. Make a new link from its Settings → Devices.",
  hostRefusePinChanged:
    "That computer's key has changed since this link was made, so ohmail stopped rather than "
    + "trusting it. If ohmail was reinstalled there or restored from a backup, make a new link "
    + "from its Settings → Devices. If not, something on your network is answering for it.",
  hostRefuseNotOhmail: (host: string) =>
    `Something answered at ${host}, but it is not ohmail. Check the link came from Settings → `
    + "Devices on that computer.",
  /* A DESKTOP RUNNING OHMAIL THAT IS NOT SHARING. The remedy is a switch on the OTHER machine,
     which is why this sentence names the pane rather than suggesting a different link. */
  hostRefuseNotServing: (host: string) =>
    `ohmail is running on ${host}, and it has not been set up to let your other devices use it. `
    + "Turn that on there, under Settings → Devices, and make a new link.",
  hostRefuseManaged:
    "That link is from ohmail Cloud, not from a computer of yours. Go back and choose “ohmail "
    + "Cloud”.",
  hostRefuseServer: (host: string) =>
    `${host} is a server you run, not a computer sharing its mail. Go back and choose “Your own `
    + "server”.",
  /* ── THE HOST WAS REINSTALLED AT THE SAME ADDRESS ────────────────────────────────────────
     A different account behind a familiar name. Neither comparison the engine already makes can
     see it — the address did not change and neither did the server — so without a way out this
     refusal repeats for ever with nothing to press.

     THE SENTENCE NAMES THE COST BEFORE THE VERB IS OFFERED, and it names both halves: the mail
     held here for the other account is discarded, and a FRESH code is needed because the one just
     used has already been spent at that computer. Leaving the second half out would send somebody
     to press Start over with a code that cannot work, and the failure would look like the refusal
     they were already stuck on. */
  hostRefuseAccountMismatch: (host: string) =>
    `This computer holds mail from a different account on ${host} — it looks like ohmail was `
    + `reinstalled there. Starting over discards the mail held here for that other account and `
    + `reads ${host}'s mailbox fresh. Your mail on the server is not touched. You will need a new `
    + "pairing link, because the one you just used has been spent.",
  /* ── A PAIRING ATTEMPTED WHILE AN EARLIER START-OVER IS STILL PENDING ────────────────────
     NOT the success card's sentence, and the difference is the whole of this key. That card says
     "Pairing finished — this computer is now paired with {host}", which on this arm is false in
     both halves: nothing was paired, and the pairing that IS waiting is a different one the
     person asked for earlier.

     "Your pairing link has not been used" is a fact about the engine's ordering rather than a
     reassurance: it refuses this before spending the token, precisely so a restart does not cost
     somebody a single-use code. Saying so is what stops a person going back to the other computer
     for a link they do not need. */
  hostRefuseRestartFirst: (host: string) =>
    `Nothing was paired. This computer is still finishing an earlier start over — quit ohmail and `
    + `open it again, then pair with ${host}. Your pairing link has not been used, so it will `
    + "still work.",
  hostStartOver: "Start over",
  hostStartingOver: "Starting over…",
  hostRefuseSpent:
    "That link has already been used or has expired. Make a new one from Settings → Devices on "
    + "that computer.",
  hostRefuseUnreachable: (host: string) => `Could not reach ${host}.`,
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

  /* ── THE OTHER COMPUTER IS NOT ANSWERING — a STANDING FACT, not a transient ──────────────
     These six sentences travel to the shared shell as strings on a prop rather than as catalogue
     keys, because the line renders in the rail — shared code that the browser also compiles, and
     the browser has no paired desktop and never will. Keeping the words in this window's own
     namespace is what keeps them out of a payload that can never render them.

     WHAT MAY NOT BE CUT FROM `hostFootStaleWhy`: "nothing can be changed until that computer is
     back". The age says how stale the copy is and the link says where to go, but that clause is
     the only thing on screen telling somebody why their next press will be refused. If the line
     ever has to be shorter, the middle clause goes and that one stays.

     AND THERE IS NO RETRY CONTROL, deliberately. The mirror already asks every twenty seconds; a
     button that does what is already happening is a claim about agency nobody has. */
  hostFootStale: (host: string) => `Can't reach ${host}.`,
  hostFootStaleWhy: (when: string, machine: string) =>
    `Last answered ${when}. This ${machine} shows the copy it holds; nothing can be changed until `
    + "that computer is back. If it will not be:",
  hostFootUnknown: (host: string) => `Can't reach ${host} yet.`,
  /* WHICH ONE THING TO CHECK, chosen from the origin's shape (`hostViaOf`). Getting it wrong
     costs one wrong thing to check, which is why it is allowed to be a derivation. */
  hostCheckLan: (machine: string) =>
    `Check that computer is on and that this ${machine} is on the same network.`,
  hostCheckTs: "Check that computer is on and signed in to your Tailscale.",
  hostFootSettings: "Settings → Desktop",
  /* ── SETTINGS → ABOUT ────────────────────────────────────────────────────────────────────── */
  aboutAppLabel: "ohmail for desktop",
  aboutAppWhy: "The build running in this window.",
  aboutPublisher: "Published by",
  aboutPublisherWhy: "The company that writes this app.",
  aboutLicence: "Licence",
  aboutLicenceWhy:
    "Free software. The source of this app is published, and you may build it yourself.",
  aboutInstallHead: "This install",
  aboutOpenedThrough: "Opened through",
  aboutDoorLocalValue: "Your own mail server",
  aboutDoorCloudValue: "An ohmail Cloud account",
  aboutDoorCloudWhy:
    "A hosted account. The organizing happens on our servers and this app keeps a copy.",
  aboutDoorHostValue: "Another computer of yours",
  /* THE LAST SENTENCE IS INVARIANT #5's CONTROL, and it is pinned here rather than merely
     written: a paired install never dials the hosted service — its engine talks to one origin,
     the one on the pairing link. If that ever stopped being true this sentence would be the
     first false thing on the pane, which is why it is stated on the pane rather than in a
     comment. */
  aboutDoorHostWhy: (host: string, machine: string) =>
    `ohmail on ${host} opens your mailbox and organizes it; this ${machine} reads and acts `
    + "through it. Nothing about your mail is sent to us.",
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
  /* THE PAIRED DOOR'S OWN ROW. `mailboxWhyOrganizes` would be the answer here today and it is
     false: the rows this install mirrors are the HOST's organizer rows, so the reader predicate
     sees nothing to object to and the pane claims this machine organizes a mailbox it only
     reads. Naming the computer is what makes the sentence checkable by the person reading it. */
  mailboxWhyViaHost: (machine: string, host: string) =>
    `The mailbox this ${machine} reads through ${host}, which organizes it.`,

  /* ── SETTINGS → DESKTOP ──────────────────────────────────────────────────────────────────── */
  paneLabel: "Desktop",
  installConnectedThrough: "Connected through",
  doorCloudWhy:
    "A hosted ohmail account. The organizing happens on our servers and this app keeps a copy.",
  doorLocalWhy:
    "Your own mail server, opened by this computer. Nothing about your mail is sent to us.",
  /* ── THE PAIRED DOOR'S "CONNECTED THROUGH" ROW ──────────────────────────────────────────
     The origin appears HERE and nowhere else on screen. The rail names the computer, which is
     what somebody is looking at; this is where they go to tell two machines apart, and two
     laptops with the same name on two tailnets read alike everywhere else. */
  doorHostWhyLan: (host: string, machine: string) =>
    `ohmail on ${host} organizes; this ${machine} reads and acts through it, over your network.`,
  doorHostWhyTs: (host: string, machine: string, origin: string) =>
    `ohmail on ${host} organizes; this ${machine} reads and acts through it, over your Tailscale `
    + `(${origin}).`,
  /* ── AND ITS CREDENTIAL ROW ──────────────────────────────────────────────────────────────
     "Account session · Signed in" is the hosted door's row and says the wrong thing twice here:
     there is no account, and what would end this is somebody pressing Remove on the OTHER
     computer. The row names the thing that can actually be taken away, and where. */
  credHostLabel: "Pairing",
  credHostLiveValue: "Paired",
  credHostLiveWhy: (machine: string, host: string) =>
    `This ${machine} is on ${host}'s Devices list. Removing it there ends the pairing.`,
  credHostOutValue: "Not paired",
  credHostOutWhy: (host: string, machine: string) =>
    `The pairing with ${host} has ended. Pair again below, or set this ${machine} up on its own.`,
  credHostCheckingWhy: "The mail engine has not answered about the pairing yet.",
  /* ── THE CONNECTION ROW — PERMANENT, IN EVERY STATE ──────────────────────────────────────
     Including `current`. A row that appears only when something is wrong is a row nobody knows
     to look for on the day it is missing, and this one answers a question ("is the other machine
     reachable?") that a person asks BEFORE anything has gone wrong as often as after. */
  connLabel: "Connection",
  connCurrentValue: "Reachable",
  connCurrentWhy: (when: string) => `Last answered ${when}.`,
  connStaleValue: "Unreachable",
  connStaleWhy: (when: string, machine: string) =>
    `Last answered ${when}. This ${machine} shows the copy it holds; nothing can be changed until `
    + "that computer is back.",
  connUnknownValue: "Not reached yet",
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
  /* ── PAIR AGAIN, offered only when the pairing has ended ────────────────────────────────
     "The copy here is kept" is a claim about `enforceMirrorOwner`: a redeem against the SAME
     account over the running engine keeps the mirror, and only a door CHANGE discards it. If the
     re-pair ever went through a reconfigure this sentence becomes false and goes with it. */
  installPairAgain: "Pair again",
  installPairAgainWhy: (host: string, machine: string) =>
    `The pairing with ${host} has ended. A new link from its Settings → Devices pairs this `
    + `${machine} again; the copy here is kept.`,
  /* ── SETTING THIS MACHINE UP ON ITS OWN ──────────────────────────────────────────────────
     The description LEADS with the condition — "If {host} will not come back." — so that a person
     reading the pane in the ordinary case does not read the row as a recommendation. It is on the
     pane in every connection state, because leaving a host is a thing somebody may do on purpose
     and a control that appears only during a failure is one nobody can plan with.

     "The copy from {host} is discarded and read again from the server" is the switch's real
     behaviour, not a softer version of it: `enforceMirrorOwner` discards a mirror whose owner
     changed, and the door change here is exactly that. Saying "frozen" would be the hosted
     door's sentence borrowed for a path that does not freeze anything. */
  takeoverLabel: (machine: string) => `Set this ${machine} up on its own`,
  takeoverAction: "Set up on its own…",
  takeoverWhy: (host: string, machine: string) =>
    `If ${host} will not come back. This ${machine} then opens your mail server itself and takes `
    + `over the organizing. The copy from ${host} is discarded and read again from the server; the `
    + `mailboxes ${host} held are listed first.`,
  takeoverLead: (machine: string, host: string) =>
    `This ${machine} will open your mail server itself and organize it, as ${host} did. The copy `
    + `from ${host} is discarded and read again from the server. Nothing on the server changes `
    + "until you agree to organize, one mailbox at a time.",
  takeoverRoster: (host: string) => `Mailboxes ${host} held`,
  /* "THE SERVERS ARE FILLED IN" WAS HERE AND IT WAS FALSE. The roster is read from the mirrored
     `GET /mailboxes` rows, and that answer carries an address and no IMAP or SMTP host at all —
     so nothing could have been pre-filled and the sentence promised a convenience the next screen
     would not deliver. What the roster genuinely gives somebody is the LIST: which mailboxes the
     other computer was organizing, and what they are called. That is what it now says. */
  takeoverRest: (count: number) =>
    count === 1
      ? "The other mailbox: add it afterwards under Settings → Mailboxes."
      : `The other ${count} mailboxes: add them afterwards under Settings → Mailboxes.`,
  /* THE ROSTER COULD NOT BE READ — never an empty list presented as "none". A takeover started
     from the revoked notice runs outside the mail client, where the shared facts hook does not
     exist, and a read that fails there must not be spelled the same as a host that held nothing.
     The `MailboxProbe` null-versus-empty rule, said on screen. */
  takeoverRosterUnknown: (host: string) =>
    `Could not read which mailboxes ${host} held; enter the server by hand.`,
  installSwitch: "Switch mailbox",
  installSwitchWhy: (machine: string) =>
    `Open a different mail server, or move between this ${machine} and your hosted account. The `
    + "copy of your mail from this one is frozen where it is rather than deleted, so coming back "
    + "does not cost a full re-sync.",
  installSwitchAction: "Switch…",
  /* ── THE PAIRED DOOR'S THREE VARIANTS OF ROWS THAT ALREADY EXIST ─────────────────────────
     Each differs from the sentence above it in the one way that matters: the hosted wording says
     "the login — the stored password, or the session for your hosted account", and a paired
     install has neither. What it has is a pairing with a named computer, and what a person needs
     to know is that ending it takes nothing off either machine's disk. */
  installSwitchWhyHost: (host: string, machine: string) =>
    `Open a different door: your own mail server, another computer, or a hosted account. The copy `
    + `from ${host} on this ${machine} is discarded; your mailbox itself is untouched.`,
  installSignOutWhyHost: (host: string, machine: string) =>
    `Ends the pairing with ${host} and forgets which mailbox this is. Your mail stays on this `
    + `${machine} and on your server.`,
  installSignOutConfirmWhyHost: (machine: string, host: string) =>
    `The copy of your mail already on this ${machine} stays where it is. What is cleared is the `
    + `pairing with ${host} and which door this install came in by. Nothing is removed from your `
    + "mail server.",
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
  /* ── NO LONGER PAIRED — its own sentence and its own two actions ─────────────────────────
     `gateSessionGone` says "You were signed out of your hosted account", which on this door names
     an account that has never existed. And one action is not enough here: a person whose pairing
     was revoked either wants it back or wants to stop depending on the other machine, and the
     second of those is the whole point of the product. `gateFoot` below still holds — the mail is
     on the person's own server either way. */
  gateUnpaired: (machine: string, host: string) =>
    `This ${machine} is no longer paired with ${host}. Pair again from its Settings → Devices, or `
    + `set this ${machine} up on its own. The copy of your mail here is kept.`,
  /* ── A PAIRING THAT WORKED AND NEEDS THE APP REOPENED ────────────────────────────────────
     The card for the one state where nothing is wrong and nothing can be done from inside the
     window. The old mailbox's copy is thrown away on the next launch — the engine cannot do it
     while its own database is open — so until then this install holds a session it may not use.

     IT LEADS WITH THE SUCCESS, because the two states around it lead with failure and a person
     arriving here has just pressed something destructive on purpose. Then the one action, in
     plain words: quit ohmail and open it again. There is deliberately no Relaunch button — this
     window has no command that restarts the app, and a button that did nothing would be worse
     than a sentence that is true. */
  gateRestartTitle: "Pairing finished",
  gateRestart: (host: string) =>
    `This computer is now paired with ${host}. Quit ohmail and open it again to finish `
    + "connecting — the copy of the mail that was here before is replaced on the next start.",
  gatePairAgain: "Pair again",
  gateOwn: "Set up on its own",
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
  doorHostSay: ["machine"],
  hostReached: ["host"],
  hostReachedTs: ["machine"],
  hostPairLead: ["machine"],
  hostRefuseNotOhmail: ["host"],
  hostRefuseNotServing: ["host"],
  hostRefuseAccountMismatch: ["host"],
  hostRefuseRestartFirst: ["host"],
  hostRefuseServer: ["host"],
  hostRefuseUnreachable: ["host"],
  hostFootStale: ["host"],
  /* TWO VALUES, and the ORDER here is the argument order of the formatter above, never the
     order the placeholders happen to appear in the German sentence — German puts `machine`
     first in several of these. `liveCopy` maps positional arguments onto named ICU values, so a
     translation may reorder the words freely and this list is what keeps the values attached to
     the right holes. */
  hostFootStaleWhy: ["when", "machine"],
  hostFootUnknown: ["host"],
  hostCheckLan: ["machine"],
  mailboxWhyViaHost: ["machine", "host"],
  doorHostWhyLan: ["host", "machine"],
  doorHostWhyTs: ["host", "machine", "origin"],
  credHostLiveWhy: ["machine", "host"],
  credHostOutWhy: ["host", "machine"],
  connCurrentWhy: ["when"],
  connStaleWhy: ["when", "machine"],
  installPairAgainWhy: ["host", "machine"],
  takeoverLabel: ["machine"],
  takeoverWhy: ["host", "machine"],
  takeoverLead: ["machine", "host"],
  takeoverRoster: ["host"],
  takeoverRest: ["count"],
  takeoverRosterUnknown: ["host"],
  installSwitchWhyHost: ["host", "machine"],
  installSignOutWhyHost: ["host", "machine"],
  installSignOutConfirmWhyHost: ["machine", "host"],
  gateRestart: ["host"],
  gateUnpaired: ["machine", "host"],
  aboutDoorHostWhy: ["host", "machine"],
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
