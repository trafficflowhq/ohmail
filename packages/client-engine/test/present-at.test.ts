import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { presentAt } from "../src/present-at.js";
import type { EntityReader } from "../src/store.js";

/**
 * THE HELD PRESS'S PRESENTATION. A row's place comes from its sender's RULE, so a Move whose rule
 * is waiting out its undo window would move nothing on screen — this is what carries it, and it is
 * a promise rather than a fact: `physicalFolder` still says where the mail actually is.
 */

function msg(id: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, folder: "INBOX", date: "2026-08-02T09:00:00.000Z", unread: false, labels: [],
    from: { name: null, address: "a@b.test" }, to: [], cc: [], subject: "s", snippet: "",
    ...over,
  } as unknown as EngineMessage;
}

function readerOf(rows: EngineMessage[]): EntityReader {
  return {
    version: () => 1,
    stampOf: () => 1,
    stampExcept: () => 1,
    get: <T,>(type: string, id: string) =>
      (type === "message" ? rows.find((r) => r.id === id) : undefined) as T | undefined,
    list: <T,>(type: string) => (type === "message" ? rows : []) as T[],
    entries: <T,>(type: string) =>
      (type === "message" ? rows.map((r, i) => ({ id: r.id, entity: r as unknown as T, seq: i })) : []),
  } as EntityReader;
}

const READS = "ohmail/Reads" as Folder;

describe("presentAt", () => {
  it("shows a named message at the place it was filed, on every door", () => {
    const base = readerOf([msg("m1"), msg("m2")]);
    const at = presentAt(base, new Map([["m1", READS]]));
    expect(at.get<EngineMessage>("message", "m1")!.folder).toBe(READS);
    expect(at.get<EngineMessage>("message", "m2")!.folder, "an unnamed row moved").toBe("INBOX");
    expect(at.list<EngineMessage>("message").map((m) => m.folder)).toEqual([READS, "INBOX"]);
    expect(at.entries<EngineMessage>("message").map((e) => e.entity.folder)).toEqual([READS, "INBOX"]);
  });

  it("keeps where the mail ACTUALLY is — the place shown is a promise, not a fact", () => {
    const at = presentAt(readerOf([msg("m1")]), new Map([["m1", READS]]));
    expect(at.get<EngineMessage>("message", "m1")!.physicalFolder).toBe("INBOX");
  });

  it("an existing projection's physical folder survives a second overlay", () => {
    /* `presentationReader` has already re-placed this row; the window's overlay may re-place it
       again and must not claim the PRESENTED place is where the mail sits. */
    const projected = msg("m1", { folder: "ohmail/Receipts" as Folder, physicalFolder: "INBOX" });
    const at = presentAt(readerOf([projected]), new Map([["m1", READS]]));
    expect(at.get<EngineMessage>("message", "m1")!.physicalFolder).toBe("INBOX");
  });

  it("returns the base reader UNWRAPPED when nothing is held", () => {
    /* Identity, not equality: this is every render but the few seconds after a Move, and a fresh
       wrapper each time would break the memo identities every downstream derivation keys on. */
    const base = readerOf([msg("m1")]);
    expect(presentAt(base, new Map())).toBe(base);
  });

  it("forwards the stamps rather than answering its own", () => {
    let asked: string[] = [];
    const base = { ...readerOf([msg("m1")]), stampOf: (t: string) => { asked.push(t); return 7; } };
    const at = presentAt(base as EntityReader, new Map([["m1", READS]]));
    expect(at.stampOf("message")).toBe(7);
    expect(asked, "a wrapper answered a stamp its base did not").toEqual(["message"]);
  });

  it("a row already at the named place is left alone, object and all", () => {
    const row = msg("m1", { folder: READS });
    const at = presentAt(readerOf([row]), new Map([["m1", READS]]));
    expect(at.get<EngineMessage>("message", "m1")).toBe(row);
  });

  it("types other than message pass straight through", () => {
    const base = readerOf([msg("m1")]);
    const at = presentAt(base, new Map([["m1", READS]]));
    expect(at.list("rule")).toEqual([]);
  });
});
