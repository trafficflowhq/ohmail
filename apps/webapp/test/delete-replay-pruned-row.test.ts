/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineMessage,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { armDeleteIntent, takeDeleteIntents } from "@ohmail/app-logic/press/delete-intents";
import { replayDeleteIntents, type ReplayEnv } from "@ohmail/app-logic/press/delete-undo";

/**
 * ═══ A ROW THE WINDOW EVICTED IS NOT A ROW THAT WAS DELETED ═════════════════════════════════
 *
 * The browser's mirror is a WINDOW and a stranded delete intent lives a day. A reload late in
 * that day finds the row gone from the mirror for a reason that has nothing to do with the
 * person's press — `pruneToPolicy` evicted it — and the replay used to read that absence as
 * "the delete already happened" and strike the record off. The message was still in the
 * mailbox and the product had said it was gone.
 *
 * The mirror can tell the two absences apart and nothing was asking it to: a delete leaves a
 * TOMBSTONE (`entity: null`, apply rule 4) and a prune leaves NOTHING (`MirrorStore.prune`
 * hard-deletes, so the seq guard cannot refuse a later delta). So a tombstone settles the
 * intent with no round trip, and any other absence asks the mailbox — which is the master.
 *
 * ── MUTATION-WATCHED ────────────────────────────────────────────────────────────────────────
 *   · make `replayDelete`'s `not_found` arm answer the local refusal instead of re-asking →
 *     case (1) goes red: the intent struck off, nothing on the wire, the message still there;
 *   · make `isTombstoned` answer `false` always → case (2) goes red (the settled delete pays a
 *     round trip it does not owe);
 *   · make `isTombstoned` answer `true` for an absent record → case (1) goes red again;
 *   · drop the 404 arm from the re-ask → case (3) goes red (a message the master no longer has
 *     keeps a record nobody can ever settle);
 *   · give the fix a side set of recent tombstones → case (5) goes red on the record count.
 */

const DELETE_URL = /\/messages\/([^/?]+)$/;

function messageChange(id: string, seq: number): SyncChange {
  const date = "2026-09-04T09:00:00.000Z";
  return {
    type: "message",
    op: "create",
    id,
    seq,
    updatedAt: date,
    entity: {
      id,
      accountId: "acct",
      mailboxId: "mb",
      threadId: null,
      messageIdHeader: null,
      subject: `Subject ${id}`,
      from: { name: null, address: "sender@example.test" },
      to: [],
      cc: [],
      date,
      folder: "INBOX",
      snippet: "snippet",
      unread: false,
      hasAttachments: false,
      attachmentCount: 0,
      sensitivity: {
        sensitive: false, category: null, no_ai: false,
        no_forward: false, no_kb: false, priority: false,
      },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: date,
    },
  } as unknown as SyncChange;
}

/** The server's own `delete` change — the tombstone the mirror keeps for a message that went. */
function deleteChange(id: string, seq: number): SyncChange {
  return {
    type: "message", op: "delete", id, seq, updatedAt: "2026-09-04T09:10:00.000Z",
  } as unknown as SyncChange;
}

interface Rig {
  engine: OhmailEngine;
  store: MemoryMirrorStore;
  /** Every `DELETE /messages/<id>` that reached the wire, in order. */
  deleted: string[];
  /** The `Idempotency-Key` each of those carried. */
  keys: Array<string | null>;
}

const originalFetch = globalThis.fetch;

/** A live engine over a hydrated mirror. `answer` decides what the DELETE comes back as. */
function rig(ids: string[], answer?: { status: number; code: string }): Rig {
  const store = new MemoryMirrorStore();
  const deleted: string[] = [];
  const keys: Array<string | null> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "DELETE" && DELETE_URL.test(href)) {
      const id = DELETE_URL.exec(href)![1]!;
      deleted.push(id);
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      keys.push(headers.get("idempotency-key"));
      if (answer) {
        return new Response(
          JSON.stringify({ error: { code: answer.code, message: "refused" } }),
          { status: answer.status, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ id, updatedAt: "2026-09-04T09:05:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": "99" } },
      );
    }
    return new Response(
      JSON.stringify({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "AQ", hasMore: false, serverTime: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://engine.test", fetch: fetchImpl }),
    store,
  });
  void store.applyChanges(ids.map((id, i) => messageChange(id, i + 1)));
  return { engine, store, deleted, keys };
}

/** Let every settled microtask and every zero-delay timer run. */
async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const t = createTranslator({ locale: "en", messages: en });

function envOver(engine: OhmailEngine, said: string[]): ReplayEnv {
  return {
    hydrated: () => engine.hydrate(),
    tell: (s) => said.push(s),
    copy: {
      retrying: (verb, count) => t(
        verb === "restore" ? "trash.restoreReplayRetrying" : "ohbox.deleteReplayRetrying",
        { count },
      ),
      failed: (verb, count) => t(
        verb === "restore" ? "trash.restoreReplayFailed" : "ohbox.deleteReplayFailed",
        { count },
      ),
    },
    attempts: 1,
  };
}

/** The shell's own replay dispatch, as `AppShell` wires it. */
function dispatchOver(engine: OhmailEngine) {
  return (messageId: string, pressId: string) => engine.replayDelete(messageId, { intentId: pressId });
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { window.localStorage.clear(); globalThis.fetch = originalFetch; });

describe("a replayed delete asks the mailbox about a row the window evicted", () => {
  it("(1) A PRUNED ROW IS RE-ASKED, never settled on its absence", async () => {
    /* The reported sequence. The row was in the mirror when the person pressed Delete; by the
       next launch the window had evicted it — a hard delete, no tombstone, exactly what
       `MirrorStore.prune` promises. At HEAD the replay dispatched into that hole, took the
       engine's own local 404 for the mailbox's answer and struck the record off. */
    const { engine, store, deleted, keys } = rig(["m1"]);
    await engine.hydrate();
    await store.prune([{ type: "message", id: "m1" }]);
    expect(
      store.get<EngineMessage>("message", "m1"),
      "the window evicted it — and it left no record at all",
    ).toBeUndefined();
    expect(store.isTombstoned("message", "m1"), "a prune is not a deletion").toBe(false);

    armDeleteIntent({ id: "press-1", messageIds: ["m1"], at: Date.now(), kind: "delete" });
    const said: string[] = [];
    replayDeleteIntents(dispatchOver(engine), Date.now(), undefined, envOver(engine, said));
    await settle();

    expect(deleted, "THE MASTER WAS ASKED — the mailbox decides, never the window").toEqual(["m1"]);
    expect(keys[0], "under this press's own key, so a replay is not a second press")
      .toBe("delete-replay:press-1:m1");
    expect(takeDeleteIntents(Date.now()), "and only then was the record cleared").toEqual([]);
    expect(said, "nothing to explain: it finished").toEqual([]);
  });

  it("(2) A TOMBSTONE SETTLES WITH NO ROUND TRIP — the common case pays nothing", async () => {
    /* The positive control for the other absence: this delete converged, the mirror holds the
       server's own tombstone, and re-asking would be a request for a fact this device has. */
    const { engine, store, deleted } = rig(["m1"]);
    await engine.hydrate();
    await store.applyChanges([deleteChange("m1", 7)]);
    expect(store.isTombstoned("message", "m1"), "memory put that row down").toBe(true);

    armDeleteIntent({ id: "press-2", messageIds: ["m1"], at: Date.now(), kind: "delete" });
    const said: string[] = [];
    replayDeleteIntents(dispatchOver(engine), Date.now(), undefined, envOver(engine, said));
    await settle();

    expect(deleted, "nothing on the wire: this device already knows").toEqual([]);
    expect(takeDeleteIntents(Date.now()), "and the record is settled").toEqual([]);
    expect(said).toEqual([]);
  });

  it("(3) THE MASTER'S 'ALREADY GONE' SETTLES IT — the re-ask is idempotent", async () => {
    /* The message left the mailbox between the press and the launch — somebody's other client,
       or a previous attempt whose answer was lost. A 404 from the DELETE is the outcome that
       was asked for, so the record goes; anything else would keep a record nobody can settle. */
    const { engine, store, deleted } = rig(["m1"], { status: 404, code: "not_found" });
    await engine.hydrate();
    await store.prune([{ type: "message", id: "m1" }]);

    armDeleteIntent({ id: "press-3", messageIds: ["m1"], at: Date.now(), kind: "delete" });
    const said: string[] = [];
    replayDeleteIntents(dispatchOver(engine), Date.now(), undefined, envOver(engine, said));
    await settle();

    expect(deleted, "it asked").toEqual(["m1"]);
    expect(takeDeleteIntents(Date.now()), "and the mailbox's answer settled it").toEqual([]);
    expect(said, "a delete that had already happened owes no sentence").toEqual([]);

    /* THE DOOR'S OWN ANSWER, and it is asserted because the journal alone cannot see it: the
       replay has a `not_found` arm of its own, so it settles the record whichever way this
       comes back and the two mechanisms cover each other. The outcome was ACHIEVED — every
       caller of this door, replay or not, is owed that word rather than a refusal. */
    const direct = await engine.replayDelete("m1", { intentId: "press-3b" });
    expect(direct.status, "the master said it is gone, which is what was asked for")
      .toBe("confirmed");
    expect(direct.error, "and a settled outcome carries no refusal").toBeUndefined();
  });

  it("(4) A REFUSAL THE REPLAY CANNOT READ KEEPS THE RECORD", async () => {
    /* The direction that must not soften: the mailbox refused for a reason this file cannot
       classify (no Trash folder), so the press is still owed and the person is told. */
    const { engine, store, deleted } = rig(["m1"], { status: 422, code: "no_trash_folder" });
    await engine.hydrate();
    await store.prune([{ type: "message", id: "m1" }]);

    armDeleteIntent({ id: "press-4", messageIds: ["m1"], at: Date.now(), kind: "delete" });
    const said: string[] = [];
    replayDeleteIntents(dispatchOver(engine), Date.now(), undefined, envOver(engine, said));
    await settle();

    expect(deleted).toEqual(["m1"]);
    expect(takeDeleteIntents(Date.now()), "STILL WRITTEN DOWN").toHaveLength(1);
    expect(said, "and said out loud").toEqual([t("ohbox.deleteReplayFailed", { count: 1 })]);
  });

  it("(5) THE FIX HOLDS NO TOMBSTONE LEDGER OF ITS OWN", async () => {
    /* THE BOUND, and it is zero: the fact the replay reads is the mirror's own record, so a
       stream of deletes far past any cap somebody would have chosen adds NOTHING beyond the
       tombstones `/sync` already wrote. An auxiliary recent-tombstone set would be the 0.16.2
       renderer-memory leak in a smaller hat, and this is the assertion that there is none. */
    const ids = Array.from({ length: 500 }, (_, i) => `m${i}`);
    const { engine, store } = rig(ids);
    await engine.hydrate();
    expect(store.snapshot().size, "five hundred rows in").toBe(500);

    await store.applyChanges(ids.map((id, i) => deleteChange(id, 1000 + i)));
    for (const id of ids) expect(store.isTombstoned("message", id)).toBe(true);
    expect(store.snapshot().size, "every one of them is down").toBe(0);

    /* AND THE ANSWER LIVES IN THE RECORD AND NOWHERE ELSE, which is what makes the bound the
       mirror's own: take the tombstones away and the query stops saying yes. A side ledger with
       a lifetime of its own would still be answering `true` here. */
    await store.prune(ids.map((id) => ({ type: "message", id })));
    for (const id of ids) expect(store.isTombstoned("message", id)).toBe(false);
  });
});
