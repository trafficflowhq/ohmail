/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, renderHook, within } from "@testing-library/react";
import { type ReactNode } from "react";
import { OhmailEngine, MemoryMirrorStore, senderKey, type SyncChange } from "@ohmail/client-engine";
import { useScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { useScreenerWords } from "../../../packages/app/src/screener/words";
import { inWords, mountPlace } from "../../../packages/app/test/screener/screener-world";
import words from "../../../packages/app/messages/screener.en.json";
import { settleFirstPaint } from "./_first-paint.js";

// Sync carries the verdict and confidence without the richer page's rationale.
afterEach(cleanup);

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, hour: number): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    mail.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

async function openSender(rationale: string) {
  const address = "synced@example.test";
  const engine = await engineWith([held("m0", address, 9)]);
  const suggestions = new Map([
    [senderKey(address), { dest: "ohbox" as const, confidence: 0.9, rationale }],
  ]);
  const { result, unmount } = renderHook(
    () => useScreenerState(engine, null, 0, () => {}, useScreenerWords(), suggestions),
    { wrapper: ({ children }: { children: ReactNode }) => inWords(children) },
  );
  await settleFirstPaint();
  const model = result.current;
  unmount();

  const { view } = mountPlace(model, { engine });
  fireEvent.click(view.getByRole("option", { name: new RegExp(address) }));
  return within(view.getByRole("region", { name: "Reading" }));
}

describe("a synced chip with no rationale", () => {
  it("renders the verdict and no empty quotation", async () => {
    const sender = await openSender("");
    const destination = sender.getByRole("button", { name: words.screener.rowMoreAria });
    expect(destination.textContent).toBe(words.screener.pileOhbox);
    expect(sender.getByText("90% sure")).toBeTruthy();
    expect(sender.queryAllByText(/^“.*”$/)).toHaveLength(0);
  });

  it("the positive control: a rationale that exists is quoted", async () => {
    const sender = await openSender("because");
    expect(sender.getAllByText("“because”")).toHaveLength(1);
  });
});
