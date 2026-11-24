/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

interface Item { messageId: string; from: string; subject: string; to: string; filedAt: string }
let filed: Item[];
let undoBodies: unknown[];
let filedReads: number;

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function installSession({ available = true } = {}) {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  const wire = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/screener/auto-filed") {
      filedReads += 1;
      return available ? json({ items: filed, more: false, max: 100 }) : json({ error: { code: "not_found" } }, 404);
    }
    if (path === "/api/screener/auto-filed/undo") {
      const body = JSON.parse(String(init!.body)) as { messageIds: string[] };
      undoBodies.push(body);
      filed = filed.filter((item) => !body.messageIds.includes(item.messageId));
      return json({ putBack: body.messageIds, requested: [] });
    }
    if (path === "/api/account/screening") {
      return json({ ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "Mail from people" });
    }
    if (path === "/api/mailboxes") {
      return json({ items: [{
        id: "mb", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    return wire(input, init);
  };
}

beforeAll(warmCloudShell);
beforeEach(() => {
  undoBodies = [];
  filedReads = 0;
  filed = [
    { messageId: "m1", from: "news@shop.test", subject: "Weekly deals", to: "ohmail/News", filedAt: "2026-09-28T10:00:00.000Z" },
    { messageId: "m2", from: "billing@shop.test", subject: "Your receipt", to: "ohmail/Receipts", filedAt: "2026-09-28T09:00:00.000Z" },
  ];
  installSession();
});
afterEach(teardownConfirmEnv);

async function mount() {
  window.location.hash = "#/settings/screener";
  const host = within(await mountCloudShell());
  await tick(3000);
  return within(host.getByRole("region", { name: messages.settings.screener }));
}

const filedRows = (pane: Awaited<ReturnType<typeof mount>>) =>
  pane.queryAllByRole("group").filter((row) => within(row).queryByRole("button", { name: "Put back" }));

async function press(element: HTMLElement) {
  await act(async () => { element.click(); });
  await tick(250);
}

describe("Filed automatically", () => {
  it("states the filings still in place and lists them on Review", async () => {
    const pane = await mount();
    expect(pane.getByText("2 messages filed out of your Screener for you.")).toBeTruthy();
    expect(filedRows(pane)).toHaveLength(0);
    await press(pane.getByRole("button", { name: "Review" }));
    const rows = filedRows(pane);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Weekly deals");
  });

  it("Put back names the one message pressed, and it leaves the list on the re-read", async () => {
    const pane = await mount();
    await press(pane.getByRole("button", { name: "Review" }));
    const readsBefore = filedReads;
    await press(within(filedRows(pane)[0]!).getByRole("button", { name: "Put back" }));
    expect(undoBodies).toEqual([{ messageIds: ["m1"] }]);
    expect(filedReads).toBeGreaterThan(readsBefore);
    const rows = filedRows(pane);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Your receipt");
    expect(pane.getByText(/^1 message goes back to your Screener\./)).toBeTruthy();
  });

  it("Put back all names every message shown", async () => {
    const pane = await mount();
    await press(pane.getByRole("button", { name: "Review" }));
    await press(pane.getByRole("button", { name: "Put back all 2" }));
    expect(undoBodies).toEqual([{ messageIds: ["m1", "m2"] }]);
    expect(pane.queryByRole("button", { name: "Review" }), "nothing left, no row").toBeNull();
    expect(filedRows(pane)).toHaveLength(0);
  });

  it("draws nothing when nothing was filed, or the door has no such read (the control)", async () => {
    filed = [];
    let pane = await mount();
    expect(filedReads).toBeGreaterThan(0);
    expect(pane.queryByText(messages.settings.screening.autoFiledTitle)).toBeNull();
    await teardownConfirmEnv();
    const readsBefore = filedReads;
    installSession({ available: false });
    pane = await mount();
    expect(filedReads).toBeGreaterThan(readsBefore);
    expect(pane.queryByText(messages.settings.screening.autoFiledTitle)).toBeNull();
  });
});
