import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { dispatchMarkAllRead, MARK_SEEN_CHUNK } from "../../src/reading/read-all.js";

describe("dispatchMarkAllRead — chunked at the route's cap", () => {
  it("splits more ids than the batch cap into ceil(n/cap) mark_seen mutations, each within the cap and unread:false", () => {
    const seen: EngineMutation[] = [];
    const n = 2 * MARK_SEEN_CHUNK + 37; // 437
    const ids = Array.from({ length: n }, (_, i) => `id-${i}`);

    const chunks = dispatchMarkAllRead((m) => seen.push(m), ids);

    expect(chunks).toBe(Math.ceil(n / MARK_SEEN_CHUNK)); // 3
    expect(seen).toHaveLength(3);
    // RED-FIRST: replace the loop with a single `mutate({..., messageIds: ids, ...})` and this
    // fails — one 437-id mutation would 413 on the wire.
    for (const m of seen) {
      expect(m.kind).toBe("mark_seen");
      const mm = m as Extract<EngineMutation, { kind: "mark_seen" }>;
      expect(mm.unread).toBe(false);
      expect(mm.messageIds.length).toBeLessThanOrEqual(MARK_SEEN_CHUNK);
    }
    // Every id is covered exactly once, order preserved.
    const flat = seen.flatMap((m) => (m as Extract<EngineMutation, { kind: "mark_seen" }>).messageIds);
    expect(flat).toEqual(ids);
  });

  it("dispatches nothing for an empty selection", () => {
    const seen: EngineMutation[] = [];
    expect(dispatchMarkAllRead((m) => seen.push(m), [])).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("a selection at exactly the cap is one chunk", () => {
    const seen: EngineMutation[] = [];
    const ids = Array.from({ length: MARK_SEEN_CHUNK }, (_, i) => `id-${i}`);
    expect(dispatchMarkAllRead((m) => seen.push(m), ids)).toBe(1);
  });
});
