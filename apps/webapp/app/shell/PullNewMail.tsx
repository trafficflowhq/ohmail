"use client";

/**
 * "PULL NEW MAIL" — the one button that makes the WORKER look at the mail server now.
 *
 * ── WHY IT EXISTS WHEN THE APP ALREADY SYNCS ITSELF ─────────────────────────────────────────
 *
 * Every self-driven sync in this shell — the SSE wake, the poll, the visibility drain — asks the
 * CLOUD for changes the worker has already mirrored. None of them can make the worker scan the
 * IMAP server any sooner, so a person who was just told "I sent it" had nothing to press: the
 * mail sat on their own mail server until the worker's rotation came round (measured 2026-08-26:
 * p50 194 s, p90 431 s arrival→mirror). This button rings `POST /sync/pull`
 * (`mailboxes.sync_requested_at` — the same doorbell the send path rings for Sent copies), the
 * worker's ~3 s kick scan marks those mailboxes woken, and the cycle serves them out of turn.
 *
 * ── THE RING GOES THROUGH THE ENGINE, AND THE GATE READS THE ENGINE — NOT THE API CLIENT ────
 *
 * Both facts here are repairs (2026-08-29), and they are the two halves of one seam error:
 *
 *  · `available` used to read `apiConfigured()` from `app/api-client` — which is TRUE on the
 *    hosted client even while the engine's wrapped adapter has lost the doorbell (the sync
 *    gate's literal had not forwarded `requestPull`, so every click ran to completion in
 *    microtasks with no request, no busy paint and no error — a dead control on ohmail.app),
 *    and FALSE on the desktop, whose builds alias the api-client to a refusing stub — so the
 *    control never rendered on either desktop door although the bridge adapter behind them
 *    serves `POST /sync/pull` on both (the hosted door forwards it to the Cloud, the standalone
 *    door stamps its own engine, which drains within one ≤15 s poll). The one predicate that
 *    cannot disagree with what the press will do is the engine's own:
 *    {@link OhmailEngine.pullAvailable}.
 *
 *  · The settle read used to be `mailboxesApi.list()` from the same api-client — unreachable on
 *    the desktop for the same reason. It is now the injected {@link MailboxProbe}, the seam the
 *    sync strip already rides (`AppShell`'s `mailboxFacts` prop): the Cloud client supplies
 *    `GET /mailboxes`, the desktop window supplies the bridge read, the served host-client its
 *    bearer read. No probe (the demo) means nothing to watch — and the demo never renders this
 *    control anyway.
 *
 * ── THE HONEST SETTLE, PER MAILBOX AND ON ONE CLOCK ─────────────────────────────────────────
 *
 * The spinner ends when the SCAN has demonstrably happened, not when the POST returns. The route
 * answers each mailbox's OWN effective request instant — a mailbox already holding a young
 * standing request answers with THAT stamp, so its bar is one its already-owed visit can meet —
 * and the worker stamps `last_sync_at` with the DATABASE's clock on woken visits, the same clock
 * the stamps come from. This hook polls the probe (2 s cadence, 30 s cap) until every listed
 * mailbox's `lastSyncAt` has moved past its own baseline; no API-host, worker-host or browser
 * wall clock enters the comparison. The ring itself is transport-bounded in the adapter
 * (`PULL_RING_TIMEOUT_MS`), so a stalled POST cannot outlive the gesture. The 30 s cap settles a
 * worker that is down or busy without a lie: the request is stamped durably and will be
 * honoured; the spinner just stops claiming to watch it.
 *
 * ── THE OUTCOME IS SAID, ONCE, AND ONLY WHERE THE MAIL CANNOT SAY IT ────────────────────────
 *
 * A pull that lands new mail needs no sentence — the rows appear and the counts tick, and a
 * toast restating that would be noise. The two outcomes the mail CANNOT show are the quiet scan
 * and the capped watch, so those are the two that speak — a control that works must also LOOK
 * like it works:
 *
 *  · scan demonstrably done, nothing new on this mirror → "Checked — nothing new." (pullQuiet)
 *  · cap hit with nothing arrived → "Still checking. New mail arrives on its own." (pullSlow) —
 *    true both when the worker is slow and when it is down, because the stamp is durable.
 *  · ring refused or failed → nothing: the sync strip owns failure sentences, and a "nothing
 *    new" over a ring that never happened would be a lie.
 *
 * "Nothing new" is judged against the MIRROR — the set of message ids before the press versus
 * after a FRESH, SUCCESSFUL post-scan drain (see the judgment block for why "fresh" and
 * "successful" are both load-bearing, and `DRAIN_JUDGE_CAP_MS` for why the wait is bounded) —
 * because the mirror is what the person is looking at; a new id in ANY pile (the Screener
 * included) counts as arrival and silences the toast. A judgment the gesture could not earn in
 * time says nothing at all.
 *
 * ── ONE FLIGHT, TWO PLACEMENTS ──────────────────────────────────────────────────────────────
 *
 * The shell renders this in the rail's foot (wide widths) and in the topbar (≤900 px, where the
 * rail is a closed drawer) — `app.css` shows one at a time, `SyncBar`'s arrangement exactly. The
 * HOOK is called once, in the shell, and both placements receive the same binding: two
 * independent hooks would each carry their own `pulling`, so resizing mid-pull would reveal an
 * idle-looking copy that accepts a second POST while the hidden copy still polls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon, useToast } from "@ohmail/ui";
import { useDemoMode, useEngine } from "./engine";
import type { MailboxProbe } from "./MailStateProvider";

const SETTLE_POLL_MS = 2_000;
const SETTLE_CAP_MS = 30_000;
/**
 * How long the gesture will wait on any ONE post-scan drain before releasing the UI unjudged.
 *
 * `HttpAdapter.sync()` carries no deadline of its own (a drain is the engine's business and may
 * legitimately run long), so an AWAITED drain here would put an unbounded wait inside a gesture
 * whose cap promises 30 s — a half-open `/sync` would hold `pulling` and the single-flight latch
 * for the tab's lifetime, and every later click would be silently refused. The race below
 * bounds the WAIT, never the drain: a drain that outlives the cap
 * keeps running in the engine and lands its pages whenever it lands them; the gesture just stops
 * claiming to watch, exactly as the settle cap already does — and makes no quiet claim it could
 * not verify.
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
         * THE JUDGMENT DRAIN — bounded, FRESH, and success-gated.
         *
         * Two awaits, not one, because `syncOnce()` is single-flight: the first flushes
         * whatever drain is already running — possibly the press-time drain above, whose pages
         * may have been read BEFORE the worker committed the scan's arrivals — and only a drain
         * that STARTED after the scan was observed can prove the mirror quiet. The second await
         * is that drain: it begins strictly after the first resolved, which is strictly after
         * the settle observation. Each wait is bounded (`DRAIN_JUDGE_CAP_MS`), and the quiet
         * sentence is spoken only when the fresh drain COMPLETED SUCCESSFULLY — a failed or
         * still-running drain proves nothing about the mailbox, so it says nothing.
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
