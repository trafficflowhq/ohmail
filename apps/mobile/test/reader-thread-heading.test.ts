import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, type EngineAdapter, type EngineMessage, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { liveMessage, type WorldView } from "../src/state/live";
import { threadHeading } from "../src/ui/thread-heading";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE PHONE READER'S HEADING OVER THE OTHER MEMBERS: the reader lists them below the
 * opened message, oldest first, and the heading named them all "Earlier" — over letters written
 * after the opened one when it was the first or a middle one. Through a real engine: a1, a2, a3;
 * opened at a1 they are Later, at a3 Earlier, at a2 the rest. Mutations: the `later` flag dropped
 * in `liveMessage`, the all-later branch dropped in `threadHeading` — each red here.
 */

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

describe("the heading over the conversation's other members", () => {
  it("opened at the first letter, every other one is Later, never Earlier", async () => {
    const m = liveMessage(await thread(), "a1", view)!;
    expect(m.earlier.map((h) => [h.id, h.later === true])).toEqual([["a2", true], ["a3", true]]);
    expect(threadHeading(EN, m.earlier)).toBe("Later in this conversation — all 3 shown");
    expect(threadHeading(DE, m.earlier)).toBe("Später in diesem Verlauf — alle 3 gezeigt");
  });
  it("opened at the newest, every other one is Earlier (the heading as before)", async () => {
    const m = liveMessage(await thread(), "a3", view)!;
    expect(m.earlier.map((h) => [h.id, h.later === true])).toEqual([["a1", false], ["a2", false]]);
    expect(threadHeading(EN, m.earlier)).toBe("Earlier in this conversation — all 3 shown");
    expect(threadHeading(DE, m.earlier)).toBe("Früher in diesem Verlauf — alle 3 gezeigt");
  });
  it("opened in the middle, the others are the rest of the conversation", async () => {
    const m = liveMessage(await thread(), "a2", view)!;
    expect(m.earlier.map((h) => [h.id, h.later === true])).toEqual([["a1", false], ["a3", true]]);
    expect(threadHeading(EN, m.earlier)).toBe("The rest of this conversation — all 3 shown");
    expect(threadHeading(DE, m.earlier)).toBe("Der Rest dieses Verlaufs — alle 3 gezeigt");
  });
  it("each member carries who wrote it, name and address", async () => {
    const m = liveMessage(await thread(), "a2", view)!;
    expect(m.earlier.map((h) => [h.id, h.sender, h.address])).toEqual([["a1", "Lena", LENA.address], ["a3", "Lena", LENA.address]]);
  });
  it("the reader renders this heading, not the bare Earlier line", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MessageReader.tsx", import.meta.url)), "utf8"));
    expect(src).toContain("{threadHeading(Copy, m.earlier)}");
    expect(src).not.toContain("Copy.earlierInThread(");
  });
});
