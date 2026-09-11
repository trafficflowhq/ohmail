/**
 * Is this tab still the app this origin is serving? A browser client is downloaded once and left running for weeks;
 * the build in the tab is frozen while the origin's moves, and nothing announces the divergence — the app keeps
 * working until something it calls answers a shape it does not know. So the tab asks occasionally which build the
 * origin serves and compares: different means a newer ohmail exists and the whole remedy is a reload.
 */

/**
 * It asks `/version`, a digest and not the commit (`buildToken` in `app-update.ts`): the comparison only needs "same
 * or not". A poll, not a push: one small request an hour cannot break anything, and a socket held open for the life
 * of a tab is a great deal of machinery for a sentence — it also asks when the tab returns to the foreground, exactly
 * when a stale tab is about to be used. Never armed in the desktop window: its window reaches no network at all
 * (`offline-guard.ts`), and it updates by signed feed instead.
 */
import {
  announceUpdate,
  askDue,
  offerKey,
  readAskMemory,
  rememberAsk,
  writeAskMemory,
  type UpdateOffer,
} from "./app-update";

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
         dismissal, because the promise is about how often the app talks.

         THE OFFER CARRIES THE BUILD, and the key is derived from the offer rather than spelled
         beside it. `offerKey` is the one keying rule for the once-a-day restraint and the
         desktop path already goes through it; an offer with no build on it keys as the bare
         word "reload", so the two would silently key differently the moment anything else — a
         dismissal, a shared "was this asked?" helper — read the offer instead of this line.
         Nothing renders the value: the browser's sentence names no build, because a digest is
         not a thing to show somebody. */
      const offer: UpdateOffer = { kind: "reload", version: served, act: reload };
      const memory = readAskMemory();
      const key = offerKey(offer);
      if (!askDue(memory, key, now())) return;
      writeAskMemory(rememberAsk(memory, key, now()));
      announceUpdate(offer);
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
