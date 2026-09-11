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
 * The engine decision, extracted so it can be TESTED rather than described. Inside `engine.tsx` (a `"use client"`
 * module) the demo promise could only be asserted structurally, by matching source text; the promise — `?demo=1` ⇒
 * fixtures only, zero network — is about behaviour. So the decision lives in a plain module and
 * `test/demo-zero-network.test.ts` drives it: build with `demo: true`, `start()`, mutate, assert
 * `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource` were touched exactly zero times, with a control proving the live
 * engine would have been caught. `env` is a parameter: Next inlines `process.env.NEXT_PUBLIC_API_BASE` at build time,
 * so taking it as an argument is what lets a test exercise both branches — including the one that must never run
 * under `?demo=1`. "The client may turn the demo ON, never OFF" still lives in `engine.tsx`, where the URL is.
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
 * Should the sync scheduler treat "hidden" as meaningful at all? `startSyncScheduler` gates on
 * `document.visibilityState` — right for a tab, wrong for the desktop app: a Tauri window the OS composites out
 * of view (occluded, another Space, merely unfocused) also reads `"hidden"`, so the shared shell would slow a
 * mail client that must stay current to the one-drain-a-minute cadence — mail a minute late unless you click
 * the window. `visibility: null` is the scheduler's own seam for "this environment has no visibility model". A
 * BUILD flag, not a prop: a prop buys a silent-omission mode — a shell that forgets it loads fine and quietly
 * never syncs in the background. The web build never defines `NEXT_PUBLIC_DESKTOP`; a web-side test greps
 * `syncsWhileHidden` so the flag cannot leak into the default environment.
 */
export function syncsWhileHidden(env: EngineEnv = BUILD_ENV): boolean {
  return env.NEXT_PUBLIC_DESKTOP === "1";
}

/**
 * The wake stream decision — which builds hold an `EventSource` on `/events`, decided here so it
 * can be tested rather than described. A factory, or `null` for "this build polls". Three
 * refusals: the desktop build ({@link syncsWhileHidden}) — its API base is the local engine
 * process, which serves no `/events`; no API base — nothing to connect to; no `EventSource` in the
 * environment (SSR, jsdom) — a null is honest where a throw is an event. The demo never reaches
 * this: `engine.tsx` schedules live engines only. The scheduler owns everything after construction
 * — one stream while visible, none hidden, permanent fallback to polling on a terminal refusal;
 * `sync-scheduler.ts`'s header carries the three-state model.
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
 * A live engine was asked for and this build has no server to point it at. `createEngine` used to answer with a
 * `FixturesAdapter` — the branch `?demo=1` takes — and the two situations must never share an outcome: `?demo=1` is
 * somebody ASKING for Mila's fictional world, while `demo: false` with no API base is a MISCONFIGURED BUILD.
 * Answering the latter with fixtures hands a signed-in, paying customer a stranger's invented mailbox, renders it in
 * the live chrome (no demo ribbon — `AppShell` reads the engine's mode), and accepts their clicks as though they were
 * organising their own mail. It looks like it works, which makes it the worst failure shape in this product: a
 * missing environment variable must never SELECT the demo. So the unarmed live request throws, loudly, at
 * construction.
 */

/**
 * Second ring by design — `next.config.mjs` refuses to BUILD a production bundle with no `TF_API_ORIGIN`
 * (`assertApiArmed`); this is the ring that holds if the first is configured away, and the one a test can drive
 * directly.
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
 * How much of the mailbox the browser keeps on disk — the ninety-day window, plus a floor. The browser's mirror is a
 * CACHE in front of a server that holds everything; the desktop tier's mirror is the mail itself. `StorePolicy`
 * defaults to `full` so a host configuring nothing keeps every message (pruning by omission would be a data-loss
 * default), so this line is the ONLY thing between a browser and a mirror that grows without bound. `minRows` is not
 * a rounding of `days` but the floor keeping them independent: a mailbox quiet for four months would otherwise evict
 * itself to nothing and render an empty app. Whichever keeps MORE mail wins. Nothing is lost by pruning —
 * `MirrorStore.prune` deletes rather than tombstones, so an evicted row is one `/sync` change away, and older mail is
 * reachable through `OhmailEngine.listOlder`.
 */

/**
 * A named constant so the test pinning it to the live path can name it too: dropping the option leaves a working app
 * whose only symptom is a mirror that quietly regrows to the whole mailbox, months later, on somebody else's machine.
 */
export const BROWSER_WINDOW = { mode: "windowed", days: 90, minRows: 5000 } as const satisfies StorePolicy;

/**
 * Build the engine for a resolved mode. `demo` WINS over everything: checked first, and no
 * configuration, environment variable or argument can make a `demo: true` call return an engine
 * with an `HttpAdapter` — the whole safety property, and why the condition is `!demo && apiBase`
 * rather than any arrangement consulting the base first. The demo engine also gets NO mirror
 * store: `IndexedDbMirrorStore` would persist a fixture world into the visitor's browser, and
 * "nothing leaves this tab" should also mean "nothing stays behind in it".
 */

/**
 * `owner` is the persistence key, and `null` means "do not persist". This used to build `new IndexedDbMirrorStore()`
 * with no arguments — ONE database name, `ohmail-mirror`, for every account that ever signed in on a given browser.
 * Two accounts on a shared browser therefore shared a cursor and persisted records; `/sync` is account-filtered but
 * only MERGES pages, so the first account's mail rendered to the second. The account id is now a REQUIRED argument
 * for the persistent path, and it must be one the SERVER confirmed — `app/shell/engine.tsx` gets it from `GET
 * /auth/session` and does not render the shell until it has it. `null` is legal and gives a live engine with an
 * in-memory mirror: correct for a session whose owner is not yet known, never the shipped path.
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
   * THE LIVE TRANSPORT IS GATED, and only the live one. `engine.syncOnce()` pages internally until `hasMore` is
   * false, so the scheduler's visibility gate could decide whether a drain STARTED and never whether it continued — a
   * hidden or closed tab kept issuing the remaining pages of a bootstrap. The gate wraps the adapter here because
   * `adapter.sync()` IS the page boundary; the scheduler claims it and refuses the next page while its loop has been
   * torn down. Read `sync-scheduler.ts` for why the association goes through a `WeakMap` rather than this function's
   * return type. IT ALSO CARRIES THE MIRROR'S NAME, which is the second question it answers. `/sync` returns no
   * account identity, and the engine writes what comes back straight into `ohmail-mirror:<owner>` — so a page fetched
   * under a session belonging to somebody else lands in this account's mailbox and stays there.
   */

  /**
   * The gate is built CLOSED for a named mirror and opens only when the confirm names an account equal to `owner`; it
   * re-reads `tf_owner` on every request, so a browser that signs into another account mid-session stops this loop
   * instead of feeding it. The demo returns above, so it never gets one: it has no transport to gate.
   */
  /*
   * THE MIRROR'S NAME, handed to the gate — this is the whole of the identity half.
   *
   * `owner` is the same value that names the IndexedDB database below, so the gate can ask
   * "is the account this browser's session belongs to the account this mirror is FOR?" without
   * anything new on the wire. `undefined` (the demo path returns earlier; an embedder that
   * builds an un-named engine) becomes `null`, which the gate reads as "no mirror on disk to
   * pollute" and leaves open.
   */
  const gate = createSyncGate(owner ?? null);
  return registerSyncGate(
    new OhmailEngine({
      /**
       * `stageAttachments: true` — THE HOSTED BROWSER CLIENT, and only it. A send whose attachment bytes exceed what
       * the inline transport can carry mints an upload ticket per file, PUTs the bytes straight into storage, and
       * sends references. That is what lets this window's compose form promise the sending mailbox's own announced
       * limit rather than the ~4.5 MB serverless request cap expressed as 3 MB of raw bytes. It is set HERE and
       * nowhere else. The desktop builds its adapter in `apps/desktop/src/bridge-fetch.ts` with no options beyond a
       * base URL and a bridge fetch, so neither of its doors stages: the standalone door has no hosted storage behind
       * it and no business writing into one, and the Cloud door forwards this request verbatim to the hosted API — a
       * shipped build must keep sending the shape it has always sent.
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
