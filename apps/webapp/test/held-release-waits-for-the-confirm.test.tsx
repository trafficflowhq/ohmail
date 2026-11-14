/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/**
 * A RELEASE PRESSED BEFORE THE ACCOUNT IS CONFIRMED WAITS FOR IT, AND SAYS SO.
 *
 * A tab opens its mirror before the server has confirmed whose it is: reads run, writes wait. The
 * release press used to refuse in that window with "could not release", a sentence about a
 * failure that had not happened, and worked on the next press. It now waits for the confirm and
 * says the mailbox is still loading. Driven through the engine the shell builds, on a named mirror.
 */

const NOW = new Date("2026-09-28T09:00:00.000Z");
const scoped = { headers: { "X-Ohmail-Account": ACCOUNT } };
const GROUPS = [{ ruleId: "r1", kind: "sender", match: "a@one.test", destination: "INBOX", count: 3 }];
let calls: string[];

beforeAll(warmCloudShell, 30_000);
beforeEach(() => {
  installConfirmEnv();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  calls = [];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb", address: ["fixture", "mailbox.example"].join("@"), status: "connected", organizerRole: "organizer", organizerChecked: true,
        createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
      }] });
    }
    if (url === "/api/screener/unscreened") {
      return Response.json(method === "POST"
        ? { screened: [{ address: "b@two.test", count: 2, newestAt: NOW.toISOString() }], total: 2 }
        : { groups: [{ address: "b@two.test", count: 2, newestAt: NOW.toISOString() }], total: 2, max: 200 }, scoped);
    }
    if (url === "/api/screener/held-releases") {
      return Response.json(method === "POST"
        ? { released: GROUPS, total: 3 }
        : { groups: GROUPS, total: 3, max: 200, fingerprint: "fp", dismissed: false }, scoped);
    }
    return fixture(input, init);
  };
});
afterEach(teardownConfirmEnv);

describe("a release pressed during the warm open", () => {
  it("the undecided-sender press waits the same way", async () => {
    let confirm!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { confirm = resolve; });
    scriptSession(() => pending);
    window.location.hash = "#/screener";
    const host = await mountCloudShell();
    await tick(3000);
    const view = within(host);
    const more = view.queryByRole("button", { name: messages.screener.place.noticesMoreName });
    if (more && !view.queryByRole("button", { name: "Screen 2" })) {
      await act(async () => { more.click(); });
      const notices = within(document.body).getByRole("menu", { name: messages.screener.place.noticesMoreName });
      await act(async () => {
        within(notices).getByRole("menuitem", { name: /2 messages from senders you have not decided about/ }).click();
      });
    }
    expect(calls).toContain("GET /api/screener/unscreened");
    const screen = view.getAllByRole("button", { name: "Screen 2" });
    expect(screen).toHaveLength(1);
    const toasts: string[] = [];
    const observer = new MutationObserver(() => {
      const report = host.querySelector('.fr-report [role="status"]:not([data-leaving])');
      if (report?.textContent) toasts.push(report.textContent);
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    try {
      await act(async () => { screen[0]!.click(); });
      await tick(1500);
      expect(toasts).toContain(messages.screener.unscreenedWaiting);
      expect(toasts).not.toContain(messages.screener.unscreenedFailed);
      expect(calls).not.toContain("POST /api/screener/unscreened");
      await act(async () => { confirm(sessionFull()); });
      await tick(1500);
      expect(toasts.at(-1)).toBe("Screened 2. Your organizer moves them on the next pass.");
      expect(calls).toContain("POST /api/screener/unscreened");
    } finally {
      observer.disconnect();
    }
  });
});
