/** @vitest-environment jsdom */
/**
 * ═══ THE SHELL A SIGN-IN OPENS ASKS WHAT THE ACCOUNT IS, AND SETTINGS SHOWS WHAT IT ANSWERED ═══
 *
 * Measured on the live Cloud: after a sign-in with password and code, Settings
 * listed no Subscription pane until a reload, and the boot read no `GET /account/access`. The
 * signed-out `/login` visit latches the session death (its session read refreshes into a coded
 * 401), the sign-in is a client-side navigation, and the new shell's mount reads were refused
 * before the wire. Driven here as the app navigates it: the `/login` read, the second factor
 * through the real client, then the real `CloudShell` in the same module state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT, coded401, installConfirmEnv, messages, mountCloudShell, refresh204, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";
import { resetSessionTruthForTests, sessionIsDead } from "@ohmail/app-logic/session/session-truth";

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

/** A paid hosted account the entitlements program lets in. */
const METERED_OPEN = { metered: true, access: "open", canAddMailbox: true, mailboxes: 3, aiEnabled: true };

let accessReads = 0;

beforeEach(async () => {
  // Settings is a lazy view; loaded here so a fake-timer tick is not racing a module transform.
  await import("../app/views/SettingsView");
  resetSessionTruthForTests();
  installConfirmEnv();
  const { bindApiOwner, forgetAccess } = await import("../app/api-client");
  bindApiOwner(null);
  forgetAccess();
  accessReads = 0;
  const fixture = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/account/access")) {
      accessReads += 1;
      return json(METERED_OPEN);
    }
    if (url.includes("/auth/2fa/totp/verify")) {
      // What the answer's `Set-Cookie` leaves script-readable: a fresh double-submit token.
      document.cookie = "tf_csrf=csrf-minted-by-the-sign-in; Path=/";
      return json({
        user: { userId: "usr_confirm_1", accountId: ACCOUNT, email: "confirm@example.invalid" },
        scope: "full",
      }, { "X-Ohmail-Account": ACCOUNT });
    }
    return fixture(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  await teardownConfirmEnv();
  resetSessionTruthForTests();
});

const navLabels = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".view-settings .set-nav button")].map((b) => b.textContent ?? "");

describe("the first screen after a sign-in", () => {
  it("reads the account's access and lists Subscription, with no reload", async () => {
    // `/login`, signed out: the ladder's session read, its refresh, and the coded 401 of each.
    scriptSession(coded401);
    scriptRefresh(coded401);
    const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome");
    expect((await resolveOwnerOutcome()).kind).toBe("none");
    expect(sessionIsDead(), "premise: the signed-out /login visit latches the death").toBe(true);

    // The second factor, through the real client, answered as the server answers it.
    const { auth } = await import("../app/api-client");
    await auth.totpVerify({ loginToken: "lt_confirm_1", code: "123456" });

    // `router.push("/")`: the same module state under a freshly mounted shell.
    scriptSession(sessionFull);
    scriptRefresh(refresh204);
    window.location.hash = "#/settings";
    const el = await mountCloudShell();
    await tick(3_000);

    expect(accessReads, "the boot after a sign-in never read /account/access").toBeGreaterThan(0);
    expect(navLabels(el), "Settings has no Subscription pane after a sign-in").toContain(messages.settings.billing);
  });

  it("control: a reload's boot (no latch carried in) lists Subscription too", async () => {
    scriptSession(sessionFull);
    document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
    window.location.hash = "#/settings";
    const el = await mountCloudShell();
    await tick(3_000);

    expect(accessReads).toBeGreaterThan(0);
    expect(navLabels(el)).toContain(messages.settings.billing);
  });
});
