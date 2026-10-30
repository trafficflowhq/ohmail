/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { stubThreadLayout } from "./fixtures/thread-layout.js";

/**
 * THE ARROW-KEY SPATIAL MODEL — rail ← list → open message (`shell/zone-nav.tsx`). Asserted:
 * ↓/↑ are j/k (same walk, same entry moves); flicking through five messages marks NOTHING, and
 * staying on one past the dwell saves exactly that one as a `"glance"` (mutants: marking on the
 * spot, `DWELL_MS → 0`); ← moves focus into the rail and →/Escape return; → from the list lands on
 * the reading column as ENGAGEMENT, which presents and saves the read at once; ↑/↓ inside the
 * column scroll it; text fields are never touched. The rail is static DOM in the `.rail`
 * vocabulary, which is the contract under test: whatever renders the rail, the keys must find it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The layout, by width query. Default desktop: nothing matches — the split column stands, the
 * dwell arms. `mobile` makes the phone question (699.98) and the drawer one (1023.98) answer true, which is the drawer-and-sheet
 * world the round-1 review findings live in.
 */
function setViewport(mobile = false): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && /max-width:\s*(699\.98|1023\.98)px/.test(query), media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; threadId?: string | null; date?: string }
function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: `sender-${m.id}`, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: `snip-${m.id}`, body: `the words of ${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let rail: HTMLElement | null = null;
let markSeen: Array<[string[], boolean, string | undefined]> = [];
let viewRenders = 0;
let shellKey: string | null = null;

/** The rail, in the `.rail` vocabulary and nothing else — see the header. */
function mountRail(): void {
  rail = document.createElement("nav");
  rail.className = "rail";
  rail.innerHTML =
    '<button type="button" class="ritem on">Ohbox</button>' +
    '<button type="button" class="ritem">News</button>' +
    '<button type="button" class="ritem">Settings</button>';
  document.body.appendChild(rail);
}

async function render(newForYou: Row[]): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider, useEnabledBinding } = await import("../app/shell/keymap.js");
  markSeen = [];
  viewRenders = 0;
  // Called as a function, so the view's own hooks live here and its every render is counted.
  const Counted = (p: unknown): React.ReactElement => {
    viewRenders++;
    return (OhboxView as unknown as (q: unknown) => React.ReactElement)(p);
  };
  function Wrapper(): React.ReactElement {
    const [sel, setSel] = React.useState<string | null>(null);
    // The shell reads the registry like this (`useShellKeys`), and it renders the view.
    shellKey = useEnabledBinding("j")?.label ?? null;
    return h(Counted as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      resurfacedRows: [], newForYou: newForYou.map(msg), previouslySeen: [],
      replyDone: null, threadSubject: () => null,
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: (ids: string[], unread: boolean, via?: string) => markSeen.push([ids, unread, via]),
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      selectedId: sel,
      onSelect: (id: string) => setSel(id),
    } as never);
  }
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(Wrapper) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  mountRail();
  await act(async () => { root!.render(el); });
}

const key = async (k: string, target: EventTarget = document): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
};

const cursor = (): string | null =>
  host!.querySelector<HTMLElement>(".row[data-id].sel")?.dataset.id ?? null;

const focused = (): Element | null => document.activeElement;

/** Undone after each case: a layout stub one case installs. */
const onTeardown: Array<() => void> = [];

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  rail?.remove();
  root = null;
  host = null;
  rail = null;
  for (const undo of onTeardown.splice(0)) undo();
});

const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

const FIVE: Row[] = [
  { id: "m1", unread: true, date: at(13) },
  { id: "m2", unread: true, date: at(12) },
  { id: "m3", unread: true, date: at(11) },
  { id: "m4", unread: true, date: at(10) },
  { id: "m5", unread: true, date: at(9) },
];

describe("↓/↑ in the list are j/k", () => {
  it("↓ enters at the top and walks; ↑ walks back; ↑ with no cursor enters at the bottom", async () => {
    setViewport();
    await render(FIVE);
    expect(cursor()).toBeNull();

    await key("ArrowDown");
    expect(cursor(), "↓ did not enter the list at the top, the way j does").toBe("m1");
    await key("ArrowDown");
    expect(cursor()).toBe("m2");
    await key("ArrowUp");
    expect(cursor(), "↑ did not return to the row ↓ left — the pair is not an inverse").toBe("m1");
    await key("ArrowUp");
    expect(cursor(), "↑ at the top lost or wrapped the cursor").toBe("m1");
  });

  it("↑ enters from the bottom on a list nobody has entered — k's own entry move", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowUp");
    expect(cursor()).toBe("m5");
  });

  it("arrows and letters interleave over one cursor — one walk, four keycaps", async () => {
    setViewport();
    await render(FIVE);
    await key("j");
    await key("ArrowDown");
    await key("j");
    expect(cursor()).toBe("m3");
    await key("ArrowUp");
    await key("k");
    expect(cursor()).toBe("m1");
  });
});

describe("the read-marking guard on arrow navigation", () => {
  it("a flick through five messages marks NOTHING", async () => {
    setViewport();
    await render(FIVE);
    vi.useFakeTimers();

    for (let i = 0; i < 5; i++) {
      await key("ArrowDown");
      // Well under the dwell, well over an instant: a real flick's cadence.
      await act(async () => { vi.advanceTimersByTime(300); });
    }
    expect(cursor()).toBe("m5");
    expect(markSeen, "arrowing through the list wrote read state — the dwell guard is gone")
      .toEqual([]);
  });

  it("staying on a row is a preview: nothing is marked, however long", async () => {
    setViewport();
    await render(FIVE);
    vi.useFakeTimers();

    await key("ArrowDown");
    expect(cursor()).toBe("m1");
    // Base: the 2 s dwell read m1 here. A preview reads nothing.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(markSeen, "a preview wrote read state").toEqual([]);

    await key("ArrowDown");
    expect(markSeen).toEqual([]);

    await act(async () => { vi.advanceTimersByTime(3000); });
    await key("ArrowDown");
    expect(markSeen).toEqual([]);
  });
});

describe("the split views hide their reading column together at phone widths", () => {
  it("the app.css hide rule names every split view's column — Folder included", async () => {
    // A review finding: the hide block covered Ohbox, History, Tag and Triage and omitted
    // Folder — a latent mismatch with `readColumnHidden()` that the zone walk turned live,
    // because → probes the column with focus() and only a REFUSED focus takes the
    // deliberate-open path. The rule is asserted as text: the block that hides the split
    // columns must name all five, or a phone-width folder swallows the focus and no reader
    // opens.
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Under the jsdom environment `import.meta.url` is not file-scheme, and the suite runs
    // from the repo root or the app dir depending on the invoker — resolve from whichever
    // holds the file.
    const candidate = ["apps/webapp/app/app.css", "app/app.css"]
      .map((rel) => path.resolve(process.cwd(), rel))
      .find((abs) => fs.existsSync(abs))!;
    const css = fs.readFileSync(candidate, "utf8");
    // Since 0.25.5 ONE rule hides every split view's column (`split-read-column-one-rule.test.ts`
    // names the views it reaches), so no view can be left out of a list again.
    expect(css, "the mobile hide rule for every split view's column is gone")
      .toMatch(/\.view\.split > \.read-col\s*\{\s*display:\s*none;/);
  });
});

describe("claimed arrows stop the sibling document listener", () => {
  it("ProviderPicker calls stopImmediatePropagation on the native event for every key it acts on", async () => {
    // A review finding: in the deployed App Router, React and the keymap registry are
    // sibling keydown listeners on `document`, and `stopPropagation` cannot stop a sibling —
    // MoreMenu measured this and `action-bar.test.ts` watches its CALL, because a test DOM
    // mounts React into a <div> where plain stopPropagation genuinely works. The same watch,
    // for the picker the zone walk collided with.
    const { ProviderPicker } = await import("../app/shell/ProviderPicker.js");
    if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC",
          children: h(ProviderPicker as never, { value: null, onChange: () => {} } as never),
        }),
      );
    });
    const tile = host!.querySelector<HTMLElement>("button")!;
    tile.focus();
    for (const k of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      let immediate = 0;
      e.stopImmediatePropagation = () => { immediate++; };
      await act(async () => { tile.dispatchEvent(e); });
      expect(immediate, `${k} did not claim the event away from the document listener`).toBe(1);
    }
  });
});

describe("the zone walk: rail ← list → open message", () => {
  it("← focuses the rail's active row; ↑/↓ walk the rail; → returns to the selected row", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");

    await key("ArrowLeft");
    const items = [...rail!.querySelectorAll("button")];
    expect(focused(), "← did not land on the rail's active row").toBe(items[0]);

    await key("ArrowDown");
    expect(focused(), "↓ in the rail did not move to the next row").toBe(items[1]);
    await key("ArrowDown");
    expect(focused()).toBe(items[2]);
    await key("ArrowUp");
    expect(focused()).toBe(items[1]);

    await key("ArrowRight");
    expect(
      (focused() as HTMLElement | null)?.closest?.(".rail"),
      "→ from the rail left focus in the rail",
    ).toBeFalsy();
    expect((focused() as HTMLElement | null)?.getAttribute("data-id")).toBe("m1");

    // …and the list keys answer again immediately.
    await key("ArrowDown");
    expect(cursor()).toBe("m2");
  });

  it("← with no cursor still reaches the rail, and → releases back to a resting list", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowLeft");
    expect((focused() as HTMLElement | null)?.closest?.(".rail")).toBeTruthy();
    await key("ArrowRight");
    // No selected row to land on: focus is released and the list rests, exactly as it
    // rests on arrival — the resting column is the Ohbox's own design, not a failure.
    expect(focused()).toBe(document.body);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");
  });

  it("→ from the list lands on the reading column as ENTERING it: what is on screen is read once the dwell is done", async () => {
    setViewport();
    // The column laid out, so the message's lines are on screen.
    const layout = stubThreadLayout();
    onTeardown.push(() => layout.restore());
    await render(FIVE);
    await key("ArrowDown");
    const row = (): HTMLElement | null => host!.querySelector(`.row[data-id="m1"]`);
    expect(row()!.dataset.unseen, "fixture: the row under the cursor must start unread").toBe("1");

    await key("ArrowRight");
    const col = host!.querySelector<HTMLElement>(".read-col");
    expect(focused(), "→ did not focus the reading column").toBe(col);
    expect(col!.getAttribute("role")).toBe("region");
    expect(col!.getAttribute("tabindex")).toBe("-1");
    // Entering starts the dwell on what is on screen, and once its top was there for it the read is
    // saved (this harness's mirror does not move, so the row keeps its ink).
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    expect(markSeen, "the write waits for the dwell").toEqual([]);
    await layout.passDwell();
    expect(markSeen, "→ into the message did not read it").toEqual([[["m1"], false, "glance"]]);

    // ← walks back to the list; moving the cursor is a departure, and it writes nothing more.
    await key("ArrowLeft");
    expect((focused() as HTMLElement | null)?.getAttribute("data-id")).toBe("m1");
    await key("ArrowDown");
    expect(markSeen).toEqual([[["m1"], false, "glance"]]);
  });

  it("↑/↓ inside the reading column scroll it by the named step and move no cursor", async () => {
    setViewport();
    await render(FIVE);
    const { READER_SCROLL_STEP } = await import("../app/shell/zone-nav.js");
    await key("ArrowDown");
    await key("ArrowRight");
    const col = host!.querySelector<HTMLElement>(".read-col")!;
    expect(col.scrollTop).toBe(0);

    await key("ArrowDown");
    expect(col.scrollTop, "↓ in the reader did not scroll the column").toBe(READER_SCROLL_STEP);
    expect(cursor(), "↓ in the reader moved the list cursor").toBe("m1");
    await key("ArrowDown");
    expect(col.scrollTop).toBe(2 * READER_SCROLL_STEP);
    await key("ArrowUp");
    expect(col.scrollTop).toBe(READER_SCROLL_STEP);
  });

  it("Escape walks back left: reader → list → rail", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    await key("ArrowRight");
    expect(focused()).toBe(host!.querySelector(".read-col"));

    await key("Escape");
    expect((focused() as HTMLElement | null)?.getAttribute("data-id")).toBe("m1");

    await key("Escape");
    expect((focused() as HTMLElement | null)?.closest?.(".rail"), "Escape in the list did not reach the rail")
      .toBeTruthy();
  });

  it("focus follows the cursor while a row owns it — Enter can never press the row you left", async () => {
    // → from the rail lands REAL focus on the selected row. If the next ↓ moved only the
    // view's cursor, focus would stand on the old row and Enter — the browser's own button
    // activation — would press a message the reader has visibly left. So while a row owns
    // focus, every cursor move re-lands focus on the `.sel` row (and announces it, which is
    // the screen-reader walk). With focus on the BODY, the same keys move only the cursor —
    // the mouse-and-letters flow stays untouched, asserted at the end.
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    await key("ArrowLeft");
    await key("ArrowRight");
    expect((focused() as HTMLElement | null)?.getAttribute("data-id")).toBe("m1");

    await key("ArrowDown");
    expect(cursor()).toBe("m2");
    expect((focused() as HTMLElement | null)?.getAttribute("data-id"),
      "the cursor moved and focus stayed on the row it left").toBe("m2");
    await key("j");
    expect((focused() as HTMLElement | null)?.getAttribute("data-id"),
      "the letter walk must rove focus exactly as the arrow walk does while a row owns it").toBe("m3");

    // Release focus (body): the virtual-cursor flow — cursor moves, focus does not.
    await act(async () => { (focused() as HTMLElement).blur(); });
    await key("ArrowDown");
    expect(cursor()).toBe("m4");
    expect(focused(), "a body-focused walk must not start grabbing focus").toBe(document.body);
  });

  it("Escape never outranks the view: with picks standing, it clears them from ANY zone", async () => {
    // THE SCOPE RULING, ASSERTED BEHAVIOURALLY. The zone walk registers at `global` scope,
    // so every view-layer Escape wins first — whatever order the layers re-registered in.
    // The registry-order test in `ohbox-read-state.test.ts` can be masked by shape-keyed
    // re-registration (a layer that re-registers moves to the head of its own scope), so
    // this drives the exact sequence that re-registers the ZONE layer last: pick, then
    // cross a zone boundary, then press Escape. A zone walk mounted at `view` scope would
    // dispatch "back to the list" here and leave the picked set standing.
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    await key("x");
    expect(host!.querySelector(".list-foot"), "fixture: the pick did not register").toBeTruthy();

    await key("ArrowRight"); // zone boundary: the zone layer re-registers after the pick
    expect(focused()).toBe(host!.querySelector(".read-col"));

    await key("Escape");
    expect(host!.querySelector(".list-foot"), "Escape walked zones over a standing selection")
      .toBeNull();
    expect(focused(), "clearing the picks must not move focus").toBe(host!.querySelector(".read-col"));

    // With nothing nearer left to claim it, the NEXT Escape walks.
    await key("Escape");
    expect((focused() as HTMLElement | null)?.getAttribute("data-id")).toBe("m1");
  });

  it("an open reader sheet IS the reader zone — scrolled by ↑/↓ from wherever focus was left", async () => {
    // A review finding: with the sheet up, ↑/↓ walked the hidden cursor behind the modal.
    // A second finding: the sheet opens WITHOUT taking focus, so a zone derived from focus
    // alone left the visible sheet unscrollable until the user first tabbed into it. The
    // sheet's EXISTENCE therefore decides the zone: ↑/↓ scroll the sheet with focus still in
    // the hidden shell, the list cursor stands still, and ← cannot land focus on a row or
    // the rail behind the modal (the kept dispatch-time gate).
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");

    const sheet = document.createElement("div");
    sheet.className = "reader";
    sheet.tabIndex = -1;
    document.body.appendChild(sheet);
    // In the app the sheet mounts through a React commit and the hook's every-commit refresh
    // re-derives the zone; this hand-made div rides the focus observer instead.
    await act(async () => { document.dispatchEvent(new Event("focusin")); });

    const { READER_SCROLL_STEP } = await import("../app/shell/zone-nav.js");
    await key("ArrowDown");
    expect(sheet.scrollTop, "↓ did not scroll the visible sheet — focus never entered it, and must not have to")
      .toBe(READER_SCROLL_STEP);
    expect(cursor(), "↓ moved the list cursor behind the open reader").toBe("m1");
    const col = host!.querySelector<HTMLElement>(".read-col")!;
    expect(col.scrollTop, "↓ scrolled the column standing behind the sheet").toBe(0);

    await key("ArrowLeft");
    expect((focused() as HTMLElement | null)?.closest?.(".rail"),
      "← reached the rail behind the open reader").toBeFalsy();
    expect((focused() as HTMLElement | null)?.matches?.(".row"),
      "← landed focus on a list row behind the open reader").toBeFalsy();

    // Focus INSIDE the sheet scrolls it exactly the same — one zone, however it was entered.
    await act(async () => { sheet.focus(); });
    await key("ArrowDown");
    expect(sheet.scrollTop).toBe(2 * READER_SCROLL_STEP);

    // Closing the sheet fires NO focus event — a removed node blurs silently — so the store
    // re-derives on the next React commit (the hook's every-commit refresh). The letters are
    // zone-independent view bindings, so `j` both proves the list never lost its own keys
    // and IS that commit; the arrows answer again right after it.
    sheet.remove();
    await key("j");
    expect(cursor(), "the letter walk stopped working around the reader").toBe("m2");
    await key("ArrowDown");
    expect(cursor(), "the walk did not resume when the reader closed").toBe("m3");
  });

  it("a field buried UNDER the sheet does not silence it; a field INSIDE it does", async () => {
    // A review finding: a keyboard search opens a hit in place while the search box keeps
    // focus — the typing target is buried under the sheet, and a scroll pair that defers to
    // every typing target left the visible reader unscrollable. The pair claims ↑/↓ exactly
    // when the field is under the sheet, and yields to a field inside it (an editor in the
    // open message keeps its native caret).
    setViewport();
    await render(FIVE);
    const buried = document.createElement("input");
    host!.appendChild(buried);
    const sheet = document.createElement("div");
    sheet.className = "reader";
    document.body.appendChild(sheet);
    await act(async () => { buried.focus(); });

    const { READER_SCROLL_STEP } = await import("../app/shell/zone-nav.js");
    await key("ArrowDown", buried);
    expect(sheet.scrollTop, "↓ from a field buried under the sheet did not scroll the sheet")
      .toBe(READER_SCROLL_STEP);
    expect(focused(), "the buried field lost focus").toBe(buried);

    const inside = document.createElement("input");
    sheet.appendChild(inside);
    await act(async () => { inside.focus(); });
    await key("ArrowDown", inside);
    expect(sheet.scrollTop, "↓ inside the sheet's own editor must stay the caret's")
      .toBe(READER_SCROLL_STEP);

    inside.remove(); buried.remove(); sheet.remove();
    await key("j");
  });

  it("a dialog layered above the sheet owns its own arrows — the walk stands down whole", async () => {
    // A review finding: a screening panel over the open reader focuses its own controls;
    // the sheet must not swallow ↑/↓ and scroll itself, obscured, underneath. Document order
    // is the layering truth — the shell renders every higher surface AFTER the reader — so
    // focus in a node the sheet precedes suspends every zone key.
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");
    const sheet = document.createElement("div");
    sheet.className = "reader";
    document.body.appendChild(sheet);
    const panel = document.createElement("div");
    panel.className = "sa";
    panel.setAttribute("role", "dialog"); // every genuine higher surface carries the role
    panel.innerHTML = '<button type="button">close</button>';
    document.body.appendChild(panel); // AFTER the sheet — layered above, as the shell renders
    await act(async () => { panel.querySelector("button")!.focus(); });

    await key("ArrowDown");
    expect(sheet.scrollTop, "↓ scrolled the sheet obscured under a higher dialog").toBe(0);
    expect(cursor(), "↓ walked the list buried under two layers").toBe("m1");
    await key("ArrowLeft");
    expect((focused() as HTMLElement | null)?.closest?.(".rail"),
      "← left a dialog for the rail behind everything").toBeFalsy();

    panel.remove(); sheet.remove();
    await key("j");
  });

  it("an invisible follower that is NOT a layer cannot silence the reader", async () => {
    // A review finding: the expired Undo toast keeps a focusable button mounted after the
    // whole shell, at opacity 0 (`role="status"` — undo-window.test.ts measured it live for
    // 20 minutes). Tab landing on it while the reader stands must leave the reader's keys
    // working: a follower suspends the walk only when it IS a layer — a dialog or menu, by
    // role — never merely because it comes later in the document.
    setViewport();
    await render(FIVE);
    const sheet = document.createElement("div");
    sheet.className = "reader";
    document.body.appendChild(sheet);
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.innerHTML = '<button type="button" class="toast-act">Undo</button>';
    document.body.appendChild(toast); // after the sheet, exactly as ToastHost renders
    await act(async () => { toast.querySelector("button")!.focus(); });

    const { READER_SCROLL_STEP } = await import("../app/shell/zone-nav.js");
    await key("ArrowDown", toast.querySelector("button")!);
    expect(sheet.scrollTop, "an invisible toast button silenced the visible reader")
      .toBe(READER_SCROLL_STEP);

    toast.remove(); sheet.remove();
    await key("j");
  });

  it("← keeps out of a closed mobile drawer, and enters an open one", async () => {
    // A review finding: the drawer is off-canvas by TRANSFORM, not display:none, so the
    // focus-refusal guard cannot fire — a translated button accepts focus() happily. The
    // drawer question (below 1024) plus the drawer's own `.open` flag gate the entry instead.
    setViewport(true);
    await render(FIVE);
    await key("ArrowLeft");
    expect((focused() as HTMLElement | null)?.closest?.(".rail"),
      "← put focus into a closed off-canvas drawer").toBeFalsy();

    rail!.classList.add("open");
    await key("ArrowLeft");
    expect((focused() as HTMLElement | null)?.closest?.(".rail"),
      "← refused an OPEN drawer").toBeTruthy();
  });

  it("focus crossing rail, list and reader re-renders neither the view nor a shell reading the registry", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    expect(shellKey, "fixture: the shell reads a live view key").not.toBeNull();
    const row = host!.querySelector<HTMLElement>(".row.sel")!;
    const col = host!.querySelector<HTMLElement>(".read-col")!;
    const items = [...rail!.querySelectorAll<HTMLElement>("button")];
    const { READER_SCROLL_STEP } = await import("../app/shell/zone-nav.js");
    viewRenders = 0;

    await act(async () => { items[0]!.focus(); });
    await key("ArrowDown");
    expect(focused(), "the rail keys did not follow a focus the view never rendered for").toBe(items[1]);
    await act(async () => { row.focus(); });
    await act(async () => { col.focus(); });
    await act(async () => { row.focus(); });
    await act(async () => { col.focus(); });
    expect(viewRenders, "a focus move re-rendered the whole view").toBe(0);
    await key("ArrowDown");
    expect(col.scrollTop, "the reader keys did not follow").toBe(READER_SCROLL_STEP);
    expect(cursor()).toBe("m1");
  });

  it("every zone key is inert while a text field owns focus", async () => {
    setViewport();
    await render(FIVE);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(focused()).toBe(input);

    await key("ArrowLeft", input);
    expect(focused(), "← stole focus from a text field").toBe(input);
    await key("ArrowDown", input);
    expect(cursor(), "↓ moved the list cursor from inside a text field").toBeNull();
    await key("Escape", input);
    expect(focused(), "Escape moved focus out of a text field").toBe(input);
    input.remove();
  });
});
