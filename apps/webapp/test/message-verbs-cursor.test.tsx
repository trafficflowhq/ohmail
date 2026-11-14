/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MessageAction } from "../app/shell/MessagePane";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SPLIT VIEWS' HALF OF THE FIRST-PRESS RULE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `cursorless-first-press.test.tsx` proves the rule over the shell's own three lists. The verbs
 * seam (`message-verbs.ts`) is the other host: Folder, Tag and History mount it over a cursor the
 * shell cannot see, and it declared `disabledReason: "no_cursor"` with nothing behind it to
 * answer — the shell's placer holds no cursor for those routes and declines, so the press stayed
 * silent. Two things had to be true and neither could be seen from the other:
 *
 *   · the seam has to CLAIM a placer at all, over the rows and the selector the view hands it;
 *   · that claim has to BEAT the shell's, and the shell's is always the more recent one (React
 *     runs a child's effects before its parent's), which is what `PlacerScope` states.
 *
 * The host below is a view's shape and no more: rows with `.row[data-id]`, a cursor in local
 * state, and DELIBERATELY no `?? rows[0]` fallback — Folder, Tag and History each carry one, and
 * a fixture that copied it would place the cursor before the press and measure nothing. The seam
 * admits `shown: null` by its own contract, which is the state under test.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────────
 *
 *   · drop `useRowCursorPlacer` from `message-verbs.ts` → every placing case reds;
 *   · claim it at `"global"` instead of `"view"` → the precedence case reds (the shell answers);
 *   · make the parked walk RUN the binding → "performs NOTHING" reds with a verb dispatched;
 *   · drop `placeFirstRow`'s standing-cursor or DOM-row refusal → the seam cases at the bottom
 *     red; neither is reachable through the dispatcher, which is why they are called directly;
 *· return `true` from `placeFirstRow` on an empty list → the empty-list case reds (on the
 *     keypress it swallows: with no rows, nothing else about the screen differs).
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  (Element.prototype as unknown as Record<string, () => void>).scrollIntoView = () => {};
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: `p${id}@example.invalid`, name: `Person ${id}` },
  to: [], date: "2026-09-11T09:00:00.000Z", unread: false,
  updatedAt: "2026-09-11T09:00:00.000Z",
} as unknown as EngineMessage);

/** Everything a press did, in order — the verbs dispatched and the rows the placer asked for. */
interface Recorded {
  actions: Array<[MessageAction, string]>;
  globalAsked: string[];
}

/**
 * Mount the seam the way a split view mounts it, under a SHELL that claims the global placer —
 * this app's real shape, and the only shape in which the precedence question is askable.
 */
async function mount(ids: string[], toastHost = true): Promise<{ el: HTMLElement; rec: Recorded }> {
  const { useCursorPlacer } = await import("@ohmail/app-logic/keys/keymap");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const { useMessageVerbs } = await import("../app/shell/message-verbs.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const rows = ids.map(msg);
  const rec: Recorded = { actions: [], globalAsked: [] };

  function View(): React.ReactNode {
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    /* NO FALLBACK — see the header. The cursor is the person's pick and nothing else. */
    const shown = rows.find((m) => m.id === selectedId) ?? null;
    useMessageVerbs({
      shown,
      scope: ".view-folder",
      onAction: (a, m) => rec.actions.push([a, m.id]),
      onAddTag: () => {},
      onScreen: () => {},
      canDelete: () => true,
      canReplyAll: () => true,
      rows,
      select: setSelectedId,
    });
    return h("div", { className: "view-folder" },
      rows.map((m) => h("div", {
        key: m.id,
        className: m.id === shown?.id ? "row sel" : "row",
        "data-id": m.id,
      })));
  }

  function Shell(): React.ReactNode {
    /* The shell's own claim, which holds no cursor for this route and would decline — the thing
       the view's claim has to beat. It answers `true` here so that a case reading `globalAsked`
       cannot pass merely because a declining placer changed nothing. */
    useCursorPlacer((label) => { rec.globalAsked.push(label); return true; }, "global");
    return h(View, null);
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  /* WITHOUT the toast host is a real mount, not a contrivance: these three views are mounted bare
     in their own tests (`folders-rail`, `history-window`) and nothing there provides one. */
  const keymap = h(KeymapProvider, { children: h(Shell, null) });
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-11T09:00:00.000Z"),
      children: h(ThemeProvider, {
        children: toastHost ? h(ToastHost, { children: keymap }) : keymap,
      }),
    }));
  });
  return { el: container, rec };
}

/** Dispatch and hand the event back, so `defaultPrevented` — what a placement CONSUMES — is readable. */
const key = async (k: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { document.dispatchEvent(e); });
  return e;
};

const selectedIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".row.sel[data-id]")].map((r) => r.getAttribute("data-id") ?? "");
const toastText = (): string => document.querySelector(".toast")?.textContent ?? "";
const hintFor = (label: string): string => messages.cursor.placed.replace("{label}", label);

describe("a split view's list with rows and no cursor", () => {
  it("places nothing on arrival — a press is a deliberate act, an arrival is not", async () => {
    const { el } = await mount(["m1", "m2", "m3"]);
    expect(selectedIds(el), "a cursor was placed with no press").toEqual([]);
    expect(toastText()).toBe("");
  });

  it("`e` places the cursor on the first row, names Park, and performs NOTHING", async () => {
    const { el, rec } = await mount(["m1", "m2", "m3"]);
    const e = await key("e");
    expect(selectedIds(el), "the cursor did not land on the first row").toEqual(["m1"]);
    expect(toastText()).toBe(hintFor(messages.shortcuts.park));
    expect(rec.actions, "the first press filed mail").toEqual([]);
    expect(e.defaultPrevented, "the press that placed a cursor was not consumed").toBe(true);
  });

  it("…and the SECOND press performs — the ordinary path, not a second mechanism", async () => {
    const { rec } = await mount(["m1", "m2", "m3"]);
    await key("e");
    await key("e");
    expect(rec.actions).toEqual([["aside", "m1"]]);
  });

  it("the hint names the verb of the chord PRESSED, verb by verb", async () => {
    for (const [chord, label, init] of [
      ["r", messages.shortcuts.reply, {}],
      ["b", messages.shortcuts.resurface, {}],
      ["Backspace", messages.shortcuts.deleteKey, {}],
      ["F", messages.shortcuts.forward, { shiftKey: true }],
    ] as const) {
      const { el } = await mount(["m1", "m2"]);
      await key(chord, init);
      expect(selectedIds(el), `${chord} placed no cursor`).toEqual(["m1"]);
      expect(toastText(), `${chord}'s hint names the wrong verb`).toBe(hintFor(label));
      for (const root of roots) await act(() => { root.unmount(); });
      roots = [];
      document.body.innerHTML = "";
    }
  });

  it("THE VIEW'S CLAIM ANSWERS, not the shell's — though the shell claimed later", async () => {
    /* The scope, stated as a press. React runs the view's effect first, so by recency the shell
       is always the winner; without a scope this list's cursor would be placed by a host that
       holds no cursor for it — or, as the shipped shell does, not placed at all. */
    const { el, rec } = await mount(["m1", "m2", "m3"]);
    await key("e");
    expect(rec.globalAsked, "the shell was asked to place this view's cursor").toEqual([]);
    expect(selectedIds(el)).toEqual(["m1"]);
  });

  it("a HELD key places nothing — auto-repeat is not a press", async () => {
    const { el } = await mount(["m1", "m2"]);
    await key("Backspace", { repeat: true });
    expect(selectedIds(el), "a repeat placed a cursor").toEqual([]);
    // THE CONTROL: the same key, the same list, pressed rather than held.
    await key("Backspace");
    expect(selectedIds(el)).toEqual(["m1"]);
  });
});

describe("a split view mounted with nowhere to say it", () => {
  it("renders, and places nothing — the view is not broken, the placement is refused", async () => {
    /* The bare mount, end to end: no `ToastHost`, so `useCursorHint` answers `null` and the
       placement declines. The rows still render — a view mounted without a toast layer must not
       throw, which is what this shape cost when the hint reached for `useToast`. */
    const { el, rec } = await mount(["m1", "m2", "m3"], false);
    expect(el.querySelectorAll(".row[data-id]").length, "the view did not render").toBe(3);
    await key("e");
    expect(selectedIds(el), "a cursor was placed with no sentence to explain it").toEqual([]);
    expect(rec.actions).toEqual([]);
  });
});

describe("a split view's list with NO rows", () => {
  it("places nothing, says nothing, and does not consume the key", async () => {
    const { el, rec } = await mount([]);
    /* NOTHING PLACED ⇒ NOTHING CONSUMED, and that is the whole difference an empty list makes
       here: with no rows the selection, the sentence and the wire are silent EITHER WAY, so a
       placer answering `true` over nothing is invisible except in the keypress it swallows —
       which is the key an empty Ohbox would take away from whatever else wanted it. */
    const consumed: boolean[] = [];
    for (const chord of ["e", "r", "b", "Backspace"]) consumed.push((await key(chord)).defaultPrevented);
    expect(consumed, "an empty list swallowed the press").toEqual([false, false, false, false]);
    expect(selectedIds(el)).toEqual([]);
    expect(toastText()).toBe("");
    expect(rec.actions).toEqual([]);
    /* And the shell was still not asked: a view that declines does not hand the question on —
       a second host would draw a ring on a list the pressed verb does not act on. */
    expect(rec.globalAsked).toEqual([]);
  });
});

/**
 * ── THE PLACEMENT ITSELF, AT ITS OWN SEAM ────────────────────────────────────────────────────
 *
 * `placeFirstRow` is exported and has two hosts, so its refusals are contract and not private
 * detail. Two of them cannot be reached through the dispatcher — it asks a placer only for a
 * binding already parked for want of a cursor, so "a cursor is standing" never arrives from
 * there, and "the window has not mounted the row" needs a list held in state and not drawn. A
 * guard nobody can watch fail is decoration; these are the calls that make both of them fail.
 */
describe("placeFirstRow refuses, at its own seam", () => {
  const host = (over: Partial<import("../app/shell/cursor-placer").CursorHost> = {}) => {
    const picked: string[] = [];
    return {
      picked,
      h: {
        rows: [{ id: "m1" }, { id: "m2" }],
        current: null as string | null,
        scope: ".view-folder",
        select: (id: string) => picked.push(id),
        ...over,
      },
    };
  };
  const draw = (ids: string[]): void => {
    document.body.innerHTML =
      `<div class="view-folder">${ids.map((id) => `<div class="row" data-id="${id}"></div>`).join("")}</div>`;
  };

  it("a cursor already standing is not moved", async () => {
    const { placeFirstRow } = await import("../app/shell/cursor-placer.js");
    draw(["m1", "m2"]);
    const said: string[] = [];
    const { picked, h } = host({ current: "m2" });
    expect(placeFirstRow(h, "Park it", (l) => said.push(l))).toBe(false);
    expect(picked, "a standing cursor was moved to the first row").toEqual([]);
    expect(said, "a sentence was said about a placement that did not happen").toEqual([]);
  });

  it("a row the window has not mounted is not placed on", async () => {
    const { placeFirstRow } = await import("../app/shell/cursor-placer.js");
    /* The list is held in state and NOT drawn — a scrolled window, or a host that renders its
       rows elsewhere. A ring on a row nobody can see is worse than the silence. */
    draw([]);
    const said: string[] = [];
    const { picked, h } = host();
    expect(placeFirstRow(h, "Park it", (l) => said.push(l))).toBe(false);
    expect(picked).toEqual([]);
    expect(said).toEqual([]);
  });

  it("a host with nowhere to SAY it places nothing", async () => {
    const { placeFirstRow } = await import("../app/shell/cursor-placer.js");
    /* A ring that appears with nothing explaining it is this rule's own defect one surface over.
       `null` is what `useCursorHint` answers where there is no toast layer — a view mounted bare,
       which is how these three views are mounted in their own tests. */
    draw(["m1", "m2"]);
    const { picked, h } = host();
    expect(placeFirstRow(h, "Park it", null)).toBe(false);
    expect(picked, "a cursor was placed with no sentence to explain it").toEqual([]);
  });

  it("…and the ordinary case is admitted — select, then say, once each", async () => {
    const { placeFirstRow } = await import("../app/shell/cursor-placer.js");
    draw(["m1", "m2"]);
    const said: string[] = [];
    const { picked, h } = host();
    expect(placeFirstRow(h, "Park it", (l) => said.push(l))).toBe(true);
    expect(picked).toEqual(["m1"]);
    expect(said).toEqual(["Park it"]);
  });
});
