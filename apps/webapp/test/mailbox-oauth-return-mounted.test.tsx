/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import {
  ACCOUNT,
  act,
  installConfirmEnv,
  ISO,
  mountCloudShell,
  refresh204,
  rememberOwner,
  scriptRefresh,
  scriptSession,
  sessionFull,
  teardownConfirmEnv,
  tick,
} from "./fixtures/cloud-confirm-shell";
import type { MailboxDTO } from "../app/api-client";
import messages from "../messages/en.json";

const COMPLETE = "/api/mailboxes/oauth/microsoft/complete";
const state = "STATE-1";
const code = "CODE-1";
const mailbox: MailboxDTO = {
  id: "mb-returned",
  provider: "microsoft",
  address: ["returned", "example.invalid"].join("@"),
  authKind: "oauth",
  status: "connected",
  displayName: null,
  createdAt: ISO,
  lastSyncAt: ISO,
  organizerRole: "organizer",
  initialImportCompletedAt: ISO,
  organizeConsentedAt: ISO,
};
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  // The real Cloud entry runs the return at module scope, once per page load.
  vi.resetModules();
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});
afterEach(async () => {
  await teardownConfirmEnv();
  window.history.replaceState(null, "", "/");
});

async function returned() {
  window.history.replaceState(
    null,
    "",
    `/mailbox?settings=mailboxes&oauth=pending&state=${state}&code=${code}&reason=ignored#/settings`,
  );
  const historyLength = window.history.length;
  const callback = await import("../app/(product)/mailbox/oauth-return");
  callback.rememberOAuthOwner(state, ACCOUNT);

  const completions: Array<{
    origin: string;
    path: string;
    query: string;
    hasUserInfo: boolean;
    method: string;
    body: unknown;
    searchAtSend: string;
    hashAtSend: string;
  }> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? "GET";
    if (url.pathname === COMPLETE) {
      completions.push({
        origin: url.origin,
        path: url.pathname,
        query: url.search,
        hasUserInfo: url.username !== "" || url.password !== "",
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        searchAtSend: window.location.search,
        hashAtSend: window.location.hash,
      });
      await held;
      completed = true;
      return json({ mailbox, created: true, returnTo: null });
    }
    if (url.pathname === "/api/account/access") return json({ metered: false });
    if (url.pathname === "/api/mailboxes" && method === "GET")
      return json({ items: completed ? [mailbox] : [] });
    return fixture(input, init);
  };

  const host = await mountCloudShell();
  await tick(3000);
  const pane = within(within(host).getByRole("region", { name: messages.settings.mailboxes }));
  return { callback, completions, historyLength, pane, release };
}

describe("coming back from Microsoft", () => {
  it("finishes the ceremony from THIS origin and strips the parameters BEFORE the call", async () => {
    const { completions, historyLength, pane, release } = await returned();
    expect(completions).toEqual([
      {
        origin: window.location.origin,
        path: COMPLETE,
        query: "",
        hasUserInfo: false,
        method: "POST",
        body: { state, code },
        searchAtSend: "?settings=mailboxes",
        hashAtSend: "#/settings/mailboxes",
      },
    ]);
    expect(window.location.search).toBe("?settings=mailboxes");
    expect(window.location.hash).toBe("#/settings/mailboxes");
    expect(window.history.length).toBe(historyLength);
    expect(pane.getByText(messages.mailboxes.oauthFinishing)).toBeTruthy();

    await act(async () => {
      release();
    });
    await tick(250);
    const connected = messages.mailboxes.oauthConnected.replace("{address}", mailbox.address);
    expect(pane.getByText(connected)).toBeTruthy();
    expect(window.location.search).toBe("?settings=mailboxes");
    expect(window.location.hash).toBe("#/settings/mailboxes");
  });

  it("runs the completion ONCE — a spent state must not be re-POSTed", async () => {
    const { callback, completions, pane, release } = await returned();
    expect(completions).toHaveLength(1);
    const cleaned = window.location.href;
    const repeated = new URL(cleaned);
    repeated.searchParams.set("oauth", "pending");
    repeated.searchParams.set("state", state);
    repeated.searchParams.set("code", code);
    await act(async () => {
      window.history.replaceState(window.history.state, "", repeated);
      callback.beginOAuthReturn();
      window.history.replaceState(window.history.state, "", cleaned);
      release();
    });
    await tick(250);
    await act(async () => {
      callback.beginOAuthReturn();
    });
    await tick(250);
    expect(completions).toHaveLength(1);
    expect(window.location.search).toBe("?settings=mailboxes");
    expect(window.location.hash).toBe("#/settings/mailboxes");
    expect(
      pane.getByText(messages.mailboxes.oauthConnected.replace("{address}", mailbox.address)),
    ).toBeTruthy();
  });
});
