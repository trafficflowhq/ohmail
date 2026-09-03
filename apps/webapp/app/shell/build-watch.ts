/**
 * IS THIS TAB STILL THE APP THIS ORIGIN IS SERVING?
 *
 * A browser client is a program that was downloaded once and then left running, and mail is the
 * kind of application people leave open for weeks. The build in the tab is frozen at the moment
 * it loaded; the build the origin serves moves whenever anything ships. Nothing about that
 * divergence announces itself — the app keeps working, against a server that has moved on, until
 * something it calls answers a shape it does not know.
 *
 * So the tab asks, occasionally, which build the origin is serving now, and compares it with the
 * one it is. Different means a newer ohmail exists and the whole remedy is a reload.
 *
 * ── WHAT IS ASKED, AND WHY IT IS NOT THE COMMIT ────────────────────────────────────────────
 *
 * `/version` answers a short digest of the running build rather than the build itself — see
 * `buildToken` in `app-update.ts`. The comparison only needs to know whether two builds are the
 * same, and a digest answers that exactly as well as a commit id while telling a stranger
 * nothing about this deployment's history.
 *
 * ── WHY A POLL AND NOT A PUSH ──────────────────────────────────────────────────────────────
 *
 * Because a poll costs one small request an hour and cannot break anything, and because the
 * alternative — a socket held open for the life of a tab, for a fact that changes a few times a
 * week — is a great deal of machinery for a sentence. The tab also asks when it comes BACK to
 * the foreground, which is when a stale tab is most likely to be stale and exactly when a person
 * is about to use it.
 *
 * ── AND IT NEVER RUNS IN THE DESKTOP WINDOW ────────────────────────────────────────────────
 *
 * Nothing here is armed by the shared shell. The browser client arms it; the desktop app arms
 * its own cadence against a signed release feed instead, and its window reaches no network at
 * all (`offline-guard.ts` seals `fetch` inside the page). A build watch there would be a request
 * that cannot be made, for a build that does not update that way.
 */
import { announceUpdate, askDue, readAskMemory, rememberAsk, writeAskMemory } from "./app-update";

/** Where the origin answers which build it is serving. */
export const BUILD_PATH = "/version";

/**
 * How often a tab that is being looked at asks again.
 *
 * Half an hour rather than a day: this is the CHECK, and it is cheap. The restraint that matters
 * to a person is on the notice, not on the question — a build that has already been declined
 * stays quiet for a day however often this asks (`askDue`).
 */
export const BUILD_POLL_MS = 30 * 60 * 1000;

/**
 * The floor between two requests, whatever provokes them.
 *
 * A window that is switched to and away from repeatedly would otherwise ask on every focus.
 * Wall-clock, like every other interval in this feature.
 */
export const BUILD_MIN_GAP_MS = 5 * 60 * 1000;

/** The build the origin says it is serving, out of whatever `/version` answered. */
export function servedTokenOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const build = (payload as { build?: unknown }).build;
  return typeof build === "string" && build !== "" ? build : null;
}

export interface BuildWatchOptions {
  /** The token of the build THIS document was loaded from. */
  token: string;
  /** Seams, so the whole cadence is drivable from a test without a clock or a network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  reload?: () => void;
  /** Ask again after this long. */
  every?: number;
}

/**
 * Watch for a newer build, and hand back the way to stop.
 *
 * Returns a no-op teardown outside a browser (a server render, a test that did not stub a
 * document): there is no tab to be stale, so there is nothing to watch.
 */
export function startBuildWatch(options: BuildWatchOptions): () => void {
  const { token } = options;
  const call = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  const now = options.now ?? (() => Date.now());
  const reload = options.reload ?? (() => window.location.reload());
  const every = options.every ?? BUILD_POLL_MS;
  if (call === null || typeof document === "undefined") return () => {};

  let stopped = false;
  let asking = false;
  let askedAt: number | null = null;

  const ask = async (): Promise<void> => {
    // One request in flight at a time, and never two inside the floor. Both guards are about
    // the same failure: a foregrounded window firing the visibility handler and the interval in
    // the same moment.
    if (stopped || asking || (askedAt !== null && now() - askedAt < BUILD_MIN_GAP_MS)) return;
    asking = true;
    askedAt = now();
    try {
      /* `no-store` on both the request and the cache mode: a cached answer is the answer of the
         build that was serving when it was cached, which is precisely the build this is trying
         to notice has been replaced. */
      const response = await call(`${BUILD_PATH}?t=${askedAt}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
        credentials: "omit",
      });
      if (!response.ok) return;
      const served = servedTokenOf(await response.json());
      if (stopped || served === null || served === token) return;

      /* A NEWER BUILD, AND THE RESTRAINT THAT DECIDES WHETHER TO SAY SO. Once per day per
         build: a person who has already been told about this one and carried on working is
         not told again by the same tab today. Recorded on the SPEAKING rather than on a
         dismissal, because the promise is about how often the app talks. */
      const memory = readAskMemory();
      const key = `reload:${served}`;
      if (!askDue(memory, key, now())) return;
      writeAskMemory(rememberAsk(memory, key, now()));
      announceUpdate({ kind: "reload", act: reload });
    } catch {
      /* Offline, a refused request, or an answer that is not JSON. A build watch that cannot
         reach the origin has nothing to report, and reporting the failure would be noise about
         a thing nobody asked for. */
    } finally {
      asking = false;
    }
  };

  const onVisible = (): void => {
    if (document.visibilityState === "visible") void ask();
  };
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(() => void ask(), every);
  /* NOT at arm time. A document that has just loaded IS the build the origin served a moment
     ago, so the first useful question is one interval away. */

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
