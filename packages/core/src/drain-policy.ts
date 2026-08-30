/**
 * THE DRAIN POLICY — the decisions a resuming mirror makes about its own staleness, in ONE
 * module, for every surface that has a mirror to resume.
 *
 * ── WHY THIS FILE EXISTS (INSTANT-ARCH §6.7, stage 7's first adopted responsibility) ─────────
 *
 * There are TWO implementations of "drain the account's change feed into a local mirror" in this
 * repository. `packages/client-engine` is one: entity records keyed `type:id`, over IndexedDB on
 * the web and sqlite on the phone. `apps/sidecar/src/cloud-mirror.ts` is the other: the same wire
 * applied into the desktop's RELATIONAL store — the very tables the LOCAL organizer writes, because
 * the desktop's shell reads the sidecar's own API in both modes. The second one is not going away
 * by being deleted: that relational apply is what the sidecar's read surface, host mode and the
 * LOCAL door all answer from. So the coherence win has to come from the layer that actually forked,
 * which is neither store — it is the POLICY they both need to agree on.
 *
 * It forked twice, measurably, in one week:
 *
 *  · INSTANT-ARCH stage 2 (the Freshness Contract) shipped `STALE_RESUME_MS` + `isStaleResume` +
 *    a three-state `freshness()` in `engine.ts`, and then had to write `CLOUD_STALE_RESUME_MS` +
 *    an inline stamp comparison + a second three-state `freshness()` into `cloud-mirror.ts`. The
 *    sidecar's own comment recorded the duplication as deliberate ("restated rather than
 *    imported").
 *  · INSTANT-ARCH stage 3 (the backlog diet) shipped `BACKLOG_PAGE_LIMIT = 2000` in `engine.ts`
 *    and `STALE_REPLAY_PAGE_LIMIT = 2000` in `cloud-mirror.ts` — the same number, the same
 *    argument, written out twice.
 *
 * Two constants and two predicates is not a large duplication in lines. It is a large one in
 * KIND: a threshold that disagrees between the drivers means one device labels itself "catching
 * up" while another calls a mirror of the same age current, and a page limit that disagrees means
 * the next fix for a convergence tail reaches the web and the phone and misses the desktop —
 * which is precisely the "the engine got a fix, the sidecar mirror didn't" class §6.7 names, and
 * precisely what the stale-resume gap was until stage 2. Everything here is pure — no
 * store, no clock, no network — precisely so that both drivers can hold it without either one
 * adopting the other's storage.
 *
 * ── WHY IT SITS IN `@trafficflow/core` AND NOT IN THE ENGINE ─────────────────────────────────
 *
 * Because of who has to import it. `apps/sidecar` is a Node process that must NOT link
 * `@ohmail/client-engine`: that barrel reaches IndexedDB, the search index and the whole
 * optimistic-overlay machinery, none of which a mirror driver can use. It already depends on
 * this package, and `packages/client-engine` already depends on this package, so a
 * dependency-free source subpath here is the one placement that costs neither graph anything —
 * the same argument, verbatim, that put `./ics` and `./folder-name` on their own subpaths for
 * the browser bundles. Nothing in this file may ever acquire an import.
 *
 * ── WHAT IS DELIBERATELY *NOT* HERE ──────────────────────────────────────────────────────────
 *
 * The APPLY. `packages/client-engine/src/apply.ts` keeps a per-record `seq` and enforces the
 * contract's rule 3 ("an older-or-equal seq never overwrites") against that field; the sidecar's
 * relational rows carry no such field and satisfy rule 3 STRUCTURALLY, by applying pages in
 * cursor order and each page in ascending seq. Those are two sound implementations of one rule
 * over two different substrates, not a fork — and merging them means giving the relational
 * mirror a per-entity mirror-seq column, which is a schema change and a separate slice.
 *
 * The COLD-MIRROR GATE. Each driver decides for itself whether a drain is a resume at all — the
 * engine asks its store for cursor `"0"`, the sidecar asks whether a bootstrap generation is in
 * flight — because "am I bootstrapping" is a fact about that driver's own persistence, not about
 * the policy. {@link mirrorStale} is the stamp comparison alone and both callers gate it.
 */

/**
 * THE FRESHNESS CONTRACT'S THREE STATES (INSTANT-ARCH §6.6) — what a surface may say about the
 * age of the mirror it is rendering. Exactly three, and they must never be conflated:
 *
 *  · `unknown` — no drain has EVER completed over this mirror. A zero-row list is not "empty",
 *    it is unanswered; the surface owes a skeleton, never content and never an empty state.
 *  · `stale`   — a drain HAS completed, but longer ago than {@link STALE_RESUME_MS}. The mirror
 *    is renderable truth and MUST be rendered (frame one is local, always) — but it is truth
 *    as of {@link MirrorFreshness.asOf}, and the surface says so quietly ("as of 14:32 ·
 *    catching up") until a drain settles. Staleness labeled is honest; staleness silent is
 *    the bug this type exists to make unrepresentable.
 *  · `current` — the last completed drain is recent. Plain content, no label.
 */
export type FreshnessState = "unknown" | "stale" | "current";

/** What a surface renders about its mirror's age — see {@link mirrorFreshness}. */
export interface MirrorFreshness {
  state: FreshnessState;
  /** The ISO stamp the state was derived from; `null` whenever the state is `unknown`. */
  asOf: string | null;
}

/**
 * WHEN A RESUMING MIRROR STOPS BEING "CURRENT" AND STARTS BEING "STALE" — the age of the last
 * completed drain beyond which the next drain fetches the newest page before replaying its
 * backlog, and beyond which a surface labels what it is showing.
 *
 * Five minutes, sized from both directions. Below it: a visible tab settles a drain every eight
 * seconds and a running sidecar completes a pull every twenty, so a healthy surface's stamp is
 * never more than seconds old and the freshness path costs it exactly nothing — the property
 * `stale-resume-freshness.test.ts` pins. Above it: the surface was not draining at all (the tab
 * was hidden, the laptop was closed), its backlog is unknowable from here, and the price of
 * guessing wrong is asymmetric — a false positive is one extra `GET /sync/snapshot` page (~0.5 s
 * measured), a false negative is the newest mail arriving at the END of an oldest-first replay
 * that production measured in whole minutes (INSTANT-ARCH §3.1).
 *
 * ONE NUMBER FOR EVERY SURFACE. It used to be two — this one and the sidecar's
 * `CLOUD_STALE_RESUME_MS` — with the same value and two copies of the argument above. Two
 * copies of a threshold is two opinions waiting to diverge, and the surface a divergence would
 * hurt is the one whose label said "current" over a mirror the other surface was freshening.
 */
export const STALE_RESUME_MS = 5 * 60_000;

/**
 * THE STALE DRAIN ASKS FOR DENSE PAGES (INSTANT-ARCH §6.3 / §8 stage 3 — the backlog diet's
 * client half). A backlog's dominant cost is PAGE COUNT, not page size: each `/sync` page is a
 * serverless invocation with ~10 fixed sequential database round trips — measured p50 1,084 ms
 * per 500-row page on the live path (2026-08-29), of which ~0.4 s no row could ever pay for —
 * so a 1,500-row backlog at the default page size was four invocations (~5.1 s measured) where
 * one dense page carries it whole. 2,000 is the server's own MAX_LIMIT (`sync-service.ts`), the
 * most a page may say; asking for more would be clamped there anyway.
 *
 * Used ONLY when the drain is a backlog catch-up — the same condition that fires the freshen,
 * so the ask and the label are one verdict observed twice. The steady-state poll keeps the
 * deployed page size, and an explicit per-driver limit (the test seams) always wins. Payload
 * stays modest: the server serves a stale span COALESCED (latest change per entity), and a
 * measured 500-row page is ~0.25–0.5 MB, so the dense page is ~1–2 MB against the platform's
 * 4.5 MB response cap.
 */
export const BACKLOG_PAGE_LIMIT = 2000;

/**
 * IS THE MIRROR BEHIND ITS OWN THRESHOLD — the stamp comparison, alone.
 *
 * `lastDrainAt` is the ISO instant of the last COMPLETED drain, written by the driver on its OWN
 * clock (never `serverTime`: cross-machine skew must not reach a comparison whose two operands
 * come from the same clock). The engine keeps it in mirror meta under `LAST_DRAIN_AT_META`; the
 * sidecar keeps it in its cursor file as `lastDrainAt`. The two spellings of "absent" — the
 * engine's `undefined`, the sidecar's `null` — are both accepted, because forcing one of them to
 * normalise at the call site is exactly the sort of adaptation that grows back into a second
 * implementation.
 *
 * ## ABSENT IS STALE HERE AND `unknown` IN {@link mirrorFreshness}, AND THAT IS NOT A CONTRADICTION
 *
 * The asymmetry is the whole reason both functions exist rather than one. A mirror with NO stamp
 * is every mirror persisted before the stamp shipped, resuming for the first time — exactly the
 * mailboxes that reported the symptom. For the RESUME it must read as stale: the cost of being
 * wrong is one snapshot page, and the cost of being wrong the other way is the whole oldest-first
 * replay. For the LABEL it must read as `unknown`: there is no time to put in "as of …", and a
 * surface that invented one would be lying about a fact it does not have.
 *
 * An UNPARSEABLE stamp reads as stale for the same reason: the stamp is the driver's own write,
 * so corruption is answered by freshening and re-stamping rather than by trusting it.
 *
 * The caller supplies the cold/bootstrap gate — see the module header.
 */
export function mirrorStale(
  lastDrainAt: string | null | undefined,
  now: Date,
  staleMs: number = STALE_RESUME_MS,
): boolean {
  if (lastDrainAt === undefined || lastDrainAt === null) return true;
  const t = Date.parse(lastDrainAt);
  return Number.isNaN(t) || now.getTime() - t > staleMs;
}

/**
 * WHAT A SURFACE MAY SAY ABOUT THIS MIRROR'S AGE — the one derivation of the Freshness
 * Contract's three states (see {@link FreshnessState}), from the drain's own completion stamp on
 * the driver's own clock.
 *
 * Every surface reads THIS: the webapp and the phone through `OhmailEngine.freshness()`, the
 * desktop window through the sidecar's `GET /mirror/freshness`. Three renderers, one derivation,
 * so "the label is showing" and "the resume freshens newest-first" are a single fact observed
 * twice rather than two opinions that can drift.
 *
 * The threshold comparison is {@link mirrorStale}'s, minus its absent-is-stale arm — see that
 * function for why the two answers about a missing stamp are deliberately different.
 */
export function mirrorFreshness(
  lastDrainAt: string | null | undefined,
  now: Date,
  staleMs: number = STALE_RESUME_MS,
): MirrorFreshness {
  if (lastDrainAt === undefined || lastDrainAt === null) return { state: "unknown", asOf: null };
  const t = Date.parse(lastDrainAt);
  // An unparseable stamp is the driver's own corrupted write: report unknown rather than a label
  // with no time in it. The next completed drain re-stamps it, and {@link mirrorStale} has
  // already made sure that drain freshens first.
  if (Number.isNaN(t)) return { state: "unknown", asOf: null };
  return { state: now.getTime() - t > staleMs ? "stale" : "current", asOf: lastDrainAt };
}

/**
 * HOW MANY ROWS THE NEXT `/sync` PAGE MAY CARRY — {@link BACKLOG_PAGE_LIMIT} on a backlog
 * catch-up, the driver's own default otherwise.
 *
 * One line, and it is here rather than inline at two call sites for the reason the constant is:
 * the ask and the freshen must fire on ONE verdict. A freshen without the dense drain leaves the
 * convergence tail; a dense drain without the freshen labels nothing. It is also the seam a
 * future policy change lands on once ("dense only above N rows", say) instead of twice.
 *
 * `defaultLimit` may be `undefined` — that is the engine's steady-state ask, which sends no
 * `limit=` at all and takes the server's own default. The sidecar passes its configured page
 * size. Neither shape is normalised into the other: the point of this function is the verdict,
 * not the number it falls back to. It is GENERIC in the fallback rather than typed
 * `number | undefined` so that a caller passing a number gets a `number` back: the sidecar
 * stringifies this straight into a query parameter, and a widened union there would make
 * `limit=undefined` a shape the types permit.
 */
export function drainPageLimit<T extends number | undefined>(
  staleResume: boolean,
  defaultLimit: T,
): number | T {
  return staleResume ? BACKLOG_PAGE_LIMIT : defaultLimit;
}
