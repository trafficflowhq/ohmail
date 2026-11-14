/** @vitest-environment jsdom */
import { cleanup, renderHook, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorPlacer } from "@ohmail/app-logic/keys";
import { useListWalk, type ListWalkInput } from "../../../packages/app-logic/src/place-list/walk.js";
import { KeymapProvider } from "../../../test/support/keymap-provider";
import { message } from "./_draft-shell.js";
import {
  ISO, act, answerConsentWith, answerSyncWith, goTo, installShellEnv, mailbox, mountShell,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import messages from "../messages/en.json";

const folder = { id: "f1", name: "Projects", mailboxId: "mb_1", mailbox: "walker@example.invalid", updatedAt: ISO };
const ids = ["m1", "m2", "m3"];

beforeEach(() => {
  installShellEnv();
  localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
});
afterEach(async () => {
  cleanup();
  await teardownShellEnv();
});

async function stand(wrap?: (page: React.ReactElement) => React.ReactElement, entries = ids) {
  answerSyncWith(() => new Response(JSON.stringify({
    cursor: "1", hasMore: false, serverTime: ISO,
    changes: {
      creates: [
        { type: "folder", op: "create", id: folder.id, seq: 1, updatedAt: ISO, entity: folder },
        ...entries.map((id, index) => {
          const date = new Date(Date.parse(ISO) - index * 60_000).toISOString();
          return {
            type: "message", op: "create", id, seq: index + 2, updatedAt: date,
            entity: { ...message(id), mailboxId: folder.mailboxId, date, updatedAt: date, folder: folder.name },
          };
        }),
      ],
      updates: [], moves: [], deletes: [],
    },
  }), { headers: { "content-type": "application/json" } }));
  window.location.hash = "#/ohbox";
  const shell = await mountShell([mailbox({ id: folder.mailboxId })], wrap ? { wrap } : {});
  await tick(2_500);
  await goTo("folder/f1");
  await tick(300);
  const view = within(shell);
  expect(view.queryAllByRole("option")).toHaveLength(entries.length);
  return view;
}

async function key(k: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
  await tick(100);
  return event;
}

const hintFor = (label: string) => messages.cursor.placed.replace("{label}", label);
const said = (view: Awaited<ReturnType<typeof stand>>) =>
  view.queryAllByRole("status").map((node) => node.textContent);
const writes = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const url = input instanceof Request ? input.url : String(input);
  return /\/messages\//.test(url) && method !== "GET";
});

function globalClaim(asked: () => boolean) {
  let show: (() => void) | undefined;
  function LateGlobal() {
    useCursorPlacer(asked, "global");
    return null;
  }
  function SharedKeys({ children }: { children: React.ReactNode }) {
    const [showGlobal, setShowGlobal] = useState(false);
    show = () => setShowGlobal(true);
    return <KeymapProvider>{children}{showGlobal ? <LateGlobal /> : null}</KeymapProvider>;
  }
  return {
    wrap: (page: React.ReactElement) => <SharedKeys>{page}</SharedKeys>,
    mount: async () => { await act(async () => show!()); },
  };
}

describe("a split view's list with rows and no cursor", () => {
  it("`e` places the cursor on the first row, names Park, and performs NOTHING", async () => {
    const view = await stand();
    const before = writes();
    expect((await key("e")).defaultPrevented).toBe(true);
    expect(window.location.hash).toBe("#/folder/f1/m/m1");
    expect(said(view)).toContain(hintFor(messages.reader.key.park));
    expect(writes()).toEqual(before);
  });

  it("the hint names the verb of the chord PRESSED, verb by verb", async () => {
    const view = await stand();
    for (const [chord, label, init] of [
      ["r", messages.reader.key.reply, {}],
      ["b", messages.reader.key.resurface, {}],
      ["Backspace", messages.reader.key.deleteKey, {}],
      ["F", messages.reader.key.forward, { shiftKey: true }],
    ] as const) {
      await key(chord, init);
      expect(window.location.hash, `${chord} placed no cursor`).toBe("#/folder/f1/m/m1");
      expect(said(view)).toContain(hintFor(label));
      await goTo("folder/f1");
      await tick(300);
    }
  });

  it("THE VIEW'S CLAIM ANSWERS, not the shell's — though the shell claimed later", async () => {
    const globalAsked = vi.fn(() => true);
    const claim = globalClaim(globalAsked);
    const view = await stand(claim.wrap);
    await claim.mount();
    await key("e");
    expect(globalAsked).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/folder/f1/m/m1");
    expect(view.getByRole("region", { name: "Reading" }).textContent).toContain("Subject m1");
  });

  it("a HELD key places nothing — auto-repeat is not a press", async () => {
    await stand();
    await key("Backspace", { repeat: true });
    expect(window.location.hash).toBe("#/folder/f1");
    await key("Backspace");
    expect(window.location.hash).toBe("#/folder/f1/m/m1");
  });
});

describe("a split view's list with NO rows", () => {
  it("places nothing, says nothing, and does not consume the key", async () => {
    const globalAsked = vi.fn(() => true);
    const claim = globalClaim(globalAsked);
    const view = await stand(claim.wrap, []);
    await claim.mount();
    const before = writes();
    const priorReports = said(view);
    for (const chord of ["e", "r", "b", "Backspace"]) {
      expect((await key(chord)).defaultPrevented, `${chord} was consumed`).toBe(false);
    }
    expect(window.location.hash).toBe("#/folder/f1");
    expect(said(view)).toEqual(priorReports);
    expect(writes()).toEqual(before);
    expect(globalAsked).not.toHaveBeenCalled();
  });
});

function mountWalk(over: Partial<ListWalkInput> = {}) {
  const effects: string[] = [];
  const open = vi.fn((id: string | null) => { effects.push(`open ${id}`); });
  const say = vi.fn((label: string) => { effects.push(`say ${label}`); });
  const { result } = renderHook(() => {
    const [openId, setOpenId] = useState(over.openId ?? null);
    return useListWalk({
      order: ids,
      columns: 2,
      list: "folder",
      labels: { next: "Next", prev: "Previous", open: "Open" },
      arrival: "rest",
      say,
      ...over,
      openId,
      open: (id) => {
        open(id);
        setOpenId(id);
      },
    });
  });
  const place = async () => {
    let placed = false;
    await act(async () => { placed = result.current.place("Park it"); });
    return placed;
  };
  return { result, effects, open, place };
}

describe("a split view mounted with nowhere to say it", () => {
  it("renders, and places nothing — the view is not broken, the placement is refused", async () => {
    const walk = mountWalk({ say: undefined });
    expect(walk.result.current.cursor).toBeNull();
    expect(await walk.place()).toBe(false);
    expect(walk.result.current.cursor).toBeNull();
    expect(walk.open).not.toHaveBeenCalled();
  });
});

describe("placeFirstRow refuses, at its own seam", () => {
  function drew(idsToDraw: string[]) {
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    for (const id of idsToDraw) {
      const row = document.createElement("div");
      row.setAttribute("role", "option");
      row.dataset.id = id;
      list.appendChild(row);
    }
    document.body.appendChild(list);
    return list;
  }

  it("a cursor already standing is not moved", async () => {
    const walk = mountWalk({ openId: "m2" });
    expect(await walk.place()).toBe(false);
    expect(walk.effects).toEqual([]);
  });

  it("a row the window has not mounted is not placed on", async () => {
    const list = drew([]);
    try {
      const walk = mountWalk({
        rowRendered: (id) => [...list.children].some((node) => (node as HTMLElement).dataset.id === id),
      });
      expect(await walk.place()).toBe(false);
      expect(walk.effects).toEqual([]);
    } finally {
      list.remove();
    }
  });

  it("a host with nowhere to SAY it places nothing", async () => {
    const list = drew(ids);
    try {
      const walk = mountWalk({ say: undefined });
      expect(await walk.place()).toBe(false);
      expect(walk.effects).toEqual([]);
    } finally {
      list.remove();
    }
  });

  it("…and the ordinary case is admitted — select, then say, once each", async () => {
    const list = drew(ids);
    try {
      const walk = mountWalk();
      expect(await walk.place()).toBe(true);
      expect(walk.result.current.cursor).toBe("m1");
      expect(walk.effects).toEqual(["open m1", "say Park it"]);
    } finally {
      list.remove();
    }
  });
});
