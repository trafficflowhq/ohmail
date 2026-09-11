"use client";

/**
 * Buying AI suggestions for the Screener — the control that names the cost BEFORE it spends. Separate from
 * `screener-state.ts` because the mirror never carries a suggestion (`/sync` is a feed of changes to mail;
 * advice about mail is not one), so a live account rendered "No suggestion" on every row until something
 * asked. This holds the suggestions known so far (joined onto rows by sender address) and one purchase's
 * state machine. The spend rule: credits never move without an action that named the cost first — the dry
 * run prices the exact set on the SERVER (a price computed here would be a second eligibility rule that
 * drifts), and the batch is an explicit list taken from the FRONT of the queue in its own order, so the
 * same press twice covers the same senders.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { senderKey } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import {
  ApiError, apiConfigured, screener as screenerApi,
  type ScreenerSkipReason, type ScreenerSuggestWire, type ScreenerWirePage,
} from "../api-client";
/* The decided-and-waiting shape, owned by the module that renders it. Type-only, so this does not
   close a runtime cycle with `screener-state.ts`, which reads this file's overlay type. */
import type { PendingDecision } from "./screener-state";

/**
 * One sender's suggestion, in the vocabulary the rows already speak. All five piles appear
 * because all five are things `POST /screener/:id` can perform (it takes `dest`); the old
 * two-outcome collapse reported a model that said Receipts, Reads or Spam as "Screened out".
 * `screener` is the sixth value and NOT a filing: it is "leave this one where it is" — the
 * server's `hold`. The old denylist collapse dropped `ohmail/Screener` through to `ohbox` — the
 * classifier's own label for a first-contact stranger, i.e. every row here — so "Ohbox" showed
 * over a rationale asking for a human. A `screener` row is decidable by a PERSON, never a bulk:
 * applying it would move nothing and grant nothing.
 */
export interface SenderSuggestion {
  dest: "ohbox" | "reads" | "receipts" | "screened" | "spam" | "screener";
  confidence: number;
  rationale: string;
  /**
   * Why there is no answer, when there is none. A purchase does not always
   * come back with a verdict for every sender, and those rows used to
   * render blank — paid for, looking skipped, nothing saying why. It was
   * called `withheld`; the rename is the AI-OPEN ruling in the type system:
   * every remaining reason (balance ran out, AI off for the account, model
   * fault) is a fact about the RUN, fixed by pressing again later — never a
   * fact about the mail. Present ⇒ `dest` is `screener` and there is only
   * something to say; absent ⇒ an ordinary suggestion.
   */
  noAnswer?: SuggestSkipShown;
}

/**
 * The skip reasons a ROW can show — every one except `not_held`.
 *
 * Narrowed rather than reusing the wire enum whole, because `not_held` means the sender has left
 * the gate, so there is no row on screen to put it on. Naming that in the type is what stops a
 * later change quietly rendering a chip for a sender who is not there.
 */
export type SuggestSkipShown = Exclude<ScreenerSkipReason, "not_held">;

/** Suggestions known so far, keyed by {@link senderKey}. */
export type SuggestionOverlay = ReadonlyMap<string, SenderSuggestion>;

export type SuggestPhase = "closed" | "pricing" | "ready" | "running";

/**
 * Which set an open ladder is bound to — the one thing that differs between
 * the two ways in. `new` covers senders with no answer yet; `again` covers
 * senders that already have one. They share every other moving part on
 * purpose — one phase, one quote, one press counter, one chunked purchase:
 * a second state machine for the re-ask would be a second implementation of
 * the spend rule. The two sets are disjoint by construction (`ai == null`
 * vs `ai != null` over one queue), so the mode is the whole difference.
 */
export type SuggestMode = "new" | "again";

/** The control, already bound to the senders it would act on. */
export interface SuggestBatchControl {
  /** Waiting senders with no suggestion yet — how much there is to buy. */
  available: number;
  /**
   * Waiting senders that ALREADY have an answer — how much there is to ask about AGAIN.
   *
   * Not a second kind of purchase, and not priced differently: a re-ask is quoted by the same dry
   * run over the same endpoint, and the server prices it from what it is holding. A sender whose
   * representative message is unchanged is already bought, so it quotes 0 and answers from the
   * store; a sender whose newest mail arrived since is unbought, so it quotes and charges like any
   * other. Nothing here decides which — the ledger does, and this number is only how many senders
   * are eligible to be asked about.
   */
  resuggestable: number;
  /** Which of the two sets the currently open ladder covers. `new` while nothing is open. */
  mode: SuggestMode;
  /**
   * How many senders the OPEN LADDER draws from — {@link available} in `new`,
   * {@link resuggestable} in `again`.
   *
   * The view's "all N" label reads this and not `available`: labelled off the buy list, a re-ask
   * ladder over 74 senders would print "all 0" on its largest size, or print nothing at all and
   * make the top of the ladder unidentifiable.
   */
  pool: number;
  /**
   * Batch sizes offered, clamped to {@link available} and to {@link MAX_SUGGEST_BATCH} — the most
   * one authorised purchase may buy. This is NOT one request's size: a chosen size larger than a
   * single request is priced and bought as several request-sized chunks, so the ladder can offer
   * more than one request's worth.
   */
  sizes: number[];
  /** The size currently chosen. */
  size: number;
  phase: SuggestPhase;
  /** The SERVER's quote for the current size. Null until the dry run answers. */
  quote: { senders: number; credits: number } | null;
  /** One sentence about the current state, already translated, or null when there is none. */
  notice: string | null;
  /**
   * How far a running purchase has got, as two numbers rather than a sentence. `notice` already
   * carries "3 of 40 suggested…", and a translated sentence is the wrong shape for a progress
   * bar — a surface that wanted a track had to parse English out of it. The numbers are
   * published beside the sentence, from the same two sources, at the same two points, so they
   * cannot disagree about a frame. `null` in every phase but `running`, and cleared — not left
   * at `{done: total}` — when the run finishes. `total` is the set the user consented to, not
   * chunks and not what the server quoted: a halted purchase must still show what it was aiming
   * at, or "8 of 8" reports a stopped run as complete.
   */
  progress: { done: number; total: number } | null;
  /** Open the ladder over the senders with no answer yet. */
  open: () => void;
  /**
   * Open the SAME ladder over the senders that already have one.
   *
   * A separate entry point rather than a mode argument on {@link open}, because the two are
   * different affordances on screen with different labels and different counts, and the caller
   * that presses one must not be able to spell the other by accident. Everything after the press
   * is the one flow: quote, confirm, progress, summary.
   */
  openAgain: () => void;
  choose: (size: number) => void;
  confirm: () => void;
  cancel: () => void;
}

/**
 * The opt-in's quote — what turning the automatic batch ON would cost,
 * before it is on. The automatic path has no dry run of its own, and the
 * licence for that is THIS: the cost was named when the setting was turned
 * on — a sentence that was a promise about a control that did not exist
 * until this one. It prices and stops; no `confirm` here on purpose: the
 * thing consented to is a SETTING, written through `useConsentState` so the
 * flag the spender reads and the flag the switch shows are one value — a
 * second writer is the beginning of the stale-OFF bug.
 */
export interface AutoOptInControl {
  /**
   * Is there a server to ask? {@link SuggestWire.configured}, and nothing else — false on any host
   * with no API base, which is every browser tab this app is served from without one.
   *
   * The row must not render at all where this is false. The flag cannot become true there —
   * `useConsentState` skips its fetch, and the automatic effect asks the same transport — so a
   * switch would be a control with nothing behind it, which is the defect this exists to avoid
   * rather than one it may create.
   */
  supported: boolean;
  /** The ceiling on one automatic batch — {@link AUTO_BATCH_SIZE}, never a literal in a view. */
  batchSize: number;
  /** Unsuggested senders waiting right now. The batch is the first {@link batchSize} of them. */
  available: number;
  /** `running` never occurs: this control buys nothing. */
  phase: SuggestPhase;
  /** The SERVER's quote for the next batch. Null until the dry run answers — and no price, no consent. */
  quote: { senders: number; credits: number } | null;
  /** One translated sentence about the current state, or null. */
  notice: string | null;
  /** Price the next batch. Opens the confirm. */
  open: () => void;
  /** Abandon the confirm and discard any dry run still in flight. */
  cancel: () => void;
}

export interface ScreenerSuggestions {
  suggestions: SuggestionOverlay;
  /**
   * Decisions this install made that its organizer has not carried out yet
   * — the durable half. It rides this hook because this hook already makes
   * the one `GET /screener` a session makes; a second fetch of the same
   * page to read one more field would be a round trip bought to avoid a
   * seam. Not a suggestion: nothing here is bought, priced or spent, and
   * `useScreenerState` is the only consumer. Empty until the read lands,
   * and empty for ever where it fails or the server lacks the field — the
   * live half (a press in THIS session) is recorded by `useScreenerState`.
   */
  outstandingDecisions: readonly PendingDecision[];
  /**
   * Put answers into the overlay from somewhere that is not this hook.
   * There is exactly one overlay on screen — `useScreenerState` joins it
   * onto the rows, and the chips, the suggested count, "Apply all" and
   * Enter-accept all read it — so a host that buys suggestions its own way
   * must land them HERE or they are answers nothing can display (the
   * desktop's control is `apps/desktop/src/local-suggest.tsx`).
   * Deliberately the only seam of its kind: it adds no way to spend and no
   * way to decide — it shows rows already answered for.
   */
  absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
  /**
   * Bind the control to a sender list — the waiting rows with no
   * suggestion, in queue order. A function rather than a hook argument
   * because the list is computed by `useScreenerState`, which consumes
   * {@link suggestions}: passing it in would be a cycle. `resuggestable` is
   * the other half of the same queue — senders that already have an answer
   * — and a second parameter rather than a second call because the two
   * ladders share one phase, quote and press counter: two calls would mint
   * two controls over one state, each reporting the other's `pricing`. Omitted ⇒ no re-ask is offered.
   */
  forSenders: (addresses: string[], resuggestable?: string[]) => SuggestBatchControl;
  /**
   * Bind the OPT-IN's quote to the same sender list.
   *
   * Takes the list explicitly rather than reading {@link forSenders}' captured queue, and that
   * is load-bearing: `forSenders` is called only inside the Screener branch of the shell's
   * render (`AppShell.tsx`), so on a tab that went straight to Settings the captured queue is
   * still empty. A quote read from it would say "0 senders · 0 credits" about a batch that is
   * about to buy ten — a lie in the direction of spending.
   */
  autoOptIn: (addresses: string[]) => AutoOptInControl;
}

/**
 * The two calls this hook makes, gathered into something a host can hand in. This module reaches a server
 * twice — it prices a set and it buys one — and the desktop renders this same client against an engine on
 * the same machine, addressed over a pipe: an install pointed at a hosted account has the allowance and
 * balance that make the control meaningful, not the browser's way of asking. The alternative — a second
 * control with its own quote, chunking and keys — is a second implementation of how money moves. What varies
 * is the four lines that carry bytes; when to price, what to consent to, chunk size, one key per chunk, halt
 * on first refusal are shared and cannot be forked. Methods are shaped like the hosted client's own, because
 * that IS the default ({@link CLOUD_WIRE}).
 */
export interface SuggestWire {
  /**
   * Is there a server to ask at all?
   *
   * Read rather than assumed: it decides whether the stored-answer read runs, whether the automatic
   * batch may fire, and whether the opt-in switch is offered. A host that answers false gets a
   * surface with no spend control on it, which is the correct posture where nothing could serve one.
   */
  configured: () => boolean;
  /** What has ALREADY been bought, one page of it. Spends nothing. */
  list: (opts: { limit?: number }) => Promise<ScreenerWirePage>;
  /**
   * Price a sender set (`dryRun`) or buy it.
   *
   * `idempotencyKey` belongs to ONE request and is the caller's, never this transport's: the thing
   * being made idempotent is one chunk of one purchase, so a transport that minted its own key
   * would make a retry of a lost answer into a second charge.
   */
  suggest: (
    senders: string[],
    opts?: { dryRun?: boolean; idempotencyKey?: string },
  ) => Promise<ScreenerSuggestWire>;
  /**
   * The sentence to show for a refusal this transport produced.
   *
   * On the wire it is the SERVICE's own words — no classifier connected, managed AI switched off,
   * no actions remaining — and each is a different, actionable fact that no status code carries. It
   * belongs to the transport because only the transport knows the shape its own failures arrive in;
   * re-deriving a taxonomy here is how somebody with an empty balance is told the model is down.
   */
  messageFor: (err: unknown, fallback: string) => string;
}

/**
 * The hosted transport — the browser talking to the API this app was written against.
 *
 * The default, so every existing caller is unchanged and no host has to name a transport to get the
 * behaviour it already had.
 */
const CLOUD_WIRE: SuggestWire = {
  configured: () => apiConfigured(),
  list: (opts) => screenerApi.list(opts),
  suggest: (senders, opts) => screenerApi.suggest(senders, opts ?? {}),
  messageFor: apiMessageFor,
};

/**
 * The per-request cap — the 413 boundary — to assume before the server has
 * published its own. `GET /screener` answers `suggestable.maxPerRequest`
 * and that number wins the moment it arrives; this is the ceiling assumed
 * if the read has not landed. Deliberately AT OR BELOW the server's real
 * cap (`MAX_SUGGEST_SENDERS`, 50): guessing high costs a 413 on a chunk
 * that had already quoted a price. It is not the size a request actually
 * carries — that is the smaller {@link SUGGEST_CHUNK_SIZE}; a request is
 * bounded by the lower of the two.
 */
const ASSUMED_MAX_PER_REQUEST = 25;

/**
 * How many senders one request actually carries — the latency budget, distinct from the 413 cap. The request must finish inside
 * one serverless invocation (60 s) at ~2 s of model time per sender. The server now buys in bounded lanes (`SUGGEST_LANES`; the
 * credit gate still serialises on the balance row), measured at 15 senders 30.3 s → 6.1 s and 50 senders 100.8 s → 20.2 s — so
 * forty is ~16 s. This constant is the FALLBACK, fifteen: safe against a server that still buys serially (a rollout or rollback
 * can pair this client with the previous server, where forty is ~80 s — killed by the deadline with a partly debited purchase;
 * both servers publish `maxPerRequest: 50`, so the cap cannot tell them apart). The forty comes off the wire as
 * `suggestable.recommendedPerRequest`: the server that can take it is the one that says so. The ladder is split into requests
 * of the lowest of the three numbers, each of which completes.
 */
export const SUGGEST_CHUNK_SIZE = 15;

/**
 * The sizes offered, before clamping. The small end is watchable, the large end drains a
 * backlog: 10/25/50 to try a handful and see, 100/200/400 to clear a real first-contact pile
 * in one authorised purchase. Every one of these is still priced by a server dry run before it
 * can be pressed, and clamped by {@link batchSizes} to {@link MAX_SUGGEST_BATCH} and the queue —
 * a size above the account's queue is never shown. A size above one request is NOT dropped: it is
 * bought as several request-sized chunks (see {@link SuggestBatchControl.confirm}).
 */
const OFFERED_SIZES = [10, 25, 50, 100, 200, 400];

/**
 * The most one authorised purchase may buy — the ladder's ceiling, above the per-request cap. A
 * purchase and a request are different sizes: one request is bounded by {@link
 * SUGGEST_CHUNK_SIZE} and the server's cap; a purchase is delivered as a sequence of them.
 * Clamping the ladder to one request's worth is what an earlier control did — and stretching
 * the request to fit a bigger ladder pushed it past the invocation's deadline. A chosen size
 * larger than one request is split into chunks that each fit; the full set is still priced
 * first (the sum of the chunk quotes), so consent is to the whole and spend never exceeds that
 * sum. The top of {@link OFFERED_SIZES}.
 */
export const MAX_SUGGEST_BATCH = 400;

/** How much of the queue one hydration reads. A `cost: read` page; it spends nothing. */
const HYDRATE_LIMIT = 200;

/**
 * How many senders one automatic batch buys — the opt-in's entire spend per Screener open. Ten,
 * not the endpoint's fifty and not the manual ladder's top: the automatic path spends without a
 * press, so its bound has to be a number somebody can live with being wrong about — a rounding
 * error against the smallest tier's monthly allowance. A backlog drains ten at a time across
 * visits rather than in one four-figure purchase nobody authorised (the reason the endpoint
 * demands an explicit list). Also why the flag needs no per-period ceiling on the account: only
 * a person opening the Screener can spend automatically, at most this much per open.
 */
export const AUTO_BATCH_SIZE = 10;

/* The spend announcement. A purchase changes a number OTHER surfaces show —
 * the remaining AI allowance, rendered one line under the control that
 * spent it. That line reads `GET /billing/subscription`, is injected,
 * fetches once on mount, and nothing remounts it when a sibling spends — so
 * it claimed the session-start balance, including credits at zero, until a
 * reload. The narrowest fix is a notification, not a shared store: this
 * file knows the moment the server reported a new balance, and listeners
 * only need "re-read" — no state crosses the seam, the shell holds no billing knowledge. Module scope rather than context (no component
 * contains both ends); `subscribe` returns its own unsubscribe. Not a poll:
 * it fires only after a request that actually moved money. */
const creditListeners = new Set<() => void>();

/**
 * Be told when a purchase in this client has just changed the account's AI balance.
 *
 * @returns the unsubscribe, so `useEffect(() => onCreditsSpent(fn), [fn])` is the whole wiring.
 */
export function onCreditsSpent(listener: () => void): () => void {
  creditListeners.add(listener);
  return () => { creditListeners.delete(listener); };
}

/**
 * Fire the listeners. Copied before iterating (a listener may unsubscribe from inside itself) and
 * each call is isolated — a surface that throws while refreshing must not fail the purchase that
 * has already succeeded.
 */
function announceSpend(): void {
  for (const listener of [...creditListeners]) {
    try { listener(); } catch { /* a display's failure is not a purchase's failure */ }
  }
}

export function useScreenerSuggestions(opts: {
  /** Is the Screener on screen? Hydration is deferred until it is. */
  active: boolean;
  /**
   * HAS THIS ACCOUNT OPTED IN to buying suggestions without a press (mail 0040)?
   *
   * Optional, and absent means NO. Every host that has no server — the demo, the desktop shell —
   * omits it, and so does a shell whose `GET /consent` failed. The default has to be the one that
   * spends nothing, because the alternative is a fetch error that costs money.
   */
  autoSuggest?: boolean;
  toast: ToastFn;
  /**
   * HOW THIS HOOK REACHES A SERVER. Absent ⇒ the browser's hosted client — see {@link SuggestWire}.
   *
   * The only thing a host may substitute. It carries bytes and nothing else: the price, the
   * consent, the chunk size and the per-chunk key are decided above it and are the same on every
   * surface that supplies one.
   */
  wire?: SuggestWire;
  /**
   * WHERE ANSWERS LAND WHEN THE OVERLAY ON SCREEN IS SOMEBODY ELSE'S.
   *
   * There is exactly one suggestion overlay in a rendered client, and the rows, the suggested
   * count, "Apply all" and Enter-accept all read it. A host that mounts this hook BESIDE that
   * overlay rather than owning it — a control handed into the shell, holding its own copy of this
   * machinery — must push what it buys into the real one or it has paid for chips nothing can
   * draw. Called with the same rows {@link ScreenerSuggestions.absorb} takes, so the two ends of
   * that seam speak one vocabulary.
   */
  publish?: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
}): ScreenerSuggestions {
  const t = useTranslations("screener");
  const { active, toast } = opts;
  const autoSuggest = opts.autoSuggest === true;
  const wire = opts.wire ?? CLOUD_WIRE;

  const [suggestions, setSuggestions] = useState<SuggestionOverlay>(() => new Map());
  const [phase, setPhase] = useState<SuggestPhase>("closed");
  /**
   * Which set the open ladder covers. Set by whichever entry point opened it, and reset to `new`
   * on cancel so a closed control never reports a mode nothing is bound to.
   *
   * It selects the sender list for `price` and `confirm`, and it selects the wording. It does NOT
   * select a price, an endpoint or an idempotency scheme — there is one of each, and the whole
   * point of routing the re-ask through here is that it cannot acquire a second.
   */
  const [mode, setMode] = useState<SuggestMode>("new");
  const [size, setSize] = useState(0);
  const [quote, setQuote] = useState<{ senders: number; credits: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** See {@link SuggestBatchControl.progress}. Written beside `notice`, never derived from it. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [maxPerRequest, setMaxPerRequest] = useState(ASSUMED_MAX_PER_REQUEST);
  /** See {@link ScreenerSuggestions.outstandingDecisions} — read off the one page fetch below. */
  const [outstanding, setOutstanding] = useState<readonly PendingDecision[]>([]);
  /**
   * The server's own recommended request size, or `null` until one has said — see
   * {@link SUGGEST_CHUNK_SIZE}. `null` and not a default, so "this server has not told me" is
   * distinguishable from "this server recommends the fallback"; an older server never says.
   */
  const [recommendedPerRequest, setRecommendedPerRequest] = useState<number | null>(null);
  /**
   * The opt-in confirm's state, held apart from the manual control's three fields above.
   *
   * One object rather than three `useState`s so the phase and the price it belongs to can never
   * be painted from different renders — `ready` with a stale `quote` is the frame that shows a
   * pressable button under the wrong number.
   */
  const [optIn, setOptIn] = useState<{
    phase: SuggestPhase;
    quote: { senders: number; credits: number } | null;
    notice: string | null;
  }>({ phase: "closed", quote: null, notice: null });

  /**
   * Everything a stale answer must not be allowed to overwrite.
   *
   * `run` counts presses: a dry run for 10 senders that resolves AFTER the user has switched
   * to 50 must not paint the price of 10 under the label "50". Compared on arrival, discarded
   * when it does not match.
   */
  const io = useRef({
    run: 0,
    hydrated: false,
    /**
     * The auto latch — the whole safety of the automatic path. `autoFired` goes true before the request
     * leaves, so a re-render, a StrictMode second pass, or a warming mirror cannot buy a second batch; it
     * resets when the Screener goes away, making the unit "one batch per open". `autoDisarmed` is the
     * refusal latch the reset gives a job: on a 402/ 409/503 the automatic path stops for the session —
     * without it an empty balance issues one doomed request per visit. The two were briefly redundant
     * (`autoFired` never reset, so removing the second latch left the suite GREEN — recorded because an
     * unwatchable guard is not evidence; the fix gave each a distinct reachable state). `queue` is the
     * last bound sender list, recorded during render for the effect.
     */
    autoFired: false,
    autoDisarmed: false,
    queue: [] as string[],
    /**
     * The opt-in quote's OWN press counter, deliberately not `run`.
     *
     * The two flows are reachable from different views and must not cancel each other: sharing
     * `run` would mean opening the Settings confirm silently discards a purchase the Screener
     * has in flight, and a purchase discarded after the request left is money spent with the
     * answer thrown away.
     */
    optInRun: 0,
    /**
     * The automatic batch's own counter — deliberately not `run`; sharing `run` was the
     * self-cancellation bug. The batch fires asynchronously, gated on `hydrateSettled`, and an
     * owner who opens the Screener and presses Suggest is inside that window: the batch's
     * `++run` invalidated the in-flight manual purchase, whose `await` saw the moved counter
     * and discarded itself WITHOUT clearing `running` — the button spun forever, and worked on
     * the next visit ("fails once, works on retry"). The two are independent purchases with
     * independent keys; neither result may discard the other.
     */
    autoRun: 0,
  });

  /**
   * Bumped once, the first time the control is bound to a non-empty queue.
   * The automatic batch cannot fire from the first render: the queue comes
   * from the mirror, and on a cold tab `forSenders` is called with an empty
   * list several times. An effect keyed only on `active` would look once,
   * find nothing and never look again — shipping a feature that does
   * nothing on every real account and works in every pre-warmed test. One
   * state write per session, guarded by `autoSeen`, purely to give the
   * effect a dependency that changes when there is something to buy.
   */
  const [queueReady, setQueueReady] = useState(0);
  const autoSeen = useRef(false);

  /** True once the stored-suggestion hydration has SETTLED, either way. See its `finally`. */
  const [hydrateSettled, setHydrateSettled] = useState(false);

  /**
   * `toast` and `t` held in a ref, so the automatic effect does not depend
   * on their identity. Not a micro-optimisation: `useTranslations` returns
   * a fresh function every render and a parent may pass a fresh `toast`
   * arrow, so listing either re-runs the effect every render — the batch
   * stays safe (the latch), but the cold-mirror behaviour then works by
   * accident off the parent's render churn. Measured: with these in the
   * deps, deleting the `setQueueReady` bump left the suite GREEN; with them
   * in a ref, that deletion goes red — the assertion the test claims to make.
   */
  const notify = useRef({ toast, t });
  notify.current = { toast, t };

  /**
   * The transport and the overlay sink, HELD IN A REF for the reason `notify` above is.
   *
   * Both are things a caller may build inline — an object literal, an arrow — so listing either in
   * the automatic batch's dependency array would re-run that effect on every render of the parent
   * and make the cold-mirror retrigger below work by accident rather than by design. The effects
   * read `link.current`; the dependency list stays the four signals it claims to be.
   */
  const link = useRef({ wire, publish: opts.publish });
  link.current = { wire, publish: opts.publish };

  const merge = useCallback(
    (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => {
      if (rows.length === 0) return;
      // OUT TO THE HOST'S OVERLAY FIRST, when there is one. Absent on every surface that owns its
      // own — see the option — so this line changes nothing for the client this file ships in.
      link.current.publish?.(rows);
      setSuggestions((prev) => {
        const next = new Map(prev);
        for (const r of rows) next.set(senderKey(r.address), r.suggestion);
        return next;
      });
    },
    [],
  );

  /**
   * Read what has already been bought — once per session, when the Screener
   * is first opened. This is what makes a suggestion survive a reload:
   * without it the chips lived only as long as the tab that bought them,
   * and the next press re-asked for answers the server already held — free
   * (a stored answer is served, not re-bought) but silent, so it looked
   * like the purchase had failed. ONE page: the server's queue is `date
   * desc` like the list on screen, so a page covers the front of both;
   * senders past the window have no chip until bought or scrolled to.
   */
  useEffect(() => {
    if (!active || io.current.hydrated || !link.current.wire.configured()) return;
    io.current.hydrated = true;
    let cancelled = false;
    void (async () => {
      try {
        const page = await link.current.wire.list({ limit: HYDRATE_LIMIT });
        if (cancelled) return;
        if (page.suggestable?.maxPerRequest) setMaxPerRequest(page.suggestable.maxPerRequest);
        /* THE SENDERS THIS PAGE LEFT OUT, and why. `list()` excludes a sender whose decision is
           waiting on another install, so without this field the exclusion is a disappearance: a
           press made in a previous session takes the sender out of the queue and nothing on
           screen accounts for them. Read off the SAME page rather than fetched separately —
           it is a property of this response, and a second request for it would be a round trip
           bought to avoid a seam. An older server sends nothing and the surface shows nothing. */
        setOutstanding(
          (page.pendingDecisions ?? []).map((d) => ({
            subject: d.subject,
            scope: d.scope,
            decidedAt: d.decidedAt,
            /* THE PAGE DOES NOT NAME THE HOLDER — it is a property of the MAILBOX and this is a
               list of senders. The unnamed sentence is what renders, which is the honest one:
               this install knows a decision is outstanding and not which machine owes it. A
               press made in THIS session carries the name, because the answer to that press
               did. */
            holder: null,
            ...(d.state !== undefined ? { state: d.state } : {}),
            ...(d.refusedReason !== undefined ? { refusedReason: d.refusedReason } : {}),
          })),
        );
        // A NUMBER, not a truthy read of an optional field: an older server omits it entirely and
        // must leave the fallback standing, and a nonsense value must not become a chunk size.
        const rec = (page.suggestable as { recommendedPerRequest?: unknown } | undefined)?.recommendedPerRequest;
        if (typeof rec === "number" && Number.isFinite(rec) && rec >= 1) setRecommendedPerRequest(Math.floor(rec));
        merge(
          page.items
            .filter((i) => i.aiSuggestion != null)
            .map((i) => ({
              address: i.sender.address,
              suggestion: toSuggestion(i.aiSuggestion!),
            })),
        );
      } catch {
        // A failed read leaves the surface exactly as it was — rows without chips, which is
        // the state it already renders honestly. Nothing is claimed, so nothing is said.
      } finally {
        // SETTLED, not "succeeded". The automatic batch waits on this so it does not buy answers
        // the account already owns — but a hydration that FAILED must not block it for ever,
        // because the stored-skip is the server's job anyway and a re-ask for a stored answer is
        // free (`charged: 0`). So both outcomes release the gate; only the ordering is bought.
        if (!cancelled) setHydrateSettled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, merge]);

  /**
   * The automatic batch — one per mounted Screener, only when the account opted in. Everything
   * this path may do is buy suggestions: it reaches {@link SuggestWire.suggest} and nothing
   * else — no branch can call `POST /screener/:id`, write a rule or move a message, which keeps
   * the opt-in an opt-in to WORK rather than to a decision
   * (`test/screener-auto-suggest.test.tsx` watches the calls). No dry run in front of it, the
   * one difference from the manual control: the cost was named when the setting was turned on,
   * and the batch is bounded by {@link AUTO_BATCH_SIZE}, so the figure quoted then is the one
   * that applies.
   */
  useEffect(() => {
    if (!active) {
      // LEAVING RE-ARMS THE BATCH, BUT NEVER THE REFUSAL. Coming back to the Screener is the
      // event the opt-in is scoped to, so the next visit may buy the next few senders; a refusal
      // is a standing condition and must not be re-tested on every visit. Two latches, one reset.
      io.current.autoFired = false;
      return;
    }
    if (!autoSuggest || !link.current.wire.configured()) return;
    if (!hydrateSettled) return;
    if (io.current.autoFired || io.current.autoDisarmed) return;
    const set = io.current.queue.slice(0, AUTO_BATCH_SIZE);
    if (set.length === 0) return;
    // LATCHED BEFORE THE AWAIT. Set after it, two effect passes racing each other both read
    // false and both buy — and the second batch is money nobody asked for.
    io.current.autoFired = true;
    // The batch's OWN counter (`autoRun`), never the manual control's `run` — see the ref's
    // comment. This effect fires mid-way through a manual purchase on the ordinary path, and a
    // shared counter made it silently discard that purchase.
    const run = ++io.current.autoRun;
    void (async () => {
      try {
        const res = await link.current.wire.suggest(set, { idempotencyKey: newKey() });
        if (io.current.autoRun !== run) return;
        merge([
          ...res.suggestions.map((s) => ({ address: s.sender, suggestion: toSuggestion(s) })),
          ...toSkips(res.skipped),
          ...toStopped(set, res),
        ]);
        // SAID OUT LOUD, every time, even though nobody pressed anything. This is the "visible
        // after the fact" half of the opt-in: money moved, so the same sentence the manual
        // purchase shows is shown here. A spend the user only discovers on their next invoice is
        // the failure mode the setting exists to avoid, not one it is licensed to create.
        notify.current.toast(summarize(res, notify.current.t));
      } catch (err) {
        if (io.current.autoRun !== run) return;
        // DISARM, DO NOT RETRY. See the latch's own comment: every refusal on this path is a
        // standing condition (no credits, AI off, no classifier), not a blip, so retrying it
        // automatically is a flood against a wall.
        io.current.autoDisarmed = true;
        const why = link.current.wire.messageFor(err, notify.current.t("suggest.failed"));
        // TOASTED, NOT ONLY NOTICED — and the distinction was found by a test rather than by
        // reading. `notice` is painted INSIDE the suggest panel, which on this path nobody
        // opened, so setting it alone left a refused automatic purchase completely invisible: the
        // user turned a setting on, it silently did nothing, and the only way to find out was to
        // notice the absence of chips. A setting that fails quietly is the failure mode this
        // whole feature is supposed to avoid, so the refusal goes through the same channel the
        // success does. `notice` is set as well, for the panel they may open next.
        setNotice(why);
        notify.current.toast(why);
      }
    })();
    // FOUR DEPENDENCIES, ALL OF THEM REAL SIGNALS: is the Screener open, did the account opt in,
    // has hydration settled, and is there anything in the queue yet. `toast`/`t` are read through
    // `notify` precisely so they cannot smuggle a fifth — see that ref's comment for the
    // measurement that made this necessary rather than tidy.
  }, [active, autoSuggest, hydrateSettled, queueReady, merge]);

  /**
   * Deliberately NOT memoised. It is called during render and closes over every piece of the
   * control's state, so a `useCallback` would need all of them in its dependency array —
   * including `quote`, a fresh object every render — and the one it would silently get wrong
   * is `phase`: a stale closure keeps reporting "pricing" after the price has landed, and the
   * confirm button never becomes pressable. Building a small object per render is cheaper
   * than the class of bug that memoising it invites.
   */
  const forSenders = (addresses: string[], resuggestable: string[] = []): SuggestBatchControl => {
    // The automatic batch's only view of the queue: the UNSUGGESTED list
    // alone, deliberately not widened to `resuggestable`. The automatic
    // path spends without a press; its entire licence is "the cost was
    // named when the setting was turned on" — a figure quoted over senders
    // with no answer yet. Including re-ask senders would spend, unpressed,
    // on a batch nobody priced; the re-ask stays manual. A ref write during
    // render is safe here (schedules nothing, changes no output); the
    // alternative — a hook argument — is the cycle `forSenders` exists to avoid.
    io.current.queue = addresses;
    // One state write, the first time there is anything to buy, so the effect above gets a
    // dependency that changes when the cold mirror finally has senders in it.
    if (!autoSeen.current && addresses.length > 0) {
      autoSeen.current = true;
      setQueueReady((n) => n + 1);
    }
    // The ladder is bounded by the PURCHASE ceiling, not the per-request cap — a size larger than
    // one request is delivered as several requests, below.
    //
    // BOTH ladders are computed every render, because the entry points need them before the mode
    // has changed. `openAgain` is pressed while `mode` is still `new`, so a single ladder read off
    // the current mode would open the re-ask at a size taken from the buy list — the "Suggest
    // again for 25" that quotes 3 because 25 was never in this set.
    const newSizes = batchSizes(addresses.length, MAX_SUGGEST_BATCH);
    const againSizes = batchSizes(resuggestable.length, MAX_SUGGEST_BATCH);
    // The set the OPEN ladder acts on. Every slice below — price, confirm, the size labels — comes
    // from here, so the set that is quoted and the set that is bought are one list.
    const target = mode === "again" ? resuggestable : addresses;
    const sizes = mode === "again" ? againSizes : newSizes;
    const chosen = sizes.includes(size) ? size : (sizes[sizes.length - 1] ?? 0);

    /**
     * One request carries at most this many senders — the lowest of the server's recommended
     * size (`suggestable.recommendedPerRequest`; {@link SUGGEST_CHUNK_SIZE}'s fallback on an
     * older server) and the 413 cap ({@link maxPerRequest}; {@link ASSUMED_MAX_PER_REQUEST}
     * until read). The cap is only the 413 boundary; the budget is what fits one serverless
     * invocation, the smaller of the two in production — a cap-sized request would classify
     * past the deadline and return nothing (the frozen "0 of N"). Larger prices and purchases
     * split via `chunksOf`, always in queue order, so a chunk is a contiguous prefix.
     */
    const chunkSize = Math.max(1, Math.min(maxPerRequest, recommendedPerRequest ?? SUGGEST_CHUNK_SIZE));
    const chunksOf = (set: string[]): string[][] => {
      const out: string[][] = [];
      for (let i = 0; i < set.length; i += chunkSize) out.push(set.slice(i, i + chunkSize));
      return out;
    };

    /**
     * Price the first `n` of `from` on the SERVER — no model, no debit, nothing stored. Priced
     * in request-sized chunks and SUMMED — the same chunks the purchase will use, so the number
     * on screen is the exact ceiling the purchase honours; every chunk checks the press counter
     * on arrival, so a size changed mid-flight discards the half-summed price. `from` and `kind`
     * are ARGUMENTS, not reads of `target`/`mode`: `openAgain` calls `setMode("again")` and
     * prices in the same handler, where `mode` is still `new` in the closure. A quote of ZERO is
     * a real answer: the server prices only what it is not already holding, so an unchanged
     * re-ask is honestly free; `kind` picks the right sentence.
     */
    const price = (n: number, from: string[], kind: SuggestMode) => {
      const set = from.slice(0, n);
      if (set.length === 0) {
        setPhase("ready");
        setQuote({ senders: 0, credits: 0 });
        setNotice(t(kind === "again" ? "suggest.nothingAgain" : "suggest.nothing"));
        return;
      }
      // Captured ONCE. Never re-bumped inside the loop — a per-chunk bump would make each chunk
      // invalidate the next one's check (the self-cancellation shape, inside one price).
      const run = ++io.current.run;
      setPhase("pricing");
      setQuote(null);
      setNotice(null);
      void (async () => {
        let senders = 0;
        let credits = 0;
        for (const chunk of chunksOf(set)) {
          let res;
          try {
            res = await wire.suggest(chunk, { dryRun: true });
          } catch (err) {
            if (io.current.run !== run) return;
            setPhase("ready");
            setQuote(null);
            // The server's own sentence. Every refusal on this path — no classifier
            // connected, AI switched off, no credits — already has a true one, and a second
            // taxonomy here is how a user gets told the wrong reason.
            setNotice(wire.messageFor(err, t("suggest.failed")));
            return;
          }
          if (io.current.run !== run) return;
          // NO PRICE, NO PURCHASE — for ANY chunk. A server that answers without `quotedCredits`
          // (one deployed before the field existed, reached in the minutes between two deploys)
          // leaves part of the cost unknown, and an unknown cost is not one a person can consent
          // to. One unpriceable chunk makes the WHOLE set unpriceable rather than partly guessed;
          // the confirm stays disabled because `quote` is null.
          if (typeof res.quotedCredits !== "number") {
            setPhase("ready");
            setQuote(null);
            setNotice(t("suggest.failed"));
            return;
          }
          senders += res.quoted;
          credits += res.quotedCredits;
        }
        if (io.current.run !== run) return;
        setPhase("ready");
        setQuote({ senders, credits });
        setNotice(
          senders === 0 ? t(kind === "again" ? "suggest.nothingAgain" : "suggest.nothing") : null,
        );
      })();
    };

    /**
     * Open one of the two ladders: pick a size on it, and price that.
     *
     * A size chosen earlier survives a cancel and a re-open — but only onto the ladder it was
     * chosen on. Carried across a MODE SWITCH it would be a number that means something else:
     * "25" picked off a buy list of 400 lands on a re-ask ladder of [10, 12] as either a
     * pressed-looking button that is not there, or a slice of a different set than the one the
     * label named. Switching sets therefore always opens at that set's largest size, which is
     * the "all N" a person pressing "Suggest again…" is asking for anyway.
     */
    const openOn = (kind: SuggestMode, from: string[], ladder: number[]) => {
      const keep = kind === mode && ladder.includes(size);
      const start = keep ? size : (ladder[ladder.length - 1] ?? 0);
      setMode(kind);
      setSize(start);
      price(start, from, kind);
    };

    return {
      available: addresses.length,
      resuggestable: resuggestable.length,
      mode,
      pool: target.length,
      sizes,
      size: chosen,
      phase,
      quote,
      notice,
      progress,
      open: () => openOn("new", addresses, newSizes),
      openAgain: () => openOn("again", resuggestable, againSizes),
      choose: (n: number) => {
        setSize(n);
        // `target`/`mode` and not arguments here: `choose` is only reachable from an open ladder,
        // so the render that drew the button it was pressed on already settled the mode.
        price(n, target, mode);
      },
      cancel: () => {
        io.current.run++;
        setPhase("closed");
        setQuote(null);
        setNotice(null);
        setProgress(null);
        // Back to the ordinary ladder. A closed control that still reported `again` would draw the
        // re-ask's wording over the next press, whichever button opened it.
        setMode("new");
      },
      /**
       * Buy the chosen set — in request-sized chunks, halting on the first that stops or fails.
       * Consent is to the whole (priced above as the sum of chunk quotes); the money rules, in order:
       * ONE idempotency key PER CHUNK — a retry replays that chunk's answer, a re-press re-buys only
       * chunks that never landed (landed ones answer `duplicate`, cost 0); a shared key would make
       * chunk 2 replay chunk 1's response. `run` is captured once and checked per chunk on arrival —
       * a second press aborts the loop, and it is never re-bumped inside it (self-cancellation moved
       * inside one purchase). Chips land incrementally; a stopped or thrown chunk halts the loop, the
       * summary names what actually charged, spend never exceeds the quote.
       */
      confirm: () => {
        // THE SET THE OPEN LADDER QUOTED, whichever it is. Sliced from `target` and not from
        // `addresses`, or a confirmed re-ask would buy the front of the buy list — a purchase over
        // senders the price on screen never covered.
        const set = target.slice(0, chosen);
        if (set.length === 0 || phase === "running") return;
        const run = ++io.current.run;
        const total = set.length;
        setPhase("running");
        setNotice(t("suggest.progress", { done: 0, total }));
        // The same fact as the sentence above, in the shape a track can render. Written HERE and
        // not derived from `notice`, so a locale that reorders the numbers cannot change it.
        setProgress({ done: 0, total });
        void (async () => {
          const gotSuggestions: ScreenerSuggestWire["suggestions"] = [];
          const gotSkipped: Array<{ reason: string }> = [];
          let charged = 0;
          let stopped: "out_of_credits" | "spend_unavailable" | undefined;
          /**
           * The LATEST balance the server reported, across the chunks of one purchase.
           *
           * Last-write-wins rather than first, because each chunk's read happens after that
           * chunk's spend: the newest answer is the one that describes the account as it stands
           * when the summary is shown. Left `undefined` when no chunk carried the field, which
           * is what an unmetered deployment produces — and `summarize` then omits the clause
           * instead of inventing a figure.
           */
          let remainingCredits: number | undefined;
          for (const chunk of chunksOf(set)) {
            let res;
            try {
              res = await wire.suggest(chunk, { idempotencyKey: newKey() });
            } catch (err) {
              // Stale — a newer press owns the state; paint nothing.
              if (io.current.run !== run) return;
              // HALT on the first chunk that threw. Keep what earlier chunks bought (money moved
              // for them and their chips are already on screen) and show the server's sentence.
              setPhase("ready");
              // A HALTED RUN IS NOT AN IN-FLIGHT ONE. Leaving the track at "8 of 40" under a
              // sentence that says the run stopped would be two surfaces disagreeing about the
              // same event, with the moving one winning the reader's attention.
              setProgress(null);
              const why = wire.messageFor(err, t("suggest.failed"));
              // A HALTED RUN STILL SPENT. Announced before the toast, so the allowance line and
              // the summary describe the same account at the same moment.
              if (charged > 0) announceSpend();
              if (gotSuggestions.length > 0) {
                setNotice(t("suggest.stoppedAt", { done: gotSuggestions.length, total, reason: why }));
                toast(summarize(
                  {
                    suggestions: gotSuggestions, charged, skipped: gotSkipped,
                    // Whatever the last chunk that ANSWERED reported. The chunk that threw said
                    // nothing about the balance, and a run that stopped part-way is exactly when
                    // "how much is left" is worth stating.
                    ...(typeof remainingCredits === "number" ? { remainingCredits } : {}),
                  },
                  t,
                ));
              } else {
                setNotice(why);
              }
              return;
            }
            // Stale — a newer press owns the state; keep nothing from this chunk.
            if (io.current.run !== run) return;
            // Chips land NOW, before the next chunk is bought.
            merge([
              ...res.suggestions.map((s) => ({ address: s.sender, suggestion: toSuggestion(s) })),
              ...toSkips(res.skipped),
              // The rest of THIS chunk, when the gate stopped part-way through it.
              ...toStopped(chunk, res),
            ]);
            gotSuggestions.push(...res.suggestions);
            gotSkipped.push(...res.skipped);
            charged += res.charged;
            stopped ??= res.stopped;
            if (typeof res.remainingCredits === "number") remainingCredits = res.remainingCredits;
            setNotice(t("suggest.progress", { done: gotSuggestions.length, total }));
            setProgress({ done: gotSuggestions.length, total });
            // HALT on the first chunk the gate stopped part-way: the balance is exhausted, so
            // every later chunk would stop too. What this chunk bought stays; the summary says so.
            if (res.stopped) break;
          }
          if (io.current.run !== run) return;
          setPhase("closed");
          setNotice(null);
          // CLEARED, not left at `{done: total}`. A full track that never goes away is a claim
          // that work is still in flight; the completed run's numbers are in the toast.
          setProgress(null);
          // ONCE PER RUN, not once per chunk: the balance a person acts on is the one this
          // purchase ended at, and a re-read per chunk would be N requests to show N−1 numbers
          // nobody had time to read. Guarded on `charged`, so a run the gate refused outright
          // (nothing bought, nothing debited) does not send every listener to the server.
          if (charged > 0) announceSpend();
          toast(summarize(
            {
              suggestions: gotSuggestions, charged, ...(stopped ? { stopped } : {}), skipped: gotSkipped,
              ...(typeof remainingCredits === "number" ? { remainingCredits } : {}),
            },
            t,
          ));
        })();
      },
    };
  };

  /**
   * Deliberately NOT memoised, for the reason {@link forSenders} gives: it closes over `optIn`,
   * so a `useCallback` would need it in the dependency array and the one it would get wrong is
   * the phase — a stale closure keeps reporting `pricing` after the price landed and the confirm
   * never becomes pressable.
   */
  const autoOptIn = (addresses: string[]): AutoOptInControl => {
    const open = () => {
      const set = addresses.slice(0, AUTO_BATCH_SIZE);
      // NOTHING TO BUY IS ANSWERED LOCALLY, not by the server. `parseSenderSet` 400s on an empty
      // list, so asking would turn "your Screener is empty" into "that setting did not save".
      // The setting is still turnable on from here — an empty queue today says nothing about the
      // senders it will hold next week, which is the whole point of an automatic batch.
      if (set.length === 0) {
        io.current.optInRun++;
        setOptIn({ phase: "ready", quote: { senders: 0, credits: 0 }, notice: t("suggest.nothing") });
        return;
      }
      const run = ++io.current.optInRun;
      setOptIn({ phase: "pricing", quote: null, notice: null });
      void (async () => {
        try {
          const res = await wire.suggest(set, { dryRun: true });
          if (io.current.optInRun !== run) return;
          // NO PRICE, NO CONSENT — the same rule the manual control states, and it has to be
          // restated here rather than shared because this is the flow that authorises EVERY
          // later batch rather than one. A server too old to carry `quotedCredits` leaves the
          // cost unknown, and the confirm stays disabled because `quote` is null. Multiplying
          // the count by an assumed per-sender price is the guess the field exists to remove.
          if (typeof res.quotedCredits !== "number") {
            setOptIn({ phase: "ready", quote: null, notice: t("suggest.failed") });
            return;
          }
          setOptIn({
            phase: "ready",
            quote: { senders: res.quoted, credits: res.quotedCredits },
            notice: res.quoted === 0 ? t("suggest.nothing") : null,
          });
        } catch (err) {
          if (io.current.optInRun !== run) return;
          // The server's own sentence — no classifier connected, AI switched off, no credits.
          // A second taxonomy here is how a user with an empty balance is told the model is down.
          setOptIn({ phase: "ready", quote: null, notice: wire.messageFor(err, t("suggest.failed")) });
        }
      })();
    };

    return {
      supported: wire.configured(),
      batchSize: AUTO_BATCH_SIZE,
      available: addresses.length,
      phase: optIn.phase,
      quote: optIn.quote,
      notice: optIn.notice,
      open,
      cancel: () => {
        io.current.optInRun++;
        setOptIn({ phase: "closed", quote: null, notice: null });
      },
    };
  };

  // `merge` is the whole of `absorb`, exposed rather than reimplemented — see the interface.
  return { suggestions, absorb: merge, forSenders, autoOptIn, outstandingDecisions: outstanding };
}

/**
 * The sizes to offer for a queue of `available` senders under a per-request cap.
 *
 * Always ends with the largest single request that is possible, so "everything you can buy in
 * one go" is one press rather than arithmetic the user performs. Sizes at or above that are
 * dropped rather than clamped: two buttons reading 25 and 50 that both buy 12 is worse than
 * one button reading 12.
 */
export function batchSizes(available: number, maxPerRequest: number): number[] {
  const cap = Math.min(Math.max(0, available), Math.max(1, maxPerRequest));
  if (cap === 0) return [];
  const out = OFFERED_SIZES.filter((n) => n < cap);
  out.push(cap);
  return out;
}

/**
 * The server's answer, as a destination — or the absence of one. `no` is
 * `screened`, not `spam`: a screened-out sender's mail goes to
 * `ohmail/Screened` and stays reversible — reading a low-confidence "no" as
 * spam would quarantine a stranger on the model's word. SWITCHED, not a
 * ternary: `decision === "yes" ? "ohbox" : "screened"` is the shape that
 * turns a new wire value into a silent decline — every `hold` would have
 * filed to Screened with no code changed and no test to notice; an
 * exhaustive switch makes the third answer a compile error.
 */
/**
 * The five piles a folder answer maps to, and the only place that mapping is written.
 *
 * `ohmail/Screener` is deliberately absent: it is not a pile a decision files to, it is the queue
 * the sender is already in, so it falls through to `screener` — the no-action arm — along with any
 * label this table does not know.
 */
const VIEW_DEST: Record<string, SenderSuggestion["dest"]> = {
  "INBOX": "ohbox",
  "ohmail/Reads": "reads",
  "ohmail/Receipts": "receipts",
  "ohmail/Screened": "screened",
  "ohmail/Quarantine": "spam",
};

/**
 * Exported for the desktop control, which buys the same answers over its own transport and must
 * read them with the SAME table. A second copy of this mapping is a second place for a new wire
 * value to be silently declined into "Screened", which is the defect the switch below records.
 */
export function toSuggestion(a: {
  decision: "yes" | "no" | "hold"; destination?: string; confidence: number; rationale: string;
}): SenderSuggestion {
  // A `hold` is a non-answer whatever folder travels beside it, so it is read first and the
  // destination is never consulted. Letting a folder outrank the hold is how the surface would
  // start naming a pile for a sender the model explicitly declined to place.
  if (a.decision === "hold") return { dest: "screener", confidence: a.confidence, rationale: a.rationale };

  // THE SERVER'S OWN ANSWER, when it sends one. An older server does not, and the fallback below
  // is the two-way reading this function used to be — never a guessed folder. A client that filled
  // in "Reads" because the server said "no" would be inventing advice nobody bought.
  const named = a.destination ? VIEW_DEST[a.destination] : undefined;
  const dest: SenderSuggestion["dest"] = named
    ?? (a.decision === "yes" ? "ohbox" : "screened");
  return { dest, confidence: a.confidence, rationale: a.rationale };
}

/**
 * The senders a run could not answer for, as overlay entries.
 *
 * `not_held` is deliberately absent: that sender is no longer at the gate, so their row is not on
 * screen to carry a chip. Every other reason describes a row the person is still looking at.
 */
/**
 * THE SENDERS A STOPPED RUN NEVER REACHED — the reason, on their own rows.
 *
 * A run that stops on the gate returns suggestions for the senders it got to and NOTHING for the
 * rest, so every unreached row fell back to "No suggestion yet for this sender" — a promise, on
 * an account that cannot buy one. A subscription that may not spend is a STANDING condition, so
 * that sentence stood on every waiting sender indefinitely while the real fact arrived only as a
 * one-off toast under the batch that discovered it. The copy for both stop reasons already exists
 * (`aiSkip.*`); only the rows were missing it.
 */
export function toStopped(
  asked: readonly string[],
  res: { suggestions: Array<{ sender: string }>; skipped: Array<{ sender: string }>; stopped?: SuggestSkipShown },
) {
  if (!res.stopped) return [];
  const answered = new Set<string>([
    ...res.suggestions.map((x) => x.sender.toLowerCase()),
    ...res.skipped.map((x) => x.sender.toLowerCase()),
  ]);
  const reason = res.stopped;
  return asked
    .filter((a) => !answered.has(a.toLowerCase()))
    .map((address) => ({
      address,
      suggestion: { dest: "screener" as const, confidence: 0, rationale: "", noAnswer: reason },
    }));
}

export function toSkips(skipped: Array<{ sender: string; reason: ScreenerSkipReason }>) {
  return skipped
    .filter((s) => s.reason !== "not_held")
    .map((s) => ({
      address: s.sender,
      suggestion: {
        dest: "screener" as const, confidence: 0, rationale: "",
        noAnswer: s.reason as SuggestSkipShown,
      },
    }));
}

/** What one completed purchase actually did, said in numbers. */
function summarize(
  res: {
    suggestions: unknown[];
    charged: number;
    stopped?: "out_of_credits" | "spend_unavailable";
    remainingCredits?: number;
    skipped: Array<{ reason: string }>;
  },
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  // The "N senders held back from the model" clause was here, counting `withheld` skips. Both the
  // reason and its sentence are gone with the AI-OPEN ruling; a run can no longer hold anything
  // back on the strength of what the mail looks like, so there is no count to state.
  const parts = [
    t("suggest.doneCount", { count: res.suggestions.length, credits: res.charged }),
    // ── WHAT IS LEFT, ONLY WHEN THE SERVER SAID SO ────────────────────────────────────────
    //
    // `typeof === "number"` and never `res.remainingCredits ?? …`: the field is absent on an
    // unmetered deployment and on a hosted one whose balance read failed, and 0 is a real
    // balance with a real sentence. The clause is omitted rather than guessed, and nothing here
    // derives it — a client that computed `known - charged` would be keeping a second ledger
    // that goes wrong on a renewal, a refund, an expiry or a second tab. The side that moves
    // the money is the side that names it.
    typeof res.remainingCredits === "number"
      ? t("suggest.remaining", { count: res.remainingCredits })
      : null,
    res.stopped === "out_of_credits" ? t("suggest.stoppedCredits") : null,
    res.stopped === "spend_unavailable" ? t("suggest.stoppedUnavailable") : null,
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * The sentence for a refusal the HOSTED transport produced —
 * {@link CLOUD_WIRE}'s half of {@link SuggestWire.messageFor}, never called
 * directly by the flow. An {@link ApiError} already carries the service's
 * own message ("no AI classifier connected", "managed AI is switched off",
 * "no AI actions remain") — each a different, actionable fact written by
 * the code that decided. Re-deriving them from status codes is how a user
 * with an empty balance is told the model is down. Anything that is not an
 * `ApiError` is a bug in this client, with nothing true to say.
 */
function apiMessageFor(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * A fresh idempotency key.
 *
 * `crypto.randomUUID` is present in every browser this app supports and in jsdom; the
 * fallback is for a runtime that lacks it, where a merely unique-enough key is still better
 * than sending none — an absent key means a lost response is retried as a second purchase.
 */
function newKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
