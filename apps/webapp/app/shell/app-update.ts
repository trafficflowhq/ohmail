/**
 * A newer ohmail exists — the one fact, and the rules about how often a person may be told it. The browser and the
 * desktop answer "is there something newer?" in unrelated ways (a tab compares the build it loaded against the one
 * the origin serves; the desktop asks a signed feed through its native process) and nothing here tries to share the
 * mechanisms. What IS shared is everything a person experiences: one quiet strip, one sentence — and the restraint.
 */

/**
 * "At most once in twenty-four hours, per thing being offered" is a rule about people, not feeds, and a rule written
 * twice drifts; the arithmetic below is the only copy. Wall clock, never ticks: a laptop shut for thirty hours fires
 * no timers, and an interval-counting cadence would wait another full day after waking — comparing instants makes
 * suspend a non-event. The one hazard that creates is a clock moving BACKWARDS, and {@link periodElapsed} guards it:
 * a stamp ahead of now is treated as elapsed.
 */
import { durableSet } from "./durable";

/**
 * How long between two checks, and between two asks about the same release.
 *
 * One constant for both because they are the same promise read from two sides: the app looks
 * at least once a day, and it may speak at most once a day about any one thing it found.
 */
export const UPDATE_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * What is on offer, and what pressing the notice would do.
 *
 *  · `reload` — the origin is serving a newer build than this document was loaded from. The
 *    remedy is entirely local to the tab.
 *  · `restart` — the desktop shell has already fetched and verified a release and is one
 *    press away from installing it.
 *  · `package` — the desktop shell cannot install this update itself, because the app was
 *    installed by something that owns its files. There is no button; there is a place to go.
 */
export type UpdateOfferKind = "reload" | "restart" | "package";

export interface UpdateOffer {
  kind: UpdateOfferKind;
  /** The release being offered, where the source knows it by name. */
  version?: string;
  /**
   * What the notice's one button does. Held as a function rather than as data on purpose: the
   * strip is shared code and must not be able to name a feed, a version or an install command.
   * It renders a sentence and calls back; the source that armed the offer owns the verb.
   *
   * Absent for `package`, which is a notice and not a control.
   */
  act?: () => void;
}

/**
 * The thing the once-per-period rule counts against — the RELEASE, not the occasion.
 *
 * "Once per day per version" and "once per day" are different promises, and only the first one
 * is honest: a person who was asked about 0.14.1 this morning and is offered 0.14.2 this
 * afternoon should hear about it. Keying on the version is what makes a new release able to
 * speak while a declined one stays quiet.
 */
export function offerKey(offer: UpdateOffer): string {
  return offer.version ? `${offer.kind}:${offer.version}` : offer.kind;
}

/**
 * Has a period passed since `since`?
 *
 * `null` means "never happened", which is elapsed by definition — a check that has never run
 * is overdue, not early.
 *
 * A stamp in the FUTURE is elapsed too, and that is the clock-moved-backwards guard rather
 * than a rounding convenience. The stamps here are wall-clock instants; if the machine's clock
 * is put back a year, a stamp written before the change is a year ahead of `now`, and a plain
 * `now - since >= period` would then answer "not yet" every time it is asked until the clock
 * catches up. Refusing to check for a year is a worse failure than checking once too early.
 */
export function periodElapsed(
  since: number | null | undefined,
  now: number,
  period: number = UPDATE_PERIOD_MS,
): boolean {
  if (since === null || since === undefined || !Number.isFinite(since)) return true;
  if (since > now) return true;
  return now - since >= period;
}

/**
 * When each offer was last put in front of somebody, by {@link offerKey}. Kept per device: it
 * is a fact about what this screen has already said, and it means nothing on another one.
 */
export type AskMemory = Record<string, number>;

/** The device-local memory's key. A read failure means "nothing remembered", which only speaks. */
export const ASK_MEMORY_KEY = "ohmail.updateAsked";

/** May this offer be shown now? */
export function askDue(
  memory: AskMemory,
  key: string,
  now: number,
  period: number = UPDATE_PERIOD_MS,
): boolean {
  return periodElapsed(memory[key] ?? null, now, period);
}

/**
 * Write down that the offer has been made — and forget the ones that can no longer matter.
 *
 * The pruning is not housekeeping. Every release this device is ever offered would otherwise
 * add a permanent key, and the store this lands in is one a browser may refuse to write when
 * it is full. An entry older than two periods can only ever answer "due", so keeping it
 * changes no decision.
 */
export function rememberAsk(
  memory: AskMemory,
  key: string,
  now: number,
  period: number = UPDATE_PERIOD_MS,
): AskMemory {
  const kept: AskMemory = {};
  for (const [name, at] of Object.entries(memory)) {
    if (Number.isFinite(at) && at <= now && now - at < period * 2) kept[name] = at;
  }
  kept[key] = now;
  return kept;
}

/** The memory this device holds. Anything unreadable reads as empty, which only speaks. */
export function readAskMemory(): AskMemory {
  try {
    const raw = window.localStorage.getItem(ASK_MEMORY_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AskMemory = {};
    for (const [name, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) out[name] = at;
    }
    return out;
  } catch {
    /* No storage, a blocked jar, or something that is not JSON. Nothing remembered. */
    return {};
  }
}

/** Store the memory. A jar that refuses holds the restraint for this run only, and says so. */
export function writeAskMemory(memory: AskMemory): void {
  durableSet(ASK_MEMORY_KEY, JSON.stringify(memory), "update.asked");
}

/**
 * THE BUILD TOKEN — a short name for "which build is this", and deliberately not the build.
 *
 * The tab has to compare the build it is running against the build the origin is serving, and
 * the honest identifier for a build is its commit. Answering that identifier to anybody who
 * asks would publish this deployment's commit history one request at a time, to no one's
 * benefit: the comparison needs only to know whether two builds are the SAME, which a digest
 * answers exactly as well as the original.
 *
 * The release number is folded in beside the commit so that a deployment which genuinely has
 * no commit to name — a self-hosted image built from a tarball, where the sha is "dev" — still
 * changes its token when it is upgraded. Without it, every such deployment would carry one
 * token for ever and no reader would ever be told anything.
 *
 * FNV-1a, not a cryptographic hash. What is wanted is "different builds get different names",
 * and the failure mode of a collision is one missed notice on one deployment boundary, which
 * the next deployment corrects. It is synchronous, which matters: the same value is computed
 * inside a request handler and inside a render, and neither is a place to await a digest.
 */
export function buildToken(version: string | undefined, build: string | undefined): string {
  /* The separator is written as an ESCAPE and not as a raw byte: a source file containing a
     literal NUL reads as binary to the ordinary text tools, which then skip it silently rather
     than reporting that they did. It is a NUL rather than a dash because neither a release
     number nor a commit id can contain one, so no pair of builds can collide by punctuation. */
  const text = `${version ?? ""}\u0000${build ?? ""}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, by shift-and-add: `hash * 16777619` overflows a double's exact integer
    // range and would quietly stop being the same function on long inputs.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/* ── THE STORE ─────────────────────────────────────────────────────────────────────────────
 *
 * A module-level value with subscribers, in the shape `omarchy.ts` uses for the theme feed and
 * for the same reason: the SOURCE is armed once by whichever host this bundle is running in —
 * the desktop window arms its own cadence at boot, the browser client arms a build watch — and
 * the SURFACE is an ordinary component that mounts and unmounts with a view. Threading the
 * offer down as a prop would mean the shared shell knowing which host it is in, which is the
 * one thing that seam exists to avoid. */
let offer: UpdateOffer | null = null;
const listeners = new Set<(next: UpdateOffer | null) => void>();

/** Publish an offer, or withdraw the one standing. Idempotent for equal offers. */
export function announceUpdate(next: UpdateOffer | null): void {
  if (next === null && offer === null) return;
  offer = next;
  // A copy, so a listener that unsubscribes while being told does not disturb the walk.
  for (const tell of [...listeners]) tell(offer);
}

/** What is on offer right now — the value a component adopts at mount, before any event. */
export function currentUpdateOffer(): UpdateOffer | null {
  return offer;
}

export function subscribeUpdateOffer(tell: (next: UpdateOffer | null) => void): () => void {
  listeners.add(tell);
  return () => {
    listeners.delete(tell);
  };
}

/** Tests only: forget the offer and every listener, so each test drives a fresh store. */
export function resetUpdateStoreForTests(): void {
  offer = null;
  listeners.clear();
}
