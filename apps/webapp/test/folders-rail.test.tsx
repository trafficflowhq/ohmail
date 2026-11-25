/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, FolderEntity } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Frame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { FOLDERS_ON, LIST_WORDS, listFrame, listSeat } from "../../../packages/app/test/places/list-seat.js";
import { MemoryMirrorStore, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { FOLDER_FILTER_AT, folderTailVerdict } from "@ohmail/app-logic/lists/folders";
import messages from "../messages/en.json";
import { fakeWindow } from "../../../packages/app/test/support/fake-window.js";

/** Folder rail controls, list windows, and paging promises from the earlier web shell. */
(globalThis as unknown as { React: unknown }).React = React;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function folder(name: string, mailboxId = "mb1", mailbox = "a@x.example"): FolderEntity {
  return { id: `f-${mailboxId}-${name}`, name, mailboxId, mailbox };
}

function mountFolderFrame(entity: FolderEntity, window: ReturnType<typeof fakeWindow>,
  { engine, children = [] }: { engine?: OhmailEngine; children?: readonly FolderEntity[] } = {}) {
  const { host: frameHost, address, mail } = listFrame({
    first: "#/ohbox",
    letters: [],
    consent: FOLDERS_ON,
    more: Object.fromEntries([entity, ...children].map((folder) => [`folder:${folder.id}`, folder])),
    mailboxes: async () => [{
      id: entity.mailboxId, address: entity.mailbox, status: "connected",
      errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null,
    }],
  });
  render(React.createElement(TextProvider, {
    locale: "en", messages: LIST_WORDS, timeZone: "Europe/Zurich",
    children: React.createElement(Frame, {
      host: {
        ...frameHost,
        engine: engine ?? frameHost.engine,
        device: { ...frameHost.device, window },
        capabilities: { ...frameHost.capabilities, foldersStorable: true },
        wires: { ...frameHost.wires, folderSummary: async () => null },
      },
    }),
  }));
  return { address, mail };
}

async function expectTouchMenuInMore(window: ReturnType<typeof fakeWindow>) {
  const projects = folder("Projects");
  const child = folder("Projects/Bids");
  const { address } = mountFolderFrame(projects, window, { children: [child] });
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  const menuName = "Folder menu for Projects";
  const pressMenu = async (surface: HTMLElement) => {
    const opener = within(surface).getByRole("button", { name: menuName });
    expect(opener.tabIndex).toBe(0);
    expect(opener.getAttribute("aria-haspopup")).toBe("menu");
    await click(opener);
    const menu = screen.getByRole("menu", { name: menuName });
    for (const name of ["Rename", "New subfolder", "Delete…"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
    }
    expect(address.read()).toBe("#/ohbox");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: menuName })).toBeNull();
  };

  try {
    const places = await screen.findByRole("dialog", { name: "More" });
    await within(places).findByRole("button", { name: "Projects" });
    await pressMenu(places);

    await click(within(places).getByRole("button", { name: "All folders" }));
    const tree = within(places).getByRole("tree", { name: "All folders" });
    expect(within(tree).queryByRole("button", { name: "Bids" })).toBeNull();
    await pressMenu(tree);
    const expand = within(tree).getByRole("button", { name: "Expand Projects" });
    await click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(address.read()).toBe("#/ohbox");
    await click(within(tree).getByRole("button", { name: "Bids" }));
    expect(address.read()).toBe(`#/folder/${child.id}`);
  } finally {
    cleanup();
  }
}

async function mount(folders: FolderEntity[], { writable = false }: { writable?: boolean } = {}) {
  mountRegisteredRail(folders, writable ? async () => null : NONE);
  const opener = await screen.findByRole("button", { name: "All folders" });
  await click(opener);
  return { el: screen.getByRole("tree", { name: "All folders" }) };
}

const rowLabels = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".oh-folderfold-row > button:not([aria-expanded])")].map((row) => row.textContent?.trim() ?? "");

const click = async (n: Element | null) => {
  expect(n, "expected an element to click").not.toBeNull();
  await act(() => (n as HTMLElement).click());
};

describe("the many-folders treatment", () => {
  const many = Array.from({ length: FOLDER_FILTER_AT + 3 }, (_, i) =>
    folder(`Mandat ${String(i + 1).padStart(2, "0")}`));

  it("above 12 roots: type-to-filter + the first 12 + a Show-all expander; expanded scrolls bounded", async () => {
    mountRegisteredRail(many, NONE);
    const expander = await screen.findByRole("button", { name: "All folders" });
    const shelf = expander.closest<HTMLElement>(".oh-foldershelf")!;
    expect(expander.getAttribute("aria-expanded")).toBe("false");
    expect(within(shelf).queryByRole("tree")).toBeNull();
    expect(within(shelf).getAllByRole("button", { name: /^Mandat \d\d$/ }).map((row) => row.textContent))
      .toEqual(many.slice(0, 7).map((row) => row.name));
    await click(expander);
    const tree = within(shelf).getByRole("tree", { name: "All folders" });
    expect(within(tree).getByRole("textbox", { name: "Find a folder" })).toBeTruthy();
    expect(rowLabels(tree)).toEqual(many.map((row) => row.name));
    expect(tree.querySelector(".oh-folderfold-scroll")).not.toBeNull();
    expect(expander.getAttribute("aria-expanded")).toBe("true");
    await click(expander);
    expect(within(shelf).queryByRole("tree")).toBeNull();
  });

  it("at 12 roots or fewer the treatment stays away — no filter line, no expander", async () => {
    const { el } = await mount(many.slice(0, FOLDER_FILTER_AT));
    expect(within(el).queryByRole("textbox", { name: "Find a folder" })).toBeNull();
    expect(within(el).queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("the filter matches the FULL path and the match wears its parent for context", async () => {
    const withChild = [...many, folder("Mandat 01/Belege")];
    const { el } = await mount(withChild);
    const input = within(el).getByRole<HTMLInputElement>("textbox", { name: "Find a folder" });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(() => {
      setter.call(input, "mandat 01/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // A path query reaches the child a leaf-only match would miss — the prototype's watched-red
    // mutation, owed here in product code.
    expect(rowLabels(el)).toEqual(["BelegeMandat 01"]);
    const match = within(el).getByRole("button", { name: "Belege, Mandat 01" });
    expect(match.querySelector(".oh-railentry-hint")?.textContent).toBe("Mandat 01");
  });
});

describe("mailbox sections", () => {
  it("the ACCOUNT's mailbox count decides — one tree still sections when a second mailbox exists", async () => {
    // Two connected mailboxes, only one with user folders: the lone tree must say whose it is
    // (spec §14 — "more than one mailbox on the account", not "more than one tree").
    const project = folder("Projects");
    const child = folder("Projects/Archive");
    listSeat({
      first: "#/ohbox",
      letters: [],
      consent: FOLDERS_ON,
      more: { [`folder:${project.id}`]: project, [`folder:${child.id}`]: child },
      mailboxes: async () => [
        { id: project.mailboxId, address: project.mailbox, status: "connected",
          errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null },
        { id: "mb2", address: "other" + "@" + "example.test", status: "connected",
          errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null },
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
    const tree = within(screen.getByRole("tree", { name: "All folders" }));
    await waitFor(() => expect(tree.getAllByRole("paragraph").map((label) => label.textContent)).toEqual([project.mailbox]));
  });
});

describe("the pure derivations behind the rows", () => {
  it("folderTailVerdict: the live entity judges fully; an absent one judges NOTHING", () => {
    // The reach-past's overlap word, branch by branch. The absent-entity branch is the
    // review-earned part, in its final shape: while the scope is not readable NOTHING is
    // judged — no ban, no clear — because a move that ends in a prune during the gap erases
    // its own evidence, and the gap is settled by the hook's scopeEpoch reset instead.
    const inF = { mailboxId: "mb1", folder: "Projects" } as never;
    const elsewhere = { mailboxId: "mb1", folder: "Archive" } as never;
    const entity = folder("Projects");

    // Not held by the mirror at all → the fetched copy shows.
    expect(folderTailVerdict(undefined, "fd1", entity)).toBe("show");
    // No folder scope, or the entity absent → hold, whatever the message row says.
    expect(folderTailVerdict(inF, undefined, undefined)).toBe("hold");
    expect(folderTailVerdict(inF, "fd1", undefined)).toBe("hold");
    expect(folderTailVerdict(elsewhere, "fd1", undefined)).toBe("hold");
    // Entity present → the mirror's full word.
    expect(folderTailVerdict(inF, "fd1", entity)).toBe("hide");
    expect(folderTailVerdict(elsewhere, "fd1", entity)).toBe("ban");
    // Same-name folder on ANOTHER mailbox never reads as this scope.
    expect(folderTailVerdict({ mailboxId: "mb2", folder: "Projects" } as never, "fd1", entity)).toBe("ban");
  });
});

function mountRegisteredFolder(
  letters: readonly EngineMessage[],
  items: readonly EngineMessage[] | null,
  nextCursor: string | null = null,
) {
  const listOlder = vi.fn(async () => {
    if (items === null) return new Promise<never>(() => {});
    return { state: "ready", items, nextCursor };
  });
  return {
    listOlder,
    ...listSeat({
      first: "#/folder/projects",
      consent: FOLDERS_ON,
      more: {
        "folder:projects": { ...folder("Projects"), id: "projects" },
        "folder:archive": { ...folder("Archive"), id: "archive" },
      },
      letters,
      engine: () => ({
        storeCoverage: () => ({ state: "partial" }),
        listOlderAvailable: () => true,
        listOlder,
      }),
    }),
  };
}

describe("an empty folder is a question until the server has answered — the reach-past", () => {
  it("with a windowed mirror, the empty claim WAITS and one probe page is asked for", async () => {
    const { listOlder } = mountRegisteredFolder([], null);
    await waitFor(() => expect(listOlder).toHaveBeenCalledTimes(1));
    const messagesRegion = screen.getByRole("region", { name: "Messages" });
    // Never the claim before the answer: no empty state while the source may hold mail…
    expect(messagesRegion.textContent).not.toContain("Nothing here");
    // …and exactly one probe (the empty list IS the ask).
    expect(listOlder).toHaveBeenCalledTimes(1);
    // The way further back is on screen instead (the device sentence went with ARCHIVE-024).
    expect(within(messagesRegion).getByRole("status", { busy: true }).textContent)
      .toBe(messages.ohbox.olderLoading);
    expect(within(messagesRegion).queryByRole("button", { name: messages.ohbox.olderAction })).toBeNull();
    expect(messagesRegion.textContent).not.toMatch(/on your server|this device/);
  });

  it("the empty state renders only once the server says the source is exhausted", async () => {
    const { listOlder } = mountRegisteredFolder([], []);
    expect(screen.queryByText("Nothing here")).toBeNull();
    expect(await screen.findByText("That is everything on your server.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("region", { name: "Messages" }).textContent).toContain("Nothing here"));
    expect(listOlder).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: messages.ohbox.olderAction })).toBeNull();
  });
});

describe("the reach-past never lies beside the mirror", () => {
  const mk = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({
    id: `m${i + offset}`,
    accountId: "acct", mailboxId: "mb1", threadId: null, messageIdHeader: null,
    subject: `Subject ${i + offset}`, from: { name: null, address: `s${i + offset}@example.com` },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "Projects",
    snippet: "…", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
  }));
  it("a fetched row the mirror also holds renders ONCE — the boundary's belt", async () => {
    const { listOlder } = mountRegisteredFolder(mk(3) as EngineMessage[], mk(2, 1) as EngineMessage[]);
    const load = await screen.findByRole("button", { name: messages.ohbox.olderAction });
    await act(async () => { load.click(); });
    expect(listOlder).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("That is everything on your server.")).toBeTruthy();
    const ids = screen.getAllByRole("option").map((row) => row.getAttribute("data-id"));
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids.sort()).toEqual(["m0", "m1", "m2"]);
  });

  it("the tail's count says what is ON SCREEN, never rows the filter hid", async () => {
    const { listOlder } = mountRegisteredFolder(mk(3) as EngineMessage[], mk(2) as EngineMessage[], "next");
    const load = await screen.findByRole("button", { name: messages.ohbox.olderAction });
    await act(async () => { load.click(); });
    expect(listOlder).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: messages.ohbox.olderAction })).toBeTruthy();
    expect(screen.queryByText(/older messages?/)).toBeNull();
  });

  it("overlap verdicts are LIVE, three-valued, and the fetched copies are kept — pinned at the source", () => {
    // The review-retired shapes, named so none returns: a surface-list filter (resurfaces
    // moved rows, counts hidden ones); an accept-time discard (mail vanishes when the mirror
    // prunes); a boolean live filter (a moved-then-pruned row revives its stale pre-move
    // copy); an unclearable latch (a rolled-back optimistic move, or a genuine move back,
    // suppressed real mail after a later eviction); a clear on the DEFENSIVE hide (a missing
    // folder entity counted as an observed return and released bans the scope never
    // re-earned); and judging the gap from the entity's last-known name (any move sequence
    // ending in a prune during the gap erases its own evidence, so remembered judgments lie
    // in one direction or the other). The hook keeps every fetched copy, asks per render,
    // LATCHES an observed move, CLEARS the latch only on the observed return, HOLDS — latches
    // untouched — while the scope cannot be judged, and the gap's END resets the tail whole:
    // the shell bumps `scopeEpoch` when the entity re-enters the mirror, and the rows are
    // re-earned from the server. `folderTailVerdict`'s branches are proven in the pure
    // derivations; the epoch reset in the hook's own suite.
    const src = stripComments(read("../../../packages/app-logic/src/folder/live.ts"));
    expect(src).toContain("folderTailVerdict(");
    expect(src).toContain('useOlderMail(engine, "folder", derived, folder?.id,');
    const hook = stripComments(read("../../../packages/app-logic/src/lists/older-mail.ts"));
    // An absent or different folder changes the paging scope, including on return.
    expect(hook).toContain('const scope = `${view}|${folderId ?? ""}|${scopeEpoch}`;');
    expect(hook).toContain('p.scope !== scope || p.engine !== engine');
    // The commit-scope effect is layout-phase in a browser and passive on a server — a bare
    // useLayoutEffect is a console.error under Next's pre-render (engine.tsx's pattern).
    expect(hook).toContain('typeof window === "undefined" ? useEffect : useLayoutEffect');
    expect(hook).toContain("useCommitEffect(() => {");
    // The latch is WRITTEN post-commit only (a discarded render must not move it) and READ
    // in the memo; anything but "show" stays out of the tail on its own verdict.
    expect(hook).toContain('if (verdict === "ban") p.banned.add(item.id);');
    expect(hook).toContain('else if (verdict === "hide") p.banned.delete(item.id);');
    expect(hook).toContain('if (verdict !== "show") return false;');
    expect(hook).toContain('return !(latched?.has(item.id) ?? false);');
  });

  it("fetched rows beside an empty mirror suppress the empty claim", async () => {
    mountRegisteredFolder([], mk(2) as EngineMessage[]);
    expect(await screen.findByRole("option", { name: /Subject 0/ })).toBeTruthy();
    expect(screen.queryByText("Nothing here")).toBeNull();
  });

  it("navigating between two empty folders re-probes the second one", async () => {
    const { address, listOlder } = mountRegisteredFolder([], null);
    await waitFor(() => expect(listOlder).toHaveBeenCalledTimes(1));
    await act(async () => { address.visit("#/folder/archive"); });
    await waitFor(() => expect(listOlder).toHaveBeenCalledTimes(2));
    expect(listOlder).toHaveBeenNthCalledWith(1, "folder", expect.objectContaining({ folderId: "projects" }));
    expect(listOlder).toHaveBeenNthCalledWith(2, "folder", expect.objectContaining({ folderId: "archive" }));
  });
});

function windowLetters(count: number, unread = 0): EngineMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    accountId: "acct", mailboxId: "mb1", threadId: null, messageIdHeader: null,
    subject: `Subject ${i}`, from: { name: null, address: `s${i}@example.com` },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "Projects" as EngineMessage["folder"],
    snippet: "…", unread: i < unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
  }));
}

function mountFolderWindow(letters: readonly EngineMessage[], open?: string) {
  const project = folder("Projects");
  return listSeat({
    first: `#/folder/${project.id}${open ? `/m/${open}` : ""}`,
    letters,
    consent: FOLDERS_ON,
    more: { [`folder:${project.id}`]: project },
  });
}

const folderWindowScroller = (list: HTMLElement) => list.closest<HTMLElement>(".pl-scroll")!;

describe("the folder view is windowed — a large folder never mounts whole", () => {
  it("renders a slice with spacer height standing in for the rest", async () => {
    mountFolderWindow(windowLetters(1000, 3));
    const list = await screen.findByRole("listbox", { name: "Projects" });
    const scroller = folderWindowScroller(list);
    const rows = within(scroller).getAllByRole("option");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    // The unrendered rows still occupy space, so the scroll range includes them.
    const spacers = [...scroller.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
      .filter((element) => parseFloat(element.style.height) > 0);
    expect(spacers.length).toBeGreaterThan(0);
    expect(within(scroller).queryByText("New", { exact: true })).toBeNull();
    expect(rows.slice(0, 3).map((row) => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Subject 0"), expect.stringContaining("Subject 1"), expect.stringContaining("Subject 2"),
    ]));
  });

  it("a deep locate target is REVEALED — the window scrolls to mount the row it names", async () => {
    const { address } = mountFolderWindow(windowLetters(1000), "m400");
    const list = await screen.findByRole("listbox", { name: "Projects" });
    const messagesRegion = screen.getByRole("region", { name: "Messages" });
    // The row is deep below the initial slice, so the reveal effect must have SCROLLED —
    // that write is the whole mechanism: the slice derives from scrollTop.
    const scroller = folderWindowScroller(list);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    // jsdom fires no scroll event for a programmatic scrollTop write; dispatching it is the
    // browser half the DOM cannot do — after it, the window has re-derived and the row exists.
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
      // The hook batches its re-derivation behind requestAnimationFrame; give the frame a beat.
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(within(list).queryByRole("option", { name: /Subject 400\b/ })).not.toBeNull();
    // …and the reading column shows the hit, not the first row.
    expect(messagesRegion.textContent).toContain("Subject 400");

    // CLOSING THE READER clears the URL tail — the target must have become the SELECTION, so
    // the column keeps the hit instead of snapping back to the first row.
    await act(() => { address.visit(`#/folder/${folder("Projects").id}`); });
    expect(messagesRegion.textContent).toContain("Subject 400");
  });

  it("a target that arrives LATE — after the folder entity — is still revealed", async () => {
    const letters = windowLetters(1000);
    const { mail } = mountFolderWindow(letters.slice(0, 50), "m400");
    const list = await screen.findByRole("listbox", { name: "Projects" });
    const scroller = folderWindowScroller(list);
    expect(scroller.scrollTop).toBe(0);

    await act(() => {
      for (const letter of letters.slice(50)) mail.add(letter);
    });
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    expect(await within(list).findByRole("option", { name: /Subject 400\b/, selected: true })).toBeTruthy();
  });
});

/**
 * ═══ STAGE 2 — THE VERBS (owner-ordered): create / rename / delete / new subfolder ═══════════
 *
 * Each guard below is an interaction the prototype ratified or a rule the brief pinned:
 * without `verbs` the group is the read-only foundation byte for byte; the create names WHICH
 * mailbox by being the section's own affordance; the … menu carries exactly the three verbs; a
 * command in flight forecloses a second one (no menu on a pending row); the name validator
 * refuses BEFORE the wire with the honest sentence; the delete asks FIRST, with the server's
 * numbers; pending rows dim, failed rows carry the refusal and its dismiss.
 */

function mountRegisteredRail(
  folders: readonly FolderEntity[],
  summary: typeof NONE | ((id: string) => Promise<{ folders: number; messages: number } | null>),
  mailbox = { id: "mb1", address: folder("Projects").mailbox },
) {
  const { host, mail } = listFrame({
    first: "#/ohbox",
    letters: [],
    consent: FOLDERS_ON,
    more: Object.fromEntries(folders.map((entry) => [`folder:${entry.id}`, entry])),
    mailboxes: async () => [{
      ...mailbox, status: "connected", errorCode: null, disabledReason: null,
      syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null,
    }],
  });
  render(
    <TextProvider locale="en" messages={LIST_WORDS} timeZone="Europe/Zurich">
      <Frame host={{
        ...host,
        capabilities: { ...host.capabilities, foldersStorable: true },
        wires: { ...host.wires, folderSummary: summary },
      }} />
    </TextProvider>,
  );
  return mail;
}

async function askToDeleteProjects() {
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Projects" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  return within(await screen.findByRole("alertdialog", { name: "Delete folder" }));
}

describe("stage 2 — the read-only render stays the foundation's", () => {
  it("without verbs there is no … affordance and no create row anywhere", async () => {
    mountRegisteredRail([folder("Projects"), folder("Invoices")], NONE);
    expect(await screen.findByRole("button", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invoices" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Folder menu for / })).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.queryByText("New folder", { exact: false })).toBeNull();
  });
});

function enterFolderName(input: HTMLInputElement): void {
  // jsdom does not perform the browser's implicit submit after an uncancelled Enter.
  if (fireEvent.keyDown(input, { key: "Enter", code: "Enter" })) fireEvent.submit(input.form!);
  fireEvent.keyUp(input, { key: "Enter", code: "Enter" });
}

describe("stage 2 — create", () => {
  async function openNewFolder() {
    fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
    const tree = within(screen.getByRole("tree", { name: "All folders" }));
    fireEvent.click(await tree.findByRole("button", { name: "New folder" }));
    return { tree, input: tree.getByRole<HTMLInputElement>("textbox", { name: "Folder name" }) };
  }

  it("the section's own affordance names the mailbox; Enter dispatches the FULL canonical path", async () => {
    const mail = mountRegisteredRail([folder("Projects")], async () => null);
    const { input } = await openNewFolder();
    fireEvent.change(input, { target: { value: "Steuern 2026" } });
    expect(mail.mutations).toEqual([]);
    enterFolderName(input);
    await waitFor(() => expect(mail.mutations).toEqual([
      { kind: "folder_create", folderId: expect.any(String), mailboxId: "mb1", name: "Steuern 2026" },
    ]));
  });

  it("a mailbox with ZERO folders still offers the create — the account list makes the section", async () => {
    mountRegisteredRail([], async () => null, { id: "mb9", address: "empty" + "@" + "example.test" });
    fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
    const tree = screen.getByRole("tree", { name: "All folders" });
    expect(await within(tree).findByRole("button", { name: "New folder" })).not.toBeNull();
  });

  it("a reserved name is refused BEFORE the wire, with the sentence — nothing dispatches", async () => {
    const mail = mountRegisteredRail([folder("Projects")], async () => null);
    const { tree, input } = await openNewFolder();
    fireEvent.change(input, { target: { value: "Spam" } });
    enterFolderName(input);
    expect(mail.mutations).toEqual([]);
    expect(tree.getByRole("alert").textContent).toContain("reserved");
  });

  it("a taken name is refused BEFORE the wire — the collision the server would 409", async () => {
    const mail = mountRegisteredRail([folder("Projects")], async () => null);
    const { tree, input } = await openNewFolder();
    fireEvent.change(input, { target: { value: "Projects" } });
    enterFolderName(input);
    expect(mail.mutations).toEqual([]);
    expect(tree.getByRole("alert").textContent).toContain("already exists");
  });
});

describe("stage 2 — the … menu", () => {
  it("carries exactly Rename / New subfolder / Delete…, and only on settled rows", async () => {
    await expectTouchMenuInMore(fakeWindow("phone"));
    window.localStorage.clear();
    await expectTouchMenuInMore(fakeWindow({
      width: 900, height: 420, pointer: "coarse", posture: "flat", reducedMotion: false,
    }));
    const pending: FolderEntity = { ...folder("Busy"), op: { kind: "create" } };
    const mail = mountRegisteredRail([folder("Projects"), pending], async () => null);
    const places = within(screen.getByRole("navigation", { name: "Places" }));
    expect(places.queryByRole("button", { name: "Folder menu for Busy" })).toBeNull();
    fireEvent.contextMenu(await places.findByRole("button", { name: "Busy" }));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(places.getByRole("button", { name: "Projects" }));
    const menu = screen.getByRole("menu", { name: /Projects/ });
    for (const name of ["Rename", "New subfolder", "Delete…"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
    }
    expect(mail.mutations).toEqual([]);
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "Open", "Pin", "New subfolder", "Rename", "Delete…",
    ]);
  });

  it("New subfolder dispatches parent/leaf and the input sits under the parent", async () => {
    const projects = folder("Projects");
    const mail = mountRegisteredRail([projects], async () => null);
    const places = within(screen.getByRole("navigation", { name: "Places" }));
    const selected = await places.findByRole("button", { name: "Projects" });
    await act(() => selected.focus());
    fireEvent.contextMenu(selected);
    fireEvent.click(screen.getByRole("menuitem", { name: "New subfolder" }));
    const tree = within(screen.getByRole("tree", { name: "All folders" }));
    const input = tree.getByRole<HTMLInputElement>("textbox", { name: "Folder name" });
    const parent = tree.getByRole("button", { name: "Projects" });
    expect(parent.closest(".oh-folderfold-row")?.nextElementSibling?.contains(input)).toBe(true);
    await act(() => input.focus());
    fireEvent.change(input, { target: { value: "Acme" } });
    expect(input.value).toBe("Acme");
    expect(document.activeElement).toBe(input);
    expect(mail.mutations).toEqual([]);
    enterFolderName(input);
    await waitFor(() => expect(mail.mutations).toEqual([
      { kind: "folder_create", folderId: expect.any(String), mailboxId: "mb1", name: "Projects/Acme" },
    ]));
  });

  it("Rename swaps the row for an input seeded with the LEAF and dispatches the new full path", async () => {
    const folders = [folder("Projects"), folder("Projects/Acme")];
    const mail = mountRegisteredRail(folders, async () => null);
    fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
    const tree = within(screen.getByRole("tree", { name: "All folders" }));
    fireEvent.click(tree.getByRole("button", { name: "Expand Projects" }));
    const child = tree.getByRole("button", { name: "Acme" });
    await act(() => child.focus());
    fireEvent.contextMenu(child);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = tree.getByRole<HTMLInputElement>("textbox", { name: "New name" });
    await act(() => input.focus());
    expect(input.value).toBe("Acme");
    expect(tree.getByRole("button", { name: "Acme" })).toBe(child);
    expect(input.closest("form")?.previousElementSibling?.contains(child)).toBe(true);
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Acme 2026" } });
    expect(mail.mutations).toEqual([]);
    enterFolderName(input);
    await waitFor(() => expect(mail.mutations).toEqual([
      { kind: "folder_rename", folderId: "f-mb1-Projects/Acme", name: "Projects/Acme 2026" },
    ]));
  });
});

describe("stage 2 — the delete ceremony asks FIRST, with the server's numbers", () => {
  it("Delete… fetches the summary, states it, and only 'Delete folder' dispatches", async () => {
    const summary = vi.fn(async () => ({ folders: 2, messages: 5 }));
    const mail = mountRegisteredRail([folder("Projects")], summary);
    const confirm = await askToDeleteProjects();
    const line = confirm.getByRole("status");
    await waitFor(() => expect(line.textContent).toContain("5 messages"));
    expect(summary.mock.calls).toEqual([["f-mb1-Projects"]]);
    expect(mail.mutations).toEqual([]);
    expect(line.textContent).toContain("2 folders");
    expect(line.textContent).toContain("Trash");

    fireEvent.click(confirm.getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(mail.mutations).toEqual([
      { kind: "folder_delete", folderId: "f-mb1-Projects" },
    ]));
    expect(summary.mock.calls).toEqual([["f-mb1-Projects"]]);
  });

  it("Cancel dispatches nothing; a failed count still asks, without numbers", async () => {
    const summary = vi.fn(async () => null);
    const mail = mountRegisteredRail([folder("Projects")], summary);
    const confirm = await askToDeleteProjects();
    const line = confirm.getByRole("status");
    await waitFor(() => expect(line.textContent).toContain("Trash"));
    expect(line.textContent).not.toMatch(/\d/);
    fireEvent.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(summary.mock.calls).toEqual([["f-mb1-Projects"]]);
    expect(mail.mutations).toEqual([]);
    expect(screen.queryByRole("alertdialog", { name: "Delete folder" })).toBeNull();
  });
});

describe("stage 2 — the honest middle: pending and failed rows", () => {
  it("a pending create dims with the sentence in its title; a pending rename wears the TARGET leaf", async () => {
    const creating: FolderEntity = { ...folder("Neu"), op: { kind: "create" } };
    const renaming: FolderEntity = { ...folder("Alt"), id: "f-r", op: { kind: "rename", to: "Danach" } };
    mountRegisteredRail([creating, renaming], async () => null);
    const places = within(screen.getByRole("navigation", { name: "Places" }));
    const creatingRow = await places.findByRole("button", { name: "Neu" });
    expect(creatingRow.getAttribute("aria-busy")).toBe("true");
    expect(creatingRow.getAttribute("title")).toContain("created");
    const renamingRow = places.getByRole("button", { name: "Danach" });
    expect(renamingRow.getAttribute("title")).toContain("renamed");
    expect(renamingRow.textContent).toContain("Danach");
    expect(renamingRow.textContent).not.toContain("Alt");
  });

  it("a failed command carries its sentence and OK dispatches the dismiss", async () => {
    for (const inTree of [false, true]) {
      const failed: FolderEntity = { ...folder("Kaputt"), op: { kind: "rename", to: "X", error: "exists" } };
      const now = new Date("2026-11-10T09:00:00Z");
      const updatedAt = now.toISOString();
      const store = new MemoryMirrorStore();
      await store.load();
      await store.applyChanges([{
        type: "folder", op: "create", id: failed.id, seq: 1, updatedAt, entity: failed,
      }]);
      let seq = 1;
      const mutate = vi.fn(async (mutation: EngineMutation) => {
        const changes = mutationEffects(store, mutation, { now: () => now, uuid: () => failed.id })
          .map((effect) => ({ ...effect, op: "update", seq: ++seq, updatedAt }) as SyncChange);
        await store.applyChanges(changes);
        return { changes, seq };
      });
      const engine = new OhmailEngine({ store, storePolicy: { mode: "full" }, adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: "1", hasMore: false, serverTime: updatedAt }),
        mutate,
        fetchBody: async () => null,
        withdrawSend: async () => ({ outcome: "unsupported" }),
      } });
      await engine.hydrate();
      expect(engine.read().get("folder", failed.id)).toEqual(failed);
      mountFolderFrame(failed, fakeWindow("desktop"), { engine });

      expect(await screen.findByRole("button", { name: failed.name })).toBeTruthy();
      const places = screen.getByRole("navigation", { name: "Places" });
      if (inTree) await click(within(places).getByRole("button", { name: "All folders" }));
      else expect(within(places).queryByRole("tree", { name: "All folders" })).toBeNull();
      const surface = inTree ? within(places).getByRole("tree", { name: "All folders" }) : places;
      const ok = within(surface).getByRole("button", { name: messages.rail.folderDismiss });
      const problem = within(surface).getAllByRole("status").find((line) => within(line).queryByRole("button", {
        name: messages.rail.folderDismiss,
      }) === ok)!;
      expect(problem.textContent).toContain("already exists");
      await click(ok);
      await waitFor(() => {
        expect(mutate.mock.calls.map(([mutation]) => mutation)).toEqual([
          { kind: "folder_op_dismiss", folderId: failed.id },
        ]);
        expect(problem.isConnected).toBe(false);
        expect(screen.queryByRole("button", { name: messages.rail.folderDismiss })).toBeNull();
      });
      expect(within(surface).getByRole("button", { name: failed.name })).toBeTruthy();
      cleanup();
    }
  });
});

describe("a refused folder delete says what happened", () => {
  /**
   * The refusal's other half. The worker stops a delete whose folder received mail while it was
   * being emptied — but a refusal nobody is told about is a person pressing Delete again on a
   * folder that looks unchanged, which is the loop the stop exists to prevent. So the code the
   * worker writes has to reach a sentence, and the sentence has to name the thing that happened.
   */
  it("`received_mail` renders the sentence in the row's alert strip, with the folder still on the rail", async () => {
    const failed = {
      ...folder("Proj"),
      op: { kind: "delete", error: "received_mail" },
    } as unknown as FolderEntity;
    const { el } = await mount([failed], { writable: true });

    expect(rowLabels(el)).toEqual(["Proj"]);            // the folder is still there
    const strip = within(el).getByRole("status");
    expect(strip?.textContent ?? "").toContain(messages.rail.folderErrGotMail);
    expect(messages.rail.folderErrGotMail).toContain("it was not deleted");
    // NOT the catch-all. A refusal that reads "your mail server refused this change" tells the
    // person nothing about the mail that arrived, and nothing about pressing Delete again.
    expect(strip?.textContent ?? "").not.toContain(messages.rail.folderErrRefused);

    cleanup();
    const mail = mountRegisteredRail([failed], async () => null);
    fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
    const tree = within(screen.getByRole("tree", { name: "All folders" }));
    expect(tree.getByRole("button", { name: "Proj" })).toBeTruthy();
    const refusal = await tree.findByRole("status");
    expect(refusal.textContent).toContain(messages.rail.folderErrGotMail);
    expect(refusal.textContent).not.toContain(messages.rail.folderErrRefused);
    expect(mail.mutations).toEqual([]);
  });
});
