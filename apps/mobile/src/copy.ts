/**
 * Every string the chrome says, in one place — the phone's copy deck.
 *
 * Blanc's rule is **factual microcopy only**: no slogans, no praise, no
 * invented numbers. Each line is either the canonical product wording (the
 * desktop client established the copy deck) or a literal statement of what the
 * app just did. Keeping them together makes that auditable, and keeps the
 * privacy grep to one file's worth of prose.
 *
 * Phone-specific lines are marked. They exist because a thumb does things a
 * cursor did not — nothing here softens or oversells the desktop wording.
 */

import { isPinFailure, PIN_CHANGED_SENTENCE } from "./net/host-pinning";
export const Copy = {
  /* --------------------------------------------------------------- welcome */

  welcomeTitle: "Which mailbox is this?",
  welcomeLead:
    "This app is the phone client for an ohmail server — ours, one you run, or the ohmail app on your own computer. It shows nothing until it is connected: your mail stays on your server, and this phone mirrors it.",
  welcomeHow:
    "Whichever you pick, the phone joins by scanning a code that server shows you. No password is ever typed here.",
  /*
   * NO `welcomeScan` / `welcomeOther` ANY MORE. They were the two buttons this screen led with —
   * "Scan the pairing QR" and "Other ways to connect" — and the second one is what the change is
   * about: it filed two of the product's three doors under "other". The scan verb still exists
   * where a scan is genuinely the next step (`scanTitle`, `stepScan`).
   */

  /* ------------------------------------------------------------------ doors */

  /*
   * ═══ THE THREE DOORS, IN THE PHONE'S IDIOM ═══════════════════════════════════════════════
   *
   * The desktop chooser asks one question with three answers — this computer, a server you run,
   * or ours — and each names a DIFFERENT MACHINE as the thing that does the organizing. The
   * phone asks the same question and its answers are NOT the same three, because a phone cannot
   * be the organizer: there is no IMAP client here, no engine dialling a mail server, no
   * "on this phone" door to offer. Every door below names somebody else's machine, and the
   * phone's own half of each sentence is the same — it keeps a copy.
   *
   * ── THE ORDER IS DIFFERENT FROM THE DESKTOP'S, AND DELIBERATELY SO ──────────────────────
   *
   * The desktop orders by who holds it, nearest first, and puts the hosted service last: the
   * first two are doors a person can verify for themselves. That argument does not transfer.
   * On a phone the nearest door — a computer on the same network — is the one with the most
   * conditions on it (a code that carries a key, a platform half that exists on Android and
   * not yet on iOS), and leading with it would open the chooser on the answer most likely to
   * end in a refusal. So the phone orders by how few conditions the door has, and the LAN door
   * comes last with its conditions written on it.
   *
   * ── EVERY SENTENCE IS A CLAIM, AND THREE OF THEM WERE CHECKED AGAINST A LIVE SERVER ────
   *
   *  · **The Cloud door pairs, TODAY.** `GET /hello` on the hosted service (`MANAGED_ORIGIN`,
   *    named once in `net/pairing.ts`) answers `features.pairing: true`, and `POST /pair/redeem`
   *    there answers `pairing_invalid` to a junk token — the ceremony is mounted, and the code
   *    comes from the Devices pane the web client shows when `/hello` announces it
   *    (`CloudShell.tsx` injects `<DevicesSection/>` on exactly that condition). Measured
   *    2026-09-01. The picker still negotiates rather than trusting this deck: if that server
   *    ever answers `pairing: false`, the door says what the server said instead of what this
   *    comment did.
   *  · **The self-hosted door needs a certificate the PHONE already trusts**, and that is a
   *    different sentence from the desktop's. See {@link doorSelfCert}.
   *  · **The desktop door is Android-only for a computer on your own network.** `canPin()` is
   *    false wherever the pinning module's native half is absent, which today is iOS, and the
   *    seam REFUSES rather than connecting unpinned. The Tailscale address works on both.
   */
  doorsLead: "One question, three answers — which machine does the organizing?",

  doorCloud: "ohmail Cloud",
  doorCloudSay:
    "Our hosted service does the organizing; this phone keeps a copy. Sign in on the web, open Settings → Devices, and scan the code it shows.",

  doorOwnServer: "Your own server",
  doorOwnServerSay:
    "A server you run does the organizing; this phone keeps a copy. Give its address and this app will check what is there.",

  doorDesktop: "Your own computer",
  doorDesktopSay:
    "The ohmail app on your computer does the organizing; this phone keeps a copy. Open Settings → Devices there and scan its code.",
  /**
   * THE DESKTOP DOOR'S ONE CONDITION, SHOWN ONLY WHERE IT APPLIES.
   *
   * The tile above is true on both platforms — a code from that pane does pair a phone — and review
   * showed the tile alone still leads to a dead end: a computer's SAME-NETWORK code needs the
   * pinning half, `canPin()` is false where that half is absent, and the seam refuses. So an iPhone
   * user could follow the tile exactly and be stopped at the scan.
   *
   * The original argument for saying nothing was that a door tile is the wrong place for a
   * conditional. That still holds for the TILE, and this is not the tile: it is a line rendered only
   * when `canPin()` is false, which is the one platform where it is true. Nobody reads a condition
   * that does not apply to them, and nobody walks into the refusal either.
   *
   * It names the remedy that works rather than the mechanism that does not — the Tailscale address
   * is on the same Devices pane, so the instruction is one screen, not two. The same sentence the
   * seam gives on refusal (`admitOrigin`), moved to before the scan instead of after it.
   */
  doorDesktopNoPin:
    "On this phone, use the Tailscale address that pane also shows — ohmail cannot yet verify a computer reached over your own network here.",

  /**
   * THE TRAVEL SENTENCE, IN THE ONE FORM THAT IS TRUE FOR A PHONE.
   *
   * The desktop's is *"Your rules and settings live in your own mailbox and travel with you — the
   * mailbox is always the master."* Both halves hold here, and a phone needs a third clause the
   * desktop does not: the desktop MAY be the organizer, so "move between these" is something its
   * own install does. A phone is never the organizer, so what moves is which server it mirrors —
   * and nothing it holds travels, because everything it holds is a copy.
   *
   * The list is the catalogue's own (`leave.note`: screened senders, rules, notification choices,
   * the away reply, tag names), shortened to the three a phone actually shows, and it does NOT say
   * "settings" unqualified — the phone's Look setting is per-device on purpose
   * (`faceScopeDevice`), and triage piles and Resurface timers stay with the install that made
   * them. Claiming them would be claiming the payload does not carry.
   */
  doorsTravel:
    "Move between these anytime. Your screened senders, rules and notification choices live in your own mailbox, so they are the same behind every door — the mailbox is always the master. This phone only ever keeps a copy of it.",

  /* ------------------------------------------------- the self-hosted door */

  doorSelfTitle: "Your own server",
  doorSelfLead:
    "Give the address you open ohmail at in a browser. This app will check that your server is there before anything else.",
  doorSelfAddress: "Your server's address",
  doorSelfAddressHint: "For example ohmail.example.com — nothing after the host.",
  doorSelfGo: "Continue",
  doorSelfChecking: "Checking your server…",
  /**
   * WHAT A PHONE CAN AND CANNOT DO ABOUT AN OPERATOR'S OWN CERTIFICATE AUTHORITY.
   *
   * ── THIS IS NOT THE DESKTOP'S ANSWER, AND SAYING IT WAS WOULD BE THE LIE ───────────────────
   *
   * The desktop tells an operator to drop their root certificate into a file in the app's data
   * folder (`cloud-ca.pem`), because Node verifies against its own compiled-in roots and
   * `NODE_EXTRA_CA_CERTS` is how you add one. There is no equivalent here and the copy must not
   * imply there is.
   *
   * MEASURED, from this app's own build rather than from documentation:
   *
   *  · **Android.** React Native's fetch is OkHttp, which uses the platform trust manager, which
   *    is configured by the app's network security config. This app declares NONE
   *    (`apps/mobile/android/app/src/main/AndroidManifest.xml` carries no
   *    `android:networkSecurityConfig`, and the release merged manifest has none either), so it
   *    gets the platform default for `targetSdkVersion` 36 — which since API 24 trusts SYSTEM
   *    certificate authorities and NOT the ones a person installs themselves. An operator who
   *    installs their own root on the phone therefore changes nothing for this app, and the
   *    handshake still fails. Opting in (`<certificates src="user"/>`) is deliberately NOT done:
   *    it would widen what every connection this app makes will accept, including the hosted
   *    one, to any authority anything on that device ever installed.
   *  · **iOS.** URLSession honours a root the person installed AND enabled under
   *    Settings → General → About → Certificate Trust Settings, so the same stack is reachable
   *    there once that is done. NAMED rather than measured — there is no Mac or iPhone in the
   *    environment this was built in, and the parity rule says to name an iOS half rather than
   *    assert an untested one.
   *
   * So the honest sentence names the two remedies that work on BOTH platforms — a certificate
   * from an authority the phone already trusts, or a Tailscale address, whose MagicDNS name has a
   * real one — and states the platform split rather than hiding it. The word "Tailscale" is
   * already in this app's copy (`admitOrigin`'s iOS refusal), so it introduces no new claim.
   */
  doorSelfCert:
    "Your server needs an https certificate from an authority this phone already trusts. A stack "
    + "on a public name gets one automatically. A stack on a private name like ohmail.test issues "
    + "its own, and whether this phone accepts that depends on the phone: on Android it does not — "
    + "ohmail trusts only the authorities that came with the system, so a root you install yourself "
    + "makes no difference — while on iPhone and iPad a root you install and switch on under "
    + "Settings → General → About → Certificate Trust Settings does count. A public "
    + "name, or a Tailscale address, works on both.",
  /** The address answered as an ohmail server. Named, so "we reached it" is not a guess. */
  doorSelfReached: (origin: string, flavor: string) =>
    `Reached ${origin} — an ohmail server (${flavor}).`,
  /**
   * THE PREFIX, SAID OUT LOUD when the measurement found one.
   *
   * A self-host stack serves its mail API under `/api` and everything else at the root, and this
   * app now measures which. Naming it is not a technical aside: an operator debugging a phone that
   * will not sync needs to know which address it settled on, and a silent derivation is the thing
   * that made the previous failure unreadable.
   */
  doorSelfApiUnder: (base: string) => `Its mail API is at ${base}.`,

  /* --------------------------------------------------- servers & pairing */

  serversTitle: "Servers",
  serversRow: "Connect to a server",
  serversNote:
    "Pair this phone with the computer or server that holds your mail. Pairing is a QR code or a short-lived token — never a password typed here.",
  serversActive: "Connected",
  serversProfiles: "Paired servers",
  serversAdd: "Add a server",
  serversNeedsPair: "Pairing ended — scan a fresh QR to pair again.",
  serversForget: "Forget",
  // CLAIMS ARE CONTRACTS. This sentence used to stop at "removes the pairing", and that was the
  // whole truth: forget closed a database handle and left the mail on the phone for ever. Now it
  // deletes the copied mail as well and reads the database back to check, so the promise is one
  // the code keeps — and `serversForgetFailed` is what gets said on the launch where it cannot.
  serversForgetNote:
    "Forgetting deletes the pairing and the mail this phone had copied. The server's Devices list can revoke it there too.",
  /** A take-back that did not fully land says what remains and what will happen next. */
  serversForgetFailed: (reason: string) => reason,
  serversEmpty: "No pairings yet.",
  /**
   * THE FRESH INSTALL WHOSE PURGE WAS REFUSED — a state with no good outcome, said plainly.
   *
   * The container is new, so these pairings belong to an installation that no longer exists,
   * and the keystore would not give them up. Opening them anyway is the exact no-ceremony
   * reinstall the install-generation marker exists to stop, so the app does not: it refuses,
   * says why, and names the revoke, which is the one remedy that does not depend on this phone.
   */
  /**
   * THE MARKER COULD NOT BE READ. Its own sentence, because the remedy is different: nothing is
   * wrong with the pairings and nothing has been deleted — the app simply cannot tell whether
   * this is the install that stored them, and on iOS the keychain outlives an uninstall, so
   * using them anyway is exactly the reinstall the check exists to stop.
   */
  serversInstallUnknown: (detail: string) =>
    "ohmail could not check whether this is the same installation that stored your sign-ins "
    + `(${detail}), so it has not opened them — and it has not removed them either. Restart the `
    + "app to try again.",
  serversPurgeRefused: (detail: string) =>
    "This phone is still holding sign-ins from an earlier installation of ohmail, and it would "
    + `not let go of them (${detail}). ohmail will not open them. Revoke this device from your `
    + "server's Devices list, then restart the app.",

  /*
   * THE THREE CHOICES ARE THE THREE DOORS NOW — `door*` above, one deck for the first-run screen
   * and the Servers screen alike. The old `choice*` keys said less and said one thing wrong: the
   * managed card's note named the address (`ohmail.app`) where the door names the machine that
   * does the organizing, which is the question the chooser actually asks.
   */

  askAddress: "Server address",
  askAddressHint: "The https address the desktop app shows under Settings \u2192 Devices",
  askGo: "Check this address",
  askChecking: "Asking the server what it is…",
  stepScan: "Scan its QR",
  stepManual: "Enter a pairing token",
  stepPairOffered: (flavor: string) => `This is an ohmail server (${flavor}) and it pairs devices.`,
  /**
   * A MANAGED-FLAVOR SERVER THAT SAYS IT DOES NOT PAIR — and this line used to promise a release.
   *
   * It read *"ohmail.app does not offer device pairing yet — it arrives with a later update"*,
   * which was true when it was written and is not now: measured 2026-09-01, `GET /hello` on the
   * hosted service answers `features.pairing: true` and `POST /pair/redeem` there answers
   * `pairing_invalid` to a junk token, so the picker offers the pair step and this
   * sentence never renders against the live service. A dormant claim is still a claim, and a
   * roadmap promise is the worst kind to leave lying in a copy deck — the descriptor is what
   * decides, so the sentence now reports what the descriptor said and nothing about the future.
   */
  managedDeferred:
    "ohmail.app is not offering device pairing right now — its own descriptor says so. Nothing to do here today.",
  noPairing: "This server does not offer device pairing.",
  notOhmail: "That address answers, but not as an ohmail server.",
  unreachable: (detail: string) => `Could not reach that address. ${detail}`,

  scanTitle: "Scan the pairing QR",
  scanHint: "Point the camera at the QR your computer or server shows.",
  scanBadCode: "Not an ohmail pairing code. The QR is on the Devices screen.",
  scanCameraOff: "Camera access is off, so there is nothing to scan with.",
  scanAllow: "Allow the camera",
  scanManual: "Enter it by hand instead",
  scanAgain: "Scan again",

  /* The Freshness Contract's label (INSTANT-ARCH §6.6): content over a stale mirror says how
     old it is, quietly, until a drain settles. `time` arrives sentence-ready from the world
     layer ("Fri 09:00", the reader's zone). Two forms because "catching up" is an ACTIVITY
     claim: with the last round failed and nothing scheduled (the runner stops; a pull or the
     next foreground drain retries), the age is stated alone — the failure sentence is the
     skeleton's and the Servers screen's, not this line's to repeat. */
  staleAsOf: (time: string) => `As of ${time} · catching up`,
  staleAsOfIdle: (time: string) => `As of ${time}`,

  pairingBusy: "Pairing…",
  pairedOk: "Paired. Syncing your mail.",

  /* --------------------------------------------------------------- connect */

  connectTitle: "Pair by hand",
  connectNote:
    "Type the server address and the pairing token shown beside its QR — or paste the whole pairing link into the token field.",
  connectOrigin: "Server address",
  /**
   * NOT "or plain http on your own network" any more, and that sentence was the app's own copy
   * contradicting its own manifest: a release build permits no cleartext, so the half of the hint
   * that offered it described something the app refuses before opening a socket. A same-network
   * address also needs the key fingerprint that only the scanned code carries, which is why this
   * hint points at the code rather than at the field.
   */
  connectOriginHint: "The https address the desktop app shows under Settings \u2192 Devices. For a computer on your own network, scan its code instead \u2014 the address alone is not enough.",
  connectToken: "Pairing token",
  connectGo: "Pair",
  connectBooting: "Opening the on-device mirror…",
  connectRefusedTitle: "Refused",
  connectSyncing: "Syncing…",
  connectSyncNow: "Sync now",
  connectDisconnect: "Disconnect",
  connectMirrored: (n: number, cursor: string) =>
    `${n} message${n === 1 ? "" : "s"} on this device · cursor ${cursor}`,
  /**
   * ── A FAILED HANDSHAKE IS NOT A FAILED NETWORK, AND THIS LINE USED TO SAY IT WAS ──────────
   *
   * Measured on a real device against a real desktop whose key had been changed: this read
   *
   *   "Sync failed — the mirror keeps what it has. MutationRejectedError: network failure:
   *    Error: fetch failed: javax.net.ssl.SSLHandshakeException:
   *    java.security.cert.CertPathValidatorException: Trust anchor for certification path not
   *    found."
   *
   * The BEHAVIOUR was right — nothing was trusted, nothing was fetched, the mirror was kept —
   * and the sentence was unreadable and, worse, indistinguishable from bad wifi. A person whose
   * desktop key genuinely changed needs to be told that, and a person whose network is being
   * interfered with needs to be told that even more.
   *
   * So a pin failure gets the pin sentence and everything else keeps the detail it always had.
   * `isPinFailure` matches by SHAPE (the wording differs across Android versions), and a missed
   * match degrades to the old line — wrong, but not misleading.
   *
   * ── AND IT ONLY MEANS "THIS COMPUTER'S KEY CHANGED" WHERE THERE IS A KEY TO CHANGE ─────────
   *
   * `PIN_CHANGED_SENTENCE` names a computer somebody paired with and tells them to mint a fresh
   * code from its Devices pane. On a pairing that carries NO pin — the hosted service, or a
   * self-hosted server on a real name — the same handshake shape means something else entirely:
   * the certificate at that address is not one this phone's trust store accepts. Telling a
   * self-hoster their computer's identity changed sends them to a screen that does not exist for
   * them. So the pinned half is gated on the profile actually holding a pin, and the unpinned half
   * gets its own sentence naming the certificate. Both are true statements about what stopped.
   *
   * `pinned` IS REQUIRED, with no default. A default would be a wrong sentence waiting for the
   * next caller who did not know the question was being asked — and the two answers are not
   * degradations of each other, they name different remedies on different screens. A required
   * parameter makes every call site state which pairing it is talking about.
   */
  connectSyncFailed: (detail: string, pinned: boolean) =>
    isPinFailure(detail)
      ? pinned
        ? `Sync stopped. ${PIN_CHANGED_SENTENCE}`
        : "Sync stopped. This phone would not accept the certificate at that address, so it did "
          + "not send anything. The server needs an https certificate from an authority this phone "
          + "already trusts — see the note on the “Your own server” door."
      : `Sync failed — the mirror keeps what it has. ${detail}`,

  /* ----------------------------------------------------------------- ohbox */

  ohbox: "Ohbox",
  groupNew: "New",
  groupSeen: "Earlier",
  ohboxTail: (shown: number) => `All ${shown} accepted message${shown === 1 ? "" : "s"} shown.`,
  ohboxEmptyTitle: "Nothing here yet.",
  ohboxEmptyHint: "Mail from senders you said Yes to lands here as it syncs.",
  doorbell: (n: number) => `${n} new sender${n === 1 ? "" : "s"}`,
  doorbellRest: "waiting",
  doorbellGo: "Screener",

  /* --------------------------------------------------------- reads/receipts */

  reads: "Reads",
  receipts: "Receipts",
  waterline: "Seen up to here",
  readsTail: (shown: number) =>
    `All ${shown} issue${shown === 1 ? "" : "s"} shown. Scrolling past an item marks it seen.`,
  receiptsTail: (shown: number) => `All ${shown} receipt${shown === 1 ? "" : "s"} shown.`,
  readsEmptyTitle: "No issues yet.",
  readsEmptyHint: "Newsletters and long reads you file here arrive as they sync.",
  receiptsEmptyTitle: "No receipts yet.",
  receiptsEmptyHint: "Orders, invoices and tickets you file here arrive as they sync.",
  streamSeenHint: "scrolling past marks seen",

  /* ------------------------------------------------------------- protected */

  protectedPreview: "Verification code ······ (redacted)",
  protectedCodeLabel: "Verification code",
  protectedRedacted: "······",
  protectedLead: "Protected",

  /* -------------------------------------------------------------- screener */

  screener: "Screener",
  segWaiting: "Waiting",
  segScreened: "Screened out",
  segSpam: "Spam",
  aiSuggests: (dest: string, confidence: number) => `${dest} · ${confidence.toFixed(2)}`,
  scopeSender: "this sender",
  scopeDomain: "whole domain",
  decideRule: (target: string) =>
    `Becomes a rule — future mail from ${target} files automatically. The ✓ half also marks this mail read.`,
  /** phone: the ✓ affordance is a toggle in the bar, not a modifier key. */
  decideReadToggle: "& read",
  decideReadOn: "Filing as read — the count will not move.",
  decideReadOff: "Filing unread — it will announce itself.",
  heldCaption: (n: number, firstContact?: string) => {
    const head = `${n} held message${n === 1 ? "" : "s"} — all shown`;
    return firstContact ? `${head} · first contact ${firstContact}` : head;
  },
  screenedNote: (date: string, held: number) =>
    `Screened ${date} · ${held} held, all shown. Allowing releases every one of them to the chosen view.`,
  allowLabel: "Allow — release held mail to",
  notSpamLabel: "Not spam — move all held mail to",
  spamNote:
    "Detection reads structure — sender, headers, link targets. Content is not sent anywhere.",
  waitingEmptyTitle: "Nobody is waiting.",
  waitingEmptyHint: "First-time senders knock here before anything reaches your Ohbox.",
  screenedEmptyTitle: "Nobody is screened out.",
  screenedEmptyHint: "Senders you say No to wait here — held, never deleted.",
  spamEmptyTitle: "No spam held.",
  /**
   * REWORDED with the junk wave (FOLDERS-SPEC.md §16.1/§16.3): the old sentence — "Suspected
   * spam waits here for your eyes, never deleted unseen" — stopped being true when the spam
   * VERDICT started writing the message into the provider's own Junk folder, whose cleanup
   * schedule is the provider's, not ours (the webapp retired its twin, `en.json`'s "nothing
   * is deleted unseen", with the segment itself). What is still true, said plainly: suspects
   * wait here, ohmail deletes nothing ON ITS OWN (the §16.3 claims-sweep scoping), and a
   * confirmed verdict moves the mail to the mail server's Junk — QUALIFIED, because a mailbox
   * with no resolvable native Junk folder keeps the verdict here instead
   * (`junk-filing.ts#physicalDestination`'s stated fallback), and an unconditional sentence
   * would claim a move that did not happen (codex round 1). This phone has no window into the
   * Junk folder — the webapp's Junk segment is a live server read this build does not make —
   * so the sentence names where the mail went rather than promising a view of it.
   */
  spamEmptyHint:
    "Suspected spam waits here for your eyes — ohmail never deletes it on its own. Mail you confirm as spam moves to your mail server's own Junk folder, or stays held here when your mailbox has none.",

  /* ---------------------------------------------------------------- triage */

  triage: "Piles",
  replyLater: "Answer Later",
  setAside: "Parked",
  /** The message ACTION, not the pile: a verb on a button, a noun on the rail. */
  park: "Park",
  resurface: "Resurface",
  pileEmpty: "Nothing here yet.",

  /* --------------------------------------------------------------- folders */

  /*
   * THE FOLDERS GROUP — the webapp rail's own strings (`en.json` rail.folder*), so the
   * feature is named the same on the phone as in the browser. The list renders ONLY while the
   * account's "Use folders" flag is on (FOLDERS-SPEC.md §6/§10 — off is the pre-feature
   * interface, byte for byte). `test/folders-parity.test.ts` holds the equalities.
   */
  folders: "Folders",
  folderEmpty: "No folders on your mail server yet.",
  folderFilter: "Filter folders",
  folderNoMatch: "No folder matches.",
  folderShowAll: (n: number) => `Show all ${n}…`,
  folderShowFewer: "Show fewer",
  folderExpand: (name: string) => `Expand ${name}`,
  folderCollapse: (name: string) => `Collapse ${name}`,
  /**
   * The folder screen's tail and empty state — PHONE-SPECIFIC wording, deliberately not the
   * webapp's `folder.emptyTitle` ("Nothing in this folder"): the webapp earns that sentence
   * with a reach-past that asks the server for mail beyond the device's mirror, and this
   * build has no reach-past on any screen. A phone that has not fetched a folder's older
   * mail may not claim the folder is empty — it says what it holds instead.
   */
  folderTail: (n: number) => `${n} message${n === 1 ? "" : "s"} from this folder on this phone.`,
  folderEmptyTitle: "No mail from this folder is on this phone.",
  folderEmptyHint:
    "This phone mirrors your server's recent mail. The folder itself lives on your mail server and may hold older mail there.",

  /*
   * THE FOLDER VERBS — stage 2 (FOLDERS-SPEC.md §18), the webapp rail's own strings
   * (`en.json` rail.folder*), so create / rename / delete are named the same on the phone as
   * in the browser; `test/folders-parity.test.ts` holds the equalities, ICU shapes resolved.
   * The phone's copy deck is English like the rest of this file — the webapp catalogue
   * carries the same keys in German for the surfaces that localize.
   */
  folderNew: "New folder",
  folderNewSub: "New subfolder",
  folderRename: "Rename",
  folderDelete: "Delete…",
  folderMenuAria: (name: string) => `Folder menu for ${name}`,
  folderNamePlaceholder: "Folder name",
  folderRenamePlaceholder: "New name",
  folderCreating: "Being created on your mail server…",
  folderRenaming: (name: string) => `Being renamed to ${name} on your mail server…`,
  folderDeleting: "Being deleted — its messages move to your server’s Trash first…",
  folderDismiss: "OK",
  folderErrRefused: "Your mail server refused this change.",
  folderErrBadName: "Your mail server uses one of these characters to separate folders — pick a different name.",
  folderErrExists: "A folder with that name already exists.",
  folderErrGone: "That folder no longer exists on your mail server.",
  folderErrNoTrash: "This mailbox has no Trash folder, and ohmail never erases mail — delete the folder in your own mail client instead.",
  folderNameEmpty: "Give the folder a name.",
  folderNameSpaces: "The name can’t begin or end with a space.",
  folderNameChars: "The name can’t contain % or *.",
  folderNameLong: "That name is too long.",
  folderNameReserved: "That name is reserved by your mailbox.",
  folderNameTaken: "A folder with that name already exists.",
  folderDeleteCounting: "Counting what moves…",
  /** The ICU sentence (`rail.folderDeleteConfirm`), resolved — the parity test compares both. */
  folderDeleteConfirm: (messages: number, folders: number) => {
    const scope = folders === 1 ? "this folder" : `these ${folders} folders`;
    const seen = messages === 0 ? "no messages" : messages === 1 ? "the 1 message" : `the ${messages} messages`;
    const tail = folders === 1 ? "the folder is" : "the folders are";
    return `Everything in ${scope} moves to the Trash on your mail server — ${seen} ohmail has seen, and anything it has not; ${tail} then removed.`;
  },
  folderDeleteConfirmUncounted: "Everything in it moves to the Trash on your mail server; the folder is then removed.",
  folderDeleteGo: "Delete folder",
  folderDeleteCancel: "Cancel",
  folderVerbFailed: "That folder change didn’t reach your mailbox — nothing was changed.",

  /** Settings → Folders — the webapp catalogue's own strings (`settings.folders.*`). */
  foldersUseTitle: "Use folders",
  foldersUseOn:
    "Your mail server's own folders show in the menu, each opening as its own list with unread counts.",
  foldersUseOff: "Your folders stay hidden. ohmail still reads them for search and history.",
  foldersMicrocopy:
    "Turning this on only shows what already exists — nothing is moved. Turning it off hides the folders again without touching your mail.",
  foldersFailed: "Couldn't save that — try again.",

  /* ---------------------------------------------------------------- search */

  search: "Search",
  /** More's one honest sentence about it — there is no search screen to route to yet. */
  searchLater: "Arrives in a later update",

  /* -------------------------------------------------------------- settings */

  settings: "Settings",
  theme: "Appearance",
  themeNote: "Follows the system unless set.",

  /**
   * Settings → Look — the FACE and its scope (OHMARCHY-PLAN.md §3a). Every line is the webapp
   * catalogue's own (`settings.face*` in `apps/webapp/messages/en.json`), held byte-equal by
   * `ohmarchy-face.test.ts` for the reason the folders copy is: one product, one sentence per
   * decision, and a person who read it on a laptop must not meet a paraphrase on their phone.
   *
   * `faceScopeDevice` is the honest one on a phone: the scope line says which state this device
   * is in, and a pin — including one this session made and has not sent to the account — means
   * this device only.
   */
  face: "Look",
  faceHint: "ohmarchy — a tiling, keyboard-first look inspired by Omarchy.",
  facePaper: "paper",
  faceOhmarchy: "ohmarchy",
  faceScopeAll: "Applies on all your devices.",
  faceScopeDevice: "Applies on this device only.",
  faceApplyAll: "Apply on all devices",
  faceFailed: "Couldn't save that — try again.",
  about: "About this build",
  /** The About block — states what is real on this build, no more. */
  aboutLive: (origin: string) =>
    `Paired with ${origin}. Mail syncs into an on-device mirror; reading, triage, reply, forward and tags are live. Compose from scratch and search arrive with later updates.`,
  /**
   * WHAT THE ON-DEVICE COPY DOES AND DOES NOT LEAVE. Three true sentences, and the third is
   * here because the product cannot yet make it false.
   *
   * The uninstall sentence is careful for a reason. On iOS the Keychain item survives deleting
   * the app and no code of ours runs at that moment, so the credential is genuinely still there
   * until the NEXT launch's install-generation purge discards it — "deleting the app removes
   * both" was a claim about an instant at which nothing we wrote can act. The remedy that works
   * immediately is the server-side revoke, so the sentence names it.
   *
   * The pairing credential is kept out of every backup (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), and
   * on Android this app's own backup rules now keep the mirror out too. On iOS the mirror lives
   * in the app's Documents directory, which the platform's own cloud and computer backups include
   * unless the file is marked excluded — and marking it needs native code this build does not
   * carry. (The brand name for that backup service is deliberately not written here: the privacy
   * census bans real brand strings in this app's source, and the sentence is clear without it.)
   * Saying so is the whole of the fix available today: an unstated limitation on a product that
   * sells on "your mailbox is yours" is the kind of claim CLAIMS-ARE-CONTRACTS exists to stop.
   * When the exclusion ships, this sentence goes with it.
   */
  aboutOnDevice:
    "Forgetting a server deletes its pairing and the mail this phone had copied. Deleting the app "
    + "takes the copied mail with it; on iPhone and iPad the pairing stays in the phone's keychain "
    + "until ohmail is opened again, which discards it before opening anything — and refuses to "
    + "open anything at all if it cannot — so to end it straight away, revoke this device from "
    + "the server's Devices list. The pairing is never included in a "
    + "backup. On iPhone and iPad the copied mail is: it lives in this app's documents, which the "
    + "phone's cloud and computer backups include. On Android it is excluded from both.",

  /* ------------------------------------------------------------- new mail */

  wake: "New mail",
  /**
   * THE NO-DISTRIBUTOR SENTENCE — the state this build is actually in, said plainly.
   *
   * It is a sentence and not a disabled switch, because a switch that cannot move is a worse
   * answer than a paragraph that tells you why. It says what a distributor IS (people have not
   * heard of UnifiedPush), that it is the user's choice, and — the part that keeps the claim
   * honest — that the app still gets mail without one. Nothing here promises a future version.
   */
  wakeNoDistributor:
    "No push distributor is chosen on this phone, so nothing wakes this app between visits. "
    + "UnifiedPush distributors are separate apps you choose yourself — no Google or Apple push "
    + "service is involved either way. Mail arrives when you open the app or pull to refresh.",
  /** The desktop-host arm. Same shape: what happens instead, not what is missing. */
  wakeDesktopHost:
    "Wake notifications need a hosted server. Paired with a desktop, this app syncs when you open "
    + "it and when you pull to refresh.",
  /**
   * THE SERVER HAS NO KEYPAIR — the one state whose fix belongs to somebody else.
   *
   * Named as its own sentence rather than folded into `wakeOff` because the action is on the person
   * running the server, and telling them WHICH thing is missing is the difference between a
   * five-minute fix and a support thread. It does not name the environment variables: this is a
   * phone screen, and the self-host guide is where the command lives.
   */
  wakeServerNoKey:
    "This server has not set up a signing key, so it cannot send wake notifications this phone "
    + "would accept. Whoever runs it can generate one — see the self-hosting guide. Mail still "
    + "arrives when you open the app or pull to refresh.",
  /**
   * REGISTERED — and every clause is measured against what the build actually does.
   *
   * While the process is alive (open or in the background) a wake is handled silently: the JS side
   * syncs and the new mail simply appears, because a wake is not a notification while you are in the
   * app. When the app has been swiped away, the connector's service still receives the wake in a
   * fresh process with no JS, and a native renderer draws a single plain "New mail" notice whose tap
   * opens the app — the one thing a content-free wake can honestly show. Either way the signal
   * carries no subject, no sender and no count.
   *
   * The closed-app notice depends on the OS notification permission being granted (Android asks for
   * it from Android 13 on); without it the app still syncs the next time it is opened. The copy says
   * "if you've allowed notifications" so it stays true on a phone that has not.
   */
  wakeOn:
    "While ohmail is running — open or in the background — your server tells this phone that "
    + "something changed, and the app fetches your mail directly. If you close the app, a plain "
    + "“New mail” notice arrives instead (if you've allowed notifications); tapping it "
    + "opens ohmail. Either way the signal carries no subject, no sender and no count.",
  /**
   * The distributor picker's label and hint.
   *
   * A REAL choice, shown only when the phone has distributors installed — the list comes from the
   * device, so an empty list means the `wakeNoDistributor` sentence and no control at all. Naming
   * two of the common ones is a kindness rather than an endorsement: "install a UnifiedPush
   * distributor" is not an actionable instruction to somebody who has never heard the word.
   */
  wakeDistributor: "Push distributor",
  wakeDistributorHint:
    "The app that carries the wake signal to this phone. You choose it, you can change it, and it "
    + "is the only thing in the path besides your own server.",
  /** Turning the choice off. Says what it costs, since it is the one destructive option here. */
  wakeDistributorNone: "None",
  wakeDistributorNoneHint:
    "Turning this off stops wake notifications and removes the registration from your server.",
  /**
   * THE SERVER KEPT THE ROW. Its own sentence, because the hint above is a CLAIM and the server
   * can refuse it: this phone stops listening either way (the distributor registration is gone),
   * so no wake reaches it, but the row is still there and the server keeps dialling an endpoint
   * that no longer exists until its own prune fires. Saying "removed" over that would be exactly
   * the unearned take-back the rest of this release is about.
   */
  wakeRowRemains:
    "Wake notifications are off on this phone. Your server would not remove the registration, so "
    + "it may keep trying the old address for a while — try again, or revoke this device from the "
    + "server's Devices list.",
  /** The distributor exists and the registration did not land. One sentence per real cause. */
  wakeOff: (reason: string): string => reason === "endpoint_refused"
    ? "Your distributor's address was refused by the server, so wake notifications are off. Mail "
      + "still arrives when you open the app or pull to refresh."
    : "Wake notifications could not be set up. Mail still arrives when you open the app or pull to "
      + "refresh.",

  /* ------------------------------------------------- world (phone-specific) */

  /** The Ohbox pin group — resurfaced mail, above everything. */
  groupResurfaced: "Resurfaced",
  /** One plain sentence for any rejected write; the optimistic view has rolled back. */
  liveSaveFailed: "That change could not be saved. Try it again.",
  liveDecided: (dest: string, target: string) =>
    `${dest} — future mail from ${target} files there automatically.`,
  liveDecideFailed: (sender: string) =>
    `That decision could not be saved — ${sender} is still waiting.`,
  liveReleased: (n: number, dest: string) =>
    `Released ${n} held message${n === 1 ? "" : "s"} to ${dest}. No rule was changed.`,
  liveReleasedRuled: (n: number, dest: string) =>
    `Released ${n} held message${n === 1 ? "" : "s"} to ${dest} — the holding rule now files there too.`,
  liveReleaseFailed: (sender: string) =>
    `That release could not be saved — mail from ${sender} is where it was.`,
  livePileAdded: (title: string) => `${title} — added.`,
  livePileFailed: (title: string) => `${title} — could not be saved. Try it again.`,
  /** The reading pane while the full text is on its way / when the fetch was refused. */
  liveBodyLoading: "Loading the whole message…",
  liveBodyFailed: "Only the preview could be loaded. Reopen to try again.",
  /**
   * THE STORAGE CAP'S TERMINAL STATE — an ANSWER, not a failure, so it must not borrow
   * {@link liveBodyFailed}'s "reopen to try again": reopening cannot change it. The server holds
   * no content for this message because the account's storage space was full when it arrived;
   * the mail itself is untouched on the user's own mail server, which is the half the reader
   * needs, and the preview above the note is real.
   */
  liveBodyWithheld:
    "Not stored — your storage space was full when this arrived. This is the preview; the message itself is safe in your mailbox on your mail server.",

  /* -------------------------------------------------------- message actions */

  routedBy: "Why it landed here",
  earlierInThread: (n: number) => `Earlier in this conversation — all ${n} shown`,
  openMessage: "Open",
  back: "Back",

  /*
   * THE MESSAGE VERBS — the webapp's action bar, word for word.
   *
   * Every label below is the webapp catalogue's own string (`apps/webapp/messages/en.json`:
   * `ohbox.action*`, `ohbox.resurface*`, `ohbox.move*`, `screening.action`,
   * `message.menuForward`, `reply.*`, `tag.*`), so an open message is named the same on the
   * phone as in the browser and on the desktop. `test/action-parity.test.ts` derives the verb
   * list from the webapp's source and holds the equality — a wording change there is a red
   * test here, never a silent drift. (The desktop composes the same shell; the phone is the
   * one surface that can diverge, and it is the one this deck keeps in step.)
   */
  actionReply: "Reply",
  actionReplyAll: "Reply all",
  actionForward: "Forward",
  actionLater: "Later",
  actionSetAside: "Park",
  actionResurface: "Resurface",
  actionTag: "Tag",
  actionScreening: "Screening",
  actionMove: "Move",
  actionMarkRead: "Mark as read",
  actionMarkUnread: "Mark unread",
  actionDone: "Done",
  actionMore: "More",
  /*
   * DELETE — the product rule verbatim (packages/core/src/adapters/imap-types.ts, mail 0065):
   * delete files the message to the provider's own \Trash and NEVER expunges. The webapp's
   * reading pane carries the verb too now (the §16 UI wave), and its catalogue mirrors these
   * exact sentences (`ohbox.actionDelete` family in `messages/en.json`) —
   * `test/folders-parity.test.ts` pins the two word for word. There
   * is no un-delete on the wire, so the ceremony is a confirm, never an undo the product
   * could not honour.
   */
  actionDelete: "Delete",
  deleteAsk: "Delete this message?",
  deleteNote:
    "It moves to the Trash folder on your own mail server — ohmail never erases mail. Your mail server's Trash rules apply from there.",
  toastDeleted: "Moved to Trash.",
  deleteFailed: "That delete could not be saved — the message is where it was.",
  /** The resurface horizon chooser (`ohbox.resurface*`). */
  resurfaceWhen: "Resurface when?",
  resurfaceNow: "Now",
  resurfaceTomorrow: "Tomorrow",
  resurfaceNextWeek: "Next week",
  resurfacePick: "Pick a date",
  /** The move panel (`ohbox.moveLabel` / `ohbox.moveCancel`); destinations are `place*`. */
  moveLabel: "move to",
  moveCancel: "Cancel",
  /** The place names the move panel files to — the webapp's `PLACE_LABEL` (format.ts PLACE_EN). */
  placeOhbox: "Ohbox",
  placeReads: "Reads",
  placeReceipts: "Receipts",
  placeScreened: "Screened",
  placeSpam: "Spam",
  /** The verbs' toasts — `ohbox.toast*`, each one sentence. */
  toastQueued: "Queued in Answer Later",
  toastUnqueued: "Out of Answer Later",
  toastAside: "Parked",
  toastUnparked: "Out of Parked",
  toastResurface: (when: string) => `Resurfaces ${when}`,
  toastResurfaceCleared: "Resurface cancelled",
  toastResurfaceNow: "Back at the top",
  toastResurfaceDone: "Done — filed under Earlier",
  toastMoved: (place: string) => `Moved to ${place}.`,
  /** The reply / forward composer (`reply.*`). */
  replyTo: (name: string) => `Reply to ${name}`,
  replyToAll: (names: string) => `Reply to ${names}`,
  replyCcLine: (names: string) => `Cc ${names}`,
  replyPlaceholder: "Write your reply…",
  replySend: "Send",
  replyCancel: "Cancel",
  replySending: "Sending…",
  replySent: "Reply sent.",
  replyQueued: "Not sent yet. ohmail is still trying.",
  replyUnverified: "We couldn't confirm this send. Check your Sent folder before sending it again.",
  replyFailed: "Sending didn't work. Try again.",
  forwardHead: "Forward — you pick who receives it",
  forwardTo: "To",
  forwardToPlaceholder: "name@example.org, …",
  forwardNotePlaceholder: "Add a note (optional)",
  forwarded: "Forwarded.",
  /*
   * SEND LATER (mail 0077) — the composer's second way for a message to end, and the
   * Scheduled screen that holds what it produced. Every sentence below is the webapp
   * catalogue's word for word (`compose.sendLater*`/`compose.toastScheduled` and
   * `drafts.scheduled*`/`drafts.schedule*`), pinned by `folders-parity.test.ts`; only the
   * three strings marked PHONE-ONLY have no webapp twin, because the webapp expresses the
   * same facts through affordances this screen does not have.
   */
  sendLater: "Send later",
  sendLaterWhat: "When should this message be sent?",
  sendLaterTonight: (when: string) => `This evening (${when})`,
  sendLaterTomorrow: (when: string) => `Tomorrow morning (${when})`,
  sendLaterMonday: (when: string) => `Monday morning (${when})`,
  sendLaterPick: "Pick a date and time",
  sendLaterClose: "Back",
  /**
   * A PRESET THAT WENT PAST WHILE THE CHOOSER SAT OPEN. The rows themselves cannot name a past
   * instant — the day rows are floored at tomorrow 09:00 and the evening preset is only
   * offered while it is meaningfully ahead — but the presets are computed WHEN THE CHOOSER
   * OPENS, and a sheet left open through 18:00 would otherwise dispatch an appointment the
   * server refuses. Re-checked at the press, refused here, in words, before the wire.
   */
  sendLaterPast: "That time has passed. Pick a future time.",
  sendLaterZone: (zone: string) => `Times are in your time zone (${zone}).`,
  sendLaterUnavailable: "Send later isn't available for messages with attachments or forwards yet.",
  scheduledFor: (when: string) => `Scheduled for ${when}.`,
  /** The Scheduled surface — the More tab's row, its screen, and the one verb on a row. */
  scheduled: "Scheduled",
  scheduledWhen: (when: string) => `Sends ${when}`,
  scheduledCancel: "Cancel send",
  scheduledNoSubject: "(no subject)",
  scheduledNoRecipient: "No recipient yet",
  scheduleFailedNote: (reason: string) =>
    `This message wasn't sent at its scheduled time: ${reason}`,
  scheduleCancelled: "Scheduled send cancelled. The message is in Drafts.",
  scheduleCancelTooLate: "Too late to cancel — this message is already being sent.",
  scheduleCancelQueued:
    "No connection — the cancel hasn't reached the server yet. The message is still scheduled until it does.",
  /**
   * PHONE-ONLY (1/3): the empty state. The webapp's Scheduled group simply does not render
   * when the list is empty, because Drafts stands underneath it; this screen is reachable on
   * its own, so it owes the reader a sentence rather than a blank panel.
   */
  scheduledEmpty: "Nothing scheduled. Messages you send later wait here until their time.",
  /**
   * PHONE-ONLY (2/3): the stated degradation. The webapp offers Edit — cancel-then-open —
   * because it has a draft editor; this app composes only replies and forwards and has no
   * editor to open a cancelled row into, so it says where the message goes instead of
   * offering a verb that leads nowhere.
   */
  scheduledEditNote:
    "Cancelling puts the message back in Drafts, where you can edit and send it from ohmail on the web or the desktop.",
  /**
   * PHONE-ONLY (3/3): an appointment whose time the mirror does not carry (an older server
   * mid-claim, a row from before the field). The row still lists — see `liveScheduled` — and
   * says what it does not know rather than inventing a time.
   */
  scheduledWhenUnknown: "Sends at its scheduled time",
  /**
   * PHONE-ONLY: an appointment the server could not keep. The scheduled-send pass closes such a
   * message back to an ordinary draft with its refusal, and the webapp's Drafts list catches
   * it; this app has no Drafts screen, so the row stays HERE and says what happened rather than
   * disappearing — a message that vanishes from the only screen that ever mentioned it reads as
   * one that was sent.
   */
  scheduledNotSent: "Not sent",
  /*
   * THE SIGNATURE BLOCK (`compose.signature*` in the webapp catalogue, word for word —
   * `folders-parity.test.ts` pins them): the sending mailbox's stored signature as a
   * distinct, removable, editable block below the writing area, serialized exactly as shown.
   */
  sigLabel: "Signature",
  sigRemove: "Remove signature for this message",
  sigAria: "Signature — part of this message; edit or remove it here",
  /** The tag picker (`tag.*`). */
  tagPlaceholder: "Tag this message…",
  tagNone: "No tags yet. Type a name to create your first.",
  tagCreate: (name: string) => `Create “${name}”`,
  tagTagged: (name: string) => `Tagged “${name}”.`,
  tagUntagged: (name: string) => `Untagged “${name}”.`,
  tagNotOnServer:
    "Tags are stored by ohmail, not in your mailbox. Your folders are real IMAP folders and survive if you leave; tags don’t — erasing your account erases them.",
  /** The screening sheet: where THIS SENDER's mail goes, from the open message. */
  screeningFor: (sender: string) => `Mail from ${sender} goes to`,
  screeningNote: (target: string) =>
    `Becomes a rule — future mail from ${target} files there automatically, and what is already here moves.`,
} as const;
