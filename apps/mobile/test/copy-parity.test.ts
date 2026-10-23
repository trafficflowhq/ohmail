import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EN, type Deck } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { Copy, DECKS } from "../src/copy";
import { LOCALES, resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";

/**
 * ═══ THE TRANSLATION GUARD ═══════════════════════════════════════════════════════════════════
 *
 * ── WHAT THE COMPILER ALREADY DOES, SO THIS FILE DOES NOT ────────────────────────────────────
 *
 * `copy.de.ts` declares `export const DE: Deck`, and `Deck` is derived from the English table. So
 * a missing key, a stray key and a function whose parameter list differs are BUILD errors, and
 * `pnpm -F mobile typecheck` covers `src/**` — which makes that a real gate rather than an
 * intention. Proven by removing `scanAgain` from the German deck: `tsc` answered
 * `TS2741: Property 'scanAgain' is missing`.
 *
 * The key-set assertion below is kept anyway, and it is not redundant: it is what turns a change to
 * that TYPE into a red test rather than a silently weaker guarantee. Somebody widening `Deck` to
 * `Partial<…>` to get past a half-finished translation would find the compiler happy and this
 * failing, which is the right way round.
 *
 * ── WHAT A TYPE CANNOT SEE, WHICH IS THE REST OF THIS FILE ───────────────────────────────────
 *
 *  · **A SENTENCE LEFT IN ENGLISH.** `de: "Delete folder"` compiles perfectly. Twenty keys are
 *    genuinely identical in both languages and each one is named below with its reason; every
 *    other match is a translation nobody did.
 *  · **A DROPPED INTERPOLATION.** `(n) => "Nachrichten"` compiles and renders a sentence with the
 *    number missing from it. The two decks are compared on WHICH arguments reach the output rather
 *    than on a count of `${`, so a German sentence cannot quietly lose the one value it was about.
 *  · **A PLURAL THAT IGNORES ITS NUMBER.** German inflects the noun where English adds a letter, so
 *    a translation that carried the English `${n === 1 ? "" : "s"}` shape over as a constant would
 *    read "1 Nachrichten". Where the English output CHANGES between one and two, the German one
 *    must change too.
 *  · **AN EMPTY STRING.** A placeholder somebody left unfilled renders a blank line rather than a
 *    sentence, and no type or runtime notices.
 *  · **DRIFT FROM THE WEB CLIENT'S GERMAN.** Where the phone says the same thing the browser says,
 *    it says it in the same words. `folders-parity.test.ts` and `action-parity.test.ts` hold that
 *    for English against `messages/en.json`; this holds the German half against `messages/de.json`,
 *    so a wording change in the catalogue is a red test here rather than a silent divergence
 *    between two surfaces of one product.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const MESSAGES = path.join(HERE, "..", "..", "webapp", "messages");
const catalog = (locale: string) =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8")) as Record<string, unknown>;
const DE_JSON = catalog("de");
const EN_JSON = catalog("en");

const at = (tree: Record<string, unknown>, dotted: string): string => {
  const value = dotted.split(".").reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key], tree,
  );
  if (typeof value !== "string") throw new Error(`the catalogue has no string at ${dotted}`);
  return value;
};

type AnyDeck = Record<string, string | ((...args: never[]) => string)>;
const en = EN as unknown as AnyDeck;
const german = DE as unknown as AnyDeck;
const KEYS = Object.keys(EN).sort();

/**
 * THE STRINGS THAT ARE THE SAME IN BOTH LANGUAGES, each with the reason it is.
 *
 * Every one of them is also the same in the web client's German catalogue, which is where the
 * decision was made — this deck is following it, not making it. A key added here without a reason
 * is the failure the rule exists to catch, so the map holds prose rather than a bare list.
 */
const SAME_IN_BOTH: Record<string, string> = {
  /* The product's own names for its six places. `messages/de.json` leaves all of these as they are
     (`place.ohbox`, `place.reads`, `place.spam`, `screener.title`), and a reader who learned them
     in the browser must not meet different words on a phone. */
  ohbox: "the product's own name for the view",
  placeOhbox: "the product's own name for the view",
  reads: "the product's own name for the view",
  placeReads: "the product's own name for the view",
  segSpam: "spam is the same word in German",
  placeSpam: "spam is the same word in German",
  screener: "the product's own name for the view",
  doorbellGo: "the same name, as the doorbell's destination",
  /* The away responder's pile list names the SAME three places, so it inherits the same rule:
     a reader who learned Ohbox, Reads and Screener in the browser must not meet three other
     words on the one screen that says which of their mail gets answered automatically. */
  awayPileOhbox: "the product's own name for the view",
  awayPileReads: "the product's own name for the view",
  awayPileScreener: "the product's own name for the view",
  /* Brand and interface names. */
  doorCloud: "a product name",
  facePaper: "the name of a face, not a word",
  faceOhmarchy: "the name of a face, not a word",
  actionTag: "the verb and the noun are both Tag in German (ohbox.actionTag)",
  tagsTitle: "the web client's German calls the group Tags too (rail.tags)",
  /* Two-letter interface conventions German shares. */
  folderDismiss: "OK is OK (rail.folderDismiss)",
  languageSystem: "the same word, and the same segment as the control above it",
  pictureQualityOriginal: "Original is Original, as the web's German has it (settings.imageQualityLevel.original)",
  /* A hostname is a hostname. `example.com` is reserved for documentation (RFC 2606), so this
     ghost text can never name anybody's real server, in either language. */
  doorSelfAddressPlaceholder: "a reserved documentation hostname, not a word",
  /* Redaction is dots, in every language. */
  protectedRedacted: "six middle dots",
  /* THE LANGUAGE NAMES, deliberately: somebody looking for their language scans for the name in
     that language, not for what the language they cannot read calls it. The web client's catalogue
     holds `settings.languageName.en` / `.de` identically in both files for this reason. */
  languageEnglish: "a language names itself",
  languageGerman: "a language names itself",
};

/**
 * WHERE THE PHONE AND THE WEB CLIENT SAY THE SAME THING, THEY SAY IT IN THE SAME WORDS.
 *
 * Only keys whose ENGLISH is already held equal to `messages/en.json` by `folders-parity`,
 * `action-parity` or `ohmarchy-face` appear here — the German half of an equality that already
 * exists, never a new claim that two surfaces ought to match.
 */
const SAME_AS_WEBAPP: Record<string, string> = {
  /* The quoted-history toggle — the web body's own pair. */
  bodyHistoryShow: "bodyText.show",
  bodyHistoryHide: "bodyText.hide",
  /* The gate's two named `_meta` refusals — the desktop row's sentences on the phone's strip. */
  phoneStateMetaFolderFull: "sync.blocked_meta_folder_full",
  phoneStateMetaUndeletable: "sync.blocked_meta_undeletable",
  /* The folder verbs — the rail's whole vocabulary. */
  folders: "rail.folders",
  folderEmpty: "rail.folderEmpty",
  folderFilter: "rail.folderFilter",
  folderNoMatch: "rail.folderNoMatch",
  folderShowFewer: "rail.folderShowFewer",
  folderNew: "rail.folderNew",
  folderNewSub: "rail.folderNewSub",
  folderRename: "rail.folderRename",
  folderDelete: "rail.folderDelete",
  folderNamePlaceholder: "rail.folderNamePlaceholder",
  folderRenamePlaceholder: "rail.folderRenamePlaceholder",
  folderCreating: "rail.folderCreating",
  folderDeleting: "rail.folderDeleting",
  folderDismiss: "rail.folderDismiss",
  folderErrRefused: "rail.folderErrRefused",
  folderErrBadName: "rail.folderErrBadName",
  folderErrExists: "rail.folderErrExists",
  folderErrGone: "rail.folderErrGone",
  folderErrNoTrash: "rail.folderErrNoTrash",
  folderErrGotMail: "rail.folderErrGotMail",
  folderNameEmpty: "rail.folderNameEmpty",
  folderNameSpaces: "rail.folderNameSpaces",
  folderNameChars: "rail.folderNameChars",
  folderNameLong: "rail.folderNameLong",
  folderNameReserved: "rail.folderNameReserved",
  folderNameTaken: "rail.folderNameTaken",
  folderDeleteCounting: "rail.folderDeleteCounting",
  folderDeleteConfirmUncounted: "rail.folderDeleteConfirmUncounted",
  folderDeleteGo: "rail.folderDeleteGo",
  folderDeleteCancel: "rail.folderDeleteCancel",
  folderVerbFailed: "rail.folderVerbFailed",
  /* Settings → Folders, and Settings → Look. */
  foldersUseTitle: "settings.folders.useTitle",
  foldersUseOn: "settings.folders.useOn",
  foldersUseOff: "settings.folders.useOff",
  foldersMicrocopy: "settings.folders.microcopy",
  foldersFailed: "settings.folders.failed",
  face: "settings.face",
  faceHint: "settings.faceHint",
  facePaper: "settings.facePaper",
  faceOhmarchy: "settings.faceOhmarchy",
  faceScopeAll: "settings.faceScopeAll",
  faceScopeDevice: "settings.faceScopeDevice",
  faceApplyAll: "settings.faceApplyAll",
  faceFailed: "settings.faceFailed",
  theme: "settings.theme",
  themeLight: "settings.themeLight",
  themeAuto: "settings.themeAuto",
  themeDark: "settings.themeDark",
  language: "settings.language",
  languageFailed: "settings.languageFailed",
  /* The message action bar, word for word. */
  actionReply: "ohbox.actionReply",
  actionReplyAll: "ohbox.actionReplyAll",
  actionForward: "message.menuForward",
  actionLater: "ohbox.actionLater",
  actionSetAside: "ohbox.actionSetAside",
  actionResurface: "ohbox.actionResurface",
  actionMarkRead: "ohbox.actionMarkRead",
  actionMarkUnread: "ohbox.actionMarkUnread",
  actionDone: "ohbox.actionDone",
  actionMore: "ohbox.actionMore",
  actionMove: "ohbox.actionMove",
  actionScreening: "screening.action",
  actionDelete: "ohbox.actionDelete",
  deleteAsk: "ohbox.deleteAsk",
  deleteNote: "ohbox.deleteNote",
  toastDeleted: "ohbox.toastDeleted",
  deleteFailed: "ohbox.deleteFailed",
  resurfaceWhen: "ohbox.resurfaceWhen",
  resurfaceNow: "ohbox.resurfaceNow",
  resurfaceTomorrow: "ohbox.resurfaceTomorrow",
  resurfaceNextWeek: "ohbox.resurfaceNextWeek",
  resurfacePick: "ohbox.resurfacePick",
  moveCancel: "ohbox.moveCancel",
  toastQueued: "ohbox.toastQueued",
  toastUnqueued: "ohbox.toastUnqueued",
  toastAside: "ohbox.toastAside",
  toastUnparked: "ohbox.toastUnparked",
  toastResurfaceCleared: "ohbox.toastResurfaceCleared",
  toastResurfaceNow: "ohbox.toastResurfaceNow",
  groupResurfaced: "ohbox.resurfacedGroup",
  groupSeen: "ohbox.previouslySeen",
  /* The six places, as the move panel names them. */
  placeOhbox: "place.ohbox",
  placeReads: "place.reads",
  placeReceipts: "place.receipts",
  placeScreened: "place.screened",
  placeSpam: "place.spam",
  /* The composer and the scheduled surface. */
  replyPlaceholder: "reply.placeholder",
  replySend: "reply.send",
  replyCancel: "reply.cancel",
  replySent: "reply.toastSent",
  replyQueued: "reply.statusQueued",
  replySendingLong: "reply.statusSendingLong",
  replyUnverified: "reply.statusUnverified",
  /* The queued row's why — phone-specific in English, registered below. */
  unsavedQueuedWhy: "sync.unsavedQueuedWhy",
  forwardHead: "reply.forwardHead",
  forwarded: "reply.toastForwarded",
  sendLater: "compose.sendLater",
  sendLaterWhat: "compose.sendLaterWhat",
  sendLaterPick: "compose.sendLaterPick",
  sendLaterClose: "compose.sendLaterClose",
  sendLaterPast: "compose.sendLaterPast",
  sendLaterUnavailable: "compose.sendLaterUnavailable",
  scheduled: "drafts.scheduledTitle",
  scheduledCancel: "drafts.scheduledCancel",
  scheduledNoSubject: "drafts.noSubject",
  scheduledNoRecipient: "drafts.noRecipient",
  scheduleCancelled: "drafts.scheduleCancelled",
  scheduleCancelTooLate: "drafts.scheduleCancelTooLate",
  scheduleCancelQueued: "drafts.scheduleCancelQueued",
  sigLabel: "compose.signature",
  sigRemove: "compose.signatureRemove",
  sigAria: "compose.signatureAria",
  /* Tags, the Screener's segments, and the banner a reader sees. */
  tagPlaceholder: "tag.pickerPlaceholder",
  tagNone: "tag.pickerNone",
  tagNotOnServer: "tag.notOnServer",
  segScreened: "screener.segScreened",
  segSpam: "screener.segSpam",
  waitingEmptyTitle: "screener.empty.waiting.title",
  waitingEmptyHint: "screener.empty.waiting.hint",
  /* HISTORY — the place's name, its rail subtitle, its explainer and its empty state. The
     phone's `history` key covers all three of the browser's spellings of the word
     (`rail.history`, `history.title`, `history.placeChip`, identical in both catalogues), so the
     rail entry is the one this is held against. The counted lines (`historyMeta`, `historyTail`)
     are functions rather than ICU strings and are not comparable here — the plural and
     interpolation checks above cover them. */
  history: "rail.history",
  historyNavSub: "rail.historySubtitle",
  historyExplainer: "history.explainer",
  historyExplainerMore: "history.explainerMore",
  historyExplainerMoreLabel: "history.explainerMoreLabel",
  historyEmptyTitle: "history.emptyTitle",
  historyEmptyHint: "history.emptyHint",
  historyLoading: "history.loading",
  historyStoreUnavailable: "history.storeUnavailable",
  historyStoreRetry: "history.storeRetry",
  historyUndated: "history.railUndated",
  searchEmptyTitle: "search.emptyTitle",
  searchIndexing: "search.emptyTitleIndexing",
  searchWholeSearching: "search.scopeWholeSearching",
  searchUnanswered: "search.scopeUnanswered",
  searchWholeRetry: "search.scopeWholeRetry",
  phoneBannerWhy: "onboarding.phoneBannerWhy",
  waterline: "reads.waterline",
  search: "search.title",
  settings: "settings.title",
  receipts: "receipts.title",
  /* The event card's words (`IcsEventCard`). */
  icsRequest: "icsEvent.request",
  icsCounter: "icsEvent.counter",
  icsCancelled: "icsEvent.cancelled",
  icsAccepted: "icsEvent.accepted",
  icsDeclined: "icsEvent.declined",
  icsTentative: "icsEvent.tentative",
  icsReply: "icsEvent.reply",
  icsEvent: "icsEvent.event",
  icsAllDay: "icsEvent.allDay",
  icsPreviously: "icsEvent.previously",
  icsDaily: "icsEvent.daily",
  icsWeekly: "icsEvent.weekly",
  icsMonthly: "icsEvent.monthly",
  icsYearly: "icsEvent.yearly",
  replyLater: "rail.replyLater",
  setAside: "rail.setAside",
  resurface: "rail.resurface",
};

/* ── the parameter types, read from the English deck's own source ────────────────────────────── */

/**
 * WHAT ARGUMENTS TO CALL EACH FUNCTION KEY WITH, DERIVED RATHER THAN LISTED.
 *
 * A hand-written table of sample arguments is the obvious way and it rots: a function key added to
 * the deck without an entry is simply not exercised, and nothing says so. So the signatures are
 * parsed out of `copy.en.ts` — the file that defines the shape both decks have — and every function
 * key is called whether or not anybody remembered it. A signature this parser cannot read fails the
 * test rather than being skipped, which is the same rule in the other direction.
 */
function parameterTypes(source: string, key: string): string[] {
  const start = source.indexOf(`\n  ${key}: (`);
  if (start < 0) return [];
  const open = source.indexOf("(", start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) throw new Error(`unbalanced parameter list for ${key}`);
  const inner = source.slice(open + 1, close).trim();
  if (inner === "") return [];
  return inner.split(",").map((p) => {
    const m = /:\s*([A-Za-z]+)\s*$/.exec(p.trim());
    if (m === null) throw new Error(`cannot read the type of "${p.trim()}" in ${key}`);
    return m[1]!;
  });
}

const SOURCE = fs.readFileSync(path.join(SRC, "copy.en.ts"), "utf8");

/**
 * ONE DISTINCTIVE SAMPLE PER POSITION, for every parameter kind — not only for strings.
 *
 * The first version marked string positions and passed numbers as a bare count. That left two holes
 * a translation could fall through and a review found both: a German function that DROPPED its
 * number entirely still matched, because only string markers were compared; and booleans were only
 * ever sampled `true`, so the false branch of every two-armed sentence was never rendered at all —
 * `connectSyncFailed(detail, pinned)` had one of its two arms untested in both languages.
 *
 * Numbers are sampled as a prime nobody would write into a sentence, so finding it in the output is
 * proof the argument reached it rather than a coincidence with a digit in the copy.
 */
const marker = (i: number): string => `«arg${i}»`;
/**
 * A DISTINCT PRIME PER NUMERIC POSITION, because one shared number cannot tell them apart.
 *
 * Round two: every numeric position was handed the same `7919`, so a two-argument sentence could
 * drop one of them and the surviving occurrence still satisfied both positions —
 * `folderDeleteConfirm(messages, folders)` is the live shape. Distinct primes make each position's
 * presence its own observation, and nothing in the copy contains these digits by coincidence.
 */
const PRIMES = [7919, 6323, 5077, 4093, 3221, 2477];
const NUM_ONE = 1;
const numberFor = (i: number): number => PRIMES[i % PRIMES.length]!;

/**
 * ONE numeric position is perturbed at a time — to 1, or to 0 — and the rest are left many.
 *
 * ZERO WAS NEVER SAMPLED. English and German both use the plural form for none, which is exactly
 * why it is easy to write a third arm for it in one language and not the other, or to write one
 * that renders nothing. "1 and many" is two thirds of the domain a counted sentence has.
 */
/**
 * CLOSED-SET parameters, sampled MEMBER BY MEMBER for the boolean lesson's reason: a deck whose
 * third arm is an English sentence renders it only when that arm is asked for. The members are
 * read out of the union's own declaration rather than typed here, so a member added to it is
 * sampled by this harness instead of silently skipping an arm.
 */
function unionMembers(file: string, name: string): string[] {
  const src = fs.readFileSync(path.join(SRC, file), "utf8");
  const decl = new RegExp(`export type ${name} =([^;]*);`).exec(src)?.[1] ?? "";
  return [...decl.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const UNION_SAMPLES: Record<string, readonly string[]> = {
  BackupExclusion: unionMembers("engine/backup-exclusion.ts", "BackupExclusion"),
  UnsubSaid: unionMembers("state/unsub-arms.ts", "UnsubSaid"),
  UnsubToast: unionMembers("state/unsub-arms.ts", "UnsubToast"),
};

interface Sample { bool: boolean; singularAt?: number; zeroAt?: number; unionArm?: number }

/** Every scenario a signature needs: both boolean arms, times every closed-set member. */
function armsFor(types: string[]): Sample[] {
  const base: Sample[] = types.includes("boolean")
    ? [{ bool: true }, { bool: false }]
    : [{ bool: true }];
  const union = types.find((t) => t in UNION_SAMPLES);
  if (union === undefined) return base;
  const members = UNION_SAMPLES[union]!.length;
  if (members === 0) throw new Error(`${union}: the union read empty, so every arm would be skipped`);
  return base.flatMap((b) => Array.from({ length: members }, (_, k) => ({ ...b, unionArm: k })));
}

/** The number a position is handed under a given scenario. */
const numberAt = (s: Sample, i: number): number =>
  (s.zeroAt === i ? 0 : s.singularAt === i ? NUM_ONE : numberFor(i));

function callWith(fn: (...args: never[]) => string, types: string[], s: Sample): string {
  const args = types.map((t, i) => {
    if (t === "number") return numberAt(s, i);
    if (t === "boolean") return s.bool;
    if (t === "string") return marker(i);
    const members = UNION_SAMPLES[t];
    if (members !== undefined) return members[(s.unionArm ?? 0) % members.length]!;
    throw new Error(`no sample for parameter type ${t}`);
  });
  return fn(...(args as never[]));
}

/**
 * WHICH ARGUMENTS ACTUALLY REACHED THE OUTPUT — the shape a translation must preserve.
 *
 * A string position counts when its marker appears; a number position counts when the sampled
 * number appears. Both are reported by index, so English and German are compared on the same
 * footing and a dropped value on either side is a difference.
 */
function argsIn(out: string, types: string[], s: Sample): number[] {
  return types.flatMap((t, i) => {
    if (t === "string") return out.includes(marker(i)) ? [i] : [];
    if (t === "number") {
      return out.includes(String(numberAt(s, i))) ? [i] : [];
    }
    return [];
  });
}

describe("the phone's two copy decks", () => {
  it("reads every member of a closed-set parameter — an empty read would skip every arm", () => {
    // Anti-vacuity for `armsFor`: the members come from the union's own declaration, so a rename
    // there would leave this harness sampling nothing and passing for it.
    for (const [name, members] of Object.entries(UNION_SAMPLES)) {
      expect(members.length, `${name}: read no members out of its declaration`).toBeGreaterThan(1);
    }
    expect(UNION_SAMPLES.BackupExclusion).toEqual(["excluded", "included", "unknown"]);
  });

  it("hold exactly the same keys, and there are more than three hundred of them", () => {
    expect(Object.keys(DE).sort()).toEqual(KEYS);
    /* Not an arbitrary floor: it is the deck's real size, and a deck that suddenly halved would be
       a merge that dropped a section rather than a translation anybody did. */
    expect(KEYS.length).toBeGreaterThan(300);
  });

  it("offer one deck per member of the closed locale set, and nothing else", () => {
    expect(Object.keys(DECKS).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) expect(Object.keys(DECKS[locale])).toHaveLength(KEYS.length);
  });

  it("agree on which keys are sentences and which are functions", () => {
    for (const key of KEYS) {
      expect(typeof german[key], `${key} is a different kind of member in German`)
        .toBe(typeof en[key]);
    }
  });

  it("has no empty German string — a blank is a placeholder nobody filled", () => {
    const blank = KEYS.filter((k) => typeof german[k] === "string" && (german[k] as string).trim() === "");
    expect(blank).toEqual([]);
  });

  it("translates every sentence except the ones that are the same word in both languages", () => {
    const untranslated = KEYS.filter(
      (k) => typeof en[k] === "string" && en[k] === german[k] && !(k in SAME_IN_BOTH),
    );
    expect(untranslated, "these read as English on a German phone").toEqual([]);
    /* …and the exemption list may not rot into a dumping ground: every name on it must still BE a
       pair of identical strings. A key whose German diverged later would otherwise keep a licence
       it no longer needs, and the next person would read the reason as still true. */
    for (const key of Object.keys(SAME_IN_BOTH)) {
      expect(en[key], `${key} is exempted but no longer identical — drop it from SAME_IN_BOTH`)
        .toBe(german[key]);
    }
  });

  /**
   * FUNCTION KEYS THAT ARE THE SAME SENTENCE IN BOTH LANGUAGES, each with its reason.
   *
   * The untranslated check below covers string keys; a function key whose German body is a
   * byte-for-byte copy of the English one used to pass everything — argument shape matched,
   * output was non-blank — so a complete English sentence could ship inside a function. These are
   * the ones that legitimately render identically for a sampled call.
   */
  /**
   * KEYS WHOSE TWO DECKS LEGITIMATELY RENDER THE SAME TEXT — and, where it matters, WHICH ARM.
   *
   * Checking both boolean arms turned up two keys that are correctly translated on `true` and
   * carry no words at all on `false` (`decideAria` renders ", suggested" / ", vorgeschlagen"
   * when true, and the bare argument when false). A whole-key exemption for those would license
   * the `true` arm back to English — closing one hole by opening the one next to it. So an entry
   * may name the single arm it excuses; `arm` absent means the key has no boolean at all.
   */
  const SAME_OUTPUT_IN_BOTH: Record<string, { arm?: boolean; why: string }> = {
    serversForgetFailed: { why: "returns its argument unchanged — the sentence is the caller's" },
    aiSuggests: { why: "a place name and a number, with no words of its own" },
    folderInMailbox: { why: "a folder's name and a mailbox's label in brackets, with no words of its own" },
    doorbellMore: { why: "a plus sign and a number — the faces the doorbell stack did not draw, "
      + "with no word in it to translate" },
    buildVersion: { why: "the word Version is the same in both, and the rest is a number" },
    searchServerMs: { why: "a number and the unit ms, the same symbol in both languages" },
    buildVersionWithCode: { why: "the same, with the build number" },
    buildCommit: { why: "the German About heading already says Build, and the rest is a commit "
      + "id — a value a rig matches character for character, so translating it would break it" },
    verbatimDetail: { why: "returns its argument unchanged — it IS the pass-through, the one key "
      + "whose job is to carry somebody else's words into a translated sentence" },
    storeFault: { why: "a marker argument falls to both decks' default arm by design; every real "
      + "code is compared in its own case below, which is the assertion that matters" },
    /* The three screen-reader joins: each is punctuation around values the caller supplies, and
       has no word of its own to translate. They exist so each language OWNS that punctuation. */
    ariaLabelCount: { why: "a label and a number joined by a comma — no words of its own" },
    screeningRuleLine: { why: "a rule's condition and its place joined by an arrow — no words of its own" },
    ariaLabelDetail: { why: "two caller-supplied values joined by a comma — no words of its own" },
    trashFromLine: { why: "a name and an address joined by a middle dot — no words of its own" },
    autoFiledRow: { why: "a sender, a subject and a pile joined by middle dots, and the one word "
      + "between them, \"in\", is the same word in German" },
    ariaNameThenSentence: { why: "a name and a sentence the caller already translated, joined by "
      + "a full stop — no words of its own" },
    metaWithReason: { why: "a count and the sentence qualifying it, both already translated, joined "
      + "by a full stop — no words of its own" },
    /* ARM-SCOPED. Both are translated on `true`; the `false` arm renders the bare arguments. */
    decideAria: { arm: false, why: "the false arm is the destination alone, with no word added; "
      + "the true arm renders \", suggested\" / \", vorgeschlagen\" and is still compared" },
    mailRowAria: { arm: false, why: "the false arm is sender, subject and time with no word "
      + "added; the true arm renders \" Unread.\" / \" Ungelesen.\" and is still compared" },
  };
  /* Four names came off this list the moment the rot check ran: `helloStatus`, `doorSelfReached`
     and `doorSelfApiUnder` ARE translated and never rendered identically, and listing them would
     have licensed a future regression to English. The list is now the two that genuinely are. */

  /**
   * KEYS THAT BRANCH ON WHAT A STRING SAYS — the arms a generic marker can never reach.
   *
   * `callWith` hands every string position the same `«argN»`. For a sentence that only
   * interpolates its argument that is exactly right. For one that ASKS something about it —
   * `connectSyncFailed` calls `isPinFailure(detail)` — the marker satisfies nothing, both boolean
   * samples fall down the same generic arm, and the two certificate branches could be replaced
   * with English or left blank with every assertion still green.
   *
   * The branching keys are found by reading the deck's own source, so a NEW one fails here until
   * somebody supplies values that reach its arms. The table is the maintained part and that is
   * deliberate: a probe value is a fact about what the code tests for, and guessing it is how a
   * sampler quietly stops reaching a branch.
   */
  const STRING_BRANCH_PROBES: Record<string, readonly string[]> = {
    connectSyncFailed: [
      /* takes `isPinFailure` — the platform's own handshake wording, which is what ships */
      "javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found",
      "ECONNRESET",                                    // …and the arm that is not a pin failure
    ],
    /* the one value it tests for, and one that is not it */
    wakeOff: ["endpoint_refused", "no_distributor"],
    /* THE FIVE ARMS OF THE PAIRING CONFIRMATION'S "what answered" LINE, one value each. The
       four flavors are `/hello`'s own vocabulary (`net/pairing.ts`, `state/servers.ts#flavor`);
       the fifth is a flavor this build has never heard of, whose arm names it verbatim rather
       than guessing — the one arm a generic marker WOULD have reached, which is why listing only
       it would have left the other four in English unnoticed. */
    pairConfirmWhat: ["local", "desktop-host", "selfhost", "managed", "a-later-flavor"],
  };

  /** Deck functions whose body asks something about one of their own string parameters. */
  const branchingKeys = (): string[] => {
    const out: string[] = [];
    const re = /^  (\w+): \(([^)]*)\)(?::\s*string)?\s*=>\s*([\s\S]*?)(?=^  \w+:|\Z)/gm;
    for (const m of SOURCE.matchAll(re)) {
      const [, key, params, body] = m;
      const names = (params ?? "").split(",")
        .filter((p) => p.includes(":") && p.split(":")[1]!.includes("string"))
        .map((p) => p.split(":")[0]!.trim());
      for (const n of names) {
        if (n === "") continue;
        const asks = new RegExp(`\\b\\w+\\(\\s*${n}\\s*\\)|${n}\\s*(===|!==|\\.includes|\\.startsWith|\\.test)`);
        if (asks.test(body ?? "")) { out.push(key!); break; }
      }
    }
    return out;
  };

  it("has a probe value for every key that asks something about its own argument", () => {
    const found = branchingKeys();
    expect(found.length, "no branching key was detected, so the probes prove nothing")
      .toBeGreaterThan(0);
    for (const k of found) {
      expect(STRING_BRANCH_PROBES[k],
        `${k} branches on a string argument and has no probe values — a generic marker cannot `
        + "reach its arms, so its German is unchecked").toBeDefined();
    }
  });

  it("translates BOTH arms of a sentence that asks about its argument", () => {
    for (const [key, probes] of Object.entries(STRING_BRANCH_PROBES)) {
      const types = parameterTypes(SOURCE, key);
      const enFn = en[key] as (...a: never[]) => string;
      const deFn = german[key] as (...a: never[]) => string;
      const seen = new Set<string>();
      for (const probe of probes) {
        for (const b of (types.includes("boolean") ? [true, false] : [true])) {
          const args = types.map((t, i) => (t === "string" && i === 0 ? probe
            : t === "boolean" ? b : t === "number" ? numberFor(i) : marker(i)));
          const a = enFn(...(args as never[]));
          const g = deFn(...(args as never[]));
          expect(g.trim(), `${key} renders nothing in German for ${JSON.stringify(probe)}`)
            .not.toBe("");
          /*
           * THE ARM'S OWN WORDS, ISOLATED. Comparing the whole outputs is not enough when an arm
           * interpolates a constant the decks translate separately: reverting the German prefix
           * of `connectSyncFailed`'s pinned arm to English still produced a string that differed
           * from the English one, because `pinChanged` after it differed. Measured — the mutation
           * passed. So every deck STRING is blanked from its own side, along with the probe, and
           * what remains is the sentence this arm contributes.
           */
          const strip = (text: string, deck: Record<string, unknown>): string => {
            let t = text.split(probe).join("§");
            for (const [k, v] of Object.entries(deck)) {
              if (typeof v === "string" && v.length > 12) t = t.split(v).join(`§${k}§`);
            }
            return t;
          };
          expect(strip(g, german as Record<string, unknown>),
            `${key}: this arm's own words read the same in both languages for `
            + `${JSON.stringify(probe)} — it is untranslated`)
            .not.toBe(strip(a, en as Record<string, unknown>));
          seen.add(g);
        }
      }
      expect(seen.size, `${key}: every probe produced the same German — the arms are not reached`)
        .toBeGreaterThan(1);
    }
  });

  it("translates FUNCTION keys too — an English body copied across used to pass", () => {
    /*
     * The hole round three named: only string members were compared for sameness. A German
     * function whose body is the English one renders English for every input and satisfied the
     * argument-shape and non-blank checks. Sampled outputs are compared now, with the handful of
     * genuinely identical renderings named above.
     */
    /*
     * BOTH BOOLEAN ARMS. This sampled `true` only, and the separate boolean case merely requires
     * the German's two arms to DIFFER FROM EACH OTHER — so a German `false` arm replaced with the
     * exact English sentence satisfied both, and a German screen reader would read English for
     * the collapsed state. A two-armed sentence is two sentences and each is checked.
     */
    const identical: string[] = [];
    for (const key of KEYS) {
      if (typeof en[key] === "string") continue;
      const types = parameterTypes(SOURCE, key);
      const arms: Sample[] = armsFor(types);
      for (const s of arms) {
        const ex = SAME_OUTPUT_IN_BOTH[key];
        /* An entry with no `arm` excuses the key; one with an `arm` excuses only that arm. */
        if (ex !== undefined && (ex.arm === undefined || ex.arm === s.bool)) continue;
        const a = callWith(en[key] as (...x: never[]) => string, types, s);
        const b = callWith(german[key] as (...x: never[]) => string, types, s);
        const label = types.includes("boolean") ? `${key} (bool=${String(s.bool)})` : key;
        if (a === b && !identical.includes(label)) identical.push(label);
      }
    }
    expect(identical, "these render the same English sentence in both decks").toEqual([]);
    /* …and the exemption list may not rot: every name on it must still BE identical. */
    for (const [key, ex] of Object.entries(SAME_OUTPUT_IN_BOTH)) {
      const types = parameterTypes(SOURCE, key);
      const arms: Sample[] = ex.arm === undefined ? armsFor(types) : [{ bool: ex.arm }];
      for (const s of arms) {
        expect(
          callWith(en[key] as (...x: never[]) => string, types, s),
          `${key} is exempted${ex.arm === undefined ? "" : ` on bool=${String(ex.arm)}`} but no `
          + "longer renders identically — drop the entry",
        ).toBe(callWith(german[key] as (...x: never[]) => string, types, s));
      }
    }
  });

  it("translates every store-fault code, and knows an unknown one is not translated", () => {
    /*
     * `storeFault` maps an enumerable failure code to a sentence, so the generic sampler above
     * cannot judge it: handed a marker it falls to the default arm in both decks and renders the
     * same string. That is correct behaviour and a useless observation, so the real question is
     * asked here — every code the store can throw must read differently in the two languages.
     *
     * The code list is read from `state/servers.ts` rather than restated, so a code added there
     * without a sentence fails here instead of reaching a screen as a bare identifier.
     */
    const src = fs.readFileSync(path.join(SRC, "state/servers.ts"), "utf8");
    const block = /export type StoreFaultCode =([\s\S]*?);/.exec(src)?.[1] ?? "";
    /* DIGITS. `[a-z_]+` silently skipped any code with a number in it — `index_v2_unreadable`
       would have been omitted from this census, kept the count floor satisfied, and reached a
       German screen as its own bare identifier. The union's own alphabet is what is read. */
    const codes = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    /* …and the census must have found ALL of them: a regex that matches a subset answers every
       assertion below about the subset it happened to match. */
    const quoted = (block.match(/"/g) ?? []).length / 2;
    expect(codes.length, `the union holds ${quoted} quoted codes and the census read `
      + `${codes.length} — the pattern is narrower than the alphabet`).toBe(quoted);
    expect(codes.length, "no StoreFaultCode union found in state/servers.ts").toBeGreaterThan(10);

    const enFn = en.storeFault as (c: string) => string;
    const deFn = german.storeFault as (c: string) => string;
    for (const code of codes) {
      expect(enFn(code), `${code} has no English sentence — it renders as its own identifier`)
        .not.toBe(code);
      expect(deFn(code), `${code} has no German sentence`).not.toBe(code);
      expect(deFn(code), `${code} reads the same in both languages`).not.toBe(enFn(code));
    }
    /* …and the default arm is deliberate: a code from a newer store is shown rather than dropped. */
    expect(enFn("a_code_from_the_future")).toBe("a_code_from_the_future");
    expect(deFn("a_code_from_the_future")).toBe("a_code_from_the_future");
  });

  it("compares BOTH boolean arms, rather than merely invoking them", () => {
    /*
     * `argsIn` never reported boolean positions, so a German function that ignored its boolean —
     * or collapsed both arms into one sentence — passed: both samples were non-blank and the
     * argument shapes matched. Where ENGLISH renders differently for true and false, German must
     * too, which is the same rule the plural check applies to numbers.
     */
    for (const key of KEYS) {
      if (typeof en[key] === "string") continue;
      const types = parameterTypes(SOURCE, key);
      if (!types.includes("boolean")) continue;
      const fn = en[key] as (...x: never[]) => string;
      const gfn = german[key] as (...x: never[]) => string;
      if (callWith(fn, types, { bool: true }) === callWith(fn, types, { bool: false })) continue;
      expect(
        callWith(gfn, types, { bool: true }),
        `${key} reads the same for both arms in German — one of them is unreachable`,
      ).not.toBe(callWith(gfn, types, { bool: false }));
    }
  });

  it("keeps every interpolation the English sentence has, and invents none", () => {
    for (const key of KEYS) {
      if (typeof en[key] !== "string") {
        const types = parameterTypes(SOURCE, key);
        expect(types.length, `${key}: no parameter list found in copy.en.ts`).toBeGreaterThan(0);
        /* BOTH boolean branches, because a two-armed sentence is two sentences and the false arm
           was never rendered before. */
        for (const s of armsFor(types)) {
          const bool = s.bool;
          const fromEn = callWith(en[key] as (...a: never[]) => string, types, s);
          const fromDe = callWith(german[key] as (...a: never[]) => string, types, s);
          expect(argsIn(fromDe, types, s), `${key} drops or invents an argument (bool=${bool})`)
            .toEqual(argsIn(fromEn, types, s));
          expect(fromDe.trim(), `${key} renders nothing in German (bool=${bool})`).not.toBe("");
        }
      }
    }
  });

  it("inflects for number wherever English does", () => {
    for (const key of KEYS) {
      if (typeof en[key] === "string") continue;
      const types = parameterTypes(SOURCE, key);
      if (!types.includes("number")) continue;
      /*
       * ONE POSITION AT A TIME. Varying every number together let a sentence with two of them
       * collapse one plural branch while the other still changed the output, and the check passed.
       * Each numeric position is now driven to 1 on its own, with the rest left many, so each
       * plural branch is observed by itself.
       */
      const fn = en[key] as (...a: never[]) => string;
      const gfn = german[key] as (...a: never[]) => string;
      /*
       * LONGEST SAMPLE FIRST. Blanking replaces each position's number with a marker, and one of
       * the primes is 4093 — which CONTAINS a zero. Replacing a zero-sampled position first would
       * eat the 0 inside 4093 and leave "409#i", so two outputs that differ would compare equal
       * and the check would pass over a real difference. Descending length makes every
       * replacement unambiguous.
       */
      const blank = (out: string, s: Sample) => {
        const subs = types
          .map((t, i) => (t === "number" ? { i, text: String(numberAt(s, i)) } : null))
          .filter((x): x is { i: number; text: string } => x !== null)
          .sort((a, b) => b.text.length - a.text.length);
        return subs.reduce((acc, { i, text }) => acc.split(text).join(`#${i}`), out);
      };
      types.forEach((t, i) => {
        if (t !== "number") return;
        const many: Sample = { bool: true };
        for (const [what, s] of [
          ["one", { bool: true, singularAt: i } as Sample],
          ["none", { bool: true, zeroAt: i } as Sample],
        ] as const) {
          /* Only where ENGLISH itself changes shape — several keys simply print the number
             (`aiSuggests`, `helloStatus`) and have no plural to get wrong, and English has no
             separate arm for none in most of them either. */
          if (blank(callWith(fn, types, s), s) === blank(callWith(fn, types, many), many)) continue;
          /* A BLANK arm satisfied "differs from many" while rendering nothing at all. Every
             perturbed sample is required to be a sentence, not merely a different string. */
          expect(callWith(gfn, types, s).trim(),
            `${key} renders nothing for ${what} at argument ${i}`).not.toBe("");
          expect(
            blank(callWith(gfn, types, s), s),
            `${key} reads the same for ${what} and for many at argument ${i} — "1 Nachrichten"`,
          ).not.toBe(blank(callWith(gfn, types, many), many));
        }
      });
    }
  });

  /**
   * THE EQUALITY IS CONDITIONAL ON THE ENGLISH ONE, WHICH IS WHAT KEEPS IT HONEST.
   *
   * The claim is "where the phone and the browser say the same thing, they say it in the same
   * words" — so the German sides are compared only where the ENGLISH sides already agree. Three
   * keys are deliberately phone-specific in English and are named below; asserting their German
   * against the catalogue would have demanded a translation of a sentence the phone does not say.
   *
   * The partition is asserted rather than assumed. A key that quietly drifted in English would
   * otherwise drop out of the German check with nothing said — the silent-skip failure this whole
   * file exists to prevent, reproduced inside the file itself.
   */
  /**
   * KEYS WHOSE GERMAN DELIBERATELY DIVERGES FROM THE WEB CATALOGUE, with the reason.
   *
   * The rule is still "where the two surfaces say the same thing, they say it in the same words".
   * This is where the web client's German is WRONG and the phone is not going to copy it: a place
   * name after a preposition that needs a case the name cannot carry. Filed to be fixed on the web
   * side; until then a divergence that is right beats a match that is wrong. (`toastMoved` was the
   * second: the web key it diverged from is retired, so there is nothing left to diverge from and
   * the phone's own sentence stands alone.)
   */
  const DIVERGES_DELIBERATELY: Record<string, string> = {
    moveLabel: "ohbox.moveLabel says 'verschieben nach' directly above the destination rows",
  };

  const ENGLISH_DIFFERS: Record<string, string> = {
    theme: "the phone's control is Appearance; the browser's is Theme",
    waitingEmptyTitle: "the phone says 'Nobody is waiting.', the browser 'No one’s waiting.'",
    waitingEmptyHint: "the phone's senders KNOCK, and reach YOUR Ohbox — phone-specific wording",
    /**
     * A SURFACE FACT, not a wording preference: THE BROWSER HOLDS THE SEND AND THE PHONE DOES NOT.
     *
     * `reply.statusUnverified` says "It's held here under the same send", and on the web that is
     * true: `holdOf` (`webapp/app/shell/send-lock.ts`) reads an `unverified` row as `parked`, and
     * the send lock is deliberately NOT released for that phase (`mail-send.ts`: "unverified is
     * NOT one of the terminals that spends the key" — the key is kept so a retry reuses it and the
     * server replays the original outcome), durably, across a reload and other tabs.
     *
     * The phone keeps no such hold. An interactive `send_unverified` is an explicit refusal, and
     * the engine drops the durable outbox entry with it (`client-engine/src/engine.ts`: "the
     * durable entry goes with it"); `sent()` in `state/live.ts` returns a key for `queued` ALONE;
     * and the composer's lock is component state that dies with the sheet
     * (`ui/MessageActions.tsx`). So nothing is held anywhere under that key, and the next send the
     * reader makes is a fresh one — which is exactly what "check your Sent folder before sending
     * it again" warns about. Saying "held here under the same send" on this surface would be a
     * false claim about a duplicate the phone cannot prevent.
     */
    replyUnverified: "the browser HOLDS an unverified send under its key (holdOf parks the row, the"
      + " lock survives a reload, a retry reuses the key); the phone drops the durable entry with"
      + " the refusal and keeps no key, so its sentence warns about sending again instead of"
      + " claiming a hold this surface does not have",
    /* A SURFACE FACT: the browser says "This browser could not reach…"; on the phone that is a
       false name for the device holding the queue. The sentence is otherwise the same. */
    unsavedQueuedWhy: "the device that could not reach the account is the phone, not a browser: the"
      + " phone's why names this phone, the web's names the browser",
  };

  it("keeps the doorbell's verb agreeing with its count", () => {
    /*
     * A REGRESSION, FOUND ON A DEVICE AND NOT HERE: a tail that could not see the number read
     * "357 neue Absender wartet". Asserted in the shape `ui/chrome.tsx` renders, count and tail.
     */
    const doorbell = german.doorbell as (n: number) => string;
    const rest = german.doorbellRest as (n: number) => string;
    const phrase = (n: number) => `${doorbell(n)} ${rest(n)}`;
    expect(phrase(1)).toBe("1 neuer Absender wartet");
    expect(phrase(357)).toBe("357 neue Absender warten");
  });

  it("records every deliberate divergence from the web catalogue, with its reason", () => {
    for (const [key, why] of Object.entries(DIVERGES_DELIBERATELY)) {
      expect(KEYS, `${key} is listed as diverging but is not a deck key`).toContain(key);
      expect(why.length, `${key} diverges without a reason`).toBeGreaterThan(20);
      /* …and it must ACTUALLY diverge: a name here whose German has drifted back to the web
         catalogue's wording is a licence nobody needs, and hides the day it drifts. */
      const dotted = { moveLabel: "ohbox.moveLabel" }[key];
      if (dotted === undefined) continue;
      const web = at(DE_JSON, dotted);
      const mine = typeof german[key] === "function"
        ? (german[key] as (x: string) => string)("«place»")
        : german[key] as string;
      expect(mine, `${key} no longer diverges — drop it from DIVERGES_DELIBERATELY`).not.toBe(web);
    }
  });

  it("says what the web client's German says, wherever the two surfaces say the same thing", () => {
    const drifted: string[] = [];
    for (const [key, dotted] of Object.entries(SAME_AS_WEBAPP)) {
      if (en[key] !== at(EN_JSON, dotted)) { drifted.push(key); continue; }
      expect(german[key], `${key} has drifted from messages/de.json ${dotted}`)
        .toBe(at(DE_JSON, dotted));
    }
    expect(drifted.sort(), "an English wording drifted without its reason being recorded")
      .toEqual(Object.keys(ENGLISH_DIFFERS).sort());
  });
});

describe("the live accessor", () => {
  it("answers English until a language is set, whatever machine the suite runs on", () => {
    /* The register rests at English and only the provider ever moves it, so a suite running on a
       machine whose ICU default is German still asserts the English strings every other test in
       this directory was written against. That independence is the point of the assertion. */
    resetLocaleRegisterForTests();
    expect(Copy.settings).toBe("Settings");
    expect(Copy.doorbell(2)).toBe("2 new senders");
  });

  it("resolves the current deck on every read, including through a switch", () => {
    resetLocaleRegisterForTests();
    expect(Copy.settings).toBe(EN.settings);
    setActiveLocale("de");
    expect(Copy.settings).toBe(DE.settings);
    expect(Copy.folderShowAll(3)).toBe(DE.folderShowAll(3));
    setActiveLocale("en");
    expect(Copy.settings).toBe(EN.settings);
    resetLocaleRegisterForTests();
  });

  it("is enumerable, so the guards that walk it still see every key", () => {
    /* `copy-tails.test.ts` reads `Object.entries(Copy)` and `doors.test.ts` reads
       `Object.keys(Copy)`. A getter defined without `enumerable` would leave both walking an empty
       object and passing — a guard that cannot fail. */
    expect(Object.keys(Copy).sort()).toEqual(KEYS);
    const values = Object.entries(Copy).filter(([, v]) => typeof v === "string");
    expect(values.length).toBeGreaterThan(200);
  });

  it("exposes the same shape as either deck, so a consumer cannot tell them apart", () => {
    const shape = (d: Deck) => Object.entries(d).map(([k, v]) => `${k}:${typeof v}`).sort();
    expect(shape(Copy)).toEqual(shape(EN));
    expect(shape(DE)).toEqual(shape(EN));
  });
});
