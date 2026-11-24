/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The fixture first: it pins the API base before any shell module reads it.
import {
  act, answerSyncWith, goTo, installShellEnv, ISO, liveAccountResponse, mailbox, mountShell, page, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { IMPORT_END_IDLE_MS } from "@ohmail/app-logic/mail-state/mail-state";
import { FACTS_POLL_MS } from "@ohmail/app-logic/mail-state/mail-state-binding";
import messages from "../messages/en.json";
import { typeSearch } from "./search-registered-fixture";

/** The rail's importing sentence, as the frame's notice says the same state. */
const SYNCING = messages.frame.connection.firstSync.title;
/** The awaiting state's line ("connected … ago"): First sync alone is said by the waiting and the counting state alike. */
const AWAITING_LINE = /connected (moments ago|1 minute ago|\d+ minutes ago)/;

/**
 * THE SYNC LINE AND SEARCH READ ONE FACT: the mailbox's first-import stamp. Unwritten,
 * the rail says "Syncing your mail" and a search says "the mail synced so far"; written, the rail
 * lets go once it has re-read the facts and its own count has been still for the import's idle
 * tail, and search says "your whole mailbox". The route half (one column, both wires) is
 * `packages/client-engine/test/search-first-sync.test.ts`; here the store's answer follows the
 * same stamp, as the route does.
 */
let stamped = false;
const facts = async (): Promise<MailboxFacts[]> =>
  [mailbox({ lastSyncAt: ISO, initialImportCompletedAt: stamped ? ISO : null } as Partial<MailboxFacts>)];

/** `GET /search` as the route answers it over this mailbox: `importing` while the stamp is unwritten. */
function searchAnswer(): Response {
  const body = { items: [], total: 0, totalExact: true, tier: "exact", ms: 12, ...(stamped ? {} : { importing: true }) };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function typeQuery(el: HTMLElement, value: string): Promise<void> {
  await act(async () => { typeSearch(el, value); });
  await tick(1_000);
}

describe("the sync line and search agree about the first import", () => {
  beforeEach(() => {
    installShellEnv();
    stamped = false;
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) =>
      (String(input).includes("/search?") ? liveAccountResponse(searchAnswer()) : inner(input as RequestInfo, init))) as unknown as typeof globalThis.fetch;
  });
  afterEach(teardownShellEnv);

  it("mid-import both say so; after the import completes the bar is done and search says whole mailbox", async () => {
    answerSyncWith(() => page(3, "INBOX"));
    const el = await mountShell([], { probe: facts, mailboxesNotices: true });
    await tick(2_000);
    await goTo("settings/mailboxes");
    expect(textOf(el), "the premise: Mailboxes reports the import").toContain(SYNCING);

    await goTo("search");
    await typeQuery(el, "zqxjvwk");
    expect(textOf(el)).toContain("Only the mail synced so far was searched. The rest of your mail has not synced yet.");
    expect(textOf(el)).toContain("The rest of your mail has not synced yet.");

    /* The import is over: the stamp is written and the server has nothing new, so the count is
       still for the idle tail. The control below differs by the stamp alone. */
    stamped = true;
    answerSyncWith(() => page(0, "INBOX"));
    await tick(FACTS_POLL_MS + IMPORT_END_IDLE_MS + 5_000);
    await goTo("settings/mailboxes");
    expect(textOf(el), "Mailboxes kept the import after the stamp and the idle tail").not.toContain(SYNCING);
    await goTo("search");
    await typeQuery(el, "zqxjvwkx");
    expect(textOf(el)).toContain("Nothing matched");
    expect(textOf(el)).not.toContain("synced so far");
    expect(textOf(el)).not.toContain("The rest of your mail has not synced yet.");
  });

  it("the control: with the stamp still unwritten, the same wait leaves both saying the import runs", async () => {
    answerSyncWith(() => page(3, "INBOX"));
    const el = await mountShell([], { probe: facts, mailboxesNotices: true });
    await tick(2_000);
    await goTo("search");
    answerSyncWith(() => page(0, "INBOX"));
    await tick(FACTS_POLL_MS + IMPORT_END_IDLE_MS + 5_000);
    await goTo("settings/mailboxes");
    expect(textOf(el), "Mailboxes let go of an import nobody stamped").toContain(SYNCING);
    expect(textOf(el), "the import fell back to the awaiting state").not.toMatch(AWAITING_LINE);
    await goTo("search");
    await typeQuery(el, "zqxjvwkx");
    expect(textOf(el)).toContain("Only the mail synced so far was searched. The rest of your mail has not synced yet.");
  });
});
