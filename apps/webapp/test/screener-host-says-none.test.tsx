/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * WHAT A HOST DID NOT OFFER IS NOT TAKEN FROM THE PAGE. Today's views mounted by a host that says `none` for its
 * Junk wire and for its suggestion wire, on a page whose own client is configured, for an account that uses folders
 * and has switched automatic suggestions on: the mail server's Junk folder is not read, and no suggestion is listed,
 * priced or bought. A default there reads a folder the host never offered, and spends.
 */

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return { ...actual, apiConfigured: () => true };
});

const WAITING = "m-wait-1";
const letter = {
  id: WAITING, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "First contact", from: { name: "Nora", address: "nora@stranger.example" },
  to: [], cc: [], date: ISO, folder: "ohmail/Screener", snippet: "hello", unread: true,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
};

/** Every request this page sent, with its method. */
let asked: string[] = [];
/** The Junk window's reads: the folder's page, its search and the sweep's preview. */
const junkAsks = (): string[] => asked.filter((line) => line.includes("/screener/junk"));
/**
 * The suggestion run's calls: what was already bought (`GET /screener` with its page size), a price or a purchase.
 * The engine's own read of who waits (`live=1`) is the mirror's and is not the suggestion wire's.
 */
const suggestAsks = (): string[] =>
  asked.filter(
    (line) =>
      (/\/screener(\?|$)/.test(line.split(" ")[1]!) && !line.includes("live=1")) || line.includes("/screener/suggest"),
  );

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  asked = [];
  answerSyncWith(() => json({
    changes: {
      creates: [{ type: "message", op: "create", id: WAITING, seq: 1, updatedAt: ISO, entity: letter }],
      updates: [], moves: [], deletes: [],
    },
    cursor: "c1", hasMore: false, serverTime: ISO,
  }));
  /* The account's own row: it files into folders, and it lets suggestions be bought without a press. */
  answerConsentWith({ foldersEnabledAt: ISO, autoSuggestAt: ISO });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/screener/junk/sweep")) return json({ mailboxes: [], movable: 0, pending: false });
    if (url.includes("/screener/junk")) return json({ items: [], mailboxes: [], nextCursor: null });
    if (url.includes("/screener/suggest")) {
      return json({ suggestions: [], skipped: [], charged: 0, quoted: 0, quotedSenders: 0 });
    }
    if (/\/screener(\?|$)/.test(url)) {
      return json({ items: [], nextCursor: null, suggestable: { senders: 1, credits: 1, maxPerRequest: 25 } });
    }
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
});
afterEach(async () => {
  await teardownShellEnv();
});

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(1_000);
};

/** The walk both cases make: the shell comes up, the Screener is opened, then its third section. */
async function walkTheScreener(): Promise<void> {
  await tick(5_000);
  await goHash("#/screener");
  await tick(12_000);
  await goHash("#/screener/spam");
  await tick(6_000);
}

describe("a host that says none for its Junk wire and its suggestion wire, on a page whose own client is configured", () => {
  it("CONTROL: with wires of its own the Junk folder is read and what was bought is listed", async () => {
    await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })]);
    await walkTheScreener();
    expect(junkAsks().length, "the walk cannot show a refusal: the Junk folder was never read").toBeGreaterThan(0);
    expect(suggestAsks().length, "the walk cannot show a refusal: no suggestion was ever asked for").toBeGreaterThan(0);
  }, 60_000);

  it("over a Junk wire of none the mail server's Junk folder is not read, at the mount, at the Screener or at its third section", async () => {
    await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })], { junkWire: "none" });
    await walkTheScreener();
    expect(junkAsks(), "the Junk folder was read for a host that named no wire").toEqual([]);
  }, 60_000);

  it("over a suggestion wire of none nothing is listed, priced or bought, though the account lets suggestions be bought without a press", async () => {
    await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })], { suggestWire: "none" });
    await walkTheScreener();
    expect(suggestAsks(), "a suggestion was asked for through the page's own session").toEqual([]);
  }, 60_000);
});
