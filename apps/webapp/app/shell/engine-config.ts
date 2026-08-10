import {
  FixturesAdapter,
  HttpAdapter,
  IndexedDbMirrorStore,
  OhmailEngine,
  purgeLegacyMirror,
  type StorePolicy,
} from "@ohmail/client-engine";
import { createSyncGate, registerSyncGate } from "./sync-scheduler";

/**
 * THE ENGINE DECISION, extracted so it can be TESTED rather than described.
 *
 * This function used to live inside `engine.tsx`, which is a `"use client"` module that
 * pulls in React and the whole provider. `demo-gate.test.ts` could therefore only assert
 * the demo promise STRUCTURALLY — by matching source text — which proves the code says the
 * right thing and not that it does it. The promise is "`?demo=1` ⇒ fixtures only, zero
 * network, nothing leaves this tab" — a self-contained surface makes no external request at
 * all — and that is a claim about
 * BEHAVIOUR: the only convincing test constructs the engine, runs it, and watches the
 * network.
 *
 * So the decision moved here, to a plain module with no React in it, and
 * `demo-zero-network.test.ts` drives it: build with `demo: true`, `start()`, mutate, and
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
}

/** The build-time API base, read once. `undefined` ⇒ this build has no server. */
const BUILD_ENV: EngineEnv = { NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE };

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
      adapter: gate.guard(new HttpAdapter({ baseUrl: apiBase })),
      ...(persist ? { store: new IndexedDbMirrorStore({ owner: owner! }) } : {}),
      storePolicy: BROWSER_WINDOW,
    }),
    gate,
  );
}
