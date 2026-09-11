/**
 * The network, removed from the page. The Tauri CSP already forbids every connection
 * (`connect-src 'none'`); this is the third lock and the only one observable from inside the
 * app: every browser API capable of leaving the process is replaced with a function that
 * throws. That is what makes the promise TESTABLE — `scripts/smoke.mjs` loads the real built
 * bundle in a headless browser and asserts nothing was requested and that `fetch` throws — and
 * what makes the LOCAL ENGINE build's wiring loud: the client's HTTP adapter falls back to the
 * global `fetch` when nothing is injected, and here that fallback is a thrower naming this
 * file. Installed from `main.tsx` before React mounts.
 */

/*
 * THE ONE ADDRESS REFUSED DIFFERENTLY: the shell's command channel is IMPLEMENTED with a fetch
 * — each command is a POST to a custom scheme (`ipc://localhost/…`; `http://ipc.localhost/…`
 * on Windows) answered by the app's own process. The runtime recovers from a CSP-refused
 * scheme when the attempt REJECTS, falling back to the webview's message channel, which cannot
 * address anything at all; a synchronous throw skips that recovery, because the recovery is a
 * rejection handler — it would not make the app more offline, only break the bridge. So this
 * address REJECTS instead: the custom-scheme request is never made, every command travels the
 * channel with no network in it, and every other address still throws where it is called.
 */

const REFUSAL =
  "ohmail Desktop is offline by construction — this build has no network layer. " +
  "See apps/desktop/src/offline-guard.ts.";

const IPC_REFUSAL =
  "ohmail Desktop refuses the webview's custom-scheme IPC transport — see " +
  "apps/desktop/src/offline-guard.ts. Commands travel the message channel instead.";

type Guarded = { __ohmailOfflineGuard?: true };

function refuse(): never {
  throw new Error(REFUSAL);
}

/**
 * Is this the shell's own command channel rather than an address on the network?
 *
 * Matched on the scheme and the host, both of which the runtime composes itself
 * and neither of which resolves anywhere: `ipc` is a scheme the app registers in
 * its own process, and `ipc.localhost` is the Windows spelling of the same
 * thing.
 */
const SHELL_CHANNEL = /^(?:ipc:\/\/|https?:\/\/ipc\.localhost(?:[/:?#]|$))/;

export function isShellCommandChannel(target: unknown): boolean {
  const raw =
    typeof target === "string"
      ? target
      : String((target as { url?: unknown } | null)?.url ?? target ?? "");
  /* Anchored, and the host is terminated: `https://ipc.localhost.example.invalid/` is a name
     somebody else can register and it is NOT this channel. A prefix match would have let it
     through — which is how a carve-out written for one address quietly becomes a carve-out for a
     family of them. */
  return SHELL_CHANNEL.test(raw);
}

/** Replace `name` on `target` with a thrower, if it is there at all. */
function seal(target: Record<string, unknown>, name: string): void {
  if (!(name in target)) return;
  const stub = function (...args: unknown[]): never | Promise<never> {
    /* The one address refused as a rejection rather than a throw. See the header. */
    if (name === "fetch" && isShellCommandChannel(args[0])) {
      return Promise.reject(new Error(IPC_REFUSAL));
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
    /* a host that refuses the redefinition still has connect-src 'none' */
  }
}

export function installOfflineGuard(scope: Record<string, unknown> = globalThis as never): void {
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) seal(scope, name);

  const nav = (scope as { navigator?: Record<string, unknown> }).navigator;
  if (nav && typeof nav.sendBeacon === "function") seal(nav, "sendBeacon");
}

/** True when `installOfflineGuard` has run in this realm — asserted by the smoke test. */
export function offlineGuardInstalled(scope: Record<string, unknown> = globalThis as never): boolean {
  return (scope.fetch as Guarded | undefined)?.__ohmailOfflineGuard === true;
}
