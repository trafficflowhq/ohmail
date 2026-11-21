/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import {
  ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/**
 * A "NOT JUNK" THE MAIL SERVER REFUSED CAN BE LEFT IN JUNK.
 *
 * The refused row said "Your mail server wouldn't move this one. Try again." and offered only the
 * two presses that try again, so the sentence stayed for as long as the message was in Junk. The
 * row now offers to leave it there; the press clears the command on the server and the row goes
 * back to saying who filed it. Driven through the window's own hook and the Cloud client.
 */

const RESCUE = "5b3a3c7e-3f5e-4b53-9f3a-0b8f5c3a9d11";
const junkPath = "/api/screener/junk";
const mailbox = "mailbox@example.invalid";
const copy = messages.screener;
const json = (status: number, body: unknown) => Response.json(body, { status });

let calls: string[];
let dismissAnswer: () => Response;
let host: HTMLElement;

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  calls = [];
  dismissAnswer = () => json(200, { dismissed: true });
});
afterEach(teardownConfirmEnv);

async function mount() {
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/mailboxes") {
      return json(200, { items: [{
        id: "mb_1", address: mailbox, status: "connected", organizerRole: "organizer",
        initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (method === "GET" && path === "/api/consent") {
      const facts = await (await fixture(input, init)).json();
      return json(200, { ...facts, foldersEnabledAt: ISO });
    }
    if (method === "GET" && path === junkPath) {
      return json(200, {
        mailboxes: [{ id: "mb_1", address: mailbox, window: "ok" }],
        items: [{
          mailboxId: "mb_1", uidValidity: "7", uid: 5, subject: "Invoice",
          from: { name: null, address: "sender@example.invalid" },
          date: ISO, messageIdHeader: "<m5@x>", seen: false, origin: "provider",
          rescue: "refused", rescueId: RESCUE,
        }],
        nextCursor: null,
      });
    }
    if (method === "GET" && path === `${junkPath}/body`) {
      return json(200, { subject: "Invoice", text: "Pay now." });
    }
    if (method === "GET" && path === `${junkPath}/sweep`) {
      return json(200, { mailboxes: [], movable: 0, pending: false });
    }
    if (method === "DELETE" && path === `${junkPath}/rescue/${RESCUE}`) {
      calls.push(`${method} ${path}`);
      return dismissAnswer();
    }
    return fixture(input, init);
  };
  window.location.hash = "#/screener/spam";
  host = await mountCloudShell();
  await tick(3000);
  await act(async () => { page().getByRole("option", { name: /Invoice/ }).click(); });
  await tick(200);
}

const page = () => within(host);
const report = () => host.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent;

describe("a refused Not junk", () => {
  it("offers to leave the message in Junk, and the press clears the refusal", async () => {
    await mount();
    expect(page().queryAllByText(copy.junkRescueRefused)).not.toHaveLength(0);
    const leave = page().getAllByRole("button", { name: copy.junkRescueDismiss });
    expect(leave, "the refused row offers no way to leave it").toHaveLength(1);

    await act(async () => { leave[0]!.click(); });
    await tick(200);
    expect(calls).toEqual([`DELETE ${junkPath}/rescue/${RESCUE}`]);
    expect(report()).toBe(messages.screener.junkRescueDismissed.replace(/\.$/u, ""));
    expect(page().queryAllByText(copy.junkRescueRefused)).toEqual([]);
    expect(page().queryAllByRole("button", { name: copy.junkRescueDismiss })).toHaveLength(0);
    // The message is still in Junk: the row stays, saying who filed it.
    expect(page().getByRole("option", { name: /Invoice/ })).toBeTruthy();
  });

  it("a refusal of the clear says so and keeps the row as it was", async () => {
    dismissAnswer = () => json(409, { error: { code: "conflict", message: "still being made" } });
    await mount();
    await act(async () => { page().getByRole("button", { name: copy.junkRescueDismiss }).click(); });
    await tick(200);
    expect(calls).toEqual([`DELETE ${junkPath}/rescue/${RESCUE}`]);
    expect(report()).toBe(messages.screener.junkRescueDismissFailed.replace(/\.$/u, ""));
    expect(page().queryAllByText(copy.junkRescueRefused)).not.toHaveLength(0);
  });

  it("a command already gone counts as cleared", async () => {
    dismissAnswer = () => json(404, { error: { code: "not_found", message: "no refused move to clear" } });
    await mount();
    await act(async () => { page().getByRole("button", { name: copy.junkRescueDismiss }).click(); });
    await tick(200);
    expect(calls).toEqual([`DELETE ${junkPath}/rescue/${RESCUE}`]);
    expect(report()).toBe(messages.screener.junkRescueDismissed.replace(/\.$/u, ""));
    expect(page().queryAllByText(copy.junkRescueRefused)).toEqual([]);
  });

  it("the German catalogue carries the three sentences", () => {
    for (const key of ["junkRescueDismiss", "junkRescueDismissed", "junkRescueDismissFailed"] as const) {
      expect(typeof de.screener[key]).toBe("string");
      expect(de.screener[key]).not.toBe(messages.screener[key]);
    }
  });
});
