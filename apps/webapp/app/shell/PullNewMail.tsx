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
 * ── THE HONEST SETTLE, PER MAILBOX AND ON ONE CLOCK ─────────────────────────────────────────
 *
 * The spinner ends when the SCAN has demonstrably happened, not when the POST returns. The route
 * answers each mailbox's OWN effective request instant — a mailbox already holding a young
 * standing request answers with THAT stamp, so its bar is one its already-owed visit can meet —
 * and the worker stamps `last_sync_at` with the DATABASE's clock on woken visits, the same clock
 * the stamps come from. This hook polls the mailbox list (2 s cadence, 30 s cap) until every
 * listed mailbox's `lastSyncAt` has moved past its own baseline; no API-host, worker-host or
 * browser wall clock enters the comparison. The ring itself is transport-bounded in the adapter
 * (`PULL_RING_TIMEOUT_MS`), so a stalled POST cannot outlive the gesture. The 30 s cap settles a
 * worker that is down or busy without a lie: the request is stamped durably and will be
 * honoured; the spinner just stops claiming to watch it.
 *
 * ── ONE FLIGHT, TWO PLACEMENTS ──────────────────────────────────────────────────────────────
 *
 * The shell renders this in the rail's foot (wide widths) and in the topbar (≤900 px, where the
 * rail is a closed drawer) — `app.css` shows one at a time, `SyncBar`'s arrangement exactly. The
 * HOOK is called once, in the shell, and both placements receive the same binding: two
 * independent hooks would each carry their own `pulling`, so resizing mid-pull would reveal an
 * idle-looking copy that accepts a second POST while the hidden copy still polls (review
 * 2026-08-26, round 1).
 *
 * Hidden in the demo (no worker), and on any build with no Cloud base (the desktop's own store
 * has no doorbell to ring) — an affordance that could never do anything must not render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@ohmail/ui";
import { apiConfigured, mailboxes as mailboxesApi } from "../api-client";
import { useDemoMode, useEngine } from "./engine";

const SETTLE_POLL_MS = 2_000;
const SETTLE_CAP_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PullBinding {
  available: boolean;
  pulling: boolean;
  pull: () => void;
}

export function usePullNewMail(): PullBinding {
  const engine = useEngine();
  const demo = useDemoMode();
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
        // Ring first (never throws, transport-bounded — see `OhmailEngine.requestPull`), then
        // drain what the worker already holds so the press feels answered immediately.
        const rang = await engine.requestPull();
        void engine.syncOnce().catch(() => undefined);
        if (rang && rang.mailboxes.length > 0) {
          // id → this mailbox's OWN baseline (DB-clock ms). Compared only against `lastSyncAt`,
          // which the worker writes with the same database clock.
          const baselines = new Map(rang.mailboxes.map((m) => [m.id, Date.parse(m.requestedAt)]));
          const deadline = Date.now() + SETTLE_CAP_MS;
          while (alive.current && Date.now() < deadline) {
            await sleep(SETTLE_POLL_MS);
            try {
              const { items } = await mailboxesApi.list();
              const scanned = items
                .filter((m) => baselines.has(m.id))
                .every((m) => m.lastSyncAt !== null
                  && Date.parse(m.lastSyncAt) >= (baselines.get(m.id) ?? Infinity));
              if (scanned) break;
            } catch {
              // A failed poll is "we cannot see yet" — keep waiting; the cap settles us.
            }
          }
          // The scan (or the cap) has spoken; drain once more for anything the SSE wake has not
          // already delivered by now.
          void engine.syncOnce().catch(() => undefined);
        }
      } finally {
        inFlight.current = false;
        if (alive.current) setPulling(false);
      }
    })();
  }, [engine]);

  return { available: !demo && apiConfigured(), pulling, pull };
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
