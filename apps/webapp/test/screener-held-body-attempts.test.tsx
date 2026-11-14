/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage, Folder, MessageBodyWire } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_FETCH_TIMEOUT_MS, MemoryMirrorStore, OhmailEngine, type SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import {
  ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

/**
 * THE SCREENER'S HELD PREVIEW ASKS AS AN OPEN MESSAGE ASKS.
 *
 * A person is reading the selected sender's held mail, so its bodies must not queue behind
 * background work nobody is watching: behind four slots held by other requests the preview read
 * "Couldn't load the full message" at the stall bound while the body sat one ask away. And the
 * sentence says what is true after a Retry: a re-ask in the air reads as loading again.
 */

const NOW = new Date(ISO);
const BODY_STALL_MS = BODY_FETCH_TIMEOUT_MS * 2 + 3_000;
let seq = 0;
let host: HTMLElement;

function msg(id: string, folder: Folder, hour: number): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: folder === "ohmail/Screener" ? "stranger@example.test" : `${id}@example.test` },
    to: [], cc: [], date: `2026-08-04T${String(hour).padStart(2, "0")}:00:00.000Z`, folder,
    snippet: `one line of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/** Four background messages whose bodies never answer, and a stranger's held mail. */
const BACKGROUND = ["b1", "b2", "b3", "b4"].map((id, i) => msg(id, "ohmail/News", 1 + i));
const heldOf = (n: number) => Array.from({ length: n }, (_, i) => msg(`h${i + 1}`, "ohmail/Screener", 6 + i));

const answer = (id: string): MessageBodyWire => ({
  text: `the whole of ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
});

async function engineWith(
  seed: EngineMessage[], held: (id: string) => Promise<MessageBodyWire>, opts: { batch?: boolean } = {},
) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(seed.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  const asked: string[] = [];
  const batches: string[][] = [];
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: (id: string) => {
        asked.push(id);
        return id.startsWith("b") ? new Promise<MessageBodyWire>(() => {}) : held(id);
      },
      // The http adapter's batch route, where the rig asks for it: one request for many ids.
      ...(opts.batch ? {
        fetchBodies: async (ids: string[]) => {
          batches.push(ids);
          return Promise.all(ids.map(async (id) => ({ messageId: id, ...(await held(id)) })));
        },
      } : {}),
    },
  });
  return { engine, asked, batches };
}

async function mount(engine: OhmailEngine): Promise<void> {
  window.location.hash = "#/screener";
  host = await mountShell([mailbox({
    id: "mb", organizerRole: "organizer", organizeConsentedAt: ISO, lastSyncAt: ISO,
  })], { engine, suggestWire: "none", junkWire: "none" });
  await tick(50);
  const list = within(host).getByRole("listbox", { name: "Screener" });
  await act(async () => { within(list).getByRole("option").click(); });
  await tick(0);
}

const articles = () => within(within(host).getByRole("region", { name: "Reading" })).getAllByRole("article");
const textOf = (letter: HTMLElement) => letter.textContent ?? "";
const FAILED = messages.body.failed;
const LOADING = messages.body.loading;

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(teardownShellEnv);

describe("the held preview's bodies are asked with urgency", () => {
  it("the selected sender's mounted held bodies are ONE urgent ask, never one per message", async () => {
    const { engine } = await engineWith(heldOf(6), async (id) => answer(id), { batch: true });
    const one = vi.spyOn(engine, "hydrateBodies");
    const each = vi.spyOn(engine, "hydrateBody");
    await mount(engine);
    expect(one.mock.calls, "the preview a person is reading must not ask as background work").toHaveLength(1);
    // The newest three are mounted (`held-window.ts`); older letters are asked for as they mount.
    expect([...one.mock.calls[0]![0]].sort()).toEqual(["h4", "h5", "h6"]);
    expect(one.mock.calls[0]![1]).toEqual({ urgent: true });
    expect(each.mock.calls, "selection asks no single body and is no human re-ask").toEqual([]);
  });

  it("ten held on a server answering in 10 s, behind four busy slots, every mounted one draws by the stall bound (SCREENER-OLDER-HELD-BODIES)", async () => {
    const slow = (id: string) => new Promise<MessageBodyWire>((r) => { setTimeout(() => r(answer(id)), 10_000); });
    const { engine, asked, batches } = await engineWith([...BACKGROUND, ...heldOf(10)], slow, { batch: true });
    for (const b of BACKGROUND) void engine.hydrateBody(b.id);
    await tick(0);
    expect(asked.filter((id) => id.startsWith("b")), "premise: the four slots are taken").toHaveLength(4);
    await mount(engine);
    await tick(BODY_STALL_MS + 1_000);
    expect(batches, "one request for the mounted held letters").toHaveLength(1);
    const visible = articles().map(textOf);
    expect(visible, "premise: the newest three of ten held messages drawn").toHaveLength(3);
    expect(visible.filter((text) => text.includes(FAILED) || text.includes(messages.screener.place.bodyFailed))).toEqual([]);
    expect(visible.every((text) => text.includes("the whole of"))).toBe(true);
  });

  it("without a batch route the newest four ask urgently and every body still draws (the control)", async () => {
    const { engine } = await engineWith(heldOf(6), async (id) => answer(id));
    await mount(engine);
    await tick(0);
    expect(articles().map(textOf).filter((text) => !text.includes("the whole of"))).toEqual([]);
  });

  it("behind four busy slots the held body is drawn, not 'Couldn't load' at the stall bound", async () => {
    const { engine, asked } = await engineWith([...BACKGROUND, ...heldOf(1)], async (id) => answer(id));
    for (const b of BACKGROUND) void engine.hydrateBody(b.id);
    await tick(0);
    expect(asked.filter((id) => id.startsWith("b")), "premise: the four slots are taken").toHaveLength(4);
    await mount(engine);
    await tick(BODY_STALL_MS + 1_000);
    const [only] = articles();
    expect(textOf(only!)).toContain("the whole of h1");
    expect(textOf(only!)).not.toContain(FAILED);
    expect(textOf(only!)).not.toContain(messages.screener.place.bodyFailed);
  });
});

describe("Retry says what is true while its re-ask is in the air", () => {
  it("after the stall face, Retry reads as loading again until the answer lands", async () => {
    let release!: () => void;
    const late = new Promise<void>((r) => { release = r; });
    const { engine } = await engineWith(heldOf(1), async (id) => { await late; return answer(id); });
    await mount(engine);
    await tick(BODY_STALL_MS + 1_000);
    const [only] = articles();
    expect(textOf(only!), "premise: the stall face is up").toMatch(/Couldn't load|This letter could not be loaded/);
    const retry = within(only!).getByRole("button", { name: "Retry" });
    await act(async () => { retry.click(); });
    await tick(10);
    expect(textOf(articles()[0]!), "a pressed Retry with its request in the air is not a failure").toContain(LOADING);
    expect(within(articles()[0]!).queryByRole("button", { name: "Retry" })).toBeNull();
    release();
    await tick(10);
    expect(textOf(articles()[0]!)).toContain("the whole of h1");
  });
});

describe("a held message over the download ceiling", () => {
  it("says why its body is empty, past the stall bound — never loading, never Couldn't load", async () => {
    const { engine } = await engineWith(heldOf(1), async (id) => ({ ...answer(id), text: "", withheld: "too_large" }));
    await mount(engine);
    await tick(BODY_STALL_MS + 1_000);
    const note = textOf(articles()[0]!);
    expect(note).toContain("Open it in your mail provider");
    expect(note).not.toContain(FAILED);
    expect(note).not.toContain(messages.screener.place.bodyFailed);
    expect(note).not.toContain(LOADING);
  });
});
