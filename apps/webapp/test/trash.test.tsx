/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import { Frame } from "@ohmail/app/frame";
import { MailGround, mailPlaces } from "@ohmail/app/mail";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import type { TrashPage } from "@ohmail/app-logic/lists/trash-page";
import { cleanup, fireEvent, getAllByRole, render, screen, within } from "@testing-library/react";
import { keySheetOver } from "../../../packages/app/src/keys/sheet/index.js";
import { LIST_WORDS, listFrame } from "../../../packages/app/test/places/list-seat.js";
import en from "../messages/en.json";
import de from "../messages/de.json";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  cleanup();
  if (root) await act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  window.localStorage.clear();
});

describe("the transient rail entry and the two chords", () => {
  it("the `?` sheet prints the reason on an INERT row and nowhere else", async () => {
    async function openSheet(first: "#/ohbox" | "#/trash", available: boolean) {
      const { host } = listFrame({
        first,
        letters: [],
        engine: () => ({
          trashAvailable: () => available,
          listTrash: async () => ({ state: "ready", items: [], nextCursor: null }),
        }),
      });
      const page = render(
        <TextProvider locale="en" messages={{ ...LIST_WORDS, shortcuts: en.shortcuts, trash: en.trash }} timeZone="UTC">
          <Frame host={{ ...host, features: { ...host.features, overs: { ...host.features.overs, keys: keySheetOver } } }} />
        </TextProvider>,
      );
      fireEvent.keyDown(document.body, { key: "?" });
      return { sheet: within(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })), unmount: page.unmount };
    }

    const unavailable = await openSheet("#/ohbox", false);
    const destination = unavailable.sheet.getByText(en.shortcuts.goTrash).closest("p")!;
    expect(destination.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.sheet.getAllByTitle(en.trash.unavailable)).toEqual([destination]);
    expect(unavailable.sheet.queryByTitle(en.trash.noErase)).toBeNull();
    unavailable.unmount();

    const available = await openSheet("#/ohbox", true);
    const active = available.sheet.getByText(en.shortcuts.goTrash).closest("p")!;
    expect(active.hasAttribute("aria-disabled")).toBe(false);
    expect(active.hasAttribute("title")).toBe(false);
    expect(available.sheet.queryByTitle(en.trash.unavailable)).toBeNull();
    available.unmount();

    const inTrash = await openSheet("#/trash", true);
    const deleteRow = inTrash.sheet.getByText(en.shortcuts.deleteKey).closest("p")!;
    expect(deleteRow.getAttribute("aria-disabled")).toBe("true");
    expect(inTrash.sheet.getAllByTitle(en.trash.noErase)).toEqual([deleteRow]);
    expect(inTrash.sheet.queryByTitle(en.trash.unavailable)).toBeNull();
  });
});

// ── the view ────────────────────────────────────────────────────────────────────────────────

function page(over: Partial<TrashPage> = {}): TrashPage {
  return {
    available: true, items: [], loading: false, error: null, exhausted: true,
    loadMore: () => {}, ...over,
  } as TrashPage;
}

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { address: "s@x.example", name: "Sender" }, to: [], cc: [],
    date: "2026-01-01T00:00:00.000Z", folder: "Trash", snippet: "snip", unread: false,
    lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: {}, triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-09T10:00:00.000Z",
    trashedAt: "2026-09-09T09:00:00.000Z", restoreTo: "ohmail/News",
    ...over,
  };
}

async function mount(p: TrashPage, catalogue: typeof en = en, locale: "en" | "de" = "en") {
  const store = new MemoryMirrorStore();
  await store.load();
  const adapter: EngineAdapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: "2026-09-09T11:00:00.000Z",
    }),
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" }),
    fetchBody: async () => null,
  };
  const engine = new OhmailEngine({
    store,
    adapter: Object.assign(adapter, {
      listTrash: async () => ({ items: p.items, nextCursor: null }),
      restoreFromTrash: async () => ({ restoreTo: "INBOX", pending: false }),
    }),
  });
  const { host: supplies } = fakeHost({
    engine, service: "self", scope: "account-trash", places: mailPlaces(), above: MailGround,
    address: fakeAddress("#/trash"), window: fakeWindow("desktop"),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(TextProvider, {
      locale, messages: catalogue as unknown as Messages, timeZone: "UTC",
      children: h(Frame, { host: supplies }),
    }));
  });
  return host;
}

describe("the Trash view", () => {
  it("carries the SCOPE sentence whether or not there are rows", async () => {
    // Keep the registered case name. The empty scope copy now consists of the title alone.
    const empty = await mount(page({ exhausted: true }));
    expect(empty.textContent).toContain(en.trash.emptyTitle);
    expect(empty.textContent).not.toContain(en.trash.foot);
    if (root) await act(() => root!.unmount());
    root = null; host?.remove(); host = null;
    const full = await mount(page({ items: [row("m1")] as never }));
    expect(full.textContent).toContain(en.trash.foot);
  });

  it("glosses a USER folder by its leaf, and an absent restoreTo as the inbox", async () => {
    const el = await mount(page({
      items: [row("m1", { restoreTo: "Archive/2026/Q1" }), row("m2", { restoreTo: undefined })] as never,
    }));
    const glosses = getAllByRole(el, "option")
      .map((row) => within(row).queryByText(/^← /)?.textContent);
    expect(glosses).toEqual(["← Q1", "← Ohbox"]);
  });

  it("renders in GERMAN from the same keys", async () => {
    const el = await mount(page({ exhausted: true }), de as unknown as typeof en, "de");
    expect(el.textContent).toContain(de.trash.emptyTitle);
    expect(el.textContent).not.toContain(de.trash.foot);
  });
});

describe("useTrashPage — a delete that lands while Trash is open", () => {
  it("is read in at the top without leaving the view; nothing is read while away", async () => {
    const { useTrashPage } = await import("@ohmail/app-logic/lists/trash-page");
    const listTrash = vi.fn()
      .mockResolvedValueOnce({ state: "ready", items: [row("m1")], nextCursor: null })
      .mockResolvedValue({ state: "ready", items: [row("m2"), row("m1")], nextCursor: null });
    const engine = { trashAvailable: () => true, listTrash, onMessagesRemoved: () => () => {} } as never;
    let shown: string[] = [];
    function Probe({ active, landed }: { active: boolean; landed: number }): null {
      shown = useTrashPage(engine, active, new Set(), landed).items.map((r) => r.id);
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(Probe, { active: true, landed: 0 })); });
    expect(shown).toEqual(["m1"]);
    await act(async () => { root!.render(h(Probe, { active: true, landed: 1 })); });
    expect(listTrash).toHaveBeenCalledTimes(2);
    expect(shown).toEqual(["m2", "m1"]);
    await act(async () => { root!.render(h(Probe, { active: false, landed: 1 })); });
    await act(async () => { root!.render(h(Probe, { active: false, landed: 2 })); });
    expect(listTrash, "a delete away from Trash is read by the next visit").toHaveBeenCalledTimes(2);
  });
});
