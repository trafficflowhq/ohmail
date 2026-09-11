/**
 * Every string the chrome says, in one place — the phone's copy deck, in English.
 *
 * Blanc's rule is **factual microcopy only**: no slogans, no praise, no
 * invented numbers. Each line is either the canonical product wording (the
 * desktop client established the copy deck) or a literal statement of what the
 * app just did. Keeping them together makes that auditable, and keeps the
 * privacy grep to one file's worth of prose.
 *
 * Phone-specific lines are marked. They exist because a thumb does things a
 * cursor did not — nothing here softens or oversells the desktop wording.
 *
 * ── THIS FILE IS ALSO THE CONTRACT EVERY OTHER LANGUAGE IS HELD TO ────────────────────────────
 *
 * It used to export `Copy` directly and be the whole of the app's copy. It now exports the ENGLISH
 * DECK and the {@link Deck} type derived from it; `copy.de.ts` is the same shape in German, and
 * `copy.ts` is the live accessor that resolves one of them per read. The English text below is
 * unchanged by that move — the parity guards that compare it to the webapp catalogue
 * (`action-parity`, `folders-parity`, `ohmarchy-face`) still read these exact strings.
 *
 * The type is what makes the second deck honest, and it is stronger than the webapp's JSON census:
 * a German deck missing a key does not compile, an extra key does not compile, and a function whose
 * arguments differ does not compile. `pnpm -F mobile typecheck` covers `src/**`, so that is a real
 * gate rather than a documented intention. `test/copy-parity.test.ts` adds the things a type cannot
 * see — an untranslated sentence, a dropped interpolation, a plural that ignores its number.
 *
 * NO `as const`. The literal types it produced were never used, and they would make the German deck
 * unassignable to this shape for the trivial reason that its strings are different strings.
 */

import { isPinFailure } from "./net/host-pinning";

/**
 * Hoisted out of the table because {@link TABLE.connectSyncFailed} interpolates it, and a member
 * that reads its own object inside that object's initializer leaves TypeScript unable to infer the
 * type it is in the middle of inferring. It is a deck key all the same — see `pinChanged`.
 */
const PIN_CHANGED =
  "This computer's identity has changed since you paired with it, so ohmail stopped rather than "
  + "trusting it. If you reinstalled ohmail on that computer or restored it from a backup, open "
  + "Settings → Devices there and pair this phone again with a fresh code. If you did not, "
  + "something on your network is answering for it.";

const TABLE = {
  /* --------------------------------------------------------------- welcome */

  welcomeTitle: "Which mailbox is this?",
  welcomeLead:
    "Whatever organizes your mail has to be running — a computer, a server, or this phone while ohmail is open. Your mail stays on your mail server.",
  /*
   * NO `welcomeScan` / `welcomeOther`, AND NO `welcomeHow`. The first two were the buttons this
   * screen led with, and `welcomeHow` said "No password is ever typed here" — true while all
   * three doors scanned a code, false the day the standalone door types one. The scan verb still
   * exists where a scan is genuinely the next step (`scanTitle`, `stepScan`).
   */

  /* ------------------------------------------------------------------ doors */

  /*
   * ═══ THE DOORS, IN THE PHONE'S IDIOM ═════════════════════════════════════════════════════
   *
   * The desktop chooser asks one question — this computer, a server you run, or ours — and each
   * answer names a DIFFERENT MACHINE as the thing that does the organizing. The phone asks the
   * same question, and since the standalone engine landed one of its answers is the phone in the
   * reader's hand. Three doors name somebody else's machine and the phone's own half of each of
   * those sentences is the same — it keeps a copy; the fourth names this phone and says what it
   * costs ({@link doorPhone}).
   *
   * ── AND THE LEAD SENTENCE COUNTS THE DOORS, WHICH IS RULED COPY ─────────────────────────
   *
   * It read "One question, three answers" and went false the day the engine started shipping
   * inside the app and the fourth tile began to render. The count is ruled — CHOOSER-DESIGN
   * §7.1 and PHONE-DOOR-DESIGN's copy table both name "One question, four answers" — so the
   * remedy is the number, not its removal. A count in prose beside a data-driven list goes
   * stale without anybody editing it, so `test/no-host-census.test.ts` §5 reads the word
   * against the `<Door>` count in both decks rather than pinning the string.
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
  doorsLead: "One question, four answers — which machine does the organizing?",

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
   * ═══ THE FOURTH DOOR ═════════════════════════════════════════════════════════════════════
   *
   * Three of these tiles name somebody else's machine. This one names the phone in the reader's
   * hand, so its third line is a CONDITION where the others' are instructions: what this door
   * costs, read before the tap rather than discovered after it.
   *
   * The third line is the only thing on any of the four screens that forks on platform. Both
   * sentences live in both decks and the tile renders on both platforms.
   */
  doorPhone: "Standalone on this phone",
  doorPhoneSay: "Your mailbox, organized on this phone.",
  doorPhoneNeedIos:
    "Only while the app is open. When you leave, it hands the mailbox back.",
  doorPhoneNeedAndroid:
    "Only while the app is open — or in the background behind a notification you can see.",

  /**
   * THE TRAVEL SENTENCE, IN THE ONE FORM THAT IS TRUE FOR A PHONE.
   *
   * The desktop's is *"Your rules and settings live in your own mailbox and travel with you — the
   * mailbox is always the master."* Both halves hold here, and a phone needs a third clause the
   * desktop does not: behind three of the four doors what moves is which machine it mirrors, and
   * nothing the phone holds travels, because behind those three everything it holds is a copy.
   * Behind the fourth the phone IS the organizer, so the final clause was dropped — it was true
   * of three doors out of four and the panel carries all four.
   *
   * The list is the catalogue's own (`leave.note`: screened senders, rules, notification choices,
   * the away reply, tag names), shortened to the three a phone actually shows, and it does NOT say
   * "settings" unqualified — the phone's Look setting is per-device on purpose
   * (`faceScopeDevice`), and triage piles and Resurface timers stay with the install that made
   * them. Claiming them would be claiming the payload does not carry.
   */
  doorsTravel:
    "Move between these anytime. Your screened senders, rules and notification choices live in your own mailbox, so they are the same behind every door — the mailbox is always the master.",

  /* ------------------------------------------------- the self-hosted door */

  doorSelfTitle: "Your own server",
  doorSelfLead:
    "Give the address you open ohmail at in a browser. This app will check that your server is there before anything else.",
  doorSelfAddress: "Your server's address",
  doorSelfAddressHint: "For example ohmail.example.com — nothing after the host.",
  /** The address field's ghost text. A reserved documentation host, and the same in both decks. */
  doorSelfAddressPlaceholder: "ohmail.example.com",
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

  /* ------------------------------------------------ the standalone door */

  /**
   * ═══ WHAT THIS PHONE IS AND IS NOT AS THE ORGANIZER ══════════════════════════════════════
   *
   * Three ruled sentences, read before the choice is confirmed. The first forks on platform
   * because the two platforms genuinely differ; the other two are the same everywhere.
   *
   * The iPhone sentence says "hands the mailbox back" and never "in the background": iOS does
   * not let a suspended app hold an organizer claim honestly, and a sentence promising it would
   * be the double-organizer hazard written down as a feature.
   */
  phoneStandaloneTitle: "Organize on this phone",
  phoneStandaloneL1Ios:
    "It organizes while ohmail is open. When you leave the app, it hands the mailbox back.",
  phoneStandaloneL1Android:
    "It organizes while its notification is shown. Dismiss the notification to stop.",
  phoneStandaloneL2: "One mailbox on this phone.",
  phoneStandaloneL3:
    "Your mail server keeps everything. Nothing here is a copy you could lose.",
  phoneStandaloneGo: "Continue",
  phoneStandaloneBack: "Choose differently",

  /* The credential form. Every label here is the web catalogue's, byte for byte — the same
     mailbox asked for in the same words on whichever surface somebody opens it. */
  phoneStandaloneFormTitle: "Your own mailbox",
  phoneStandaloneFormLead:
    "This phone connects to your mail server directly. Your password is stored on this phone, encrypted under a key held in its keystore, and is never sent to us.",
  phoneStandaloneAddress: "Mailbox address",
  phoneStandalonePassword: "Mailbox password",
  phoneStandaloneShowPassword: "Show password",
  phoneStandaloneHidePassword: "Hide password",
  phoneStandaloneAdvanced: "Server settings",
  phoneStandaloneImapHost: "Incoming server (IMAP)",
  phoneStandaloneImapPort: "IMAP port",
  /**
   * THE SWITCH AND THE PORT ARE ONE FACT, which is why this hint exists.
   *
   * `enterLocalDoor` derives `secure` from the PORT and ignores any separate flag, so a switch
   * that wrote its own value would be a control the engine does not read. Here the switch sets
   * the port and the port sets the switch — one source of truth, and the hint says so rather
   * than leaving somebody to discover that the two move together.
   */
  phoneStandaloneImapTls: "Implicit TLS",
  phoneStandaloneImapTlsHint:
    "On is port 993. Off is port 143, which upgrades with STARTTLS. Changing the port moves this switch with it.",
  phoneStandaloneSmtpHost: "Outgoing server (SMTP)",
  phoneStandaloneSmtpPort: "SMTP port",
  phoneStandaloneConnect: "Connect",
  phoneStandaloneConnecting: "Opening your mailbox…",
  /** The press beside a refusal that named a host. Only rendered where there is a field for it. */
  phoneStandaloneUseHost: (host: string) => `Use ${host}`,
  /* The probe's own two sentences, verbatim from the web catalogue — the server's answer, not
     ours. `probe_tls_hostname` / `probe_tls_hostname_suggest`. */
  probeTlsHostname: (certHost: string, expectedHost: string, protocol: string) =>
    `That server's certificate is for ${certHost}, not ${expectedHost}, so we stopped before sending the password. Check the ${protocol} host with your provider.`,
  probeTlsHostnameSuggest: (certHost: string, expectedHost: string, suggestedHost: string, protocol: string) =>
    `That server's certificate is for ${certHost}, not ${expectedHost}, so we stopped before sending the password. It answers to ${suggestedHost} — use that as the ${protocol} host.`,

  /**
   * Settings → This phone. The five state labels are the desktop's own keys and values, because
   * a person who reads "Organizing" on a laptop must not meet a second word for it here.
   */
  phoneThisPhone: "This phone",
  phoneStateOrganizing: "Organizing",
  phoneStateStopping: "Stopping",
  phoneStateNotOrganized: "Nothing organizes this mailbox",
  phoneStateReader: (name: string) => `Organized by ${name}`,
  phoneStateReaderLegacy: "Organized by another install",
  settingsStopHere: "Stop organizing here",
  settingsStopHereWhat:
    "This phone stops filing this mailbox and goes on reading it. Your folders and everything in them stay where they are. Any install can take it over afterwards, including this one.",
  settingsStopHereConfirm: "Hand the mailbox back",
  settingsStopHereCancel: "Keep organizing",

  /* The standalone door's own refusals. Each one names what is missing; none of them ever
     carries the password, which is not an argument any of these takes. */
  standaloneNoEngine:
    "This build cannot organize a mailbox on this phone. Connect it to a computer, a server or ohmail Cloud instead.",
  standaloneNoHost:
    "ohmail needs your incoming server (IMAP). Open Server settings and give its address.",
  standaloneNoPort:
    "That IMAP port is not a number ohmail can dial. Open Server settings and check it.",
  standaloneSignInRefused:
    "Your mail server would not accept that address and password. Check them and try again — nothing has been saved.",
  standaloneNoEncryption:
    "Your mail server offers no encrypted connection on that port, and ohmail will not send your password in the clear. Try port 993 in Server settings.",
  standaloneRefused: (detail: string) =>
    `Opening the mailbox stopped: ${detail}`,

  /* --------------------------------------------------- servers & pairing */

  serversTitle: "Servers",
  serversRow: "Connect to a server",
  serversNote:
    "Pair this phone with the computer or server that holds your mail. Pairing is a QR code or a short-lived token, and no password is typed for it.",
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
  /**
   * AN ADDRESS THAT ANSWERED, AND NOT WITH TLS — see `isNotTls`, which decides it.
   *
   * "Could not reach that address" followed by `javax.net.ssl.SSLException: Unable to parse TLS
   * packet header` is two wrong things at once: the address WAS reached, and the words after the
   * full stop are the platform's, not anybody's. The usual cause is named and not asserted,
   * because iOS's own wording for this does not distinguish it from a cipher mismatch.
   */
  notEncrypted:
    "ohmail could not open an encrypted connection to that address, so it sent nothing. The "
    + "usual reason is a server answering plain http on the port you typed — ohmail only "
    + "pairs over https.",

  scanTitle: "Scan the pairing QR",
  scanHint: "Point the camera at the QR your computer or server shows.",
  scanBadCode: "Not an ohmail pairing code. The QR is on the Devices screen.",
  scanCameraOff: "Camera access is off, so there is nothing to scan with.",
  scanAllow: "Allow the camera",
  scanManual: "Enter it by hand instead",
  scanAgain: "Scan again",

  /* ── THE CONFIRMATION BEFORE A CODE IS SPENT ───────────────────────────────────────────────
     A QR is a string nobody can read. Every shipped release has said, in the desktop's own
     Devices pane, that "a device pairing over your network shows these characters before it
     pairs" — and the phone showed nothing and paired on the scan, which made that sentence
     false. These are the screen that makes it true. `net/pairing.ts#PairAdmission` holds the
     reasoning; the key is rendered from `shortPin`, the SAME twelve characters the desktop
     draws, because two ends of a comparison computed by two rules compare nothing. */
  pairConfirmTitle: "Pair this phone?",
  pairConfirmLead:
    "A code cannot be read by eye, so check what answered before it is spent.",
  pairConfirmWhatLabel: "What answered",
  /* THE DOOR'S OWN WORD ABOUT ITSELF, read over the connection this pairing will use — never a
     name carried in the code. A "display name" in the QR would let a hostile code label a
     stranger's server "MacBook Pro" on the one screen built to catch it. The default arm is the
     flavor verbatim: a server this build has never heard of is named, not guessed at. */
  pairConfirmWhat: (flavor: string) =>
    flavor === "local" || flavor === "desktop-host"
      ? "The ohmail app on a computer"
      : flavor === "selfhost"
        ? "An ohmail server"
        : flavor === "managed"
          ? "The hosted ohmail service"
          : `An ohmail server (${flavor})`,
  pairConfirmAddressLabel: "Address",
  pairConfirmKeyLabel: "Its key",
  pairConfirmKeyWhy:
    "The same characters as under Settings \u2192 Devices there. If they differ, something else "
    + "is answering for that computer \u2014 do not pair.",
  /* NO KEY ROW WITHOUT A KEY. The desktop pane keeps the same rule for the same reason: a row
     inviting a comparison against a value nothing shows is a check that cannot be performed. */
  pairConfirmNoKeyWhy:
    "This address carries a certificate your phone checks on its own, so there is no key to "
    + "compare by eye.",
  pairConfirmGo: "Pair",
  pairConfirmCancel: "Do not pair",

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
  /**
   * WHAT TO SHOW WHEN A PAIRED COMPUTER PRESENTS A KEY THIS PHONE DID NOT AGREE TO.
   *
   * It lived in `net/host-pinning.ts` as `PIN_CHANGED_SENTENCE` and moved here with the second
   * language, because it is copy and copy is translated: leaving it beside the regex that
   * recognises a handshake failure would have made it the one refusal sentence on the phone that
   * could not be German. The regex stayed there — it matches a platform's own error text and has
   * no language of its own.
   */
  pinChanged: PIN_CHANGED,
  connectSyncFailed: (detail: string, pinned: boolean) =>
    isPinFailure(detail)
      ? pinned
        ? `Sync stopped. ${PIN_CHANGED}`
        : "Sync stopped. This phone would not accept the certificate at that address, so it did "
          + "not send anything. The server needs an https certificate from an authority this phone "
          + "already trusts — see the note on the “Your own server” door."
      : `Sync failed — the mirror keeps what it has. ${detail}`,

  /* ------------------------------------------- transport & pairing refusals */

  /*
   * ═══ THE SENTENCES THE NETWORK LAYER HANDS BACK ═══════════════════════════════════════════
   *
   * These were literals inside `net/pairing.ts`, `net/server-base.ts` and `net/connection.tsx`,
   * and every one of them reaches a screen: a `refused` outcome's `reason` is rendered under
   * {@link connectRefusedTitle}, and an unreachable one goes through {@link unreachable}. They
   * were the largest body of user-visible prose outside this deck, which made them the largest
   * body of prose that could not be translated — so they moved, verbatim, and the modules that
   * produce them read `Copy` like every screen does.
   *
   * The modules keep their own DEVELOPER messages: a `throw new Error(…)` about an un-normalized
   * origin or a missing account id is a programming fault, is never rendered, and would be worse
   * in German than in English for the person who has to read the stack. `test/copy-census.test.ts`
   * draws that line and names it.
   */

  /** A plain-http address, refused before a socket opens. */
  admitCleartext:
    "That address is a plain, unencrypted connection, and ohmail will not send your mail "
    + "over one. A desktop running ohmail serves a secure address — open Settings → Devices "
    + "there and use the code it shows.",
  /** A same-network address whose code carried no key fingerprint. */
  admitNoPin:
    "That pairing code does not carry this computer's identity, so ohmail cannot tell its "
    + "connection apart from anything else on your network. Mint a fresh code from the "
    + "desktop app's Settings → Devices and scan that.",
  /** The platform has no pinning half — today, iOS. The remedy that works on both is named. */
  admitCannotPin:
    "Pairing with a computer on your own network is not available in this build of the "
    + "ohmail app yet. Use the Tailscale address from that computer's Settings → Devices "
    + "instead — it works on every platform.",
  admitPinNotStored:
    "ohmail could not record this computer's identity on this phone, so it stopped "
    + "rather than connecting without it.",
  /**
   * A PINNED CODE FOR A NAMED ADDRESS. The desktop composes a key into a pairing code only for
   * its same-network address, so a code carrying one for a named address is either a mistake or
   * somebody else's code. The key cannot be checked there — the address has a certificate of its
   * own — and showing an unchecked key beside "compare these characters" is the one outcome that
   * cannot be made honest, so the code is refused instead.
   */
  admitPinUnenforceable:
    "This pairing code carries a key, but the address in it is a named one whose certificate "
    + "this phone checks for itself \u2014 so the key cannot be checked and ohmail will not "
    + "show it as if it had been. Use the code shown on the computer or server you mean to pair "
    + "with.",

  pairBadAddress: (origin: string) => `not a server address: "${origin}"`,
  pairEmptyToken: "the pairing code is empty",
  /** A `/hello` that answered with a status rather than a descriptor. Rides `unreachable`'s detail. */
  helloStatus: (status: number) => `the server answered ${status}`,
  pairUnreachable: (detail: string) => `could not reach that server — ${detail}`,
  pairNotOhmail: "that address answers, but not as an ohmail server",
  pairManagedDeferred: "ohmail.app is not offering device pairing right now — its own descriptor says so",
  pairNoPairing: "this server does not offer device pairing",
  /** The keystore refused the pairing AFTER a session was opened — two arms, two remedies. */
  pairNotStoredClosed: (detail: string) =>
    `this phone could not store the pairing (${detail}) — the session was closed; mint a fresh code and try again`,
  pairNotStoredOpen: (detail: string) =>
    `this phone could not store the pairing (${detail}), and the server could not be `
    + "reached to close the session it had just opened — revoke this device from its Devices "
    + "list, then mint a fresh code and try again",
  pairEndedRefused: "this pairing ended — the server refused its token. Scan a fresh QR to pair again",
  /*
   * FOUR MORE REDEEM-TIME REFUSALS. They sat inside `net/pairing.ts` behind a stretch of the file
   * the census could not see, and the second of them is the one a phone actually rendered under a
   * German "Abgelehnt" heading — found on a device, which is why the census now tokenizes rather
   * than stripping comments line by line.
   */
  pairRedeemUnreachable: "could not reach that server to redeem the pairing",
  pairCodeRejected: "that pairing code was not accepted — mint a fresh one and scan again",
  pairNoAccountName:
    "paired, but the server could not name the account this pairing opens — once it holds mail, "
    + "mint a fresh code and pair again",
  pairOwedDeletion: (detail: string) =>
    "This phone still owes a deletion for that mailbox's copied mail and could not carry "
    + `it out (${detail}). Restart ohmail so it can finish, then pair again with a fresh code.`,
  pairEndedOnServer: "this pairing ended on the server — scan a fresh QR to pair again",
  notPairedHere: "that server is no longer paired on this phone",
  pairingsUnreadable: (detail: string) =>
    `could not read this phone's stored pairings — ${detail}`,

  /** Forgetting a server: what remains, and what to do about it. */
  forgetCannotStart: (detail: string) =>
    `This phone could not start forgetting that server (${detail}). Restart ohmail so `
    + "it can finish the deletions it already owes, then try again.",
  forgetKeystoreRefused: (detail: string) =>
    `This phone would not let go of the pairing (${detail}). `
    + "Revoke this device from the server's Devices list, which ends the session wherever it is held.",
  forgetMailRemains: (detail: string) =>
    "The pairing is removed, but the mail this phone had copied could not be deleted "
    + `(${detail}). ohmail will try again the next time it starts.`,
  forgetServerUnreachable:
    "The pairing and the mail this phone had copied are gone. The server could not be reached to "
    + "end the session, so it may still count this phone as connected — revoke this device from its "
    + "Devices list to finish.",
  forgetStillPending:
    "This server is still being forgotten on this phone — ohmail could not remove its "
    + "sign-in yet. Restart the app to let it finish, or revoke this device from the server's "
    + "Devices list.",

  /** The address field's own refusals, before any request is made. */
  baseAddressMissing: "Your server's address is missing.",
  baseNeedsTheCode:
    "That is a numeric address on a network, and no certificate authority can vouch for one — "
    + "so ohmail can only trust it through the code your computer shows. Open Settings → "
    + "Devices there and scan that instead.",
  baseCleartext:
    "That is a plain, unencrypted address, and ohmail will not send your mail over one. "
    + "Give the https address you open ohmail at in a browser.",
  baseNotAnAddress:
    "That does not look like a server address. Give the address you open ohmail at in a "
    + "browser — for example https://ohmail.example.com — with nothing after the host.",

  /** Finding the mail API: four outcomes, four sentences, each true of exactly its own state. */
  baseApiUnreachable: (detail: string) =>
    `could not reach that server to find its mail API — ${detail}`,
  baseApiStopped:
    "That server started answering and then stopped, so ohmail stopped waiting. If you run "
    + "it, check that its proxy is passing requests through to the ohmail API.",
  baseApiTimeout:
    "That server did not answer in time, so ohmail stopped waiting. That may be the network "
    + "between this phone and it, or a route on the server that never replies.",
  baseApiMixed: (detail: string) =>
    "One of the two addresses ohmail tried answered and was not its mail API, and the other "
    + `could not be reached — ${detail}. If you run this server, check that it `
    + "is passing /api through to the ohmail API.",
  baseApiNotFound:
    "That address answers, but ohmail could not find its mail API — neither at the address "
    + "itself nor under /api. If you run this server, check that its proxy is passing /api "
    + "through to the ohmail API.",

  /* ----------------------------------------------------------------- ohbox */

  ohbox: "Ohbox",
  groupNew: "New",
  groupSeen: "Earlier",
  /*
   * THE VIEW META LINES AND THE SPOKEN LABELS — moved here from the screens that render them.
   *
   * `state/world.tsx` built four of these as template literals inside the view memo, and three
   * screens spelled an English word into an `accessibilityLabel`. None of it was reachable from a
   * copy deck, so none of it could be translated, and a screen reader on a German phone would have
   * read "3 new" over a German interface. The counts still come from the view; only the words are
   * here.
   */
  metaUnreadOf: (unread: number, total: number) => `${unread} unread of ${total}`,
  metaNew: (n: number) => `${n} new`,
  metaWaiting: (n: number) =>
    `${n} first-time sender${n === 1 ? "" : "s"} waiting`,
  metaItems: (n: number) => `${n} item${n === 1 ? "" : "s"}`,
  /** A mail row, spoken. The trailing state is a clause rather than a word glued to a stop. */
  mailRowAria: (from: string, subject: string, time: string, unread: boolean) =>
    `${from}. ${subject}. ${time}.${unread ? " Unread." : ""}`,
  /** A Screener row, spoken — the only word in it is the one describing what is held. */
  senderRowAria: (name: string, address: string, held: number) =>
    `${name}, ${address}, ${held} held`,
  /** The Reads card's expand affordance, as a badge and as a spoken label. */
  readsCollapse: "Collapse",
  readsReadInFull: "Read in full",
  readsCardAria: (subject: string, open: boolean) =>
    `${subject}. ${open ? "Collapse" : "Read in full"}.`,
  /** The two halves of a Screener decision button, spoken. `done` is the past-tense place name. */
  decideAria: (done: string, suggested: boolean) => `${done}${suggested ? ", suggested" : ""}`,
  decideReadAria: (done: string) => `${done}, and mark read`,
  ohboxTail: (shown: number) => `All ${shown} accepted message${shown === 1 ? "" : "s"} shown.`,
  ohboxEmptyTitle: "Nothing here yet.",
  ohboxEmptyHint: "Mail from senders you said Yes to lands here as it syncs.",
  doorbell: (n: number) => `${n} new sender${n === 1 ? "" : "s"}`,
  doorbellRest: "waiting",
  doorbellGo: "Screener",
  /**
   * THE DOORBELL, SPOKEN — one key, because the markup was joining three.
   *
   * It was `` `${Copy.doorbell(n)} ${Copy.doorbellRest}. ${Copy.doorbellGo}` `` in `chrome.tsx`:
   * the space, the full stop and the order all typed into the component, which fixes English
   * grammar for every language. German puts the verb at the end and inflects the adjective with
   * the count, and neither is expressible by concatenating those three pieces.
   */
  doorbellAria: (n: number, go: string): string =>
    `${n} new sender${n === 1 ? "" : "s"} waiting. ${go}`,

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
  /**
   * THE VERB, as opposed to {@link segScreened}'s past tense — the label on the decision button
   * that sends a sender there. `state/model.ts` held both as literals in a lookup table; the
   * past-tense one was already a deck string one section down, and this is its missing twin.
   */
  destScreenOut: "Screen out",
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

  /*
   * THE PILE BLURBS LIVE HERE, not beside the projection that builds the rows.
   *
   * They were a second deck — a `PILE_META` const in `state/live.ts`, spread into each pile row,
   * with its own copies of the three titles. The titles above were already correct and already
   * used by the More screen, so the two decks agreed in English and nothing looked wrong; the
   * moment a translated deck existed, the More screen followed it and the Piles screen did not.
   * A screen that reads a private copy of the wording cannot be translated, and the defect is
   * invisible until somebody translates.
   *
   * The English is the branch that owns `state/live.ts` writing it, byte for byte, so the two
   * halves of this change cannot disagree when they meet.
   */
  replyLaterNote: "Answers you owe. A Reply Run walks them one screen at a time.",
  setAsideNote: "Kept in view without keeping the Ohbox busy.",
  resurfaceNote: "Comes back on its own, at the time you chose.",

  /**
   * WHAT THIS PHONE'S OWN STORE SAYS WHEN IT REFUSES — one sentence per enumerable failure.
   *
   * These reach a screen as the DETAIL inside a translated refusal (`pairNotStoredClosed`,
   * `forgetCannotStart` and their neighbours). They used to arrive as `String(err)` from a thrown
   * English `Error`, so a German reader met a German sentence with an English one inside it. The
   * store throws a {@link StoreFault} carrying a code now, and this turns the code back into
   * language. Anything that is NOT one of ours — a keystore's own exception, an SQLite failure —
   * is still quoted verbatim, which is the diagnostic rule.
   */
  storeFault: (code: string): string => {
    switch (code) {
      case "origin_not_normalized": return "that server address was not in the form this phone stores";
      case "account_id_missing": return "the server did not name the account this pairing opens";
      case "pairing_not_recorded": return "this phone could not record the pairing before storing it";
      case "pairing_still_held": return "this phone is still holding the pairing";
      case "pairing_still_listed": return "this phone is still listing the pairing";
      case "no_such_profile": return "there is no such pairing on this phone";
      case "wipe_queue_full": return "this phone already has more unfinished deletions than it can record";
      case "wipe_not_recorded": return "this phone could not record that the copied mail is owed a deletion";
      case "wipe_still_owed": return "this phone still records a deletion owed for that mailbox";
      case "wake_queue_full": return "this phone already has more unfinished wake removals than it can record";
      case "wake_not_recorded": return "this phone could not record that the wake registration is owed a removal";
      case "wake_still_owed": return "this phone still records a wake removal owed for that registration";
      case "index_unreadable": return "this phone's list of pairings could not be read";
      case "purge_refused": return "the keystore would not give up the earlier installation's pairings";
      case "mirror_not_deleted":
        return "this phone could not delete the mail it had stored for that account";
      case "sync_held_pre_identity":
        return "ohmail is still checking which account this server opens";
      case "account_mismatch":
        return "that server is syncing a different account than the one this pairing names";
      case "index_not_removed": return "the keystore would not remove the list of pairings";
      /* A code this build does not know is a newer store talking to an older deck. Saying the code
         is better than saying nothing, and it is the one arm that can reach a screen unworded. */
      default: return code;
    }
  },

  /**
   * THE SERVER'S OWN WORDS, PASSED THROUGH. A refusal carries a deck key, so a message that is not
   * ours needs a key that says exactly that: the pairing redeem quotes whatever the server wrote
   * when the failure is not one of the enumerable ones. The diagnostic rule, expressed as a key.
   */
  verbatimDetail: (detail: string) => detail,

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
  /* ── SCREEN-READER LABELS ASSEMBLED FROM PARTS ──────────────────────────────────────────
     Each of these was a template in the markup — `${label}, ${count}`, `${name}. ${say}` — which
     fixes one language's separator and one language's order for both. The joins are small and
     that is exactly why they were invisible: the census only saw punctuation typed between JSX
     children, and a template span is not that. Each language owns its own now. */
  /** A tab or folder, with the number waiting in it. */
  ariaLabelCount: (label: string, count: number): string => `${label}, ${count}`,
  /** A row and the second fact about it — a server's address and what kind of server it is. */
  ariaLabelDetail: (label: string, detail: string): string => `${label}, ${detail}`,
  /** A choice's name and the sentence that IS the choice — see `Doors.tsx`. */
  ariaNameThenSentence: (name: string, say: string): string => `${name}. ${say}`,
  /** The new-subfolder sheet's subtitle, naming the folder it would go inside. */
  folderNewSubIn: (parent: string): string => `New subfolder — ${parent}/`,
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
  /** The Use-folders switch's two positions. English happens to be the same in German. */
  switchOff: "Off",
  switchOn: "On",

  /* ---------------------------------------------------------------- search */

  search: "Search",
  /** More's one honest sentence about it — there is no search screen to route to yet. */
  searchLater: "Arrives in a later update",

  /* -------------------------------------------------------------- settings */

  settings: "Settings",
  theme: "Appearance",
  themeNote: "Follows the system unless set.",
  /* The three segments of the appearance control. They were literals in `app/settings.tsx` — the
     only words on that screen that were not already deck strings — and a control whose options are
     English on a German phone is the most visible untranslated thing an app can have. */
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",

  /**
   * SETTINGS → LANGUAGE — beside Appearance, because they are the same class of decision: how the
   * app is drawn, changing nothing about anybody's mail. The webapp's language row makes the same
   * argument and sits in the same place.
   *
   * THREE segments where the web client has two, and the extra one is the honest default: a phone
   * has a language of its own and this app follows it unless told otherwise, so "System" is a state
   * the control has to be able to express. Without it, choosing English on an English phone would
   * be indistinguishable from never having chosen — and would then keep the app in English if the
   * phone were later switched to German.
   *
   * The SCOPE line says how far the choice reaches, and on a phone the answer is "this app". There
   * is no account write here: the language is stored on the device, so claiming it follows you to a
   * browser would be a claim about a sync that does not happen — the same distinction the webapp
   * draws between `languageHint` and `languageHintLocal`.
   */
  language: "Language",
  languageNote: "Follows this phone unless set. Applies to ohmail on this device.",
  /**
   * THE NAME OF EACH LANGUAGE, IN THAT LANGUAGE — and the one pair of strings the German deck holds
   * identically to this one, on purpose. Somebody looking for their language scans for "Deutsch",
   * not for whatever the language they cannot read calls it; and an English reader is no better
   * served by "German", since the label they are choosing is the one they will then be reading.
   * `test/copy-parity.test.ts` names these as the exception to its own untranslated-string rule.
   */
  languageSystem: "System",
  languageEnglish: "English",
  languageGerman: "Deutsch",
  languageFailed: "Couldn't save that — try again.",

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
  /* ────────────────────────────────────────────────── who organizes this mailbox */

  /*
   * ═══ THE READER BANNER ═══════════════════════════════════════════════════════════════════
   *
   * A phone cannot be the organizer — there is no IMAP client here and no engine dialling a
   * mail server, which is the same fact the three-doors block above is built on. So every
   * decision taken here is carried out somewhere else, and this names where.
   *
   * The first two lines are the onboarding deck's own (`onboarding.phoneBanner` and
   * `phoneBannerWhy` in `apps/webapp/messages/en.json`), which were written for this surface
   * and had no consumer until the phone gained a mailbox read. The third is the mailbox pane's
   * (`mailboxes.readerStopped`) rather than a phone-specific rewrite: "has stopped checking in"
   * is the sentence every other client says for that state, and it is already true of a phone
   * with nothing phone-shaped in it. Byte-equal on purpose, and pinned.
   *
   * WITHHELD unless the server names ONE holder for every mailbox — `live.ts#phoneOrganizer`
   * has the three answers and why two of them are silence.
   */
  phoneBanner: (name: string) => `Organized by ${name}`,
  phoneBannerWhy:
    "This phone reads the mailbox. Decisions are made where it is organized.",
  phoneBannerStopped: (name: string) =>
    `${name} has stopped checking in. Until something organizes this mailbox, new mail waits in the inbox.`,

  about: "About this build",
  /** The build's own name, on the About block. Two shapes — see `src/build-info.ts`. */
  buildVersion: (version: string) => `Version ${version}`,
  buildVersionWithCode: (version: string, build: string) => `Version ${version} (${build})`,
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

  /* --------------------------------------------- organizing in the background */

  /**
   * ═══ THE ANDROID NOTIFICATION, AND THE ONE SENTENCE IT HAS TO KEEP TRUE ═════════════════
   *
   * A standalone phone is the organizer of its mailbox, and Android freezes an app it has put in
   * the background. A foreground service is what keeps this app running there, and its
   * notification is not a courtesy: it is the only surface saying a mailbox is being organized,
   * and dismissing it is how a person ends that. The fourth door promises exactly this —
   * *"It organizes while its notification is shown. Dismiss the notification to stop."*
   *
   * All three strings are read from this deck at the moment the service starts, and handed to the
   * platform. The alternative — Android string resources — would be a second copy of three
   * sentences in two languages, and could not hold the ADDRESS, which is not copy.
   */

  /** The channel's name in system notification settings, and nothing else. */
  stateOrganizing: "Organizing",
  /**
   * The notification's body. The address comes from the mailbox row, and it is the whole point:
   * a person with two phones needs to know WHICH mailbox this one is holding.
   *
   * It does NOT say "tap to stop". A tap opens the app — the platform's convention for every
   * notification anybody has ever touched — and a body promising otherwise would fire the stop
   * from the open-the-app reflex. The stop is the action button beside it.
   */
  notifBody: (address: string): string => `Organizing ${address}.`,
  /** The one action. The words of the desktop's own stop verb, so the two cannot drift. */
  notifStop: "Stop organizing",
  /**
   * BATTERY SAVER, SAID ONCE.
   *
   * Under battery saver — or a per-app background restriction somebody set — Android may kill the
   * service at any moment with nothing anywhere saying why, so this app does not start one: it
   * hands the mailbox back and organizes while it is open, which is the iPhone behaviour and is
   * true on any phone. The sentence names the setting because that is the thing a person can
   * change, and it does not ask them to change it.
   *
   * Shown once per launch rather than at every background: somebody who has battery saver on has
   * it on all day, and a sentence repeated hourly is a sentence nobody reads.
   */
  organizerRestricted:
    "Battery saver does not let ohmail organize in the background on this phone. It organizes "
    + "while the app is open, and hands the mailbox back when you leave.",

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
  /**
   * THE SAME PRESS ON A MAILBOX THIS PHONE DOES NOT ORGANIZE — and it must not say "files".
   *
   * A phone is never the organizer, so a decision made here is recorded for the install that is
   * and applied on its next pass. Nothing has moved and no rule has been written at the moment
   * this is said, which is why it names the machine that owes the work and when rather than
   * reporting a filing. `liveDecided`'s sentence would be a claim about an act that has not
   * happened — the defect this vocabulary exists to keep out of every door.
   */
  liveDecidedElsewhere: (name: string, target: string) =>
    `Decided — ${name} files ${target} on its next pass.`,
  liveDecidedElsewhereUnknown: (target: string) =>
    `Decided — the install that organizes this mailbox files ${target} on its next pass.`,
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
  /** The fifth tab. Its own key rather than {@link actionMore}'s: a destination, not a verb. */
  tabMore: "More",
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
  /**
   * PHONE-ONLY: this phone organizes the mailbox itself, so it keeps no appointments.
   *
   * Rendered on the Scheduled screen and in the composer where Send later would have been.
   * "while ohmail is running on it" rather than "while ohmail is open": Android organizes behind
   * a notification (`phoneStandaloneL1Android`) and iPhone while the app is open, and one
   * sentence has to be true on both. The action names the two places the promise CAN be kept.
   */
  scheduledNotOnThisPhone:
    "This phone organizes your mailbox only while ohmail is running on it, so it cannot hold a message for a later time. Send now, or schedule it from a computer or ohmail Cloud.",
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

  /* ─────────────────────────────── screens the census could not see until it read JSX ─────── */

  /*
   * SEVEN STRINGS THAT WERE JSX TEXT NODES, not literals, and therefore invisible to two
   * generations of the census. `<Section>Piles</Section>` is a heading on screen and a string
   * nowhere. They are here now and the census reads JSX text as a rendering position.
   */
  /** The Screener's reassurance under the held list. */
  screenerNothingDeleted: "Nothing was deleted. Every held message is one tap away, in full.",
  /** A folder, message or sender that is gone by the time the screen opens. */
  folderGone: "That folder is no longer here.",
  messageGone: "That message is no longer here.",
  senderGone: "That sender is no longer in the Screener.",
  /** The sender sheet's note for a sender nothing has got past yet. */
  senderFirstContact:
    "First contact. Nothing from this sender has reached the Ohbox — it waited here.",
  /**
   * THE WHOLE SUGGESTION SENTENCE, in one key, because word order is not ours to assume.
   *
   * This used to be the fragment "is the AI's suggestion at", with the destination rendered
   * BEFORE it by the screen and the score and reason after. English survives that; German does
   * not — the verb moves, and the assembled result read "Ohbox schlägt die KI vor", which says
   * that Ohbox suggests the AI. A sentence assembled from parts by JSX can only ever have one
   * language's grammar.
   *
   * `reason` is the model's own words, arriving from the server. It is quoted rather than
   * translated, for the same reason a platform diagnostic is.
   */
  senderAiSuggestion: (dest: string, confidence: string, reason: string): string =>
    `${dest} is the AI's suggestion at ${confidence}: “${reason}”`,

  /* ───────────────────────────── refusals the seams RETURN, and a screen renders ──────────── */

  /*
   * These were English sentences inside `engine/boot.ts` and `state/install-marker.ts`. Both files
   * were exempted from the census on the strength of their own headers, which said "thrown Errors";
   * they also RETURN `reason` fields that `net/pairing.ts` passes straight to the connect screen,
   * where they appeared under the German "Abgelehnt" heading. A comment is the claim under test,
   * not the evidence for it, and these are the cost of having used one as evidence.
   *
   * They are OUR failures and enumerable, which is what separates them from the platform
   * diagnostics this deck quotes verbatim — see the census's DIAGNOSTIC RULE.
   */
  /*
   * THE ENGLISH HERE IS BYTE-FOR-BYTE WHAT IT WAS IN `engine/boot.ts` AND `state/install-marker.ts`.
   *
   * The first attempt at this move also improved the wording — "the copy on this device" for "the
   * on-device mirror", "sign-in" for "bearer" — and four existing guards went red naming the exact
   * sentences they were written against. They were right to. A slice that adds a language moves a
   * sentence; it does not reword one, because a reworded English sentence is a product change
   * nobody reviewed hiding inside a translation. If "bearer" is the wrong word for a reader, that
   * is its own change with its own reasoning.
   */
  bootBadOrigin: (origin: string) => `not a server origin: "${origin}"`,
  bootBadApiBase: (base: string) => `not a server API base: "${base}"`,
  bootApiBaseOffOrigin: (base: string, origin: string) =>
    `this server's API base "${base}" is not on the paired address "${origin}" — `
    + "re-pair this server to record it again",
  bootLocalEngineOffOrigin: (expected: string, origin: string) =>
    `a standalone install's engine is reached at "${expected}", not at "${origin}" — a caller `
    + "passing both a local engine and a remote address has not decided which of the two it is "
    + "talking to",
  bootNeedsCredential: "a credential and an account id are both required",
  bootAccountMismatch: (serverSays: string, expected: string) =>
    `this bearer belongs to account "${serverSays}", not "${expected}" — check the account id you entered`,
  bootMirrorFailed: (detail: string) => `the on-device mirror could not open: ${detail}`,
  installMarkerUnopenable: (detail: string) =>
    `the install marker could not be opened: ${detail}`,
  installPurgeFailed: (detail: string) =>
    `the old install's pairings could not be purged: ${detail}`,
  installMarkerUnreadable: (detail: string) => `the install marker could not be read: ${detail}`,
  /*
   * THE STANDALONE INSTALL'S ENGINE KEY — three refusals, and none of them takes an argument.
   *
   * `kek.ts` refuses rather than minting a replacement, because every credential on the device is
   * sealed under the key that is there. No argument is deliberate: the value in the slot is a
   * secret, and a sentence that interpolated it would carry it wherever the sentence goes.
   */
  kekUnreadable:
    "This phone's key store holds something that is not a key, so the mailbox password sealed "
    + "under it cannot be opened. ohmail is not replacing it: a new key would lock that password "
    + "away for good. Your mail on the server is untouched — set this phone up for the mailbox "
    + "again to start over.",
  kekNotGenerated:
    "This phone could not generate the key that seals the mailbox password, so nothing was stored "
    + "and nothing was sealed. Nothing on the server changed. Close ohmail and open it again.",
  kekNotKept:
    "This phone's key store took the key that seals the mailbox password and did not give it back, "
    + "so nothing has been sealed under it. Nothing on the server changed. Close ohmail and open "
    + "it again.",
  /**
   * A CONNECTION ATTEMPT THAT LOST A RACE TO A NEWER ONE.
   *
   * It lived in `net/connection.tsx` as a constant whose comment said "never rendered as an error",
   * and the census exempted it on that sentence. Both of its call sites return it as
   * `{ ok: false, reason }`, and Connect and Scan render every failed reason — so it could reach a
   * German screen in English. Translated rather than exempted.
   */
  connectSuperseded: "a newer connection attempt took over.",

  screeningFor: (sender: string) => `Mail from ${sender} goes to`,
  // ── CHANGES THE SERVER WOULD NOT TAKE ──────────────────────────────────────────────────
  // The phone's half of the browser's "could not be saved" strip. Same words on both platforms
  // deliberately: a person who uses both should not have to learn two names for one state.
  unsavedCount: (n: number) => (n === 1 ? "1 change could not be saved" : `${n} changes could not be saved`),
  unsavedShow: "Show them",
  unsavedHide: "Hide",
  unsavedRetry: "Try again",
  unsavedDiscard: "Discard",
  unsavedDismiss: "Dismiss",
  unsavedNoReason: "The server refused it and did not say why.",
  unsavedSuperseded: "A newer change to the same thing has since been saved, so this one cannot be retried.",
  unsavedKindOther: "A change to your mailbox",
  unsavedKindMove: "Filing a message",
  unsavedKindDelete: "Deleting a message",
  unsavedKindTriage: "Setting a message aside",
  unsavedKindScreener: "A Screener decision",
  unsavedKindRead: "Marking mail read",
  unsavedKindSend: "Sending a message",
  unsavedKindDraft: "Saving a draft",
  unsavedKindDraftDiscard: "Discarding a draft",
  unsavedKindSchedule: "Cancelling a scheduled send",
  unsavedKindTag: "A tag change",
  unsavedKindFolder: "A folder change",
  unsavedKindRule: "A rule change",

  screeningNote: (target: string) =>
    `Becomes a rule — future mail from ${target} files there automatically, and what is already here moves.`,
};

/**
 * THE SHAPE EVERY DECK HAS. Strings widen to `string`, functions keep their exact parameter lists,
 * so a translation is checked on both — a missing key, a stray one, and a plural whose count
 * argument was dropped are all compile errors in `copy.de.ts` rather than blank text on a phone.
 */
export type Deck = typeof TABLE;

/** The English deck. The fallback in the register's sense, not merely the default. */
export const EN: Deck = TABLE;
