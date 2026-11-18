/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  senderKey,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import de from "../messages/de.json";

/**
 * ── THE CONSEQUENCE IS ON SCREEN WHERE IT IS INCURRED (mail 0054) ────────────────────────
 *
 * Screening a sender out, or pressing the Screener's spam verb, hands the mail that decision
 * re-routed to the one-click unsubscribe path. That has been true and INVISIBLE in the Screener
 * since the trigger was wired: the sender sheet asks before the click, but the Screener — the
 * surface where nearly every one of these decisions is actually made, one key per stranger —
 * said only "Screened out — …" and "Marked spam — …".
 *
 * This file renders the REAL hook and reads the toast options exactly as `ToastHost` receives
 * them, for `sender-sheet-reachable.test.tsx`'s reason: a sentence that exists only in a
 * catalogue and never reaches a surface is the repository's recurring "built, tested,
 * unreachable" shape, and a copy-only assertion cannot tell the two apart.
 *
 * ── WHY A TOAST HERE AND A CONFIRM THERE ─────────────────────────────────────────────────
 *
 * Not an inconsistency. The sheet's click can widen to a whole domain at once, so its disclosure
 * has to be a gate; the Screener is the triage loop, and a confirm in front of every `n` and `x`
 * would make the queue unusable. What the Screener owes is that the thing happening is visible
 * while it can still be undone — and the toast carries the undo.
 *
 * ── THE THREE CLAIMS ─────────────────────────────────────────────────────────────────────
 *
 *  1. The two DEMOTING decisions say it. Delete the `unsub` argument at either call site and the
 *     ICU `select` falls to `other {}`, which is silence — so these go red on the exact mutation
 *     that would ship the feature undisclosed again.
 *  2. The three KEEP destinations never say it, and that is a claim about truth rather than
 *     tidiness: `ohmail/News` and `ohmail/Receipts` were deliberately REMOVED from the
 *     unsubscribe service's actionable set, so a sentence there would be false.
 *  3. The account switch silences it. Wire `autoUnsubscribe` to a constant `true` and this goes
 *     red, which is the "states the consequence only when the mechanism will run" half.
 */

/* The held bodies here are never read, so each sentence is the CONDITIONAL one; the line before the
   press, the fact, the silence for a sender offering none and Undo's reach are pinned in
   `screener-unsubscribe-said-before-the-press.test.tsx`. */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-10T12:00:00.000Z");
let seq = 0;
let toasts: string[] = [];

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

const HELD = [msg("h1", "news@bulk.example", "ohmail/Screener")];

async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(held.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
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
    },
  });
}

interface StateLike {
  waiting: Array<{ id: string; from: { address: string } }>;
  decide: (sender: unknown, dest: string, opts: { read: boolean; scope: string }) => void;
  applyAll: (scopeOf: (s: unknown) => string) => void;
  markAllSpam: (scopeOf: (s: unknown) => string) => void;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountState(
  engine: OhmailEngine,
  opts: {
    autoUnsubscribe?: boolean;
    locale?: "en" | "de";
    suggestions?: ReadonlyMap<string, unknown>;
  } = {},
): Promise<{ get: () => StateLike }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  let latest: StateLike | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(
      engine,
      null, v,
      ((message: string) => { toasts.push(message); }) as never,
      useScreenerText(), opts.suggestions as never,
      undefined,
      opts.autoUnsubscribe,
    ) as unknown as StateLike;
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: opts.locale ?? "en",
        messages: (opts.locale === "de" ? de : en) as never,
        timeZone: "UTC",
        now: NOW,
        children: h(Probe),
      }),
    );
  });
  await settleFirstPaint();
  return { get: () => latest! };
}

/** File the one held sender to `dest` and return the toast sentence that was raised. */
async function decideTo(dest: string, opts: Parameters<typeof mountState>[1] = {}): Promise<string> {
  const engine = await engineWith(HELD);
  const state = await mountState(engine, opts);
  await act(async () => {
    state.get().decide(state.get().waiting[0], dest, { read: false, scope: "sender" });
  });
  expect(toasts, `no toast was raised for ${dest}`).toHaveLength(1);
  return toasts[0]!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  toasts = [];
  // Each case here decides on a sender and never lets the undo window close, so the decision is
  // still armed in the durable intent journal (`shell/screener-intents.ts`) when the case ends.
  // One jar per FILE in jsdom, so without this the next mount replays the previous case's decision
  // and its row is gone from `waiting` — the leak reads as `waiting[0]` being undefined.
  window.localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("the Screener says that a screen-out also unsubscribes", () => {
  it("screening out states the consequence", async () => {
    const text = await decideTo("screened");
    expect(text).toContain("Screened out");
    expect(text).toContain("one-click unsubscribe");
    // The qualifier is not decoration. Most screened-out mail publishes no one-click route at
    // all, and a flat "we unsubscribed you" would be a promise the mechanism does not keep.
    expect(text).toContain("one-click");
  });

  it("marking spam states it too — both halves of the endpoint's `no`", async () => {
    const text = await decideTo("spam");
    expect(text).toContain("Marked spam");
    expect(text).toContain("one-click unsubscribe");
  });

  it.each(["ohbox", "reads", "receipts"])(
    "%s says nothing about unsubscribing — a KEEP destination arms nothing",
    async (dest) => {
      // `ohmail/News` and `ohmail/Receipts` were deliberately removed from the unsubscribe
      // service's actionable set: Reads is mail the user CHOSE to keep, and a receipt is for a
      // purchase already made. The sentence would be false here, not merely noisy.
      expect(await decideTo(dest)).not.toContain("unsubscrib");
    },
  );

  it("the switch OFF silences it, and the rest of the sentence is unchanged", async () => {
    const off = await decideTo("screened", { autoUnsubscribe: false });
    expect(off).toContain("Screened out");
    expect(off).not.toContain("unsubscrib");
  });

  it("the parameter DEFAULTS to on — a caller that passes nothing still says it", async () => {
    // The failure worth preventing is the silent one: a decision that quietly leaves a mailing
    // list. Change the default in `useScreenerState`'s signature to `false` and this goes red.
    expect(await decideTo("screened", {})).toContain("one-click unsubscribe");
  });

  /**
   * ── THE BULK PATHS, WHICH ARE THE LARGEST HAND-OFFS THIS SURFACE MAKES ──────────────────
   *
   * One press can turn down forty senders. If the sentence rides only the single-decision toast,
   * the disclosure is missing from precisely the case that produces the most outbound requests.
   *
   * `applyAll` is the one that needs watching rather than asserting once and forgetting: it used
   * to exclude spam from what it applies and no longer does, so a condition written on
   * `screened` alone would go quietly false for a batch of spam verdicts — which is what
   * happened to the version of this file written before that change landed.
   */
  async function bulk(
    kind: "applyAll" | "markAllSpam",
    dests: Record<string, string>,
    opts: Parameters<typeof mountState>[1] = {},
  ): Promise<string> {
    const world = Object.keys(dests);
    const engine = await engineWith(
      world.map((address, i) => msg(`b${i}`, address, "ohmail/Screener")),
    );
    const suggestions = new Map<string, unknown>(
      world.map((a) => [senderKey(a), { dest: dests[a], confidence: 0.9, rationale: "because" }]),
    );
    const state = await mountState(engine, { ...opts, suggestions });
    await act(async () => { state.get()[kind](() => "sender"); });
    // Every row is dispatched on its own timer and the SUMMARY lands after the last one.
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(toasts.length, "no summary toast was raised").toBeGreaterThan(0);
    return toasts[toasts.length - 1]!;
  }

  it("applying suggestions states it when the batch turned somebody down", async () => {
    const text = await bulk("applyAll", {
      "a@x.example": "reads",
      "b@x.example": "screened",
    });
    expect(text).toContain("one-click unsubscribe");
  });

  it("applying a batch of SPAM verdicts states it too", async () => {
    // The regression this exists for. `applyAll` files spam now, so a batch that is entirely
    // spam is the biggest single hand-off to the mechanism the surface can make — and a
    // `screened`-only condition says nothing about it.
    const text = await bulk("applyAll", {
      "a@x.example": "spam",
      "b@x.example": "spam",
    });
    expect(text).toContain("one-click unsubscribe");
  });

  it("applying a batch of KEEPS says nothing — that batch arms nothing", async () => {
    const text = await bulk("applyAll", {
      "a@x.example": "reads",
      "b@x.example": "receipts",
      "c@x.example": "ohbox",
    });
    expect(text).not.toContain("unsubscrib");
  });

  it("`Mark all spam` states it — the highest-volume path to the mechanism", async () => {
    const text = await bulk("markAllSpam", { "a@x.example": "reads", "b@x.example": "reads" });
    expect(text).toContain("one-click unsubscribe");
  });

  it("the switch OFF silences both bulk summaries as well", async () => {
    expect(await bulk("applyAll", { "a@x.example": "screened" }, { autoUnsubscribe: false }))
      .not.toContain("unsubscrib");
    toasts = [];
    expect(await bulk("markAllSpam", { "a@x.example": "reads" }, { autoUnsubscribe: false }))
      .not.toContain("unsubscrib");
  });

  it("German says it too, and says it about one-click", async () => {
    // The parity guard proves the KEY exists in both catalogues and that the ICU arguments match.
    // It cannot prove the German branch is the sentence rather than an empty one, which is what a
    // hand-written `select` gets wrong — so the German half is rendered here.
    const text = await decideTo("screened", { locale: "de" });
    expect(text).toContain("Aussortiert");
    expect(text).toContain("Ein-Klick-Abmeldung");
    expect(text).toContain("Ein-Klick");
  });
});
