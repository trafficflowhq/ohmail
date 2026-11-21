/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import {
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
  warmCloudShell,
} from "./fixtures/cloud-confirm-shell";
import { bindApiOwner, type MailboxDTO } from "../app/api-client";
import messages from "../messages/en.json";

const copy = messages.mailboxes;
const settings = messages.settings;
const microsoft = "/api/mailboxes/oauth/microsoft";
const refusal = "Connecting a Microsoft mailbox is not available on this deployment yet.";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function install(): void {
  installConfirmEnv();
  bindApiOwner(null);
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
}

beforeAll(warmCloudShell);
beforeEach(install);
afterEach(async () => {
  await teardownConfirmEnv();
  bindApiOwner(null);
});

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await tick(250);
}

async function mountedMailboxes(
  availability: () => Response | Promise<Response>,
  mailboxes: MailboxDTO[] = [],
) {
  const reads: Array<{ method: string; path: string }> = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/account/access") return json({ metered: false });
    if (path === "/api/mailboxes" && method === "GET") return json({ items: mailboxes });
    if (path === `${microsoft}/availability` && method === "GET") {
      reads.push({ method, path });
      return availability();
    }
    if (path.startsWith("/api/mailboxes") && method !== "GET") {
      writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === `${microsoft}/start`) {
        return json({ error: { code: "oauth_unconfigured", message: refusal } }, 503);
      }
      return json({ error: { code: "not_found", message: "No synthetic mailbox write." } }, 404);
    }
    return fixture(input, init);
  };

  window.location.hash = "#/settings";
  const frame = await mountCloudShell();
  await tick(3000);
  const nav = within(frame).getByRole("navigation", { name: settings.navAria });
  await click(within(nav).getByRole("button", { name: settings.mailboxes }));
  expect(window.location.hash).toBe("#/settings/mailboxes");
  const pane = within(within(frame).getByRole("region", { name: settings.mailboxes }));
  return {
    pane,
    reads,
    writes,
    async open(mailbox: MailboxDTO) {
      await click(pane.getByRole("button", { name: (name) => name.includes(mailbox.address) }));
      expect(
        pane.getByRole("button", { name: (name) => name.includes(mailbox.address), expanded: true }),
      ).toBeTruthy();
    },
  };
}

function mailbox(id: string, facts: Partial<MailboxDTO> = {}): MailboxDTO {
  return {
    id,
    provider: "microsoft",
    address: [id, "example.invalid"].join("@"),
    status: "connected",
    displayName: null,
    createdAt: ISO,
    lastSyncAt: ISO,
    organizerRole: "organizer",
    initialImportCompletedAt: ISO,
    organizeConsentedAt: ISO,
    ...facts,
  };
}

const oauth = mailbox("mb-oauth", {
  authKind: "oauth",
  status: "error",
  errorCode: "auth",
  errorDetail: "OAUTH_INVALID_GRANT",
  failedAt: ISO,
  retryCount: 3,
});
const available = () => json({ available: true, device: false });
const availabilityRead = [{ method: "GET", path: `${microsoft}/availability` }];

describe("the Outlook door is gated on the deployment's capability, not shown then withdrawn", () => {
  it("hides an oauth row's Reconnect when the door is shut — and offers no Edit in its place", async () => {
    const view = await mountedMailboxes(() => json({ available: false, device: false }), [oauth]);
    await view.open(oauth);
    expect(view.reads).toEqual(availabilityRead);
    expect(view.pane.queryByRole("button", { name: copy.oauthReconnect })).toBeNull();
    expect(view.pane.queryByRole("button", { name: copy.edit })).toBeNull();
    expect(view.writes).toEqual([]);
  });
});

describe("an OAUTH row offers a reconnect, and NOT the password form", () => {
  it("replaces Edit with Reconnect Microsoft, and names the row it came from", async () => {
    let allow!: (answer: Response) => void;
    const held = new Promise<Response>((resolve) => {
      allow = resolve;
    });
    const other = { ...oauth, id: "mb-other", address: ["other", "example.invalid"].join("@") };
    const { pane, reads, writes, open } = await mountedMailboxes(() => held, [other, oauth]);
    const origin = window.location.href;
    expect(reads).toEqual([]);
    await open(oauth);
    expect(reads).toEqual(availabilityRead);
    expect(pane.queryByRole("button", { name: copy.oauthReconnect })).toBeNull();
    await act(async () => {
      allow(available());
    });
    await tick(250);
    expect(pane.queryByRole("button", { name: copy.edit })).toBeNull();
    expect(writes).toEqual([]);
    await click(pane.getByRole("button", { name: copy.oauthReconnect }));
    expect(writes).toEqual([
      {
        method: "POST",
        path: `${microsoft}/start`,
        body: { mailboxId: oauth.id, returnTo: "/" },
      },
    ]);
    expect(pane.getByText(refusal)).toBeTruthy();
    expect(window.location.href).toBe(origin);
  });

  it("a PASSWORD row still offers Edit and not the consent flow", async () => {
    const item = mailbox("mb-pass", { authKind: "password", status: "error", errorCode: "auth" });
    const view = await mountedMailboxes(available, [item]);
    await view.open(item);
    expect(view.pane.getByRole("button", { name: copy.edit })).toBeTruthy();
    expect(view.pane.queryByRole("button", { name: copy.oauthReconnect })).toBeNull();
    expect(view.writes).toEqual([]);
  });

  it("a row from an OLDER API, with no authKind at all, keeps the password door", async () => {
    const old = mailbox("mb-old");
    const view = await mountedMailboxes(available, [old]);
    await view.open(old);
    expect(view.pane.getByRole("button", { name: copy.edit })).toBeTruthy();
    expect(view.pane.queryByRole("button", { name: copy.oauthReconnect })).toBeNull();
    expect(view.writes).toEqual([]);
  });

  it("does not send a reconnect after another account becomes current", async () => {
    const { pane, writes, open } = await mountedMailboxes(available, [oauth]);
    const origin = window.location.href;
    await open(oauth);
    const reconnect = pane.getByRole<HTMLButtonElement>("button", { name: copy.oauthReconnect });
    expect(reconnect.disabled).toBe(false);
    rememberOwner("acct_other_mailboxes");
    await click(reconnect);
    expect(writes).toEqual([]);
    expect(
      pane.getByText("This window is signed in to a different account than this browser now holds."),
    ).toBeTruthy();
    expect(window.location.href).toBe(origin);
  });
});
