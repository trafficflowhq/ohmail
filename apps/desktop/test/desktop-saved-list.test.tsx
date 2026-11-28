/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopGate } from "../src/DesktopGate.js";
import { engineLogout } from "../src/bridge-fetch.js";
import { LONG_PHASE_MS } from "../src/BootStatus.js";
import { DesktopLocale } from "../src/DesktopLocale.js";

const key = "ohmail.boot.desktop-list.window";
const preview = {
  door: "same-door",
  scope: "mailbox",
  groups: [{ label: "New", rows: [{
    id: "last-letter", who: "Fixture Sender", subject: "Meeting notes",
    preview: "Bring the agenda.", when: "09:15",
  }] }],
  anchor: { id: "last-letter", offset: 0 },
};

let root: Root | undefined;
let view: HTMLElement;
let status: Record<string, unknown>;
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false, media, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = { state: "starting", mode: "local", startupListKey: "same-door" };
  invoke = vi.fn(async (command: string) => command === "engine_status" ? status : null);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke, transformCallback: () => 1 });
  localStorage.setItem(key, JSON.stringify(preview));
  view = document.body.appendChild(document.createElement("div"));
  root = createRoot(view);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  view.remove();
  localStorage.clear();
  window.location.hash = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function show() {
  await act(async () => {
    root?.render(<DesktopLocale><ThemeProvider><ToastHost><DesktopGate /></ToastHost></ThemeProvider></DesktopLocale>);
  });
}

async function poll() {
  await act(async () => vi.advanceTimersByTimeAsync(50));
}

it("shows kept rows without sending a row press to an engine that is still opening", async () => {
  await show();
  const row = view.querySelector<HTMLElement>("[data-saved-row] [role=option]");
  expect(row?.textContent).toContain("Meeting notes");
  const before = invoke.mock.calls.length;
  await act(async () => row?.click());
  expect(invoke.mock.calls.slice(before).some(([command]) => command === "engine_request")).toBe(false);
  expect(window.location.hash).toBe("");
});

it("withholds counts until the live list can report them", async () => {
  await show();
  expect(view.textContent).toContain("Meeting notes");
  expect(view.querySelector("[data-saved-list] .oh-groupheading-count")).toBeNull();
  expect(view.querySelector("[aria-setsize]")).toBeNull();
});

it.each(["not_configured", "no_key"])("drops the kept list when the shell reports %s", async (state) => {
  await show();
  status = { state };
  await poll();
  expect(localStorage.getItem(key)).toBeNull();
  expect(view.textContent).not.toContain("Meeting notes");
});

it("does not display rows from a different configured account", async () => {
  status = { ...status, startupListKey: "other-door" };
  await show();
  expect(view.textContent).not.toContain("Meeting notes");
});

it("removes the saved list on the sign-out press before the native answer", async () => {
  await show();
  let release: () => void = () => undefined;
  invoke.mockImplementation((command: string) => command === "engine_logout"
    ? new Promise((resolve) => { release = () => resolve({ state: "not_configured" }); })
    : Promise.resolve(null));
  const signedOut = engineLogout();
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(localStorage.getItem(key)).toBeNull();
  release();
  await signedOut;
});

it("does not show a saved list behind a known account lock", async () => {
  status = { ...status, mode: "cloud" };
  localStorage.setItem(key, JSON.stringify({ ...preview, wall: "mailbox" }));
  localStorage.setItem("ohmail.access.mailbox", "closed");
  await show();
  expect(view.textContent).not.toContain("Meeting notes");
});

function frame(body: unknown): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status: 200, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(4 + meta.length + payload.length);
  new DataView(out.buffer).setUint32(0, meta.length);
  out.set(meta, 4);
  out.set(payload, 4 + meta.length);
  return out;
}

function changes(id: string, subject: string, age: number, threadId: string | null = null) {
  const date = new Date(Date.now() - age).toISOString();
  const address = `${id}@example.invalid`;
  return [
    { type: "message", op: "create", id, seq: 5, updatedAt: date,
      entity: { id, accountId: "account", mailboxId: "mailbox", threadId, messageIdHeader: null,
        subject, from: { name: "Fixture Sender", address }, to: [], cc: [], date, folder: "INBOX",
        snippet: "", unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
        labels: [], remoteContent: "none", updatedAt: date } },
    { type: "rule", op: "create", id: `rule-${id}`, seq: 5, updatedAt: date,
      entity: { id: `rule-${id}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
        provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
        createdAt: date, updatedAt: date } },
  ];
}

function pages(threadId: string | null = null) {
  const id = "anchor-letter";
  const recent = changes("recent-letter", "Mail above the saved viewport", 0, threadId);
  const saved = changes(id, "Current subject at the saved position", 1000, threadId);
  let sendTail: (() => void) | undefined;
  invoke.mockImplementation(async (command: string, payload?: { url?: string }) => {
    if (command === "engine_status") return status;
    if (command !== "engine_request") return null;
    const url = new URL(payload?.url ?? "/", "http://localhost");
    if (url.pathname === "/mailboxes") {
      return frame({ items: [{ id: "mailbox", address: "mailbox@example.invalid", status: "connected",
        lastSyncAt: new Date().toISOString(), initialImportCompletedAt: new Date().toISOString() }] });
    }
    if (url.pathname === "/sync/snapshot") {
      const page = (changes: unknown, nextCursor: string | null) => frame({
        asOfSeq: 5, changes, nextCursor, window: { days: 90, minRows: 500 },
      });
      return url.searchParams.has("cursor")
        ? new Promise((resolve) => { sendTail = () => resolve(page(saved, null)); })
        : page(recent, "next-page");
    }
    return frame({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "NQ", hasMore: false,
      serverTime: new Date().toISOString() });
  });
  return {
    id,
    async serving() {
      status = { ...status, state: "serving", mailboxId: "mailbox", credentialState: "ready" };
      await poll();
      await vi.waitFor(() => expect(sendTail).toBeTypeOf("function"));
    },
    async finish() { await act(async () => sendTail?.()); },
  };
}

it("keeps the saved viewport and its pending press while the anchor's page is loading", async () => {
  const wire = pages();
  const row = { ...preview.groups[0]!.rows[0]!, id: wire.id };
  localStorage.setItem(key, JSON.stringify({ ...preview, groups: [{ label: "New", rows: [row] }],
    anchor: { id: wire.id, offset: -18 } }));
  await show();
  const option = view.querySelector<HTMLElement>("[data-saved-row] [role=option]");
  expect(option?.textContent).toContain("Meeting notes");
  await act(async () => option?.click());
  await wire.serving();
  expect(view.querySelector("[data-saved-list]")?.textContent).toContain("Meeting notes");
  expect(window.location.hash).not.toContain(wire.id);
  await wire.finish();
  await vi.waitFor(() => expect(view.querySelector("[data-saved-list]")).toBeNull());
  await vi.waitFor(() => expect(window.location.hash).toContain(wire.id));
});

it("restores a surviving neighbor's offset when the saved anchor was deleted", async () => {
  const wire = pages();
  const row = { ...preview.groups[0]!.rows[0]!, id: wire.id, offset: -7 };
  localStorage.setItem(key, JSON.stringify({ ...preview,
    groups: [{ label: "New", rows: [...preview.groups[0]!.rows, row] }],
    anchor: { id: "last-letter", offset: -18 } }));
  await show();
  await wire.serving();
  await wire.finish();
  await vi.waitFor(() => expect(view.textContent).toContain("Current subject at the saved position"));
  expect(view.querySelector("[data-saved-list]")).toBeNull();
  expect(view.querySelector(".ob-scroll")?.scrollTop).toBe(7);
});
it("does not state a group count while the engine still owes a snapshot page", async () => {
  const wire = pages();
  const kept = { ...preview.groups[0]!.rows[0]!, id: "recent-letter" };
  localStorage.setItem(key, JSON.stringify({ ...preview,
    groups: [{ label: "New", rows: [kept] }], atTop: true,
    anchor: { id: kept.id, offset: 0 } }));
  await show();
  expect(view.querySelector(".oh-groupheading-count")).toBeNull();
  await wire.serving();
  const countBeforeTail = view.querySelector(".oh-groupheading-count")?.textContent ?? null;
  expect(view.querySelector("[aria-setsize]")).toBeNull();
  await wire.finish();
  await vi.waitFor(() => expect(view.textContent).toContain("Current subject at the saved position"));
  expect(view.querySelector(".oh-groupheading-count")?.textContent).toBe("2");
  expect(countBeforeTail).toBeNull();
});

it("opens the live conversation when a new reply replaces the kept row target", async () => {
  const wire = pages("one-conversation");
  const kept = { ...preview.groups[0]!.rows[0]!, id: wire.id };
  localStorage.setItem(key, JSON.stringify({ ...preview,
    groups: [{ label: "New", rows: [kept] }], atTop: true,
    anchor: { id: kept.id, offset: 0 } }));
  await show();
  const row = view.querySelector<HTMLElement>("[data-saved-row] [role=option]");
  expect(row?.textContent).toContain("Meeting notes");
  await act(async () => row?.click());
  expect(window.location.hash).toBe("");
  await wire.serving();
  await wire.finish();
  await vi.waitFor(() => expect(view.querySelector("[data-saved-list]")).toBeNull());
  expect(view.querySelectorAll(".oh-row[data-id]")).toHaveLength(1);
  expect(view.querySelector(".oh-row[data-id]")?.getAttribute("data-id")).toBe("recent-letter");
  expect(window.location.hash).toContain("recent-letter");
});

it("keeps the saved row on screen until the live scroll position is restored", async () => {
  const wire = pages();
  const kept = { ...preview.groups[0]!.rows[0]!, id: wire.id };
  localStorage.setItem(key, JSON.stringify({ ...preview,
    groups: [{ label: "New", rows: [kept] }],
    anchor: { id: kept.id, offset: -18 } }));
  await show();
  await wire.serving();
  const scroller = view.querySelector<HTMLElement>(".ob-list:not([data-saved-list]) > .ob-scroll")!;
  let top = 0;
  const positioning: boolean[] = [];
  Object.defineProperty(scroller, "scrollTop", {
    get: () => top,
    set: (next: number) => {
      if (next === 18) positioning.push(view.querySelector("[data-saved-list]") !== null);
      top = next;
    },
  });
  await wire.finish();
  await vi.waitFor(() => expect(view.querySelector("[data-saved-list]")).toBeNull());
  expect(positioning).toEqual([true]);
  expect(scroller.scrollTop).toBe(18);
  expect(scroller.querySelector('.oh-row[data-id="anchor-letter"]')).not.toBeNull();
});

it("keeps an unscrolled saved list at the top when newer mail arrives", async () => {
  const wire = pages();
  const kept = { ...preview.groups[0]!.rows[0]!, id: wire.id };
  localStorage.setItem(key, JSON.stringify({ ...preview,
    groups: [{ label: "New", rows: [kept] }], atTop: true,
    anchor: { id: kept.id, offset: 36 } }));
  await show();
  await wire.serving();
  await wire.finish();
  await vi.waitFor(() => expect(view.querySelector("[data-saved-list]")).toBeNull());
  const scroller = view.querySelector(".ob-list > .ob-scroll");
  expect(scroller?.scrollTop).toBe(0);
  expect(scroller?.querySelector(".oh-row[data-id]")?.getAttribute("data-id")).toBe("recent-letter");
});

it.each([1280, 760, 540])("keeps the upgrade progress visible with saved rows at %ipx", async (width) => {
  vi.stubGlobal("innerWidth", width);
  status = { ...status, bootPhase: "migrating", bootApplied: 1, bootPending: 3 };
  await show();
  const message = () => view.querySelector(".gate-boot [role=status]")?.textContent ?? "";
  expect(view.querySelector("[data-saved-list]")?.textContent).toContain("Meeting notes");
  expect(message()).toContain("Updating your local mail store… (1 of 3)");
  expect(message()).not.toContain("several minutes");

  await act(async () => vi.advanceTimersByTimeAsync(LONG_PHASE_MS));
  expect(view.querySelector("[data-saved-list]")?.textContent).toContain("Meeting notes");
  expect(message()).toContain("Updating your local mail store… (1 of 3)");
  expect(message()).toContain("This can take several minutes on a large mailbox.");
  expect(view.querySelectorAll(".gate-boot [role=status]")).toHaveLength(1);
});
