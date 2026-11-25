/** @vitest-environment jsdom */
import * as React from "react";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame";
import { DesktopLocale } from "../src/DesktopLocale";
import { linkSlot } from "../src/link-in";

const ISO = "2026-11-25T08:00:00.000Z";
const noChange = () => undefined;

vi.mock("../src/local-mailbox-facts", async () => ({
  ...await vi.importActual<typeof import("../src/local-mailbox-facts")>("../src/local-mailbox-facts"),
  readMailboxFacts: async () => [{
    id: "mailbox", address: "writer@example.invalid", status: "connected",
    lastSyncAt: ISO, createdAt: ISO, organizerRole: "organizer", organizeConsentedAt: ISO,
    errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, organizedBy: null,
  }],
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
  localStorage.clear();
  window.location.hash = "#/ohbox";
  vi.stubGlobal("matchMedia", (media: string) => ({
    media, matches: false, addEventListener: noChange, removeEventListener: noChange,
    addListener: noChange, removeListener: noChange,
  }));
  vi.stubGlobal("IntersectionObserver", class {
    observe = noChange;
    unobserve = noChange;
    disconnect = noChange;
  });
  Element.prototype.scrollIntoView ??= noChange;
  Element.prototype.scrollTo ??= noChange;
  Element.prototype.animate ??= (() => ({ cancel: noChange, finished: Promise.resolve() })) as unknown as Element["animate"];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function paste(editor: HTMLElement, text: string) {
  editor.focus();
  fireEvent.paste(editor, { clipboardData: { types: ["text/plain"], getData: (kind: string) => kind === "text/plain" ? text : "" } });
}

async function mountDesktop(engine: OhmailEngine, scope: string): Promise<void> {
  const props: DesktopFrameProps = {
    engine, status: { state: "serving", mode: "local" }, session: "live", sessionRefused: false,
    sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null, storage: null,
    mayLinkOut: false, manageOffered: false, withdrawManage: noChange, rereadAccess: noChange,
    reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: noChange, onStatus: noChange,
    openOverlay: noChange, takeOver: noChange, firstRunOpen: false, firstRun: undefined, takesMailLinks: true,
    scope, onUnread: noChange,
    liveBody: async () => ({ kind: "loaded", text: "Original", html: null }),
    links: linkSlot(), connection: { read: () => null, subscribe: () => noChange },
  };
  await act(async () => void render(
    <DesktopLocale><ThemeProvider><ToastHost>
      <DesktopFrame {...props} />
    </ToastHost></ThemeProvider></DesktopLocale>,
  ));
}

it("Escape keeps the desktop composer's last words in one draft before leaving", async () => {
  const store = new MemoryMirrorStore();
  await store.load();
  let answer!: () => void;
  const firstAnswer = new Promise<void>((resolve) => { answer = resolve; });
  let finish!: () => void;
  const secondAnswer = new Promise<void>((resolve) => { finish = resolve; });
  let last!: () => void;
  const lastAnswer = new Promise<void>((resolve) => { last = resolve; });
  let writes = 0;
  let seq = 0;
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: ISO }),
      fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      withdrawSend: async () => ({ outcome: "unreachable" }),
      mutate: async (mutation) => {
        writes += 1;
        if (writes === 1) await firstAnswer;
        if (writes === 2) await secondAnswer;
        if (writes === 3) await lastAnswer;
        const changes = mutationEffects(store, mutation, { now: () => new Date(ISO), uuid: () => `letter-${writes}` })
          .map((effect) => ({ type: effect.type, op: "update", id: effect.id, entity: effect.entity, seq: ++seq, updatedAt: ISO })) as SyncChange[];
        return { changes, seq, ...(mutation.kind === "draft_save" && mutation.draftId === null ? { entityId: changes[0]!.id } : {}) };
      },
    },
  });
  await mountDesktop(engine, "desktop-draft-close");
  await act(async () => { window.location.hash = "#/compose"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  const subject = "The letter I was writing";
  const body = "The first words. The last words too.";
  const editor = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: subject } });
  await act(async () => paste(editor, "The first words."));
  try {
    await act(async () => { fireEvent.keyDown(editor, { key: "Escape" }); });
    expect(writes).toBe(1);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    await act(async () => paste(editor, " The last"));
    await act(async () => { answer(); });
    expect(writes).toBe(2);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    await act(async () => paste(editor, " words too."));
    await act(async () => { finish(); });
    await waitFor(() => expect(writes).toBe(3));
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
  } finally {
    await act(async () => { answer(); finish(); last(); });
  }
  expect(window.location.hash).toBe("#/ohbox");
  expect(writes).toBe(3);
  await act(async () => { window.location.hash = "#/drafts"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  const draft = screen.getByRole("option", { name: new RegExp(subject) });
  fireEvent.click(draft);
  expect((await screen.findByRole("textbox", { name: "Message" })).textContent).toBe(body);
}, 15_000);
