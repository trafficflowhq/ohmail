import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, type EngineAdapter, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { liveMessage, type WorldView } from "../src/state/live";
import { railItemsOf, readerGroups } from "../src/ui/reader-marks";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/** The phone draws every member in time order around the addressed message. */

const AT = Date.UTC(2026, 8, 20, 8, 0, 0);
const LENA = { name: "Lena", address: "lena@example.test" };
const view: WorldView = { now: new Date(AT + 3_600_000), zone: "UTC" };
function msg(id: string, atMs: number): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
    from: LENA, to: [{ name: "Me", address: "me@example.test" }], cc: [], date: new Date(atMs).toISOString(), arrivedAt: new Date(atMs).toISOString(),
    folder: "INBOX", snippet: `the words of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(atMs).toISOString(),
  } as EngineMessage;
}
const create = (type: string, id: string, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq: 1, updatedAt: new Date(AT).toISOString(), entity } as SyncChange);
const consent = (): SyncChange => create("rule", "rule_lena", {
  id: "rule_lena", kind: "sender", match: LENA.address, destination: "INBOX", priority: 0, provenance: "seeded-from-sent",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
});

async function thread(): Promise<OhmailEngine> {
  let seq = 1000;
  const pages: SyncChange[][] = [[consent(), ...["a1", "a2", "a3"].map((id, i) => create("message", id, msg(id, AT + i * 60_000)))].map((c) => ({ ...c, seq: seq++ }))];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: new Date(AT).toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: { mode: "full" } });
  await engine.start();
  return engine;
}

describe("the phone conversation order", () => {
  it("the other letters follow the first letter", async () => {
    const m = liveMessage(await thread(), "a1", view)!;
    expect(m.earlier.map((h) => [h.id, h.later === true])).toEqual([["a2", true], ["a3", true]]);
    const { above, below } = readerGroups(m);
    expect(above.map((h) => h.id)).toEqual([]);
    expect(below.map((h) => h.id)).toEqual(["a2", "a3"]);
  });
  it("the other letters precede the newest letter", async () => {
    const m = liveMessage(await thread(), "a3", view)!;
    expect(m.earlier.map((h) => [h.id, h.later === true])).toEqual([["a1", false], ["a2", false]]);
    const { above, below } = readerGroups(m);
    expect(above.map((h) => h.id)).toEqual(["a1", "a2"]);
    expect(below.map((h) => h.id)).toEqual([]);
  });
  it("the middle letter keeps its place among the other letters", async () => {
    const m = liveMessage(await thread(), "a2", view)!;
    expect(m.earlier.map((h) => [h.id, h.later === true])).toEqual([["a1", false], ["a3", true]]);
    const { above, below } = readerGroups(m);
    expect(above.map((h) => h.id)).toEqual(["a1"]);
    expect(below.map((h) => h.id)).toEqual(["a3"]);
  });
  it("each member carries who wrote it, name and address", async () => {
    const m = liveMessage(await thread(), "a2", view)!;
    expect(m.earlier.map((h) => [h.id, h.sender, h.address])).toEqual([["a1", "Lena", LENA.address], ["a3", "Lena", LENA.address]]);
  });
  it("every letter has one square in time order from any addressed member", async () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MessageReader.tsx", import.meta.url)), "utf8"));
    expect(src).toContain("readerGroups(m)");
    expect(src).not.toContain("Copy.earlierInThread(");
    const engine = await thread();
    for (const id of ["a1", "a2", "a3"]) {
      const mail = liveMessage(engine, id, view)!;
      expect(railItemsOf(mail).map((item) => item.id)).toEqual(["a1", "a2", "a3"]);
    }
  });
});
