import type { EngineDraft, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  draftBodyKnown,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * A SENT DRAFT'S TEXT IS NOT COLD-MIRROR STATE.
 *
 * A reload replays `GET /sync/snapshot`, which carried every draft WITH its body — including the
 * thousands whose status is `sent`. The `draft` type is outside both eviction policies, so nothing
 * ever takes one back: thousands of sent-draft bodies survive a ten-message window, and for a busy
 * sender's replies that is gigabytes held by an ordinary reload. The rows STAY (the sent list is read
 * offline) and the bodies go, re-fetchable by id. THE CLIENT ENFORCES IT TOO: an older server or a
 * replayed page can still hand this walk the text, and a bound one side keeps the other can lose.
 */

const NOW = new Date("2026-09-14T12:00:00.000Z");

let seq = 0;
function change(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

/**
 * THE ROW AS THE WIRE CARRIES IT. `EngineDraft` does not declare `html` — and the mirror holds it
 * anyway, because `applyToRecords` stores the server's DTO verbatim. That gap is the reason this
 * lane exists in the shape it does: the rich half of every draft was in the mirror under a key no
 * client type names, so a strip written against the declared type would have taken the plain body
 * and left the same words beside it. The test drives the row the wire really sends.
 */
type WireDraft = EngineDraft & { html: string | null };

/** A draft row as the wire carries one. `body` is spelled out because it is the subject. */
function draft(id: string, status: EngineDraft["status"], body: string | null): WireDraft {
  return {
    id, mailboxId: "mb", threadId: null, inReplyToMessageId: null,
    subject: `Subject ${id}`, body, html: body === null ? null : `<p>${body}</p>`,
    to: [], cc: [], bcc: [], rationale: null, status,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
}

/** The text every sent draft in these fixtures carries — one needle, asked for by weight. */
const REPLY = "R".repeat(2048);

/**
 * A snapshot server that hands back exactly the draft rows it is given, ONE page, the way the
 * bootstrap reader pages them. Deliberately carries the body on every row: this is the older
 * server, and the client's half of the bound is what is under test.
 */
function engineWith(rows: WireDraft[], store: MemoryMirrorStore): OhmailEngine {
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    snapshot: async (): Promise<SyncSnapshotPage> => ({
      asOfSeq: 900,
      changes: rows.map((d) => change("draft", d.id, d)),
      nextCursor: null,
      window: { days: 90, minRows: 5000 },
    }),
  } as unknown as EngineAdapter;
  return new OhmailEngine({
    adapter, store, now: () => NOW,
    storePolicy: { mode: "windowed", days: 90, minRows: 10, maxRows: 10 },
  });
}

/** Boot a fresh mirror over those rows — a reload, which is where the defect lives. */
async function bootstrap(rows: WireDraft[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await engineWith(rows, store).start();
  return store;
}

/** The draft-body bytes this mirror is holding — the retainer count, not a slope. */
function retainedDraftBytes(store: MemoryMirrorStore): number {
  let bytes = 0;
  for (const d of store.list<WireDraft>("draft")) {
    bytes += (d.body ?? "").length + (d.html ?? "").length;
  }
  return bytes;
}

// ── THE POSITIVE CONTROL, FIRST ────────────────────────────────────────────────────────────

/**
 * THIS IS HOW THE FIX COULD COST MAIL INSTEAD OF SAVING MEMORY. Everything below takes text out
 * of the mirror, and the one thing that must never leave is the message the person is writing.
 * `sent` is the only status this touches: a `draft`, a `scheduled` send waiting for its
 * appointment, a `sending` row mid-flight and an `unverified` one are all messages somebody
 * still owns, and compose seeds its editor from exactly that body.
 *
 * WATCHED RED by widening the strip to every draft status (`status !== "draft"`, and again with
 * the status test removed altogether): four failures, one per live status.
 */
describe("a draft the person is still holding keeps its text", () => {
  it("keeps the body and the html of every status that is not sent", async () => {
    const store = await bootstrap([
      draft("d-edit", "draft", "the one being written"),
      draft("d-later", "scheduled", "the one with an appointment"),
      draft("d-flight", "sending", "the one mid-send"),
      draft("d-unver", "unverified", "the one whose send is unconfirmed"),
      draft("d-sent", "sent", REPLY),
    ]);

    for (const id of ["d-edit", "d-later", "d-flight", "d-unver"]) {
      const row = store.get<WireDraft>("draft", id)!;
      expect(row, `${id} must survive the bootstrap`).toBeDefined();
      expect(draftBodyKnown(row), `${id}: the person's own text`).toBe(true);
      expect(row.body).toBe(draft(id, "draft", row.body).body);
      expect(row.html, `${id}: the rich half goes with the plain one`).not.toBeNull();
      expect(row.bodyOmitted, `${id}: nothing was taken`).toBeUndefined();
    }
  });

  /**
   * AND IT SURVIVES THE EVICTION PASS ITSELF. The guard above proves the snapshot did not strip
   * it; this proves no later prune takes the row. Driven through a real drain with a window of
   * ten over forty messages, so the pass genuinely runs.
   */
  it("is still there after a windowed prune has evicted mail around it", async () => {
    const store = new MemoryMirrorStore();
    const engine = engineWith([draft("d-edit", "draft", "the one being written")], store);
    await engine.start();
    await engine.syncOnce();

    const row = store.get<WireDraft>("draft", "d-edit")!;
    expect(row).toBeDefined();
    expect(draftBodyKnown(row)).toBe(true);
    expect(row.body).toBe("the one being written");
  });
});

// ── THE BOUND ──────────────────────────────────────────────────────────────────────────────

describe("a sent draft's text never enters the mirror", () => {
  /**
   * THE RETAINER COUNT, BEFORE AND AFTER — entities and bytes, never a slope. The sent drafts here
   * are round 1's own count, at 2 KiB each rather than its 100 KiB so the case stays quick; the
   * ratio is what the guard asserts.
   *
   * WATCHED RED by removing the strip from `runSnapshot`: every row carrying its body
   * bytes, and more with their html, against the 0 below.
   */
  it("holds a long list of sent-draft ROWS and none of their bytes", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => draft(`s${i}`, "sent", REPLY));
    const store = await bootstrap(rows);

    // THE ROWS STAY. The sent list is an offline surface and the address book learns its
    // recipients from these rows — dropping them would be a different defect.
    expect(store.list<EngineDraft>("draft")).toHaveLength(1500);
    expect(retainedDraftBytes(store)).toBe(0);
    for (const d of store.list<WireDraft>("draft")) {
      expect(d.body).toBeNull();
      expect(d.html).toBeNull();
      expect(d.bodyOmitted).toBe("sent");
      expect(draftBodyKnown(d)).toBe(false);
    }
  });

  /**
   * THE CONTROL FOR THE COUNT ITSELF: the same walk with the same rows at status `draft` retains
   * every byte. Without it the zero above passes for a bootstrap that carried no text at all.
   */
  it("the same rows at a LIVE status retain their text in full", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => draft(`s${i}`, "draft", REPLY));
    const store = await bootstrap(rows);

    expect(store.list<EngineDraft>("draft")).toHaveLength(1500);
    expect(retainedDraftBytes(store)).toBe(1500 * (REPLY.length + REPLY.length + 7));
  });

  /**
   * NOTHING OF THE TEXT IS ANYWHERE IN THE MIRROR — not a truncation, not a copy on another
   * record. Asked of the whole serialized store rather than of the row, because the defect this
   * lane exists for is text the mirror holds somewhere nobody looked.
   */
  it("leaves no copy of the text anywhere in the mirror", async () => {
    const store = await bootstrap([draft("s0", "sent", REPLY)]);
    const everything = JSON.stringify(store.list<unknown>("draft"));
    expect(everything).not.toContain("RRR");
  });

  /**
   * THE REST OF THE ROW IS INTACT, so the sent list still renders and the address book still
   * learns from it.
   */
  it("keeps the subject, the recipients and the stamps", async () => {
    const row = draft("s0", "sent", REPLY);
    row.to = [{ name: "Who", address: "who@example.test" }];
    const store = await bootstrap([row]);

    const held = store.get<WireDraft>("draft", "s0")!;
    expect(held.subject).toBe("Subject s0");
    expect(held.to).toEqual([{ name: "Who", address: "who@example.test" }]);
    expect(held.status).toBe("sent");
    expect(held.updatedAt).toBe(NOW.toISOString());
  });
});
