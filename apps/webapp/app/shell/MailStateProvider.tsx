"use client";

/**
 * The observations the ladder in `mail-state.ts` judges, made once — the impure half: it samples the mirror,
 * holds the clock, reads `GET /mailboxes` through an injected probe, and publishes ONE answer. The growth
 * sampler is stateful, so two consumers running their own would disagree; it is folded here. Context, not
 * props: `MailboxSection` is injected as an opaque node with no prop path from the shell. `useMailState()`
 * THROWS without a provider — a resting default would make a forgotten provider a permanently silent strip. The
 * facts arrive as a FUNCTION (the publish script denies `api-client` to this shared shell); a probe that
 * rejects is NOT an empty account: `facts` starts `null` ("we cannot see") and a rejection leaves it alone —
 * mapping a 503 to `[]` would render "No mailbox connected" to somebody who has five.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDemoMode, useEngine, useFreshness, useSyncStatus } from "./engine";
import { SYNC_FAILURE_STREAK, syncMayRead } from "./sync-scheduler";
import {
  deriveMailState,
  growthStep,
  pulledCount,
  seedGrowth,
  wantsImportCounts,
  type MailboxFacts,
  type MailState,
  type MailStateInputs,
  type MirrorGrowth,
} from "./mail-state";

/**
 * `GET /mailboxes`, narrowed to {@link MailboxFacts}. Supplied by the Cloud client only.
 *
 * MUST REJECT on failure. Returning `[]` from a catch would be indistinguishable from an
 * account with no mailboxes — see the file header.
 */
export type MailboxProbe = (opts?: { counts?: boolean }) => Promise<MailboxFacts[]>;

/** The ladder's freshness input — the Freshness Contract's verdict. See `MailStateInputs`. */
export type FreshnessFacts = MailStateInputs["freshness"];

/**
 * The desktop's freshness source — `GET /mirror/freshness` over the bridge,
 * narrowed. Supplied by the desktop client only, and it OVERRIDES the
 * engine's own answer when present: the window engine drains the sidecar's
 * local feed and is always "current" relative to it, so its own stamp can
 * never say the desktop is behind the hosted account — the sidecar's stamp
 * can. Must REJECT on failure: the provider keeps the last answer it saw,
 * because a stale claim may only be withdrawn by evidence of currency — a
 * dead bridge mapped to "current" silently unlabels a days-old mirror.
 */
export type FreshnessProbe = () => Promise<FreshnessFacts>;

/**
 * How often the strip's own clock beats, while a state's copy depends on
 * elapsed time. A healthy tab publishes an identical `SyncStatus` every
 * eight seconds and `engine.tsx` bails out of re-rendering for it — without
 * a clock, "syncing" would stay on screen an hour after the import finished
 * and `awaiting`'s minutes would freeze. Five seconds, so the handover out
 * of `importing` is not visibly late; no network, so it costs a render and
 * nothing else. Armed only while `MailState.clock` is true: a quiet mailbox
 * holds no timer.
 */
/**
 * `useLayoutEffect` in a browser; `useEffect` where there is nothing to commit — `older-mail.ts`'s
 * idiom, chosen ONCE at module scope for its two reasons: hooks must be the same hook on every
 * render, and a bare `useLayoutEffect` in a server render is a `console.error` (Next pre-renders
 * client components), which the zero-console-errors rule refuses. On the server there is no
 * commit and no microtask racing a response, so the passive fallback loses nothing there; in the
 * browser the PHASE is the entire point — see the ownership ref below.
 */
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Are two answers the same answer? — the equality gate on both polls. Both parse a fresh object per
 * call, so `setFacts(got)` published a NEW IDENTITY even when byte-identical — and identity is
 * load-bearing downstream: it re-renders every consumer, and in `AppShell` it changes
 * `ownAddresses`, rebuilding the whole-mirror consent partition per poll (measurable as retained
 * memory). Generic, deliberately NOT a field list: a hand-written comparator misses the field added
 * later, two different answers compare equal, and the strip freezes silently. Both payloads are
 * plain JSON-shaped wire records — no `Date`, `Map`, `Set` or cycles cross this wire. `Object.is`
 * at the leaves, React's own bail-out behaviour.
 */
function sameWire(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => sameWire(item, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.prototype.hasOwnProperty.call(b, k)
    && sameWire((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export const MAIL_CLOCK_MS = 5_000;

/**
 * How often the mailbox facts are re-read: thirty seconds,
 * visibility-gated, and it keeps running while everything looks healthy —
 * `blocked` and `mailboxError` appear UNDERNEATH a populated mirror, so a
 * poll that backed off when things looked fine would go quiet exactly when
 * needed. Reads stay open deliberately: refusing one costs the same
 * invocation as serving it, and 120 requests/hour per visible tab sits
 * inside the ~450 `/sync` budget. A hidden tab reads nothing, the `/sync`
 * rule: nobody is looking.
 */
export const FACTS_POLL_MS = 30_000;

interface MailStateBinding {
  state: MailState;
  /**
   * The facts themselves, not only the sentence derived from them.
   * Compose's From selector and the reply's From line need the account's
   * mailboxes — ids, addresses, can-send — a question `MailState`
   * deliberately cannot answer. Published from here because this provider
   * already reads `GET /mailboxes` every 30 s, and two pollers is two
   * answers. `null` keeps its meaning exactly: we CANNOT SEE mailboxes (the
   * desktop, the demo, a first poll not landed) — never "there are none".
   * The From surfaces render nothing rather than guess (`compose-from.ts`).
   */
  mailboxes: MailboxFacts[] | null;
  /**
   * Is there a roster to see at all — the state `mailboxes: null` collapses, and the collapse cost
   * a regression. `null` means "we cannot see" for TWO reasons: no probe was given (the desktop,
   * the demo — there is no roster and never will be), or the probe has not answered (a first poll,
   * an outage). For rendering they are the same; for a WRITE GATE they are opposite — "not answered
   * yet" is a reason to refuse a delete, "no probe" is not, because on those doors the wire has
   * always been the only authority. A helper reading only `mailboxes` refused every delete on the
   * desktop and demo, naming another install — false there (measured 2026-09-06). `false` here
   * means NO PROBE: a property of the mount, stable from the first render.
   */
  rosterProbed: boolean;
  /**
   * Messages in the mirror — every folder, every mailbox — published as the fact it is. NOT
   * `state.count`, and the difference is load-bearing: `MailState.count` is carried by the states
   * that use it and left at `0` by the rest, so a surface reading the mirror's size from the
   * derived state would report an empty device for the whole of an outage. This is the input the
   * provider was handed, unconditioned by which sentence the ladder chose. Its consumer is the
   * Mailboxes pane's holdings line, through {@link deviceHoldings}. NOT the import's numerator —
   * see `pulled` below, which is what the strip and the pull stage quote.
   */
  mirrored: number;
  /**
   * HOW MUCH THE IMPORT HAS PULLED — {@link pulledCount} over the same facts the ladder judged.
   * The first-run pull stage's numerator, and the strip's; `mirrored` above answers a different
   * question ("how much is on this device") and the two diverge by the whole of a large mailbox
   * once the renderer's mirror is windowed.
   */
  pulled: number;
  /**
   * THE FRESHNESS VERDICT the ladder judged — the probed one on the desktop (the sidecar's stamp
   * against the hosted account), the engine's own everywhere else.
   *
   * Published because `unknown` is not a `MailStateKey` and therefore cannot be read off
   * {@link MailState}: the stale arm does not fire for it, so a door whose currency has never
   * been established is indistinguishable from a current one by key alone. `holdingsSpeak` is its
   * one consumer, and needs it for exactly that distinction.
   */
  freshness: FreshnessFacts;
  /** Re-read the mailbox facts now. The Settings pane calls it after a connect or a resync. */
  refresh: () => void;
}

const MailStateContext = createContext<MailStateBinding | null>(null);

export function MailStateProvider({
  probe,
  freshnessProbe,
  mirrored,
  children,
}: {
  probe?: MailboxProbe;
  /** See {@link FreshnessProbe} — the desktop's sidecar-truth override; absent everywhere else. */
  freshnessProbe?: FreshnessProbe;
  /** Messages in the MIRROR — every folder. THE progress signal, once it moves. */
  mirrored: number;
  children: ReactNode;
}) {
  const sync = useSyncStatus();
  const demo = useDemoMode();
  const engineFreshness = useFreshness();
  /* THE ENGINE ON SCREEN. Read here rather than beside the adoption effect below because the
     readers' generation guard ({@link answersFor}) needs it, and a hook must not be called after
     the callbacks that close over it. `EngineProvider`'s adoption rule — a different engine is a
     different mailbox — is what makes this identity meaningful. */
  const probeEngine = useEngine();
  const [facts, setFacts] = useState<MailboxFacts[] | null>(null);
  const [probedFreshness, setProbedFreshness] = useState<FreshnessFacts | null>(null);
  const [beat, setBeat] = useState(() => Date.now());
  const [growth, setGrowth] = useState<MirrorGrowth>(() => seedGrowth(mirrored));

  /**
   * WHICH FRESHNESS THE LADDER JUDGES. With a probe (the desktop): the probe's LAST answer, and
   * `unknown` until it first answers — never the engine's own, whose stamp tracks the local
   * sidecar feed and would unlabel a desktop that is days behind the hosted account. Without
   * one (web, mobile-shaped hosts, the demo): the engine's own verdict, live via subscription.
   */
  const freshness: FreshnessFacts = freshnessProbe
    ? (probedFreshness ?? { state: "unknown", asOf: null })
    : engineFreshness;

  /**
   * THE IMPORT'S NUMERATOR. One derivation, so the strip's sentence, the growth episode and the
   * first-run pull rate are the same number — `pull-rate.ts`'s rule. Falls back to `mirrored`
   * wherever no door answered a count, so it can never read below what is already on screen.
   */
  const pulled = pulledCount(mirrored, facts);

  /**
   * Fold every observation of the mirror's size in. In an effect, not during render: `growthStep` records a TIME, and
   * a StrictMode double-invoked render recording two rises for one arrival would let a single message satisfy the
   * two-rise rule. While the first drain is still landing, the mirror is being READ, not growing: the live engine
   * starts with an empty in-memory mirror, so the seed captured 0 and hydration arrived as one jump — read as the
   * first rise of a first import, latching "Syncing your mail. N messages" over a finished mailbox, with N the size
   * of the whole mirror. So while `bootstrapping` is true every observation RE-BASELINES the sampler; a genuine first
   * import is still announced by the import FLOOR (`initialImportCompletedAt`, bounded by `importFloorSpeaks`). Once
   * the first drain settles, arrivals are measured from the device's own count.
   */
  useEffect(() => {
    setGrowth((prev) =>
      sync.bootstrapping ? seedGrowth(pulled) : growthStep(prev, pulled, Date.now()),
    );
    // The clock is re-read whenever the mirror moves, not only on the interval — otherwise a
    // rise arriving during a quiet spell would be judged against a `beat` minutes old.
    setBeat(Date.now());
  }, [pulled, sync.bootstrapping]);

  const state = useMemo(
    () =>
      deriveMailState({
        sync,
        failureStreak: SYNC_FAILURE_STREAK,
        freshness,
        // The rendered engine's own verdict — the settled wrapper's evidence, never the probe's.
        engineFreshness,
        mailboxes: facts,
        mirrored,
        pulled,
        growth,
        now: beat,
        demo,
      }),
    [sync, freshness, engineFreshness, facts, mirrored, pulled, growth, beat, demo],
  );

  // The clock, armed only while something on screen depends on elapsed time.
  useEffect(() => {
    if (!state.clock) return;
    const id = setInterval(() => setBeat(Date.now()), MAIL_CLOCK_MS);
    return () => clearInterval(id);
  }, [state.clock]);

  /**
   * IS THIS PROVIDER STILL MOUNTED? — and the SETUP half is not decoration.
   *
   * It used to be a cleanup alone. React's StrictMode mounts every effect, tears it down and
   * mounts it again, so a development build ran the cleanup once on a component that was very
   * much still there and left this `false` for the rest of the session — after which every probe
   * answer was dropped and the strip never learned anything about the mailbox again. Restoring it
   * on setup is what makes the pair symmetric, which is the property StrictMode exists to check.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /**
   * Whose question is this? — the one identity both held answers belong to. Three things decide
   * which mailbox the provider is describing, and a change in ANY makes every answer in flight a
   * statement about something else: `probeEngine` (a different engine is a different mailbox),
   * `probe` (the source of `GET /mailboxes`; `undefined` is its own case — "we cannot ask"), and
   * `freshnessProbe` (the desktop's sidecar-truth override, which can change WITHOUT the engine on
   * a door switch). One object rather than three comparisons: everything downstream asks "is this
   * still the thing I asked for?", and three spellings of that question is how two end up
   * disagreeing.
   */
  const identity = { engine: probeEngine, probe, freshnessProbe };

  /**
   * The frame before the effect — the clear, done during RENDER. An effect is passive: React
   * commits the render that first carried the new engine and runs the effect after, so there is
   * exactly one painted frame in which the previous account's facts sit under the new mirror —
   * enough to pair this device's new count with somebody else's total. The
   * state-adjustment-during-render pattern, documented for exactly this: the render output is
   * discarded and re-run before commit, so the stale frame never exists. Terminates on the first
   * re-run (`adopted` then equals the identity) and touches only this component's own state.
   */
  const [adopted, setAdopted] = useState(identity);
  const changed =
    adopted.engine !== identity.engine
    || adopted.probe !== identity.probe
    || adopted.freshnessProbe !== identity.freshnessProbe;
  if (changed) {
    setAdopted(identity);
    setFacts(null);
    setProbedFreshness(null);
  }
  /** The identity this render is actually about — the adjusted one when it has just changed. */
  const now = changed ? identity : adopted;

  /**
   * What is on screen, for an answer coming back to compare itself against. Written in an EFFECT, never
   * during render (review, round 5): a ref is shared with the committed tree, and a render-phase write
   * publishes a value from a render React may discard — an in-flight reader for the OLD identity could
   * capture the NEW one and be waved through. And a COMMIT-PHASE effect, not a passive one (the same
   * review): a passive effect runs after the commit, so a promise settling in the gap would find the ref
   * naming the identity just left. `useLayoutEffect` runs inside the commit, so no microtask can observe
   * the gap — nothing to lay out; the phase is the reason ({@link useCommitEffect} for SSR). Declared
   * before the re-ask effect so adoption's own read sees itself.
   */
  const answering = useRef(now);
  useCommitEffect(() => { answering.current = adopted; }, [adopted]);

  /**
   * WHAT THE NEXT POLL NEEDS IN ORDER TO DECIDE `?counts=1` — the inputs, settled at commit. The
   * DECISION itself is taken at poll time by {@link wantsImportCounts}, and that split is the fix:
   * its episode arm is time-dependent, so a boolean settled when the deps last changed can only
   * ever be stale — false through the gap after the door's stamp (the counter then read backwards),
   * and, once the mirror went still and nothing re-ran the effect, true for ever, which is the
   * `count(*)` this gate exists to avoid. The inputs are the commit's; the clock is the poll's.
   */
  const countsInputs = useRef<{
    facts: readonly MailboxFacts[] | null;
    growth: MirrorGrowth;
    bootstrapping: boolean;
  }>({ facts: null, growth, bootstrapping: sync.bootstrapping });
  useEffect(() => {
    countsInputs.current = { facts, growth, bootstrapping: sync.bootstrapping };
  }, [facts, growth, sync.bootstrapping]);

  const read = useCallback(async (): Promise<void> => {
    if (!now.probe) return;
    /**
     * The second ownership test, and it asks a different question. The one below compares REACT identities — right
     * for an engine switch. It cannot see the case that costs mail: another tab signs in as somebody else, the jar is
     * rewritten, and NOTHING in this tree changes — the poll then asks `GET /mailboxes` under the new session and
     * publishes the other account's mailboxes automatically. The identity that matters is the SESSION's, held by the
     * mirror's sync gate (`syncIdentityOf`), asked before AND after the await (a request that left while the jar
     * agreed can answer after it stopped). {@link syncMayRead}, not a comparison written out here: the adapter's own
     * read rule, exported so the doors cannot drift — both still tested `contradicted` alone after the gate grew
     * `revoked`. An UNCONFIRMED gate still reads: the ordinary warm open.
     */
    if (!syncMayRead(probeEngine)) return;
    try {
      const ci = countsInputs.current;
      const got = await now.probe({
        counts: wantsImportCounts(ci.facts, ci.growth, ci.bootstrapping, Date.now()),
      });
      if (!syncMayRead(probeEngine)) return;
      /* THE OWNERSHIP TEST. `now` is this callback's OWN identity, frozen when the callback was
         made; `answering.current` is what is on screen when the answer lands. A request issued for
         the previous account resolves whenever the network says so — `alive.current` only asks
         whether the component is still mounted — and publishing it would put the old account's
         rows straight back over the clear, indistinguishable from an ordinary poll and caught by
         no timeout. */
      if (alive.current && answering.current === now) {
        setFacts((prev) => (sameWire(prev, got) ? prev : got));
      }
    } catch {
      // NOT `setFacts([])`. A refusal or a dead network is "we still cannot see", which is what
      // `facts` already says — and if we DID see mailboxes a moment ago, the last thing we knew
      // is a better answer than a fabricated empty account. A signed-out tab is the shell's own
      // `SessionScreen`'s business, not this strip's.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, probeEngine]);

  const readFreshness = useCallback(async (): Promise<void> => {
    if (!now.freshnessProbe) return;
    try {
      const got = await now.freshnessProbe();
      // {@link read}'s ownership test, for the same reason: a verdict about the door that has just
      // been left may not be published over the one now on screen.
      if (alive.current && answering.current === now) {
        setProbedFreshness((prev) => (sameWire(prev, got) ? prev : got));
      }
    } catch {
      // KEEP THE LAST ANSWER. A stale claim may only be withdrawn by evidence of currency; a
      // dead bridge mapped to anything else would either unlabel a days-old mirror (mapped
      // current) or label a current one (mapped stale). The last thing the sidecar said is the
      // best thing known.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  /**
   * The freshness poll, desktop only. Two cadences, one reason: while the last answer was
   * `stale` the label is ON SCREEN and must clear promptly when the sidecar's pull settles, so
   * the re-ask rides the same five-second beat the strip's own clock does; at rest it drops to
   * the facts poll's cadence. Both are one call down a local pipe — no network, no server cost.
   */
  useEffect(() => {
    if (!now.freshnessProbe) return;
    /* NO IMMEDIATE READ HERE, and that is a fix rather than an omission. This effect re-runs
       whenever the VERDICT changes, because the cadence depends on it — so an immediate read
       inside it made every `null → current`, `current → stale` and `stale → current` transition
       issue a second call on the spot, one per transition, for the life of the install. The first
       read belongs to the identity effect below, which is where "we have a new question" is
       expressed; this effect now owns nothing but the timer. */
    const cadence = probedFreshness?.state === "stale" ? MAIL_CLOCK_MS : FACTS_POLL_MS;
    const id = setInterval(() => void readFreshness(), cadence);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readFreshness, probedFreshness?.state]);

  /**
   * ASK AGAIN, WHENEVER THE IDENTITY CHANGES — the one effect that used to be two.
   *
   * The render-phase clear above already emptied what was held; this is the half a render may not
   * do. Without it the surfaces stay silent for a whole `FACTS_POLL_MS` after a switch, because
   * the poll below is the only other thing that asks. `null` paints first — the honest answer
   * while the question is being re-asked — and the new identity's own rows replace it.
   */
  useEffect(() => {
    if (now.probe) void read();
    // BOTH readers, because both hold an answer the clear has just discarded and both are silent
    // until something asks again. The freshness poll above owns only its timer.
    if (now.freshnessProbe) void readFreshness();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, readFreshness]);

  useEffect(() => {
    if (!now.probe) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void read();
    }, FACTS_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);

  /**
   * `refresh` reads through a ref, and the identity is the point. It was `refresh: () => void
   * read()` inline in the memo, taking a new identity every poll (the memo's deps include `facts`).
   * Harmless while consumers passed it straight down; not once a memoized handler DEPENDS on it — a
   * `useCallback` listing an unstable `refresh` is rebuilt 120 times an hour, and a memoized
   * callback rebuilt per render pins the render that made it (the retained-scope chain measured at
   * ~1 GB per idle hour). `mail-state-identity.test.tsx` holds the property. The assignment is in
   * an effect so a discarded concurrent render cannot leave the ref pointing at its `read`.
   */
  const readRef = useRef(read);
  useEffect(() => { readRef.current = read; }, [read]);
  const refresh = useCallback(() => { void readRef.current(); }, []);

  const binding = useMemo<MailStateBinding>(
    () => ({
      state, mailboxes: facts, rosterProbed: probe !== undefined, mirrored, pulled, freshness,
      refresh,
    }),
    [state, facts, probe, mirrored, pulled, freshness, refresh],
  );

  return <MailStateContext.Provider value={binding}>{children}</MailStateContext.Provider>;
}

/**
 * What to say about this mailbox, decided once. See {@link MailStateProvider} for why this
 * throws rather than returning a resting value when nothing provided it.
 */
export function useMailState(): MailStateBinding {
  const binding = useContext(MailStateContext);
  if (!binding) {
    throw new Error("useMailState must be used inside <MailStateProvider>");
  }
  return binding;
}

/**
 * The mailbox facts for a surface that can be mounted OUTSIDE the shell — the one allowed non-throwing
 * sibling of {@link useMailState}. `InlineReply` renders inside `MessagePane`, mounted with no provider
 * in several harnesses and published to the Desktop mirror; a throw would take an editor down over a
 * decoration. The objection to a non-throwing accessor is answered structurally: `AppShell` renders
 * `MailStateProvider` above `ShellInner` unconditionally, and it is `ShellInner` — through the THROWING
 * binding — that decides whether a reply carries a substitute `mailboxId`; there is no arrangement in
 * which the wire substitutes and this line stays quiet. `null` keeps one meaning: we cannot see this
 * account's mailboxes — the only thing a caller may do is render nothing.
 */
export function useMailboxFacts(): MailboxFacts[] | null {
  return useContext(MailStateContext)?.mailboxes ?? null;
}
