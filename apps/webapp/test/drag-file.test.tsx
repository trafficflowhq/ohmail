/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, FOLDER_OF_VIEW, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * DRAG-AND-DROP FILING TO THE RAIL — one semantic, new gesture.
 *
 * The claims, each mutation-proven against the real shell (the same full-shell harness as
 * `shell-screening-bulk.test.ts`, counting mutations at the ADAPTER — the last thing before
 * the wire):
 *
 *   · A drop dispatches THE SAME mutation the equivalent pill action dispatches — asserted by
 *     driving the pill's own Move on one message and the drag on another and comparing the two
 *     wire objects field for field.
 *   · An illegal target never lights and never accepts. "Illegal" is the existing controls'
 *     own enablement: the move panel excludes the current folder, the picker's apply skips a
 *     tag already on the message, and the Screener row is no filing target at all — screening
 *     is a consent ceremony about senders, deliberately outside the bulk vocabulary.
 *   · Below the movement threshold the press is a plain click; after a real drag the release
 *     is NOT one (suppressed exactly once).
 *   · A drop of a picked row covers the whole selection and clears it, exactly as the bulk
 *     bar's own commit does.
 *   · Escape cancels: nothing dispatches, the drag's own Escape never reaches the shell's
 *     ladder (a live selection survives it), and no highlight is left standing.
 *
 * Pointer events are dispatched as `MouseEvent`s with pointer type names — jsdom has no
 * `PointerEvent` constructor, and the handlers read only `button`/`clientX`/`clientY`/
 * `pointerType` (absent means "not touch", which is the mouse the gesture is for). jsdom has
 * no layout either, so `document.elementFromPoint` — absent entirely — is stubbed per hover
 * step; the controller reads it optionally and a missing implementation is simply "over
 * nothing", which is also what a real browser answers between targets.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
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
/** Every mutation the demo adapter was asked to perform, in order. */
let sent: EngineMutation[] = [];

function setViewport(mobile: boolean): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

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
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  // Put the cursor on the first row — the Ohbox selects nothing by itself.
  await key("j");
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const click = async (el: Element | null | undefined, init: MouseEventInit = {}): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
};

/** A pointer event by NAME — see the header for why the constructor is MouseEvent. */
const pointer = async (
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  target: EventTarget,
  x: number,
  y: number,
): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
};

/** What `document.elementFromPoint` answers while the pointer is "over" `el`. */
const hovering = (el: Element | null): void => {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => el;
};

const rows = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")];
/** Rows standing for ONE message — no `⤷ N` fold — so a per-row assert names one id. */
const soloRows = (): HTMLElement[] => rows().filter((r) => !(r.textContent ?? "").includes("⤷"));
const rail = (id: string): HTMLElement | null => host!.querySelector<HTMLElement>(`[data-rail-id="${id}"]`);
const tagRows = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>("[data-rail-tag-id]")];
const ghost = (): HTMLElement | null => document.body.querySelector<HTMLElement>(".drag-ghost");
const lit = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".drop-ok")];
const kinds = (kind: string) => sent.filter((m) => m.kind === kind);

/** Drag `row` past the threshold and leave the pointer over `over`. */
const dragOver = async (row: HTMLElement, over: Element | null): Promise<void> => {
  await pointer("pointerdown", row, 10, 10);
  hovering(over);
  await pointer("pointermove", window, 60, 60);
};

/** Advance past every drop/spring-back timer the gesture leaves behind. */
const settle = async (): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(600); });
};

beforeEach(() => {
  vi.useFakeTimers();
  setViewport(false);
  window.location.hash = "#/ohbox";
  sent = [];
  // The demo adapter IS the transport — see `shell-screening-bulk.test.ts` for why the spy
  // calls through with every argument.
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
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("drag-to-file — the drop is the pill's own dispatch", () => {
  it("dropping a row on News puts the SAME move on the wire as the pill's Move → News", async () => {
    await mountShell();

    // ── the pill's own Move on the cursor row, as the reference dispatch ──────────────────
    const pillRowId = rows()[0]!.dataset.id!;
    const byText = (text: string): HTMLButtonElement => {
      // The verb's LABEL, without the keycap the button also wears (`<Key chord>` prints the
      // registry's cap into the button — `Move` reads "Move m" in textContent terms). The
      // dispatch assertions below are untouched; only the finder learned the bar's anatomy.
      const label = (x: HTMLButtonElement): string => {
        const kbd = x.querySelector("kbd")?.textContent ?? "";
        return (x.textContent ?? "").replace(kbd, "").trim();
      };
      const b = [...host!.querySelectorAll<HTMLButtonElement>(".read-col .abar button")]
        .find((x) => label(x) === text);
      expect(b, `no "${text}" control in the pill`).toBeTruthy();
      return b!;
    };
    await click(byText("Move"));
    await click(byText(`→ ${messages.place.reads}`));
    const pillMove = kinds("move");
    expect(pillMove).toHaveLength(1);
    // The Move writes the sender's rule, so its move is marked as that press's (`pressRule`).
    expect(pillMove[0]).toEqual({ kind: "move", messageId: pillRowId, folder: FOLDER_OF_VIEW.reads, pressRule: true });

    // ── the drag, on a different (solo) row, compared field for field ─────────────────────
    sent = [];
    const row = soloRows().find((r) => r.dataset.id !== pillRowId)!;
    const dragId = row.dataset.id!;
    await dragOver(row, rail("reads"));
    expect(ghost(), "no drag ghost past the threshold").toBeTruthy();
    expect(rail("reads")!.classList.contains("drop-ok"), "legal target did not light").toBe(true);
    await pointer("pointerup", window, 60, 60);
    await settle();

    const dragMove = kinds("move");
    expect(dragMove).toHaveLength(1);
    // Dispatch-level equality: the drag's wire object IS the pill's, re-keyed to the dragged row.
    expect(dragMove[0]).toEqual({ ...pillMove[0]!, messageId: dragId });
    expect(ghost(), "ghost outlived the drop").toBeNull();
    expect(lit(), "highlight outlived the drop").toHaveLength(0);
  });

  it("an illegal target never lights and never accepts; non-filing rail rows are never targets", async () => {
    await mountShell();
    const row = rows()[1]!;

    // Ohbox → Ohbox: the move panel's own exclusion of the current folder.
    await dragOver(row, rail("ohbox"));
    expect(lit()).toHaveLength(0);
    await pointer("pointerup", window, 60, 60);
    await settle();
    expect(kinds("move")).toHaveLength(0);

    // Screener / History / Drafts / Settings: not filing targets at all.
    for (const id of ["screener", "history", "drafts", "settings"]) {
      const target = rail(id);
      if (!target) continue;
      await dragOver(rows()[1]!, target);
      expect(lit(), `${id} lit up`).toHaveLength(0);
      await pointer("pointerup", window, 60, 60);
      await settle();
    }
    expect(sent.filter((m) => m.kind !== "mark_seen")).toHaveLength(0);
  });

  it("below the threshold the press stays a click; past it the release is not one", async () => {
    await mountShell();
    const row = rows()[2]!;
    const id = row.dataset.id!;

    // 3px of travel: no drag, and the row's own click still selects.
    await pointer("pointerdown", row, 10, 10);
    await pointer("pointermove", window, 12, 11);
    expect(ghost(), "a ghost below the threshold").toBeNull();
    await pointer("pointerup", window, 12, 11);
    await click(row);
    expect(row.classList.contains("sel"), "the click after a non-drag did not select").toBe(true);

    // A real drag: the release's click is suppressed — once.
    const other = rows().find((r) => r.dataset.id !== id && !r.classList.contains("sel"))!;
    await dragOver(other, null);
    await pointer("pointerup", window, 60, 60);
    await click(other);
    expect(other.classList.contains("sel"), "the drag's release still clicked").toBe(false);
    await click(other);
    expect(other.classList.contains("sel"), "the suppression was not one-shot").toBe(true);
    await settle();
  });

  it("a drop of a picked row covers the whole selection and clears it", async () => {
    await mountShell();
    await key("x");
    await key("j");
    await key("x");
    const picked = host!.querySelectorAll('.view-ohbox .row[aria-selected="true"]');
    expect(picked.length).toBeGreaterThanOrEqual(2);
    // The count the bar states is MESSAGES (a folded row picks its members), so it is the
    // number of moves a drop must dispatch — and the number the ghost badge must wear.
    // The count is the pill's leading capsule since 0.15.0 (`.list-foot .abar-count`), and the
    // number inside it is the live region — which is exactly the span to read here.
    const stated = Number(
      (host!.querySelector('.list-foot .abar-count [role="status"]')?.textContent ?? "").match(/\d+/)?.[0],
    );
    expect(stated).toBeGreaterThanOrEqual(2);

    sent = [];
    await dragOver(picked[0] as HTMLElement, rail("reads"));
    // The ghost badges the whole selection, not the one row under the pointer.
    expect(ghost()!.querySelector(".dg-count")?.textContent).toBe(String(stated));
    await pointer("pointerup", window, 60, 60);
    await settle();

    const moved = kinds("move") as Array<{ messageId: string; folder: string }>;
    expect(moved).toHaveLength(stated);
    expect(new Set(moved.map((m) => m.messageId)).size).toBe(stated);
    for (const m of moved) expect(m.folder).toBe(FOLDER_OF_VIEW.reads);
    expect(host!.querySelector(".list-foot"), "the selection survived its own drop").toBeNull();
  });

  it("Escape cancels: no dispatch, the selection survives, the release is not a click", async () => {
    await mountShell();
    await key("x");
    expect(host!.querySelector(".list-foot")).toBeTruthy();

    const row = rows()[3]!;
    sent = [];
    await dragOver(row, rail("reads"));
    expect(rail("reads")!.classList.contains("drop-ok")).toBe(true);
    await key("Escape");
    // The drag owned that Escape: nothing cleared the selection, nothing stayed lit.
    expect(host!.querySelector(".list-foot"), "Escape fell through to the shell's ladder").toBeTruthy();
    expect(lit()).toHaveLength(0);
    await pointer("pointerup", window, 60, 60);
    // The release's click arrives in the same task in a browser — before any timer runs.
    await click(row);
    expect(row.classList.contains("sel"), "the cancelled drag's release still clicked").toBe(false);
    await settle();
    expect(sent.filter((m) => m.kind !== "mark_seen")).toHaveLength(0);
    expect(ghost()).toBeNull();
  });

  it("a tag drop is the picker's own apply — and an applied tag stops being a target", async () => {
    await mountShell();
    const row = soloRows()[0]!;
    const rowId = row.dataset.id!;

    // ── the picker's own apply on the same row, as the reference dispatch ────────────────
    await click(row);
    await key("t");
    const free = [...host!.querySelectorAll<HTMLElement>(".tagp li[role='option']")]
      .find((li) => !li.querySelector(".ck") && !li.classList.contains("mk"));
    expect(free, "no unassigned tag in the picker").toBeTruthy();
    await click(free!);
    const pickerAssign = kinds("tag_assign")[0] as Record<string, unknown> & { tagId: string };
    expect(pickerAssign).toMatchObject({ kind: "tag_assign", messageId: rowId, assigned: true });
    await key("Escape");

    // ── the drag, onto a DIFFERENT tag's rail row — the first one that lights ────────────
    sent = [];
    let target: HTMLElement | null = null;
    for (const tag of tagRows()) {
      if (tag.dataset.railTagId === pickerAssign.tagId) continue;
      await dragOver(rows().find((r) => r.dataset.id === rowId)!, tag);
      if (tag.classList.contains("drop-ok")) { target = tag; break; }
      // Not this one — release over it (an illegal drop dispatches nothing) and try the next.
      await pointer("pointerup", window, 60, 60);
      await settle();
    }
    expect(target, "no tag row ever lit").toBeTruthy();
    const tagId = target!.dataset.railTagId!;

    sent = [];
    await pointer("pointerup", window, 60, 60);
    await settle();
    const assigns = kinds("tag_assign");
    expect(assigns).toHaveLength(1);
    const dragAssign = assigns[0] as Record<string, unknown>;
    // Dispatch-level equality with the picker: same kind, same row, same direction, and the
    // same field inventory on the wire — the one divergence is WHICH tag, which is the
    // drop's whole input. (`labels` is engine bookkeeping both paths acquire identically.)
    expect(dragAssign).toMatchObject({ kind: "tag_assign", messageId: rowId, tagId, assigned: true });
    expect(Object.keys(dragAssign).sort()).toEqual(Object.keys(pickerAssign).sort());

    // The picker's own enablement, mirrored: already applied ⇒ not a target.
    sent = [];
    await dragOver(rows().find((r) => r.dataset.id === rowId)!, target);
    expect(target!.classList.contains("drop-ok"), "an applied tag still lit").toBe(false);
    await pointer("pointerup", window, 60, 60);
    await settle();
    expect(kinds("tag_assign")).toHaveLength(0);
  });
});
