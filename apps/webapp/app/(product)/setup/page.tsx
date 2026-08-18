import { SetupScreen } from "./SetupScreen";

/**
 * `/setup` — the self-host FIRST-RUN ceremony (see `SetupScreen.tsx` for the whole design).
 *
 * A plain client screen with NO server-side inputs, deliberately: the one credential this page
 * handles — the setup token — is pasted into a form, never carried in a URL, so there is
 * nothing to read here and nothing for history, referrers or access logs to retain.
 * `middleware.ts` serves the path under the strict nonce CSP with `no-referrer`/`no-store`,
 * the same treatment every credential screen gets.
 *
 * The page is mounted on EVERY deployment (one route tree, one bundle) and gated by the
 * SERVER: the screen renders its form only after a fresh `GET /hello` answers
 * `needsSetup: true`, which the managed service never does and a self-host box does exactly
 * once. On anything else it renders "already set up" — a truthful page, not a 404, because the
 * self-host guides name this address.
 */
export default function SetupPage() {
  return <SetupScreen />;
}
