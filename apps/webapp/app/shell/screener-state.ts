"use client";

/**
 * Screener decisions with a real undo window on a real engine.
 *
 * The wire vocabulary has no inverse for `screener_decide` (the server
 * has no un-decide endpoint either), so undo is a DELAYED COMMIT: a
 * decision hides the row and counts instantly, the toast carries Undo,
 * and the engine mutation fires when the window closes. Navigating away
 * (or switching segments) flushes pending commits so destinations are
 * always up to date when you look at them.
 *
 * Client view-state that Stage 2 replaces with wire endpoints:
 *  - senders you mark spam stay visible in the Spam segment (pinned
 *    locally; the engine files their held mail to Quarantine + a rule);
 *  - "Not spam → Screener" pulls a fixture spam sender back to Waiting;
 *  - "Delete" hides a spam row.
 *
 * DERIVED ROWS. On a Cloud account every row comes out of the
 * message mirror, not out of a `screener_sender` fixture, and the two are
 * not interchangeable here: `POST /screener/:id` resolves only mail still
 * held in `ohmail/Screener`, so a sender who has already left the gate is a
 * 404 and is released with `move` instead. `sender.derived` is the switch.
 *
 * WHAT THE DECIDE CARRIES, AND WHAT IT USED TO NOT. This comment said the
 * endpoint "has exactly two outcomes (yes ⇒ INBOX, no ⇒ ohmail/Screened)"
 * and that a derived row "composes the rest out of `move`". Both were true
 * and the composition did not work: `decide` reads its held rows outside its
 * transaction and writes `desired_folder` inside it, so a `move` fired
 * beside it was clobbered as often as not. `POST /screener/:id` now takes
 * `dest`, all five destinations ride the decision itself, and the only thing
 * still composed on top is `mark_seen` for "&read" — a flag, not a folder.
 *
 * GATE-PHYSICAL vs PAST THE GATE (#116). `derived` is not the whole switch.
 * The queue is built from the PROJECTED mirror, so a row can represent an
 * active-undecided sender whose mail is physically in the INBOX and merely
 * PRESENTED at the gate. A decide on that rep is a no-op that claims success —
 * the server 404s it, the engine rolls it back with nothing sent. So `commit`
 * re-reads the RAW mirror: a rep genuinely at `ohmail/Screener` takes the
 * decide above; one that only presents there is routed PAST THE GATE, through
 * the sender sheet's own `planScreeningChange`/`dispatchScreeningChange` —
 * a `rule_create` (destination INBOX for a screen-in) with `applyRetro`,
 * AWAITED so the toast is chosen from what the server returned. Once the rule
 * lands, the whole sender's bag presents in the Ohbox with zero server moves.
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
import {
  armScreenerIntent,
  disarmScreenerIntent,
  takeScreenerIntents,
  type ScreenerIntent,
} from "./screener-intents";
import {
  dispatchScreeningChange,
  holdingRules,
  planScreeningChange,
  senderScreening,
} from "./sender-screening";
import { PLACE_LABEL } from "./format";
import { displayAddress, displayAddressee, displayDomain, displayDomainLabel } from "./idn";
import { activeFormatZone } from "./locale";
import { useAppLocale } from "./LocaleContext";
import {
  DECISION_DONE_LABEL,
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
 * WHY A HELD MESSAGE'S BODY IS NEVER GOING TO ARRIVE.
 *
 * `ScreenerHeldMail.bodyState` answers what the text on screen IS — `snippet`, `loading`,
 * `failed`, `full`. It cannot answer whether a `snippet` is a body in flight or a body nobody
 * will ever fetch, because that is not a fact about the body record; it is a fact about the
 * MESSAGE, and it is `OhmailEngine.hydrateBody` that holds it.
 *
 *  · `protected` — sensitive mail. `hydrateBody` returns without asking, and purges any body a
 *    previous build cached, because a protected message must hold no raw text at rest. There is
 *    no request, so there is nothing to wait for.
 *  · `absent`    — the id is not in the mirror. A fixture `screener_sender`'s held ids are not
 *    message ids at all, and a real row can be drained away or evicted by the windowed store.
 *    `hydrateBody` returns on `if (!msg)`, again without asking.
 *
 * Both were rendered as "Loading the full message…" with no control and no end: the preview
 * claimed a request the engine had already decided never to make. Reading the same predicate
 * `hydrateBody` reads is what keeps the two from drifting apart again.
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
   * How many of those rows actually CARRY a suggestion.
   *
   * Never assume this tracks `waitingCount`. `selectors.ts` mints `ai: null` for every
   * derived row — `/sync` carries no suggestion, because a suggestion is advice about mail
   * rather than a change to it, and no classifier runs client-side — so on a live account
   * this is 0 until something buys one. What buys one is `shell/screener-suggest.ts`, whose
   * result arrives here as the `suggestions` overlay; before that surface existed the number
   * could ONLY be 0 outside the demo, which is why "Apply all" had nothing to apply.
   *
   * It exists so the surface can decline to offer "Apply all suggestions" over an
   * empty set rather than quietly meaning something else.
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
   * The waiting senders that ALREADY have a suggestion, in the queue's own order — the batch a
   * re-ask would be composed from, and the count the resting state states.
   *
   * The complement of {@link unsuggestedSenders} within the set the server can speak for, and
   * never within the whole queue: see the derivation for why every eligibility filter is repeated
   * here instead of subtracting one list from another.
   *
   * It exists because a Screener whose every sender has been answered for used to render no AI
   * surface at all — the buy control hid itself on an empty buy list, and "there is nothing left
   * to buy" and "this feature is not here" looked identical.
   */
  suggestedSenders: string[];
  /**
   * HOW FAR A BULK IS THROUGH ITS OWN QUEUE — `null` unless one is running.
   *
   * `applyAll` and `markAllSpam` do not decide forty rows in one frame. Every row is dispatched
   * on its own `BULK_STEP_MS` timer, so a forty-sender press is ten seconds of work, and until
   * this field existed the only evidence any of it was happening was rows sliding away one at a
   * time. A person who pressed "Apply 40" and saw the first three move had no way to tell a
   * stagger from a stall, and the summary toast — the one thing that states a number — does not
   * arrive until the LAST row has been dispatched.
   *
   * `done` counts rows whose `decide` has actually run, not rows whose timer has been scheduled:
   * scheduling is instantaneous for the whole set and would report 40 of 40 in the first frame.
   * `total` is the set the press acted on, which is `waiting` minus what was already pending —
   * the same filter `bulk` itself applies, read from the same array, so the denominator can never
   * name rows the run will not touch.
   *
   * Cleared when the run ends, on the same timer that raises the summary toast: a bar left full
   * is a claim that work is still in flight, and the toast is what says the work is finished.
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
   * THIS ROW'S DECISION WAS REFUSED, and it is back in the queue because of that.
   *
   * ── A SILENTLY ROLLED-BACK DECISION WAS THE WHOLE OF A REPORTED DEFECT ────────────────────
   *
   * `commit` used to fire `void engine.mutate({kind:"screener_decide", …})` and never look at the
   * result. A refusal — the server's 404 for a row that is no longer held at the gate, which is
   * reachable whenever this mirror is a poll behind another writer (a second device, the retro
   * pass) — rolled the overlay back, restored nothing, and said nothing. The row simply reappeared
   * on the next visit, indistinguishable from a decision never made. Reproduced end-to-end in
   * `test/screener-decision-holds.test.ts`: screen one sender in and one out, leave for the Ohbox, come
   * back, and both are waiting again with no error anywhere on the page.
   *
   * So a refusal is now a STATE, not an absence. The row returns carrying it, and it survives the
   * toast — a capsule that has faded cannot be the only record of a decision that did not happen.
   * Cleared when the same row is decided again (see `decide`), because that is a fresh attempt.
   *
   * ── AND IT ANSWERS FOR THE UNDO OF A DECISION AS WELL AS THE DECISION ─────────────────────
   *
   * `allowScreened` and both halves of `notSpamToOhbox`/`notSpamToWaiting` — the controls that take
   * a sender back OUT of Screened out or Spam — carried the identical defect for as long: an
   * unwatched `void engine.mutate`, an optimistic toast stating the release as done, and a row that
   * quietly reappeared where it had been. Worse in one respect, because there is no undo window on
   * those presses, so the toast was the only account of them the reader ever got. They now report
   * through the same mark, in the same words, keyed so a PARTIAL release still marks the row that
   * comes back (see `refusalKeys`). Asked by all three segments' rows in `ScreenerView`.
   */
  refused: (id: string) => boolean;
  /** Commit every pending decision now (route/segment changes). */
  flush: () => void;
}

const OUT_MS = 330;
/**
 * ═══ HOW LONG "UNDO" IS TRUE, AND THE TWO NUMBERS THAT HAVE TO AGREE ═══════════════════
 *
 * Observed in real use: "Ohbox — filed … Undo" was still on screen twenty minutes later,
 * across every view, until another toast replaced it.
 *
 * ── WHAT IS ACTUALLY REPRODUCIBLE, MEASURED RATHER THAN ASSUMED ────────────────────────
 *
 * `ToastHost` (`packages/ui/src/primitives/Toast.tsx`) DOES run a timer, and it does drop the
 * `on` class on schedule — so `.toast{opacity:0;pointer-events:none}` takes the capsule off
 * screen. What it never does is clear `toast` state, so the message and its **`<button>` stay
 * mounted for ever**: still in the accessibility tree of a `role="status"` region, still
 * `tabIndex 0`, still firing `onAction` when activated. `pointer-events:none` stops a mouse; it
 * does not stop Tab + Enter, and it does not stop a screen reader. Proven in jsdom: 20 minutes
 * after the toast, the node still read `"Ohbox — filed.Undo"` and activating the button still
 * called `onAction`.
 *
 * ── AND THAT IS THE SMALLER HALF. THE UNDO WAS ALREADY DEAD BY THEN ────────────────────
 *
 * `commit` fires on its own timer and `undo` only restores rows still in `pending`. So a press
 * after the commit window restored NOTHING and then said `toastUndone` with `count: 0` —
 * **"Undone — 0 waiting again."** — which is the product claiming an act it did not perform, on
 * the one screen a user goes to in order to check. That is the defect worth fixing; the stale
 * button is what makes it reachable.
 *
 * ── SO THE WINDOW IS ONE NUMBER, DECLARED ONCE ────────────────────────────────────────
 *
 * The acceptance asks for an 8–10 s dismissal *and* asks what Undo does after that long. The two
 * questions are the same question: the toast may not outlive the act it offers to reverse, or it
 * is a live control for something that has already happened. `UNDO_MS` is the offer, and the
 * commit is deliberately derived from it rather than written beside it — the shipped pair was
 * 6000 (toast) against 6200 (commit), which had already left a 200 ms slice of exactly this bug
 * and would have grown to 2–4 s had the toast simply been lengthened to 8 s.
 *
 * `COMMIT_GRACE_MS` covers `toast.css`'s own .25 s opacity transition, so the capsule is
 * visually gone before the decision is sent, never after.
 *
 * `undo()` is still guarded independently and always will be. A number cannot fix a control that
 * outlives its own toast; only refusing to claim an undo that did not happen can.
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
 * The piles the apply control may name, in the order it names them.
 *
 * The five `applyAll` can actually file into, and no more: `screener` is the model declining to
 * place a sender, which is the one answer a bulk may not act on (`applyAll`'s predicate states
 * why). A sixth member here would put a pile in the label that the press does not deliver, which
 * is the "Apply all (83)" lie one control over — and, symmetrically, a destination the press DOES
 * deliver but this list omits is the "it stopped at the spam" report this list used to produce.
 *
 * Ohbox first, then the two automated piles, then the demotion, then the judgement — least to
 * most consequential, so a reader scanning "Apply 12 — Ohbox, Reads, Receipts & Spam" meets the
 * admissions before the filing and the filing before the verdict.
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
   * THE MIRROR AS IT IS PRESENTED — `presentationReader(engine.read(), consentPartition(…))`.
   *
   * The queue is built from THIS and the mutations are built from the raw mirror, and the split
   * is the whole point rather than an implementation detail.
   *
   * `screenerSegments` groups by `m.folder`, so handed the raw mirror it answers "whose mail is
   * filed in `ohmail/Screener`". That is not the question the Screener asks. On any mailbox that
   * has been through a backfill the two answers diverge by an order of magnitude — the folder
   * holds a sender row for every stranger who ever wrote, the queue only those still worth
   * asking about — because a backfill files every stranger's mail into the Screener folder and
   * the cutline is what decides which of those senders a decision is still wanted for.
   * Three ways it went wrong before this argument existed: a sender who went quiet
   * years ago was a queue row AND a History row at once; a sender the user had already consented
   * to was asked about again while their mail presented in the Ohbox; and an active stranger
   * whose mail sat in the INBOX appeared in no pile whatsoever, because the projection moved it
   * out of the Ohbox while the raw folder kept it out of the Screener.
   *
   * OPTIONAL, and absent means the raw mirror — which is what the demo and any caller without a
   * partition want, and is exactly the behaviour every caller had before this parameter existed.
   */
  presented?: EntityReader,
  /**
   * WILL A SCREEN-OUT OR A SPAM PRESS ACTUALLY SEND THE ONE-CLICK UNSUBSCRIBE? — the account
   * switch (mail 0054) ANDed with "this build has a service that can" (`AppShell`'s
   * `autoUnsubscribeDiscloses`).
   *
   * It changes ONE thing: whether the two demoting toasts state the consequence. Nothing here
   * sends, nothing here is gated on it, and no mutation looks at it — the server reads its own
   * row at the seam, which is what makes the switch enforceable rather than advisory.
   *
   * The Screener says this AFTER the press rather than before it, and that is a departure from the
   * sender sheet's confirm which is worth being explicit about. The Screener IS the triage loop:
   * one key per stranger, dozens in a sitting, and a confirm in front of every `n` and `x` would
   * make the queue unusable — which is why the disclosure that has to be a gate lives on the
   * sheet, where a click can widen to a whole domain at once. What this owes is that the thing
   * happening is visible while it can still be undone, and the toast carries the undo.
   *
   * **Defaults to TRUE, so a caller that has not been taught about the switch still says it.** The
   * failure to avoid is the silent one: a decision that quietly leaves a mailing list.
   */
  autoUnsubscribe = true,
): ScreenerState {
  const t = useTranslations("screener");
  // The past-the-gate branch of `commit` speaks the sender-sheet's own sentences (`toastRuled`,
  // `toastRuleFailed`, …), chosen from what the server actually returned — so it reads them from
  // the `screening` namespace, exactly as `AppShell#changeScreening` does.
  const ts = useTranslations("screening");
  const [, bump] = useReducer((c: number) => c + 1, 0);
  const store = useRef({
    pending: new Map<string, PendingEntry>(),
    out: new Set<string>(),
    pins: [] as ScreenerSenderDTO[],
    overrides: new Set<string>(),
    hidden: new Set<string>(),
    /** See {@link ScreenerState.refused} — rows whose decision the wire would not take. */
    refused: new Set<string>(),
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
    () => screenerSegments(queueReader, undefined, locale, activeFormatZone()),
    [queueReader, version, locale],
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
   * Move a sender's whole bag, and ANSWER WHETHER IT ALL LANDED.
   *
   * ── THIS USED TO BE `for (…) void engine.mutate(…)` AND IT IS THE RELEASE FAMILY'S WHOLE BUG ──
   *
   * Every reversal on the Screened-out and Spam segments comes through here or through the two
   * decides beside it: "Allow" on a screened-out sender, "Not spam → Ohbox", "Not spam → Screener".
   * With the results thrown away, a refused move rolled the engine's overlay back — so the row
   * reappeared in the segment it was pressed in — while the toast raised at press time went on
   * stating the release as done. That is the same shape `commit` carried (see
   * {@link ScreenerState.refused}), one surface over, and it is worse here in one respect: there is
   * no undo window and no second confirmation, so the toast was the only thing the reader ever saw.
   *
   * `false` on ANY refusal, not on all of them: this is one act as far as the reader is concerned
   * ("release this sender's mail"), and a release that moved four of five messages has not happened.
   * The sender is still listed either way, because the mail that did not move keeps their row alive.
   *
   * A rejected promise counts as a refusal for the same reason it does in `commit`. A `queued`
   * result does NOT — the mutation is on the retry queue with its Idempotency-Key and the user's
   * intent stands, which is the one status where the mail staying visibly moved is truthful.
   *
   * Empty ⇒ `true`. Nothing was asked for and nothing failed; this is what the loop already did.
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
   * A RELEASE IS TWO HALVES NOW, AND THE ANSWER IS THEIR CONJUNCTION.
   *
   * The rule half is what was missing, and its absence is the leckker defect (2026-08-19, live):
   * a sender with an enabled rule pointing at `ohmail/Quarantine` presents their INBOX and
   * Screener mail in Spam ({@link holdingRules} states the projection), so a release made of bare
   * `move`s failed twice over — a move for mail already physically at the destination is the
   * engine's LOCAL 404 (no effects, nothing sent), and the moves that did land were re-presented
   * straight back by the rule. "That change could not be saved. Try it again." was true forever.
   *
   * So the callers pass the rule rewrites ({@link holdingRules} mapped to `rule_update` or
   * `rule_delete`) beside the moves, and the moves cover ONLY mail physically in the segment's
   * own folder ({@link physicallyHeldIn}) — everything else is where the rule change alone
   * re-presents, and the server's retro pass makes physical later (`PATCH /rules/:id` re-arms
   * `retro_requested_at` by default, so a retarget walks the whole backlog, including mail the
   * windowed mirror has evicted).
   *
   * Both halves are watched, on `moveAll`'s own doctrine: `rolled_back` or a rejection is a
   * refusal, `queued` is not (the intent stands on the retry queue). NOTHING TO DO IS A REFUSAL —
   * a press that can dispatch neither a rule rewrite nor a move cannot change what the reader is
   * looking at, and answering "landed" would drop the row under a toast about a release that
   * never happened.
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
   * THE ROW CAME BACK AND IT SAYS SO — the durable half, with no sentence attached.
   *
   * Separate from the toast because the two have different owners. The MARK belongs to every
   * failure path without exception: a row that returns must carry why. The SENTENCE belongs only
   * to a failure nothing else is already describing more precisely, and there are two cases where
   * something is:
   *
   *  · the past-the-gate branch, where `screeningToast` answers `toastRuleFailed` — *"3 messages
   *    from … moved, but the rule couldn't be made. Future mail is unchanged."* That distinguishes
   *    a lost RULE from a lost decision, which this cannot, and the mail really did move;
   *  · a BULK, which raises one summary for the whole run ("4 decided — …"). A per-row refusal
   *    toast there replaces the summary of everything that DID work with a complaint about one row.
   *
   * `bump()` because the store is a ref: without it the mark appears on the next unrelated render,
   * which is the shape the whole defect wore.
   */
  const markRefused = (id: string) => {
    s.refused.add(id);
    bump();
  };

  /**
   * A refusal with nothing better to say about it: mark the row and name the sender.
   *
   * `quiet` is the bulk's own flag, threaded from `decide` through {@link ScreenerIntent} — the
   * same flag that suppresses the per-row optimistic toast — so the two toasts are suppressed by
   * one decision rather than by two guesses about who is calling.
   *
   * IT TAKES THE INTENT, NOT THE LIVE ENTRY, and that is what lets a decision RESTORED from the
   * journal report its own refusal in the same words: the only thing it ever wanted from the
   * `ScreenerSenderDTO` was a name to put in the sentence, and the intent carries that name.
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
   * EVERY ID THIS ROW COULD COME BACK UNDER — the rep, plus the sender's whole derived bag.
   *
   * `markRefused` marks ONE id, which is exactly right for a queue row: `commit`'s row keeps its
   * representative message, so the id the view asks about cannot change under the mark.
   *
   * A RELEASE CAN CHANGE THE REPRESENTATIVE, and that is why this exists. A derived Screened-out /
   * Spam row's id is the sender's NEWEST message in that folder (`selectors.ts#screenerSegments`).
   * Release five messages, have the newest land and an older one refused, and the row that comes
   * back is minted on a DIFFERENT message — so a mark on the pressed row's id would be a mark on
   * an id no row is asking about, which renders as nothing at all: the silent rollback again, in
   * the one case a partial failure produces. Marking the bag means whichever message is still there
   * carries the note.
   *
   * `heldMessageIds` and not `sender.held` directly, because a FIXTURE row's held ids are not
   * message ids — it answers `[]` there and the rep id alone is correct, which is the demo world.
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
   * A REVERSAL THE WIRE WOULD NOT TAKE — "Allow", "Not spam → Ohbox", "Not spam → Screener".
   *
   * Its own sentence rather than `toastDecideFailed`, because that one says *"… is back in the
   * queue"* and none of these rows go there: a refused release leaves the sender exactly where they
   * were, in the segment the reader pressed in. `segment` is the id and not a label so the mapping
   * to words lives here once — the toast has to name a real pile or it is telling the reader to go
   * and look somewhere the sender is not.
   *
   * No `quiet` flag: there is no bulk on these two segments. Every press is one sender, chosen from
   * a confirm strip, so every refusal has a sentence of its own to raise.
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
    heldIds: heldMessageIds(entry.sender),
    from: { name: entry.sender.from.name ?? null, address: entry.sender.from.address },
  });

  const commit = (id: string) => {
    const entry = s.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.commitTimer);
    clearTimeout(entry.outTimer);
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
   * SEND ONE DECISION — the only path to the wire, taken by the live timer AND by the boot replay.
   *
   * ── WHY IT TAKES A {@link ScreenerIntent} AND NOT A {@link PendingEntry} ─────────────────────
   *
   * Because the two callers do not have the same thing in their hands. The live commit holds a
   * `PendingEntry` with the full `ScreenerSenderDTO`; the boot replay holds a record read off disk
   * by a session that never saw that row. Written twice, this would be two implementations of one
   * rule — the shape this repository's own mutation tests keep catching — so it is written once, in
   * the vocabulary BOTH callers can speak, and the live path adapts to it (`intentOf`) rather than
   * the durable path guessing at a DTO it cannot reconstruct.
   *
   * `disarmScreenerIntent` is called on the SETTLE of each branch and never before the dispatch.
   * That order is the whole durability contract, one step further along than the journal itself:
   * `Engine.mutate` persists the verb to its own durable outbox AHEAD of the wire, so from the
   * moment it settles the outbox is the record and this journal has nothing left to hold — but
   * between the two, the journal is the ONLY copy, and dropping it early would reopen the defect
   * at a narrower window instead of closing it.
   */
  const dispatchDecision = (d: ScreenerIntent) => {
    const id = d.id;
    const derived = d.derived;
    const heldIds = d.heldIds;
    const done = () => disarmScreenerIntent(id);

    // ── WHERE IS THE REPRESENTATIVE, ACTUALLY? READ THE RAW MIRROR ────────────────────────────
    //
    // The queue is built from the PROJECTED reader, in which an active-undecided sender's INBOX
    // mail is PRESENTED in the Screener (`consentPartition`). A `screener_decide` on such a rep
    // is a NO-OP that claims success — the exact #116 shape: `derivedScreenerEffects` returns
    // nothing for a rep whose PHYSICAL folder is not `ohmail/Screener`, so `Engine.mutate` rolls
    // it back WITHOUT sending, and the wire would 404 it anyway (`heldRowById` requires
    // `desired_folder = 'ohmail/Screener'`). Every Aug-4 bulk-moved undecided+active sender is
    // this shape.
    //
    // So the branch reads the RAW mirror (`engine.read()`), NEVER `queueReader` / the projected
    // reader — that reader would report the INBOX rep AS gate-physical, which is the dangerous
    // branch. A fixture (non-derived) row is always taken through the decide path: it is served
    // in-process by `FixturesAdapter` and never opens a socket.
    const rawRep = engine.read().get<EngineMessage>("message", id);
    const gatePhysical =
      !derived || (rawRep != null && physicalFolderOf(rawRep) === FOLDER_OF_VIEW.screener);

    if (gatePhysical) {
      // ── GATE-PHYSICAL: the decide, EXACTLY as before ────────────────────────────────────────
      //
      // Spam must ride the NO branch on a derived row: `yes` is the verb that ADMITS a sender, and
      // the server now refuses `{decision:"yes", dest:"ohmail/Quarantine"}` outright (400) rather
      // than guessing which half the caller meant. The old "yes unless screened" mapping filed spam
      // into the Ohbox on a live account, which is the failure that predicate exists for.
      //
      // Fixture rows keep the demo's own semantics — spam rides `yes` there, so the local effect
      // materialises the held mail straight into Quarantine instead of moving the sender to the
      // screened-out ledger. That pairing (`decision:"yes"` with `dest:"spam"`) is the one shape the
      // server would refuse, and it cannot reach it: a fixture row exists only under
      // `FixturesAdapter`, which serves `mutationEffects` in-process and never opens a socket.
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
        if (res.status === "rolled_back") refuse(d);
      }, () => { done(); refuse(d); });
    } else {
      // ── PAST THE GATE: a rule, not a decide (#116) ──────────────────────────────────────────
      //
      // The sender's mail is physically in the INBOX (or spread), presented in the Screener
      // because they are active and undecided. The decide cannot touch it, so a screen-IN goes
      // through the SAME past-the-gate ladder the sender sheet uses: `rule_create` (destination
      // INBOX for an Ohbox decision) with `applyRetro`, plus capped `move`s for anything not
      // already in place. Once the rule lands in the mirror, `decidedDestination` → `placeOf =
      // INBOX`, and the whole sender's bag presents in the Ohbox with ZERO server-side moves.
      //
      // Fed from the RAW-reader `senderScreening`, and the mutations are AWAITED so the toast is
      // the one the server actually earned — never the unawaited "Ruled" over nothing this bug
      // was. The decide path's own optimistic toast was already raised at `decide()` time; this
      // confirms the real outcome when the undo window closes, and says so on a refusal.
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
        // ── THE REPRESENTATIVE IS GONE FROM THE MIRROR, and this branch was EMPTY ──────────────
        //
        // `senderScreening` answers null on exactly one condition: `reader.get("message", id)`
        // found nothing. The row id is the representative MESSAGE's id and this runs up to
        // `COMMIT_MS` after the press, so a drain or the windowed store's eviction pass in between
        // is enough — the message the decision names is no longer held here.
        //
        // With no `else`, that dispatched NOTHING: no mutation, no toast, no error, and the row
        // back in the queue on the next render. Of the three ways this commit can fail it was the
        // only one that was completely silent, which makes it the one most worth naming.
        //
        // THE INTENT IS DISARMED HERE, and it is the one refusal where that is a judgement rather
        // than bookkeeping. Nothing was sent, so the journal COULD keep the decision and offer it
        // to a later, warmer session. It does not, because this arm is only ever reached with the
        // rep genuinely gone: the boot replay never presents an intent whose rep the mirror cannot
        // see (see the restore effect), so reaching here from either caller means the mirror has
        // looked and the message is not there. Holding a decision about mail this device can no
        // longer name would be a retry loop with no terminating condition but the TTL.
        done();
        refuse(d);
      }
    }

    // "&read" is a flag, not a folder, so it cannot be clobbered by either branch — a Yes files
    // the sender's mail already-seen. `read` is still not a field on `POST /screener/:id`, so the
    // seen half is the same `PATCH /messages` batch the Ohbox uses. Derived rows only; a fixture
    // row's held ids are not message ids. It is clamped away for the demoting piles in `decide`.
    //
    // ── THE ONE `void engine.mutate` LEFT IN THIS FILE, AND IT IS DELIBERATE ──────────────────
    //
    // Everything else here now reads its result (see {@link ScreenerState.refused} and `moveAll`).
    // This does not, because the failure it can have is not the failure that family is about. The
    // DECISION has already landed by the time this runs; only the seen flag on mail that is now
    // filed can be lost. Calling `refuse`/`refuseRelease` for it would mark the row "Not saved" and
    // name the sender in a toast — a statement that the decision failed, which would be false, and
    // aimed at a row that is no longer in the queue to carry it. The real consequence is that some
    // of the filed mail stays bold in the Ohbox, which is visible where it happened and is undone
    // by reading it. Left unwatched on purpose rather than by omission, which is what the comment
    // is for.
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
     * THE DECISION IS ON DISK BEFORE ANYTHING ELSE HAPPENS TO IT.
     *
     * Ahead of `s.pending.set`, ahead of the toast, ahead of the render — and synchronously, which
     * is the whole reason this journal is `localStorage` and not the mirror store. Between this
     * line and `dispatchDecision` there is an 8.4-second window in which the ONLY record of an
     * explicit consent decision used to be the `commitTimer` above; a tab closed inside it lost the
     * decision while the toast had already reported it done. Now the window is a scheduled DURABLE
     * intent: the press lands here, Undo removes it, and a crash resolves one way — the next boot
     * reads it and commits (see the restore effect and {@link ScreenerIntent}).
     *
     * The timers are still armed and still own the HAPPY path. This is not a second mechanism
     * racing them; it is the record they act on, and the only thing that outlives them.
     */
    armScreenerIntent(intentOf(id, entry));
    s.pending.set(id, entry);
    s.out.add(id);
    bump();
    if (opts.quiet) return;
    const target = scopeText(sender, opts.scope);
    /**
     * THE UNSUBSCRIBE SENTENCE, ON THE TWO DEMOTING TOASTS ONLY.
     *
     * `screened` and `spam` are the whole of the endpoint's `no`, which is the whole of what arms
     * the pass: `screener-service.ts` calls `unsubscribe.onScreenOut` on `decision === "no"`, and
     * the service narrows again to the two reject folders itself. The three mail destinations are
     * a KEEP and must never carry this sentence — `ohmail/Reads` and `ohmail/Receipts` were
     * deliberately removed from the actionable set, so claiming it there would be false as well as
     * alarming.
     *
     * Passed as an ICU `select` argument rather than by choosing between two message keys, so the
     * German catalogue cannot end up with the two halves of one sentence in different orders.
     */
    const unsub = autoUnsubscribe ? "true" : "false";
    const message =
      dest === "screened"
        ? t("toastScreened", { target, read: read ? "true" : "false", unsub })
        : dest === "spam"
          ? t("toastSpam", { target: displayAddress(sender.from.address), unsub })
          : t("toastFiled", {
              dest: DECISION_DONE_LABEL[dest],
              read: read ? "true" : "false",
              target,
            });
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

  const visibleWaiting = waiting.filter((x) => !s.pending.has(x.id) || s.out.has(x.id));
  const undecided = waiting.filter((x) => !s.pending.has(x.id));
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
   * WHICH PILES the press would file into, deduped, in the surface's own reading order.
   *
   * Derived from `suggestedRows` and not from a second filter, because the label and the number
   * beside it have to describe one set. "Apply 5" over rows that turn out to be three Reads and
   * two Receipts is a control whose consequence a person cannot picture before pressing it —
   * they see a count, press, and find five senders filed into piles nobody named.
   *
   * The order is DECLARED here rather than taken from the queue, so the label is stable: read
   * off row order it would reshuffle every time a suggestion landed, and a control whose text
   * changes while you look at it reads as a different control.
   */
  const suggestedDests = APPLY_PILE_ORDER.filter(
    (d) => suggestedRows.some((x) => x.ai!.dest === d),
  );
  /**
   * The buy list, from the SAME set and in the SAME order.
   *
   * Deduped on the normalised address rather than trusted to be distinct: the queue is one
   * row per sender, but a spam row pulled back to Waiting by `notSpamToWaiting` joins this
   * list too, and a batch that named one address twice would reserve two of the user's
   * chosen 25 slots for one sender. The endpoint dedupes as well — this is so the COUNT the
   * confirmation shows is the count that gets bought.
   *
   * ── AND A SENDER THE GATE HOLDS NOTHING FOR IS NOT BUYABLE ────────────────────────────
   *
   * `gatePhysical: false` is a row whose representative is physically in the INBOX, minted
   * because the cutline PRESENTS that sender at the gate (#116). The row is decidable — its
   * commit routes past the gate as a rule — but `POST /screener/suggest` resolves senders
   * through `heldRows`, which requires `desired_folder = 'ohmail/Screener'`, so the server can
   * only answer `skipped: not_held` for them. `toSkips` then drops `not_held` on the floor,
   * by design: there is no chip to render for a sender who is not at the gate.
   *
   * The consequence was a loop with no exit. Every such sender was in every batch, refused
   * every time, never acquired an `ai`, and so was still unsuggested on the next pass — which
   * auto-suggest ran automatically, on a timer, spending the user's quoted slots on senders
   * the endpoint had already said it cannot speak for. Filtering them here is the whole fix:
   * they keep their row, they keep the manual decision that works, and they stop being offered
   * for sale.
   *
   * `!== false` and not `=== true`, because a FIXTURE row carries no flag at all and the demo's
   * rows must keep their existing behaviour. Only a row the projection explicitly marked as
   * past the gate is excluded.
   *
   * The server's `heldRows` is deliberately NOT widened to match. That is a wire contract —
   * what `POST /screener/:id` and `/suggest` will resolve — and widening it changes what the
   * gate means for every caller, not just this list.
   */
  const unsuggestedSenders = [
    ...new Set(
      undecided
        .filter((x) => x.derived === true && x.ai == null && x.gatePhysical !== false)
        .map((x) => senderKey(x.from.address)),
    ),
  ];
  /**
   * THE RE-ASK LIST — the same buyable set, on the other side of `ai == null`.
   *
   * Every filter above is repeated deliberately rather than computed as "waiting minus
   * unsuggested": `derived` and `gatePhysical` are facts about whether the SERVER can speak for
   * this sender at all, and they are as true of a sender who already has an answer as of one who
   * does not. A complement taken over the whole queue would put fixture rows and past-the-gate
   * rows into a batch the endpoint can only answer `not_held` for — the exact loop #116 removed
   * from the buy list, re-created on the re-ask path.
   *
   * `ai != null` and NOT `suggestedRows`' predicate: that set drops `screener`, because it is the
   * one answer a bulk APPLY refuses to act on. A sender the model declined to place, or one a run
   * could not answer for, is not un-re-askable — it is the case with the most to gain from being
   * asked again once their next mail arrives.
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
   * "APPLY ALL SUGGESTIONS" MAY ONLY APPLY SUGGESTIONS THAT EXIST.
   *
   * Reported from live use: the Screener offers "apply all suggestions" while none of the
   * mail on screen shows what the suggestion would be. That was right, and the button was
   * worse than dead. It read `x.ai?.dest ?? "ohbox"`, and on a live account `x.ai` is
   * ALWAYS null — so the fallback, not the suggestion, decided every row. One press meant
   * "accept every waiting stranger into the Ohbox and promote a rule for each of them",
   * under a label that said it was applying suggestions the user had never been shown.
   *
   * On a backlogged mailbox that is hundreds of senders and thousands of held messages,
   * dispatched 240 ms apart, with the single Undo toast arriving minutes after the first
   * one moved. A consent gate
   * whose bulk control silently grants consent is the product inverted.
   *
   * So the fallback is GONE — not replaced. `only` restricts the bulk to rows that carry a
   * suggestion, and `dest` is read from that suggestion with no default, so a row this
   * cannot speak for is never decided by it. With no suggestions anywhere the set is empty
   * and the whole thing is a no-op; the surface additionally declines to render the control
   * (`ScreenerView.tsx`), because an inert button is its own small lie.
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
      // `dest !== "screener"` is the second half of the same rule the paragraph above states, and
      // it is load-bearing rather than defensive: the server's `hold` arrives here as `screener`,
      // which means the classifier declined to place this sender and left the choice to the
      // person working the queue. Acting on it in bulk is a consent gate granting consent — the
      // very thing removing the fallback was meant to end. Without this the cast above would send
      // the string "screener" to `decide` as a `DecisionDestination`, which is not one of the five.
      //
      // ── AND IT IS THE ONLY EXCLUSION. SPAM USED TO BE THE SECOND, AND WAS WRONG ────────────
      //
      // This predicate carried `&& x.ai.dest !== "spam"` as well, on the argument that spam is a
      // judgement about a stranger rather than a filing of their mail, and that `markAllSpam`
      // already exists for anyone who wants to make it forty at a time. Reported from live use:
      // "when auto-applying the AI suggestions it stops at the spam and shows one only the
      // remaining spam messages". That is this line, and the report is the right reading of it —
      // a control labelled "Apply 12" that leaves five rows standing has failed halfway as far as
      // anyone using it can tell, whatever the reasoning behind the gap.
      //
      // The safety argument does not survive contact with what the press actually does. A spam
      // decision is `{decision:"no", dest:"spam"}` — a MOVE to `ohmail/Quarantine`, plus the same
      // rule and the same retro pass every other destination writes. Nothing is deleted; the Spam
      // segment lists the whole pile with "Not spam → Screener" and "Not spam → Ohbox" on every
      // row, and `undo` covers the window like any other decision. It is exactly as reversible as
      // the screen-out this control has always performed, and `markAllSpam` — which judges EVERY
      // waiting sender with no model behind it — is by any measure the blunter of the two.
      //
      // `markAllSpam` stays where it is. It answers a different question ("all of this is junk")
      // and needs no suggestions to do it.
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
   * Releasing a sender the Screener already decided about.
   *
   * There is no un-screen endpoint: `decide` resolves `:id` only against mail whose
   * DESIRED folder is still `ohmail/Screener`, so a screened-out or quarantined
   * representative is a 404. Per-message `move` releases the mail physically filed here.
   *
   * ── AND THE HOLDING RULE IS RETARGETED, WHICH THIS USED TO NOT DO ─────────────────────────
   *
   * This comment said "It creates no rule, and the copy says so instead of promising future
   * mail will follow" — and for a sender whose segment membership came from a RULE, that made
   * the release unperformable (see {@link releaseHeld}; live, 2026-08-19). It still creates no
   * rule. It RETARGETS the rules that hold the sender here — the reversal of the decision those
   * rows record — which is also the only rewrite that moves ingest along with the presentation:
   * a fresh allow rule beside a standing deny rule loses every tie (`compareRules`, deny before
   * allow before kind), so future mail would have kept arriving in Quarantine under a queue
   * showing the sender released.
   *
   * @param segment which pile the sender is being released FROM — the one the refusal names, and
   * the one they are still in if it is refused. Passed rather than derived because `release`
   * serves both `allowScreened` (Screened out) and `notSpamToOhbox` (Spam) and the two look
   * identical from in here.
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
        dest: DECISION_DONE_LABEL[dest],
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
        dest: DECISION_DONE_LABEL[dest],
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
       * THE PIN IS OPTIMISTIC STATE, AND IT IS THE ONE PIECE THE ENGINE CANNOT ROLL BACK.
       *
       * Every other reversal on this segment is undone for us: the engine drops its overlay, the
       * mail is reported where it still is, and the derived row reappears. The pin is ours — this
       * session's memory of a spam decision, which `pinnedKeys` uses to hold the derived row for the
       * same address OUT of the list.
       *
       * ── AND "THE DERIVED ROW COMES BACK ANYWAY" IS NOT AN ARGUMENT FOR DROPPING IT ────────────
       *
       * It does come back, and for one sender with one piece of quarantined mail it comes back under
       * the very same id, which is why a first pass at the guard for this could not tell the restore
       * from its absence. The case that separates them is a sender with OTHER, NEWER mail already in
       * Quarantine from an earlier decision: the derived row is minted on the sender's newest
       * quarantined message (`selectors.ts#screenerSegments`), so the row that surfaces is one this
       * press never named, `refusalKeys` does not cover it, and the refusal renders as nothing at
       * all. Restoring the pin keeps the row that was pressed — with the id the mark is on, and with
       * its "You marked this" caption, which is still true of a release that was declined.
       *
       * Restored at its own index rather than prepended, because a pin's position is the order the
       * reader marked senders in and a refused release is not a new decision. Guarded on absence so
       * a sender re-pinned in the meantime is not listed twice.
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
   * DECISIONS THIS SESSION INHERITED — the restart half of the durable-intent contract.
   *
   * Loaded ONCE, then drained as the mirror becomes able to carry each one. Both halves of that
   * sentence are load-bearing:
   *
   * ── ONCE ────────────────────────────────────────────────────────────────────────────────────
   *
   * `restoredIntents.current === null` is the latch. Without it a remount (React strict mode's
   * double-invoke, a route that rebuilds the shell) would re-read the journal while THIS session's
   * timers are still armed over the same rows and dispatch each decision twice. The same guard
   * `OhmailEngine.restoreOutbox` states in its own words — *"an entry this session is already
   * handling is not a restart's entry"* — is applied to the load as well: an id already in
   * `s.pending` belongs to a live timer and is not this effect's business.
   *
   * ── AS THE MIRROR BECOMES ABLE ──────────────────────────────────────────────────────────────
   *
   * This is the failure the fix would otherwise have OPENED, and it is worth naming because it is
   * the one that makes a durable replay worse than no replay. A derived row's id is a representative
   * MESSAGE id. At boot the mirror is cold: `engine.read().get("message", id)` answers nothing until
   * the first drain lands. `dispatchDecision` on an absent rep takes the past-the-gate branch,
   * `senderScreening` answers null, and the decision is REFUSED — locally, with nothing sent, and
   * marked "Not saved" on a row nobody is looking at. Replaying at mount would therefore have
   * converted "the decision survives a crash" into "the decision is destroyed on the next boot, in
   * a way that looks like the server refused it". Red against the wrong dataset, exactly as the
   * cold-account trap says.
   *
   * So the effect re-runs on `version` — the mirror's own revision, already this hook's render key
   * — and dispatches only the intents the mirror can now name. A non-derived (fixture) intent has
   * no such dependency and goes on the first pass. Anything still undispatched stays IN the journal
   * and is offered again next boot, or swept by {@link INTENT_TTL_MS}; nothing is consumed by an
   * attempt that could not be made.
   *
   * There is no timer and no deadline here on purpose. A deadline would have to choose between
   * dispatching into a cold mirror (the defect above) and discarding the decision (the defect this
   * whole slice closes), and the journal already has a bound that needs neither.
   */
  const restoredIntents = useRef<ScreenerIntent[] | null>(null);
  useEffect(() => {
    if (restoredIntents.current === null) {
      restoredIntents.current = takeScreenerIntents(Date.now())
        .filter((r) => !s.pending.has(r.id));
    }
    const queue = restoredIntents.current;
    if (queue.length === 0) return;
    const raw = engine.read();
    const ready = queue.filter((r) => !r.derived || raw.get<EngineMessage>("message", r.id) != null);
    if (ready.length === 0) return;
    restoredIntents.current = queue.filter((r) => !ready.includes(r));
    for (const r of ready) dispatchDecision(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

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
    decide,
    applyAll,
    markAllSpam,
    allowScreened,
    notSpamToWaiting,
    notSpamToOhbox,
    deleteSpam,
    flush,
  };
}
