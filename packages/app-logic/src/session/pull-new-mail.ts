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

/**
 * The outcome is said once, and only where the mail cannot say it: new rows need no sentence. The
 * quiet scan speaks ("Checked — nothing new.", pullQuiet), the capped watch speaks (pullSlow), and
 * a rung mailbox whose server cannot be reached ends the watch with pullUnreachable, because no
 * scan can happen; a ring whose answer says the server is not fetching new mail at all
 * (`fetching.behind`) starts no watch and says so at once (pullBehind, naming who is not checking),
 * because no scan will come and the waiting line would be false for as long as that lasts;
 * a refused ring says nothing — the sync strip owns failure sentences. "Nothing new" is judged against the MIRROR — ids before the press versus
 * after a fresh, successful post-scan drain; a new id in ANY pile counts as arrival and silences
 * the toast. One flight, two placements: the HOOK is called once and both placements share the
 * binding — two hooks would each carry their own `pulling`, and a resize mid-pull would reveal an
 * idle copy accepting a second POST.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useManagedService } from "../doors/managed-service.js";
import { useDemoMode, useEngine } from "../engine/context.js";
import { serverUnreachable } from "../mail-state/mail-state.js";
import type { MailboxProbe } from "../mail-state/mail-state-binding.js";
import type { ToastFn } from "../press/report.js";

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

export interface PullBinding {
  available: boolean;
  pulling: boolean;
  pull: () => void;
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

/** The `sync` namespace's sentences, as the binder reads them. */
export type PullWords = (key: string) => string;

type Engine = ReturnType<typeof useEngine>;

/** What one press says its outcome with: the report, the words, and who checks the mailboxes behind it. */
interface PullSays {
  readonly toast: ToastFn;
  readonly t: PullWords;
  /** Who checks the mailboxes behind this frame: ohmail Cloud only on the managed service. */
  readonly managed: boolean;
}

/** Watch every rung mailbox's own scan, bounded by the cap. */
async function watchScan(
  probe: MailboxProbe,
  rang: NonNullable<Awaited<ReturnType<Engine["requestPull"]>>>,
  alive: { readonly current: boolean },
): Promise<{ settled: boolean; unreachable: boolean }> {
  /** Did the watch see every mailbox's own scan, or did the cap end it? */
  let settled = false;
  /** Did a rung mailbox's server turn out unreachable? Then nothing could be checked. */
  let unreachable = false;
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
      unreachable = rung.some(serverUnreachable);
      if (unreachable) break;
    } catch {
      // A failed poll is "we cannot see yet" — keep waiting; the cap settles us.
    }
  }
  return { settled, unreachable };
}

/** One press, end to end: the ring, the watch, the judgment, and the one sentence a person needs. */
async function pullOnce(
  engine: Engine,
  probe: MailboxProbe | undefined,
  say: PullSays,
  alive: { readonly current: boolean },
): Promise<void> {
  const { toast, t, managed } = say;
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
    if (alive.current) toast(t(managed ? "pullBehind" : "pullBehindServer"));
    return;
  }
  const watched = rang !== null && rang.mailboxes.length > 0 && probe !== undefined;
  const { settled, unreachable } = watched
    ? await watchScan(probe, rang, alive)
    : { settled: false, unreachable: false };
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
  if (rang) {
    const flushed = await boundedDrain(engine);
    if (flushed !== "timeout") {
      judged = (await boundedDrain(engine)) === "ok";
    }
  }
  if (watched && unreachable && alive.current) {
    toast(t("pullUnreachable"));
  } else if (watched && judged && alive.current) {
    const arrived = engine
      .read()
      .entries("message")
      .some((e) => !before.has(e.id));
    // New mail is its own feedback; only the outcomes the mail cannot show get a sentence.
    if (!arrived) toast(settled ? t("pullQuiet") : t("pullSlow"));
  }
}

/**
 * The one binding of Pull new mail. `probe`: the mailbox facts the settle watch reads (the sync strip's own seam);
 * `toast`: where an outcome is said; `t`: the `sync` namespace's sentences. Single flight: a press while one is out
 * does nothing.
 */
export function usePullNewMail(probe: MailboxProbe | undefined, toast: ToastFn, t: PullWords): PullBinding {
  const engine = useEngine();
  const demo = useDemoMode();
  /* Who checks the mailboxes behind this shell: ohmail Cloud only on the managed service. */
  const managed = useManagedService();
  const [pulling, setPulling] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  // Single-flight per tab without stale-closure re-arms: the ref is the latch, state is the paint.
  const inFlight = useRef(false);

  const pull = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPulling(true);
    void (async () => {
      try {
        await pullOnce(engine, probe, { toast, t, managed }, alive);
      } finally {
        inFlight.current = false;
        if (alive.current) setPulling(false);
      }
    })();
  }, [engine, probe, toast, t, managed]);

  return { available: !demo && engine.pullAvailable(), pulling, pull };
}
