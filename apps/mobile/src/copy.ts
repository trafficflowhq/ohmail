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
export const Copy = {
  /* --------------------------------------------------------------- welcome */

  welcomeTitle: "Connect your server",
  welcomeLead:
    "This app is the phone client for an ohmail server — your own, or the ohmail desktop app on your computer. It shows nothing until it is connected: your mail stays on your server, and this phone mirrors it.",
  welcomeHow:
    "Your desktop's Devices screen and a self-hosted server's setup page both show a pairing QR. Scanning it is the whole ceremony — no password is typed here.",
  welcomeScan: "Scan the pairing QR",
  welcomeOther: "Other ways to connect",

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
  serversForgetNote:
    "Forgetting removes the pairing from this phone. The server's Devices list can revoke it there too.",
  serversEmpty: "No pairings yet.",

  choiceManaged: "ohmail (managed)",
  choiceManagedNote: "The hosted service at ohmail.app",
  choiceSelf: "Your own server",
  choiceSelfNote: "A standalone ohmail server you run",
  choiceDesktop: "Your desktop",
  choiceDesktopNote: "Scan the QR in Settings → Devices on your computer",

  askAddress: "Server address",
  askAddressHint: "https, or plain http on your own network",
  askGo: "Check this address",
  askChecking: "Asking the server what it is…",
  stepScan: "Scan its QR",
  stepManual: "Enter a pairing token",
  stepPairOffered: (flavor: string) => `This is an ohmail server (${flavor}) and it pairs devices.`,
  managedDeferred:
    "ohmail.app does not offer device pairing yet — it arrives with a later update. Nothing to do here today.",
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

  pairingBusy: "Pairing…",
  pairedOk: "Paired. Syncing your mail.",

  /* --------------------------------------------------------------- connect */

  connectTitle: "Pair by hand",
  connectNote:
    "Type the server address and the pairing token shown beside its QR — or paste the whole pairing link into the token field.",
  connectOrigin: "Server address",
  connectOriginHint: "https, or plain http on your own network",
  connectToken: "Pairing token",
  connectGo: "Pair",
  connectBooting: "Opening the on-device mirror…",
  connectRefusedTitle: "Refused",
  connectSyncing: "Syncing…",
  connectSyncNow: "Sync now",
  connectDisconnect: "Disconnect",
  connectMirrored: (n: number, cursor: string) =>
    `${n} message${n === 1 ? "" : "s"} on this device · cursor ${cursor}`,
  connectSyncFailed: (detail: string) => `Sync failed — the mirror keeps what it has. ${detail}`,

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
  spamEmptyHint: "Suspected spam waits here for your eyes, never deleted unseen.",

  /* ---------------------------------------------------------------- triage */

  triage: "Piles",
  replyLater: "Answer Later",
  setAside: "Parked",
  /** The message ACTION, not the pile: a verb on a button, a noun on the rail. */
  park: "Park",
  resurface: "Resurface",
  pileEmpty: "Nothing here yet.",

  /* ---------------------------------------------------------------- search */

  search: "Search",
  /** More's one honest sentence about it — there is no search screen to route to yet. */
  searchLater: "Arrives in a later update",

  /* -------------------------------------------------------------- settings */

  settings: "Settings",
  theme: "Appearance",
  themeNote: "Follows the system unless set.",
  about: "About this build",
  /** The About block — states what is real on this build, no more. */
  aboutLive: (origin: string) =>
    `Paired with ${origin}. Mail syncs into an on-device mirror; reading, triage, reply, forward and tags are live. Compose from scratch and search arrive with later updates.`,

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
