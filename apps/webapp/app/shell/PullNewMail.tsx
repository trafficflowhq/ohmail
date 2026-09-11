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
 * quiet scan speaks ("Checked — nothing new.", pullQuiet) and the capped watch speaks (pullSlow —
 * true whether the worker is slow or down); a refused ring says nothing — the sync strip owns
 * failure sentences. "Nothing new" is judged against the MIRROR — ids before the press versus
 * after a fresh, successful post-scan drain; a new id in ANY pile counts as arrival and silences
 * the toast. One flight, two placements (rail foot, topbar; `app.css` shows one at a time): the
 * HOOK is called once in the shell and both placements share the binding — two hooks would each
 * carry their own `pulling`, and resizing mid-pull would reveal an idle copy accepting a second POST.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon, useToast } from "@ohmail/ui";
import { useDemoMode, useEngine } from "./engine";
import type { MailboxProbe } from "./MailStateProvider";

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
  const cap = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), DRAIN_JUDGE_CAP_MS); });
  try {
    return await Promise.race([
      engine.syncOnce().then(() => "ok" as const, () => "failed" as const),
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

export function usePullNewMail(probe?: MailboxProbe): PullBinding {
  const engine = useEngine();
  const demo = useDemoMode();
  const toast = useToast();
  const t = useTranslations("sync");
  const [pulling, setPulling] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // Single-flight per tab without stale-closure re-arms: the ref is the latch, state is the paint.
  const inFlight = useRef(false);

  const pull = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPulling(true);
    void (async () => {
      try {
        // What the mirror held at the press — the "nothing new" judgment's left-hand side.
        const before = new Set(engine.read().entries("message").map((e) => e.id));
        // Ring first (never throws, transport-bounded — see `OhmailEngine.requestPull`), then
        // drain what the worker already holds so the press feels answered immediately.
        const rang = await engine.requestPull();
        void engine.syncOnce().catch(() => undefined);
        /** Did the watch see every mailbox's own scan, or did the cap end it? */
        let settled = false;
        const watched = rang !== null && rang.mailboxes.length > 0 && probe !== undefined;
        if (watched) {
          // id → this mailbox's OWN baseline (DB-clock ms). Compared only against `lastSyncAt`,
          // which the worker writes with the same database clock.
          const baselines = new Map(rang.mailboxes.map((m) => [m.id, Date.parse(m.requestedAt)]));
          const deadline = Date.now() + SETTLE_CAP_MS;
          while (alive.current && Date.now() < deadline) {
            await sleep(SETTLE_POLL_MS);
            try {
              const facts = await probe();
              settled = facts
                .filter((m) => baselines.has(m.id))
                .every((m) => m.lastSyncAt !== null
                  && Date.parse(m.lastSyncAt) >= (baselines.get(m.id) ?? Infinity));
              if (settled) break;
            } catch {
              // A failed poll is "we cannot see yet" — keep waiting; the cap settles us.
            }
          }
        }
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
        if (watched && judged && alive.current) {
          const arrived = engine.read().entries("message").some((e) => !before.has(e.id));
          // New mail is its own feedback; only the outcomes the mail cannot show get a sentence.
          if (!arrived) toast(settled ? t("pullQuiet") : t("pullSlow"));
        }
      } finally {
        inFlight.current = false;
        if (alive.current) setPulling(false);
      }
    })();
  }, [engine, probe, toast, t]);

  return { available: !demo && engine.pullAvailable(), pulling, pull };
}

/** One shared binding, two renderers — see the header for why the hook must not live in here. */
export function PullNewMail({ variant, binding }: { variant: "rail" | "topbar"; binding: PullBinding }) {
  const t = useTranslations("sync");
  const { available, pulling, pull } = binding;
  if (!available) return null;

  if (variant === "topbar") {
    return (
      <button
        type="button"
        className={pulling ? "tb-btn pull-busy" : "tb-btn"}
        aria-label={t("pullAria")}
        aria-busy={pulling}
        onClick={pull}
      >
        <Icon name="refresh" />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={pulling ? "rail-pull pull-busy" : "rail-pull"}
      aria-busy={pulling}
      onClick={pull}
    >
      <Icon name="refresh" />
      <span>{pulling ? t("pulling") : t("pull")}</span>
    </button>
  );
}
