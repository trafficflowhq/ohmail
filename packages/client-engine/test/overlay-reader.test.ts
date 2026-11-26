import { describe, expect, it, vi } from "vitest";
import { OverlayReader } from "../src/engine/overlay-reader.js";
import type { MutationEffect } from "../src/mutations.js";
import { MemoryMirrorStore } from "../src/store.js";

const type = "message";
const updatedAt = "2026-01-01T00:00:00Z";

describe("optimistic message reads", () => {
  it("shares the merge while returning independent lists in mailbox order", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(["recent", "removed", "older"].map((id, i) => ({
      type, id, op: "create", seq: i + 1, updatedAt, entity: id,
    })));
    const entries = vi.spyOn(store, "entries");
    const overlays = new Map<string, MutationEffect[]>([["action", [
      { type, id: "recent", entity: "read" },
      { type, id: "removed", entity: null },
      { type, id: "new", entity: "new" },
    ]]]);
    let revision = 1;
    const reader = new OverlayReader(store, overlays, () => revision);

    expect(reader.list(type).reverse()).toEqual(["new", "older", "read"]);
    const first = reader.entries(type);
    expect(first).toEqual([
      { id: "recent", entity: "read", seq: 1 },
      { id: "older", entity: "older", seq: 3 },
      { id: "new", entity: "new", seq: 0 },
    ]);
    first[0]!.seq = 99;
    expect(reader.entries(type)[0]?.seq).toBe(1);
    expect(entries).toHaveBeenCalledTimes(1);

    await store.applyChanges([{ type, id: "older", op: "delete", seq: 4, updatedAt }]);
    expect(reader.list(type)).toEqual(["read", "new"]);
    overlays.set("action", [{ type, id: "recent", entity: "moved" }]);
    // Reads during a durable write can see replaced effects before the next publish.
    expect(reader.list(type)).toEqual(["moved", "removed"]);
    revision++;
    overlays.clear();
    expect(reader.list(type)).toEqual(["recent", "removed"]);
  });
});
