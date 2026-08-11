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
import { useMemo, useReducer, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  FOLDER_OF_VIEW,
  isProtectedMessage,
  physicalFolderOf,
  screenerSegments,
  senderKey,
  type EngineMessage,
  type EntityReader,
  type Folder,
  type OhmailEngine,
  type ScreenDest,
  type ScreenerSenderDTO,
} from "@ohmail/client-engine";
import type { SuggestionOverlay } from "./screener-suggest";
import {
  dispatchScreeningChange,
  planScreeningChange,
  senderScreening,
} from "./sender-screening";
import { PLACE_LABEL } from "./format";
import { displayAddress, displayAddressee, displayDomain, displayDomainLabel } from "./idn";
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
 * Exported so the suite reads the REAL number. `screener-cloud.test.ts` carried
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
  /* THE DERIVED ROWS CARRY WORDS: a derived sender's stamp ("Mo", "2. Aug") and a screened-out
     sender's date are minted by the selector, not by a view, so it has to be told which language to
     name them in. The memo re-keys on the locale, so a switch re-derives the segments in the same
     render rather than leaving yesterday's stamps in English until the next mutation. */
  const locale = useAppLocale()?.locale ?? "en";
  const segments = useMemo(
    () => screenerSegments(queueReader, undefined, locale),
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

  const moveAll = (ids: string[], folder: Folder) => {
    for (const messageId of ids) void engine.mutate({ kind: "move", messageId, folder });
  };

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
    const derived = entry.sender.derived === true;
    const heldIds = heldMessageIds(entry.sender);

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
        entry.dest === "screened" || (derived && entry.dest === "spam") ? "no" : "yes";
      // The destination rides the decide on BOTH branches (SCR-READ), so the server files where the
      // user pressed on all five; nothing is composed on top but "&read", which is a flag below.
      void engine.mutate({
        kind: "screener_decide",
        senderId: id,
        decision,
        dest: entry.dest as ScreenDest,
        ...(decision === "yes" ? { read: entry.read } : {}),
        scope: entry.scope,
      });
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
        const dest = entry.dest;
        const plan = planScreeningChange(sender, dest, entry.scope, true);
        // The toast's subject, not the rule's — the rule was already written from `plan`.
        const who = entry.scope === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address);
        const place = PLACE_LABEL[dest] ?? dest;
        void dispatchScreeningChange(plan, (m) => engine.mutate(m)).then((key) => {
          toast(ts(key, { sender: who, place, count: plan.moved }));
        });
      }
    }

    // "&read" is a flag, not a folder, so it cannot be clobbered by either branch — a Yes files
    // the sender's mail already-seen. `read` is still not a field on `POST /screener/:id`, so the
    // seen half is the same `PATCH /messages` batch the Ohbox uses. Derived rows only; a fixture
    // row's held ids are not message ids. It is clamped away for the demoting piles in `decide`.
    if (derived && entry.read) {
      for (let i = 0; i < heldIds.length; i += MARK_SEEN_MAX) {
        void engine.mutate({
          kind: "mark_seen",
          messageIds: heldIds.slice(i, i + MARK_SEEN_MAX),
          unread: false,
        });
      }
    }
    bump();
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
    // ── THE ONE PLACE "MARK READ" IS CLAMPED FOR THE DEMOTING PILES ─────────────────────────
    //
    // You do not read what you triage out: filing to Screen out or Spam carries no read verb.
    // The ✓ is gone from those capsules and their ⇧-twin keys are unbound — but this is the
    // funnel every decision path converges on (the ✓, o/r/c/n/x, ⇧Enter accepting an AI
    // suggestion of a demoting destination), so clamping HERE is what makes the guarantee
    // structural rather than three UI branches that each have to remember. `commit` reads
    // `entry.read` for both the wire `read` flag and the derived-row `mark_seen` batch, so a
    // false here stops both. SCR-READBOX.
    const read = opts.read && !DECISION_QUIET.has(dest);
    const entry: PendingEntry = {
      sender,
      dest,
      read,
      scope: opts.scope,
      outTimer: setTimeout(() => {
        s.out.delete(id);
        bump();
      }, OUT_MS),
      commitTimer: setTimeout(() => commit(id), COMMIT_MS),
    };
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
        // The sentence is owed only if this batch actually DEMOTED somebody. A run of Reads and
        // Receipts arms nothing, and appending it there would be false — the two mail piles are a
        // KEEP and were deliberately removed from the unsubscribe service's actionable set. `spam`
        // cannot appear here at all (the predicate below excludes it), so `screened` is the whole
        // of the condition.
        const unsub = autoUnsubscribe && n("screened") > 0 ? "true" : "false";
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
   * representative is a 404. Per-message `move` releases the held mail for real. It
   * creates no rule, and the copy says so instead of promising future mail will follow.
   */
  const release = (sender: ScreenerSenderDTO, dest: "ohbox" | "reads") => {
    moveAll(heldMessageIds(sender), FOLDER_OF_VIEW[dest]);
    toast(
      t("toastReleased", {
        count: sender.held.length,
        sender: displayAddress(sender.from.address),
        dest: DECISION_DONE_LABEL[dest],
      }),
    );
  };

  const allowScreened = (sender: ScreenerSenderDTO, dest: "ohbox" | "reads") => {
    if (sender.derived) {
      release(sender, dest);
      return;
    }
    void engine.mutate({
      kind: "screener_decide",
      senderId: sender.id,
      decision: "yes",
      dest,
      scope: "sender",
    });
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
    if (row.sender.derived) {
      // Back to Waiting means the mail goes back to `ohmail/Screener` — the derived
      // queue reads the folder, so a local override would show a row whose mail is
      // still quarantined and whose decision would 404.
      moveAll(heldMessageIds(row.sender), FOLDER_OF_VIEW.screener);
      toast(t("toastNotSpamWaiting", { sender: senderLabel(row.sender) }));
      return;
    }
    s.overrides.add(row.sender.id);
    bump();
    toast(t("toastNotSpamWaiting", { sender: senderLabel(row.sender) }));
  };

  const notSpamToOhbox = (row: SpamRow) => {
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
      for (const m of quarantined) {
        void engine.mutate({ kind: "move", messageId: m.id, folder: "INBOX" });
      }
      s.pins = s.pins.filter((p) => p.id !== row.sender.id);
      bump();
    } else if (row.sender.derived) {
      release(row.sender, "ohbox");
      return;
    } else {
      void engine.mutate({
        kind: "screener_decide",
        senderId: row.sender.id,
        decision: "yes",
        dest: "ohbox",
        scope: "sender",
      });
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
