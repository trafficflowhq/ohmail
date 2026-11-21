/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { storeMessage } from "./_store-fixture.js";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, liveAccountResponse, mailbox, mountShell, page, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

const contact = "correspondent@example.invalid";
const from = storeMessage(4, ISO, { accountId: "acct_live_1", from: { name: "Correspondent", address: contact } });
const to = storeMessage(5, ISO, { accountId: "acct_live_1", to: [{ name: "Correspondent", address: contact }] });
type Direction = "any" | "from" | "to";
type Answer = { direction: Direction; items: EngineMessage[]; total: number; importing?: true; totalExact?: false };

beforeEach(() => {
  installShellEnv();
  const sync = page(1);
  answerSyncWith(() => sync.clone());
});
afterEach(teardownShellEnv);

async function openAddress(answer: (direction: Direction) => Answer | Response | Promise<Response>) {
  const original = globalThis.fetch;
  const asked: Direction[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://harness.invalid");
    if (!url.pathname.endsWith("/search") || !url.searchParams.has("address")) return original(input, init);
    const direction = url.searchParams.get("direction") as Direction;
    asked.push(direction);
    const value = await answer(direction);
    return liveAccountResponse(value instanceof Response ? value : Response.json(value));
  };
  const host = await mountShell([mailbox({ lastSyncAt: ISO })]);
  await goTo("address/" + encodeURIComponent(contact));
  return { host, asked };
}

async function choose(host: HTMLElement, name: RegExp) {
  const button = within(host).getByRole("button", { name });
  await act(async () => { button.click(); });
  await tick(50);
}
const row = (host: HTMLElement, message: EngineMessage) =>
  host.querySelector(`[role=option][data-id="${message.id}"]`);

it("lists archive-only mail for the answered direction and uses the complete count", async () => {
  const { host, asked } = await openAddress((direction) => ({
    direction, total: direction === "any" ? 2 : 1, items: direction === "any" ? [from, to] : direction === "to" ? [to] : [from],
  }));
  await tick(50);
  expect.soft(host.textContent).toContain("2 in your whole mailbox");
  await choose(host, /^To them/);
  expect.soft(row(host, to)).not.toBeNull();
  expect.soft(row(host, from)).toBeNull();
  await choose(host, /^All/);
  expect.soft(asked).toEqual(["any", "to"]);
  expect(row(host, from)).not.toBeNull();
});

it("names the sender-only limit and keeps those rows out of To them", async () => {
  const { host } = await openAddress(() => ({ direction: "from", total: 1, items: [from] }));
  await tick(50);
  expect.soft(host.textContent).toContain("1 in your whole mailbox (by sender)");
  expect.soft(row(host, from)).not.toBeNull();
  await choose(host, /^To them/);
  expect.soft(host.textContent).toContain("cannot be searched by recipient yet");
  expect(row(host, from)).toBeNull();
});

it("states a refusal, retries the archive, and names a settled empty address", async () => {
  let usable = false;
  const { host } = await openAddress((direction) => usable ? { direction, total: 0, items: [] }
    : Response.json({ error: "Unavailable" }, { status: 503 }));
  await tick(50);
  const retry = within(host).queryByRole("button", { name: "Try again" });
  expect.soft(retry).not.toBeNull();
  usable = true;
  if (retry) await act(async () => { retry.click(); });
  await tick(50);
  expect.soft(host.textContent).toContain(`Nothing from or to ${contact}.`);
  expect(host.textContent).toContain("0 in your whole mailbox");
});

it("reports a capped count as a lower bound during the first sync", async () => {
  const { host } = await openAddress((direction) => ({ direction, total: 50, items: [from], importing: true, totalExact: false }));
  await tick(50);
  expect(host.textContent).toContain("at least 50 in the mail synced so far");
});
