/**
 * The network, removed from the page. The window's CSP names one connection source, the app's own
 * in-process command scheme (`src/window-csp.ts`); this is the second lock and the only one
 * observable from inside the app: every browser API capable of leaving the process is replaced
 * with a function that throws. That is what makes the promise TESTABLE — `scripts/smoke.mjs`
 * loads the real built bundle and asserts it — and what makes the LOCAL ENGINE build's wiring
 * loud: the client's HTTP adapter falls back to the global `fetch` when nothing is injected, and
 * here that fallback is a thrower naming this file. Installed from `main.tsx` before React mounts.
 */

/*
 * THE ONE ADDRESS HANDED ON: Tauri implements every command as a POST to its own scheme, answered
 * by this app's process — `ipc://localhost/<command>`, `http://ipc.localhost/<command>` on Windows.
 * The sealed `fetch` passes exactly this build's spelling, as a string, to the original and nothing
 * else. The other platform's spelling is an ordinary host name there (on Linux and macOS
 * `ipc.localhost` resolves to loopback port 80), so it throws like every other address. The CSP
 * admits the same one spelling; it is the lock, because a script can reach a pristine `fetch`.
 */

import { BUILD_PLATFORM } from "./platform.js";
import { commandChannelOf } from "./window-csp.js";

const REFUSAL =
  "ohmail Desktop is offline by construction — this build has no network layer. " +
  "See apps/desktop/src/offline-guard.ts.";

type Guarded = { __ohmailOfflineGuard?: true };

function refuse(): never {
  throw new Error(REFUSAL);
}

/**
 * Is `target` this build's own command channel, as the runtime composes it? A string only: `fetch`
 * stringifies anything else itself, so a `Request` or an object carrying a `url` could name one
 * address to this check and another to the network.
 */
export function isOwnCommandChannel(target: unknown, platform: string = BUILD_PLATFORM): boolean {
  const own = commandChannelOf(platform);
  return own !== null && typeof target === "string" && target.startsWith(own.prefix);
}

/** Replace `name` on `target` with a thrower, if it is there at all. */
function seal(target: Record<string, unknown>, name: string, platform: string): void {
  if (!(name in target)) return;
  const original = target[name];
  const stub = function (...args: unknown[]): unknown {
    if (name === "fetch" && typeof original === "function" && isOwnCommandChannel(args[0], platform)) {
      return (original as (...a: unknown[]) => unknown).apply(target, args);
    }
    return refuse();
  };
  (stub as unknown as Guarded).__ohmailOfflineGuard = true;
  try {
    Object.defineProperty(target, name, {
      value: stub,
      writable: true,
      configurable: true,
    });
  } catch {
    /* a host that refuses the redefinition still has its CSP */
  }
}

/** `platform` is the build's (`__OHMAIL_PLATFORM__`); a test names one. Unknown: nothing passes. */
export function installOfflineGuard(
  scope: Record<string, unknown> = globalThis as never,
  platform: string = BUILD_PLATFORM,
): void {
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) seal(scope, name, platform);

  const nav = (scope as { navigator?: Record<string, unknown> }).navigator;
  if (nav && typeof nav.sendBeacon === "function") seal(nav, "sendBeacon", platform);
}

/** True when `installOfflineGuard` has run in this realm — asserted by the smoke test. */
export function offlineGuardInstalled(scope: Record<string, unknown> = globalThis as never): boolean {
  return (scope.fetch as Guarded | undefined)?.__ohmailOfflineGuard === true;
}
