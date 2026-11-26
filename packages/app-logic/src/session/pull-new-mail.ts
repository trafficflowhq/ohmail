"use client";

/**
 * "Pull new mail" — the one button that makes the WORKER look at the mail server now. Every
 * self-driven sync asks the CLOUD for changes the worker already mirrored; none can make the worker
 * scan IMAP sooner, so a person just told "I sent it" had nothing to press (measured 2026-08-26:
 * p50 194 s, p90 431 s arrival→mirror). The button rings `POST /sync/pull`
 * (`mailboxes.sync_requested_at`) and the worker's ~3 s kick scan serves those mailboxes out of
 * turn. The ring goes through the ENGINE and the gate reads the ENGINE, not the api-client, whose
 * `apiConfigured()` disagreed with the press on both doors: {@link OhmailEngine.pullAvailable}
 * decides, and the settle read is the injected {@link MailboxProbe}, the sync strip's own seam.
 *
 * Moved from the web shell (`PullNewMail.tsx`) so the rail's foot on the mail ground and today's shell
 * press the one binding. What the shell read of itself, the report of an outcome and the `sync`
 * namespace's sentences, is handed in by whoever binds it.
 */

/**
 * The honest settle, per mailbox and on one clock: the spinner ends when the SCAN has demonstrably
 * happened, not when the POST returns. The route answers each mailbox's own effective request
 * instant and the worker stamps `last_sync_at` with the DATABASE's clock — this hook polls the
 * probe (2 s cadence, 30 s cap) until every mailbox's `lastSyncAt` moves past its own baseline; no
 * wall clock enters the comparison. The ring is transport-bounded (`PULL_RING_TIMEOUT_MS`); the
 * 30 s cap settles a down worker without a lie — the request is stamped durably and will be
 * honoured, the spinner just stops claiming to watch.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useDemoMode, useEngine } from "../engine/context.js";
import { mailboxErrorNeedsAction, serverUnreachable } from "../mail-state/mail-state.js";
import type { MailboxProbe } from "../mail-state/mail-state-binding.js";

const SETTLE_POLL_MS = 2_000;
const SETTLE_CAP_MS = 30_000;
/**
 * How long the gesture will wait on any one post-scan drain before releasing the UI unjudged.
 * `HttpAdapter.sync()` carries no deadline (a drain is the engine's business and may run long), so
 * an awaited drain here would put an unbounded wait inside a gesture whose cap promises 30 s — a
 * half-open `/sync` would hold `pulling` and the single-flight latch for the tab's lifetime, and
 * every later click would be silently refused. The race bounds the WAIT, never the drain: a drain
 * outliving the cap keeps running in the engine and lands its pages whenever it lands them; the
 * gesture just stops claiming to watch, and makes no quiet claim it could not verify.
 */
const DRAIN_JUDGE_CAP_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait on one drain, bounded. `"ok"` is a drain that COMPLETED SUCCESSFULLY within the cap;
 * `"failed"` completed by rejecting; `"timeout"` is still running — the caller releases the UI
 * and claims nothing.
 */
async function boundedDrain(engine: { syncOnce(): Promise<void> }): Promise<"ok" | "failed" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), DRAIN_JUDGE_CAP_MS);
  });
  try {
    return await Promise.race([
      engine.syncOnce().then(
        () => "ok" as const,
        () => "failed" as const,
      ),
      cap,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const PULL_KEY = "p";

export interface PullBinding {
  available: boolean;
  pulling: boolean;
  pull: () => void;
  result?: { key: string; mailboxId?: string };
}

/**
 * THE ONE BINDING, HANDED: what binds it (the mail ground, once a frame) provides it here, and every part that draws a
 * pull reads it (the rail's foot, a list under a finger, a place's menu), so a finger, a menu and `p` are one flight.
 * Null where nothing binds one.
 */
export const PullContext = createContext<PullBinding | null>(null);

/** The handed binding where it can pull now, else null: a part offers no pull then. */
export function usePull(): PullBinding | null {
  const binding = useContext(PullContext);
  return binding !== null && binding.available ? binding : null;
}

type Engine = ReturnType<typeof useEngine>;

/** Watch every rung mailbox's own scan, bounded by the cap. */
async function watchScan(
  probe: MailboxProbe,
  rang: NonNullable<Awaited<ReturnType<Engine["requestPull"]>>>,
  alive: { readonly current: boolean },
): Promise<{ settled: boolean; failedMailbox?: string }> {
  /** Did the watch see every mailbox's own scan, or did the cap end it? */
  let settled = false;
  let failedMailbox: string | undefined;
  // id → this mailbox's OWN baseline (DB-clock ms). Compared only against `lastSyncAt`,
  // which the worker writes with the same database clock.
  const baselines = new Map(rang.mailboxes.map((m) => [m.id, Date.parse(m.requestedAt)]));
  const deadline = Date.now() + SETTLE_CAP_MS;
  while (alive.current && Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    try {
      const facts = await probe();
      const rung = facts.filter((m) => baselines.has(m.id));
      settled = rung.every(
        (m) => m.lastSyncAt !== null && Date.parse(m.lastSyncAt) >= (baselines.get(m.id) ?? Infinity),
      );
      if (settled) break;
      // A scan that cannot reach the server will not happen: say so rather than wait.
      failedMailbox = rung.find(
        (m) => serverUnreachable(m) || (m.status === "error" && mailboxErrorNeedsAction(m)),
      )?.id;
      if (failedMailbox) break;
    } catch {
      // A failed poll is "we cannot see yet" — keep waiting; the cap settles us.
    }
  }
  return { settled, failedMailbox };
}

/** One press, end to end: the ring, the watch, the judgment, and the one sentence a person needs. */
async function pullOnce(
  engine: Engine,
  probe: MailboxProbe | undefined,
  alive: { readonly current: boolean },
): Promise<PullBinding["result"]> {
  // What the mirror held at the press — the "nothing new" judgment's left-hand side.
  const before = new Set(
    engine
      .read()
      .entries("message")
      .map((e) => e.id),
  );
  // Ring first (never throws, transport-bounded — see `OhmailEngine.requestPull`), then
  // drain what the worker already holds so the press feels answered immediately.
  const rang = await engine.requestPull();
  void engine.syncOnce().catch(() => undefined);
  // The server says it is not fetching: the request is stamped and nothing will scan it
  // until fetching runs again, so there is nothing to watch. Say so now.
  if (rang?.fetching?.behind === true) {
    return { key: "pullPaused" };
  }
  const watched = rang !== null && rang.mailboxes.length > 0 && probe !== undefined;
  const { settled, failedMailbox } = watched
    ? await watchScan(probe, rang, alive)
    : { settled: false, failedMailbox: undefined };
  if (failedMailbox) return { key: "pullMailboxFailed", mailboxId: failedMailbox };
  if (!rang) return { key: "pullPaused" };
  /**
   * The judgment drain — bounded, FRESH, and success-gated. Two awaits, not one, because
   * `syncOnce()` is single-flight: the first flushes whatever drain is already running —
   * possibly the press-time drain, whose pages may have been read BEFORE the worker committed
   * the scan's arrivals — and only a drain that STARTED after the scan was observed can prove
   * the mirror quiet; the second await is that drain. Each wait is bounded
   * (`DRAIN_JUDGE_CAP_MS`), and the quiet sentence is spoken only when the fresh drain
   * completed successfully — a failed or still-running drain proves nothing, so it says
   * nothing.
   */
  let judged = false;
  const flushed = await boundedDrain(engine);
  if (flushed !== "timeout") judged = (await boundedDrain(engine)) === "ok";
  if (!watched || !judged) return undefined;
  const arrived = engine
    .read()
    .entries("message")
    .some((entry) => !before.has(entry.id));
  return arrived ? undefined : { key: settled ? "pullCurrent" : "pullPending" };
}

/** The rail, list menu and touch gesture share one request and its result. */
export function usePullNewMail(probe: MailboxProbe | undefined): PullBinding {
  const engine = useEngine();
  const demo = useDemoMode();
  const [pulling, setPulling] = useState(false);
  const [result, setResult] = useState<PullBinding["result"]>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), result.mailboxId ? 15_000 : 5_000);
    return () => clearTimeout(timer);
  }, [result]);
  const inFlight = useRef(false);

  const pull = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setResult(undefined);
    setPulling(true);
    void (async () => {
      try {
        const next = await pullOnce(engine, probe, alive);
        if (alive.current) setResult(next);
      } finally {
        inFlight.current = false;
        if (alive.current) setPulling(false);
      }
    })();
  }, [engine, probe]);

  return { available: !demo && engine.pullAvailable(), pulling, pull, result };
}
