"use client";

/**
 * Screener decisions with a real undo window on a real engine. The wire has no inverse for `screener_decide`, so undo is a
 * DELAYED COMMIT: a decision hides the row instantly, the toast carries Undo, and the mutation fires when the window closes;
 * navigating away flushes pending commits. On a Cloud account every row is DERIVED from the message mirror
 * (`sender.derived`): `POST /screener/:id` resolves only mail still held in `ohmail/Screener` and now takes `dest` — all five
 * destinations ride the decision; only `mark_seen` is composed on top. Gate-physical vs past the gate (#116): the queue is
 * built from the PROJECTED mirror, so a rep can merely PRESENT at the gate — `commit` re-reads the RAW mirror, and a
 * presented-only rep routes past the gate through the sender sheet's `planScreeningChange`/`dispatchScreeningChange`
 * (`rule_create` + `applyRetro`), awaited so the toast reflects what the server returned.
 */
import { useEffect, useMemo, useReducer, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  FOLDER_OF_VIEW,
  isProtectedMessage,
  physicalFolderOf,
  screenerSegments,
  senderKey,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type OhmailEngine,
  type ScreenDest,
  type ScreenerSenderDTO,
} from "@ohmail/client-engine";
import type { SuggestionOverlay } from "./screener-suggest";
/* THE ONE ROLE ANSWER, imported rather than restated. `mail-state.ts` owns the derivation the
   mailbox pane renders its own state line from, and a second rule shaped like it here is how two
   surfaces come to describe one mailbox differently. */
import type { ScreenerRole } from "./mail-state";
import {
  armScreenerIntent,
  disarmScreenerIntent,
  takeScreenerIntents,
  type ScreenerIntent,
} from "./screener-intents";
import { createIntentWindows } from "./intent-windows";
import {
  dispatchScreeningChange,
  holdingRules,
  planScreeningChange,
  senderScreening,
} from "./sender-screening";
import { pileNames } from "./decision-copy";
import { PLACE_LABEL } from "./format";
import { displayAddress, displayAddressee, displayDomain, displayDomainLabel } from "./idn";
import { activeFormatZone } from "./locale";
import { useAppLocale } from "./LocaleContext";
import {
  DECISION_QUIET,
  type DecisionDestination,
  type DecisionScope,
  type ToastFn,
} from "@ohmail/ui";

export interface SpamRow {
  sender: ScreenerSenderDTO;
  /** Locally pinned: a sender the user marked spam this session. */
  pinned: boolean;
}

export interface DecideOptions {
  read: boolean;
  scope: DecisionScope;
  quiet?: boolean;
}

/**
 * Why a held message's body is never going to arrive. `ScreenerHeldMail.bodyState` says what
 * the text IS; it cannot say whether a `snippet` is in flight or will never be fetched — that
 * is a fact about the MESSAGE, held by `OhmailEngine.hydrateBody`: `protected` (sensitive mail
 * — hydrateBody returns without asking and purges any cached body) and `absent` (the id is not
 * in the mirror — fixture held ids, or a drained or evicted row). Both were rendered as
 * "Loading the full message…" with no end: the preview claimed a request the engine had decided
 * never to make. Reading the predicate hydrateBody reads keeps the two from drifting.
 */
export type HeldBodyStall = "protected" | "absent";

interface PendingEntry {
  sender: ScreenerSenderDTO;
  dest: DecisionDestination;
  read: boolean;
  scope: DecisionScope;
  /**
   * This decision raises no sentence of its own — it is one step of a BULK, which speaks once for
   * the whole run.
   *
   * Carried on the entry rather than re-derived at commit time because the commit fires up to
   * `COMMIT_MS` after the press and `s.bulkBusy` is long cleared by then: "was this part of a bulk"
   * is a fact about the decision, so it travels with it. Read by `refuse` for exactly the reason
   * `decide` reads `opts.quiet` — one refusal must not overwrite the summary of a run that mostly
   * worked.
   */
  quiet: boolean;
  /**
   * WHEN THE READER PRESSED — the same stamp the durable intent carries.
   *
   * On the entry rather than re-read at commit time for the reason `quiet` is: the commit fires
   * up to `COMMIT_MS` later, and this has to be the moment of the DECISION so the journal's copy
   * and the in-memory copy are the same record rather than two clocks that agree by luck.
   */
  at: number;
  commitTimer: ReturnType<typeof setTimeout>;
  outTimer: ReturnType<typeof setTimeout>;
}

export interface ScreenerState {
  /** Waiting rows to render (rows mid-exit carry `pendingOut`). */
  waiting: ScreenerSenderDTO[];
  /** Waiting minus everything decided — rail badge, doorbell, meta. */
  waitingCount: number;
  /**
   * How many of those rows actually carry a suggestion. Never assume this
   * tracks `waitingCount`: `selectors.ts` mints `ai: null` for every derived
   * row (`/sync` carries no suggestion; no classifier runs client-side), so
   * on a live account this is 0 until `shell/screener-suggest.ts` buys one
   * and lands it in the `suggestions` overlay — before that surface existed
   * "Apply all" had nothing to apply. It exists so the surface can decline
   * to offer "Apply all suggestions" over an empty set.
   */
  suggestedCount: number;
  /**
   * The distinct piles those rows would be filed into, in {@link APPLY_PILE_ORDER}.
   *
   * The apply control's label is built from this and from {@link suggestedCount} together: a
   * button that says only how MANY is a bulk action whose consequence is invisible until it has
   * happened. Never contains `screener` — the one answer the bulk refuses to act on — because it
   * is derived from the same rows the count is.
   */
  suggestedDests: DecisionDestination[];
  /**
   * The waiting senders with no suggestion yet, in the queue's own order — the batch a
   * purchase would be composed from.
   *
   * Lower-cased addresses, because that is the key the endpoint normalises to, and DERIVED
   * rows only: a fixture sender does not exist on the server and would come back `not_held`,
   * padding a batch the user was charged nothing for but had counted.
   */
  unsuggestedSenders: string[];
  /**
   * The waiting senders that already have a suggestion, in the queue's own
   * order — the batch a re-ask would be composed from, and the count the
   * resting state states. The complement of {@link unsuggestedSenders}
   * within the set the server can speak for, never within the whole queue
   * (see the derivation for why the eligibility filters are repeated).
   * It exists because a fully answered Screener used to render no AI
   * surface at all — "nothing left to buy" and "this feature is not here"
   * looked identical.
   */
  suggestedSenders: string[];
  /**
   * How far a bulk is through its own queue — `null` unless one is running.
   * `applyAll`/`markAllSpam` dispatch each row on its own `BULK_STEP_MS` timer, so a
   * forty-sender press is ten seconds of work, and the summary toast does not arrive until the
   * last row — a person could not tell a stagger from a stall. `done` counts rows whose
   * `decide` actually ran, not scheduled timers (scheduling would report 40/40 in the first
   * frame); `total` is the set the press acted on, read from the same array `bulk` filters, so
   * the denominator never names rows the run will not touch. Cleared on the timer that raises
   * the summary toast.
   */
  applying: { done: number; total: number } | null;
  screenedOut: ScreenerSenderDTO[];
  spam: SpamRow[];
  isExiting: (id: string) => boolean;
  /**
   * Is this held message's body stalled for good, and why? Null while it may still arrive.
   * See {@link HeldBodyStall} — the preview renders a spinner ONLY on a null answer.
   */
  bodyStall: (messageId: string) => HeldBodyStall | null;
  decide: (sender: ScreenerSenderDTO, dest: DecisionDestination, opts: DecideOptions) => void;
  applyAll: (scopeOf: (s: ScreenerSenderDTO) => DecisionScope) => void;
  markAllSpam: (scopeOf: (s: ScreenerSenderDTO) => DecisionScope) => void;
  allowScreened: (sender: ScreenerSenderDTO, dest: "ohbox" | "reads") => void;
  notSpamToWaiting: (row: SpamRow) => void;
  notSpamToOhbox: (row: SpamRow) => void;
  deleteSpam: (row: SpamRow) => void;
  /**
   * This row's decision was refused, and it is back in the queue because of that. `commit` used to
   * fire-and-forget: a refusal (the server's 404 for a row no longer held — reachable whenever this mirror
   * is a poll behind another writer) rolled the overlay back and said nothing; the row reappeared
   * indistinguishable from a decision never made (`test/screener-decision-holds.test.ts` reproduces it).
   * So a refusal is a STATE, not an absence: the row returns carrying it, it survives the toast, and is
   * cleared when the row is decided again. The release verbs (`allowScreened`, both `notSpam` halves)
   * carried the identical defect with no undo window; they report through the same mark, keyed so a
   * PARTIAL release still marks the row that comes back (`refusalKeys`).
   */
  refused: (id: string) => boolean;
  /** Commit every pending decision now (route/segment changes). */
  flush: () => void;
  /**
   * What this install may do with a decision — three-way, not a boolean. `organizer`: every verb works as always.
   * `pending`: a reader whose organizer can take a decision — the press is real, the mail does not move here, the
   * sender leaves the queue and appears under {@link pending}. `blocked`: a reader with nowhere to send a decision.
   * Measured on 0.13.7 standalone: the bar drew, `o` toasted "filed", the count dropped — while the server was
   * unchanged; 45 s later the sender was back, tagged "Not saved", no sentence why. So the refusal is BEFORE the
   * press, at the funnel every decision converges on: the view withholds bar and keys, and every other entry (a missed
   * key, a row menu, bulk, boot replay) meets the same wall. `pending` passes through on purpose. Derived from {@link
   * readerStandDown} in `mail-state.ts` — never a second rule shaped like it.
   */
  role: ScreenerRole;
  /**
   * Senders decided here that the organizer has not carried out yet — empty
   * in every other mode. They are out of {@link waiting} and not finished, a
   * third state that must not collapse into either neighbour: left in the
   * queue they would be asked twice; dropped silently a press looks like
   * nothing happened. The mail is still in the Screener folder on the
   * server, truthfully, until the organizer's pass moves it. Two sources
   * merged on the address: this session's presses, and previous sessions'
   * that the server still reports outstanding — without the second a reload would re-ask every decided sender.
   */
  pending: PendingDecision[];
  /**
   * THE SAME DECISIONS AS ROWS, paired with the sender each is about — empty in every other
   * mode.
   *
   * {@link pending} is the record and this is what a list can draw: the senders are still in
   * the mirror, because the mail has not moved, so these are the rows the queue would have
   * shown with the decision attached. A surface that rebuilt them from {@link pending} alone
   * would have an address and nothing else.
   */
  decided: Array<{ sender: ScreenerSenderDTO; decision: PendingDecision }>;
  /**
   * SENDERS THE ORGANIZER REFUSED, still IN {@link waiting} — the reason, paired with the row.
   *
   * They are deliberately not excluded and deliberately not under the heading: the organizer
   * answered no, so the question is open and belongs in front of the person again. This exists so
   * the row can say what happened rather than reappearing as though nothing did.
   */
  notApplied: Array<{ sender: ScreenerSenderDTO; decision: PendingDecision }>;
}

/**
 * ONE SENDER DECIDED ON A MAILBOX THIS INSTALL DOES NOT ORGANIZE.
 *
 * `state` and `reason` are OPTIONAL and are read structurally rather than switched on, so an
 * organizer that starts answering with an outcome this build has never heard of renders the
 * generic sentence instead of a raw token or a crash. What this build knows is that a `refused`
 * state means the decision was not carried out; anything else it has not been told about is
 * still waiting, which is the safe reading — a decision reported as refused that in fact landed
 * would be the worse of the two errors.
 */
export interface PendingDecision {
  /** The address (sender scope) or the domain (domain scope) the decision covers, lower-cased. */
  subject: string;
  scope: "sender" | "domain";
  decidedAt: string;
  /** The organizer's name, for the sentence. `null` where this build has none. */
  holder: string | null;
  /**
   * Where the decision stands — and the third value changes what the queue
   * does. `pending` and `sent` are the same to this surface: the organizer
   * has it, the sender is out of the queue and under the heading. `refused`
   * is the opposite — the organizer answered no — so the sender comes BACK:
   * the question is open again and only the person can answer it. A carried
   * out or expired decision is not reported at all. Read structurally: a
   * state this build has never heard of is treated as outstanding — the
   * safe reading, since "refused" for a landed decision re-asks an answered question.
   */
  state?: string;
  /**
   * WHY IT WAS NOT CARRIED OUT, in the organizer's own word — `null` outside `refused`, and also
   * `null` for a refusal it declined to explain.
   *
   * A closed vocabulary on the wire, and deliberately NOT a union here: the organizer's set can
   * grow without a client release, and this build must render a word it has never seen as a
   * refusal with no reason rather than as a raw token or a missing key.
   */
  refusedReason?: string | null;
}

const OUT_MS = 330;
/**
 * How long "Undo" is true, and the two numbers that have to agree. `ToastHost` drops the `on` class on schedule but never
 * clears state, so the message and its button stay mounted — `pointer-events:none` stops a mouse, not Tab + Enter or a
 * screen reader (proven in jsdom: 20 minutes later the button still fired). And the undo was already dead: `commit` fires on
 * its own timer and `undo` only restores rows still pending, so a late press restored nothing and said "Undone — 0 waiting
 * again." — the product claiming an act it did not perform. So the window is ONE number: `UNDO_MS` is the offer and the
 * commit is derived from it (the shipped pair was 6000 vs 6200 — already a 200 ms slice of this bug). `COMMIT_GRACE_MS`
 * covers the toast's own fade so the capsule is gone before the decision is sent. `undo()` stays independently guarded: only
 * refusing to claim an undo that did not happen fixes the control.
 */
export const UNDO_MS = 8000;
const COMMIT_GRACE_MS = 400;
/**
 * Exported so the suite reads the REAL number. `test/screener-cloud.test.ts` carried
 * `const COMMIT_MS = 6200` — a hand-copied duplicate of a value it does not own, which would
 * have gone green against a shipped 8400 for exactly as long as nobody re-ran it.
 */
export const COMMIT_MS = UNDO_MS + COMMIT_GRACE_MS;
const BULK_STEP_MS = 240;
/** `PATCH /messages` takes at most 200 ids (413 above it) — `routes/messages.ts:52`. */
const MARK_SEEN_MAX = 200;

/**
 * The piles the apply control may name, in the order it names them — the
 * five `applyAll` can actually file into, no more: `screener` is the model
 * declining to place a sender, the one answer a bulk may not act on. A
 * sixth member would put a pile in the label the press does not deliver
 * (the "Apply all (83)" lie one control over); an omitted one produced the
 * "it stopped at the spam" report. Ohbox first, then the two automated
 * piles, the demotion, the judgement — least to most consequential.
 */
export const APPLY_PILE_ORDER: readonly DecisionDestination[] = [
  "ohbox", "reads", "receipts", "screened", "spam",
];

export function useScreenerState(
  engine: OhmailEngine,
  version: number,
  toast: ToastFn,
  /**
   * Suggestions bought for this account, keyed by sender — `shell/screener-suggest.ts`.
   *
   * OPTIONAL, and absent means exactly what it meant before there was anything to pass:
   * every derived row's `ai` stays null and the surface says so. It is joined on here rather
   * than inside `screenerSegments` because the mirror is a record of mail and this is not
   * mail — the engine has no business holding it, and a client-engine that did would have to
   * persist and evict it.
   */
  suggestions?: SuggestionOverlay,
  /**
   * The mirror as it is PRESENTED — `presentationReader(engine.read(), consentPartition(…))`. The queue is
   * built from this and the mutations from the raw mirror; the split is the
   * point. `screenerSegments` groups by `m.folder`, so handed the raw
   * mirror it answers "whose mail is filed in `ohmail/Screener`" — after a
   * backfill that diverges from the queue by an order of magnitude (dormant
   * senders queued beside their History rows; consented senders re-asked;
   * active INBOX strangers in no pile at all). Optional; absent means the
   * raw mirror — the demo and every pre-parameter caller.
   */
  presented?: EntityReader,
  /**
   * Will a screen-out or spam press actually send the one-click unsubscribe? — the account
   * switch (mail 0054) ANDed with "this build has a service that can"
   * (`autoUnsubscribeDiscloses`). It changes ONE thing: whether the two demoting toasts state
   * the consequence — nothing here sends or gates on it; the server reads its own row at the
   * seam. The Screener says it AFTER the press (a confirm before every `n`/`x` would make the
   * queue unusable — the gate lives on the sender sheet, where a click can widen to a domain);
   * the toast carries the undo. Defaults TRUE: the failure to avoid is the silent unsubscribe.
   */
  autoUnsubscribe = true,
  /**
   * WHAT THIS INSTALL MAY DO WITH A DECISION — see {@link ScreenerState.role}.
   *
   * OPTIONAL, and absent means `organizer`, which is what every caller meant before this
   * parameter existed and is the safe default in the only direction that matters here: the
   * dangerous value would refuse decisions on a mailbox this install DOES organize. The one
   * caller that can know (`AppShell`) computes it with `screenerMode` over the same polled rows
   * Settings → Mailboxes reads.
   */
  role: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false },
  /**
   * DECISIONS A PREVIOUS SESSION MADE THAT THE ORGANIZER HAS NOT CARRIED OUT YET.
   *
   * The durable half of {@link ScreenerState.pending}: this session's own presses are recorded
   * here as they happen, and these are the ones the server still reports outstanding. Absent is
   * "none known", which is right for the demo, for an organizer, and for a server that does not
   * report them — in every one of those cases there is nothing to exclude.
   */
  outstanding: readonly PendingDecision[] = [],
  /**
   * THE ACCOUNT'S OWN ADDRESSES — `GET /mailboxes`, the same list `AppShell` hands
   * `consentPartition`, so the queue and the partition cannot disagree about who the reader is.
   *
   * Without it a message from the account's own address sitting physically in `ohmail/Screener`
   * is a waiting row and the reader is asked to screen themselves. ABSENT ⇒ the mirror's own
   * `mailbox` rows, which is the demo and any caller with no facts to pass.
   */
  ownAddresses?: readonly string[],
): ScreenerState {
  const t = useTranslations("screener");
  /* The five pile names as the catalogue has them, so a toast naming a destination uses the
     word the rail uses. See `decision-copy.ts`. */
  const piles = pileNames(t);
  // The past-the-gate branch of `commit` speaks the sender-sheet's own sentences (`toastRuled`,
  // `toastRuleFailed`, …), chosen from what the server actually returned — so it reads them from
  // the `screening` namespace, exactly as `AppShell#changeScreening` does.
  const ts = useTranslations("screening");
  /* "No undo — this browser cannot keep one." ONE sentence for the Screener and the delete key,
     so it lives in the namespace the durability notice uses rather than twice in two piles'. */
  const tSession = useTranslations("session");
  /* `tick` IS READ, and by one effect only. The boot replay below waits for the cross-tab
     handshake, which settles on a timer rather than on a mirror change — so keying that effect on
     `version` alone would leave a stranded decision sitting until the next drain. */
  const [tick, bump] = useReducer((c: number) => c + 1, 0);
  /**
   * WHOSE UNDO WINDOW IS WHOSE, ACROSS TABS — see `intent-windows.ts`.
   *
   * One per hook instance rather than in module scope, which is what a TAB is and is also the
   * only shape a pair of them can be driven in. `bump` is a reducer dispatch and therefore
   * stable, so the coordinator is built once.
   */
  const windows = useMemo(() => createIntentWindows({ onChange: bump }), []);
  const store = useRef({
    pending: new Map<string, PendingEntry>(),
    out: new Set<string>(),
    pins: [] as ScreenerSenderDTO[],
    overrides: new Set<string>(),
    hidden: new Set<string>(),
    /** See {@link ScreenerState.refused} — rows whose decision the wire would not take. */
    refused: new Set<string>(),
    /**
     * Senders this session decided on a mailbox somebody else organizes,
     * keyed by {@link senderKey} — the ADDRESS, the identity that survives
     * a drain. Keyed on the row id the exclusion lasts eight seconds: the
     * optimistic overlay is dropped when the mutation confirms, the mail
     * has not moved on the server (only the organizer moves mail), and the
     * next projection re-mints the same sender under a NEW representative
     * id. Keyed by address, the sender stays where the press put it.
     */
    queued: new Map<string, PendingDecision>(),
    bulkBusy: false,
    /** See {@link ScreenerState.applying}. Guarded by `bulkBusy`, so only one run ever owns it. */
    applying: null as { done: number; total: number } | null,
  });

  /**
   * The RAW mirror. Where each message physically sits on the server.
   *
   * Everything that MUTATES reads from here, and `consent-cutline.ts` states why in the
   * `presentationReader` docblock: a projected reader answers with a presentation rather than a
   * location, and a move needs to know what it is moving from. `notSpamToOhbox` below is the
   * live case — it looks up a sender's quarantined mail by folder to release it.
   */
  const reader = engine.read();
  // The QUEUE, from the projected mirror. See the `presented` parameter.
  const queueReader = presented ?? reader;
  /* THE DERIVED ROWS CARRY WORDS AND A CLOCK: a derived sender's stamp ("Mo", "2. Aug") and a
     screened-out sender's date are minted by the selector, not by a view, so it has to be told
     which language to name them in AND which zone to read them in. The engine defaults the zone to
     UTC because it has no reader to ask; this is the call site that has one, and without it the
     Screener would keep showing the two-hours-behind stamps every other pile has stopped showing.
     The memo re-keys on the locale, so a switch re-derives the segments in the same render rather
     than leaving yesterday's stamps in English until the next mutation; the zone is resolved once
     per session and is not a dependency. */
  const locale = useAppLocale()?.locale ?? "en";
  const segments = useMemo(
    () => screenerSegments(queueReader, undefined, locale, activeFormatZone(), ownAddresses),
    [queueReader, version, locale, ownAddresses],
  );
  const s = store.current;

  // Both of these end up inside toast and confirmation SENTENCES, so both name the sender the way
  // a person reads them — an internationalized domain decoded (`idn.ts`). The rule, the mutation
  // and the screening key below all read `x.from.address` / `sender.address` directly.
  const senderLabel = (x: ScreenerSenderDTO) => displayAddressee(x.from.name, x.from.address);
  const scopeText = (x: ScreenerSenderDTO, scope: DecisionScope) =>
    scope === "domain"
      ? t("wholeDomain", { domain: displayDomainLabel(x.from.address) })
      : displayAddress(x.from.address);

  /** A derived row's held ids ARE message ids; a fixture row's are not. */
  const heldMessageIds = (sender: ScreenerSenderDTO): string[] =>
    sender.derived ? sender.held.map((h) => h.id) : [];

  /**
   * Move a sender's whole bag, and answer whether it ALL landed. This was `for (…) void
   * engine.mutate(…)` — the release family's whole bug: a refused move rolled the overlay back
   * (the row reappeared) while the press-time toast went on stating the release as done, with
   * no undo window and no second confirmation. `false` on ANY refusal, not all: this is one act
   * to the reader, and a release that moved four of five messages has not happened — the
   * unmoved mail keeps the row alive either way. A rejected promise counts as a refusal; a
   * `queued` result does not (the intent stands on the retry queue with its key). Empty ⇒
   * `true`: nothing asked, nothing failed.
   */
  const moveAll = (ids: string[], folder: Folder): Promise<boolean> =>
    Promise.all(
      ids.map((messageId) =>
        engine.mutate({ kind: "move", messageId, folder }).then(
          (r) => r.status !== "rolled_back",
          () => false,
        ),
      ),
    ).then((landed) => landed.every(Boolean));

  /**
   * A release is two halves now, and the answer is their conjunction. The rule half was missing (live,
   * 2026-08-19): a sender with an enabled rule pointing at `ohmail/Quarantine` presents INBOX and Screener
   * mail in Spam, so a release of bare `move`s failed twice — a move for mail already at the destination is
   * the engine's local 404, and the moves that landed were re-presented by the rule. Callers pass the rule
   * rewrites ({@link holdingRules} → `rule_update`/`rule_delete`) beside moves covering only mail
   * physically in the segment's folder ({@link physicallyHeldIn}); the server's retro pass makes the rest
   * physical later. Both halves watched on `moveAll`'s doctrine; NOTHING TO DO is a refusal — a press that
   * can dispatch neither cannot change what the reader sees.
   */
  const releaseHeld = (
    ruleMutations: EngineMutation[],
    moveIds: string[],
    folder: Folder,
  ): Promise<boolean> => {
    if (ruleMutations.length === 0 && moveIds.length === 0) return Promise.resolve(false);
    const rules = Promise.all(
      ruleMutations.map((m) =>
        engine.mutate(m).then((r) => r.status !== "rolled_back", () => false),
      ),
    );
    return Promise.all([rules, moveAll(moveIds, folder)])
      .then(([ruled, moved]) => moved && ruled.every(Boolean));
  };

  /**
   * The held ids whose mail is PHYSICALLY in `folder` — the only ones a release may move.
   *
   * The RAW mirror, deliberately: `sender.held` was minted over the projected reader, where a
   * rule-held message reports the segment as its folder. Asking to move a message that is
   * already at the destination is `mutationEffects`' empty answer, which `Engine.mutate` turns
   * into a rolled-back 404 WITH NOTHING SENT — the deterministic half of the release failure.
   */
  const physicallyHeldIn = (raw: EntityReader, sender: ScreenerSenderDTO, folder: Folder): string[] =>
    heldMessageIds(sender).filter((id) => raw.get<EngineMessage>("message", id)?.folder === folder);

  /**
   * The row came back and it says so — the durable half, with no sentence attached. Separate
   * from the toast because the two have different owners: the MARK belongs to every failure
   * path without exception; the SENTENCE only where nothing else describes it better — the
   * past-the-gate branch answers `toastRuleFailed` (a lost RULE, and the mail really did move),
   * and a BULK raises one summary for the run (a per-row refusal toast would replace the
   * summary of everything that worked). `bump()` because the store is a ref: without it the
   * mark appears on the next unrelated render — the shape the defect wore.
   */
  const markRefused = (id: string) => {
    s.refused.add(id);
    bump();
  };

  /**
   * A refusal with nothing better to say: mark the row and name the sender.
   * `quiet` is the bulk's own flag, threaded from `decide` through
   * {@link ScreenerIntent} — the same flag that suppresses the per-row
   * optimistic toast, so both toasts are suppressed by one decision rather
   * than two guesses about the caller. It takes the INTENT, not the live
   * entry, which lets a decision restored from the journal report its own
   * refusal in the same words — all it needs is a name for the sentence,
   * and the intent carries it.
   */
  const refuse = (d: ScreenerIntent) => {
    markRefused(d.id);
    if (d.quiet) return;
    toast(
      t("toastDecideFailed", { sender: displayAddressee(d.from.name, d.from.address) }),
      { duration: UNDO_MS },
    );
  };

  /**
   * The decision landed with the organizer, not on this machine — record it
   * and say so. NOT a refusal and never through {@link refuse}: `s.refused`
   * means "the wire would not take your decision", and the wire took this
   * one; what has not happened is the FILING, and the replacing sentence
   * says exactly that and names who owes it. The key is the address for a
   * sender-scope decision and the DOMAIN for a domain-scope one, so a
   * domain decision excludes the domain — what the organizer will apply,
   * and therefore what the queue must stop asking about.
   */
  const markQueued = (d: ScreenerIntent, holder: string | null) => {
    const at = d.from.address.lastIndexOf("@");
    const subject = d.scope === "domain" && at >= 0 ? d.from.address.slice(at + 1) : d.from.address;
    s.queued.set(senderKey(subject), {
      subject,
      scope: d.scope,
      decidedAt: new Date(d.at).toISOString(),
      holder,
    });
    bump();
  };

  /**
   * Every id this row could come back under — the rep plus the sender's whole derived bag.
   * `markRefused` marks one id, right for a queue row whose representative cannot change under
   * the mark. A RELEASE can change the representative: a derived Screened-out/Spam row's id is
   * the sender's NEWEST message in that folder, so release five, have the newest land and an
   * older one refused, and the returning row is minted on a different message — a mark on the
   * pressed id renders as nothing: the silent rollback again. Marking the bag means whichever
   * message remains carries the note. `heldMessageIds`, not `sender.held`: a fixture row's held
   * ids are not message ids (it answers `[]` there).
   */
  const refusalKeys = (sender: ScreenerSenderDTO): string[] => [
    sender.id,
    ...heldMessageIds(sender),
  ];

  /**
   * A FRESH ATTEMPT CLEARS THE OLD NOTE — the reversal family's counterpart to the
   * `s.refused.delete(id)` at the top of `decide`, and for the identical reason: the note says
   * "your last press did not land", and leaving it on a row the reader has just pressed again
   * would make it say that about the new press before the wire has been asked.
   *
   * Bumps, so the note is gone in the same frame as the press rather than on the next unrelated
   * render. Also called on SUCCESS, so a sender whose mail is released for real leaves no stale key
   * behind to mark a row minted on the same message later.
   */
  const clearRefused = (sender: ScreenerSenderDTO) => {
    for (const id of refusalKeys(sender)) s.refused.delete(id);
    bump();
  };

  /**
   * A reversal the wire would not take — "Allow", "Not spam → Ohbox",
   * "Not spam → Screener". Its own sentence rather than `toastDecideFailed`,
   * which says "… is back in the queue" — none of these rows go there: a
   * refused release leaves the sender exactly where they were, in the
   * segment the reader pressed in. `segment` is the id, not a label, so the
   * mapping to words lives here once — the toast has to name a real pile.
   * No `quiet` flag: there is no bulk on these segments; every press is one
   * sender from a confirm strip.
   */
  const refuseRelease = (sender: ScreenerSenderDTO, segment: "screened" | "spam") => {
    for (const id of refusalKeys(sender)) s.refused.add(id);
    bump();
    toast(
      t("toastReleaseFailed", {
        sender: senderLabel(sender),
        place: segment === "spam" ? t("segSpam") : t("segScreened"),
      }),
      { duration: UNDO_MS },
    );
  };

  /**
   * THE LIVE ENTRY, AS THE DURABLE RECORD OF ONE DECISION.
   *
   * The trim rather than the row — see {@link ScreenerIntent} for what is left out and why
   * (`ScreenerSenderDTO.held` carries every held message in full; a bulk over a busy queue would
   * put megabytes of mail text in `localStorage` to record five fields).
   */
  const intentOf = (id: string, entry: PendingEntry): ScreenerIntent => ({
    v: 1,
    id,
    dest: entry.dest,
    read: entry.read,
    scope: entry.scope,
    quiet: entry.quiet,
    at: entry.at,
    derived: entry.sender.derived === true,
    /**
     * Only when they are load-bearing — the same predicate `dispatchDecision` guards the `mark_seen` batch with
     * (`derived && read`), so gating the list here changes no behaviour and
     * keeps the journal small. Not micro-optimisation: `held` is every held
     * message and a bulk over a busy queue is hundreds of senders — a
     * demoting bulk would put tens of thousands of ids in `localStorage`
     * for a flag none will be asked about, and a quota refusal there is
     * swallowed, losing the whole journal silently — the one thing this
     * file exists to prevent, reached through its own storage.
     */
    heldIds: entry.sender.derived === true && entry.read ? heldMessageIds(entry.sender) : [],
    from: { name: entry.sender.from.name ?? null, address: entry.sender.from.address },
  });

  const commit = (id: string) => {
    const entry = s.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.commitTimer);
    clearTimeout(entry.outTimer);
    /* THE WINDOW IS CLOSED, so no other tab may replay it: from here the engine's outbox is the
       durable record. Told before the dispatch for the same reason the journal is written before
       the timer — the other tab is not waiting for this one to finish. */
    windows.release([id]);
    s.pending.delete(id);
    s.out.delete(id);
    if (entry.dest === "spam") {
      s.pins = [entry.sender, ...s.pins];
    }
    s.overrides.delete(id);
    dispatchDecision(intentOf(id, entry));
    bump();
  };

  /**
   * Send one decision — the only path to the wire, taken by the live timer AND the boot replay.
   * It takes a {@link ScreenerIntent}, not a {@link PendingEntry}: the live commit holds a full
   * DTO, the boot replay holds a record read off disk by a session that never saw the row —
   * written twice this would be two implementations of one rule, so it is written once in the
   * vocabulary both speak (`intentOf` adapts). `disarmScreenerIntent` is called on the SETTLE of
   * each branch, never before dispatch: `Engine.mutate` persists the verb to its durable outbox
   * ahead of the wire, but between press and settle the journal is the ONLY copy — dropping it
   * early reopens the defect at a narrower window.
   */
  const dispatchDecision = (d: ScreenerIntent) => {
    const id = d.id;
    const derived = d.derived;
    const heldIds = d.heldIds;
    const done = () => disarmScreenerIntent(id);

    // Where is the representative, actually? Read the RAW mirror. The queue
    // is built from the projected reader, in which an active-undecided
    // sender's INBOX mail is PRESENTED in the Screener — a `screener_decide`
    // on such a rep is a no-op that claims success (#116):
    // `derivedScreenerEffects` returns nothing for a rep not physically in
    // `ohmail/Screener`, `Engine.mutate` rolls back without sending, and
    // the wire would 404 it anyway. So this branch reads `engine.read()`,
    // never the projected reader — that reader would report the INBOX rep
    // as gate-physical, the dangerous branch. A fixture (non-derived) row
    // always takes the decide path: served in-process, never a socket.
    const rawRep = engine.read().get<EngineMessage>("message", id);
    const gatePhysical =
      !derived || (rawRep != null && physicalFolderOf(rawRep) === FOLDER_OF_VIEW.screener);

    if (gatePhysical) {
      // Gate-physical: the decide, exactly as before. Spam must ride the NO
      // branch on a derived row — `yes` is the verb that ADMITS a sender,
      // and the server refuses `{decision:"yes", dest:"ohmail/Quarantine"}`
      // outright (400); the old "yes unless screened" mapping filed spam
      // into the Ohbox on a live account. Fixture rows keep the demo's own
      // semantics (spam rides `yes`, materialising held mail straight into
      // Quarantine) — that pairing is the one shape the server would refuse,
      // and it cannot reach it: fixture rows exist only under
      // `FixturesAdapter`, in-process, never a socket.
      const decision: "yes" | "no" =
        d.dest === "screened" || (derived && d.dest === "spam") ? "no" : "yes";
      // The destination rides the decide on BOTH branches, so the server files where the
      // user pressed on all five; nothing is composed on top but "&read", which is a flag below.
      //
      // ── THE RESULT IS INSPECTED, AND IT USED TO BE THROWN AWAY ──────────────────────────────
      //
      // This was `void engine.mutate(…)`. See {@link ScreenerState.refused} for what that cost:
      // a refusal rolled the overlay back and the sender reappeared as though undecided, with no
      // error anywhere. `queued` is deliberately NOT a refusal — the mutation is on the retry queue
      // with its Idempotency-Key and the user's intent still stands, which is the one status where
      // the row staying gone is the truthful answer.
      void engine.mutate({
        kind: "screener_decide",
        senderId: id,
        decision,
        dest: d.dest as ScreenDest,
        ...(decision === "yes" ? { read: d.read } : {}),
        scope: d.scope,
      }).then((res) => {
        done();
        if (res.status === "rolled_back") { refuse(d); return; }
        /* The organizer took it, and will carry it out later. `pendingWith`
         * is present only where the server queued the decision instead of
         * applying it: nothing moved, no rule written, the mail still in
         * the Screener folder. Recording it here is what stops the sender
         * coming back — without it the press undoes itself ON THE CONFIRM:
         * the engine drops the overlay on success, the authoritative delta
         * carries no move (there was none), and the projection offers the
         * same sender again with nothing saying why. The mark is on the
         * ADDRESS because the overlay's row id is gone by then. */
        if (res.pendingWith) markQueued(d, res.pendingWith.name);
      }, () => { done(); refuse(d); });
    } else {
      // Past the gate: a rule, not a decide (#116). The sender's mail is
      // physically in the INBOX, presented in the Screener because they are
      // active and undecided — the decide cannot touch it, so a screen-IN
      // takes the sender sheet's own ladder: `rule_create` (destination
      // INBOX for an Ohbox decision) with `applyRetro`, plus capped `move`s
      // for anything not already in place; once the rule lands, `placeOf`
      // presents the whole bag in the Ohbox with zero server moves. Fed
      // from the RAW-reader `senderScreening`, and the mutations are
      // AWAITED so the toast is the one the server earned — never the
      // unawaited "Ruled" over nothing this bug was.
      const sender = senderScreening(engine.read(), id);
      if (sender) {
        const dest = d.dest;
        const plan = planScreeningChange(sender, dest, d.scope, true);
        // The toast's subject, not the rule's — the rule was already written from `plan`.
        const who = d.scope === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address);
        const place = PLACE_LABEL[dest] ?? dest;
        void dispatchScreeningChange(plan, (m) => engine.mutate(m)).then((key) => {
          done();
          // THE SENTENCE IS UNCHANGED — `toastRuleFailed` says "… moved, but the rule couldn't be
          // made. Future mail is unchanged.", which is strictly more informative than a generic
          // refusal and is true: the mail moved, only the rule was lost. What was missing is the
          // MARK. If nothing moved (a screen-in for a sender whose mail is already in the INBOX
          // plans no `move` at all) the sender comes back into the queue, and it used to come back
          // looking untouched while the only record faded with the toast.
          if (key === "toastRuleFailed") markRefused(id);
          toast(ts(key, { sender: who, place, count: plan.moved }));
        }, () => { done(); refuse(d); });
      } else {
        // The representative is gone from the mirror — and this branch was
        // EMPTY. `senderScreening` answers null exactly when `reader.get("message", id)` finds nothing; this runs up to
        // `COMMIT_MS` after the press, so a drain or eviction in between is
        // enough. With no `else` it dispatched NOTHING — no mutation, no
        // toast, the row back on the next render — the one completely
        // silent failure of the three. The intent is disarmed here, a
        // judgement: the boot replay never presents an intent whose rep the
        // mirror cannot see, so reaching here means the mirror has looked
        // and the message is not there — holding the decision would be a
        // retry loop with no terminating condition but the TTL.
        done();
        refuse(d);
      }
    }

    // "&read" is a flag, not a folder, so neither branch can clobber it: a
    // Yes files the sender's mail already-seen via the same `PATCH
    // /messages` batch the Ohbox uses (derived rows only; clamped away for
    // the demoting piles). This is the one deliberate `void engine.mutate`
    // left in this file: the DECISION has already landed by the time this
    // runs — only the seen flag on now-filed mail can be lost, and calling
    // `refuse` for it would falsely state the decision failed, aimed at a
    // row no longer in the queue. The real consequence — some filed mail
    // stays bold in the Ohbox — is visible where it happened and undone by
    // reading it. Unwatched on purpose, which is what this comment is for.
    if (derived && d.read) {
      for (let i = 0; i < heldIds.length; i += MARK_SEEN_MAX) {
        void engine.mutate({
          kind: "mark_seen",
          messageIds: heldIds.slice(i, i + MARK_SEEN_MAX),
          unread: false,
        });
      }
    }
  };

  const undo = (ids: string[]) => {
    let restored = 0;
    for (const id of ids) {
      const entry = s.pending.get(id);
      if (!entry) continue;
      clearTimeout(entry.commitTimer);
      clearTimeout(entry.outTimer);
      s.pending.delete(id);
      s.out.delete(id);
      // THE UNDO CANCELS THE SCHEDULED INTENT, and it is the half that makes the durable
      // journal safe to have. A decision is on disk from the moment it is taken; Undo is what
      // takes it off again, in the same synchronous act that clears the timer. Without this, a
      // decision the reader had just reversed would be re-committed by the next boot — the
      // journal would have turned "user always wins" upside down at the one control that exists
      // to honour it.
      disarmScreenerIntent(id);
      /* AND NO OTHER TAB MAY REPLAY IT EITHER — a reversal the reader made in this tab is a
         reversal, whichever tab happens to boot next. */
      windows.release([id]);
      restored++;
    }
    // NOTHING RESTORED IS NOT AN UNDO, so it does not get the undo sentence. Every id
    // had already committed (or was never pending), the mutation is dispatched, and
    // `toastUndone` at `count: 0` said "Undone — 0 waiting again." to a person who had just
    // pressed the button precisely to find out. Reachable long after the capsule fades,
    // because the button outlives it — see UNDO_MS.
    if (restored === 0) {
      toast(t("toastUndoExpired"));
      return;
    }
    bump();
    toast(t("toastUndone", { count: restored }));
  };

  const decide = (
    sender: ScreenerSenderDTO,
    dest: DecisionDestination,
    opts: DecideOptions,
  ) => {
    const id = sender.id;
    if (s.pending.has(id)) return;
    // A FRESH ATTEMPT CLEARS THE OLD REFUSAL. The note answers "your last decision about this row
    // did not land"; leaving it on a row the reader has just decided again would make it say that
    // about the new one before the wire has been asked. See {@link ScreenerState.refused}.
    s.refused.delete(id);
    // ── THE ONE PLACE "MARK READ" IS CLAMPED FOR THE DEMOTING PILES ─────────────────────────
    //
    // You do not read what you triage out: filing to Screen out or Spam carries no read verb.
    // The ✓ is gone from those capsules and their ⇧-twin keys are unbound — but this is the
    // funnel every decision path converges on (the ✓, o/r/c/n/x, ⇧Enter accepting an AI
    // suggestion of a demoting destination), so clamping HERE is what makes the guarantee
    // structural rather than three UI branches that each have to remember. `commit` reads
    // `entry.read` for both the wire `read` flag and the derived-row `mark_seen` batch, so a
    // false here stops both — the demote-stays-unread rule.
    const read = opts.read && !DECISION_QUIET.has(dest);
    const entry: PendingEntry = {
      sender,
      dest,
      read,
      scope: opts.scope,
      quiet: opts.quiet === true,
      at: Date.now(),
      outTimer: setTimeout(() => {
        s.out.delete(id);
        bump();
      }, OUT_MS),
      commitTimer: setTimeout(() => commit(id), COMMIT_MS),
    };
    /**
     * The decision is on disk before anything else happens to it — ahead of `s.pending.set`,
     * the toast, the render, and synchronously, which is why this journal is `localStorage` and
     * not the mirror store. Between here and `dispatchDecision` there is an 8.4-second window
     * in which the only record of an explicit consent decision used to be the commit timer; a
     * tab closed inside it lost the decision the toast had already reported done. Now the
     * window holds a durable intent: the press lands here, Undo removes it, and a crash
     * resolves one way — the next boot reads it and commits. The timers still own the happy
     * path.
     */
    const written = armScreenerIntent(intentOf(id, entry));
    /**
     * A REFUSED JAR TAKES THE UNDO AWAY, NOT THE DECISION.
     *
     * The window is only reversible because nothing has been sent yet, and what made it safe to
     * postpone was the record above. With no record, a tab closed inside the window loses a
     * decision the toast has already reported — the whole defect this journal closes, arriving
     * through a private window instead of through a crash. So the decision is sent at once and
     * the sentence says the undo is not on offer; `commit`'s own tail, minus the timers.
     */
    const holds = written === "stored";
    if (holds) {
      s.pending.set(id, entry);
      s.out.add(id);
      /* THIS TAB OWNS THE WINDOW. Another tab's boot read finds the same journal entry and would
         otherwise commit it while the countdown here is still running. */
      windows.claim([{ id, at: entry.at }]);
    } else {
      clearTimeout(entry.outTimer);
      clearTimeout(entry.commitTimer);
      if (dest === "spam") s.pins = [entry.sender, ...s.pins];
      s.overrides.delete(id);
      dispatchDecision(intentOf(id, entry));
    }
    bump();
    if (opts.quiet) return;
    const target = scopeText(sender, opts.scope);
    /**
     * The unsubscribe sentence, on the two demoting toasts only. `screened` and `spam` are the
     * whole of the endpoint's `no`, which is the whole of what arms the pass
     * (`screener-service.ts` calls `unsubscribe.onScreenOut` on `decision === "no"` and narrows
     * to the two reject folders itself). The three mail destinations are a KEEP and must never
     * carry this sentence — claiming it there would be false as well as alarming. Passed as an
     * ICU `select` argument rather than two message keys, so the German catalogue cannot end up
     * with the two halves of one sentence in different orders.
     */
    const unsub = autoUnsubscribe ? "true" : "false";
    const message =
      dest === "screened"
        ? t("toastScreened", { target, read: read ? "true" : "false", unsub })
        : dest === "spam"
          ? t("toastSpam", { target: displayAddress(sender.from.address), unsub })
          : t("toastFiled", {
              dest: piles[dest],
              read: read ? "true" : "false",
              target,
            });
    if (!holds) {
      toast(`${message} ${tSession("noUndoHere")}`);
      return;
    }
    toast(message, {
      action: t("toastUndo"),
      duration: UNDO_MS,
      onAction: () => undo([id]),
    });
  };

  /**
   * Join one bought suggestion onto a row.
   *
   * Three guards, and each one is a row this must NOT touch. A fixture row carries the demo's
   * own `ai` and is not a real sender, so the overlay has nothing true to say about it. A row
   * that already has an `ai` keeps it — the mirror is never overwritten by this. And a row
   * with no match is returned UNCHANGED rather than rebuilt, so the identity every `useMemo`
   * downstream compares stays stable when nothing was bought.
   */
  const withSuggestion = (x: ScreenerSenderDTO): ScreenerSenderDTO => {
    if (!suggestions || x.ai || x.derived !== true) return x;
    const found = suggestions.get(senderKey(x.from.address));
    return found ? { ...x, ai: found } : x;
  };

  const waiting = useMemo(() => {
    const overridden = segments.spam.filter((x) => s.overrides.has(x.id));
    return [...segments.waiting, ...overridden].map(withSuggestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, version, s.overrides.size, suggestions]);

  /**
   * DECIDED HERE, NOT CARRIED OUT YET — this session's presses over the server's own record.
   *
   * Merged rather than concatenated, and this session wins a tie: the server's copy is a poll
   * behind, so a sender pressed a moment ago is in one list and stale in the other, and showing
   * both would list one decision twice. The server's copy is what survives a reload; this
   * session's is what makes the press feel like it happened.
   */
  const pendingByKey = new Map<string, PendingDecision>();
  for (const p of outstanding) pendingByKey.set(senderKey(p.subject), p);
  for (const [k, p] of s.queued) pendingByKey.set(k, p);
  const pendingDecisions = [...pendingByKey.values()]
    .sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));

  /* WHICH DECISION, IF ANY, COVERS THIS SENDER. Matched on the address, and on the DOMAIN for a
     domain-scope decision: deciding a whole domain and then being asked about the next sender at
     that domain is the same question twice. */
  const decisionFor = (address: string): PendingDecision | undefined => {
    const direct = pendingByKey.get(senderKey(address));
    if (direct) return direct;
    const at = address.lastIndexOf("@");
    if (at < 0) return undefined;
    const domain = pendingByKey.get(senderKey(address.slice(at + 1)));
    return domain?.scope === "domain" ? domain : undefined;
  };
  /* AN OUTSTANDING DECISION TAKES THE SENDER OUT OF THE QUEUE AND KEEPS THEM OUT. Their mail is
     still in the Screener folder — only the organizer moves mail — so the projection goes on
     offering them, and without this the press would appear to work and then undo itself on the
     next drain.

     A REFUSED ONE DOES NOT, and that inversion is the whole of what the third state changed here.
     The organizer answered no: nothing was filed, no rule was written, and the question is open
     again — so the sender belongs back in the queue where it can be answered a second time. The
     entry survives to say what happened, beside them, and not to hide them. */
  const outstandingFor = (address: string): PendingDecision | undefined => {
    const d = decisionFor(address);
    return d === undefined || d.state === "refused" ? undefined : d;
  };
  const notDecided = (x: ScreenerSenderDTO): boolean => outstandingFor(x.from.address) === undefined;

  /* A ROW WHOSE WINDOW ANOTHER TAB OWNS IS NOT THIS TAB'S TO DECIDE — it is being decided, in a
     window that is counting down somewhere else, and offering it here would put one sender in two
     presses. It is withheld exactly as this tab's own pending rows are, and comes back the moment
     the holding tab releases it: filed (the projection drops the sender) or taken back (undecided
     again). See `intent-windows.ts`. */
  const decidedElsewhere = windows.elsewhere(Date.now(), COMMIT_MS);
  const visibleWaiting = waiting.filter((x) => (!s.pending.has(x.id) || s.out.has(x.id))
    && !decidedElsewhere.has(x.id) && notDecided(x));
  const undecided = waiting.filter((x) => !s.pending.has(x.id)
    && !decidedElsewhere.has(x.id) && notDecided(x));
  /**
   * THE DECIDED SENDERS, AS ROWS — the same rows the queue would have shown, on the other side of the line. Built
   * from `waiting` rather than from the decisions alone, and that is what makes them REAL rows: the mail has not
   * moved (only the organizer moves mail), so every one of these senders is still in the mirror with their subject,
   * their time and their held bag. A list rebuilt from the decision records would carry an address and nothing else,
   * and would have to invent the rest or show less than the row above it. They are out of {@link waiting} and not
   * finished, which is a third state this queue has never had. Leaving them in would ask the same question twice;
   * dropping them silently would make a press look like nothing happened.
   */
  const decided = waiting.flatMap((x) => {
    const p = outstandingFor(x.from.address);
    return p === undefined ? [] : [{ sender: x, decision: p }];
  });
  /**
   * SENDERS THE ORGANIZER REFUSED — still in the queue, with the reason beside them.
   *
   * Not a separate list on screen and not a separate state of the queue: these are ordinary
   * waiting rows that carry one more fact. What makes them worth naming here is that the fact
   * would otherwise be invisible — the press happened, the sender left the queue, the organizer
   * said no, and the sender came back looking exactly as they did before anybody pressed.
   */
  const notApplied = waiting.flatMap((x) => {
    const p = decisionFor(x.from.address);
    return p?.state === "refused" ? [{ sender: x, decision: p }] : [];
  });
  const waitingCount = undecided.length;
  // Counted over the SAME set the bulk would act on — including the `hold` exclusion, which is
  // why this predicate must stay a copy of `applyAll`'s and not merely of "has a suggestion".
  // A queue whose every suggestion is a `hold` offers no button at all, which is honest: there
  // is nothing to apply, and a button reading "Apply all (83)" that moved nothing would be the
  // inert-button lie `ScreenerView.tsx` already refuses.
  // Spam IS counted, because the press files it — see `applyAll`. It used to be excluded here to
  // match an exclusion there, and the two together are what left a queue of spam rows on screen
  // after a press that claimed to have applied every suggestion.
  const suggestedRows = undecided.filter((x) => x.ai != null && x.ai.dest !== "screener");
  const suggestedCount = suggestedRows.length;
  /**
   * WHICH PILES the press would file into, deduped, in the surface's own reading order. Derived from `suggestedRows`
   * and not from a second filter, because the label and the number beside it have to describe one set. "Apply 5" over
   * rows that turn out to be three Reads and two Receipts is a control whose consequence a person cannot picture
   * before pressing it — they see a count, press, and find five senders filed into piles nobody named. The order is
   * DECLARED here rather than taken from the queue, so the label is stable: read off row order it would reshuffle
   * every time a suggestion landed, and a control whose text changes while you look at it reads as a different
   * control.
   */
  const suggestedDests = APPLY_PILE_ORDER.filter(
    (d) => suggestedRows.some((x) => x.ai!.dest === d),
  );
  /**
   * The buy list, from the SAME set and in the SAME order. Deduped on the normalised address
   * rather than trusted distinct: the queue is one row per sender, but a spam row pulled back to
   * Waiting by `notSpamToWaiting` joins this list too, and a batch naming one address twice
   * would reserve two of the user's 25 slots for one sender. The endpoint dedupes as well —
   * this is so the COUNT the confirmation shows is the count that gets bought.
   */

  /**
   * A sender the gate holds nothing for is not buyable. `gatePhysical: false` is a row whose representative is
   * physically in the INBOX, minted because the cutline PRESENTS the sender at the gate (#116). The row is decidable
   * — its commit routes past the gate as a rule — but `POST /screener/suggest` resolves senders through `heldRows`,
   * which requires `desired_folder = 'ohmail/Screener'`, so the server can only answer `skipped: not_held`, and
   * `toSkips` drops `not_held` by design (no chip to render for a sender not at the gate). The consequence was a loop
   * with no exit: every such sender was in every batch, refused every time, never acquired an `ai`, and auto-suggest
   * re-offered them on a timer, spending quoted slots on senders the endpoint had already declined. Filtering them
   * here is the whole fix: they keep their row and the manual decision that works, and stop being offered for sale.
   */

  /**
   * `!== false` and not `=== true` because a FIXTURE row carries no flag and the demo must keep its behaviour. The
   * server's `heldRows` is deliberately NOT widened: that is a wire contract, and widening it changes what the gate
   * means for every caller.
   */
  const unsuggestedSenders = [
    ...new Set(
      undecided
        .filter((x) => x.derived === true && x.ai == null && x.gatePhysical !== false)
        .map((x) => senderKey(x.from.address)),
    ),
  ];
  /**
   * THE RE-ASK LIST — the same buyable set, on the other side of `ai == null`. Every filter above is repeated
   * deliberately rather than computed as "waiting minus unsuggested": `derived` and `gatePhysical` are facts about
   * whether the SERVER can speak for this sender at all, and they are as true of a sender who already has an answer
   * as of one who does not. A complement taken over the whole queue would put fixture rows and past-the-gate rows
   * into a batch the endpoint can only answer `not_held` for — the exact loop #116 removed from the buy list,
   * re-created on the re-ask path. `ai != null` and NOT `suggestedRows`' predicate: that set drops `screener`,
   * because it is the one answer a bulk APPLY refuses to act on.
   */

  /**
   * A sender the model declined to place, or one a run could not answer for, is not un-re-askable — it is the case
   * with the most to gain from being asked again once their next mail arrives.
   */
  const suggestedSenders = [
    ...new Set(
      undecided
        .filter((x) => x.derived === true && x.ai != null && x.gatePhysical !== false)
        .map((x) => senderKey(x.from.address)),
    ),
  ];

  const bulk = (
    destOf: (x: ScreenerSenderDTO) => DecisionDestination,
    scopeOf: (x: ScreenerSenderDTO) => DecisionScope,
    summary: (snaps: Array<{ id: string; dest: DecisionDestination }>) => string,
    /** Restricts the bulk to rows it can honestly speak for. Absent ⇒ every waiting row. */
    only?: (x: ScreenerSenderDTO) => boolean,
  ) => {
    const items = waiting.filter((x) => !s.pending.has(x.id) && (only ? only(x) : true));
    if (!items.length || s.bulkBusy) return;
    s.bulkBusy = true;
    const total = items.length;
    // PUBLISHED BEFORE THE FIRST TIMER, so the first frame after the press already says how big
    // this is. `bump()` because the store is a ref: nothing else in this function schedules a
    // render until the first `decide` fires `BULK_STEP_MS` later, which is the blank window the
    // field exists to close.
    s.applying = { done: 0, total };
    bump();
    const snaps: Array<{ id: string; dest: DecisionDestination }> = [];
    items.forEach((item, i) => {
      setTimeout(() => {
        const dest = destOf(item);
        decide(item, dest, { read: false, scope: scopeOf(item), quiet: true });
        snaps.push({ id: item.id, dest });
        // `i + 1` and not `snaps.length`: they agree here, and the index is the one that stays
        // true if a `decide` is ever allowed to decline a row — `done` counts rows this run has
        // WALKED, which is what the denominator was taken from.
        s.applying = { done: i + 1, total };
        bump();
      }, i * BULK_STEP_MS);
    });
    setTimeout(() => {
      s.bulkBusy = false;
      // Cleared on the same timer that raises the summary — the toast is what states the
      // finished numbers, and a bar still on screen beside it would claim work is in flight.
      s.applying = null;
      bump();
      // The bulk summary appears only after the last row's `decide`, and every row runs its own
      // `COMMIT_MS` clock from its own start — so over a long bulk the earliest rows can commit
      // while this capsule is still up, and this Undo is genuinely PARTIAL. That is stated
      // rather than papered over: `undo()` counts what it actually restored and `toastUndone`
      // reports that number, so a partial press says how many came back and a fully expired one
      // takes the `toastUndoExpired` arm. Shortening the capsule to cover the FIRST row instead
      // would leave a forty-row bulk with no undo on screen at all, which is worse.
      toast(summary(snaps), {
        action: t("toastUndo"),
        duration: UNDO_MS,
        onAction: () => undo(snaps.map((x) => x.id)),
      });
    }, items.length * BULK_STEP_MS + 160);
  };

  /**
   * "Apply all suggestions" may only apply suggestions that exist. Reported from live use: the Screener offered it
   * while no mail on screen showed what the suggestion would be — and the button was worse than dead. It read
   * `x.ai?.dest ?? "ohbox"`, and on a live account `x.ai` is ALWAYS null, so the fallback decided every row: one
   * press meant "accept every waiting stranger into the Ohbox and promote a rule for each", under a label claiming to
   * apply suggestions the user had never been shown — on a backlogged mailbox, hundreds of senders dispatched 240 ms
   * apart, with one Undo toast arriving minutes after the first move. A consent gate whose bulk control silently
   * grants consent is the product inverted.
   */

  /**
   * So the fallback is GONE — not replaced: `only` restricts the bulk to rows carrying a suggestion, `dest` is read
   * from that suggestion with no default, and with no suggestions the set is empty — the surface additionally
   * declines to render the control (`ScreenerView.tsx`), because an inert button is its own small lie.
   */
  const applyAll = (scopeOf: (x: ScreenerSenderDTO) => DecisionScope) =>
    bulk(
      (x) => x.ai!.dest as DecisionDestination,   // `hold` is excluded by the predicate below
      scopeOf,
      (snaps) => {
        const n = (d: DecisionDestination) => snaps.filter((x) => x.dest === d).length;
        const parts = [
          n("ohbox") ? t("bulkOhbox", { count: n("ohbox") }) : null,
          n("reads") ? t("bulkReads", { count: n("reads") }) : null,
          n("receipts") ? t("bulkReceipts", { count: n("receipts") }) : null,
          n("screened") ? t("bulkScreened", { count: n("screened") }) : null,
          n("spam") ? t("bulkSpam", { count: n("spam") }) : null,
        ].filter(Boolean);
        // The sentence is owed only if this batch actually DEMOTED somebody. A run of Ohbox,
        // Reads and Receipts arms nothing, and appending it there would be false — those three
        // are a KEEP, and Reads and Receipts were deliberately removed from the unsubscribe
        // service's actionable set.
        //
        // BOTH REJECTS ARE COUNTED, and `spam` is not defensive padding: this control used to
        // exclude spam from what it applies, and no longer does (see the predicate below). A
        // condition written on `screened` alone would silently say nothing about a batch of
        // twelve spam verdicts — the largest single hand-off to the mechanism this surface can
        // make — which is the disclosure failing precisely where it matters most.
        const unsub = autoUnsubscribe && n("screened") + n("spam") > 0 ? "true" : "false";
        return t("toastBulkDecided", { count: snaps.length, parts: parts.join(" · "), unsub });
      },
      // `dest !== "screener"` is the second half of the rule above, load-bearing rather than
      // defensive: the server's `hold` arrives here as `screener`, meaning the classifier
      // declined to place this sender and left the choice to the person working the queue —
      // acting on it in bulk is a consent gate granting consent. Without this, the cast above
      // would send "screener" to `decide` as a `DecisionDestination`, which is not one of the
      // five.

      // And it is the ONLY exclusion. Spam used to be the second, arguing that spam is a
      // judgement about a stranger and `markAllSpam` already exists. Reported from live use:
      // "when auto-applying the AI suggestions it stops at the spam" — a control labelled
      // "Apply 12" that leaves five rows standing has failed halfway as far as anyone using it
      // can tell. The safety argument does not survive what the press does: a spam decision is
      // `{decision:"no", dest:"spam"}` — a MOVE to `ohmail/Quarantine` plus the same rule and
      // retro pass every destination writes; nothing is deleted, the Spam segment lists the
      // pile with "Not spam" verbs on every row, and `undo` covers the window. It is exactly as
      // reversible as the screen-out this control always performed. `markAllSpam` stays: it
      // answers a different question ("all of this is junk") and needs no suggestions.
      (x) => x.ai != null && x.ai.dest !== "screener",
    );

  const markAllSpam = (scopeOf: (x: ScreenerSenderDTO) => DecisionScope) =>
    bulk(
      () => "spam",
      scopeOf,
      // The highest-volume path to the mechanism there is — forty senders in one press, every one
      // of them a reject — so this summary is where the sentence matters most, not least.
      (snaps) => t("toastBulkSpam", {
        count: snaps.length, unsub: autoUnsubscribe ? "true" : "false",
      }),
    );

  /**
   * Releasing a sender the Screener already decided about. There is no un-screen endpoint: `decide` resolves `:id`
   * only against mail whose DESIRED folder is still `ohmail/Screener`, so a screened-out or quarantined
   * representative is a 404; per-message `move` releases the mail physically filed here. It still creates no rule —
   * but it RETARGETS the rules holding the sender here (this used to say "it creates no rule" and stop, which made
   * the release unperformable for a sender whose segment membership came from a rule — see {@link releaseHeld}; live,
   * 2026-08-19).
   */

  /**
   * Retargeting is the reversal of the decision those rows record, and the only rewrite that moves ingest along with
   * the presentation: a fresh allow rule beside a standing deny rule loses every tie (`compareRules`, deny before
   * allow before kind), so future mail would have kept arriving in Quarantine. @param segment the pile the sender is
   * released FROM — named by a refusal, and where they remain if refused. Passed rather than derived because
   * `release` serves both `allowScreened` (Screened out) and `notSpamToOhbox` (Spam), identical from in here.
   */
  const release = (sender: ScreenerSenderDTO, dest: "ohbox" | "reads", segment: "screened" | "spam") => {
    // The RAW mirror, exactly as `commit` re-reads it: rules and physical folders are locations,
    // and the projected reader answers presentations.
    const raw = engine.read();
    const wanted = FOLDER_OF_VIEW[dest];
    const segFolder = segment === "spam" ? FOLDER_OF_VIEW.spam : FOLDER_OF_VIEW.screened;
    const retargets: EngineMutation[] = holdingRules(raw, sender.from.address, segFolder)
      .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: wanted }));
    // Both halves are WATCHED. `toastReleased` below is raised at press time and states the
    // release as done — which was the only thing on screen when the moves were refused, beside a
    // row that had not moved. Keeping it and adding the refusal is the same pairing `decide`
    // uses: the optimistic sentence when the press happens, the truth when the wire has answered.
    void releaseHeld(retargets, physicallyHeldIn(raw, sender, segFolder), wanted).then((landed) => {
      if (landed) clearRefused(sender);
      else refuseRelease(sender, segment);
    });
    // TWO SENTENCES, BECAUSE ONLY ONE OF THEM IS TRUE AT A TIME. `toastReleased` says "No rule
    // was made, so future mail is unchanged" — true for the no-rule release this always was, and
    // FALSE the moment a holding rule is retargeted above: that retarget is precisely a statement
    // about future mail. Claims are contracts; the toast follows what was actually dispatched.
    toast(
      t(retargets.length > 0 ? "toastReleasedRuled" : "toastReleased", {
        count: sender.held.length,
        sender: displayAddress(sender.from.address),
        dest: piles[dest],
      }),
    );
  };

  const allowScreened = (sender: ScreenerSenderDTO, dest: "ohbox" | "reads") => {
    clearRefused(sender);
    if (sender.derived) {
      release(sender, dest, "screened");
      return;
    }
    // A FIXTURE row's decide, and it is watched for the same reason the derived moves are. It is
    // served in-process by `FixturesAdapter` so it opens no socket, but `Engine.mutate` still
    // answers `rolled_back` with nothing sent when `mutationEffects` finds no target — a sender
    // whose fixture row has been drained away between the render and the press. That rolls the
    // overlay back and put the row straight back into Screened out under a toast saying "Allowed".
    void engine.mutate({
      kind: "screener_decide",
      senderId: sender.id,
      decision: "yes",
      dest,
      scope: "sender",
    }).then(
      (res) => { if (res.status === "rolled_back") refuseRelease(sender, "screened"); },
      () => refuseRelease(sender, "screened"),
    );
    toast(
      t("toastAllowed", {
        count: sender.held.length,
        sender: displayAddress(sender.from.address),
        dest: piles[dest],
      }),
    );
  };

  const notSpamToWaiting = (row: SpamRow) => {
    if (row.pinned) return;
    clearRefused(row.sender);
    if (row.sender.derived) {
      // Back to Waiting means UNDECIDED: the holding rules are DELETED, never retargeted — no
      // rule may point at the gate (`ohmail/Screener` is held mail, not a consent destination,
      // and `consentIndex` skips such rules anyway), and a sender back in the queue is a sender
      // with no decision on record. With the rules gone, their INBOX mail presents at the gate
      // by the cutline itself; only the mail physically in Quarantine needs a real move there —
      // the derived queue reads the folder, so a local override would show a row whose mail is
      // still quarantined and whose decision would 404.
      //
      // WATCHED, like every other release: a refused deletion or move leaves the sender in Spam,
      // and the toast below states them as back in Waiting.
      const raw = engine.read();
      const deletions: EngineMutation[] = holdingRules(raw, row.sender.from.address, FOLDER_OF_VIEW.spam)
        .map((r) => ({ kind: "rule_delete", ruleId: r.id }));
      void releaseHeld(
        deletions,
        physicallyHeldIn(raw, row.sender, FOLDER_OF_VIEW.spam),
        FOLDER_OF_VIEW.screener,
      ).then((landed) => {
        if (landed) clearRefused(row.sender);
        else refuseRelease(row.sender, "spam");
      });
      toast(t("toastNotSpamWaiting", { sender: senderLabel(row.sender) }));
      return;
    }
    // Nothing to watch on this branch — `overrides` is a local view-state flip for a FIXTURE row
    // and no mutation is sent. The demo's own semantics, stated in this file's header.
    s.overrides.add(row.sender.id);
    bump();
    toast(t("toastNotSpamWaiting", { sender: senderLabel(row.sender) }));
  };

  const notSpamToOhbox = (row: SpamRow) => {
    clearRefused(row.sender);
    if (row.pinned) {
      // The engine already filed this sender's held mail to Quarantine —
      // release it to the Ohbox with real move mutations.
      const quarantined = reader
        .list<EngineMessage>("message")
        .filter(
          (m) =>
            m.folder === FOLDER_OF_VIEW.spam &&
            m.from.address === row.sender.from.address,
        );
      /**
       * The pin is optimistic state, and it is the one piece the engine cannot roll back. Every other reversal on
       * this segment is undone for us — the engine drops its overlay and the derived row reappears. The pin is this
       * session's memory of a spam decision, which `pinnedKeys` uses to hold the derived row for the same address OUT
       * of the list. "The derived row comes back anyway" is not an argument for dropping it: for a sender with one
       * quarantined message it returns under the same id, but a sender with OTHER, NEWER quarantined mail gets a row
       * minted on the newest message (`selectors.ts#screenerSegments`) — an id this press never named, `refusalKeys`
       * does not cover, and the refusal renders as nothing. Restoring the pin keeps the row that was pressed, with
       * the id the mark is on and its still-true "You marked this" caption.
       */

      /**
       * Restored at its own index (a pin's position is the order the reader marked senders in), guarded on absence so
       * a re-pinned sender is not listed twice.
       */
      const pinAt = s.pins.findIndex((p) => p.id === row.sender.id);
      s.pins = s.pins.filter((p) => p.id !== row.sender.id);
      bump();
      // The decide that pinned this sender PROMOTED a rule to `ohmail/Quarantine` server-side,
      // and by now the drain has put it in the mirror. Releasing the mail while that rule stands
      // is the leckker defect one press later: the moved mail re-presents in Spam and every
      // future arrival is quarantined. Retargeted to INBOX beside the moves, both watched.
      const retargets: EngineMutation[] = holdingRules(reader, row.sender.from.address, FOLDER_OF_VIEW.spam)
        .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: "INBOX" }));
      void releaseHeld(retargets, quarantined.map((m) => m.id), "INBOX").then((landed) => {
        if (landed) {
          clearRefused(row.sender);
          return;
        }
        if (!s.pins.some((p) => p.id === row.sender.id)) {
          const back = [...s.pins];
          back.splice(pinAt < 0 ? s.pins.length : pinAt, 0, row.sender);
          s.pins = back;
        }
        // Bumps and raises the sentence — so the row is back and marked in one render.
        refuseRelease(row.sender, "spam");
      });
    } else if (row.sender.derived) {
      release(row.sender, "ohbox", "spam");
      return;
    } else {
      // The fixture decide, watched for the reason `allowScreened`'s is.
      void engine.mutate({
        kind: "screener_decide",
        senderId: row.sender.id,
        decision: "yes",
        dest: "ohbox",
        scope: "sender",
      }).then(
        (res) => { if (res.status === "rolled_back") refuseRelease(row.sender, "spam"); },
        () => refuseRelease(row.sender, "spam"),
      );
    }
    toast(t("toastNotSpamOhbox", { sender: senderLabel(row.sender) }));
  };

  const deleteSpam = (row: SpamRow) => {
    if (row.pinned) s.pins = s.pins.filter((p) => p.id !== row.sender.id);
    else s.hidden.add(row.sender.id);
    bump();
    toast(t("toastDeleted", { sender: senderLabel(row.sender) }));
  };

  const flush = () => {
    for (const id of [...s.pending.keys()]) commit(id);
  };

  /**
   * Decisions this session inherited — the restart half of the durable-intent contract. Loaded
   * ONCE, then drained as the mirror becomes able to carry each one. Once:
   * `restoredIntents.current === null` is the latch — without it a remount (strict mode's
   * double-invoke, a route rebuilding the shell) would re-read the journal while this session's
   * timers are still armed and dispatch each decision twice; and an id already in `s.pending`
   * belongs to a live timer, the same rule `OhmailEngine.restoreOutbox` states in its own words.
   */

  /**
   * As the mirror becomes able — the failure the fix would otherwise have OPENED, the one that makes a durable replay
   * worse than none. A derived row's id is a representative MESSAGE id, and at boot the mirror is cold:
   * `engine.read().get("message", id)` answers nothing until the first drain, so `dispatchDecision` on an absent rep
   * takes the past-the-gate branch, `senderScreening` answers null, and the decision is REFUSED locally — "Not saved"
   * on a row nobody is looking at. Replaying at mount would convert "the decision survives a crash" into "the
   * decision is destroyed on the next boot, looking like a server refusal". So the effect re-runs on `version` — the
   * mirror's own revision, already this hook's render key — and dispatches only the intents the mirror can now name;
   * a fixture intent goes on the first pass.
   */

  /**
   * Anything undispatched stays IN the journal for the next boot, or is swept by {@link INTENT_TTL_MS}; nothing is
   * consumed by an attempt that could not be made. No timer and no deadline on purpose: a deadline must choose
   * between dispatching into a cold mirror and discarding the decision, and the journal already has a bound that
   * needs neither.
   */
  const restoredIntents = useRef<ScreenerIntent[] | null>(null);
  /**
   * THE HANDSHAKE, AND WHY THE REPLAY WAITS FOR IT.
   *
   * A claim broadcast at the press cannot reach a tab that was not open yet, so a booting tab has
   * to ASK — and a replay that fired before the answer came back would be the very sequence the
   * handshake exists to refuse. `asked` is what the restore effect below waits on; it is set once
   * and the wait is a no-op on a surface with no bus (see `intent-windows.ts#ask`).
   */
  const asked = useRef(false);
  useEffect(() => {
    windows.serve(() => [...s.pending].map(([id, e]) => ({ id, at: e.at })));
    let alive = true;
    void windows.ask().then(() => {
      if (!alive) return;
      asked.current = true;
      bump();
    });
    return () => {
      alive = false;
      windows.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    /**
     * AND NOT ON A MAILBOX THIS INSTALL NO LONGER ORGANIZES. The journal outlives the session that wrote it, so an
     * install that organized yesterday and is a reader today would replay decisions the engine will not make — the
     * exact rollback-with-no-reason this slice closes, arriving through the durable path instead of a keypress.
     * Nothing is consumed: the entries stay in the journal for the next boot, and age out on {@link INTENT_TTL_MS} if
     * this install never gets the mailbox back. `blocked` ONLY, on the same argument the live guard makes: a decision
     * restored onto a mailbox whose organizer WILL carry it out is a decision the person made and the product kept,
     * which is what the journal is for. Only the state with nowhere to send it withholds the replay.
     */
    if (role.mode === "blocked") return;
    /**
     * THE READ HAPPENS AT MOUNT; ONLY THE DISPATCH WAITS FOR THE OTHER TABS. The order matters and getting it wrong
     * dispatched twice. This effect re-runs on the local tick as well as on the mirror's version, so with the read
     * behind the handshake's gate the FIRST journal read landed after a press — where the jar still holds this
     * session's own intent while its commit is in flight (the disarm settles with the mutation, `s.pending` is
     * already cleared), so the replay took it as stranded and sent it a second time. Measured as a duplicate
     * `mark_seen` and a duplicate demote in the bulk paths. Read once at mount, before anything can be pressed,
     * exactly as this effect always did.
     */
    if (restoredIntents.current === null) {
      restoredIntents.current = takeScreenerIntents(Date.now())
        .filter((r) => !s.pending.has(r.id));
    }
    if (!asked.current) return;
    /* A ROW ANOTHER TAB HAS RESOLVED LEAVES THIS SNAPSHOT FOR GOOD. The journal read is taken
       once, so an entry the owning tab has since committed or taken back is still in it here —
       and dispatching that is a second act on one press. */
    const resolvedElsewhere = windows.resolved();
    const queue = restoredIntents.current.filter((r) => !resolvedElsewhere.has(r.id));
    restoredIntents.current = queue;
    if (queue.length === 0) return;
    const raw = engine.read();
    /* AND NOT A ROW WHOSE WINDOW IS STILL OPEN IN ANOTHER TAB. It stays in the journal and in this
       snapshot: whichever way that tab resolves it, this one learns from the release. */
    const owned = windows.elsewhere(Date.now(), COMMIT_MS);
    const ready = queue.filter((r) => !owned.has(r.id)
      && (!r.derived || raw.get<EngineMessage>("message", r.id) != null));
    if (ready.length === 0) return;
    restoredIntents.current = queue.filter((r) => !ready.includes(r));
    for (const r of ready) dispatchDecision(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick]);

  /**
   * See {@link HeldBodyStall}. The RAW reader, deliberately: the projection answers where a
   * message PRESENTS, and this asks two questions about the message itself — does it exist, and
   * is it protected. `isProtectedMessage` rather than a re-derived test, because it is the exact
   * predicate `hydrateBody` uses to decide not to fetch, and the whole defect was a surface
   * disagreeing with that decision.
   */
  const bodyStall = (messageId: string): HeldBodyStall | null => {
    const m = reader.get<EngineMessage>("message", messageId);
    if (!m) return "absent";
    return isProtectedMessage(m) ? "protected" : null;
  };

  // A pinned sender and the DERIVED row for the same address are the same sender: the
  // pin is this session's memory of a decision whose mail the mirror now reports sitting
  // in `ohmail/Quarantine`. Without the address filter, marking a sender spam lists them
  // twice the moment the move lands.
  const pinnedKeys = new Set(s.pins.map((p) => senderKey(p.from.address)));
  const spam: SpamRow[] = [
    ...s.pins.map((p) => ({ sender: p, pinned: true })),
    ...segments.spam
      .filter((x) => !s.overrides.has(x.id) && !s.hidden.has(x.id) && !pinnedKeys.has(senderKey(x.from.address)))
      .map((x) => ({ sender: x, pinned: false })),
  ];

  /**
   * WHAT A DECIDING VERB DOES ON A MAILBOX THIS INSTALL DOES NOT ORGANIZE — say so, do nothing. ONE sentence for all
   * seven verbs, and one wall for all seven, which is the point of putting it at the return rather than at the top of
   * each: the list below is complete by construction, and a verb added later that is not wrapped is a verb visibly
   * outside the guard rather than one that silently escaped it. `test/screener-reader.test.ts` asserts the exact set.
   * It raises a toast and does NOT touch `s.refused`: that mark means "the wire would not take your decision", which
   * is a thing that happened to a row. Nothing happened to a row here — nothing was armed, nothing was dispatched, no
   * overlay moved, and the queue does not flicker.
   */
  const refuseReadOnly = (): void => {
    toast(role.name
      ? t("readerRefused", { name: role.name })
      : t("readerRefusedUnknown"));
  };
  /**
   * WHAT A READER MAY NOT DO WHATEVER ITS ORGANIZER OFFERS — a MOVE, and the sentence says so. Releasing a
   * screened-out sender, rescuing mail out of Quarantine and deleting it are folder moves against mail another
   * install is organizing. They are refused for EVERY reader, in both modes, because the channel a decision travels
   * carries a decision and nothing else: there is no vocabulary for "move this mail" in it, and inventing one here
   * would put two installs on the same folder at once, which is the invariant the whole organizer lease exists to
   * hold. Its own sentence, and not the decide refusal's: on a `pending` reader "this computer does not decide about
   * senders" is FALSE — it does, and the press works. What it does not do is move mail, which is a different thing to
   * be told.
   */
  const refuseMove = (): void => {
    /* THE ACCOUNT-SCOPED FORM, and it stays here rather than moving to the shared predicate.
       `mail-state.ts#readerMoveRefusal` asks about NAMED MAILBOXES, which is the right question
       for a message verb and the wrong one for the Screener: its queue does not say which mailbox
       a sender belongs to, so there is no id to pass, and a decision writes an ACCOUNT-scoped
       rule. The two share the sentence — the same two catalogue keys — and differ in what they
       ask, which is the honest split. */
    toast(role.name
      ? t("readerMoveRefused", { name: role.name })
      : t("readerMoveRefusedUnknown"));
  };
  const guardMove = <A extends unknown[]>(verb: (...args: A) => void) =>
    (role.mode === "organizer" ? verb : ((..._args: A) => refuseMove()));
  /**
   * A DECIDING VERB — walled in `blocked` ONLY, and that is the whole of what the mode split
   * changed here.
   *
   * `pending` goes THROUGH: the press has an organizer to travel to, so refusing it would be the
   * mirror image of the defect this guard exists for — a control withheld from somebody whose
   * decision would in fact be carried out. What `pending` changes is the sentence AFTERWARDS,
   * which is `markQueued`'s business and not this one's.
   */
  const guard = <A extends unknown[]>(verb: (...args: A) => void) =>
    (role.mode === "blocked" ? ((..._args: A) => refuseReadOnly()) : verb);

  return {
    waiting: visibleWaiting,
    waitingCount,
    suggestedCount,
    suggestedDests,
    unsuggestedSenders,
    suggestedSenders,
    applying: s.applying,
    screenedOut: segments.screenedOut,
    spam,
    isExiting: (id) => s.pending.has(id),
    refused: (id) => s.refused.has(id),
    bodyStall,
    /**
     * THE SEVEN VERBS THAT WRITE, every one behind a wall — but not the SAME wall, and the split is the point rather
     * than an inconsistency. The first three express a DECISION about a sender, which is the one thing a reader's
     * organizer will carry out on its behalf, so they are open wherever there is an organizer to carry it out. The
     * last four MOVE MAIL — a release out of Screened, a rescue out of Quarantine, a delete — and no organizer takes
     * those from a reader in any mode. `flush` is deliberately outside both. It commits decisions ALREADY armed, so
     * on a blocked reader there are none and wrapping it would only make a route change raise a sentence about
     * nothing; on a pending one the armed decisions are exactly the ones that should be sent.
     */
    decide: guard(decide),
    applyAll: guard(applyAll),
    markAllSpam: guard(markAllSpam),
    allowScreened: guardMove(allowScreened),
    notSpamToWaiting: guardMove(notSpamToWaiting),
    notSpamToOhbox: guardMove(notSpamToOhbox),
    deleteSpam: guardMove(deleteSpam),
    flush,
    role,
    pending: pendingDecisions,
    decided,
    notApplied,
  };
}
