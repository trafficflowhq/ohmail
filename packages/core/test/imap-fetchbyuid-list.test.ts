import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../src/adapters/imap.js";

/**
 * `fetchByUid` RESOLVES THE SENT PATH WITHOUT RE-LISTING THE FOLDER INVENTORY.
 *
 * It used to go through `foldersToScan()`, whose LIST-STATUS arm issues a full `client.list()`
 * on EVERY call — and the junk-restore pass fetches in four-message chunks, so fifty candidates
 * in one folder paid thirteen complete folder-inventory scans to resolve a value the adapter
 * memoises for the connection's life (review round 2). The only thing `fetchByUid` ever needed
 * was the Sent path for the `ownAuthored` stamp, and `findSentForScan` answers that from its
 * memo after the first resolution.
 *
 * The pin: two targeted fetches against a LIST-STATUS server cost exactly ONE `list()` — the
 * memoising resolution — and not one per call. Mutation: put `foldersToScan()` back in
 * `fetchByUid` and this counts two.
 */
function fakeClient(opts: { sent?: boolean; serve?: number[] } = {}) {
  // `armed`: the LIST `connect()` issues answers no folder and is not counted, so the count is the
  // targeted fetches' alone and the Sent folder is still to be resolved when they run.
  const state = { lists: 0, armed: false };
  const client = {
    capabilities: new Set(["LIST-STATUS"]),
    mailbox: { uidValidity: 1n },
    list: async () => {
      if (!state.armed) return [];
      state.lists += 1;
      return opts.sent === false
        ? []
        : [{ path: "Sent", specialUse: "\\Sent", flags: new Set<string>(), delimiter: "/" }];
    },
    getMailboxLock: async () => ({ release: () => {} }),
    append: async () => ({ uid: 1, uidValidity: 1n }),
    // Two-pass shape: the size probe answers first, the source fetch second. `serve` empty ⇒
    // every asked UID is `absent`.
    fetch: (_range: unknown, query: Record<string, unknown>) => (async function* () {
      for (const uid of opts.serve ?? []) {
        if (query.size) yield { uid, size: 10 };
        else yield { uid, source: Buffer.from("From: a@b\r\n\r\nx"), flags: new Set<string>() };
      }
    })(),
  };
  return { client, state };
}

/** Connected over the fake, as a worker's adapter is: `connect()` learns the delimiter (`/`, none named). */
async function connectedOver(fake: ReturnType<typeof fakeClient>): Promise<ImapAdapter> {
  const adapter = new ImapAdapter({
    host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
  }, { client: fake.client });
  await adapter.connect();
  fake.state.armed = true;
  return adapter;
}

describe("fetchByUid — the sent-path resolution is memoised, never a per-call LIST", () => {
  it("two targeted fetches cost one LIST, not one each", async () => {
    const fake = fakeClient();
    const { state } = fake;
    const adapter = await connectedOver(fake);

    const first = await adapter.fetchByUid("INBOX", [7]);
    expect(first.absent).toEqual([7]);
    const second = await adapter.fetchByUid("INBOX", [8]);
    expect(second.absent).toEqual([8]);

    expect(state.lists, "the folder inventory was re-listed per targeted fetch").toBe(1);
  });

  it("a NO-SENT server costs one LIST too — the negative answer is memoised behind a clock", async () => {
    // `findSentForScan` deliberately re-asks a null per SCAN cycle (a Sent folder created later
    // must start being watched). A targeted fetch has no discovery duty per call, so without its
    // own negative memo a no-Sent account paid one full inventory LIST per four-message chunk —
    // review round 3, after round 2's fix covered only the positive path.
    const fake = fakeClient({ sent: false });
    const { state } = fake;
    const adapter = await connectedOver(fake);

    const first = await adapter.fetchByUid("INBOX", [7]);
    expect(first.absent).toEqual([7]);
    const second = await adapter.fetchByUid("INBOX", [8]);
    expect(second.absent).toEqual([8]);

    expect(state.lists, "the negative Sent answer was re-asked per targeted fetch").toBe(1);
  });

  it("a positive resolution learned INSIDE the window outranks the cached negative", async () => {
    // The scan or the send path can discover/create the Sent folder while the targeted memo
    // still holds a null. A retry fetched from that folder must carry `ownAuthored` — un-stamped,
    // planChange routes the user's own outbound mail as inbound (review round 4).
    const server = { sent: false, serve: [7] };
    const adapter = await connectedOver(fakeClient(server));

    await adapter.fetchByUid("INBOX", [7]);   // caches the negative
    // The send path learns the Sent path mid-window: the server now lists it, and filing a sent
    // copy resolves it.
    server.sent = true;
    await adapter.fileSentCopy(Buffer.from("From: a@b\r\n\r\nx"), "<m@x.invalid>");

    const out = await adapter.fetchByUid("Sent", [7]);
    expect(out.creates).toHaveLength(1);
    expect(out.creates[0]!.ownAuthored, "the cached negative masked a known Sent path").toBe(true);
  });
});
