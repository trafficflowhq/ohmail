import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import type { ConsentPartition, EntityReader } from "@ohmail/client-engine";
import { GATE_FOLDER } from "@trafficflow/core/destinations";
import { presentedOver } from "../../src/reading/presented-mirror.js";

/** THE PRESENTED MIRROR as the web shell composes it: the gate's holds, the delete window, the held routing. */

const row = (id: string): EngineMessage =>
  ({ id, folder: "INBOX", threadId: "t1" }) as unknown as EngineMessage;

function mirror(rows: EngineMessage[]): EntityReader {
  const by = new Map(rows.map((m) => [m.id, m]));
  return {
    get: (type: string, id: string) => (type === "message" ? by.get(id) : undefined),
    list: (type: string) => (type === "message" ? [...by.values()] : []),
    entries: (type: string) =>
      type === "message" ? [...by.values()].map((m) => ({ id: m.id, entity: m, seq: 1 })) : [],
    version: () => 1,
    stampOf: () => 1,
    stampExcept: () => 1,
  } as unknown as EntityReader;
}

const gate = (ids: string[]) =>
  ({
    placeOf: new Map<string, string | null>(ids.map((id) => [id, GATE_FOLDER])),
    history: [],
    activity: new Map(),
    retiredDecided: new Set(),
    sentInHistory: new Set(),
    counts: {
      consentedSenders: 1,
      activeUndecidedSenders: 1,
      dormantUndecidedSenders: 0,
      historyMessages: 0,
    },
  }) as unknown as ConsentPartition;

describe("the presented mirror", () => {
  const raw = mirror([row("a"), row("b"), row("c")]);

  it("with nothing held and no partition, it reads as the raw mirror", () => {
    const shown = presentedOver(raw, null, new Set(), new Map());
    expect(shown.get<EngineMessage>("message", "a")).toEqual(row("a"));
  });

  it("a letter held at the gate is shown there, still filed where the mail server has it", () => {
    const shown = presentedOver(raw, gate(["b"]), new Set(), new Map());
    expect(shown.get<EngineMessage>("message", "b")).toMatchObject({
      folder: GATE_FOLDER,
      physicalFolder: "INBOX",
    });
  });

  it("a letter inside its delete window is not there; a held routing press shows where it was filed", () => {
    const shown = presentedOver(raw, null, new Set(["a"]), new Map([["c", "ohmail/News" as const]]));
    expect(shown.get("message", "a")).toBeUndefined();
    expect(shown.get<EngineMessage>("message", "c")).toMatchObject({ folder: "ohmail/News" });
  });
});
