import type { EngineMessage, TagEntity as TagDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { HttpAdapter, mutationEffects } from "@ohmail/client-engine";
import type { EntityReader } from "@ohmail/client-engine";

/**
 * THE THREE TAG VERBS THAT HAD NO CALLER — on the wire, and in the mirror.
 *
 * `POST /tags`, `PATCH /tags/:id` and `DELETE /tags/:id` shipped mounted and contract-tested
 * with nothing in the product calling them: Settings offered Rename and Delete buttons that
 * raised "isn't wired up yet", and a tag could only be made by first finding a message to put
 * it on. That is the same "built, tested, unreachable" shape `tag-wire.test.ts` was written
 * for one entity along, and the same one the rules CRUD was in — so it gets the same guard,
 * because the only assertion that catches it is one that watches the HTTP call.
 *
 * The second half of this file watches the OPTIMISTIC EFFECT, and the delete case is the one
 * that matters: the server clears `message_tags` in the same transaction as the tag, so an
 * effect that tombstoned only the tag row would leave its id sitting in every message's
 * `labels` until the next drain.
 */

interface Captured { method: string; url: string; body: unknown }

function adapterCapturing(into: Captured[], response: Response): HttpAdapter {
  return new HttpAdapter({
    baseUrl: "https://api.test",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      into.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response.clone();
    }) as unknown as typeof globalThis.fetch,
  });
}

const ok = (body: unknown, status = 200, seq = "77"): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "X-Sync-Seq": seq },
  });

const TAG: TagDTO = {
  id: "server-id",
  name: "Invoices",
  hue: "moss",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

describe("the tag CRUD reaches the wire", () => {
  it("tag_create POSTs /tags with the NAME and no id — the database mints that", async () => {
    // The id on the mutation names the OPTIMISTIC row only. `TagsService.create` inserts
    // without an id, so sending the client's would be ignored by the server and would tell a
    // reader of this code something false. Same shape as `rule_create`.
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok(TAG, 201));

    const res = await adapter.mutate(
      { kind: "tag_create", tagId: "client-local", name: "Invoices" },
      { idempotencyKey: "idem-1" },
    );

    expect(calls, "the mutation never reached the network").toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/tags");
    expect(calls[0]!.body).toEqual({ name: "Invoices" });
    expect(calls[0]!.body).not.toHaveProperty("id");
    // The SERVER's row is echoed into the mirror, under the SERVER's id.
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({ type: "tag", op: "create", id: "server-id" });
    expect(res.seq).toBe(77);
  });

  it("tag_create sends a hue only when one was chosen", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok(TAG, 201));
    await adapter.mutate(
      { kind: "tag_create", tagId: "c", name: "Travel", hue: "moss" },
      { idempotencyKey: "idem-2" },
    );
    expect(calls[0]!.body).toEqual({ name: "Travel", hue: "moss" });
  });

  it("tag_rename PATCHes the name and nothing else", async () => {
    // `PATCH /tags/:id` accepts `hue` too; a rename must not send it. The colour is its own verb
    // ({@link tag_recolor}) so each request carries exactly the field the user touched.
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok({ ...TAG, name: "Bills" }));

    const res = await adapter.mutate(
      { kind: "tag_rename", tagId: "server-id", name: "Bills" },
      { idempotencyKey: "idem-3" },
    );

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.test/tags/server-id");
    expect(calls[0]!.body).toEqual({ name: "Bills" });
    expect(calls[0]!.body).not.toHaveProperty("hue");
    expect(res.changes[0]).toMatchObject({ type: "tag", op: "update", id: "server-id" });
  });

  it("tag_recolor PATCHes the HUE and nothing else, and echoes the updated row", async () => {
    // The sibling of rename, one field over. If the body ever drops `hue` this goes red — the
    // recolour reaching the wire is the whole point of the verb.
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok({ ...TAG, hue: "rosewood" }));

    const res = await adapter.mutate(
      { kind: "tag_recolor", tagId: "server-id", hue: "rosewood" },
      { idempotencyKey: "idem-3b" },
    );

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.test/tags/server-id");
    expect(calls[0]!.body).toEqual({ hue: "rosewood" });
    expect(calls[0]!.body).not.toHaveProperty("name");
    expect(res.changes[0]).toMatchObject({ type: "tag", op: "update", id: "server-id" });
  });

  it("tag_delete DELETEs, and an already-gone tag is success rather than a rollback", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok(null, 204));
    const res = await adapter.mutate(
      { kind: "tag_delete", tagId: "server-id" },
      { idempotencyKey: "idem-4" },
    );
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/tags/server-id");
    expect(res.changes).toEqual([]);

    const gone: Captured[] = [];
    const adapter404 = adapterCapturing(gone, new Response(null, { status: 404 }));
    const res404 = await adapter404.mutate(
      { kind: "tag_delete", tagId: "server-id" },
      { idempotencyKey: "idem-5" },
    );
    // The tag is gone, which is what the caller asked for. Rolling back an optimistic delete
    // that was correct would put the row back on screen.
    expect(res404.changes).toEqual([]);
    expect(res404.seq).toBeNull();
  });

  it("the tag id is URL-encoded, so an id with a slash cannot forge a path", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok(null, 204));
    await adapter.mutate({ kind: "tag_delete", tagId: "a/../b" }, { idempotencyKey: "idem-6" });
    expect(calls[0]!.url).toBe("https://api.test/tags/a%2F..%2Fb");
  });
});

/* ── the optimistic half ────────────────────────────────────────────────────────────── */

function readerOf(tags: TagDTO[], messages: Array<Partial<EngineMessage> & { id: string; labels: string[] }>): EntityReader {
  const msgs = messages as unknown as EngineMessage[];
  return {
    get: <T,>(type: string, id: string): T | undefined =>
      (type === "tag"
        ? tags.find((t) => t.id === id)
        : msgs.find((m) => m.id === id)) as T | undefined,
    list: <T,>(type: string): T[] => (type === "tag" ? tags : msgs) as unknown as T[],
    entries: <T,>(type: string): Array<[string, T]> =>
      (type === "tag" ? tags : msgs).map((e) => [e.id, e as unknown as T]),
  } as unknown as EntityReader;
}

const ctx = { now: () => new Date("2026-08-04T12:00:00.000Z"), uuid: () => "minted" };

describe("the optimistic half", () => {
  it("tag_create paints one tag row, and an empty name paints nothing", () => {
    const reader = readerOf([], []);
    const made = mutationEffects(reader, { kind: "tag_create", tagId: "t-new", name: "  Invoices " }, ctx);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ type: "tag", id: "t-new" });
    expect((made[0]!.entity as TagDTO).name).toBe("Invoices");
    // The default matches the server's, so the optimistic row and the echo agree.
    expect((made[0]!.entity as TagDTO).hue).toBe("moss");

    // The server answers 400 for this; [] is the engine's "nothing to do" and it reports a
    // rejection rather than painting a nameless row.
    expect(mutationEffects(reader, { kind: "tag_create", tagId: "t", name: "   " }, ctx)).toEqual([]);
  });

  it("tag_rename rewrites the row it has, and refuses one it does not", () => {
    const reader = readerOf([TAG], []);
    const renamed = mutationEffects(reader, { kind: "tag_rename", tagId: "server-id", name: "Bills" }, ctx);
    expect((renamed[0]!.entity as TagDTO).name).toBe("Bills");
    expect(mutationEffects(reader, { kind: "tag_rename", tagId: "nope", name: "Bills" }, ctx)).toEqual([]);
  });

  it("INVARIANT #2: tag_assign writes an ASSIGNMENT and never a rule — the bulk consent guard", () => {
    // A bulk tag over a selection is `tag_assign` fanned out (`bulkToggleTag` in `AppShell`). A
    // bulk act may write assignments ONLY: "always tag this sender" is a rule the user makes
    // explicitly, never one inferred from having tagged a batch once. So no `tag_assign` path may
    // emit a `rule` effect. If one ever does — a "learn from this" shortcut, say — this goes red.
    const reader = readerOf(
      [{ ...TAG }],
      [{ id: "m-1", labels: [] }, { id: "m-2", labels: [] }],
    );
    for (const id of ["m-1", "m-2"]) {
      const effects = mutationEffects(reader, { kind: "tag_assign", messageId: id, tagId: "server-id", assigned: true }, ctx);
      expect(effects.map((e) => e.type)).toEqual(["message"]);
      expect(effects.some((e) => e.type === "rule"), "a bulk tag-assign must write zero rules").toBe(false);
    }
  });

  it("tag_recolor rewrites the hue it has, keeps the name, and refuses a missing row or blank hue", () => {
    const reader = readerOf([{ ...TAG, name: "Invoices", hue: "moss" }], []);
    const recoloured = mutationEffects(reader, { kind: "tag_recolor", tagId: "server-id", hue: "rosewood" }, ctx);
    expect((recoloured[0]!.entity as TagDTO).hue).toBe("rosewood");
    // The name rides along untouched — recolour is one field.
    expect((recoloured[0]!.entity as TagDTO).name).toBe("Invoices");
    // Drop the hue → the guard proves the hue is what makes the effect: blank yields nothing.
    expect(mutationEffects(reader, { kind: "tag_recolor", tagId: "server-id", hue: "  " }, ctx)).toEqual([]);
    expect(mutationEffects(reader, { kind: "tag_recolor", tagId: "nope", hue: "moss" }, ctx)).toEqual([]);
  });

  it("THE ONE THAT MATTERS: deleting a tag also strips it from every message that carried it", () => {
    // `TagsService.remove` deletes the `message_tags` rows in the same transaction and emits
    // one `message` change each. An effect that tombstoned only the tag would leave a dead id
    // in `labels` until the next drain — two representations of one fact, disagreeing.
    const reader = readerOf(
      [TAG],
      [
        { id: "m-1", labels: ["server-id", "other"] },
        { id: "m-2", labels: ["other"] },
        { id: "m-3", labels: ["server-id"] },
      ],
    );

    const effects = mutationEffects(reader, { kind: "tag_delete", tagId: "server-id" }, ctx);

    const touched = effects.filter((e) => e.type === "message");
    expect(touched.map((e) => e.id).sort()).toEqual(["m-1", "m-3"]);
    expect((touched.find((e) => e.id === "m-1")!.entity as EngineMessage).labels).toEqual(["other"]);
    expect((touched.find((e) => e.id === "m-3")!.entity as EngineMessage).labels).toEqual([]);

    const tomb = effects.find((e) => e.type === "tag");
    expect(tomb, "the tag row itself must be tombstoned").toBeDefined();
    expect(tomb!.entity).toBeNull();

    expect(mutationEffects(reader, { kind: "tag_delete", tagId: "nope" }, ctx)).toEqual([]);
  });
});
