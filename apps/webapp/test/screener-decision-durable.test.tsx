/** @vitest-environment jsdom */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MirrorStore,
  type ScreenerWaitingWire,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { screenerIntentsKey, type ScreenerIntent } from "../app/shell/screener-intents";
import { INTENT_ASK_MS } from "@ohmail/app-logic/press/intent-windows";
import { COMMIT_MS } from "../app/shell/screener-state";
import { createCloudSidecar } from "../../sidecar/src/cloud-engine.js";
import { freshDataDir } from "../../sidecar/test/_datadir.js";
import { hostedMailbox, mailboxList } from "../../sidecar/test/fixtures/hosted-mailbox.js";

/**
 * A SCREENER DECISION SURVIVES THE TAB THAT MADE IT — the kill test.
 *
 * ## THE DEFECT
 *
 * A decision lived only in a `setTimeout` closure for its whole
 * 8.4-second undo window (`COMMIT_MS = UNDO_MS + COMMIT_GRACE_MS`), with nothing persisted and no
 * `pagehide` flush anywhere in the file. Close the tab, navigate away, or crash inside that window
 * and the decision was gone — after the toast had already told the reader the mail was filed. It is
 * the product's primary consent gate silently discarding an explicit act — "the user always wins"
 * read backwards — and it is one member of a class a review named as the top blocker before beta:
 * *this product decides in memory and persists afterwards*.
 *
 * ## THE SEQUENCE THIS FILE CLOSES
 *
 *   1. press `n` on a stranger → the toast says "Screened out — …", the row leaves the queue;
 *   2. inside the undo window, the tab dies (closed, navigated, reclaimed);
 *   3. the reader comes back → the sender is in the queue again, undecided, and the product has
 *      no record that anything was ever pressed.
 *
 * ## THE SEQUENCE IT CHECKS WAS NOT OPENED
 *
 * Two, and both are asserted below rather than argued:
 *
 *   · **Undo must still win.** A durable decision that Undo cannot reach would re-commit on the
 *     next boot a decision the reader had explicitly reversed — worse than the defect, because it
 *     acts against the reader instead of merely forgetting them.
 *   · **A cold mirror must not eat the decision.** A derived row's id is a representative MESSAGE
 *     id, and at boot the mirror holds nothing until the first drain lands. A replay that fired at
 *     mount would take the past-the-gate branch, find no sender, and REFUSE — converting "the
 *     decision survives" into "the decision is destroyed on the next boot in a way that looks like
 *     the server refused it". The replay is therefore gated on the mirror being able to name the
 *     row, and the third case drives exactly that: restart cold, assert nothing was sent and
 *     nothing was lost, then let the row arrive and assert it lands.
 *
 * ## THE RESTART IS A REAL RESTART
 *
 * A new `OhmailEngine` over the SAME `MirrorStore`, with the old root unmounted and every armed
 * timer cleared — which is what a killed tab is. The `localStorage` jar is deliberately NOT cleared
 * between the two mounts of one case (it is the thing under test) and IS cleared between cases.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-10T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
/** The `onAction` of the most recent toast — the Undo the reader actually presses. */
let undoAction: (() => void) | null = null;
/** Every sentence the hook raised, in order. */
let said: string[] = [];
/** `waitingCount` at every render — the badge as the rail draws it. */
let counts: number[] = [];

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-08-10T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-10T09:00:00.000Z",
  };
}

const HELD = msg("h1", "news@bulk.example", "ohmail/Screener");

async function freshStore(withHeld: boolean): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  if (withHeld) await seed(store);
  return store;
}

/** Put the held message in the mirror, as a `/sync` create would. */
async function seed(store: MirrorStore): Promise<void> {
  await store.applyChanges([{
    type: "message", op: "create", id: HELD.id, seq: ++seq, updatedAt: HELD.updatedAt, entity: HELD,
  }]);
}

/**
 * An engine over `store` whose every dispatched verb is recorded in `sent`. `door.queue` is the store's
 * queue; `door.answered` holds each verb's answer, as a server door's round trip does.
 */
function engineOver(
  store: MirrorStore, door: { queue?: () => Promise<ScreenerWaitingWire>; answered?: Promise<void> } = {},
): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        await door.answered;
        const changes: SyncChange[] = mutationEffects(store, m, {
          now: () => NOW, uuid: () => `id-${++seq}`,
        }).map((e) => ({
          type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
          updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
      ...(door.queue ? { screenerWaiting: door.queue } : {}),
    },
  });
}

interface StateLike {
  waiting: Array<{ id: string; from: { address: string } }>;
  waitingCount: number;
  decide: (sender: unknown, dest: string, opts: { read: boolean; scope: string }) => void;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mount the real hook over `engine`; `bump` forces the version prop the restore effect keys on. */
async function mountState(engine: OhmailEngine): Promise<{
  get: () => StateLike;
  bump: () => Promise<void>;
}> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: StateLike | null = null;
  let force: (() => void) | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    force = () => setV((x) => x + 1);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(
      engine,
      v,
      ((message: string, opts?: { onAction?: () => void }) => {
        said.push(message);
        // The toast IS the undo control: `decide` passes `onAction: () => undo([id])` and nothing
        // else exposes `undo`. Capturing the options here is what lets the second case press the
        // real button rather than reach past it into the journal.
        if (opts?.onAction) undoAction = opts.onAction;
      }) as never,
    ) as unknown as StateLike;
    counts.push(latest.waitingCount);
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(Probe),
      }),
    );
  });
  await settleFirstPaint();
  return {
    get: () => latest!,
    /**
     * A RESTART IS NOT FINISHED UNTIL THE CROSS-TAB HANDSHAKE HAS SETTLED.
     *
     * The boot replay asks the other tabs whether one of them still holds this window open
     * (`intent-windows.ts`) and waits {@link INTENT_ASK_MS} for the answer, so a mount that has
     * not been given the clock has not booted. Advanced by a hair over the wait and well under
     * the 330 ms "out" animation, which must not fire here.
     */
    bump: async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(INTENT_ASK_MS + 10); });
      await act(async () => { force?.(); });
    },
  };
}

/** THE KILL: the surface is gone and so is its event loop, with the mirror left on disk. */
async function killTab(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllTimers();
  // `vi.clearAllTimers()` RESETS THE FAKE CLOCK TO REAL TIME — measured here, not assumed: without
  // this line the restarted session read `Date.now()` as the real 2026-08-31 against an intent
  // stamped at `NOW` (2026-08-10), decided it was three weeks past `INTENT_TTL_MS`, and swept it.
  // The suite went red for the RIGHT reason at the wrong subject — the TTL guard proving itself
  // while the durability case it was standing in front of never got to run.
  vi.setSystemTime(NOW);
}

const decides = (): EngineMutation[] => sent.filter((m) => m.kind === "screener_decide");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent = [];
  undoAction = null;
  said = [];
  counts = [];
  window.localStorage.clear();
});

afterEach(async () => {
  await killTab();
  vi.useRealTimers();
});

describe("a Screener decision is durable at the moment it is taken", () => {
  it("survives a tab killed inside the undo window", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    expect(first.get().waiting).toHaveLength(1);

    await act(async () => {
      first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
    });

    // NOTHING IS ON THE WIRE YET — the undo window is the whole point, and the defect was that
    // this was ALSO the whole record.
    expect(decides(), "the decide must not be sent before the window closes").toHaveLength(0);
    // …but the decision is already on disk.
    expect(window.localStorage.getItem(screenerIntentsKey()), "the intent was not journalled")
      .toContain("h1");

    await killTab();
    expect(decides(), "the killed tab must not have sent anything").toHaveLength(0);

    // THE RESTART: a new engine over the same mirror, a fresh mount, no timers inherited.
    const second = await mountState(engineOver(store));
    await second.bump();
    await act(async () => { await Promise.resolve(); });

    const seenDecides = decides();
    expect(seenDecides, "the decision did not survive the restart").toHaveLength(1);
    expect(seenDecides[0]).toMatchObject({
      kind: "screener_decide", senderId: "h1", decision: "no", dest: "screened", scope: "sender",
    });
    // The journal is spent: the durable outbox owns the verb from here.
    expect(window.localStorage.getItem(screenerIntentsKey())).toBeNull();
  });

  it("a DEMOTING decision carries no held ids — the journal is not a copy of the mailbox", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    await act(async () => {
      // `read: true` is what `decide` clamps to false for the demoting piles, so this is the exact
      // call a "screen out and mark read" press makes. The ids ride the &read batch and nothing
      // else, so a decision that carries no read flag must carry no ids: a bulk over a busy queue
      // would otherwise put tens of thousands of message ids in the jar for a flag never asked
      // about, and a quota refusal there is swallowed — losing the decision through the very
      // storage that exists to keep it.
      first.get().decide(first.get().waiting[0], "screened", { read: true, scope: "sender" });
    });
    const raw = window.localStorage.getItem(screenerIntentsKey());
    expect(raw).not.toBeNull();
    const rows = JSON.parse(raw!) as Array<{ read: boolean; heldIds: string[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.read, "the demoting clamp did not apply").toBe(false);
    expect(rows[0]!.heldIds, "a decision that marks nothing read still carried the whole bag")
      .toEqual([]);
  });

  it("a KEEP decision that marks read DOES carry them", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    await act(async () => {
      first.get().decide(first.get().waiting[0], "ohbox", { read: true, scope: "sender" });
    });
    const rows = JSON.parse(window.localStorage.getItem(screenerIntentsKey())!) as
      Array<{ read: boolean; heldIds: string[] }>;
    expect(rows[0]!.read).toBe(true);
    expect(rows[0]!.heldIds, "the &read batch's ids were dropped from the journal").toEqual(["h1"]);
  });

  /**
   * A DECISION THIS SESSION COMMITTED IS NOT REPLAYED AS THOUGH IT WERE STRANDED.
   *
   * The boot replay reads the journal once and re-runs on the mirror's version AND on a local
   * tick. Reading the jar at the wrong moment sends the same decision twice: between the commit
   * and the mutation settling, the entry is still on disk (`disarmScreenerIntent` runs on the
   * settle) while `s.pending` has already been cleared, so a read taken THERE sees a decision
   * nobody owns. Measured as a duplicate `screener_decide` and a duplicate `mark_seen`.
   */
  it("a decision this session committed is sent exactly once, however often the hook re-renders", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    /* PRESSED WHILE THE HANDSHAKE IS STILL IN FLIGHT, which is what a press in the first second
       of a session is — and it is load-bearing here: settling the handshake first moves the
       journal read back in front of the press and hides the defect entirely. */
    await act(async () => {
      first.get().decide(first.get().waiting[0], "ohbox", { read: true, scope: "sender" });
    });
    /* THE WINDOW CLOSES NORMALLY, and the clock is turned SYNCHRONOUSLY on purpose: that is a
       browser firing a timer, and it leaves the commit's mutation still in flight — the journal
       entry is on disk and `s.pending` is already cleared, which is the exact window the read
       must not be taken in. The async form settles the disarm in between and sees nothing. */
    await act(async () => { vi.advanceTimersByTime(COMMIT_MS + 100); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    // …and then the hook re-renders, repeatedly, as a live surface does.
    for (let i = 0; i < 3; i++) await first.bump();

    expect(decides(), "the decision was sent more than once").toHaveLength(1);
    expect(
      sent.filter((m) => m.kind === "mark_seen"),
      "the '& read' batch went out twice",
    ).toHaveLength(1);
    expect(window.localStorage.getItem(screenerIntentsKey())).toBeNull();
  });

  it("a decision the reader UNDID does not come back", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    await act(async () => {
      first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    expect(window.localStorage.getItem(screenerIntentsKey())).toContain("h1");

    // THE REAL UNDO — the toast's own action, captured in the probe above.
    expect(undoAction, "the decide raised no toast carrying an Undo").not.toBeNull();
    await act(async () => { undoAction!(); });
    expect(
      window.localStorage.getItem(screenerIntentsKey()),
      "Undo left the decision armed on disk",
    ).toBeNull();

    await killTab();
    const second = await mountState(engineOver(store));
    await second.bump();
    await act(async () => { await Promise.resolve(); });

    expect(decides(), "an undone decision was re-committed by the restart").toHaveLength(0);
    expect(second.get().waiting, "the undone sender should be back in the queue").toHaveLength(1);
  });

  it("a decision older than the journal's horizon is dropped, not committed", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    await act(async () => {
      first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    await killTab();

    // A DAY AND A MINUTE LATER. `INTENT_TTL_MS` is the ceiling on staleness, not a retry budget:
    // past it the queue has moved on — decided elsewhere, swept, the rep evicted — and quietly
    // filing a day-old decision into a queue the reader has since re-read is a surprise rather
    // than a restoration.
    const { INTENT_TTL_MS } = await import("../app/shell/screener-intents.js");
    vi.setSystemTime(new Date(NOW.getTime() + INTENT_TTL_MS + 60_000));

    const second = await mountState(engineOver(store));
    await second.bump();
    await act(async () => { await Promise.resolve(); });

    expect(decides(), "an expired intent was committed anyway").toHaveLength(0);
    expect(
      window.localStorage.getItem(screenerIntentsKey()),
      "an expired intent must be swept, not left to be re-rejected on every boot for ever",
    ).toBeNull();
    // …and the sender is simply back in the queue, undecided, which is the honest state.
    expect(second.get().waiting).toHaveLength(1);
  });

  /**
   * AN EXPIRED DECISION IS REPORTED, NOT SWEPT IN SILENCE.
   *
   * The sweep above is right and was half of the story. The entry is removed, the row comes back
   * undecided — and the person who pressed a key about that sender is told nothing at all, which
   * is the silent loss this journal exists to remove arriving through the journal's own horizon.
   * So the sweep hands its expiries back, the boot says what happened in the catalogue's words
   * and asks for the press again, and one counted line carries the rate to whoever reads logs.
   */
  it("an expired decision is reported to the person who made it, and counted", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await freshStore(true);
      const first = await mountState(engineOver(store));
      await act(async () => {
        first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
      });
      await killTab();

      const { INTENT_TTL_MS } = await import("../app/shell/screener-intents.js");
      vi.setSystemTime(new Date(NOW.getTime() + INTENT_TTL_MS + 60_000));

      const second = await mountState(engineOver(store));
      await second.bump();
      await act(async () => { await Promise.resolve(); });

      /* THE SENTENCE, rendered from the catalogue rather than retyped here: a copy change that
         stops naming the sender, or stops asking for the press again, reddens this line. */
      const tr = createTranslator({ locale: "en", messages: en as never, namespace: "screener" });
      expect(
        said,
        "an expired decision was swept with nothing said to the person who made it",
      ).toContain(tr("toastIntentExpired", { count: 1, name: HELD.from.address }));

      /* …and counted where an operator reads it: the class and how many, never the sender. */
      const line = warned.mock.calls.find((c) => c[0] === "ohmail: screener intents expired");
      expect(line, "an expiry reached no log line").toBeDefined();
      expect(line![1]).toEqual({ class: "screener.intent.expired", count: 1 });
    } finally {
      warned.mockRestore();
    }
  });

  /**
   * CONTROL — the ordinary restore is admitted, and says nothing about an expiry.
   *
   * A sentence raised on every boot would be worse than the silence it replaces: a decision that
   * WAS carried out reported as lost teaches people to distrust the one that matters. A minute
   * short of the horizon, so the only difference from the case above is which side of it the
   * clock is on.
   */
  it("CONTROL: a decision restored inside the horizon is applied and reported as nothing", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await freshStore(true);
      const first = await mountState(engineOver(store));
      await act(async () => {
        first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
      });
      await killTab();

      const { INTENT_TTL_MS } = await import("../app/shell/screener-intents.js");
      vi.setSystemTime(new Date(NOW.getTime() + INTENT_TTL_MS - 60_000));

      const second = await mountState(engineOver(store));
      await second.bump();
      await act(async () => { await Promise.resolve(); });

      expect(decides(), "the decision inside the horizon was not carried out").toHaveLength(1);
      /* BY THE COUNT OF SENTENCES, not by the expiry sentence's count-1 rendering: a widened
         condition that reports every restore renders "0 decisions …", which a `not.toContain`
         of the one-row sentence admits. The press raised one sentence; the restore raises none. */
      expect(
        said,
        "the restore raised a sentence of its own over a decision it carried out",
      ).toHaveLength(1);
      expect(said[0]!.startsWith("Screened out — "), said[0]).toBe(true);
      expect(
        warned.mock.calls.some((c) => c[0] === "ohmail: screener intents expired"),
        "a live decision was counted as an expiry",
      ).toBe(false);
    } finally {
      warned.mockRestore();
    }
  });

  /**
   * A BOOT THAT FINDS TWO SAYS IT ONCE AND SAYS HOW MANY.
   *
   * Two sentences for one boot is the sweep's shape leaking into the reader's screen, and a
   * sentence that always says "one" is a number that is only right on the fixture the guard was
   * written against — the hole this case puts in it. The journal is seeded directly: a stale entry
   * is what a boot finds, not something a press can make inside one test.
   */
  it("two expiries are ONE sentence and one counted line, naming how many", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await freshStore(true);
      const { INTENT_TTL_MS } = await import("../app/shell/screener-intents.js");
      const stale = (id: string, address: string): ScreenerIntent => ({
        v: 1, id, dest: "screened", read: false, scope: "sender", quiet: false,
        at: NOW.getTime() - INTENT_TTL_MS - 60_000, derived: true, heldIds: [],
        from: { name: null, address },
      });
      window.localStorage.setItem(
        screenerIntentsKey(),
        JSON.stringify([stale(HELD.id, HELD.from.address), stale("h2", "offers@bulk.example")]),
      );

      const boot = await mountState(engineOver(store));
      await boot.bump();
      await act(async () => { await Promise.resolve(); });

      expect(decides(), "an expired intent was committed anyway").toHaveLength(0);
      const tr = createTranslator({ locale: "en", messages: en as never, namespace: "screener" });
      expect(
        said,
        "the boot owed the reader one sentence naming how many decisions died",
      ).toEqual([tr("toastIntentExpired", { count: 2, name: HELD.from.address })]);
      const line = warned.mock.calls.find((c) => c[0] === "ohmail: screener intents expired");
      expect(line![1], "the count is not what was swept").toEqual({
        class: "screener.intent.expired", count: 2,
      });
      expect(
        window.localStorage.getItem(screenerIntentsKey()),
        "a reported expiry must still leave the journal",
      ).toBeNull();
    } finally {
      warned.mockRestore();
    }
  });

  /**
   * A REFUSED JAR TAKES THE UNDO AWAY, NOT THE DECISION.
   *
   * Safari's private mode throws on write, and a full quota does the same. The journal used to
   * swallow that, so the toast went on offering an Undo over a record nobody held and a tab closed
   * inside the window lost the decision — this file's own defect, reached through the browser
   * instead of through a crash. With nothing on disk to postpone against, the decide is sent at
   * once and the sentence says the undo is not on offer.
   */
  it("a REFUSED jar sends the decision at once and offers no undo", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      await act(async () => {
        first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
      });
    } finally {
      setItem.mockRestore();
    }

    expect(decides(), "the decision was postponed against a record nobody holds").toHaveLength(1);
    expect(decides()[0]).toMatchObject({
      kind: "screener_decide", senderId: "h1", decision: "no", dest: "screened",
    });
    expect(undoAction, "an undo was offered over a write that failed").toBeNull();
    /* The sentence by its two ends rather than by re-running ICU here: the decision it reports is
       unchanged, and what is added is the clause saying the undo is not on offer. */
    const sentence = said[said.length - 1] ?? "";
    expect(sentence.startsWith("Screened out — news@bulk.example."), sentence).toBe(true);
    expect(sentence.endsWith(en.session.noUndoHere), sentence).toBe(true);
  });

  it("a COLD mirror neither sends nor loses the decision, and lands it once the row arrives", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    await act(async () => {
      first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    await killTab();

    // The restart finds an EMPTY mirror — the state every boot is in before its first drain.
    const cold = await freshStore(false);
    const coldMount = await mountState(engineOver(cold));
    await coldMount.bump();
    await act(async () => { await Promise.resolve(); });

    expect(decides(), "a cold boot must not dispatch against a mirror that cannot name the row")
      .toHaveLength(0);
    expect(
      window.localStorage.getItem(screenerIntentsKey()),
      "a decision the cold boot could not act on must still be on disk",
    ).toContain("h1");

    // The first drain lands the row. The same session now commits it.
    await act(async () => { await seed(cold); });
    await coldMount.bump();
    await act(async () => { await Promise.resolve(); });

    expect(decides(), "the decision did not land once the mirror could name the row").toHaveLength(1);
    expect(window.localStorage.getItem(screenerIntentsKey())).toBeNull();
  });
});

/**
 * ═══ A DECIDED SENDER STAYS DECIDED ON SCREEN — the two ways the row used to come back ═══════
 *
 * Both holes were bookkeeping keyed on the representative MESSAGE id, which is minted on the
 * sender's NEWEST message and therefore moves under the mark:
 *
 *  1. A newer arrival inside the undo window re-minted the pending sender under an id the hide
 *     never named — the row was back mid-decision, pressable, two decisions for one sender.
 *  2. A reload inside the window put the decision in the journal, and until the replay could
 *     dispatch it (handshake + a mirror able to name the rep) the derivation showed the decided
 *     sender undecided — "my decision came back", for as long as the mirror took.
 *
 * The fix keys the pending hide and the boot hide by {@link senderKey}. MUTATIONS WATCHED RED
 * (each restored and `cmp`-verified): `senderHeld` reduced to the old `s.pending.has(x.id)` read
 * reddens case 1; dropping `restoredKeys` from `senderHeld` reddens case 2.
 */
describe("a decided sender stays decided on screen", () => {
  it("a NEWER arrival from a pending sender does not re-mint the row", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    expect(first.get().waiting).toHaveLength(1);

    await act(async () => {
      first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    // Inside the undo window a newer message from the SAME sender lands — the re-mint: the
    // derived row's id moves to the new message, which `s.pending` never named.
    const newer = { ...msg("h2", HELD.from.address, "ohmail/Screener"), date: "2026-08-10T11:00:00.000Z" };
    await act(async () => {
      await store.applyChanges([{
        type: "message", op: "create", id: newer.id, seq: ++seq,
        updatedAt: NOW.toISOString(), entity: newer,
      }]);
    });
    await act(async () => { await Promise.resolve(); });
    await first.bump();

    expect(
      first.get().waiting.filter((x) => x.from.address === HELD.from.address),
      "the pending sender re-minted under the newer message's id",
    ).toHaveLength(0);

    // And the window closing commits ONE decision, on the id that was pressed.
    await act(async () => { vi.advanceTimersByTime(COMMIT_MS + 100); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(decides()).toHaveLength(1);
    expect(decides()[0]).toMatchObject({ senderId: "h1" });
  });

  it("the boot replay never SHOWS the decided sender — hidden from the read, before dispatch", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    await act(async () => {
      first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    await killTab();

    // The restart, over a WARM mirror that can mint the row at the first render. The handshake
    // has not settled and nothing has been dispatched — the gap the sender used to render in.
    const second = await mountState(engineOver(store));
    await act(async () => { await Promise.resolve(); });
    expect(decides(), "nothing may be dispatched before the handshake").toHaveLength(0);
    expect(
      second.get().waiting,
      "the journal's decided sender rendered undecided before the replay dispatched",
    ).toHaveLength(0);

    // The replay then dispatches it, once, and the sender stays gone.
    await second.bump();
    await act(async () => { await Promise.resolve(); });
    expect(decides()).toHaveLength(1);
    expect(second.get().waiting).toHaveLength(0);
  });

  it("the store's first answer, asked before the replay reached it, never counts the decided sender", async () => {
    const store = await freshStore(true);
    const first = await mountState(engineOver(store));
    await act(async () => {
      first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    await killTab();
    counts = [];

    // The relaunch asks the store at mount; every answer waits until this case lets it go.
    const answers: Array<() => void> = [];
    const listed: ScreenerWaitingWire = {
      items: [{ messageId: HELD.id, address: HELD.from.address, name: null, receivedAt: HELD.date!,
        subject: HELD.subject, snippet: HELD.snippet, mailboxId: "mb" }],
      nextCursor: null, total: 1, inFlight: [],
    };
    let asks = 0;
    let answer!: () => void;
    const engine = engineOver(store, {
      queue: () => {
        const wire = asks++ === 0 ? listed : { ...listed, items: [], total: 0 };
        return new Promise((r) => { answers.push(() => r(wire)); });
      },
      answered: new Promise((r) => { answer = r; }),
    });
    const second = await mountState(engine);
    await second.bump();
    await act(async () => { await Promise.resolve(); });
    expect(decides(), "the replay was not sent before the answer").toHaveLength(1);

    // The first answer lands after the decide, before the server's, and still lists the sender.
    await act(async () => { answers.shift()!(); await vi.advanceTimersByTimeAsync(10); });
    expect(engine.screenerWaitingSettled()).toBe(true);
    await act(async () => { answer(); await vi.advanceTimersByTimeAsync(10); });
    for (const r of answers.splice(0)) await act(async () => { r(); await vi.advanceTimersByTimeAsync(10); });
    expect(Math.max(...counts), `a decided sender was counted at the start (${counts.join(",")})`).toBe(0);
    expect(decides(), "the decision was sent more than once").toHaveLength(1);
  });
});

/**
 * THE FIRST SESSION AFTER A SIGN-IN ON A SERVER DOOR. The window journals under the mailbox the
 * shell says is served (`setStorageOwner`), so the key is the real engine's answer in each session:
 * a first session that served a minted id the relaunch never serves again read nothing back.
 */
describe("the first session after a sign-in on a server door", () => {
  /* jsdom's `Blob` has no `arrayBuffer()`; the engine's store loads its extensions as a Blob. */
  if (typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
    (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as ArrayBuffer);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(this);
      });
    };
  }
  const OPERATOR = "operator@ohmail.test";
  const HOSTED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const reply = (v: unknown): Response => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const ownServer = (async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/login") return reply({ status: "twofa_required", loginToken: "lt" });
    if (path === "/auth/2fa/totp/verify") return reply({ tokens: { accessToken: "a-1", refreshToken: "r-1" } });
    if (path === "/auth/session") return reply({ user: { email: OPERATOR } });
    if (path === "/mailboxes") return reply(mailboxList([hostedMailbox(HOSTED, "team@ohmail.test")]));
    if (path === "/sync") return reply({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c1", hasMore: false, serverTime: NOW.toISOString() });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  /** One launch of the real engine, read as the shell reads it: `ready`'s id, an empty one filled once. */
  async function launch(dataDir: string): Promise<string> {
    let served: string | null = null;
    const s = await createCloudSidecar({
      dataDir, cloudUrl: "https://own.test", address: OPERATOR, keks: { 1: Buffer.alloc(32, 9) },
      fetchImpl: ownServer, pollIntervalMs: 3_600_000,
      onServedMailbox: async (id) => { if (served === "") served = id; },
    });
    served = s.servedMailboxId();
    try {
      if (!s.signedIn()) {
        await s.handle(new Request("http://sidecar/cloud/signin", {
          method: "POST", headers: { authorization: `Bearer ${s.sessionToken}` },
          body: JSON.stringify({ email: OPERATOR, password: "pw", totp: "123456" }),
        }));
      }
      await s.start();
    } finally {
      await s.stop();
    }
    return served;
  }

  it("a decision pressed just before the quit is sent once at the relaunch", async () => {
    vi.useRealTimers();
    const dataDir = await freshDataDir("ohmail-first-session-journal-");
    const { setStorageOwner } = await import("@ohmail/app-logic/storage/storage-owner");
    try {
      const owners = [await launch(dataDir), await launch(dataDir)];
      expect(owners[0], "the first session served no mailbox").not.toBe("");
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const store = await freshStore(true);
      setStorageOwner(owners[0]!);
      const first = await mountState(engineOver(store));
      await act(async () => {
        first.get().decide(first.get().waiting[0], "screened", { read: false, scope: "sender" });
      });
      await killTab();

      setStorageOwner(owners[1]!);
      const second = await mountState(engineOver(store));
      await second.bump();
      await act(async () => { await Promise.resolve(); });
      expect(decides(), "the decision of the first session was lost at the relaunch").toHaveLength(1);
      expect(second.get().waiting).toHaveLength(0);
    } finally {
      setStorageOwner(null);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
