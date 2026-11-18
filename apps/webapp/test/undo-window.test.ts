/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { COMMIT_MS, UNDO_MS } from "@ohmail/app-logic/screener/screener-state";

/**
 * THE UNDO THAT OUTLIVED THE THING IT UNDID.
 *
 * ── WALKED ON A LIVE ACCOUNT, 2026-08-04 ────────────────────────────────────────────────
 *
 * *"Ohbox — filed … Undo"* was still there many minutes later, across every view, until another
 * toast replaced it.
 *
 * ── WHAT IS REPRODUCIBLE, AND IT IS NOT QUITE WHAT IT LOOKED LIKE ───────────────────────
 *
 * `ToastHost` (`packages/ui/src/primitives/Toast.tsx`) does run its timer and does drop the
 * `on` class on schedule, so `.toast{opacity:0;pointer-events:none}` takes the capsule off
 * screen. What it did not do then was clear the toast STATE. Measured in this environment: 20 minutes
 * after the toast, the node still read `"Ohbox — filed.Undo"`, its `<button>` was still mounted,
 * still `tabIndex 0`, still not `disabled`, and activating it still called `onAction`.
 * `pointer-events:none` stops a mouse. It does not stop Tab + Enter and it does not remove the
 * control from a `role="status"` region a screen reader is browsing.
 *
 * So the durable harm is not the pixels. It is that the button stays LIVE for an action that
 * stopped being reversible seconds after it was offered — and that pressing it then said
 * **"Undone — 0 waiting again."**, the product claiming an act it did not perform, on the one
 * screen a person presses precisely in order to find out.
 *
 * ── WHY THE FIX IS TWO THINGS AND NOT A NUMBER ──────────────────────────────────────────
 *
 * The acceptance asks for an 8–10 s dismissal AND asks what Undo does after that long, and
 * those are the same question. Lengthening the toast alone would have WIDENED the defect: the
 * shipped pair was 6000 ms (toast) against 6200 ms (commit), so an 8 s toast over a 6.2 s
 * commit leaves ~2 s of a live control for a decision already on the wire. So the window is one
 * declared number with the commit derived from it, and `undo()` refuses to claim an undo it did
 * not perform — which is the half that still holds when the button outlives its own capsule.
 *
 * The stale node is gone since the host takes an Undo capsule's button out of the tree after its
 * fade (`packages/ui/test/toast-two-slots.test.tsx`); the guard below still answers a press made
 * through a callback held anywhere else.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];

interface ToastCall {
  message: string;
  action?: string;
  duration?: number;
  onAction?: () => void;
}
let toasts: ToastCall[] = [];

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-08-04T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-04T09:00:00.000Z",
  };
}

/** Two strangers holding mail in the Screener — the live-account shape (derived rows). */
const HELD = [
  msg("h1", "giulia@terracotta.example", "ohmail/Screener"),
  msg("h2", "win@jackpot.example", "ohmail/Screener"),
];

async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
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
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
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

/**
 * The REAL hook, with a recording `toast`.
 *
 * `useScreenerState` takes the toast function as a parameter, so this substitutes for
 * `ToastHost` without reimplementing anything the surface does: every option the product hands
 * a toast — its label, its duration, its `onAction` — arrives here exactly as `ToastHost`
 * would have received it.
 */
async function mountState(engine: OhmailEngine): Promise<{ get: () => StateLike }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  let latest: StateLike | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(
      engine,
      null, v,
      ((message: string, options?: Omit<ToastCall, "message">) => {
        toasts.push({ message, ...(options ?? {}) });
      }) as never, useScreenerText(),
    ) as unknown as StateLike;
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
      }),
    );
  });
  await settleFirstPaint();
  return { get: () => latest! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent = [];
  toasts = [];
  // A decision is DURABLE from the press (`shell/screener-intents.ts`), and jsdom gives one
  // `localStorage` per FILE. A case that leaves its undo window open therefore leaves an armed
  // intent behind, which the next case's mount legitimately replays — the restart behaviour under
  // test in `screener-decision-durable.test.tsx`, and cross-case contamination here.
  window.localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("an Undo is offered for exactly as long as it is real", () => {
  it("the window is one number, and the commit cannot beat the capsule off screen", () => {
    /**
     * Mutation: write `duration: 6000` back at the `decide` call site, or set
     * `COMMIT_MS = 6200` independently of `UNDO_MS`. Either makes the second assertion red.
     *
     * This is the guard the shipped pair never had. 6000 against 6200 satisfies it by 200 ms
     * — technically — and a later slice lengthening only the toast breaks it immediately,
     * which is the failure mode this exists to catch.
     */
    expect(UNDO_MS, "the acceptance is an 8–10 s dismissal").toBeGreaterThanOrEqual(8000);
    expect(UNDO_MS).toBeLessThanOrEqual(10_000);
    expect(
      COMMIT_MS,
      "the toast offers an Undo for longer than the decision is reversible",
    ).toBeGreaterThan(UNDO_MS);
  });

  it("a decision's toast carries that window, not a hand-typed one", async () => {
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);

    await act(async () => {
      get().decide(get().waiting[0], "ohbox", { read: false, scope: "sender" });
    });

    const t = toasts.at(-1)!;
    expect(t.message).toContain("Ohbox — filed");
    expect(t.action).toBe("Undo");
    expect(t.duration, "the capsule's life is not derived from the undo window").toBe(UNDO_MS);
  });

  it("THE GUARD — pressing Undo after the window says so, and does not claim an undo", async () => {
    /**
     * Mutation: delete the `restored === 0` arm from `undo()` in `screener-state.ts`. The last
     * two assertions then go red with `"Undone — 0 waiting again."`, which is the sentence a
     * real account was given.
     *
     * The press is made through the toast's OWN `onAction`, captured above — i.e. through the
     * exact callback the button in `ToastHost` holds, pressed after the window it was offered for.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);

    await act(async () => {
      get().decide(get().waiting[0], "ohbox", { read: false, scope: "sender" });
    });
    const undoAction = toasts.at(-1)!.onAction!;

    // Within the window it is a real undo: the sender comes back and nothing was sent.
    expect(sent).toEqual([]);

    // Past the commit — the wire has the decision, and the button is still there.
    await act(async () => {
      vi.advanceTimersByTime(COMMIT_MS + 50);
    });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(sent.some((m) => m.kind === "screener_decide"), "the premise: it committed").toBe(true);

    const before = sent.length;
    toasts = [];
    await act(async () => { undoAction(); });

    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe("Too late to undo — that decision has already been sent.");
    expect(toasts[0]!.message).not.toContain("Undone");
    expect(toasts[0]!.message).not.toMatch(/\b0\b/);
    expect(sent.length, "a dead undo must not put anything else on the wire").toBe(before);
  });

  it("and inside the window it still restores, and still says the true count", async () => {
    // The other half of "never weaken an assertion": refusing a dead undo must not have
    // disarmed the live one. Red if the `restored === 0` guard is written as an unconditional
    // early return.
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);

    await act(async () => {
      get().decide(get().waiting[0], "ohbox", { read: false, scope: "sender" });
    });
    const undoAction = toasts.at(-1)!.onAction!;

    await act(async () => { vi.advanceTimersByTime(UNDO_MS - 500); });
    toasts = [];
    await act(async () => { undoAction(); });

    expect(toasts.at(-1)!.message).toBe("Undone — 1 waiting again.");
    // And the commit never happens: the undo cleared its timer.
    await act(async () => { vi.advanceTimersByTime(COMMIT_MS * 2); });
    expect(sent.some((m) => m.kind === "screener_decide")).toBe(false);
    expect(get().waitingCount).toBe(2);
  });
});
