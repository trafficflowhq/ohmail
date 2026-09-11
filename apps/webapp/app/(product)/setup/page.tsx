import { SetupScreen } from "./SetupScreen";

/**
 * `/setup` — the self-host first-run ceremony (design in `SetupScreen.tsx`). A plain client screen
 * with NO server-side inputs, deliberately: the one credential — the setup token — is pasted into a
 * form, never carried in a URL, so there is nothing for history, referrers or access logs to
 * retain; `middleware.ts` serves the path under the strict nonce CSP with `no-referrer`/`no-store`.
 * Mounted on EVERY deployment (one route tree, one bundle) and gated by the SERVER: the form
 * renders only after a fresh `GET /hello` answers `needsSetup: true`, which the managed service
 * never does and a self-host box does exactly once; on anything else it renders "already set up"
 * — a truthful page, not a 404, because the self-host guides name this address.
 */
export default function SetupPage() {
  return <SetupScreen />;
}
