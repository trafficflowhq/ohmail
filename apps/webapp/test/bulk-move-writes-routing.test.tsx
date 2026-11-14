/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { UNDO_MS } from "../app/shell/screener-state";

/**
 * ═══ "MOVE TO <PLACE>" OVER A SELECTION WRITES ROUTING, NOT FOLDER MOVES ════════════════════
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * The single-row Move was fixed to write the SENDER'S ROUTING — Reads and Receipts are not
 * folders mail sits in, they are what a sender's rule says, so a folder move to the presented
 * place computes no effects and the engine refuses it. The selection's Move kept the old shape:
 * one `move` per picked message against that same presented place, effectless, its refusal
 * thrown away, and a sentence counting messages nothing had moved.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 *  1. The press writes ROUTING — the same plan the single row's Move dispatches, once per sender.
 *  2. Every folder move it does dispatch names a PICKED message: a sender's other mail is not
 *     dragged along by a press nobody made on it.
 *  3. The sentence counts SENDERS and MESSAGES, because a selection spanning senders changes
 *     where mail from each of them goes from now on.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 *  · In `planMoveToPlace`, widen the narrowing — `only.has(x.messageId)` → `true` — and case 2
 *    goes red on a move naming a message nobody picked.
 *  · Put the old arm back (a bare `move` per picked id against the presented folder) and case 1
 *    goes red twice over: no routing on the wire, and a sentence naming nought senders. Measured
 *    that way round, which is also this defect's own RED.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
      }),
    }));
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  await key("j");
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

/**
 * WAIT THE ROUTING OUT. A Move press moves the mail now and HOLDS the sender's rule for the undo
 * window (`routing-undo.ts`), so the rule reaches the adapter when the window closes and not
 * before — which is the feature, and is why these cases read the wire twice. The REAL `UNDO_MS`
 * rather than a fake clock, for `delete-key-shell.test.tsx`'s reason: the timers belong to a
 * mounted shell this file does not own, and a fake clock installed over it stalls the engine.
 */
async function afterTheWindow(): Promise<void> {
  await act(async () => { await new Promise<void>((r) => { setTimeout(r, UNDO_MS + 800); }); });
  await settle();
}

const buttonStarting = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));

const toastText = (): string =>
  [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "").join(" ");

/** The rows the selection holds, read off the rendered list. */
const pickedRows = (): HTMLElement[] =>
  [...host!.querySelectorAll<HTMLElement>(".view-ohbox .row")]
    .filter((r) => r.classList.contains("picked") || r.getAttribute("aria-selected") === "true");

/** The ids the selection holds, read off the rendered rows. */
function pickedIds(): string[] {
  return pickedRows().map((r) => r.dataset.id!).filter(Boolean);
}

/**
 * THE SENDERS THE SELECTION SPANS, read off the ROWS and not off what the press dispatched.
 * An expectation derived from the arm's own output cannot say the arm grouped wrongly: with
 * one plan for the whole set the mutations and the sentence agree with each other and disagree
 * only with the list on screen, which is why the anchor is the list.
 */
const pickedSenders = (): Set<string> =>
  new Set(pickedRows().map((r) => (r.querySelector(".addr")?.textContent ?? "").trim().toLowerCase()));

beforeEach(() => {
  window.location.hash = "#/ohbox";
  sent = [];
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  vi.restoreAllMocks();
});

/**
 * Pick a run of rows and press Move → the named place. The ids AND the senders are read while
 * the rows are still on screen: the press takes them out of the list, so a reading taken
 * afterwards is a reading of what is left.
 */
async function moveSelectionTo(place: string, picks: number): Promise<{ ids: string[]; senders: Set<string> }> {
  for (let i = 0; i < picks; i += 1) await key("ArrowDown", { shiftKey: true });
  const ids = pickedIds();
  const senders = pickedSenders();
  expect(ids.length, "the selection gesture picked nothing").toBeGreaterThan(1);
  sent = [];
  await click(buttonStarting("Move"));
  await click(buttonStarting(`→ ${place}`));
  await settle();
  return { ids, senders };
}

describe("the selection's Move", () => {
  it("writes the sender's routing, and says so in senders and messages", async () => {
    await mountShell();
    await moveSelectionTo("News", 2);
    // Read while it is on screen: the Undo capsule leaves the tree once its window has closed.
    const saidAtPress = toastText();

    /* THE ROUTING IS HELD, which is the undo this press now carries: nothing about the sender's
       future mail is on the wire while the toast stands. */
    expect(sent.filter((m) => m.kind.startsWith("rule_")),
      "a rule went out inside the undo window — there would be nothing left to undo").toEqual([]);

    // ROUTING, not a folder move to a presented place: the rule half is what decides where a
    // sender's mail lives, and the old arm never wrote one. It goes when the window closes.
    await afterTheWindow();
    const routing = sent.filter((m) => m.kind.startsWith("rule_") || m.kind === "screener_decide");
    expect(routing.length, "the press wrote no routing at all").toBeGreaterThan(0);

    /* AND THE MAIL, into the destination's own folder. One statement in two files: the same pair
       is asserted in `shell-screening-bulk.test.ts`, because "writes routing" and "moves the
       messages" are halves of one press and a file that says only one of them leaves the other
       free to rot. `ohmail/News` is a real IMAP folder — `FOLDER_OF_VIEW` maps it and the rule
       routes future mail into the same place. */
    const intoReads = sent.filter((m): m is Extract<EngineMutation, { kind: "move" }> =>
      m.kind === "move");
    expect(intoReads.length, "the press wrote routing and moved nothing").toBeGreaterThan(0);
    expect([...new Set(intoReads.map((m) => m.folder))], "a move went somewhere else")
      .toEqual(["ohmail/News"]);

    // …and the sentence names both numbers.
    expect(saidAtPress, "the sentence did not count senders and messages")
      .toMatch(/Mail from [1-9]\d* senders? now goes to News/);
  }, 20000);

  it("moves only the messages that were picked", async () => {
    await mountShell();
    const { ids } = await moveSelectionTo("News", 2);
    const picked = new Set(ids);
    const moves = sent.filter((m): m is Extract<EngineMutation, { kind: "move" }> => m.kind === "move");
    /* THE NARROWING IS ONLY A READING IF SOMETHING MOVED. Measured: with the mint taken out of
       `planMoveToPlace` this press put no move on the wire at all and "no strays" passed over an
       empty list — a guard that cannot fail. */
    expect(moves.length, "the press moved nothing, so the narrowing below reads nothing")
      .toBeGreaterThan(0);
    const strays = moves.map((m) => m.messageId).filter((id) => !picked.has(id));
    expect(strays, "a press on a selection moved mail nobody picked").toEqual([]);
  }, 20000);

  /**
   * A MIXED SET IS N DECISIONS, NEVER ONE GUESS — one plan over the set would decide for senders
   * nobody asked about. The groups are counted against the LIST and not against the press's own
   * output, because a press that guessed once agrees with itself perfectly.
   *
   * Watched: `bySender` seeded with a constant key, and the routing count falls to one against a
   * three-sender list, here and in the sentence.
   */
  it("writes one routing per DISTINCT sender, and counts the senders the list holds", async () => {
    await mountShell();
    const { senders } = await moveSelectionTo("News", 2);
    const saidAtPress = toastText();
    expect(senders.size, "the selection spans one sender, so grouping cannot be read").toBeGreaterThan(1);

    /* ONE HELD PRESS PER SENDER, read where they land: the window holds one intent per subject,
       so the count below is a statement about the grouping and not about the timing. */
    await afterTheWindow();
    const routing = sent.filter((m) => m.kind.startsWith("rule_") || m.kind === "screener_decide");
    const subjects = new Set(routing.map((m) => JSON.stringify(
      (m as { match?: string; ruleId?: string; messageId?: string }).match
      ?? (m as { ruleId?: string }).ruleId
      ?? (m as { messageId?: string }).messageId,
    )));
    expect(subjects.size, "the press wrote one routing for the whole set").toBe(senders.size);
    expect(routing.length, "a sender got two routing writes from one press").toBe(senders.size);

    // …and the sentence says the same number the list does.
    const said = /Mail from (\d+) senders? now goes to News/.exec(saidAtPress);
    expect(said, "the sentence did not count senders").not.toBeNull();
    expect(Number(said![1])).toBe(senders.size);
  }, 20000);
});
