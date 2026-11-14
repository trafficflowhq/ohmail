/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineMessage,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  armDeleteIntent,
  deleteIntentsKey,
  takeDeleteIntents,
} from "@ohmail/app-logic/press/delete-intents";
import {
  UNDO_MS,
  createDeleteUndo,
  replayDeleteIntents,
  type ReplayEnv,
} from "@ohmail/app-logic/press/delete-undo";

/**
 * ═══ A DELETE REPORTED DONE SURVIVES THE RELOAD THAT INTERRUPTED IT ═════════════════════════
 *
 * Press Delete, lose the tab inside the undo window, reload. The boot replay used to dispatch at
 * mount — BEFORE the mirror had been read off disk — so `engine.mutate` found no row, refused it
 * 404 `not_found`, and the replay cleared the journal on the strength of that refusal. The
 * message was still in the mailbox and the product had said it was gone.
 */

/**
 * The invariant these cases hold: an intent is removed by its COMPLETION, never by an attempt
 * that could not run. So the replay waits for the mirror's own hydration — the promise, never a
 * timer — and classifies what comes back: settled, gone, or unclassified-and-still-owed.
 */

/**
 * ── MUTATION-WATCHED ────────────────────────────────────────────────────────────────────────
 *   · drop the `await env.hydrated()` in `settlePress` → case (1) goes red exactly as the defect
 *     did: the intent gone, the message still in the mirror, nothing on the wire;
 *   · make the `not_found` arm answer `false` → case (2) goes red (the row is gone and the
 *     journal keeps it for ever);
 *   · make `attemptOne`'s last arm answer `true` → case (3) goes red (an unreadable refusal eats
 *     the intent, which is the defect one class along);
 *   · drop `disarmDeleteIntent` from `take` → case (4) goes red.
 */

const DELETE_URL = /\/messages\/([^/?]+)$/;

/** The mailbox row this account has on disk — the one the press asked to delete. */
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

/**
 * THE MIRROR AS IT ACTUALLY IS AT BOOT: rows on disk, memory empty, and the read not finished.
 * `readPersisted` is what `MirrorStore.load()` calls, so holding it open holds the engine in the
 * precise state the defect needed — not a stand-in for it. `open()` lets the read complete.
 */
class GatedMirror extends MemoryMirrorStore {
  private release: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
  /** How many times the store was asked to read itself — a hydration is a fact, not a delay. */
  reads = 0;

  constructor(private readonly onDisk: SyncChange[]) { super(); }

  protected override async readPersisted(): Promise<void> {
    this.reads += 1;
    await this.gate;
    await this.applyChanges(this.onDisk);
  }

  open(): void { this.release?.(); }
}

interface Rig {
  engine: OhmailEngine;
  store: GatedMirror;
  /** Every `DELETE /messages/<id>` that reached the wire, in order. */
  deleted: string[];
  dispatch: (messageId: string, pressId: string) => Promise<{ status: string }>;
}

const originalFetch = globalThis.fetch;

/** A live engine over a held-open mirror. `refuse` answers the DELETE with a server refusal. */
function rig(ids: string[], refuse?: { status: number; code: string }): Rig {
  const store = new GatedMirror(ids.map((id, i) => messageChange(id, i + 1)));
  const deleted: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "DELETE" && DELETE_URL.test(href)) {
      const id = DELETE_URL.exec(href)![1]!;
      if (refuse) {
        return new Response(
          JSON.stringify({ error: { code: refuse.code, message: "refused" } }),
          { status: refuse.status, headers: { "content-type": "application/json" } },
        );
      }
      deleted.push(id);
      return new Response(
        JSON.stringify({ id, updatedAt: "2026-09-04T09:05:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": "99" } },
      );
    }
    // Every read this engine makes on the way: an empty, settled page.
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
  return {
    engine,
    store,
    deleted,
    dispatch: (messageId) => engine.mutate({ kind: "message_delete", messageId }),
  };
}

/** Let every settled microtask and every zero-delay timer run. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const t = createTranslator({ locale: "en", messages: en });
const tde = createTranslator({ locale: "de", messages: de });

/** The shell's own resolution of the two replay sentences, in the locale under test. */
function copyOf(translate: typeof t): ReplayEnv["copy"] {
  return {
    retrying: (verb, count) => translate(
      verb === "restore" ? "trash.restoreReplayRetrying" : "ohbox.deleteReplayRetrying",
      { count },
    ),
    failed: (verb, count) => translate(
      verb === "restore" ? "trash.restoreReplayFailed" : "ohbox.deleteReplayFailed",
      { count },
    ),
  };
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { window.localStorage.clear(); globalThis.fetch = originalFetch; });

describe("the boot replay waits for the mirror, and keeps what it could not settle", () => {
  it("(1) A REPLAY BEFORE HYDRATION CARRIES THE INTENT, and the delete lands once the mirror is read", async () => {
    /* The reported sequence, end to end. The row is on disk and not yet in memory; the replay
       runs at mount, which is where it has always run. At HEAD it dispatched into the empty
       mirror, took the 404 for an answer and cleared the journal — the delete abandoned in
       silence. It now waits for the read the app was already making. */
    const { engine, store, deleted, dispatch } = rig(["m1"]);
    armDeleteIntent({ id: "press-1", messageIds: ["m1"], at: Date.now(), kind: "delete" });

    const said: string[] = [];
    const count = replayDeleteIntents(dispatch, Date.now(), undefined, {
      hydrated: () => engine.hydrate(),
      tell: (s) => said.push(s),
      copy: copyOf(t),
    });
    expect(count, "one stranded press was taken up").toBe(1);

    await settle();
    expect(deleted, "nothing on the wire while the mirror is still being read").toEqual([]);
    expect(takeDeleteIntents(Date.now()), "AND THE INTENT IS STILL WRITTEN DOWN").toHaveLength(1);

    store.open();
    await settle(10);

    expect(deleted, "the delete went out once the mirror held the row").toEqual(["m1"]);
    expect(takeDeleteIntents(Date.now()), "and only then was the record cleared").toEqual([]);
    expect(
      engine.read().get<EngineMessage>("message", "m1"),
      "the row is gone from the mirror — the deletion the person was told about happened",
    ).toBeUndefined();
    expect(said, "nothing to explain: it finished").toEqual([]);
  });

  it("(1b) THE WAIT IS THE MIRROR'S OWN FACT, not an interval — nothing is dispatched on a clock", async () => {
    /* The hard stop, measured: with the hydration promise held open for a quarter of a minute of
       real waiting, the replay still has not dispatched. A timer-based fix passes case (1) and
       fails this one, which is the whole reason it is here. */
    const { store, engine, deleted, dispatch } = rig(["m1"]);
    armDeleteIntent({ id: "press-2", messageIds: ["m1"], at: Date.now(), kind: "delete" });
    replayDeleteIntents(dispatch, Date.now(), undefined, {
      hydrated: () => engine.hydrate(),
      tell: () => {},
      copy: copyOf(t),
    });
    await settle(40);
    expect(deleted).toEqual([]);
    expect(takeDeleteIntents(Date.now())).toHaveLength(1);
    expect(store.reads, "the read was asked for exactly once, by this replay or the scheduler").toBe(1);
    store.open();
    await settle(10);
    expect(deleted).toEqual(["m1"]);
  });

  it("(2) A ROW THAT IS GENUINELY GONE SETTLES THE INTENT — it is not retried for ever", async () => {
    /* The positive control for the `not_found` arm, and the reason the wait has to come first:
       once the mirror IS hydrated, a row it holds nothing of is still sent (the one door), and
       the mailbox's own 404 — it is already gone — settles the intent. Keeping it would leave a
       journal that only grows and a sentence about mail nobody has. */
    const { engine, store, deleted, dispatch } = rig([], { status: 404, code: "not_found" });
    armDeleteIntent({ id: "press-3", messageIds: ["gone-1"], at: Date.now(), kind: "delete" });
    const said: string[] = [];
    replayDeleteIntents(dispatch, Date.now(), undefined, {
      hydrated: () => engine.hydrate(),
      tell: (s) => said.push(s),
      copy: copyOf(t),
    });
    store.open();
    await settle(10);
    expect(takeDeleteIntents(Date.now()), "settled, because the world already agrees").toEqual([]);
    expect(deleted, "and nothing was deleted: the mailbox said it was already gone").toEqual([]);
    expect(said, "a delete that already happened explains nothing").toEqual([]);
  });

  it("(3) AN UNCLASSIFIED REFUSAL KEEPS THE INTENT AND SAYS SO — en and de", async () => {
    /* A server that cannot file the message (422 `no_trash_folder` is the shipped instance) is a
       refusal this replay cannot read as either done or gone. So the record stands for the next
       launch and the person is told, rather than the delete being dropped in silence. */
    const { engine, store, dispatch } = rig(["m1"], { status: 422, code: "no_trash_folder" });
    armDeleteIntent({ id: "press-4", messageIds: ["m1"], at: Date.now(), kind: "delete" });
    const said: string[] = [];
    replayDeleteIntents(dispatch, Date.now(), undefined, {
      hydrated: () => engine.hydrate(),
      tell: (s) => said.push(s),
      copy: copyOf(t),
      attempts: 2,
      wait: async () => {},
    });
    store.open();
    await settle(12);

    expect(takeDeleteIntents(Date.now()), "STILL OWED — nobody said this delete happened").toHaveLength(1);
    expect(said).toEqual([
      t("ohbox.deleteReplayRetrying", { count: 1 }),
      t("ohbox.deleteReplayFailed", { count: 1 }),
    ]);
    expect(said[0]).toContain("Retrying");

    /* The same two sentences exist in German, with the count in them. A catalogue that carries
       the key and drops `{count}` renders a sentence with the number missing. */
    expect(tde("ohbox.deleteReplayRetrying", { count: 3 })).toContain("3");
    expect(tde("ohbox.deleteReplayFailed", { count: 3 })).toContain("3");
    expect(tde("ohbox.deleteReplayRetrying", { count: 3 }))
      .not.toBe(t("ohbox.deleteReplayRetrying", { count: 3 }));
  });

  it("(3b) A HELD RESTORE SAYS THE RESTORE'S SENTENCE, never the delete's", async () => {
    /* One journal, two verbs. The sentence is resolved from the row's own `kind`, or a refused
       restore would tell somebody their DELETE did not finish — a false state about the opposite
       action. */
    armDeleteIntent({ id: "press-5", messageIds: ["m9"], at: Date.now(), kind: "restore" });
    const said: string[] = [];
    replayDeleteIntents(
      async () => ({ status: "applied" }),
      Date.now(),
      async () => ({ status: "rolled_back" }),
      {
        hydrated: async () => {},
        tell: (s) => said.push(s),
        copy: copyOf(t),
        attempts: 1,
        wait: async () => {},
      },
    );
    await settle(8);
    expect(takeDeleteIntents(Date.now()), "kept: the restore did not happen").toHaveLength(1);
    expect(said).toEqual([t("trash.restoreReplayFailed", { count: 1 })]);
  });

  it("(4) THE ORDINARY PRESS IS UNTOUCHED — delete, undo, and the journal follows both", async () => {
    /* The control that the window itself still works: nothing above may be bought by making the
       ordinary path hesitate. Real timers here would be four seconds of waiting, so the window's
       own injected timer is driven directly. */
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const make = (pressId: string) => createDeleteUndo({
        mutate: async (id) => { sent.push(id); return { status: "confirmed" }; },
        toast: () => {},
        copy: {
          deleted: en.ohbox.toastDeleted, undo: en.screener.toastUndo,
          undone: en.ohbox.deleteUndone, failed: en.ohbox.deleteFailed,
          noUndo: en.session.noUndoHere,
        },
        onHeld: () => {},
        refusal: () => null,
        now: () => 1_000_000,
        pressId: () => pressId,
      });

      const undone = make("press-a");
      undone.remove({ id: "m1", mailboxId: "mb" });
      expect(takeDeleteIntents(1_000_000), "written down before the timer exists").toHaveLength(1);
      undone.undo("m1");
      expect(takeDeleteIntents(1_000_000), "and taken off disk by Undo").toEqual([]);
      expect(sent, "nothing was sent").toEqual([]);

      const kept = make("press-b");
      kept.remove({ id: "m2", mailboxId: "mb" });
      await vi.advanceTimersByTimeAsync(UNDO_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent, "the window closed and the delete went").toEqual(["m2"]);
      expect(takeDeleteIntents(1_000_000), "cleared by its own completion").toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
