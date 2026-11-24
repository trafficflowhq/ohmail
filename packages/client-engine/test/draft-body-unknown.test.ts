import type { EngineDraft } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  draftBodyKnown,
  type EngineAdapter,
  type SyncChange,
} from "../src/index.js";

/**
 * A BOUNDED PAGE CAN LEAVE A DRAFT ROW WITHOUT ITS TEXT, AND THE MIRROR SAYS SO.
 *
 * `applyToRecords` stores a change's `entity` verbatim — the protocol's own rule, because a
 * `/sync` change carries a whole DTO — so a page that omits `body` produces a row whose body is
 * ABSENT behind a type that used to promise a string. `EngineDraft.body` is nullable now and
 * {@link draftBodyKnown} is the one predicate; compose consults it before it seeds an editor.
 */

const NOW = new Date("2026-09-10T09:00:00.000Z");

const adapter = (over: Partial<EngineAdapter> = {}): EngineAdapter => ({
  sync: async () => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
  }),
  mutate: async () => { throw new Error("no mutation in this rig"); },
  fetchBody: async () => null,
  ...over,
} as EngineAdapter);

/** A draft change with whatever the page carried — `body` present, `null`, or not at all. */
const draftChange = (entity: Record<string, unknown>): SyncChange => ({
  type: "draft", op: "create", id: "d1", seq: 7,
  updatedAt: NOW.toISOString(),
  entity: {
    id: "d1", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
    subject: "Quarterly numbers", to: [], cc: [], bcc: [], rationale: null,
    status: "draft", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...entity,
  },
});

async function mirrorWith(entity: Record<string, unknown>): Promise<EngineDraft> {
  const store = new MemoryMirrorStore();
  await store.applyChanges([draftChange(entity)]);
  return store.get<EngineDraft>("draft", "d1")!;
}

describe("draftBodyKnown over a real mirror row", () => {
  it("is TRUE for the text of record, empty string included", async () => {
    expect(draftBodyKnown(await mirrorWith({ body: "the third tab changed" }))).toBe(true);
    expect(draftBodyKnown(await mirrorWith({ body: "" }))).toBe(true);
  });

  it("is FALSE for a page that carried no body key at all", async () => {
    const row = await mirrorWith({});
    expect(row.body, "the row kept the DTO the page sent, key for key").toBeUndefined();
    expect(draftBodyKnown(row)).toBe(false);
  });

  it("is FALSE for an explicit null", async () => {
    expect(draftBodyKnown(await mirrorWith({ body: null }))).toBe(false);
  });
});

describe("OhmailEngine.readDraftBody", () => {
  const engineWith = (over: Partial<EngineAdapter>): OhmailEngine =>
    new OhmailEngine({ adapter: adapter(over), store: new MemoryMirrorStore(), now: () => NOW });

  it("answers the text the server holds", async () => {
    const asked: string[] = [];
    const engine = engineWith({
      fetchDraftBody: async (id: string) => { asked.push(id); return "what the account holds"; },
    });
    expect(await engine.readDraftBody("d1")).toBe("what the account holds");
    expect(asked).toEqual(["d1"]);
  });

  it("answers null when the adapter has no such capability — the demo world", async () => {
    /* Absence is a real answer, not a broken adapter: the fixtures' rows always carry a body, so
       `?demo=1` must issue no request for one. */
    expect(await engineWith({}).readDraftBody("d1")).toBeNull();
  });

  it("answers null when the server refuses, rather than an empty body", async () => {
    const engine = engineWith({
      fetchDraftBody: async () => { throw new Error("HTTP 503"); },
    });
    /* NULL AND NOT "". A refusal read as an empty body is the whole defect one layer up: the
       caller would seed an editor with nothing and save it over the message. */
    expect(await engine.readDraftBody("d1")).toBeNull();
  });

  it("writes nothing to the mirror — the row stays the server's", async () => {
    const store = new MemoryMirrorStore();
    await store.applyChanges([draftChange({})]);
    const engine = new OhmailEngine({
      adapter: adapter({ fetchDraftBody: async () => "fetched" }), store, now: () => NOW,
    });
    await engine.readDraftBody("d1");
    expect(
      draftBodyKnown(store.get<EngineDraft>("draft", "d1")!),
      "a local patch would put text at a seq the store never observed",
    ).toBe(false);
  });
});
