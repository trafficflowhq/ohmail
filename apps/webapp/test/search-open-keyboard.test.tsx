/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";
import { ShortcutSheet } from "../app/shell/ShortcutSheet";

/**
 * OPENING A SEARCH RESULT FROM THE KEYBOARD — the half of that fix nothing was watching.
 *
 * `SearchView` declares four bindings (Escape, ↑, ↓, ↵) and opens `shown[cursor]`. Two of the
 * four were already guarded when this file was written — ↓ by `search-similar.test.tsx` ("the
 * keyboard cursor walks INTO the Similar rows") and Escape by `search-escape.test.tsx` — and
 * ↵, the binding the whole report was about, was guarded by NOTHING: a grep for `key: "Enter"`
 * across every search test in this directory returned no line. So the one keystroke a person
 * pressed and got nothing from could have been deleted, or re-gated on the empty-result
 * condition it used to carry, and every suite would have stayed green.
 *
 * Three properties, and the second is the one that makes the first worth having:
 *
 *   1. ↵ opens a result.
 *   2. It opens the one UNDER THE CURSOR, not the first row. Without this, ↑/↓ are decoration
 *      and the test above them measures a highlight nobody can act on.
 *   3. It opens on a NON-EMPTY result — which is the exact inverse of the gate the reported
 *      build carried (`items.length === 0`, i.e. ↵ reached the archive re-ask and never the
 *      open). Re-introducing that gate has to redden something, and this is the something.
 *
 * The expectations read the RENDERED row order (`data-hit`) rather than assuming which message
 * the index ranks first: the assertion is "↵ opened the row wearing `aria-current`", which is
 * the claim the reader can check, and it stays true if the ranking changes.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string, from = "someone@example.test"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: from },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

function baseAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

async function engineWith(rows: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({ adapter: baseAdapter(), store, now: () => NOW });
}

let host: HTMLDivElement;
let root: Root;
/** Every message id `onOpen` was called with, in order. */
let opened: string[];

beforeEach(() => {
  window.localStorage.clear();
  opened = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/**
 * The view with the query held ABOVE it, the way the shell holds it — so Escape's `onQuery("")`
 * really empties the box instead of being swallowed by a spy. `sheet` mounts the `?` overlay
 * beside the view so the generated rows can be read without standing up the whole shell.
 */
function Harness({ engine, initial, sheet }: { engine: OhmailEngine; initial: string; sheet: boolean }) {
  const [query, setQuery] = React.useState(initial);
  return h(KeymapProvider, {
    children: [
      h(SearchView, {
        key: "view",
        engine, version: 1, now: NOW, query,
        onQuery: setQuery,
        onOpen: (hit) => { opened.push(hit.message.id); },
      }),
      sheet ? h(ShortcutSheet, { key: "sheet", open: true, onClose: () => {} }) : null,
    ],
  });
}

async function render(engine: OhmailEngine, query: string, sheet = false): Promise<void> {
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(Harness, { engine, initial: query, sheet }),
      }),
    );
  });
  /* Past the archive debounce, so a settled screen is what the keys are pressed against. This
     fixture's adapter offers no archive at all, which is the desktop's and the demo's state —
     the merge is the local arm alone and the row order is the index's own. */
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

/** The rendered rows, in screen order. */
const hits = (): string[] =>
  [...host.querySelectorAll("[data-hit]")].map((el) => el.getAttribute("data-hit") ?? "");
/** The row wearing the cursor, or null. */
const focused = (): string | null =>
  host.querySelector('[data-hit][aria-current="true"]')?.getAttribute("data-hit") ?? null;
const box = (): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(".view-search .search-box input");

/** Three subjects that all answer "invoice", so the exact tier holds more than one row. */
const CORPUS = [
  msg("inv-a", "Invoice 078 for the workshop", "billing@erdton.example"),
  msg("inv-b", "Invoice 079 for the kiln", "billing@erdton.example"),
  msg("inv-c", "Invoice 080 and the glaze order", "anna@lichtgrat.example"),
];

describe("a search result opens from the keyboard", () => {
  it("↵ opens a result: the cursor's row reaches `onOpen`", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "invoice");

    expect(hits().length, "the fixture must answer with rows for this to mean anything").toBeGreaterThan(1);
    // The cursor starts at the top, and that is the row ↵ is about.
    expect(focused()).toBe(hits()[0]);
    await key("Enter");
    expect(opened).toEqual([hits()[0]]);
  });

  it("…and it opens THE ROW UNDER THE CURSOR, never the first one", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "invoice");

    const rows = hits();
    expect(rows.length, "three rows are needed to tell 'the cursor' from 'the first row'").toBeGreaterThan(2);
    await key("ArrowDown");
    await key("ArrowDown");
    expect(focused()).toBe(rows[2]);

    await key("Enter");
    expect(opened).toEqual([rows[2]]);
    // The discriminator, spelled out: what was opened is NOT the top row.
    expect(opened[0]).not.toBe(rows[0]);
  });

  it("↑ walks back, and ↵ follows it", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "invoice");

    const rows = hits();
    await key("ArrowDown");
    await key("ArrowDown");
    await key("ArrowUp");
    expect(focused()).toBe(rows[1]);
    await key("Enter");
    expect(opened).toEqual([rows[1]]);
  });

  it("↵ OPENS ON A NON-EMPTY RESULT — the reported build's gate was the inverse of this", async () => {
    /* The gate that was reported is `items.length === 0`: ↵ fired only when nothing had been
       found, so on a screen full of answers the key did nothing. This case is the one that
       goes red if that condition comes back, whatever else stays green. */
    const engine = await engineWith(CORPUS);
    await render(engine, "invoice");

    expect(hits().length).toBeGreaterThan(0);
    await key("Enter");
    expect(opened.length, "↵ on a non-empty result must open exactly one message").toBe(1);
  });

  it("with nothing found there is nothing to open, and ↵ opens nothing", async () => {
    /* The other side of the same rule — a binding listed because it exists and inert because
       there is nothing to act on. Without this case, "↵ always opens something" would pass a
       build that opened a stale row after the query moved on. */
    const engine = await engineWith(CORPUS);
    await render(engine, "kiln-glaze-nothing-answers-this");

    expect(hits()).toEqual([]);
    expect(focused()).toBeNull();
    await key("Enter");
    expect(opened).toEqual([]);
  });

  it("a result listed late above the cursor leaves the cursor, and ↵, on the row it was on", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const put = (rows: EngineMessage[]) => store.applyChanges(rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })));
    await put(CORPUS);
    const engine = new OhmailEngine({ adapter: baseAdapter(), store, now: () => NOW });
    const draw = (version: number) => act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider, { children: h(SearchView, {
          engine, version, now: NOW, query: "invoice", onQuery: () => {},
          onOpen: (hit) => { opened.push(hit.message.id); },
        }) }),
      }));
    });
    await draw(1);
    const rows = hits();
    await key("ArrowDown");
    expect(focused()).toBe(rows[1]);
    await put([{ ...msg("inv-0", "Invoice 081 for the invoice run, invoice attached", "billing@erdton.example"), date: "2026-08-04T09:00:00.000Z" }]);
    await draw(2);
    expect(hits().indexOf("inv-0"), `listed above the cursor: ${hits().join(",")}`).toBeLessThan(hits().indexOf(rows[1]!));
    expect(focused()).toBe(rows[1]);
    await key("Enter");
    expect(opened).toEqual([rows[1]]);
  });

  it("Escape clears the question and leaves the caret in the box, ready for the next one", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "invoice");

    // Focus starts in the box (`autoFocus`), and a hit press is what moves it away. The row is no
    // longer one button: `data-hit` wraps a `<div class="hit">` whose focusable control is the
    // `<button class="hit-open">` around the subject.
    const first = host.querySelector<HTMLElement>("[data-hit] button.hit-open");
    expect(first, "the result row exposes no focusable control").toBeTruthy();
    await act(async () => { first!.focus(); });
    expect(document.activeElement).not.toBe(box());

    await key("Escape");
    expect(box()!.value).toBe("");
    /* THE CARET COMES BACK, and this is the part a `onQuery("")` alone does not do: the row
       that had focus is removed with the results, and focus would otherwise fall to `body` —
       a screen with a search box on it and no keyboard in anything. */
    expect(document.activeElement).toBe(box());
  });

  it("the `?` sheet lists the three keys while Search is the view — from the registry, not a list", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "invoice", true);

    const rows = [...host.querySelectorAll(".ks li")].map((li) => ({
      label: li.querySelector(".ks-lab")?.textContent ?? "",
      caps: [...li.querySelectorAll("kbd")].map((k) => k.textContent ?? "").join(""),
    }));
    const capsFor = (label: string): string | undefined => rows.find((r) => r.label === label)?.caps;

    expect(capsFor(messages.search.keyOpen), "the sheet does not list opening a result").toBe("↵");
    expect(capsFor(messages.search.keyNext)).toBe("↓");
    expect(capsFor(messages.search.keyPrev)).toBe("↑");
    expect(capsFor(messages.search.keyClose)).toBe("esc");
  });
});
