/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MutationRejectedError,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type ListOlderWire,
  type MutationOutcome,
  type SyncResponse,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import messages from "../messages/en.json";
import { useOlderMail, type OlderMail } from "@ohmail/app-logic/lists/older-mail";
import { KeymapProvider } from "../app/shell/keymap";
import { OhboxView } from "../app/views/OhboxView";

/**
 * ═══ THE BOTTOM OF A WINDOWED PILE IS A BOUNDARY, NOT AN END ═══════════════════════════════
 *
 * The browser keeps ninety days of mail on the device in front of a server that still holds all
 * of it. That makes the last row of a list ambiguous in a way it never used to be: it can mean
 * "this is your mail" or "this is what this device kept", and only one of those has anything
 * behind it.
 *
 * Two halves are proven here. The HOOK, which fetches one page per ask and never writes to the
 * mirror; and the VIEW, which has to say something true about the boundary in every state —
 * including the two where the honest answer is to say nothing at all.
 *
 * ── THE SENTENCE THAT MUST NEVER BE GUESSED ─────────────────────────────────────────────────
 *
 * "That is everything on your server" is a claim about somebody's whole mailbox. It is said only
 * when the server answered a page with no cursor after it. An empty page, a refusal, a dead
 * network and a client that simply has no server are four different things, and a surface that
 * rendered any of them as that sentence would be lying about the one thing the window makes
 * uncertain.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const COPY = messages.ohbox;

function msg(id: string, subject = `Subject ${id}`): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject,
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date: "2024-01-01T00:00:00.000Z",
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

/** A quiet engine, optionally able to read past the end of the window. */
function engineOf(listMessages?: (view: string, opts: { cursor?: string }) => Promise<ListOlderWire | null>) {
  const base: EngineAdapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "AQ",
      hasMore: false,
      serverTime: new Date().toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  };
  return new OhmailEngine({
    adapter: (listMessages ? { ...base, listMessages } : base) as EngineAdapter,
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => { r.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-07T09:00:00.000Z"), children: node,
    }));
  });
  return host!;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}

// ── the hook ────────────────────────────────────────────────────────────────

let latest: OlderMail | null = null;

function HookProbe({ engine }: { engine: OhmailEngine }): null {
  latest = useOlderMail(engine, "ohbox", 0);
  return null;
}

describe("one page per ask, and never speculatively", () => {
  beforeEach(() => { latest = null; });

  it("a client whose mirror IS the mailbox reports nothing behind the list", async () => {
    await render(h(HookProbe, { engine: engineOf() }));
    expect(latest!.available).toBe(false);
    expect(latest!.exhausted).toBe(false);
    expect(latest!.items).toEqual([]);
  });

  it("THE DEMO issues zero requests, even when asked", async () => {
    // Invariants #6/#8. `loadMore` is wired to a control the demo never renders, but a hook that
    // fetched anyway would be one careless `useEffect` away from a request out of `?demo=1`.
    const engine = new OhmailEngine({ adapter: new FixturesAdapter() });
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await render(h(HookProbe, { engine }));
      expect(latest!.available).toBe(false);
      await act(async () => { latest!.loadMore(); });
      await settle();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(latest!.items).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("NOTHING is fetched until somebody asks", async () => {
    const asked: unknown[] = [];
    await render(h(HookProbe, { engine: engineOf(async (v, o) => { asked.push([v, o]); return { items: [], nextCursor: null }; }) }));
    await settle();
    // Mounting a list is not a request for the whole mailbox.
    expect(asked).toEqual([]);
    expect(latest!.available).toBe(true);
  });

  it("one ask fetches one page, and pages onward from the server's cursor", async () => {
    const asked: Array<string | undefined> = [];
    const engine = engineOf(async (_v, o) => {
      asked.push(o.cursor);
      return o.cursor
        ? { items: [msg("old-2")], nextCursor: null }
        : { items: [msg("old-1")], nextCursor: "page-2" };
    });
    await render(h(HookProbe, { engine }));

    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id)).toEqual(["old-1"]);
    expect(latest!.exhausted, "one page is not the end of a mailbox").toBe(false);

    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(asked, "the second ask did not carry the server's cursor").toEqual([undefined, "page-2"]);
    expect(latest!.items.map((m) => m.id)).toEqual(["old-1", "old-2"]);
    // ONLY now, and only because the server said there is no page after this one.
    expect(latest!.exhausted).toBe(true);
  });

  it("two asks in ONE tick append one page, not two", async () => {
    // The engine coalesces identical view+cursor requests, so the cost was never a duplicate
    // fetch — it is the same page appended twice, i.e. the same mail on screen twice.
    let calls = 0;
    const engine = engineOf(async () => { calls++; return { items: [msg("old-1")], nextCursor: null }; });
    await render(h(HookProbe, { engine }));
    await act(async () => { latest!.loadMore(); latest!.loadMore(); });
    await settle();
    expect(calls).toBe(1);
    expect(latest!.items.map((m) => m.id)).toEqual(["old-1"]);
  });

  it("a repeated row from the server is not rendered twice", async () => {
    const engine = engineOf(async (_v, o) =>
      o.cursor ? { items: [msg("old-1"), msg("old-2")], nextCursor: null } : { items: [msg("old-1")], nextCursor: "p2" });
    await render(h(HookProbe, { engine }));
    await act(async () => { latest!.loadMore(); });
    await settle();
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id)).toEqual(["old-1", "old-2"]);
  });

  it("A REFUSAL IS NOT AN ENDING — the cursor holds and the same page can be retried", async () => {
    let attempt = 0;
    const engine = engineOf(async () => {
      attempt++;
      if (attempt === 1) {
        // A REAL rejection, code and all — the shape the wire client throws. The spend gate is
        // the one refusal whose words are written for the person reading them, so it is the one
        // whose words survive to the screen.
        throw new MutationRejectedError("You have used this month's included reads.", {
          status: 402, code: "payment_required",
        });
      }
      return { items: [msg("old-1")], nextCursor: null };
    });
    await render(h(HookProbe, { engine }));

    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.error).toContain("included reads");
    // The distinction the whole outcome type exists for: the network failed, the mailbox did not
    // end. A surface that read this as `exhausted` would take the control away.
    expect(latest!.exhausted).toBe(false);

    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.error).toBeNull();
    expect(latest!.items.map((m) => m.id)).toEqual(["old-1"]);
  });

  it("A REFUSAL WRITTEN FOR A LOG IS NOT PASSED ON — the failure shows, the words do not", async () => {
    // MUTATION: `error: outcome.error` in `older-mail.ts` → red. That line is how a validation
    // message naming the server's internal vocabulary came to be printed under a pile of mail.
    const engine = engineOf(async () => {
      throw new MutationRejectedError(
        "view must be one of imbox, feed, paper_trail, screened, quarantine, new_for_you, previously_seen",
        { status: 400, code: "validation" },
      );
    });
    await render(h(HookProbe, { engine }));
    await act(async () => { latest!.loadMore(); });
    await settle();

    // `""`, not `null`: the attempt failed and the surface must say so and offer a retry. It is
    // only the server's WORDS that are withheld. Conflating the two would hide the failure.
    expect(latest!.error).toBe("");
    expect(latest!.exhausted).toBe(false);
  });

  it("…and a failure with no server behind it says nothing either", async () => {
    // A dead network carries no code, so there is nothing addressed to the reader. `TypeError:
    // Failed to fetch` is not a sentence anybody should find under their mail.
    const engine = engineOf(async () => { throw new TypeError("Failed to fetch"); });
    await render(h(HookProbe, { engine }));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.error).toBe("");
  });

  it("the rows are NEVER written to the mirror", async () => {
    // They have no sync sequence, so nothing could ever update or remove them — and the next
    // prune pass would evict them again, which is the only thing keeping the window a window.
    const engine = engineOf(async () => ({ items: [msg("old-1")], nextCursor: null }));
    await render(h(HookProbe, { engine }));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items).toHaveLength(1);
    expect(engine.read().get<EngineMessage>("message", "old-1")).toBeUndefined();
  });
});

// ── the surface ─────────────────────────────────────────────────────────────

const INERT: OlderMail = {
  available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {},
};

function ohboxWith(older: OlderMail, demo = false): React.ReactElement {
  // The view declares its keys into the keyboard registry rather than adding a `document`
  // listener, so the provider is part of mounting it at all — the same harness every other
  // Ohbox test uses.
  return h(KeymapProvider as never, { children: h(OhboxView as never, {
    demo,
    newForYou: [],
    previouslySeen: [msg("m1", "Something in the window")],
    tags: [],
    now: new Date("2026-08-07T09:00:00.000Z"),
    selectedId: null,
    onSelect: () => {},
    onEnterReader: () => {},
    onMarkSeen: () => {},
    doorbellInitials: [],
    doorbellCount: 0,
    settled: true,
    owed: false,
    onDoorbell: () => {},
    onAction: () => {},
    onAddTag: () => {},
    bulk: { later: true, aside: true, resurface: true, move: true, read: true },
    older,
  }) });
}

function ohbox(older: Partial<OlderMail>, demo = false): React.ReactNode {
  return ohboxWith({ ...INERT, ...older }, demo);
}

/** The hook and the view together, over a real engine — no hand-written `older` prop between them. */
function LiveOhbox({ engine }: { engine: OhmailEngine }): React.ReactElement {
  const older = useOlderMail(engine, "ohbox", 0);
  latest = older;
  return ohboxWith(older);
}

describe("the pile says something true about its own boundary", () => {
  it("A CLIENT THAT HOLDS EVERYTHING OFFERS NOTHING — no control, no sentence", async () => {
    // The standalone desktop client. Its list ends where its mail ends, and an affordance to
    // load older mail would be an offer it cannot keep.
    const el = await render(ohbox({ available: false }));
    expect(el.textContent).not.toContain(COPY.olderAction);
    expect(el.textContent).not.toContain(COPY.olderEnd);
  });

  it("THE DEMO keeps its own sentence, and gains no control", async () => {
    // Mila's fixture world has a beginning and no server behind it. `tail` is true there and
    // has been for as long as it has been rendered.
    const el = await render(ohbox({ available: false }, true));
    expect(el.textContent).toContain(COPY.tail);
    expect(el.textContent).not.toContain(COPY.olderAction);
  });

  it("A WINDOWED CLIENT offers the way back, and names no device", async () => {
    const el = await render(ohbox({ available: true }));
    expect(el.textContent).not.toMatch(/device|on your server/i);
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === COPY.olderAction);
    expect(button, "there is no way to reach the older mail").toBeDefined();
  });

  it("pressing it asks for a page", async () => {
    const loadMore = vi.fn();
    const el = await render(ohbox({ available: true, loadMore }));
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === COPY.olderAction)!;
    await act(async () => { button.click(); });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("the older rows render BELOW the local window, under their own label", async () => {
    // Not merged into "Earlier". A reader who scrolls past the label has been told where the
    // boundary is; a list that hid it would claim the device holds more than it does.
    const el = await render(ohbox({ available: true, items: [msg("old-1", "From further back")] }));
    expect(el.textContent).toContain("From further back");
    const groups = [...el.querySelectorAll("*")].map((n) => n.textContent).filter(Boolean);
    expect(groups.some((g) => g === COPY.olderTitle)).toBe(true);
    // The count, not a bare list — the sentence says what the rows are.
    expect(el.textContent).toContain("1 older message");
  });

  it("THE END IS SAID ONLY WHEN THE SERVER SAID IT, and the control goes with it", async () => {
    const el = await render(ohbox({ available: true, items: [msg("old-1")], exhausted: true }));
    expect(el.textContent).toContain(COPY.olderEnd);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === COPY.olderAction)).toBe(false);
  });

  it("…and NOT when a page merely came back empty", async () => {
    // An empty page with a cursor after it is a real state: the server had nothing on this page.
    // It is not the end of the mailbox and must not be described as one.
    const el = await render(ohbox({ available: true, items: [], exhausted: false }));
    expect(el.textContent).not.toContain(COPY.olderEnd);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === COPY.olderAction)).toBe(true);
  });

  it("a refusal shows the SERVER'S sentence and keeps a way to retry", async () => {
    const el = await render(ohbox({ available: true, error: "You have used this month's included reads." }));
    expect(el.textContent).toContain("You have used this month's included reads.");
    expect(el.textContent).not.toContain(COPY.olderEnd);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === COPY.olderRetry)).toBe(true);
  });

  it("a refusal with nothing to add still says the app's own sentence, and still offers retry", async () => {
    const el = await render(ohbox({ available: true, error: "" }));
    // The sentence's own leading half — everything up to the interpolation — is what the reader
    // gets, with no dangling server text after it.
    expect(el.textContent).toContain(COPY.olderFailed.replace("{reason}", "").trim());
    expect(el.textContent).not.toContain(COPY.olderEnd);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === COPY.olderRetry)).toBe(true);
  });

  it("while a page is in flight it says so, and offers no second press", async () => {
    const el = await render(ohbox({ available: true, loading: true }));
    expect(el.textContent).toContain(COPY.olderLoading);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === COPY.olderAction)).toBe(false);
  });
});

describe("THE SERVER'S OWN WORDS NEVER LAND UNDER SOMEBODY'S MAIL", () => {
  it("a validation refusal renders the app's sentence, and not one word of the server's", async () => {
    // END TO END, hook and view together over a real engine: this is the live defect, written as
    // a test. `GET /messages` refused the client's view vocabulary, and the raw 400 —
    // "view must be one of imbox, feed, paper_trail, …" — was rendered at the bottom of the pile.
    //
    // Two independent things now stop it: the wire client translates the name so this 400 does
    // not happen, and the hook refuses to repeat a message not addressed to the reader if it
    // ever does. This proves the second, which is the one that holds for refusals nobody has
    // thought of yet.
    const RAW = "view must be one of imbox, feed, paper_trail, screened, quarantine, new_for_you, previously_seen";
    const engine = engineOf(async () => {
      throw new MutationRejectedError(RAW, { status: 400, code: "validation" });
    });

    const el = await render(h(LiveOhbox, { engine }));
    await act(async () => { latest!.loadMore(); });
    await settle();

    expect(el.textContent, "the server's validation message was published into the mail list").not.toContain(RAW);
    expect(el.textContent).not.toContain("paper_trail");
    expect(el.textContent).not.toContain("previously_seen");
    expect(el.textContent).toContain(COPY.olderFailed.replace("{reason}", "").trim());
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === COPY.olderRetry)).toBe(true);
    // Not an ending, either — the mail did not stop, the request did.
    expect(el.textContent).not.toContain(COPY.olderEnd);
  });
});

describe("a page in flight belongs to the list that asked for it", () => {
  it("a response that lands after the view changed is DROPPED, not appended", async () => {
    // The reset cannot cancel a request already on the wire. Without a validity check the page
    // asked for in one pile lands after the reset and is appended to a DIFFERENT pile's list —
    // mail from one place rendered at the bottom of another, which is the single mistake this
    // whole surface exists to avoid making.
    //
    // MUTATION: delete the `committed.current.scope !== p.scope` return in `older-mail.ts` → red.
    let release!: (page: ListOlderWire) => void;
    const engine = engineOf(() => new Promise<ListOlderWire>((r) => { release = r; }));

    let view: "ohbox" | "reads" = "ohbox";
    function Switcher(): null {
      latest = useOlderMail(engine, view, 0);
      return null;
    }
    await render(h(Switcher, {}));
    await act(async () => { latest!.loadMore(); });

    // The list changes underneath the request…
    view = "reads";
    await act(async () => { root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-07T09:00:00.000Z"),
      children: h(Switcher, {}),
    })); });

    // …and only then does the first pile's page come back.
    await act(async () => { release({ items: [msg("from-the-other-pile")], nextCursor: null }); });
    await settle();

    expect(latest!.items, "a page from another list was appended").toEqual([]);
    expect(latest!.exhausted, "the other list's answer ended this one").toBe(false);
  });

  it("returning to a scope does not admit its ABANDONED request's answer", async () => {
    // A leaves a request in flight; B's own ask re-keys the paging state; the user returns to
    // A, whose page state was reset by the round trip. The old answer's paging incarnation is
    // gone, so the answer must change nothing — the committed-scope check alone would admit it
    // (committed is A again) and render a ghost page under a list that never asked.
    //
    // MUTATION (watched red 2026-08-24): delete the `paging.current !== p` return → the ghost
    // renders.
    const releases: Array<(w: ListOlderWire) => void> = [];
    const engine = engineOf(() => new Promise<ListOlderWire>((r) => { releases.push(r); }));
    let folderId = "fd1";
    function Probe(): null {
      latest = useOlderMail(engine, "folder", 0, folderId, undefined, undefined, 0);
      return null;
    }
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });     // A's request, held open

    folderId = "fd2";
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });     // B's ask re-keys the paging state

    folderId = "fd1";
    await render(h(Probe, {}));                          // back to A — no new ask yet

    await act(async () => { releases[0]!({ items: [msg("ghost")], nextCursor: null }); });
    await settle();
    expect(latest!.items, "the abandoned request's ghost rendered").toEqual([]);
    expect(latest!.exhausted, "the abandoned request ended the fresh list").toBe(false);

    // A fresh ask under the returned scope works, from page one.
    await act(async () => { latest!.loadMore(); });
    await act(async () => { releases[2]!({ items: [msg("real")], nextCursor: null }); });
    await settle();
    expect(latest!.items.map((m) => m.id)).toEqual(["real"]);
    expect(latest!.exhausted).toBe(true);
  });

  it("a scope RE-ENTERED through a quiet detour starts from page one, not the old position", async () => {
    // The paging incarnation must retire on every COMMITTED scope change, not only when the
    // intermediate scope happens to ask for a page: an A→B→A round trip in which B never asks
    // must not hand A back its old exhaustion (a probe that no-ops against a reset page), its
    // old cursor (page one skipped), or its old latch — the round trip reset the page state,
    // and the paging position has to move with it.
    //
    // MUTATION (watched red 2026-08-24, red-first): with retirement keyed off the first ask,
    // the returned scope's probe is swallowed by the stale `done` and items stay [].
    let folderId = "fd1";
    let served = "old-tail";
    const engine = engineOf(async () => ({ items: [msg(served)], nextCursor: null }));
    function Probe(): null {
      latest = useOlderMail(engine, "folder", 0, folderId, undefined, undefined, 0);
      return null;
    }
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.exhausted).toBe(true);

    // The quiet detour: B commits, asks nothing, and A returns.
    folderId = "fd2";
    await render(h(Probe, {}));
    folderId = "fd1";
    served = "fresh-tail";
    await render(h(Probe, {}));
    expect(latest!.exhausted, "the old exhaustion leaked through the detour").toBe(false);

    // The probe must actually ask again — a stale `done` would swallow it silently.
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id), "the probe was swallowed by the old position").toEqual(["fresh-tail"]);
  });
});

describe("the three verdicts — hide is quiet, show is a return, ban is a latch", () => {
  // The scenario behind the latch: a fetched overlap row is MOVED out of the folder — the
  // mirror renders it elsewhere, so the caller's predicate answers "ban" — and the windowed
  // mirror later hard-prunes the moved row. A boolean live filter reads that prune as "not
  // held" and revives the stale pre-move copy in its former folder; the latch keeps the
  // mailbox's own word. Eviction must stay different: a row the predicate only ever HID is
  // released the moment the mirror stops holding it.
  //
  // MUTATION (watched red 2026-08-24): in `older-mail.ts`, treat `"ban"` as `"hide"` — drop
  // `banned.current.add(item.id)` — and "the observed move does not" below fails with
  // ["kept", "evicted", "moved"].
  it("a banned id stays away after the mirror prunes it; a merely hidden one returns", async () => {
    const verdicts = new Map<string, "show" | "hide" | "ban">();
    let version = 0;
    const engine = engineOf(async () => ({
      items: [msg("kept"), msg("evicted"), msg("moved")], nextCursor: null,
    }));
    function Probe(): null {
      latest = useOlderMail(engine, "folder", version, "fd1", undefined,
        (id) => verdicts.get(id) ?? "show");
      return null;
    }
    // Both overlap rows start as "hide": the mirror renders them above the tail.
    verdicts.set("evicted", "hide");
    verdicts.set("moved", "hide");
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id)).toEqual(["kept"]);

    // A drain shows "moved" in ANOTHER folder — the mailbox's word that it left this one.
    verdicts.set("moved", "ban");
    version += 1;
    await render(h(Probe, {}));
    expect(latest!.items.map((m) => m.id)).toEqual(["kept"]);

    // The windowed mirror prunes both live rows: neither is held any more. Eviction releases
    // the fetched copy; the observed move does not.
    verdicts.set("evicted", "show");
    verdicts.set("moved", "show");
    version += 1;
    await render(h(Probe, {}));
    expect(latest!.items.map((m) => m.id)).toEqual(["kept", "evicted"]);
  });

  // The caller's predicate reads the OVERLAY-AWARE mirror, so a pending optimistic move also
  // answers "ban". A hard-rejected move rolls the row back into the scope — and a row can be
  // genuinely moved back — so the latch must clear on the opposite observation, or a later
  // eviction hides mail the server still holds for the rest of the scope's life.
  //
  // MUTATION (watched red 2026-08-24): drop `banned.current.delete(item.id)` in
  // `older-mail.ts` → the final assertion fails with [].
  it("a ban is CLEARED when the row is observed back in the scope — a rollback cannot outlive it", async () => {
    const verdicts = new Map<string, "show" | "hide" | "ban">();
    let version = 0;
    const engine = engineOf(async () => ({ items: [msg("returned")], nextCursor: null }));
    function Probe(): null {
      latest = useOlderMail(engine, "folder", version, "fd1", undefined,
        (id) => verdicts.get(id) ?? "show");
      return null;
    }
    // An optimistic move (or a real one) is observed: the overlay shows the row elsewhere.
    verdicts.set("returned", "ban");
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items).toEqual([]);

    // The move is rejected (or undone): the mirror holds the row in this folder again.
    verdicts.set("returned", "hide");
    version += 1;
    await render(h(Probe, {}));
    expect(latest!.items).toEqual([]);

    // The window later evicts the live row — the fetched copy must come back.
    verdicts.set("returned", "show");
    version += 1;
    await render(h(Probe, {}));
    expect(latest!.items.map((m) => m.id), "a stale ban outlived the rollback").toEqual(["returned"]);
  });

  // The caller answers "hold" when the render cannot judge the scope at all — the folder
  // entity missing from the mirror (the flag toggled off and on over an open URL, a tombstone
  // render). That defensive hide is NOT an observed return: a ban must survive it, or a moved
  // row pruned while the entity was away revives its stale copy the moment the scope is
  // unreadable.
  //
  // MUTATION (watched red 2026-08-24): treat "hold" as "hide" in `older-mail.ts` → the final
  // assertion fails with ["parked"].
  it("a hold hides without judging — the latch survives it", async () => {
    const verdicts = new Map<string, "show" | "hide" | "ban" | "hold">();
    let version = 0;
    const engine = engineOf(async () => ({ items: [msg("parked")], nextCursor: null }));
    function Probe(): null {
      latest = useOlderMail(engine, "folder", version, "fd1", undefined,
        (id) => verdicts.get(id) ?? "show");
      return null;
    }
    // The move is observed: the mirror shows the row elsewhere.
    verdicts.set("parked", "ban");
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items).toEqual([]);

    // The folder entity leaves the mirror (flag mid-toggle): the scope cannot be judged.
    verdicts.set("parked", "hold");
    version += 1;
    await render(h(Probe, {}));
    expect(latest!.items).toEqual([]);

    // The moved row is pruned while the entity is away: NOT a release — the ban held.
    verdicts.set("parked", "show");
    version += 1;
    await render(h(Probe, {}));
    expect(latest!.items, "a defensive hide released the latch").toEqual([]);
  });

  // The unjudgeable gap's END: the caller bumps `scopeEpoch` when the folder entity re-enters
  // the mirror. Everything the gap made unreliable — pages fetched before it, latches earned
  // before it — is dropped, and the tail re-earns its rows from the server.
  //
  // MUTATION (watched red 2026-08-24): drop `scopeEpoch` from the hook's reset-effect deps →
  // "the latch survived the epoch" fails with [].
  it("an epoch bump drops the pages AND the latch — the tail re-earns from the server", async () => {
    const verdicts = new Map<string, "show" | "hide" | "ban" | "hold">();
    let epoch = 0;
    let served: string[] = ["stale"];
    const engine = engineOf(async () => ({ items: served.map((id) => msg(id)), nextCursor: null }));
    function Probe(): null {
      latest = useOlderMail(engine, "folder", 0, "fd1", undefined,
        (id) => verdicts.get(id) ?? "show", epoch);
      return null;
    }
    // A ban is earned, then the entity leaves the mirror: every verdict holds.
    verdicts.set("stale", "ban");
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items).toEqual([]);
    verdicts.set("stale", "hold");
    await render(h(Probe, {}));
    expect(latest!.items).toEqual([]);

    // The entity returns: the epoch bumps, the fetched page is gone with the latch…
    verdicts.set("stale", "show");
    served = ["fresh"];
    epoch += 1;
    await render(h(Probe, {}));
    await settle();
    expect(latest!.items, "the old page outlived the epoch").toEqual([]);
    expect(latest!.exhausted, "the old exhaustion outlived the epoch").toBe(false);

    // …and the next ask is answered by the SERVER's current truth, unfiltered by old bans.
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id), "the latch survived the epoch").toEqual(["fresh"]);
  });

  // The reset must be SYNCHRONOUS with the render that changes the scope, because the consumer
  // that needs it most runs before any parent effect could: FolderView mounts when the entity
  // returns and its mount effect probes an empty folder immediately — child effects run before
  // parent effects, so a reset deferred to an effect leaves that probe reading the PREVIOUS
  // scope's refs (a stale `done` swallows it silently; a stale generation drops its answer),
  // and its deps never change again, so the folder sits unprobed until a manual press.
  //
  // MUTATION (watched red 2026-08-24, red-first): with the reset in a passive effect, this
  // fails — the stale exhaustion swallows the mount probe and items stay [].
  it("a probe fired from a child MOUNT effect survives the epoch's reset", async () => {
    let epoch = 0;
    let served = ["stale"];
    const engine = engineOf(async () => ({ items: served.map((id) => msg(id)), nextCursor: null }));
    function Kid(): null {
      React.useEffect(() => { latest!.loadMore(); }, []);
      return null;
    }
    function Probe({ kid }: { kid: boolean }): React.ReactNode {
      latest = useOlderMail(engine, "folder", 0, "fd1", undefined, undefined, epoch);
      return kid ? h(Kid, {}) : null;
    }
    // The previous scope ended exhausted — the stale `done` a deferred reset would leak.
    await render(h(Probe, { kid: false }));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.exhausted).toBe(true);

    // The entity returns: the epoch bumps AND the view mounts, probing from its mount effect.
    served = ["fresh"];
    epoch += 1;
    await render(h(Probe, { kid: true }));
    await settle();
    expect(latest!.items.map((m) => m.id), "the mount probe was swallowed by the old scope").toEqual(["fresh"]);
    expect(latest!.exhausted).toBe(true);
  });

  // The reset's guard lives in STATE because React may discard a render pass (StrictMode's
  // second invoke; a concurrent render thrown away), and a discarded pass keeps its ref
  // mutations while losing its queued state updates — a ref guard remembers the new scope
  // while the page was never reset, and the replayed render skips the block. StrictMode is
  // the closest a test can get to that replay, so the whole switch is exercised under it.
  //
  // MUTATION (watched red 2026-08-24): drop `setResetFor(...)` from the block → the reset
  // re-runs every render and the page can never accumulate (this and half the suite go red);
  // drop `setPage(EMPTY)` → the old folder's rows survive the switch.
  it("a scope switch under StrictMode resets whole — no leaked rows, no swallowed probe", async () => {
    let folderId = "fd1";
    const engine = engineOf(async () =>
      ({ items: [msg(folderId === "fd1" ? "first-folder" : "second-folder")], nextCursor: null }));
    function Probe(): null {
      latest = useOlderMail(engine, "folder", 0, folderId, undefined, undefined, 0);
      return null;
    }
    const mountStrict = () => render(h(React.StrictMode, { children: h(Probe, {}) }));
    await mountStrict();
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id)).toEqual(["first-folder"]);
    expect(latest!.exhausted).toBe(true);

    // The switch: the old rows must not commit under the new title, even for a frame…
    folderId = "fd2";
    await mountStrict();
    expect(latest!.items).toEqual([]);
    expect(latest!.exhausted, "the old exhaustion survived the switch").toBe(false);

    // …and the new scope's ask works — the probe is not swallowed by stale refs.
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id)).toEqual(["second-folder"]);
  });

  it("the latch lives and dies with its scope — another folder starts unbanned", async () => {
    // "Latched out for the scope's life": a ban observed in one folder must not follow the id
    // into a different folder's tail, whose pages are fetched fresh against the live server.
    const verdicts = new Map<string, "show" | "hide" | "ban">();
    let folderId = "fd1";
    const engine = engineOf(async () => ({ items: [msg("wanderer")], nextCursor: null }));
    function Probe(): null {
      latest = useOlderMail(engine, "folder", 0, folderId, undefined,
        (id) => verdicts.get(id) ?? "show");
      return null;
    }
    verdicts.set("wanderer", "ban");
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items).toEqual([]);

    // The scope changes; the mirror holds nothing of it there.
    verdicts.set("wanderer", "show");
    folderId = "fd2";
    await render(h(Probe, {}));
    await act(async () => { latest!.loadMore(); });
    await settle();
    expect(latest!.items.map((m) => m.id), "fd1's ban leaked into fd2").toEqual(["wanderer"]);
  });
});
