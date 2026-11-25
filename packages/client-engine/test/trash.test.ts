import { describe, it, expect, vi } from "vitest";
import { HttpAdapter, OhmailEngine, applyToRecords, type MirrorRecord } from "../src/index.js";

/**
 * THE ENGINE'S TRASH PAIR — absence is an ANSWER, and a restore is not a mutation.
 *
 * Three properties, and each of them is a state the product has to be able to render rather than
 * a happy path:
 *
 *  1. an adapter with NEITHER capability reports "unavailable" and never throws;
 *  2. an adapter with ONE of the two reports unavailable as well, because a Trash list whose
 *     Restore is dead is not the feature and a half-forward must turn it off rather than half on
 *     (the wrapper that rebuilds the adapter as an object literal forwards them one at a time);
 *  3. a `create` after a `delete` re-adds the entity — the apply contract's own rule 4, which is
 *     what makes the restore's end-to-end path work without the restore emitting anything.
 */

/** The smallest adapter the engine will construct over. */
function bareAdapter(extra: Record<string, unknown> = {}) {
  return {
    sync: async () => ({ cursor: 0, changes: { creates: [], updates: [], moves: [], deletes: [] }, hasMore: false }),
    mutate: async () => ({ status: "confirmed" as const }),
    ...extra,
  };
}

const engineOver = (extra: Record<string, unknown> = {}) =>
  new OhmailEngine({ adapter: bareAdapter(extra) as never });

describe("the engine's Trash pair", () => {
  it("reports UNAVAILABLE with neither capability, and answers rather than throwing", async () => {
    const e = engineOver();
    expect(e.trashAvailable()).toBe(false);
    await expect(e.listTrash()).resolves.toEqual({ state: "unavailable" });
    await expect(e.restoreFromTrash("m1")).resolves.toEqual({ state: "unavailable" });
  });

  it("reports UNAVAILABLE with only the LIST forwarded — a bin with a dead button is not the feature", async () => {
    const listTrash = vi.fn(async () => ({ items: [], nextCursor: null }));
    const e = engineOver({ listTrash });
    expect(e.trashAvailable()).toBe(false);
    /* The list still WORKS when asked directly — the gate is about what a surface may OFFER,
       not about disabling a capability that was forwarded. Two different questions, and
       collapsing them would make a forwarded method unreachable. */
    await expect(e.listTrash()).resolves.toMatchObject({ state: "ready" });
    await expect(e.restoreFromTrash("m1")).resolves.toEqual({ state: "unavailable" });
  });

  it("reports UNAVAILABLE with only the VERB forwarded", () => {
    const e = engineOver({ restoreFromTrash: async () => ({ restoreTo: "INBOX", pending: true }) });
    expect(e.trashAvailable()).toBe(false);
  });

  it("reports AVAILABLE with both, and carries the two row fields through untouched", async () => {
    const e = engineOver({
      listTrash: async () => ({
        items: [{ id: "m1", subject: "s", trashedAt: "2026-09-09T10:00:00.000Z", restoreTo: "ohmail/News" }],
        nextCursor: "c2",
      }),
      restoreFromTrash: async () => ({ restoreTo: "Projects", pending: true }),
    });
    expect(e.trashAvailable()).toBe(true);
    const page = await e.listTrash({ limit: 10 });
    expect(page).toMatchObject({ state: "ready", nextCursor: "c2" });
    expect(page.state === "ready" && page.items[0]).toMatchObject({
      id: "m1", trashedAt: "2026-09-09T10:00:00.000Z", restoreTo: "ohmail/News",
    });
    await expect(e.restoreFromTrash("m1")).resolves.toEqual({
      state: "restored", restoreTo: "Projects", pending: true,
    });
  });

  it("a NULL wire is unavailable and never an empty ready — \"there is nothing in Trash\" is a claim", async () => {
    const e = engineOver({
      listTrash: async () => null,
      restoreFromTrash: async () => null,
    });
    await expect(e.listTrash()).resolves.toEqual({ state: "unavailable" });
    await expect(e.restoreFromTrash("m1")).resolves.toEqual({ state: "unavailable" });
  });

  it("a throwing transport becomes a VALUE — the caller is a render effect, not a try block", async () => {
    const e = engineOver({
      listTrash: async () => { throw new Error("no"); },
      restoreFromTrash: async () => { throw new Error("gone"); },
    });
    await expect(e.listTrash()).resolves.toMatchObject({ state: "failed", error: "no", code: null });
    await expect(e.restoreFromTrash("m1")).resolves.toMatchObject({ state: "rolled_back", error: "gone" });
  });

  it("is SINGLE-FLIGHT per page and per message — a double press is one request", async () => {
    const listTrash = vi.fn(async () => ({ items: [], nextCursor: null }));
    const restoreFromTrash = vi.fn(async () => ({ restoreTo: "INBOX", pending: true }));
    const e = engineOver({ listTrash, restoreFromTrash });
    await Promise.all([e.listTrash({ limit: 5 }), e.listTrash({ limit: 5 })]);
    expect(listTrash).toHaveBeenCalledTimes(1);
    await Promise.all([e.restoreFromTrash("m1"), e.restoreFromTrash("m1")]);
    expect(restoreFromTrash).toHaveBeenCalledTimes(1);
  });

  it("sends the press's own Idempotency-Key when the caller has one, and none when it does not", async () => {
    /* The route is `idempotent`-marked, so a client whose first response was lost replays the
       SAME intent under the SAME key and is answered with the first response — without a key it
       met the state check and was told 409 `not_in_trash` about a restore already committed to.
       The key is composed HERE so one place owns what goes in the header, and a caller with no
       durable record of the press sends none rather than an invented one, which would make two
       deliberate presses look like one intent. */
    const seen: Array<[string, unknown]> = [];
    const e = engineOver({
      listTrash: async () => ({ items: [], nextCursor: null }),
      restoreFromTrash: async (id: string, opts: unknown) => {
        seen.push([id, opts]);
        return { restoreTo: "INBOX", pending: true };
      },
    });
    await e.restoreFromTrash("m1", { intentId: "press-7" });
    await e.restoreFromTrash("m2");
    expect(seen).toEqual([
      ["m1", { idempotencyKey: "restore:press-7:m1" }],
      ["m2", {}],
    ]);
  });

  it("the wire carries that key as `Idempotency-Key`, and sends no header without one", async () => {
    /* THE WIRE IS THE ASSERTION. The case above proves the engine hands the key to the
       transport; this proves the transport puts it in the header the route reads. A key the
       engine composes and the adapter drops would leave the replay unprotected with both halves
       looking correct. */
    const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const adapter = new HttpAdapter({
      baseUrl: "https://api.test",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response(JSON.stringify({ restoreTo: "ohmail/News", pending: true }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
    });

    await adapter.restoreFromTrash("m1", { idempotencyKey: "restore:press-7:m1" });
    await adapter.restoreFromTrash("m2");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.test/messages/m1/restore",
      "POST https://api.test/messages/m2/restore",
    ]);
    expect(calls[0]!.headers["idempotency-key"]).toBe("restore:press-7:m1");
    expect(calls[1]!.headers["idempotency-key"], "no durable record, no key").toBeUndefined();
  });

  it("WHY a restore is not a mutation: a Trash row is a TOMBSTONE here, which mutate refuses", async () => {
    /* THE MEASURED REASON `restoreFromTrash` exists as a plain call. A delete tombstones the row
       (`apply.ts` rule 4), so every message in Trash is one this mirror HOLDS as gone: a verb over
       it computes no local effects and is refused 404 `not_found` before the wire. A message the
       mirror never recorded is the other case — sent by id, the server's to refuse (ARCHIVE-024) —
       and it is the control below. Mutated: with the `effects.length === 0` arm removed this resolves. */
    const mutate = vi.fn(async () => ({ changes: [], seq: null }));
    const e = engineOver({ mutate });
    await e.store.applyChanges([{ type: "message", op: "delete", id: "in-trash", seq: 1, updatedAt: "t", entity: null } as never]);
    const out = await e.mutate({ kind: "message_delete", messageId: "in-trash" });
    expect(out.status).toBe("rolled_back");
    expect(out.error, "and it says which").toMatchObject({ code: "not_found" });
    expect(mutate, "nothing reached the wire").not.toHaveBeenCalled();
    await e.mutate({ kind: "message_delete", messageId: "never-recorded" });
    expect(mutate, "a row this mirror never recorded is sent").toHaveBeenCalledTimes(1);
  });
});

describe("the apply contract's own half of a restore", () => {
  it("a CREATE after a DELETE re-adds the entity, and an UPDATE does the same", () => {
    /* THE POSITIVE CONTROL the restore path depends on end to end. The restore emits nothing
       that resurrects a row: the mail server moves the message, the passive read observes it in
       the target, `clearDeletedOnAdopt` clears the tombstone, and the arrival's change carries
       the live entity. Whether that change's op is `create`, `update` or `move` is not the
       surface's business — the apply contract upserts all three — and this is where that is
       true rather than assumed. */
    const records = new Map<string, MirrorRecord>();
    applyToRecords(records, [
      { type: "message", op: "create", id: "m1", seq: 1, updatedAt: "t", entity: { id: "m1" } } as never,
    ]);
    expect(records.get("message:m1")!.entity).toEqual({ id: "m1" });

    applyToRecords(records, [
      { type: "message", op: "delete", id: "m1", seq: 2, updatedAt: "t" } as never,
    ]);
    expect(records.get("message:m1")!.entity, "tombstoned").toBeNull();

    applyToRecords(records, [
      { type: "message", op: "update", id: "m1", seq: 3, updatedAt: "t", entity: { id: "m1", back: true } } as never,
    ]);
    expect(records.get("message:m1")!.entity, "an UPDATE resurrects too — create and update are one upsert")
      .toEqual({ id: "m1", back: true });

    /* And a REPLAYED delete at an older seq stays dead-letter: it does not re-tombstone the
       resurrected row, which is what makes the drain order-independent. */
    applyToRecords(records, [
      { type: "message", op: "delete", id: "m1", seq: 2, updatedAt: "t" } as never,
    ]);
    expect(records.get("message:m1")!.entity).toEqual({ id: "m1", back: true });
  });
});
