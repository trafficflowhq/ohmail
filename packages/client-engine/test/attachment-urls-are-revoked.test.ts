import type { AttachmentWire } from "@ohmail/wire";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { ObjectUrlLedger } from "../src/object-urls.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * Minting an object URL and owing its revocation are ONE act.
 *
 * The defect: the only record of a minted URL was the attachment ENTRY, which the release path is
 * allowed to delete first. Open an attachment, move on before the bytes land, and the completion
 * mints a `blob:` URL that is written nowhere — the tab holds the whole file until the document
 * dies. The counters below sit on the ENGINE's own calls to a stubbed URL pair, never on a revoke
 * the test performed.
 */

const NOOP_SYNC = { changes: [], cursor: "1", hasMore: false };

let minted: string[];
let revoked: string[];
beforeEach(() => {
  minted = [];
  revoked = [];
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: (b: Blob) => {
      const u = `blob:${minted.length}:${b.type}`;
      minted.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => {
      revoked.push(u);
    },
  };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

function makeAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => NOOP_SYNC as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

function wire(id: string, messageId = "m1"): AttachmentWire {
  return { id, filename: `${id}.pdf`, contentType: "application/pdf", sizeBytes: 12, inline: false, messageId };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PDF = () => new Blob(["x"], { type: "application/pdf" });

describe("attachment object URLs are revoked", () => {
  /**
   * ══ CONTROL 1 — ABANDON BEFORE COMPLETION ═════════════════════════════════════════════════
   * Two mutations watched red separately, because both halves are load-bearing: drop the
   * registration from `ObjectUrlLedger.mint`, and drop the completion-path revoke in
   * `openAttachment`. Each fails as:
   *   AssertionError: a URL minted after the release is held by the tab for the life of the
   *   document: expected [] to deeply equal [ 'blob:0:application/pdf' ]
   */
  it("a fetch that lands after the release still revokes its URL", async () => {
    const gate = deferred<Blob>();
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire("a1")],
        fetchAttachment: () => gate.promise,
      }),
    });
    await engine.loadAttachments("m1");

    const open = engine.openAttachment("m1", "a1");
    // The reader moves on while the bytes are still on the wire.
    engine.releaseAllAttachments();
    gate.resolve(PDF());
    await open;

    expect(minted).toHaveLength(1);
    expect(
      revoked,
      "a URL minted after the release is held by the tab for the life of the document",
    ).toEqual(minted);
  });
  /**
   * ══ CONTROL 2 — THE ORDINARY PATH, EXACTLY ONCE ═══════════════════════════════════════════
   * The positive control: the ordinary open and release is admitted, and it frees that message
   * alone. A double revoke is harmless in a browser and hides a second defect, so it is asserted.
   * Mutation: drop `this.ownerOf.delete(url)` from `ObjectUrlLedger.releaseOwner`. Real failure:
   *   AssertionError: the same object URL was revoked twice: expected 2 to be 4
   */
  it("an opened attachment is revoked once by its own message's release, and no other's", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async (messageId: string) => [wire("a1", messageId)],
        fetchAttachment: async () => PDF(),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    await engine.loadAttachments("m2");
    await engine.openAttachment("m2", "a1");
    expect(minted).toHaveLength(2);

    engine.releaseAttachments("m1");
    expect(revoked, "a per-message release drained another message's URLs").toEqual([minted[0]]);

    // Releasing the same message again has nothing left to free.
    engine.releaseAttachments("m1");
    expect(revoked).toHaveLength(1);

    engine.releaseAllAttachments();
    expect(new Set(revoked).size, "the same object URL was revoked twice").toBe(revoked.length);
    expect(revoked).toEqual(minted);
  });

  /**
   * Mutation: drop `if (owner === undefined) return;` from `ObjectUrlLedger.revoke` (revoke
   * whatever it is handed). Real failure text:
   *   AssertionError: the same object URL was revoked twice: expected [ 'blob:0:application/pdf',
   *   …(1) ] to have a length of 1 but got 2
   */
  it("the ledger revokes one URL once, however many times it is asked", () => {
    const ledger = new ObjectUrlLedger();
    const url = ledger.mint("m1", PDF())!;
    ledger.revoke(url);
    ledger.revoke(url);
    ledger.releaseOwner("m1");
    ledger.releaseAll();
    expect(revoked.filter((u) => u === url), "the same object URL was revoked twice").toHaveLength(1);
  });

  /**
   * ══ CONTROL 3 — A REVOKED URL IS NOT KEPT ALIVE ═══════════════════════════════════════════
   * A release frees the URL and the ledger forgets it, so the re-open's mint is its own debt and
   * the teardown does not revoke a dead URL a second time.
   * Mutation: drop `this.ownerOf.delete(url)` from `ObjectUrlLedger.releaseOwner`. Real failure:
   *   AssertionError: the ledger kept a revoked URL alive: expected [ 'blob:0:application/pdf',
   *   …(1) ] to have a length of 1 but got 2
   */
  it("a URL revoked before a re-mint is gone from the ledger, and the re-mint is its own debt", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire("a1")],
        fetchAttachment: async () => PDF(),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    engine.releaseAttachments("m1");
    // The reader comes back: a fresh list, a fresh fetch, a second URL.
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    expect(minted).toHaveLength(2);

    engine.releaseAllAttachments();
    expect(revoked.filter((u) => u === minted[0]), "the ledger kept a revoked URL alive").toHaveLength(1);
    expect(revoked).toEqual(minted);
  });

  /**
   * ══ CONTROL 4 — THE LEDGER IS BOUNDED ═════════════════════════════════════════════════════
   * It may not become the new unbounded structure: live URLs never exceed the entries that carry
   * one plus the fetches still in flight, and a teardown leaves nothing.
   * Mutation: drop the completion-path revoke in `openAttachment`. Real failure text:
   *   AssertionError: the ledger holds a URL no entry and no flight can account for: expected
   *   1 to be less than or equal to 0
   */
  it("live URLs never exceed the entries carrying one plus the fetches in flight", async () => {
    const gate = deferred<Blob>();
    let hang = false;
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async (messageId: string) => [wire("a1", messageId), wire("a2", messageId)],
        fetchAttachment: async () => (hang ? gate.promise : PDF()),
      }),
    });
    const withUrl = (id: string): number => {
      const v = engine.attachmentsOf(id);
      return v.state === "ready" ? v.items.filter((i) => i.objectUrl).length : 0;
    };
    const live = (): number => minted.length - revoked.length;

    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    await engine.loadAttachments("m2");
    await engine.openAttachment("m2", "a1");
    hang = true;
    const inFlight = engine.openAttachment("m1", "a2");
    expect(live()).toBeLessThanOrEqual(withUrl("m1") + withUrl("m2") + 1);

    engine.releaseAttachments("m2");
    expect(live()).toBeLessThanOrEqual(withUrl("m1") + 1);

    engine.releaseAllAttachments();
    gate.resolve(PDF());
    await inFlight;
    expect(
      live(),
      "the ledger holds a URL no entry and no flight can account for",
    ).toBeLessThanOrEqual(0);
    // Release order is not mint order here — m2 went first.
    expect([...revoked].sort()).toEqual([...minted].sort());
  });

  /**
   * Mutation: drop `this.ownerOf.delete(url)` from `ObjectUrlLedger.releaseOwner`. Real failure:
   *   AssertionError: the ledger holds a URL no entry and no flight can account for: expected
   *   3 to be 1
   */
  it("the ledger's own count falls to nothing", () => {
    const ledger = new ObjectUrlLedger();
    ledger.mint("m1", PDF());
    ledger.mint("m1", PDF());
    const second = ledger.mint("m2", PDF())!;
    expect(ledger.size).toBe(3);
    expect(ledger.ownerCount).toBe(2);

    ledger.releaseOwner("m1");
    expect(ledger.size, "the ledger holds a URL no entry and no flight can account for").toBe(1);
    expect(ledger.ownerCount).toBe(1);

    ledger.revoke(second);
    expect(ledger.size).toBe(0);
    expect(ledger.ownerCount).toBe(0);
    ledger.releaseAll();
    expect(ledger.size).toBe(0);
  });
});
