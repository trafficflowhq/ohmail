"use client";

/**
 * THE OBSERVATIONS the ladder in `mail-state.ts` judges, made ONCE.
 *
 * `mail-state.ts` is pure: numbers in, a state out. This file is the impure half — it samples
 * the mirror, holds the clock, and reads `GET /mailboxes` through an injected probe — and it
 * publishes ONE answer to every surface that has something to say about a sync.
 *
 * ── WHY IT RUNS ONCE AND ARRIVES BY CONTEXT ─────────────────────────────────────────────
 *
 * The growth sampler is STATEFUL. Two consumers each running their own would eventually
 * disagree about whether the mirror is growing, and a disagreement between two surfaces about
 * the same fact is the original bug with extra steps. So it is folded here, once.
 *
 * Three surfaces consume it: the shell's strip (`SyncBar`), the Ohbox's empty pane, and the
 * Settings → Mailboxes rows. The third is why it cannot be a prop: `MailboxSection` is
 * injected into `AppShell` as an opaque `ReactNode` by `(product)/mailbox/CloudShell.tsx` and
 * rendered two levels down inside `SettingsView`, so there is no prop path from the shell to
 * it at all. `useSyncStatus`'s header makes the same argument for the same reason.
 *
 * `useMailState()` THROWS without a provider rather than returning a resting value. A default
 * would make a forgotten provider render a permanently silent strip — which is exactly the
 * failure this strip was built for: the sentence exists, the wiring does not, and nothing
 * anywhere says so.
 *
 * ── WHY THE MAILBOX FACTS ARRIVE AS A FUNCTION ──────────────────────────────────────────
 *
 * Same seam as `resolveOwner`, and it has to be: `apps/webapp/app/shell/**` is published to
 * the Desktop mirror and `scripts/publish-desktop.mjs` DENYs `apps/webapp/app/api-client`, so
 * this shared shell may not import `GET /mailboxes`. The Cloud client supplies a probe; the
 * Desktop and the demo supply nothing.
 *
 * **A PROBE THAT REJECTS IS NOT AN EMPTY ACCOUNT.** `facts` starts `null` — "we cannot see" —
 * and a rejection LEAVES IT ALONE rather than writing `[]`. Mapping a 503 to `[]` would render
 * "No mailbox connected" to somebody who has five, which is a worse lie than the one this
 * slice is fixing. The probe is therefore contracted to REJECT on failure; it must not
 * helpfully return an empty array.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDemoMode, useEngine, useFreshness, useSyncStatus } from "./engine";
import { SYNC_FAILURE_STREAK } from "./sync-scheduler";
import {
  deriveMailState,
  growthStep,
  seedGrowth,
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
export type MailboxProbe = () => Promise<MailboxFacts[]>;

/** The ladder's freshness input — the Freshness Contract's verdict. See `MailStateInputs`. */
export type FreshnessFacts = MailStateInputs["freshness"];

/**
 * THE DESKTOP'S FRESHNESS SOURCE — `GET /mirror/freshness` over the bridge, narrowed.
 *
 * Supplied by the desktop client only, and it OVERRIDES the engine's own answer when present,
 * for the one reason the route exists: the desktop's window engine drains the SIDECAR's local
 * feed and is always "current" relative to it, so its own stamp can never say the desktop is
 * behind the hosted account. The sidecar's stamp can, and this is how it reaches the strip.
 *
 * MUST REJECT on failure (the `MailboxProbe` contract, for the freshness direction): the
 * provider keeps the LAST answer it saw, because a stale claim may only be withdrawn by
 * evidence of currency — a dead bridge mapped to "current" would silently unlabel a mirror
 * that is days old, which is the exact lie the label exists to end.
 */
export type FreshnessProbe = () => Promise<FreshnessFacts>;

/**
 * How often the strip's own clock beats, while a state's copy depends on elapsed time.
 *
 * A healthy tab publishes an IDENTICAL `SyncStatus` every eight seconds and `engine.tsx`
 * deliberately bails out of re-rendering for it — so without a clock of its own, "syncing"
 * would still be on screen an hour after the import finished, and the minutes in `awaiting`
 * would be frozen at whatever they were when the mirror last moved. Five seconds, so the
 * handover out of `importing` is not visibly late; no network, so it costs a render and
 * nothing else.
 *
 * Armed ONLY while `MailState.clock` is true. A quiet mailbox holds no timer.
 */
export const MAIL_CLOCK_MS = 5_000;

/**
 * How often the mailbox facts are re-read.
 *
 * Thirty seconds, visibility-gated, and it keeps running while everything looks healthy — that
 * is not an oversight. `blocked` and `mailboxError` are precisely the states that appear
 * UNDERNEATH a populated, healthy-looking mirror (`dto/types.ts` says so at the column), so a
 * poll that backed off once things looked fine would go quiet exactly when it was needed. It is
 * a read, and reads stay open deliberately — refusing one costs the same serverless invocation
 * as serving it, so gating reads takes nothing off a hostile poller; 120 requests an hour per
 * visible tab sits inside the ~450 `/sync` budget `sync-scheduler.ts` already argued for.
 *
 * A hidden tab reads nothing at all, the same rule `/sync` follows: nobody is looking, so there
 * is no revenue behind the cost.
 */
export const FACTS_POLL_MS = 30_000;

interface MailStateBinding {
  state: MailState;
  /**
   * THE FACTS THEMSELVES, not only the sentence derived from them.
   *
   * Compose's From selector and the reply's From line need the account's mailboxes — their
   * ids, their addresses and whether each can still send — which is a different question from
   * "what should the strip say", and one `MailState` deliberately cannot answer. They are
   * published from here rather than polled a second time because this provider is already
   * reading `GET /mailboxes` every 30 s, and two pollers is two answers.
   *
   * `null` keeps its meaning exactly: **we cannot see mailboxes**, which is the Desktop, the
   * demo, and a Cloud tab whose first poll has not landed. It is NOT "there are none". The
   * From surfaces render nothing rather than guess when it is null — see `compose-from.ts`.
   */
  mailboxes: MailboxFacts[] | null;
  /**
   * MESSAGES IN THE MIRROR — every folder, every mailbox — published as the fact it is.
   *
   * NOT `state.count`, and the difference is load-bearing rather than stylistic. `MailState.count`
   * is carried by the states that have a use for it and left at `0` by the rest (`stopped`,
   * `failing`, `blocked`, `mailboxError`, `noMailbox`, `awaiting`, `filing`), so a surface that
   * read the mirror's size from the derived state would report an empty device for the whole of
   * an outage. This is the input the provider was handed, unconditioned by which sentence the
   * ladder chose.
   *
   * Its one consumer is the Mailboxes pane's holdings line, through {@link deviceHoldings} —
   * which is also the strip's own denominator, so the two cannot disagree.
   */
  mirrored: number;
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
   * FOLD EVERY OBSERVATION OF THE MIRROR'S SIZE IN.
   *
   * In an effect rather than during render, so the reducer is called once per committed count
   * rather than once per render attempt — `growthStep` records a TIME, and a double-invoked
   * render (StrictMode) recording two rises for one arrival would let a single message satisfy
   * the two-rise rule.
   *
   * ── WHILE THE FIRST DRAIN IS STILL LANDING, THE MIRROR IS BEING READ, NOT GROWING ────────
   *
   * `seedGrowth`'s own note assumes the sampler is seeded from the SETTLED count — "a tab that
   * opens onto a settled mailbox starts at 495 rather than at 0". In production it was not: the
   * live engine is constructed with an EMPTY in-memory mirror and the shell renders before the
   * device's copy has been read out of IndexedDB, so the seed captured 0. Hydration then arrived
   * as one jump from 0 to the whole persisted count — read by `growthStep` as the first rise of a
   * first import (`runStartCount === 0`) — and a single ordinary message within the run window
   * latched the "Syncing your mail. N messages" episode over a mailbox whose import finished long
   * ago. The count shown was the size of the whole mirror, not import progress.
   *
   * So while `bootstrapping` is true — hydration, then this tab's first drain — every observation
   * RE-BASELINES the sampler instead of folding a rise. The initial load establishes the baseline;
   * it is not growth. A genuine first import is still announced: `deriveMailState`'s import FLOOR
   * reads the server's own `initialImportCompletedAt`, which a growth-only reading cannot, and it
   * speaks for as long as that stamp is null and the import is still plausible — absolutely for the
   * first day after a connect, and past that only while this tab cannot show otherwise (see
   * `importFloorSpeaks`; an unbounded floor held a permanent false "Syncing" over a finished
   * mailbox whose worker never reported a drained cycle). Once the first drain settles, live arrivals are
   * measured from the count actually on the device, so the hydration jump can no longer be mistaken
   * for an import.
   */
  useEffect(() => {
    setGrowth((prev) =>
      sync.bootstrapping ? seedGrowth(mirrored) : growthStep(prev, mirrored, Date.now()),
    );
    // The clock is re-read whenever the mirror moves, not only on the interval — otherwise a
    // rise arriving during a quiet spell would be judged against a `beat` minutes old.
    setBeat(Date.now());
  }, [mirrored, sync.bootstrapping]);

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
        growth,
        now: beat,
        demo,
      }),
    [sync, freshness, engineFreshness, facts, mirrored, growth, beat, demo],
  );

  // The clock, armed only while something on screen depends on elapsed time.
  useEffect(() => {
    if (!state.clock) return;
    const id = setInterval(() => setBeat(Date.now()), MAIL_CLOCK_MS);
    return () => clearInterval(id);
  }, [state.clock]);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const read = useCallback(async (): Promise<void> => {
    if (!probe) return;
    try {
      const got = await probe();
      if (alive.current) setFacts(got);
    } catch {
      // NOT `setFacts([])`. A refusal or a dead network is "we still cannot see", which is what
      // `facts` already says — and if we DID see mailboxes a moment ago, the last thing we knew
      // is a better answer than a fabricated empty account. A signed-out tab is the shell's own
      // `SessionScreen`'s business, not this strip's.
    }
  }, [probe]);

  const readFreshness = useCallback(async (): Promise<void> => {
    if (!freshnessProbe) return;
    try {
      const got = await freshnessProbe();
      if (alive.current) setProbedFreshness(got);
    } catch {
      // KEEP THE LAST ANSWER. A stale claim may only be withdrawn by evidence of currency; a
      // dead bridge mapped to anything else would either unlabel a days-old mirror (mapped
      // current) or label a current one (mapped stale). The last thing the sidecar said is the
      // best thing known.
    }
  }, [freshnessProbe]);

  /**
   * The freshness poll, desktop only. Two cadences, one reason: while the last answer was
   * `stale` the label is ON SCREEN and must clear promptly when the sidecar's pull settles, so
   * the re-ask rides the same five-second beat the strip's own clock does; at rest it drops to
   * the facts poll's cadence. Both are one call down a local pipe — no network, no server cost.
   */
  useEffect(() => {
    if (!freshnessProbe) return;
    void readFreshness();
    const cadence = probedFreshness?.state === "stale" ? MAIL_CLOCK_MS : FACTS_POLL_MS;
    const id = setInterval(() => void readFreshness(), cadence);
    return () => clearInterval(id);
  }, [freshnessProbe, readFreshness, probedFreshness?.state]);

  /**
   * A DIFFERENT ENGINE IS A DIFFERENT MAILBOX (the `EngineProvider` adoption rule), so the held
   * probe answer is withdrawn with it — kept-last is the right failure mode WITHIN one mirror's
   * life and the wrong one across a door switch: a stale Cloud verdict surviving onto another
   * engine would label content it was never about, and the label may only ever be a statement
   * about the mirror on screen. Back to `unknown` (no label, panes keep their own evidence)
   * until the new door's probe answers. Keyed on the probe too, so a probe that disappears
   * (Cloud → local door, where none is passed) drops the old answer rather than freezing it.
   */
  const probeEngine = useEngine();
  useEffect(() => {
    setProbedFreshness(null);
  }, [probeEngine, freshnessProbe]);

  useEffect(() => {
    if (!probe) {
      setFacts(null);
      return;
    }
    void read();
  }, [probe, read]);

  useEffect(() => {
    if (!probe) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void read();
    }, FACTS_POLL_MS);
    return () => clearInterval(id);
  }, [probe, read]);

  const binding = useMemo<MailStateBinding>(
    () => ({ state, mailboxes: facts, mirrored, refresh: () => void read() }),
    [state, facts, mirrored, read],
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
 * The mailbox facts for a surface that can be mounted OUTSIDE the shell — and the ONE reason
 * this is allowed to be the non-throwing sibling of {@link useMailState}.
 *
 * `InlineReply` renders inside `MessagePane`, and `MessagePane` is mounted with no provider in
 * more than one harness (`test/mail-send-states.test.ts` renders the editor alone; `action-bar.
 * test.ts` says so at the assertion). It is also published to the Desktop mirror. A throw there
 * would take an editor down over a decoration.
 *
 * The objection to a non-throwing accessor is real and is answered structurally rather than by
 * promise: a missing provider must never let the app SUBSTITUTE a sender without saying so. It
 * cannot. `AppShell` renders `MailStateProvider` above `ShellInner` unconditionally, and it is
 * `ShellInner` — through the THROWING binding — that decides whether a reply carries a
 * substitute `mailboxId`. So there is no arrangement in which the wire substitutes and this
 * line stays quiet: either both see the facts, or neither does and nothing is substituted.
 *
 * `null` therefore keeps exactly one meaning at every call site: **we cannot see this account's
 * mailboxes**. The only thing a caller may do with it is render nothing.
 */
export function useMailboxFacts(): MailboxFacts[] | null {
  return useContext(MailStateContext)?.mailboxes ?? null;
}
