/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The fixture first: it pins the API base before any shell module reads it.
import {
  act, answerSyncWith, goTo, installShellEnv, ISO, mailbox, mountShell, page, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { IMPORT_END_IDLE_MS } from "@ohmail/app-logic/mail-state/mail-state";
import { FACTS_POLL_MS } from "../app/shell/MailStateProvider";

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
  const input = el.querySelector<HTMLInputElement>(".view-search input");
  expect(input, "the search box").not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick(1_000);
}

describe("the sync line and search agree about the first import", () => {
  beforeEach(() => {
    installShellEnv();
    stamped = false;
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) =>
      (String(input).includes("/search?") ? searchAnswer() : inner(input as RequestInfo, init))) as unknown as typeof globalThis.fetch;
  });
  afterEach(teardownShellEnv);

  it("mid-import both say so; after the import completes the bar is done and search says whole mailbox", async () => {
    answerSyncWith(() => page(3, "INBOX"));
    const el = await mountShell([], { probe: facts });
    await tick(2_000);
    expect(textOf(el), "the premise: the rail announces the import").toContain("Syncing your mail");

    await goTo("search");
    await typeQuery(el, "zqxjvwk");
    expect(textOf(el)).toContain("Searched the mail synced so far — nothing matched");
    expect(textOf(el)).toContain("The rest of your mail has not synced yet.");

    /* The import is over: the stamp is written and the server has nothing new, so the count is
       still for the idle tail. The control below differs by the stamp alone. */
    stamped = true;
    answerSyncWith(() => page(0, "INBOX"));
    await tick(FACTS_POLL_MS + IMPORT_END_IDLE_MS + 5_000);
    expect(textOf(el), "the rail kept the import after the stamp and the idle tail").not.toContain("Syncing your mail");
    await typeQuery(el, "zqxjvwkx");
    expect(textOf(el)).toContain("Searched your whole mailbox — nothing matched");
    expect(textOf(el)).not.toContain("synced so far");
    expect(textOf(el)).not.toContain("The rest of your mail has not synced yet.");
  });

  it("the control: with the stamp still unwritten, the same wait leaves both saying the import runs", async () => {
    answerSyncWith(() => page(3, "INBOX"));
    const el = await mountShell([], { probe: facts });
    await tick(2_000);
    await goTo("search");
    answerSyncWith(() => page(0, "INBOX"));
    await tick(FACTS_POLL_MS + IMPORT_END_IDLE_MS + 5_000);
    expect(textOf(el), "the rail let go of an import nobody stamped").toContain("Syncing your mail");
    await typeQuery(el, "zqxjvwkx");
    expect(textOf(el)).toContain("Searched the mail synced so far — nothing matched");
  });
});
