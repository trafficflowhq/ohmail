/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { message } from "./_draft-shell.js";
import { ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";

/**
 * THE PREVIEW SAYS WHAT THE LIST ANSWERED. The press goes through the real
 * `HttpAdapter` over the route's own wire: a list that refused reads as refused with the sender's
 * link and no press left; a list that failed, or a press that never reached ohmail, keeps its
 * button. Read from the rendered text and the rendered controls.
 */
let held: HTMLElement;

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(async () => { await teardownShellEnv(); });

type Answer = { status: number; body: unknown } | "offline";
const json = (status: number, body: unknown): Answer => ({ status, body });
const refusal = (code: string, retryable: boolean | undefined, details: Record<string, unknown>) =>
  json(409, { error: { code, message: "server English", details, ...(retryable === undefined ? {} : { retryable }) } });

async function mount(answers: Answer[]): Promise<{ calls: () => number }> {
  let calls = 0;
  const adapter = new HttpAdapter({
    baseUrl: "http://api.test",
    getCookie: () => null,
    fetch: async () => {
      const a = answers[Math.min(calls, answers.length - 1)]!;
      calls += 1;
      if (a === "offline") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    },
  });
  const store = new MemoryMirrorStore();
  await store.load();
  const letter = message("m1", {
    accountId: "acct_live_1", mailboxId: "mb_1", folder: "ohmail/Screened", subject: "Weekly list",
  });
  await store.applyChanges([
    { type: "message", op: "create", id: letter.id, seq: 1, updatedAt: ISO, entity: letter },
    {
      type: "message_body", op: "create", id: letter.id, seq: 2, updatedAt: ISO,
      entity: {
        messageId: letter.id, state: "ready", text: "The list's message", html: null, loadedRemoteContent: false,
        unsubscribe: "one_click", unsubscribeUrl: null, withheld: null,
      },
    },
  ]);
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: ISO,
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" }),
      fetchBody: async () => null,
      unsubscribe: (id) => adapter.unsubscribe(id),
    },
  });
  window.location.hash = "#/screener/screened";
  const host = await mountShell([mailbox({
    id: "mb_1", lastSyncAt: ISO, organizerRole: "organizer", organizeConsentedAt: ISO,
  })], { engine, suggestWire: "none", junkWire: "none" });
  await tick(50);
  const row = within(host).getByRole("option", { name: /Weekly list/ });
  await act(async () => { row.click(); });
  await tick(50);
  held = within(host).getByRole("region", { name: "Reading" });
  return { calls: () => calls };
}

async function press(): Promise<void> {
  const button = within(held).getByRole("button", { name: S.unsubscribe });
  await act(async () => { button.click(); });
  await tick(0);
}

const S = en.screener;

describe("the Screened-out preview after a one-click press", () => {
  it("a list that refused reads as refused, offers the sender's site, and leaves no press", async () => {
    await mount([refusal("unsubscribe_list_refused", false, { status: 405, siteUrl: "https://list.example/leave?t=1" })]);
    await press();
    const text = held.textContent ?? "";
    expect(text).toContain(S.unsubListRefused);
    expect(text, "a refused request may not read as done").not.toContain(S.unsubAlready);
    const link = within(held).queryByRole("link", { name: S.unsubExternal });
    expect(link?.getAttribute("href")).toBe("https://list.example/leave?t=1");
    expect(link?.textContent).toBe(S.unsubExternal);
    expect(within(held).queryByRole("button", { name: S.unsubscribe }), "the list answered; asking again changes nothing").toBeNull();
  });

  it("a link that is not https is never drawn", async () => {
    await mount([refusal("unsubscribe_list_refused", false, { status: 405, siteUrl: "javascript:alert(1)" })]);
    await press();
    expect(held.textContent).toContain(S.unsubListRefused);
    expect(within(held).queryAllByRole("link")).toEqual([]);
  });

  it("a list that failed says so and keeps its press, and the retry is a real second request", async () => {
    const m = await mount([
      refusal("unsubscribe_list_failed", true, { status: 500 }),
      json(200, { messageId: "m1", posted: true, status: 200, refusal: null, header: "one_click" }),
    ]);
    await press();
    expect(held.textContent).toContain(S.unsubListFailed);
    await press();
    expect(m.calls()).toBe(2);
    expect(held.textContent).toContain(S.unsubSent);
  });

  it("a press that never reached ohmail keeps its press", async () => {
    await mount(["offline"]);
    await press();
    expect(held.textContent).toContain(S.place.unsubFailed);
    expect(within(held).queryByRole("button", { name: S.unsubscribe }), "a failed press keeps its button").not.toBeNull();
  });
});
