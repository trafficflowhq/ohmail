import { describe, expect, it } from "vitest";
import { STORE_REFUSED_DETAIL, storageRowSentence, type RowDoor } from "../src/storage-row-sentence.js";

/**
 * EVERY `storage` ROW HAS EXACTLY ONE SENTENCE, from one table. "This computer cannot store mail right
 * now" is the device store refusing writes on the LOCAL door and nothing else: a held write-off run, the
 * hosted worker's OVERQUOTA and a paired host's refusal keep the code's own sentence, and a stated count
 * always wins. The detail token is the sidecar's own spelling (`STORE_REFUSED_DETAIL` in engine.ts).
 */
describe("the storage row's sentence, by door and detail", () => {
  const doors: RowDoor[] = ["local", "cloud", "paired"];
  const details = [STORE_REFUSED_DETAIL, null, undefined, "MAILBOX_PLAINTEXT_REFUSED"];

  it("the detail token is the engine's spelling", () => {
    expect(STORE_REFUSED_DETAIL).toBe("MAILBOX_STORE_REFUSED");
  });

  it("covers every door, detail and count, and names the store only for the local door's refusal", () => {
    const table: string[] = [];
    for (const door of doors) for (const detail of details) for (const hasCount of [true, false]) {
      table.push(`${door} ${String(detail)} ${hasCount} -> ${storageRowSentence(door, detail, hasCount)}`);
    }
    expect(table.filter((l) => l.endsWith("storeRefused"))).toEqual(["local MAILBOX_STORE_REFUSED false -> storeRefused"]);
    expect(table.filter((l) => l.endsWith("count"))).toHaveLength(doors.length * details.length);
    expect(table.filter((l) => l.endsWith("code"))).toHaveLength(doors.length * details.length - 1);
  });

  it("a held write-off run, OVERQUOTA and a paired host's refusal keep the code", () => {
    expect(storageRowSentence("local", null, false)).toBe("code");
    expect(storageRowSentence("cloud", null, false)).toBe("code");
    expect(storageRowSentence("paired", STORE_REFUSED_DETAIL, false)).toBe("code");
  });
});
