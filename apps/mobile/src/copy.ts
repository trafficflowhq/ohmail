/**
 * Every string the chrome says, in one place — the phone's copy deck.
 *
 * Blanc's rule is **factual microcopy only**: no slogans, no praise, no
 * invented numbers. Each line here is either verbatim from the canonical
 * prototype (`design/proposals/blanc/index.html`, whose wording the retired
 * macOS client established as the copy deck) or
 * a literal statement of what the app just did. Keeping them together makes
 * that auditable, and keeps the privacy grep to one file's worth of prose.
 *
 * Phone-specific lines are marked. They exist because a thumb does things a
 * cursor did not — nothing here softens or oversells the desktop wording.
 */
export const Copy = {
  /* ---------------------------------------------------------------- status */

  /**
   * The status banner. The default world is still Mila's fixtures and that mode
   * still makes no network request — but the build now carries the real engine
   * behind a manual connect screen, so the old "no network, no sync" sentence
   * would be a claim outliving the code. Say what is true instead.
   */
  previewTitle: "Demo world",
  previewNote:
    "Mila's demo world, rendered from fixtures — not an account, and this mode makes no network requests. Connect to a server (under More) to sync real mail.",

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
  serversEmpty: "No pairings yet. The demo world stays until you add one.",

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
  connectOhbox: (fresh: number, seen: number) => `Ohbox: ${fresh} new · ${seen} earlier`,
  connectSyncFailed: (detail: string) => `Sync failed — the mirror keeps what it has. ${detail}`,

  /* ----------------------------------------------------------------- ohbox */

  ohbox: "Ohbox",
  groupNew: "New",
  groupSeen: "Earlier",
  /* The server-search sentence is DEMO-ONLY: on a live account, search still runs over the
   * demo corpus (see `searchDemoOnly`), so promising it "reaches the rest of your server"
   * would be a claim the app cannot keep. The live tail states only what is on screen. */
  ohboxTail: (shown: number, live = false) =>
    `All ${shown} accepted message${shown === 1 ? "" : "s"} shown.${live ? "" : " Search reaches the rest of your server."}`,
  doorbell: (n: number) => `${n} new sender${n === 1 ? "" : "s"}`,
  doorbellRest: "waiting",
  doorbellGo: "Screener",

  /* --------------------------------------------------------- reads/receipts */

  reads: "Reads",
  receipts: "Receipts",
  waterline: "Seen up to here",
  readsTail: (shown: number) =>
    `All ${shown} issue${shown === 1 ? "" : "s"} shown. Scrolling past an item marks it seen.`,
  receiptsTail: (shown: number, live = false) =>
    `All ${shown} receipt${shown === 1 ? "" : "s"} shown.${live ? "" : " Search reaches older ones on your server."}`,
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
  applyAll: "Apply all suggestions",
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

  /* ---------------------------------------------------------------- triage */

  triage: "Piles",
  replyLater: "Answer Later",
  setAside: "Parked",
  /** The message ACTION, not the pile: a verb on a button, a noun on the rail. */
  park: "Park",
  resurface: "Resurface",
  pileEmpty: "Nothing here yet.",

  /* ------------------------------------------------------------------ tags */

  tags: "Tags",
  tagEmpty: "Nothing carries this tag yet.",
  tagEmptySub: "Open a message and tap a tag to add it.",
  tagsNote: "A tag groups messages across Ohbox, Reads and Receipts without moving them.",

  /* ---------------------------------------------------------------- search */

  search: "Search",
  /** Shown on a LIVE session: this screen still searches the demo corpus, and must say so. */
  searchDemoOnly:
    "This screen searches the demo corpus only — searching your synced mail arrives with a later update.",
  searchPlaceholder: "Search everything — typos welcome",
  searchIndex: "local index",
  searchEmptyTitle: "No local results.",
  searchEmptySub: "This preview searches the fixtures on your device — nothing leaves it.",
  searchIdleTitle: "Search Mila's world.",
  searchIdleSub: "Try “invoce” — the misspelling still finds the invoice.",
  fuzzyNote: (term: string) => `fuzzy match — “${term}”`,
  results: (n: number, ms: number) =>
    `${n} result${n === 1 ? "" : "s"} · ${ms} ms · ${Copy.searchIndex}`,

  /* -------------------------------------------------------------- settings */

  settings: "Settings",
  /** Shown on a LIVE session: every panel below is still the demo world's, and must say so. */
  settingsDemoOnly:
    "These settings are the demo world's — settings for a connected server arrive with a later update. Manage the pairing itself under More → Connect to a server.",
  /** The About block while a session is live — states what is real on this build. */
  aboutLive: (origin: string) =>
    `Paired with ${origin}. Mail syncs into an on-device mirror; reading and triage are live. Search and the settings above still show the demo world.`,
  theme: "Appearance",
  themeNote: "Follows the system unless set.",
  mailboxes: "Mailboxes",
  mailboxesNote: "Mail stays in real folders on these servers.",
  notifications: "Notifications",
  vipHeading: "VIP — always notifies",
  connected: "Connected",
  about: "About this build",

  /* ------------------------------------------------- live world (phone-specific) */

  /** The Ohbox pin group — resurfaced mail, above everything (live accounts only). */
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

  /* -------------------------------------------------------- message actions */

  reply: "Reply",
  routedBy: "Why it landed here",
  earlierInThread: (n: number) => `Earlier in this conversation — all ${n} shown`,
  openMessage: "Open",
  back: "Back",
  undo: "Undo",
} as const;
