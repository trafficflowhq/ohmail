import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MutationRejectedError,
  OhmailEngine,
  SERVER_VIEW_OF,
  type EngineAdapter,
  type EngineMessage,
  type ListOlderFn,
  type MutationOutcome,
  type OhmailView,
  type ServerMessageView,
  type SyncResponse,
} from "../src/index.js";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * ═══ READING PAST THE END OF THE WINDOW ═══════════════════════════════════════════════
 *
 * A windowed browser mirror deliberately holds only the newest slice of the mailbox. The
 * rest is not lost — it is on the Cloud — but until this capability existed there was no way
 * back to it, and the bottom of a pile was a claim ("this is your mail") that a windowed client
 * could not honestly make.
 *
 * The capability is STRUCTURAL, exactly like `searchServer` and `snapshot`: `listMessages` on the
 * adapter, absent on any client with no server behind it, and `unavailable` is a first-class
 * answer rather than an error. That shape is what lets a surface say "there is nothing beyond
 * this list" instead of offering a control that cannot work.
 *
 * Every guard below was watched RED against a named mutation and the implementation restored.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");

function msg(id: string, date: string): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date,
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  };
}

/** A quiet adapter, optionally carrying the out-of-window capability. */
function adapterOf(listMessages?: ListOlderFn): EngineAdapter {
  const base: EngineAdapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "AQ",
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  };
  return listMessages ? { ...base, listMessages } : base;
}

describe("absence is an answer, not a broken adapter", () => {
  it("an adapter with no `listMessages` reports `listOlderAvailable() === false`", () => {
    // MUTATION: default `listOlderFn` to a throwing stub instead of `null` → red.
    expect(new OhmailEngine({ adapter: adapterOf() }).listOlderAvailable()).toBe(false);
  });

  it("…and calling it answers `unavailable` rather than an empty page", async () => {
    // The distinction the whole outcome type exists for. "There is nothing older" is a claim
    // about somebody's mail; this is the case where nothing was asked.
    const engine = new OhmailEngine({ adapter: adapterOf() });
    expect(await engine.listOlder("ohbox")).toEqual({ state: "unavailable" });
  });

  it("THE DEMO: fixtures have no server, so the end of the list is the end of the mail", async () => {
    // Invariants #6/#8 — `?demo=1` issues zero requests. A "load older" affordance over Mila's
    // hand-made world would be a control with nothing behind it.
    const engine = new OhmailEngine({ adapter: new FixturesAdapter() });
    expect(engine.listOlderAvailable()).toBe(false);
    expect(await engine.listOlder("ohbox")).toEqual({ state: "unavailable" });
  });

  it("a transport that RESOLVES `null` means the same thing, and must not become an empty page", async () => {
    const engine = new OhmailEngine({ adapter: adapterOf(async () => null) });
    // `listOlderAvailable()` is true — the method exists — and the ANSWER is still `unavailable`.
    expect(engine.listOlderAvailable()).toBe(true);
    expect(await engine.listOlder("ohbox")).toEqual({ state: "unavailable" });
  });
});

describe("a page comes back, and it does NOT go in the mirror", () => {
  it("THE RULE: returned rows are never written — they have no seq to reconcile by", async () => {
    // `/sync` owns the mirror and reconciles by seq; a row from `GET /messages` has none.
    // Writing one in creates a record no delta can ever update or remove — and the next prune
    // pass would evict it again anyway, which is the only thing keeping the window a window.
    const engine = new OhmailEngine({
      adapter: adapterOf(async () => ({ items: [msg("old-1", "2024-01-01T00:00:00.000Z")], nextCursor: null })),
    });
    const outcome = await engine.listOlder("ohbox");

    expect(outcome).toEqual({
      state: "ready",
      items: [msg("old-1", "2024-01-01T00:00:00.000Z")],
      nextCursor: null,
    });
    // MUTATION: `await this.store.applyChanges(...)` inside `listOlder` → red here.
    expect(engine.read().get<EngineMessage>("message", "old-1")).toBeUndefined();
    expect(engine.read().list<EngineMessage>("message")).toEqual([]);
  });

  it("the view and the cursor reach the transport unchanged", async () => {
    const seen: Array<[string, unknown]> = [];
    const engine = new OhmailEngine({
      adapter: adapterOf(async (view, opts) => {
        seen.push([view, opts]);
        return { items: [], nextCursor: null };
      }),
    });
    await engine.listOlder("receipts", { cursor: "opaque-token", limit: 50 });
    expect(seen).toEqual([["receipts", { cursor: "opaque-token", limit: 50 }]]);
  });

  it("an empty `nextCursor` is normalised to null, so a surface knows to stop asking", async () => {
    // Forward-compatible parsing: a server that answers `""` means "last page", and a surface
    // that treated it as a token would ask for the same page for ever.
    const engine = new OhmailEngine({
      adapter: adapterOf(async () => ({ items: [], nextCursor: "" as unknown as string })),
    });
    expect(await engine.listOlder("ohbox")).toEqual({ state: "ready", items: [], nextCursor: null });
  });
});

describe("it never rejects, and it never issues the same page twice at once", () => {
  it("a refusal arrives as a VALUE carrying the server's own sentence", async () => {
    // The caller is a React effect. A rejection there is an unhandled promise over somebody's
    // mailbox; a 402 from the spend gate has to be renderable text, not an error boundary.
    const engine = new OhmailEngine({
      adapter: adapterOf(async () => {
        throw new Error("You have used this month's included reads.");
      }),
    });
    expect(await engine.listOlder("ohbox")).toEqual({
      state: "failed",
      error: "You have used this month's included reads.",
      // `null` because a bare `Error` never reached a server and carries no code. The surface
      // reads this to decide whether the sentence above is one a person should be shown.
      code: null,
    });
  });

  it("a REJECTION FROM THE SERVER carries its code alongside its sentence", async () => {
    // MUTATION: drop the `code:` line from the engine's catch → red. Without the code the surface
    // cannot tell the spend gate's explanation from a validation message written for a log, and
    // the only two safe options left are to print all of them or none of them.
    const engine = new OhmailEngine({
      adapter: adapterOf(async () => {
        throw new MutationRejectedError("You have used this month's included reads.", {
          status: 402,
          code: "payment_required",
        });
      }),
    });
    expect(await engine.listOlder("ohbox")).toEqual({
      state: "failed",
      error: "You have used this month's included reads.",
      code: "payment_required",
    });
  });

  it("SINGLE-FLIGHT per view+cursor: two callers for one page make one request", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const engine = new OhmailEngine({
      adapter: adapterOf(async () => {
        calls++;
        await new Promise<void>((r) => { release = r; });
        return { items: [], nextCursor: null };
      }),
    });

    const a = engine.listOlder("ohbox", { cursor: "c1" });
    const b = engine.listOlder("ohbox", { cursor: "c1" });
    expect(calls, "the second caller issued its own request").toBe(1);
    release!();
    expect(await a).toEqual(await b);
  });

  it("…but a DIFFERENT page is a different request — the key is not just the view", async () => {
    // MUTATION: key on `view` alone → red. A surface paging down would then get page 1's
    // promise for page 2 and stop, silently, at the first page of older mail.
    const asked: Array<string | undefined> = [];
    let release: (() => void) | null = null;
    const engine = new OhmailEngine({
      adapter: adapterOf(async (_v, opts) => {
        asked.push(opts.cursor);
        await new Promise<void>((r) => { release = r; });
        return { items: [], nextCursor: null };
      }),
    });
    void engine.listOlder("ohbox", { cursor: "c1" });
    void engine.listOlder("ohbox", { cursor: "c2" });
    expect(asked).toEqual(["c1", "c2"]);
    release!();
  });

  it("the in-flight entry is cleared when it settles, so a retry is possible", async () => {
    let calls = 0;
    const engine = new OhmailEngine({
      adapter: adapterOf(async () => {
        calls++;
        throw new Error("network down");
      }),
    });
    await engine.listOlder("ohbox", { cursor: "c1" });
    await engine.listOlder("ohbox", { cursor: "c1" });
    // A memoised-forever failure would make one dropped packet permanent for the tab's life.
    expect(calls).toBe(2);
  });
});

// ── the two vocabularies ────────────────────────────────────────────────────
//
// The client and the server have different names for the same six piles, and they agree on
// exactly one of them (`screened`). A client that forwards its own name works for that one view
// and is refused for the other five — which does not read as a wrong name, it reads as an
// intermittent fault.

/**
 * THE SERVER'S OWN LIST, WRITTEN OUT BY HAND.
 *
 * Mirrored from the `MessageView` union in `packages/services/src/message-service.ts`. It is a
 * literal here rather than an import on purpose: an import would follow the server wherever it
 * went and this check would agree with a rename it was supposed to catch. Spelled out, the
 * vocabularies can only drift THROUGH this line — so a name added, removed or renamed on the
 * server turns a test red here instead of turning into a refused request in production.
 */
const SERVER_VOCABULARY = [
  "imbox", "feed", "paper_trail", "screened", "quarantine", "new_for_you", "previously_seen",
] as const;

describe("the client's words for the piles are translated into the server's", () => {
  it("the table maps every client view, and every target is a name the server has", () => {
    // MUTATION: change any value in `SERVER_VIEW_OF` to the client's own word (e.g. `ohbox`) →
    // red. That is the exact defect this table exists to make impossible.
    const known = new Set<string>(SERVER_VOCABULARY);
    for (const [clientView, serverView] of Object.entries(SERVER_VIEW_OF)) {
      if (serverView === null) continue;
      expect(known.has(serverView), `"${clientView}" maps to "${serverView}", which the server has no name for`).toBe(true);
    }
  });

  it("THE DRIFT GUARD: the mirrored vocabulary and the declared type are the same seven names", () => {
    // Two directions, and both are needed. The `Record` makes a name the type has but the literal
    // list lacks a compile error; the assertion makes a name the list has but the type lacks a
    // test failure. Between them, `ServerMessageView` cannot quietly stop being a copy of the
    // server's union — and `ServerMessageView` is what every value in the table is checked against.
    const fromType: Record<ServerMessageView, true> = {
      imbox: true, feed: true, paper_trail: true, screened: true, quarantine: true,
      new_for_you: true, previously_seen: true,
    };
    expect(Object.keys(fromType).sort()).toEqual([...SERVER_VOCABULARY].sort());
  });

  it("the whole client vocabulary is accounted for — nothing is left to fall through", () => {
    // A view with no entry would read `undefined`, which is neither a name nor `null`, and would
    // reach the wire as the literal string "undefined".
    const clientViews: OhmailView[] = ["ohbox", "reads", "receipts", "screener", "screened", "spam"];
    expect(Object.keys(SERVER_VIEW_OF).sort()).toEqual([...clientViews].sort());
    for (const v of clientViews) expect(SERVER_VIEW_OF[v]).not.toBeUndefined();
  });

  it("`screened` is the ONE name both sides share, and it is a coincidence, not a rule", () => {
    // Worth pinning because it is why the bug was survivable enough to ship: one working view out
    // of six is what made a wrong vocabulary look like an unreliable server.
    const shared = Object.entries(SERVER_VIEW_OF).filter(([client, server]) => client === server);
    expect(shared).toEqual([["screened", "screened"]]);
  });
});

describe("the HTTP adapter speaks the route the server already has", () => {
  it("`listMessages` reaches `GET /messages?view=&cursor=&limit=` under the SERVER's name", async () => {
    const calls: string[] = [];
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ items: [msg("m1", "2024-01-01T00:00:00.000Z")], nextCursor: "next-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    // Asked for by its CLIENT name; the server never hears that word.
    const page = await adapter.listMessages("reads", { cursor: "c0", limit: 25 });
    expect(calls).toEqual(["/api/messages?view=feed&cursor=c0&limit=25"]);
    expect(calls[0]).not.toContain("view=reads");
    expect(page?.nextCursor).toBe("next-1");
    expect(page?.items[0]?.id).toBe("m1");
  });

  it("every view the server serves goes out under the server's word for it", async () => {
    // MUTATION: forward `view` untranslated (`new URLSearchParams({ view })`) → red on five of
    // the six rows, which is the production failure written down as a table.
    for (const [clientView, serverView] of Object.entries(SERVER_VIEW_OF)) {
      if (serverView === null) continue;
      const calls: string[] = [];
      const adapter = new HttpAdapter({
        baseUrl: "/api",
        fetch: async (url) => {
          calls.push(url);
          return new Response(JSON.stringify({ items: [], nextCursor: null }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        },
      });
      await adapter.listMessages(clientView as OhmailView);
      expect(calls, `"${clientView}" did not go out as "${serverView}"`).toEqual([`/api/messages?view=${serverView}`]);
    }
  });

  it("THE SCREENER IS NOT A PILE OF MAIL: no request, no throw, just `null`", async () => {
    // It is a queue of SENDERS waiting at the door — there is no message list behind it and no
    // cursor to page. Asking would earn a refusal the surface would then have to render, so the
    // honest answer is the one a client with no server gives: there is nothing behind this list.
    let requests = 0;
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: async () => { requests += 1; return new Response("{}", { status: 200 }); },
    });
    expect(await adapter.listMessages("screener", { cursor: "c1" })).toBeNull();
    expect(requests, "the screener was asked for a page of mail").toBe(0);
  });

  it("…and the engine turns that `null` into `unavailable`, not an empty page", async () => {
    // The two are different claims. "There is nothing older" is a statement about somebody's
    // mail; this is the case where nothing was asked.
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: async () => { throw new Error("the screener must never reach the wire"); },
    });
    const engine = new OhmailEngine({ adapter: adapter as unknown as EngineAdapter });
    expect(await engine.listOlder("screener")).toEqual({ state: "unavailable" });
  });

  it("a non-2xx THROWS, carrying the server's sentence — the engine turns it into `failed`", async () => {
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { code: "payment_required", message: "You have used this month's included reads." } }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    });
    const engine = new OhmailEngine({ adapter: adapter as unknown as EngineAdapter });
    const outcome = await engine.listOlder("ohbox");
    expect(outcome.state).toBe("failed");
    expect((outcome as { error: string }).error).toContain("included reads");
  });

  it("a page with no `items` is an empty page, not a crash", async () => {
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: async () =>
        new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect(await adapter.listMessages("ohbox")).toEqual({ items: [], nextCursor: null });
  });
});
