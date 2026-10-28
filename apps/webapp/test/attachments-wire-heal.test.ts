/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MutationRejectedError, OhmailEngine, PART_REASK_DELAYS_MS, REASK_MAX, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import { AttachmentStrip } from "../app/components/AttachmentStrip.js";
import { useMessageAttachments } from "../app/shell/attachments.js";
import { POLL_MS, startSyncScheduler } from "../app/shell/sync-scheduler.js";

/**
 * the reader's half. After a short connection drop the open letter kept "Couldn't
 * reach ohmail — check your connection." for minutes while every request answered 200 again: the
 * list is re-asked only on a session revival, and a network failure is not the session's. A list
 * the WIRE failed is now asked again when the server answers a drain again — the store reads' one
 * classifier and cap — and a list the server answered (a 500) is not.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const offline = () => new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });
const file = { id: "a1", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 2_300, inline: false, messageId: "m1" };

function engineOver(listAttachments: EngineAdapter["listAttachments"]): OhmailEngine {
  return new OhmailEngine({
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      listAttachments,
      fetchAttachment: async () => new Blob(["%PDF"], { type: "application/pdf" }),
    } as EngineAdapter,
  });
}

function Harness({ engine }: { engine: OhmailEngine }) {
  const a = useMessageAttachments(engine, "m1", { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  return a ? h(AttachmentStrip, {
    items: a.itemsOf("m1"), onOpen: (id: string) => a.open("m1", id),
    onDownloadAll: () => a.downloadAll("m1"), downloadingAll: a.downloadingAll("m1"),
  }) : null;
}

async function mount(engine: OhmailEngine): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(Harness, { engine })));
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
const drain = async (engine: OhmailEngine) => {
  await act(async () => { await engine.syncOnce(); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};

describe("a file list the wire failed heals when the server answers again", () => {
  it("the first completed drain asks again, and the files replace the sentence", async () => {
    let down = true;
    const listAttachments = vi.fn(async () => { if (down) throw offline(); return [file]; });
    const engine = engineOver(listAttachments);
    await mount(engine);
    expect(host!.textContent).toContain("Couldn't reach ohmail — check your connection.");
    down = false;
    await drain(engine);
    expect(listAttachments).toHaveBeenCalledTimes(2);
    expect(host!.textContent).not.toContain("Couldn't reach ohmail");
    expect(host!.textContent).toContain("invoice.pdf");
  });

  it(`asks at most ${REASK_MAX} times while the wire keeps failing`, async () => {
    const listAttachments = vi.fn(async () => { throw offline(); });
    const engine = engineOver(listAttachments);
    await mount(engine);
    for (let i = 0; i < REASK_MAX + 2; i++) await drain(engine);
    expect(listAttachments).toHaveBeenCalledTimes(1 + REASK_MAX);
  });

  it("control: a list the server answered with a fault is not asked again on a drain", async () => {
    const listAttachments = vi.fn(async () => { throw new MutationRejectedError("boom", { status: 500, code: "internal", retryable: true }); });
    const engine = engineOver(listAttachments);
    await mount(engine);
    await drain(engine);
    expect(listAttachments).toHaveBeenCalledTimes(1);
  });
});

describe("an embedded picture the mail server did not serve", () => {
  it("reads that it is tried again shortly, on the reader's own strip", async () => {
    const picture = { id: "p1", filename: "logo.png", contentType: "image/png", sizeBytes: 8, inline: true, contentId: "logo@corp", messageId: "m1" };
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listAttachments: async () => [picture],
        fetchAttachment: async () => { throw new MutationRejectedError("no answer", { status: 424, code: "mail_server_unreachable", retryable: true }); },
      } as EngineAdapter,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const Strip = () => {
      const a = useMessageAttachments(engine, "m1", { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
      return a ? h(AttachmentStrip, { items: a.itemsOf("m1", { includeInlineParts: true }), onOpen: () => {}, onDownloadAll: () => {}, downloadingAll: false }) : null;
    };
    await act(async () => root!.render(h(Strip)));
    await act(async () => { await engine.loadInlineImages("m1", ["logo@corp"]); });
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("Your mail server didn't answer — trying again shortly");
    engine.releaseAllAttachments();
  });

  it("is asked again on the sync loop's tick once its re-ask is due, and drawn", async () => {
    vi.useFakeTimers();
    const picture = { id: "p1", filename: "logo.png", contentType: "image/png", sizeBytes: 8, inline: true, contentId: "logo@corp", messageId: "m1" };
    let down = true;
    const fetchAttachment = vi.fn(async () => {
      if (down) throw new MutationRejectedError("no answer", { status: 424, code: "mail_server_unreachable", retryable: true });
      return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    });
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listAttachments: async () => [picture],
        fetchAttachment,
      } as EngineAdapter,
    });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    down = false;
    const quiet = { addEventListener(): void {}, removeEventListener(): void {} };
    const stop = startSyncScheduler(engine, { report: () => {}, visibility: { ...quiet, visibilityState: "visible" }, online: quiet, random: () => 0 });
    try {
      await vi.advanceTimersByTimeAsync(PART_REASK_DELAYS_MS[0]! + 2 * POLL_MS);
      expect(fetchAttachment).toHaveBeenCalledTimes(2);
      const held = engine.attachmentsOf("m1", { includeInlineParts: true });
      expect(held.state === "ready" ? held.items[0] : null).toMatchObject({ state: "ready" });
    } finally {
      stop();
      engine.releaseAllAttachments();
      vi.useRealTimers();
    }
  });
});
