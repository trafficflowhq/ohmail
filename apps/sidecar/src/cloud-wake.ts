import type { Diagnostic } from "./log.js";

/**
 * THE CLOUD DOOR'S WAKE SUBSCRIPTION — the sidecar's half of the realtime wake channel.
 *
 * The hosted `GET /events` emits a content-free `event: sync` frame whenever the account's
 * `change_log` advances (every writer NOTIFYs at the append chokepoint; the API fans out).
 * This module holds ONE such stream over `authedFetch` — the sidecar is the thing with the
 * session, not the webapp inside the desktop window — and answers every frame with
 * `mirror.kick()`, which pulls now and queues at most one follow-up for a burst.
 *
 * IT IS A HINT, NEVER A DEPENDENCY. The mirror's poll (`DEFAULT_CLOUD_POLL_MS`, with its own
 * backoff) is untouched and remains the reliability floor: with this stream dead, the door
 * behaves exactly as it did before the wake channel existed. Which is why every failure here
 * degrades to silence rather than to an error the door can feel:
 *
 *  · **Any non-200 except 429** ⇒ OFF for the process's lifetime, zero retries. This is the production
 *    default until the deploy flips the server's flag (503 `sse_disabled`), it is what an
 *    unknown route answers (404), and it is what capacity or an auth refusal answers — and a
 *    subscriber that re-dialed a refusing endpoint on a timer is a reconnect storm against
 *    the exact deployment that asked it to stop. One line says it happened; the poll carries
 *    the door from there. A **429** is the one refusal that means LATER rather than never —
 *    measured live: the launch bootstrap's own `/sync` paging tripped the limiter over the
 *    `/events` dial beside it — so a throttle redials on a slow cadence (`Retry-After`,
 *    floored at {@link WAKE_THROTTLE_RETRY_MS}) instead of dying for the process's lifetime.
 *  · **A connect that THROWS before the stream ever succeeded** ⇒ up to
 *    {@link NEVER_CONNECTED_ATTEMPTS} tries, then OFF. A host that never once answered is a
 *    host without the channel; endless redials would be pure noise (and in tests, pure churn).
 *  · **A drop AFTER a successful connect** ⇒ reconnect on backoff, forever. The server ends
 *    every stream on a cadence by design (its platform bounds an invocation's lifetime), so a
 *    clean end is the ordinary case and reconnects immediately with the backoff reset.
 *
 * The frames themselves are trusted for nothing: `event: sync` means "ask /sync", data is
 * ignored, and everything else (heartbeat comments, retry hints, unknown events) is skipped.
 */
export const NEVER_CONNECTED_ATTEMPTS = 3;
/** Reconnect after a CLEAN server close — the stream cycling, not failing. */
export const WAKE_RECYCLE_DELAY_MS = 1_000;
export const WAKE_BACKOFF_BASE_MS = 1_000;
export const WAKE_BACKOFF_MAX_MS = 300_000;
/** The floor under a 429 redial — the server said LATER, and later is at most once a minute. */
export const WAKE_THROTTLE_RETRY_MS = 60_000;

export interface CloudWakeConfig {
  auth: { authedFetch(path: string, init?: RequestInit): Promise<Response> };
  /** The wake sink — `mirror.kick`. Must not throw; a throw is treated as a no-op. */
  onWake: () => void;
  log?: Diagnostic;
  /** Test seams. Production takes the defaults above. */
  recycleDelayMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  throttleRetryMs?: number;
}

export interface CloudWake {
  /** Close the stream and stop reconnecting. Idempotent. */
  stop(): void;
}

/**
 * Parse an SSE byte stream, invoking `onEvent` per dispatched event name. Minimal by intent:
 * the protocol's `data:`/`id:` fields are deliberately dropped (our frames are content-free
 * wake signals; a client that read data out of them would be building the dependency this
 * channel must never become).
 */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (name: string) => void,
  isStopped: () => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || isStopped()) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") {
          // Dispatch. The default event name is "message"; ours is "sync".
          if (eventName === "sync") onEvent(eventName);
          eventName = "";
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        }
        // `: ping` comments, `retry:` hints and `data:` lines all fall through, read and unused.
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the stream is already gone, which is what cancel wanted */
    }
  }
}

export function startCloudWake(cfg: CloudWakeConfig): CloudWake {
  const recycleDelayMs = cfg.recycleDelayMs ?? WAKE_RECYCLE_DELAY_MS;
  const backoffBaseMs = cfg.backoffBaseMs ?? WAKE_BACKOFF_BASE_MS;
  const backoffMaxMs = cfg.backoffMaxMs ?? WAKE_BACKOFF_MAX_MS;
  const throttleRetryMs = cfg.throttleRetryMs ?? WAKE_THROTTLE_RETRY_MS;

  let stopped = false;
  let everConnected = false;
  let failedDials = 0;
  let backoffMs = backoffBaseMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Aborts the held request on `stop()`. Without it a stop would leave the reader parked on a
   * `read()` that resolves only when the server next says something — a quit waiting on a
   * heartbeat is a quit that misses the shell's grace period.
   */
  let aborter: AbortController | null = null;

  const wake = (): void => {
    try {
      cfg.onWake();
    } catch {
      /* a wake sink that throws forfeits this wake; the next frame or the poll covers it */
    }
  };

  const scheduleReconnect = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, ms);
    // A pending reconnect must not keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    let res: Response;
    try {
      aborter = new AbortController();
      res = await cfg.auth.authedFetch("/events", {
        headers: { accept: "text/event-stream" },
        signal: aborter.signal,
      });
    } catch (err) {
      if (stopped) return;                       // the abort on stop() lands here; say nothing
      if (everConnected) {
        // A drop on a channel that has worked: a blip. Reconnect on backoff, forever — the
        // stream is how mail becomes prompt, and the poll bounds what a long outage costs.
        backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
        scheduleReconnect(backoffMs);
        return;
      }
      failedDials += 1;
      if (failedDials < NEVER_CONNECTED_ATTEMPTS) {
        scheduleReconnect(backoffBaseMs * failedDials);
        return;
      }
      cfg.log?.("cloud_wake_off", {
        err,
        reason: "the hosted events stream never connected; the mirror stays on its poll — " +
          "mail arrives on the poll cadence instead of the push one, nothing else changes",
      });
      stopped = true;
      return;
    }

    if (!res.ok || !res.body) {
      try {
        await res.body?.cancel();
      } catch {
        /* nothing to release */
      }
      // A 429 is the server saying LATER, not never — and it is exactly what a fresh install
      // hears, measured live: the launch's bootstrap is paging `/sync` flat out, the limiter
      // throttles the `/events` dial that rides in beside it, and "permanent for the process"
      // turned one crowded second into a push channel that stayed dead for the install's whole
      // lifetime. So a throttle redials — at the server's own `Retry-After` when it names one,
      // never faster than {@link WAKE_THROTTLE_RETRY_MS} — which is one dial a minute at most,
      // not the reconnect storm the permanent-off doctrine exists to prevent.
      if (res.status === 429) {
        // `Retry-After` is delay-seconds OR an HTTP-date; a proxy is free to use either form,
        // and reading a date with Number() yields NaN — which would fall to the floor and
        // redial into the very limiter that asked for more time.
        const raw = res.headers.get("retry-after");
        const asSeconds = Number(raw);
        const asDate = raw ? Date.parse(raw) : Number.NaN;
        const askedMs = Number.isFinite(asSeconds) && asSeconds > 0
          ? asSeconds * 1000
          : Number.isFinite(asDate)
            ? asDate - Date.now()
            : 0;
        const waitMs = Math.max(throttleRetryMs, askedMs);
        cfg.log?.("cloud_wake_throttled", {
          reason: "the hosted events stream is rate-limited right now; the dial repeats on a " +
            "slow cadence and the mirror stays on its poll until it connects",
        });
        scheduleReconnect(waitMs);
        return;
      }
      // Every OTHER refusal is permanent for the process, zero retries: the server's own flag
      // being off (503) until the deploy flips it, an unknown route (404), an auth refusal —
      // see the header for why redialing a refusing endpoint is the storm this must never start.
      cfg.log?.("cloud_wake_off", {
        status: res.status,
        reason: "the hosted events stream refused; the mirror stays on its poll — " +
          "mail arrives on the poll cadence instead of the push one, nothing else changes",
      });
      stopped = true;
      return;
    }

    if (!everConnected) {
      everConnected = true;
      // Once, and worth a line: this is the fact a deploy verification reads to know the
      // realtime channel is live end-to-end for the desktop's Cloud door.
      cfg.log?.("cloud_wake_connected", {
        reason: "the hosted events stream is live; commits on the account now pull the mirror " +
          "within about a second instead of on the poll cadence",
      });
    }
    backoffMs = backoffBaseMs;

    try {
      await readEvents(res.body, wake, () => stopped);
      // A clean end: the server cycles streams on a fixed lifetime by design. Reconnect
      // promptly (the gap is a window where frames are lost — the first pull after
      // reconnecting is NOT forced, because the poll bounds the loss and a forced pull per
      // cycle would be a scheduled cost, which is the poll's job, not the stream's).
      scheduleReconnect(recycleDelayMs);
    } catch {
      // The stream died mid-read: a blip on a proven channel (or the abort on stop, which
      // `scheduleReconnect` refuses). Backoff and redial.
      backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
      scheduleReconnect(backoffMs);
    }
  };

  void connect();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        aborter?.abort();
      } catch {
        /* an abort on a settled request is a no-op */
      }
    },
  };
}
