"use client";

/**
 * Buying AI suggestions for the Screener — the control that names the cost BEFORE it spends.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `screener-state.ts` ──────────────────────────────────
 *
 * The waiting rows come from the message mirror, and the mirror has never carried a
 * suggestion: `/sync` is a feed of changes to mail, and advice about mail is not one. So a
 * live account rendered "No suggestion" on every row, the "Apply all" control had nothing to
 * apply, and Enter had nothing to accept — not because the server could not answer, but
 * because nothing ever asked it. This module is the asking.
 *
 * It holds two things and nothing else: the suggestions known so far (joined onto rows by
 * sender address) and the small state machine of one purchase. Decisions, undo and the
 * commit window stay where they were.
 *
 * ── THE SPEND RULE THIS FILE IMPLEMENTS ──────────────────────────────────────────────────
 *
 * Credits are never moved without an action that named the cost first. That is why the flow
 * has a dry run in the middle of it and cannot be collapsed: opening the control prices the
 * exact set that is about to be posted, on the server, and the confirmation shows the number
 * the server answered. A price computed here would be a second implementation of the
 * eligibility rule — is this sender still held, is their mail withheld from the model, has
 * their answer already been bought — and the moment it disagreed with the server's, the
 * button would be quoting one figure and buying another.
 *
 * The batch is composed here for the same reason the endpoint demands an explicit list:
 * "suggest for everyone" over a backlogged mailbox is a four-figure spend behind one click.
 * The senders are taken from the FRONT of the queue in its own order, so the same press
 * twice covers the same senders and a person can predict what they are buying.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { senderKey } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import {
  ApiError, apiConfigured, screener as screenerApi,
  type ScreenerSkipReason, type ScreenerSuggestWire,
} from "../api-client";

/**
 * One sender's suggestion, in the vocabulary the rows already speak.
 *
 * All five piles appear here, because all five are things `POST /screener/:id` can perform: it
 * takes a `dest` and files the sender's held mail there. This comment used to say the wire had
 * only two outcomes and that no finer destination could be shown. That stopped being true when
 * the endpoint learned the full destination set, and the stale sentence had a cost: the surface
 * kept collapsing every answer into "Ohbox" or "Screened out", so a model that said Receipts,
 * Reads or Spam was reported as having said "Screened out" — and the product looked as though it
 * never suggested those three at all.
 *
 * `screener` is the sixth value and it is NOT a filing: it is "leave this one where it already is",
 * which is what the server's `hold` means and what `OhmailView` has always called this pile. It
 * is here because the alternative — collapsing it into one of the two real ones — is the defect
 * this type used to carry. The comment above this interface used to read "the server's own
 * answer is that same yes/no, so nothing is lost in the mapping". The server's answer was
 * six-valued and the collapse behind it was a denylist, so `ohmail/Screener` fell through into
 * `ohbox` — and that is the classifier's OWN label for a first-contact stranger, which is what
 * every row in this queue is, so it was the answer that arrived most often. The surface showed
 * "Ohbox" over a rationale asking for a human.
 *
 * A row carrying `screener` is decidable by a PERSON and never by a bulk control: applying it
 * would move nothing and grant nothing, so it is not an outcome to offer.
 */
export interface SenderSuggestion {
  dest: "ohbox" | "reads" | "receipts" | "screened" | "spam" | "screener";
  confidence: number;
  rationale: string;
  /**
   * WHY THERE IS NO ANSWER, when there is none.
   *
   * A purchase does not always come back with a verdict for every sender it was asked about, and
   * the surface used to render those rows exactly as it rendered a sender nobody had bought advice
   * for — blank. The person had paid, watched the run finish, and found rows that looked skipped,
   * with nothing anywhere saying why.
   *
   * It was called `withheld`, and the rename is the AI-OPEN ruling arriving in the type system.
   * Every remaining reason — the balance ran out, AI is off for the account, the model faulted —
   * is a fact about the RUN, and every one of them is fixed by pressing again later. None of them
   * is a fact about the mail, which is what "withheld" said and what this product no longer does
   * on a path a person asked for.
   *
   * Present ⇒ `dest` is `screener` and there is nothing to act on, only something to say. Absent ⇒
   * this is an ordinary suggestion.
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

/** The control, already bound to the senders it would act on. */
export interface SuggestBatchControl {
  /** Waiting senders with no suggestion yet — how much there is to buy. */
  available: number;
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
   * HOW FAR A RUNNING PURCHASE HAS GOT, as two numbers rather than as a sentence.
   *
   * `notice` already carries "3 of 40 suggested…", and that string is where this fact lived
   * until now. A translated sentence is the wrong shape for a progress bar: a surface that
   * wanted a track had to parse English back out of it, and a locale that ordered the numbers
   * differently would break the parse rather than the sentence. So the numbers are published
   * beside the sentence, from the same two sources, and neither is derived from the other.
   *
   * `null` in every phase but `running`, and cleared — not left at `{done: total}` — when the
   * run finishes: a filled track that never goes away claims work is still in flight. It is
   * set at the same two points the notice is (before the first chunk leaves, and after each
   * chunk lands) so the two can never disagree about a frame.
   *
   * `total` is the SET the user consented to, not the number of chunks and not the number of
   * senders the server ended up quoting — a purchase that halts part-way must still show what
   * it was aiming at, or "8 of 8" would report a stopped run as a complete one.
   */
  progress: { done: number; total: number } | null;
  open: () => void;
  choose: (size: number) => void;
  confirm: () => void;
  cancel: () => void;
}

/**
 * THE OPT-IN'S QUOTE — what turning the automatic batch ON would cost, before it is on.
 *
 * The automatic path has no dry run of its own (see the effect that fires it), and the reason
 * it is allowed not to have one is THIS: the cost was named when the setting was turned on.
 * That sentence was a promise about a control that did not exist — the flag was reachable only
 * by a raw API call — so this is the control that makes it true.
 *
 * It prices and stops. There is no `confirm` here on purpose: the thing being consented to is a
 * SETTING, written through `useConsentState` so the flag the spender reads and the flag the
 * switch shows are one value. A `confirm` on this object would be a second writer and the
 * beginning of the stale-OFF bug — switch off in Settings, Screener still buys.
 */
export interface AutoOptInControl {
  /**
   * Is there a server to ask? False on the desktop build and on any host with no API base.
   *
   * The row must not render at all where this is false. The flag cannot become true there —
   * `useConsentState` skips its fetch, and the automatic effect checks `apiConfigured()` — so a
   * switch would be a control with nothing behind it, which is the defect this slice is fixing
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
   * PUT ANSWERS INTO THE OVERLAY FROM SOMEWHERE THAT IS NOT THIS HOOK.
   *
   * There is exactly one overlay on screen — `useScreenerState` joins it onto the rows, and the
   * chips, the suggested count, "Apply all" and Enter-accept are all read from it. So a host that
   * buys suggestions its own way has to land them HERE or they are answers nothing can display:
   * the desktop app talks to an engine on the same machine over a channel this file cannot use,
   * and its control is its own (see `apps/desktop/src/local-suggest.tsx`).
   *
   * Deliberately the only seam of its kind. It adds no way to spend and no way to decide — it
   * takes rows that have already been answered for and shows them.
   */
  absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
  /**
   * Bind the control to a sender list — the waiting rows with no suggestion, in queue order.
   *
   * A function rather than a hook argument because the list is computed by
   * `useScreenerState`, which in turn consumes {@link suggestions}: passing it in would be a
   * cycle. Called during render, it closes over the list for the one press that follows.
   */
  forSenders: (addresses: string[]) => SuggestBatchControl;
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
 * The per-request CAP — the 413 boundary — to assume before the server has published its own.
 *
 * `GET /screener` answers `suggestable.maxPerRequest` and that number is preferred the moment
 * it arrives; this is the ceiling the control assumes if that read has not landed (offline, or a
 * press faster than the fetch). It is the most a single request may carry before the server
 * REFUSES it, and it is deliberately AT OR BELOW the server's real cap of
 * {@link ../../../packages/services/src/screener-service MAX_SUGGEST_SENDERS} (50) rather than
 * above it: guessing high costs a 413 on a chunk that had already quoted a price.
 *
 * It is NOT the size a request actually carries — that is the smaller {@link SUGGEST_CHUNK_SIZE},
 * and a request is bounded by whichever of the two is lower.
 */
const ASSUMED_MAX_PER_REQUEST = 25;

/**
 * HOW MANY SENDERS ONE REQUEST ACTUALLY CARRIES — the latency budget, distinct from the 413 cap.
 *
 * The server classifies the senders in a request SERIALLY through the model, and the whole request
 * has to finish inside one serverless invocation (its host runs under a 60-second ceiling). A
 * sender costs roughly two seconds of model time, so a request of about fifteen finishes in well
 * under half that budget — leaving room for a cold start or an occasional slow sender — while a
 * request the size of the per-request cap ({@link ASSUMED_MAX_PER_REQUEST} / the server's
 * `maxPerRequest`, up to 50) would run PAST the invocation and return nothing the control could
 * show: no ticking progress, no chips, just a timeout.
 *
 * So the offered ladder (up to {@link MAX_SUGGEST_BATCH}) is split into requests of at most this
 * many, each of which reliably completes: a large purchase ticks forward one chunk at a time and
 * its chips land as it goes, instead of freezing on a single request that cannot finish. The cap
 * and this budget are two different bounds, and a request is never larger than the lower of them.
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
 * THE MOST ONE AUTHORISED PURCHASE MAY BUY — the ladder's ceiling, above the per-request cap.
 *
 * A purchase and a request are different sizes. One request is bounded by {@link SUGGEST_CHUNK_SIZE}
 * (what reliably classifies inside one serverless invocation) and by the server's per-request cap;
 * a purchase can be much larger, and is delivered as a sequence of those requests. Clamping the
 * ladder to a single request's worth is what an earlier control did — a purchase could then never
 * exceed one request, and stretching the request to fit a bigger ladder pushed it past the
 * invocation's deadline. This ceiling decouples the two: it is a number a person can picture
 * spending in one press, and a chosen size larger than one request is SPLIT into chunks that each
 * fit one request. The full set is still priced first (the sum of the chunk quotes), so consent is
 * to the whole, and spend never exceeds that sum.
 *
 * It is the top of {@link OFFERED_SIZES}: the ladder offers up to here and no higher.
 */
export const MAX_SUGGEST_BATCH = 400;

/** How much of the queue one hydration reads. A `cost: read` page; it spends nothing. */
const HYDRATE_LIMIT = 200;

/**
 * HOW MANY SENDERS ONE AUTOMATIC BATCH BUYS — the opt-in's entire spend per Screener open.
 *
 * Ten, not the endpoint's cap of fifty and not the largest size the manual control offers. The
 * automatic path spends without a press, so its bound has to be a number somebody can live with
 * being wrong about: at `AI_ACTION_COST` per sender, ten is a rounding error against the smallest
 * tier's monthly allowance, and a person who wants the other forty presses the manual control and
 * sees a quote first. A backlog is drained ten at a time across visits rather than in one
 * four-figure purchase nobody authorised individually — the reason the endpoint demands an
 * explicit sender list in the first place (see the header's spend rule).
 *
 * It is also why the flag needs no per-period ceiling stored on the account: the only thing that
 * can spend automatically is a person opening the Screener, and each open buys at most this many.
 */
export const AUTO_BATCH_SIZE = 10;

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
}): ScreenerSuggestions {
  const t = useTranslations("screener");
  const { active, toast } = opts;
  const autoSuggest = opts.autoSuggest === true;

  const [suggestions, setSuggestions] = useState<SuggestionOverlay>(() => new Map());
  const [phase, setPhase] = useState<SuggestPhase>("closed");
  const [size, setSize] = useState(0);
  const [quote, setQuote] = useState<{ senders: number; credits: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** See {@link SuggestBatchControl.progress}. Written beside `notice`, never derived from it. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [maxPerRequest, setMaxPerRequest] = useState(ASSUMED_MAX_PER_REQUEST);
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
     * THE AUTO LATCH — the whole safety of the automatic path is these three fields.
     *
     * `autoFired` goes true before the request leaves, so a re-render, a second effect pass under
     * StrictMode, or a warming mirror cannot buy a second batch. It is reset when the Screener goes
     * AWAY, which makes the unit "one batch per Screener-open": a person who comes back later gets
     * the next few senders, and a backlog drains across visits instead of in one purchase nobody
     * authorised individually.
     *
     * `autoDisarmed` is the refusal latch, and the reset above is what gives it a job. When the
     * server refuses — no credits (402), managed AI switched off (409), no classifier connected
     * (503) — the automatic path stops for the whole session and does not try again on the next
     * visit. Without it, an account with an empty balance would issue one doomed request every
     * time the Screener was opened: a client hammering a wall it has already been told about, and
     * for a 503 an automatic loop against a misconfiguration. The manual control still works and
     * still carries the server's own sentence, so nobody is left without a way in.
     *
     * The two were briefly redundant — `autoFired` was never reset, so nothing could reach the
     * second latch and REMOVING IT LEFT THE SUITE GREEN. That is recorded because a guard nobody
     * has watched fail is not evidence, and the fix was to give each of them a distinct
     * reachable state rather than to delete the one that happened to be unreachable.
     *
     * `queue` is the sender list the control was last bound to, recorded during render so the
     * effect below can read it without the render cycle `forSenders` exists to avoid.
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
     * THE AUTOMATIC BATCH'S OWN COUNTER — deliberately not `run`, for the reason `optInRun` is
     * not either, and it was the SCR-SUGGEST-FLAKE bug when it was.
     *
     * The automatic batch fires ASYNCHRONOUSLY, gated on `hydrateSettled`, so the first time it
     * runs is a network round trip after the Screener opens — and an owner who opens the Screener
     * and presses Suggest is inside that window: the manual purchase is in flight when the batch
     * fires. Sharing `run` meant the batch's own `++run` invalidated that in-flight manual
     * purchase, whose `await` then returned, saw the counter had moved, and discarded itself
     * WITHOUT clearing `running` — the button spun forever. On the next visit the batch's latch
     * had already fired, so the counter stood still and the same press worked, which is exactly
     * the "fails once, works on retry" the flake was reported as.
     *
     * The manual control's `run` and this are independent purchases with independent idempotency
     * keys; neither result should ever discard the other. A manual press does not cancel the
     * automatic batch and the automatic batch does not cancel a manual press.
     */
    autoRun: 0,
  });

  /**
   * Bumped ONCE, the first time the control is bound to a non-empty queue.
   *
   * The automatic batch cannot fire from the first render: the queue comes from the message
   * mirror, and on a cold tab the mirror is still filling, so `forSenders` is called with an empty
   * list several times before it has anything. An effect keyed only on `active` would look once,
   * find nothing and never look again — which is how this feature would ship doing nothing on
   * every real account and working on every test that pre-warms its fixture.
   *
   * One state write per session, guarded by `autoSeen`, purely to give the effect below a
   * dependency that changes when there is finally something to buy.
   */
  const [queueReady, setQueueReady] = useState(0);
  const autoSeen = useRef(false);

  /** True once the stored-suggestion hydration has SETTLED, either way. See its `finally`. */
  const [hydrateSettled, setHydrateSettled] = useState(false);

  /**
   * `toast` and `t` HELD IN A REF, so the automatic effect does not depend on their identity.
   *
   * Not a micro-optimisation — it is what makes the effect's dependency list mean something.
   * `useTranslations` returns a fresh function every render, and a parent is free to pass a fresh
   * `toast` arrow, so listing either in the deps re-runs the effect on EVERY render. The batch is
   * still safe (the latch stops a second purchase), but the cold-mirror behaviour then works by
   * accident: `queueReady` would be dead weight and the real retrigger would be the parent's
   * render churn, which is not something this module can promise.
   *
   * Measured, not assumed. With these in the deps, deleting the `setQueueReady` bump left the
   * whole suite GREEN — a guard that cannot fail is not evidence. With them in a ref, that
   * deletion goes red, which is the assertion the test claims to be making.
   */
  const notify = useRef({ toast, t });
  notify.current = { toast, t };

  const merge = useCallback(
    (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => {
      if (rows.length === 0) return;
      setSuggestions((prev) => {
        const next = new Map(prev);
        for (const r of rows) next.set(senderKey(r.address), r.suggestion);
        return next;
      });
    },
    [],
  );

  /**
   * Read what has ALREADY been bought.
   *
   * Once per session, when the Screener is first opened, and never again: this is what makes a
   * suggestion survive a reload. Without it the chips would live only as long as the tab that
   * bought them, and the user's next press would re-ask the server for answers it is already
   * holding — free to them (a stored answer is served, not re-bought) but silent, so it would
   * look like the purchase had failed.
   *
   * ONE page. The server's queue is `date desc` and so is the list on screen, so a page covers
   * the front of both. A backlogged mailbox has more senders than this, and the ones past the
   * window simply have no chip until they are bought or scrolled to; paging the whole backlog
   * on every visit would be hundreds of rows of subject and snippet fetched to decorate rows
   * nobody is looking at.
   */
  useEffect(() => {
    if (!active || io.current.hydrated || !apiConfigured()) return;
    io.current.hydrated = true;
    let cancelled = false;
    void (async () => {
      try {
        const page = await screenerApi.list({ limit: HYDRATE_LIMIT });
        if (cancelled) return;
        if (page.suggestable?.maxPerRequest) setMaxPerRequest(page.suggestable.maxPerRequest);
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
   * THE AUTOMATIC BATCH — one per mounted Screener, only when the account opted in.
   *
   * Everything this path is allowed to do is buy suggestions. It reaches `screenerApi.suggest`
   * and nothing else: there is no branch here that can call `POST /screener/:id`, write a rule or
   * move a message, which is what keeps the opt-in an opt-in to WORK rather than to a decision.
   * `screener-auto-suggest.test.tsx` asserts that by watching the calls, because "I did not write
   * that line" is not a property a reader can check later.
   *
   * There is no dry run in front of it, and that is the one place this path differs from the
   * manual control. The control prices first because a person is about to press a button and has
   * to see what it costs; here the cost was named when the setting was turned on, and the batch is
   * bounded by {@link AUTO_BATCH_SIZE} so the figure quoted then is the figure that applies. A dry
   * run would double the round trips to re-tell the client something it already fixed.
   */
  useEffect(() => {
    if (!active) {
      // LEAVING RE-ARMS THE BATCH, BUT NEVER THE REFUSAL. Coming back to the Screener is the
      // event the opt-in is scoped to, so the next visit may buy the next few senders; a refusal
      // is a standing condition and must not be re-tested on every visit. Two latches, one reset.
      io.current.autoFired = false;
      return;
    }
    if (!autoSuggest || !apiConfigured()) return;
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
        const res = await screenerApi.suggest(set, { idempotencyKey: newKey() });
        if (io.current.autoRun !== run) return;
        merge([
          ...res.suggestions.map((s) => ({ address: s.sender, suggestion: toSuggestion(s) })),
          ...toSkips(res.skipped),
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
        const why = messageFor(err, notify.current.t("suggest.failed"));
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
  const forSenders = (addresses: string[]): SuggestBatchControl => {
    // The automatic batch's only view of the queue. A REF write during render, which is safe —
    // it schedules nothing and changes no output — and the alternative (passing the list in as a
    // hook argument) is the cycle this function's own docblock exists to explain.
    io.current.queue = addresses;
    // One state write, the first time there is anything to buy, so the effect above gets a
    // dependency that changes when the cold mirror finally has senders in it.
    if (!autoSeen.current && addresses.length > 0) {
      autoSeen.current = true;
      setQueueReady((n) => n + 1);
    }
    // The ladder is bounded by the PURCHASE ceiling, not the per-request cap — a size larger than
    // one request is delivered as several requests, below.
    const sizes = batchSizes(addresses.length, MAX_SUGGEST_BATCH);
    const chosen = sizes.includes(size) ? size : (sizes[sizes.length - 1] ?? 0);
    // The largest size on the ladder — the default the control opens to.
    const cap = sizes[sizes.length - 1] ?? 0;

    /**
     * ONE request carries at most this many senders — the LOWER of the latency budget
     * ({@link SUGGEST_CHUNK_SIZE}) and the server's per-request cap ({@link maxPerRequest},
     * {@link ASSUMED_MAX_PER_REQUEST} until that read lands). The cap is only the 413 boundary; the
     * budget is what actually fits one serverless invocation, and it is the smaller of the two in
     * production — a request the size of the cap would classify past the invocation's deadline and
     * return nothing (the frozen "0 of N" this split exists to prevent). A price or a purchase
     * larger than this is split into chunks of at most this size; `chunksOf` is that split, always
     * in the queue's own order so a chunk is a contiguous prefix-slice and the same press twice
     * covers the same senders.
     */
    const chunkSize = Math.max(1, Math.min(maxPerRequest, SUGGEST_CHUNK_SIZE));
    const chunksOf = (set: string[]): string[][] => {
      const out: string[][] = [];
      for (let i = 0; i < set.length; i += chunkSize) out.push(set.slice(i, i + chunkSize));
      return out;
    };

    /**
     * Price `n` senders on the SERVER. No model, no debit, nothing stored.
     *
     * The set is priced in REQUEST-SIZED chunks and the quotes are SUMMED — the same chunks the
     * purchase will use, so the number on screen is the exact ceiling the purchase honours.
     * Consent is to the sum, not to a first chunk that happened to fit one request. Every chunk
     * checks the press counter on arrival, so a size changed mid-flight discards the whole
     * half-summed price rather than painting it under the new label.
     */
    const price = (n: number) => {
      const set = addresses.slice(0, n);
      if (set.length === 0) {
        setPhase("ready");
        setQuote({ senders: 0, credits: 0 });
        setNotice(t("suggest.nothing"));
        return;
      }
      // Captured ONCE. Never re-bumped inside the loop — a per-chunk bump would make each chunk
      // invalidate the next one's check (the SCR-SUGGEST-FLAKE shape, inside one price).
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
            res = await screenerApi.suggest(chunk, { dryRun: true });
          } catch (err) {
            if (io.current.run !== run) return;
            setPhase("ready");
            setQuote(null);
            // The server's own sentence. Every refusal on this path — no classifier
            // connected, AI switched off, no credits — already has a true one, and a second
            // taxonomy here is how a user gets told the wrong reason.
            setNotice(messageFor(err, t("suggest.failed")));
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
        setNotice(senders === 0 ? t("suggest.nothing") : null);
      })();
    };

    return {
      available: addresses.length,
      sizes,
      size: chosen,
      phase,
      quote,
      notice,
      progress,
      open: () => {
        const start = sizes.includes(size) ? size : cap;
        setSize(start);
        price(start);
      },
      choose: (n: number) => {
        setSize(n);
        price(n);
      },
      cancel: () => {
        io.current.run++;
        setPhase("closed");
        setQuote(null);
        setNotice(null);
        setProgress(null);
      },
      /**
       * Buy the chosen set — in REQUEST-SIZED chunks, halting on the first that stops or fails.
       *
       * The whole set was priced above (the sum of the chunk quotes), so consent is to the whole
       * and the money rules are these, in order:
       *
       *  - ONE idempotency key PER CHUNK. Each chunk is its own purchase: a retry of a lost chunk
       *    replays THAT chunk's answer, and a re-press after a mid-run failure re-buys only the
       *    chunks that never landed — the ones that did answer `duplicate` server-side and cost 0.
       *    A single key shared across chunks would make chunk 2 replay chunk 1's response.
       *  - `run` is captured ONCE, here, and every chunk checks it against `io.current.run` on
       *    arrival. A second press (cancel, or a re-price) bumps the counter and the in-flight loop
       *    aborts, painting nothing. It is NEVER re-bumped inside the loop — that would make each
       *    chunk invalidate the next one's check, which is the SCR-SUGGEST-FLAKE self-cancellation
       *    moved inside a single purchase.
       *  - Chips land INCREMENTALLY, per chunk, and the notice ticks "X of Y bought". A chunk that
       *    stops (the gate ran out part-way) or throws HALTS the loop: what earlier chunks bought
       *    stays on record, the summary names what actually charged, and spend never exceeds the
       *    sum that was quoted.
       */
      confirm: () => {
        const set = addresses.slice(0, chosen);
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
          for (const chunk of chunksOf(set)) {
            let res;
            try {
              res = await screenerApi.suggest(chunk, { idempotencyKey: newKey() });
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
              const why = messageFor(err, t("suggest.failed"));
              if (gotSuggestions.length > 0) {
                setNotice(t("suggest.stoppedAt", { done: gotSuggestions.length, total, reason: why }));
                toast(summarize({ suggestions: gotSuggestions, charged, skipped: gotSkipped }, t));
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
            ]);
            gotSuggestions.push(...res.suggestions);
            gotSkipped.push(...res.skipped);
            charged += res.charged;
            stopped ??= res.stopped;
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
          toast(summarize(
            { suggestions: gotSuggestions, charged, ...(stopped ? { stopped } : {}), skipped: gotSkipped },
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
          const res = await screenerApi.suggest(set, { dryRun: true });
          if (io.current.optInRun !== run) return;
          // NO PRICE, NO CONSENT — the same rule the manual control states, and it has to be
          // restated here rather than shared because this is the flow that authorises EVERY
          // later batch rather than one. A server too old to carry `quotedCredits` leaves the
          // cost unknown, and the confirm stays disabled because `quote` is null. Multiplying
          // the count by an assumed `AI_ACTION_COST` is the guess the field exists to remove.
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
          setOptIn({ phase: "ready", quote: null, notice: messageFor(err, t("suggest.failed")) });
        }
      })();
    };

    return {
      supported: apiConfigured(),
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
  return { suggestions, absorb: merge, forSenders, autoOptIn };
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
 * The server's answer, as a destination — or as the absence of one.
 *
 * `no` is `screened` and not `spam`: a screened-out sender's mail goes to `ohmail/Screened`
 * and stays reversible, which is what the endpoint does. Reading a low-confidence "no" as
 * spam would quarantine a stranger on the model's word.
 *
 * SWITCHED, not a ternary. This was `decision === "yes" ? "ohbox" : "screened"`, which is the
 * shape that turns a new wire value into a silent DECLINE — every `hold` the server started
 * sending would have filed the sender to `ohmail/Screened` with no line of code changed and no
 * test to notice. An exhaustive switch makes the server's third answer a compile error here
 * instead.
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
    skipped: Array<{ reason: string }>;
  },
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  // The "N senders held back from the model" clause was here, counting `withheld` skips. Both the
  // reason and its sentence are gone with the AI-OPEN ruling; a run can no longer hold anything
  // back on the strength of what the mail looks like, so there is no count to state.
  const parts = [
    t("suggest.doneCount", { count: res.suggestions.length, credits: res.charged }),
    res.stopped === "out_of_credits" ? t("suggest.stoppedCredits") : null,
    res.stopped === "spend_unavailable" ? t("suggest.stoppedUnavailable") : null,
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * The sentence to show for a refusal.
 *
 * An {@link ApiError} already carries the SERVICE's own message — "this deployment has no AI
 * classifier connected", "managed AI is switched off for this account", "no AI actions remain
 * on this account" — and each of those is a different, actionable fact written by the code
 * that made the decision. Re-deriving them from status codes here is how a user with an empty
 * balance is told the model is down. Anything that is not an `ApiError` is a bug in this
 * client, and there is nothing true to say about it.
 */
function messageFor(err: unknown, fallback: string): string {
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
