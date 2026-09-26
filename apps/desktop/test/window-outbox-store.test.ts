import { describe, expect, it } from "vitest";
import { OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE } from "@ohmail/client-engine";

import { WINDOW_OUTBOX_PATH, WindowOutboxStore, type OutboxFetch } from "../src/window-outbox-store.js";

/**
 * The window's store (`window-outbox-store.ts`): the mirror in memory, the two outbox types on the
 * engine's door. What it must never do is make a request for any other row — the eager body pass
 * writes hundreds — or publish an outbox row the door did not take.
 */

interface Sent { method: string; url: string; body: { puts?: Array<{ type: string; id: string }>; deletes?: Array<{ type: string; id: string }> } | null }

function door(answer: (s: Sent) => Response = () => new Response(null, { status: 204 })) {
  const sent: Sent[] = [];
  const fetch: OutboxFetch = async (url, init) => {
    const i = (init ?? {}) as { method?: string; body?: string };
    const s: Sent = { method: i.method ?? "GET", url, body: i.body ? JSON.parse(i.body) as Sent["body"] : null };
    sent.push(s);
    return answer(s);
  };
  return { sent, fetch };
}

const row = (type: string, id: string) => ({ type, id, entity: { id } });
const SCOPE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = `${WINDOW_OUTBOX_PATH}?scope=${SCOPE}`;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("WindowOutboxStore", () => {
  it("a commit of bodies alone asks the door nothing", async () => {
    const d = door();
    const store = new WindowOutboxStore({ scope: SCOPE, write: d.fetch });
    await store.commitLocal([row("message_body", "m-1"), row("message_body", "m-2")], []);
    expect(d.sent).toEqual([]);
    expect(store.get("message_body", "m-1")).toEqual({ id: "m-1" });
  });

  it("a mixed commit carries only the outbox rows to the door", async () => {
    const d = door();
    const store = new WindowOutboxStore({ scope: SCOPE, write: d.fetch });
    await store.commitLocal(
      [row(OUTBOX_ABANDONED_TYPE, "v-1"), row("message_body", "m-1")],
      [{ type: OUTBOX_TYPE, id: "v-1" }, { type: "held_release_group", id: "r-1" }],
    );
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.url, "every request names the mailbox this window serves").toBe(AT);
    expect(d.sent[0]!.body).toEqual({
      puts: [{ type: OUTBOX_ABANDONED_TYPE, id: "v-1", entity: { id: "v-1" } }],
      deletes: [{ type: OUTBOX_TYPE, id: "v-1" }],
    });
  });

  it("a refused write rejects the commit and publishes nothing", async () => {
    const d = door(() => new Response("{}", { status: 500 }));
    const store = new WindowOutboxStore({ scope: SCOPE, write: d.fetch });
    await expect(store.commitLocal([row(OUTBOX_TYPE, "v-1")], [])).rejects.toThrow(/refused the outbox write/);
    expect(store.get(OUTBOX_TYPE, "v-1")).toBeUndefined();
  });

  it("a busy shell's named wait is asked again, then the write lands", async () => {
    let n = 0;
    const d = door(() => (++n === 1
      ? new Response("{}", { status: 503, headers: { "retry-after": "0" } })
      : new Response(null, { status: 204 })));
    const store = new WindowOutboxStore({ scope: SCOPE, write: d.fetch });
    await store.commitLocal([row(OUTBOX_TYPE, "v-1")], []);
    expect(d.sent).toHaveLength(2);
    expect(store.get(OUTBOX_TYPE, "v-1")).toEqual({ id: "v-1" });
  });

  it("a terminal delete of an outbox row reaches the door; a body's does not", async () => {
    const d = door();
    const store = new WindowOutboxStore({ scope: SCOPE, write: d.fetch });
    await store.commitLocal([row(OUTBOX_TYPE, "v-1"), row("message_body", "m-1")], []);
    await store.pruneSerialized([{ type: OUTBOX_TYPE, id: "v-1" }, { type: "message_body", id: "m-1" }]);
    expect(d.sent.map((s) => s.body)).toEqual([
      { puts: [{ type: OUTBOX_TYPE, id: "v-1", entity: { id: "v-1" } }], deletes: [] },
      { puts: [], deletes: [{ type: OUTBOX_TYPE, id: "v-1" }] },
    ]);
  });

  it("the load follows every page and keeps what memory already holds", async () => {
    const pages: Record<string, unknown> = {
      [AT]: { rows: [row(OUTBOX_TYPE, "v-1"), row("message", "not-mine")], next: "k1" },
      [`${AT}&after=k1`]: { rows: [row(OUTBOX_ABANDONED_TYPE, "v-2")], next: null },
    };
    const writes = door();
    const reads = door((s) => json(pages[s.url]));
    const store = new WindowOutboxStore({ scope: SCOPE, write: writes.fetch, read: reads.fetch });
    await store.applyChanges([{ type: "message", op: "create", id: "m-9", seq: 3, updatedAt: "", entity: { id: "m-9" } }]);
    await store.load();
    expect(reads.sent.map((s) => s.url)).toEqual([AT, `${AT}&after=k1`]);
    expect(store.get(OUTBOX_TYPE, "v-1")).toBeDefined();
    expect(store.get(OUTBOX_ABANDONED_TYPE, "v-2")).toBeDefined();
    expect(store.get("message", "not-mine"), "the door's answer carries outbox rows only").toBeUndefined();
    expect(store.get("message", "m-9"), "a row already in memory survives the load").toBeDefined();
    expect(writes.sent).toEqual([]);
  });

  it("a load the door refuses rejects, so the engine retries rather than restoring nothing", async () => {
    const d = door(() => new Response("{}", { status: 500 }));
    await expect(new WindowOutboxStore({ scope: SCOPE, write: d.fetch }).load()).rejects.toThrow(/outbox read/);
  });

  it("an engine with no outbox door reads as an empty outbox rather than stopping every drain", async () => {
    const d = door(() => new Response("{}", { status: 404 }));
    const store = new WindowOutboxStore({ scope: SCOPE, write: d.fetch });
    await store.load();
    expect(store.entries(OUTBOX_TYPE)).toEqual([]);
  });
});
