import {
  FixturesAdapter,
  HttpAdapter,
  IndexedDbMirrorStore,
  OhmailEngine,
  purgeLegacyMirror,
  type StorePolicy,
} from "@ohmail/client-engine";
import { createSyncGate, registerSyncGate, type WakeStreamLike } from "./sync-scheduler";

/**
 * THE ENGINE DECISION, extracted so it can be TESTED rather than described.
 *
 * This function used to live inside `engine.tsx`, which is a `"use client"` module that
 * pulls in React and the whole provider. `test/demo-gate.test.ts` could therefore only assert
 * the demo promise STRUCTURALLY — by matching source text — which proves the code says the
 * right thing and not that it does it. The promise is "`?demo=1` ⇒ fixtures only, zero
 * network, nothing leaves this tab" — a self-contained surface makes no external request at
 * all — and that is a claim about
 * BEHAVIOUR: the only convincing test constructs the engine, runs it, and watches the
 * network.
 *
 * So the decision moved here, to a plain module with no React in it, and
 * `test/demo-zero-network.test.ts` drives it: build with `demo: true`, `start()`, mutate, and
 * assert that `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` were touched exactly
 * zero times — with a control that builds the LIVE engine and proves the same assertions
 * would have caught a request. `engine.tsx` imports this and is otherwise unchanged; the
 * "the client may turn the demo ON, never OFF" rule still lives there, where the URL is.
 *
 * ── `env` IS A PARAMETER ────────────────────────────────────────────────────────────────
 *
 * Next inlines `process.env.NEXT_PUBLIC_API_BASE` at BUILD time, so in a bundle it is a
 * literal and cannot be varied. Taking it as an argument (defaulted to the inlined value)
 * changes nothing about the shipped behaviour and is what lets a test exercise both
 * branches in one process — including the branch that must NEVER be taken under `?demo=1`,
 * which is the one that matters.
 */
export interface EngineEnv {
  NEXT_PUBLIC_API_BASE?: string;
  /**
   * `"1"` only in a DESKTOP build — set by `apps/desktop/vite.config.ts`'s `define`, absent from
   * the Next web build. Read through {@link syncsWhileHidden}; see it for what it decides and why
   * it is a build flag rather than a prop.
   */
  NEXT_PUBLIC_DESKTOP?: string;
}

/** The build-time environment, read once. */
const BUILD_ENV: EngineEnv = {
  NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
  NEXT_PUBLIC_DESKTOP: process.env.NEXT_PUBLIC_DESKTOP,
};

/**
 * SHOULD THE SYNC SCHEDULER TREAT "HIDDEN" AS MEANINGFUL AT ALL?
 *
 * `startSyncScheduler` gates on `document.visibilityState`: a browser tab that goes to the
 * background drops to the slow hidden cadence — one drain a minute, no wake stream held
 * (`sync-scheduler.ts`; it was ZERO syncs before the realtime-wake slice). That rule is right
 * for a tab and wrong for the desktop
 * app: a Tauri window the OS composites out of view — occluded by another window, on another
 * Space, or merely unfocused — ALSO reads `visibilityState: "hidden"`, so the shared shell would
 * silently slow a mail client that is supposed to stay current in the background to the
 * background cadence. The symptom is mail that arrives a minute late unless you click the window.
 *
 * The fix is the scheduler's existing seam: passing `visibility: null` tells it "this environment
 * has no visibility model", so `visible()` is always true and the loop never slows for occlusion.
 * `engine.tsx` passes it exactly when this returns true.
 *
 * ── A BUILD FLAG, FOLDED HERE — NOT A PROP ──────────────────────────────────────────────────
 *
 * The desktop-versus-web distinction is a property of the BUILD, so it is a build-time flag read
 * here rather than a prop threaded down from the shell. A prop buys only a silent-omission mode —
 * a shell that forgets to pass it loads fine and then quietly never syncs in the background, which
 * is the very bug re-created as a wiring bug (the same reasoning `engine.tsx` gives for wiring the
 * scheduler inside the provider). The Next web build never defines `NEXT_PUBLIC_DESKTOP`, so this
 * is false there and browser tabs keep their hidden cadence; only a desktop build turns it on.
 * A web-side test (grep `syncsWhileHidden` in this app's test suite) fails if the flag ever leaks
 * into the default (web) environment.
 */
export function syncsWhileHidden(env: EngineEnv = BUILD_ENV): boolean {
  return env.NEXT_PUBLIC_DESKTOP === "1";
}

/**
 * THE WAKE STREAM DECISION — which builds hold an `EventSource` on `/events`, decided here so
 * it can be tested rather than described (this file's whole reason to exist).
 *
 * A factory, or `null` for "this build polls". Three refusals, each a different reason:
 *
 *  · **The desktop build** ({@link syncsWhileHidden}): its API base is the LOCAL engine
 *    process, which serves no `/events` — the hosted door's wake lives in that process
 *    itself, which holds the session and kicks its mirror pull per frame. Opening a stream
 *    here would buy one guaranteed refusal per launch and nothing after it.
 *  · **No API base**: nothing to connect to. (`createEngine` throws for the live path anyway;
 *    this keeps the factory decision total rather than partial.)
 *  · **No `EventSource` in the environment** (SSR, jsdom): the scheduler treats a throwing
 *    factory as a dead stream, but "this build cannot push" is a fact known HERE, and a null
 *    is honest where a throw is an event.
 *
 * The DEMO never reaches this: `engine.tsx` schedules live engines only, and the demo takes
 * the bare `engine.start()` path — a self-contained surface holds no connection to anything.
 *
 * The scheduler owns everything after construction: one stream while visible, none while
 * hidden, permanent fallback to polling on a terminal refusal (the production default — the
 * server's SSE flag is off until the deploy flips it, and the refusal costs one request per
 * session). `sync-scheduler.ts`'s header carries the three-state model.
 */
export function cloudWakeStream(
  env: EngineEnv = BUILD_ENV,
): (() => WakeStreamLike) | null {
  if (syncsWhileHidden(env)) return null;
  // Deliberately NOT spelled the way `createEngine` reads the same variable (a local named
  // `apiBase`): `test/api-rewrite.test.ts` pins the ORDER of that exact line against the demo gate
  // by `indexOf`, so an identical occurrence above the gate — even in a comment — would
  // satisfy the grep for the wrong function and the guard would stop guarding.
  const base = env.NEXT_PUBLIC_API_BASE;
  if (!base) return null;
  if (typeof EventSource === "undefined") return null;
  // Same-origin (`/api/events` through the rewrite), so the session cookie rides along without
  // `withCredentials` — the same reason every other engine request needs no auth wiring here.
  return () => new EventSource(`${base}/events`);
}

/**
 * A live engine was asked for and this build has no server to point it at.
 *
 * THE FAILURE THIS EXISTS TO MAKE IMPOSSIBLE. `createEngine` used to answer that request
 * with a `FixturesAdapter` — the same branch `?demo=1` takes. The two situations are not
 * alike and must never share an outcome:
 *
 *  · `?demo=1` is somebody ASKING for Mila's fictional world. Fixtures are the right answer.
 *  · `demo: false` with no API base is a MISCONFIGURED BUILD. Answering it with fixtures
 *    hands a signed-in, paying customer a stranger's invented mailbox, renders it in the
 *    live chrome (no demo ribbon — `AppShell` reads the engine's mode, and the mode is
 *    `false`), and accepts their clicks as though they were organising their own mail.
 *
 * It looks like it works, which is what makes it the worst failure shape in this product.
 * A missing environment variable must never be able to SELECT the demo; the demo is opted
 * into, by a URL or by `NEXT_PUBLIC_DEMO`, and by nothing else. So the unarmed live request
 * throws, loudly, at the moment the engine is constructed.
 *
 * This should be unreachable in a deployed build — `next.config.mjs` refuses to BUILD a
 * production bundle with no `TF_API_ORIGIN` (`assertApiArmed`), which is the guard that
 * actually stops it shipping. This is the second ring: the one that holds if the first is
 * ever configured away, and the one a test can drive directly.
 */
export class EngineUnarmedError extends Error {
  constructor() {
    super(
      "ohmail: a live engine was requested but this build has no NEXT_PUBLIC_API_BASE. " +
        "Refusing to fall back to demo fixtures — set TF_API_ORIGIN and rebuild, or ask for " +
        "the demo explicitly with ?demo=1.",
    );
    this.name = "EngineUnarmedError";
  }
}

/**
 * HOW MUCH OF THE MAILBOX THE BROWSER KEEPS ON DISK — the ninety-day window, plus a floor.
 *
 * The browser's mirror is a CACHE in front of a server that still holds everything; the desktop
 * tier's mirror is the mail itself. `StorePolicy` defaults to `full` precisely so that a host
 * which configures nothing keeps every message — a policy that pruned by omission would be a
 * data-loss default — and the consequence is that this line is the ONLY thing standing between a
 * browser and a mirror that grows without bound. IndexedDB has a quota; a mailbox does not care.
 *
 * `minRows` is not a rounding of `days`, it is the floor that keeps them independent: a mailbox
 * that has been quiet for four months would otherwise evict itself down to nothing and render an
 * empty app to somebody whose mail is all present on the server. Whichever of the two keeps MORE
 * mail wins, every time.
 *
 * Nothing is lost by pruning. `MirrorStore.prune` deletes rather than tombstones, so an evicted
 * row is one `/sync` change or one re-snapshot away — and the mail past the window is reachable
 * directly through `OhmailEngine.listOlder`, which is the other half of this decision.
 *
 * It is a NAMED CONSTANT rather than an inline literal so that the test pinning it to the live
 * path can name it too. The risk this guards is one-sided and silent: dropping the option leaves
 * a working, correct, fully-tested app whose only symptom is a mirror that quietly regrows to the
 * whole mailbox, months later, on somebody else's machine.
 */
export const BROWSER_WINDOW = { mode: "windowed", days: 90, minRows: 5000 } as const satisfies StorePolicy;

/**
 * Build the engine for a resolved mode.
 *
 * `demo` WINS over everything. It is checked first and there is no configuration, no
 * environment variable and no argument that can make a `demo: true` call return an engine
 * with an `HttpAdapter` — which is the whole safety property, and the reason the condition
 * is `!demo && apiBase` rather than `apiBase && !demo` or any arrangement where the base
 * is consulted first.
 *
 * The demo engine also gets NO mirror store: `IndexedDbMirrorStore` would persist a
 * fixture world into the visitor's browser, and "nothing leaves this tab" should also mean
 * "nothing stays behind in it".
 *
 * ── `owner` IS THE PERSISTENCE KEY, AND `null` MEANS "DO NOT PERSIST" ────────────────────
 *
 * This function used to build `new IndexedDbMirrorStore()` with no arguments, which took
 * the store's default database name — ONE name, `ohmail-mirror`, for every account that
 * ever signed in on a given browser. The option's own doc comment said "one mirror per
 * account should use a distinct name" and nothing supplied one. Two accounts on a shared
 * browser therefore shared a cursor and a set of persisted records; `/sync` is
 * account-filtered but it only MERGES pages, so nothing removed the first account's mail
 * and it rendered to the second.
 *
 * So the account id is now a REQUIRED argument for the persistent path, and it must be one
 * the SERVER confirmed — `app/shell/engine.tsx` gets it from `GET /auth/session` and does
 * not render the shell until it has it. Passing `null` is legal and gives a live engine
 * with an in-memory mirror: correct for a session whose owner is not yet known, because
 * nothing it holds outlives the tab. It is never the shipped path.
 */
export function createEngine(
  demo: boolean,
  env: EngineEnv = BUILD_ENV,
  owner: string | null = null,
): OhmailEngine {
  // `demo` FIRST, and it returns — so there is no configuration, no environment variable
  // and no argument that can make a `demo: true` call yield an `HttpAdapter`. Unchanged in
  // effect from the old `!demo && apiBase` ordering; spelled as an early return because the
  // branch below now throws, and "the demo is decided before anything can fail" has to stay
  // obvious.
  // No `storePolicy` here either, and that is not an oversight: the absent branch is `full`, the
  // demo has no persistent mirror to prune, and a window over a hand-made fixture world could
  // only ever delete part of the story Mila is being shown.
  if (demo) return new OhmailEngine({ adapter: new FixturesAdapter() });

  // FIXTURES ARE NOT A FALLBACK. See {@link EngineUnarmedError}: reaching here without a
  // base used to return the demo world to a real signed-in account, silently.
  const apiBase = env.NEXT_PUBLIC_API_BASE;
  if (!apiBase) throw new EngineUnarmedError();

  const persist = owner !== null && typeof indexedDB !== "undefined";
  if (persist) {
    // Fire-and-forget, once per engine: the pre-repair database is not ours to read and
    // is not something to leave lying on the origin. It is never opened, only deleted.
    void purgeLegacyMirror().catch(() => {
      /* blocked by another tab, or storage refused — hygiene, not an invariant */
    });
  }
  /**
   * THE LIVE TRANSPORT IS GATED, and only the live one.
   *
   * `engine.syncOnce()` pages internally until `hasMore` is false, so the scheduler's
   * visibility gate could decide whether a drain STARTED and never whether it continued — a
   * hidden or closed tab kept issuing the remaining pages of a bootstrap. The gate wraps the
   * adapter here because `adapter.sync()` IS the page boundary; the scheduler claims it and
   * refuses the next page while the tab is hidden or its loop has been torn down. Read
   * `sync-scheduler.ts` for why the association goes through a `WeakMap` rather than this
   * function's return type.
   *
   * The demo returns above, so it never gets one: it has no transport to gate.
   */
  const gate = createSyncGate();
  return registerSyncGate(
    new OhmailEngine({
      /**
       * `stageAttachments: true` — THE HOSTED BROWSER CLIENT, and only it.
       *
       * A send whose attachment bytes exceed what the inline transport can carry mints an upload
       * ticket per file, PUTs the bytes straight into storage, and sends references. That is what
       * lets this window's compose form promise the sending mailbox's own announced limit rather
       * than the ~4.5 MB serverless request cap expressed as 3 MB of raw bytes.
       *
       * It is set HERE and nowhere else. The desktop builds its adapter in
       * `apps/desktop/src/bridge-fetch.ts` with no options beyond a base URL and a bridge fetch,
       * so neither of its doors stages: the standalone door has no hosted storage behind it and no
       * business writing into one, and the Cloud door forwards this request verbatim to the hosted
       * API — a shipped build must keep sending the shape it has always sent.
       */
      adapter: gate.guard(new HttpAdapter({ baseUrl: apiBase, stageAttachments: true })),
      ...(persist ? { store: new IndexedDbMirrorStore({ owner: owner! }) } : {}),
      storePolicy: BROWSER_WINDOW,
      /**
       * EAGER RECENT-WINDOW HYDRATION — the live browser client opts in (ruling 2026-08-21).
       * After each settled drain the engine prefetches bodies for the mirror's newest messages,
       * so opening recent mail costs no round trip at the moment of intent — measured at
       * ~100 ms warm and seconds on a serverless cold start per body before this. Bounded and
       * admission-gated in the engine (`EAGER_BODIES_MAX`, `bodyPlan`); ready bodies persist in
       * the IndexedDB mirror above, which is what makes re-opens instant across sessions. The
       * demo returns above and never prefetches: its fixture rows already carry their bodies.
       */
      eagerBodies: true,
    }),
    gate,
  );
}
