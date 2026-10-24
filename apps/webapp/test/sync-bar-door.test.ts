/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailState } from "../app/shell/mail-state";

/**
 * THE `stopped` STRIP KNOWS WHICH DOOR IT CAME IN BY.
 *
 * `stopped` is the one sync state that offers a remedy the user must act on: the loop has
 * disarmed itself after our API refused this session and re-made the refusal. On the WEB that
 * refusal is a revoked Cloud session, and "Sign in" at `/login` is exactly right.
 *
 * On the STANDALONE DESKTOP it is not. That build has no Cloud account and no `/login` — its
 * engine runs the real `HttpAdapter` over a local bridge, and the sidecar injects a bearer that
 * ROTATES on restart, so a restart-skew answers 401 and latches `terminal` just as a revocation
 * would. Sending a user with no account to a sign-in page is a dead end. The seam that tells the
 * two apart is `apiConfigured()`, false exactly on the build with no Cloud behind it.
 *
 * Reported false alarm the fix answers: "Sync stopped — this session is no longer authorized. Sign
 * in" shown on a machine that never had an account to sign into.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const STOPPED: MailState = {
  key: "stopped",
  clock: false,
  count: 0,
  total: null,
  reason: null,
  errorCode: null,
  asOf: null,
  address: null,
  minutes: null,
  slow: false,
  screenerCandidate: false,
  pending: 0,
  // The filing report — `null` is the resting value and means the arm has not fired.
  filing: null,
  continuesAtFolder: null,
  settled: true,
  owed: false,
};

let current: MailState = STOPPED;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

// Flipped per test. `apiConfigured()` is SyncBar's only import from the Cloud client, so a
// one-function stand-in is the whole seam.
let cloudDoor = true;
vi.mock("../app/api-client", () => ({
  apiConfigured: () => cloudDoor,
}));

const roots: Root[] = [];
beforeEach(() => {
  cloudDoor = true;
  current = STOPPED;
});
afterEach(() => {
  roots.forEach((r) => r.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
});

async function render(variant?: "rail", setupHref?: string): Promise<HTMLElement> {
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-09T00:00:00.000Z"),
        children: h(SyncBar, { ...(variant ? { variant } : {}), ...(setupHref ? { setupHref } : {}) }),
      }),
    );
  });
  return container;
}

const login = (c: HTMLElement) => c.querySelector<HTMLAnchorElement>('a[href="/login"]');

describe("stopped, on the CLOUD door", () => {
  it("offers the sign-in link — the remedy a revoked Cloud session has", async () => {
    cloudDoor = true;
    const c = await render();
    expect(login(c), "the Cloud sign-in link was dropped").not.toBeNull();
    expect(login(c)!.textContent).toBe(messages.sync.signIn);
    expect(c.textContent).toContain(messages.sync.stopped);
  });

  it("keeps the sign-in link in the rail form too", async () => {
    cloudDoor = true;
    const c = await render("rail");
    expect(login(c), "the rail form dropped the Cloud remedy").not.toBeNull();
  });
});

describe("stopped, on the LOCAL door (standalone desktop)", () => {
  it("renders NO /login link — the remedy is a relaunch, not a dead-end sign-in", async () => {
    cloudDoor = false;
    const c = await render();
    expect(
      login(c),
      "a standalone install with no Cloud account was told to Sign in — the reported false alarm",
    ).toBeNull();
    // …and it says the true thing instead: quit and reopen.
    expect(c.textContent, "the local door lost its repair sentence").toContain(messages.sync.stoppedLocal);
    expect(c.textContent, "the cloud copy leaked onto the local door").not.toContain(messages.sync.stopped);
  });

  it("renders no /login link in the rail form either", async () => {
    cloudDoor = false;
    const c = await render("rail");
    expect(login(c), "the rail form sent a standalone install to /login").toBeNull();
    expect(c.querySelector(".rail-sync"), "the rail strip stayed silent on a stopped loop").not.toBeNull();
  });
});

describe("no mailbox: the link goes where this door connects one", () => {
  const link = (c: HTMLElement) => c.querySelector<HTMLAnchorElement>("a");

  it("on the web, the setup page", async () => {
    current = { ...STOPPED, key: "noMailbox" };
    for (const variant of [undefined, "rail"] as const) {
      const c = await render(variant, "/join");
      expect(link(c)?.getAttribute("href")).toBe("/join");
      expect(link(c)?.textContent).toBe(messages.sync.connect);
    }
  });

  it("in the desktop window, Settings → Mailboxes", async () => {
    current = { ...STOPPED, key: "noMailbox" };
    const c = await render();
    expect(link(c)?.getAttribute("href")).toBe("#/settings/mailboxes");
  });
});
