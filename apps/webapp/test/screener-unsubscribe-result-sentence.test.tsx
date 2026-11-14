/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { UnsubscribeResult } from "@ohmail/wire";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "../messages/en.json";
import { message } from "./_draft-shell.js";
import {
  ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

/**
 * THE SENTENCE A PERSON READS AFTER PRESSING UNSUBSCRIBE (a high review finding).
 *
 * The record for a list is written BEFORE the request, so its existence says only that somebody
 * got as far as trying. The service answered `already_recorded` on any conflict and this control
 * rendered "Already unsubscribed from this list." over it — so a person whose unsubscribe was
 * claimed and then stranded by a DNS failure was told the thing was done, while the mail kept
 * arriving. The acceptance is the sentence, not the service's return code.
 *
 * Read from the RENDERED output. Watched red by putting the old mapping back (every refusal that
 * is not null rendering `unsubAlready`): the first case then reads the completed sentence for a
 * send that never happened.
 */
beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(teardownShellEnv);

async function press(res: UnsubscribeResult): Promise<string> {
  const letter = message("m", {
    accountId: "acct_live_1", mailboxId: "mb_1", folder: "ohmail/Screened", subject: "Weekly list",
  });
  const store = new MemoryMirrorStore();
  await store.load();
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
  const pressed: string[] = [];
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
      unsubscribe: async (id) => {
        pressed.push(id);
        return res;
      },
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
  const held = within(within(host).getByRole("region", { name: "Reading" }));
  const button = held.getByRole("button", { name: en.screener.unsubscribe });
  await act(async () => { button.click(); });
  await tick(0);

  expect(pressed).toEqual([letter.id]);
  return held.getByRole("status").textContent ?? "";
}

const ALREADY = en.screener.unsubAlready;
const UNFINISHED = en.screener.unsubUnfinished;
const SENT = en.screener.unsubSent;

describe("the sentence after a press follows the OUTCOME, not the record", () => {
  it("a claim that never sent does NOT say the unsubscribe is done", async () => {
    const text = await press({
      messageId: "m", posted: false, status: null,
      refusal: "previous_attempt_unsettled", header: "one_click",
    });
    expect(text).toContain(UNFINISHED);
    expect(text, "a send that never happened may not read as a completed one").not.toContain(ALREADY);
  });

  it("a settled send still says it — the case the sentence was written for", async () => {
    const text = await press({
      messageId: "m", posted: false, status: null,
      refusal: "already_recorded", header: "one_click",
    });
    expect(text).toContain(ALREADY);
  });

  it("a fresh send says it was sent", async () => {
    const text = await press({
      messageId: "m", posted: true, status: 200,
      refusal: null, header: "one_click",
    });
    expect(text).toContain(SENT);
  });
});
