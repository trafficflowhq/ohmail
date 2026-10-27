/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { shellFrameOf } from "./source-anchor.js";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import type { FolderEntity } from "@ohmail/client-engine";
import { FoldersRailGroup } from "../app/shell/FoldersRailGroup";
import {
  FOLDER_FILTER_AT,
  folderMatches,
  folderTailVerdict,
  folderTree,
  folderUnreadCounts,
  folderUnreadDeep,
  visibleFolderRows,
} from "../app/shell/folders";
import messages from "../messages/en.json";

/**
 * THE RAIL'S FOLDERS GROUP — the foundation stage's product guards, each one a prototype
 * invariant clicked through and ratified on the prototype (the folders spec §14/§15; the prototype watched its
 * own mutations of every one of these go red, and this file owes the same watch in product code):
 *
 *  · FLAG-OFF PARITY: with "Use folders" off the group is spread away, not emptied — the rail is
 *    byte-identical to the pre-feature rail (spec §10). Asserted at the source level, because
 *    the property is structural: no `.rgroup` may exist to be styled differently.
 *  · FIRST LEVEL ONLY by default — the OPENED-set, no seeding.
 *  · ROLL-UP: a collapsed parent's badge is own + hidden descendants, exactly once.
 *  · ALPHABETICAL, numeric-aware, case-insensitive siblings.
 *  · THE MANY-FOLDERS TREATMENT above 12 roots: filter + first 12 + Show all, bounded scroll.
 *  · FULL-PATH filter matching — a leaf-only match was a watched-red prototype mutation.
 *  · SECTIONED BY MAILBOX only when 2+ exist.
 *  · THE NUMBER KEYS see nothing: the group carries `items: []` and the derivation reads items.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  window.localStorage.clear();
});

function folder(name: string, mailboxId = "mb1", mailbox = "a@x.example"): FolderEntity {
  return { id: `f-${mailboxId}-${name}`, name, mailboxId, mailbox };
}

async function mount(
  folders: FolderEntity[],
  unread: Map<string, number> = new Map(),
  activeFolderId?: string,
  mailboxCount?: number,
): Promise<{ el: HTMLElement; nav: string[] }> {
  const nav: string[] = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() =>
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "Europe/Zurich",
        children: h(FoldersRailGroup, {
          folders,
          unread,
          mailboxCount,
          activeFolderId,
          onNavigate: (id: string) => nav.push(id),
        }),
      }),
    ),
  );
  return { el: host, nav };
}

const rowLabels = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".frow .ritem .flabel")].map((n) => n.textContent ?? "");

const click = async (n: Element | null) => {
  expect(n, "expected an element to click").not.toBeNull();
  await act(() => (n as HTMLElement).click());
};

describe("first level only, and the opened-set", () => {
  it("a fresh boot renders roots alone; opening a branch reveals its children and persists", async () => {
    const { el } = await mount([
      folder("Projects"),
      folder("Projects/Acme"),
      folder("Projects/Acme/2026"),
      folder("Invoices"),
    ]);
    // Roots only — the child is not in the DOM at all, not merely hidden.
    expect(rowLabels(el)).toEqual(["Invoices", "Projects"]);

    // The branch wears a twisty; the leaf wears a spacer.
    const twisties = el.querySelectorAll("button.ftw");
    expect(twisties.length).toBe(1);
    await click(twisties[0]);
    expect(rowLabels(el)).toEqual(["Invoices", "Projects", "Acme"]);
    // Acme itself has children and starts closed — first level of each branch, recursively.
    expect(rowLabels(el)).not.toContain("2026");

    // The opened branch survives a remount (the persisted OPENED-set).
    await act(() => root!.unmount());
    const again = await mount([
      folder("Projects"),
      folder("Projects/Acme"),
      folder("Projects/Acme/2026"),
      folder("Invoices"),
    ]);
    expect(rowLabels(again.el)).toEqual(["Invoices", "Projects", "Acme"]);
  });

  it("navigating to a nested folder opens its ancestors", async () => {
    const deep = folder("Projects/Acme/2026");
    const { el } = await mount(
      [folder("Projects"), folder("Projects/Acme"), deep],
      new Map(),
      deep.id,
    );
    expect(rowLabels(el)).toEqual(["Projects", "Acme", "2026"]);
  });
});

describe("the roll-up count", () => {
  it("a collapsed parent's badge is own + hidden descendants, exactly once; expanded, its own", async () => {
    const folders = [folder("Projects"), folder("Projects/Acme"), folder("Projects/Acme/2026")];
    const unread = new Map([
      ["mb1|Projects", 1],
      ["mb1|Projects/Acme", 2],
      ["mb1|Projects/Acme/2026", 4],
    ]);
    const { el } = await mount(folders, unread);
    const badge = () => el.querySelector(".frow .ritem .cnt")?.textContent;
    expect(badge()).toBe("7");
    await click(el.querySelector("button.ftw"));
    // Expanded: the parent shows its OWN unread; Acme (still collapsed) rolls its child up.
    const counts = [...el.querySelectorAll(".frow .ritem .cnt")].map((n) => n.textContent);
    expect(counts).toEqual(["1", "6"]);
  });
});

describe("ordering", () => {
  it("siblings sort alphabetically, numeric-aware, case-insensitive", async () => {
    const { el } = await mount([
      folder("Steuern 2010"),
      folder("zebra"),
      folder("Steuern 2009"),
      folder("Archiv"),
    ]);
    expect(rowLabels(el)).toEqual(["Archiv", "Steuern 2009", "Steuern 2010", "zebra"]);
  });
});

describe("the many-folders treatment", () => {
  const many = Array.from({ length: FOLDER_FILTER_AT + 3 }, (_, i) =>
    folder(`Mandat ${String(i + 1).padStart(2, "0")}`));

  it("above 12 roots: type-to-filter + the first 12 + a Show-all expander; expanded scrolls bounded", async () => {
    const { el } = await mount(many);
    expect(el.querySelector("input.ritem-new-input")).not.toBeNull();
    expect(rowLabels(el).length).toBe(FOLDER_FILTER_AT);
    const expander = [...el.querySelectorAll(".ritem-action")].find((n) =>
      (n.textContent ?? "").includes("Show all 15"));
    expect(expander).toBeDefined();
    await click(expander!);
    expect(rowLabels(el).length).toBe(15);
    // The full list scrolls in its OWN region — the rail itself never grows by hundreds of rows.
    expect(el.querySelector(".fscroll")).not.toBeNull();
    expect([...el.querySelectorAll(".ritem-action")].some((n) =>
      (n.textContent ?? "").includes("Show fewer"))).toBe(true);
  });

  it("at 12 roots or fewer the treatment stays away — no filter line, no expander", async () => {
    const { el } = await mount(many.slice(0, FOLDER_FILTER_AT));
    expect(el.querySelector("input.ritem-new-input")).toBeNull();
    expect(el.querySelector(".ritem-action")).toBeNull();
  });

  it("the filter matches the FULL path and the match wears its parent for context", async () => {
    const withChild = [...many, folder("Mandat 01/Belege")];
    const { el } = await mount(withChild);
    const input = el.querySelector("input.ritem-new-input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(() => {
      setter.call(input, "mandat 01/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // A path query reaches the child a leaf-only match would miss — the prototype's watched-red
    // mutation, owed here in product code.
    const labels = rowLabels(el);
    // The label carries the parent as a muted prefix plus the leaf — one span, two parts.
    expect(labels).toContain("Mandat 01/Belege");
    expect(el.querySelector(".fpath")?.textContent).toBe("Mandat 01/");
  });
});

describe("mailbox sections", () => {
  it("two mailboxes are sectioned by address; one mailbox wears no label at all", async () => {
    const two = await mount([
      folder("Projects", "mb1", "a@x.example"),
      folder("Archiv", "mb2", "b@y.example"),
    ]);
    const labels = [...two.el.querySelectorAll(".rmblab")].map((n) => n.textContent);
    expect(labels).toEqual(["a@x.example", "b@y.example"]);

    await act(() => root!.unmount());
    const one = await mount([folder("Projects", "mb1", "a@x.example")]);
    expect(one.el.querySelector(".rmblab")).toBeNull();
  });

  it("the ACCOUNT's mailbox count decides — one tree still sections when a second mailbox exists", async () => {
    // Two connected mailboxes, only one with user folders: the lone tree must say whose it is
    // (spec §14 — "more than one mailbox on the account", not "more than one tree").
    const { el } = await mount([folder("Projects", "mb1", "a@x.example")], new Map(), undefined, 2);
    expect([...el.querySelectorAll(".rmblab")].map((n) => n.textContent)).toEqual(["a@x.example"]);
  });
});

describe("navigation", () => {
  it("a row press navigates by entity id and lights the active row", async () => {
    const target = folder("Projects");
    const { el, nav } = await mount([target, folder("Archiv")], new Map(), target.id);
    const on = el.querySelector(".ritem.on");
    expect(on?.textContent).toContain("Projects");
    await click(el.querySelector(`[data-rail-folder-id="${target.id}"]`));
    expect(nav).toEqual([target.id]);
  });
});

describe("the pure derivations behind the rows", () => {
  it("folderUnreadCounts is one pass, keyed by mailbox — two mailboxes' same-named folders never merge", () => {
    const counts = folderUnreadCounts([
      { mailboxId: "mb1", folder: "Projects", unread: true },
      { mailboxId: "mb2", folder: "Projects", unread: true },
      { mailboxId: "mb1", folder: "Projects", unread: false },
    ] as never[]);
    expect(counts.get("mb1|Projects")).toBe(1);
    expect(counts.get("mb2|Projects")).toBe(1);
  });

  it("folderUnreadDeep counts descendants once and never a sibling's", () => {
    const folders = [folder("A"), folder("A/B"), folder("AB")];
    const counts = new Map([["mb1|A", 1], ["mb1|A/B", 2], ["mb1|AB", 8]]);
    // "AB" starts with "A" but is a SIBLING — the descendant test is path-segment-aware.
    expect(folderUnreadDeep("mb1", "A", counts, folders)).toBe(3);
  });

  it("an orphaned path renders as a root (IMAP allows children of non-existent mailboxes)", () => {
    const tree = folderTree([folder("Ghost/Child")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.depth).toBe(0);
  });

  it("visibleFolderRows hides exactly the closed subtrees", () => {
    const tree = folderTree([folder("A"), folder("A/B"), folder("A/B/C"), folder("Z")]);
    const rows = visibleFolderRows(
      tree,
      (p) => p === "A",
      (p) => p === "A" || p === "A/B",
    );
    expect(rows.map((r) => r.folder.name)).toEqual(["A", "A/B", "Z"]);
  });

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

  it("folderMatches is a substring of the full canonical path", () => {
    expect(folderMatches("Projects/Acme", "acme")).toBe(true);
    expect(folderMatches("Projects/Acme", "projects/a")).toBe(true);
    expect(folderMatches("Projects/Acme", "invoices")).toBe(false);
  });
});

describe("an empty folder is a question until the server has answered — the reach-past", () => {
  const mount2 = async (older: Record<string, unknown>) => {
    const { FolderView: Raw } = await import("../app/views/FolderView");
    /* FolderView declares the message verbs (`useMessageVerbs`), so it needs a keymap. In the
       product it is always inside `AppShell`, which provides one; a bare mount brings its own
       rather than the hook going quiet when there is none — a view whose keys silently do not
       exist is the defect that wiring was. */
    const FolderView = (props: React.ComponentProps<typeof Raw>) =>
      h(KeymapProvider, { children: h(WithListGone, { children: h(Raw, props) }) });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "Europe/Zurich",
        children: h(FolderView, { onMarkSeen: () => {},
          folder: { id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@x.example" },
          messages: [] as never[],
          older: older as never,
          tags: [],
          now: new Date("2026-08-04T12:00:00.000Z"),
          onOpen: () => {}, hydrateBody: () => {}, onAction: () => {}, onAddTag: () => {},
          onScreen: () => {}, canDelete: () => true, canReplyAll: () => true,
        }),
      })),
    );
  };

  it("with a windowed mirror, the empty claim WAITS and one probe page is asked for", async () => {
    let asked = 0;
    await mount2({ available: true, items: [], loading: false, error: null, exhausted: false,
      loadMore: () => { asked += 1; } });
    // Never the claim before the answer: no empty state while the source may hold mail…
    expect(host!.textContent).not.toContain("Nothing in this folder");
    // …and exactly one probe (the empty list IS the ask).
    expect(asked).toBe(1);
    // The way further back is on screen instead (the device sentence went with ARCHIVE-024).
    expect(host!.textContent).toContain(messages.ohbox.olderAction);
    expect(host!.textContent).not.toMatch(/on your server|this device/);
  });

  it("the empty state renders only once the server says the source is exhausted", async () => {
    await mount2({ available: true, items: [], loading: false, error: null, exhausted: true,
      loadMore: () => { throw new Error("must not ask past the end"); } });
    expect(host!.textContent).toContain("Nothing in this folder");
    expect(host!.textContent).toContain("That is everything on your server");
  });

  it("a whole-mailbox client keeps the plain empty state — no offer it cannot keep", async () => {
    await mount2({ available: false, items: [], loading: false, error: null, exhausted: false,
      loadMore: () => { throw new Error("unavailable must never be asked"); } });
    expect(host!.textContent).toContain("Nothing in this folder");
    expect(host!.textContent).not.toContain("Load older mail");
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
  const mountFolder = async (props: Record<string, unknown>) => {
    const { FolderView: Raw } = await import("../app/views/FolderView");
    /* FolderView declares the message verbs (`useMessageVerbs`), so it needs a keymap. In the
       product it is always inside `AppShell`, which provides one; a bare mount brings its own
       rather than the hook going quiet when there is none — a view whose keys silently do not
       exist is the defect that wiring was. */
    const FolderView = (props: React.ComponentProps<typeof Raw>) =>
      h(KeymapProvider, { children: h(WithListGone, { children: h(Raw, props) }) });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (p2: Record<string, unknown>) => act(() =>
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "Europe/Zurich",
        children: h(FolderView, {
          folder: { id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@x.example" },
          tags: [], now: new Date("2026-08-04T12:00:00.000Z"),
          onOpen: () => {}, hydrateBody: () => {}, onAction: () => {}, onAddTag: () => {},
          onScreen: () => {}, canDelete: () => true, canReplyAll: () => true,
          ...p2,
        } as never),
      })),
    );
    await render(props);
    return render;
  };

  it("a fetched row the mirror also holds renders ONCE — the boundary's belt", async () => {
    await mountFolder({
      messages: mk(3) as never[],
      older: { available: true, items: mk(2, 1), loading: false, error: null, exhausted: true, loadMore: () => {} },
    });
    // m1/m2 exist in BOTH lists; each id may appear exactly once.
    const ids = [...host!.querySelectorAll(".row[data-id]")].map((n) => n.getAttribute("data-id"));
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("the tail's count says what is ON SCREEN, never rows the filter hid", async () => {
    // Every fetched row overlaps the mirror: the tail must not claim "2 older messages" over a
    // list that renders none of them below the line.
    await mountFolder({
      messages: mk(3) as never[],
      older: { available: true, items: mk(2), loading: false, error: null, exhausted: false, loadMore: () => {} },
    });
    expect(host!.textContent).not.toContain("older message");
    expect(host!.textContent).toContain(messages.ohbox.olderAction);
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
    const src = stripComments(shellFrameOf("folderTailEpoch").source);
    expect(src).toContain("folderTailVerdict(");
    expect(src).toContain("folderTailEpoch.current.epoch,");
    expect(src).toContain("{ t.epoch += 1; t.present = true; }");
    const hook = stripComments(read("../app/shell/older-mail.ts"));
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
    await mountFolder({
      messages: [] as never[],
      older: { available: true, items: mk(2), loading: false, error: null, exhausted: true, loadMore: () => {} },
    });
    expect(host!.textContent).not.toContain("Nothing in this folder");
    expect(host!.textContent).toContain("Subject 0");
  });

  it("navigating between two empty folders re-probes the second one", async () => {
    let asked = 0;
    const older = { available: true, items: [], loading: false, error: null, exhausted: false,
      loadMore: () => { asked += 1; } };
    const { FolderView: Raw } = await import("../app/views/FolderView");
    /* FolderView declares the message verbs (`useMessageVerbs`), so it needs a keymap. In the
       product it is always inside `AppShell`, which provides one; a bare mount brings its own
       rather than the hook going quiet when there is none — a view whose keys silently do not
       exist is the defect that wiring was. */
    const FolderView = (props: React.ComponentProps<typeof Raw>) =>
      h(KeymapProvider, { children: h(WithListGone, { children: h(Raw, props) }) });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (fid: string) => act(() =>
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "Europe/Zurich",
        children: h(FolderView, { onMarkSeen: () => {},
          folder: { id: fid, name: "Projects", mailboxId: "mb1", mailbox: "a@x.example" },
          messages: [] as never[], older: older as never,
          tags: [], now: new Date("2026-08-04T12:00:00.000Z"),
          onOpen: () => {}, hydrateBody: () => {}, onAction: () => {}, onAddTag: () => {},
          onScreen: () => {}, canDelete: () => true, canReplyAll: () => true,
        }),
      })),
    );
    await render("fd1");
    expect(asked).toBe(1);
    await render("fd2");
    // The second empty folder is owed the same one probe — folder identity keys the effect.
    expect(asked).toBe(2);
  });
});

describe("flag-off parity and the number keys — the structural claims, at the source", () => {
  /* The rail group left `AppShell.tsx` for `shell-keys.tsx` with the rest of the rail (ARCH-022
     L6); the entity list and the partition are still the derivations'. `numberNav` is the name
     the resolver finds in the rail's frame — `railGroups` carries a type annotation. */
  const shell = stripComments(shellFrameOf("numberNav").source);
  const derivations = stripComments(shellFrameOf("folders").source);

  it("the folders group is SPREAD AWAY when off — no empty .rgroup may exist to differ by", () => {
    // The conditional spread is the parity mechanism: `consent.foldersEnabled ? [{...}] : []`.
    expect(shell).toMatch(/\.\.\.\(consent\.foldersEnabled\s*\n?\s*\? \[\{/);
  });

  it("the group contributes nothing to the number keys — items is empty and numberNav reads items", () => {
    expect(shell).toMatch(/\.\.\.\(consent\.foldersEnabled[\s\S]{0,200}items: \[\],/);
    expect(shell).toMatch(/railGroups\s*\n?\s*\.flatMap\(\(g\) => g\.items\)/);
  });

  it("the folder entities themselves are gated on the consent answer, not only the group", () => {
    // Stale mirror entities after a disable must not resurrect the rail.
    expect(derivations).toMatch(/consent\.foldersEnabled \? reader\.list<FolderEntity>\("folder"\) : \[\]/);
  });

  it("the History lens takes the same consent answer — the partition is flag-gated too", () => {
    /* The lens must not infer authority from eventually-deleted entities (client review,
       round 1): the partition CALL carries the flag, and the memo re-keys on it. Asked inside
       the call and not of the file: the rail hands the same pair down, so a file-wide match went
       on passing off that prop when the partition moved to `shell-derivations.ts`. */
    // The call takes the one options builder the lists and a press's read-back share, and the
    // builder carries the flag.
    expect(derivations).toMatch(/consentPartition\(reader, shellConsentOptions\(consent, now, ownAddresses, firstImportDoneAt\)\)/);
    expect(stripComments(readFileSync(`${process.cwd()}/apps/webapp/app/shell/consent-options.ts`, "utf8")))
      .toMatch(/return \{[\s\S]{0,1200}foldersEnabled: consent\.foldersEnabled,/);
    expect(derivations).toMatch(/consent\.foldersEnabled,\n\s*\],/);
  });
});

/** A quiet reach-past for the direct FolderView mounts: the mirror IS the mailbox here. */
const olderNone = {
  available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {},
};

describe("search hits route to the folder view only when it can show them", () => {
  it("openTargetFor: a held row targets the folder; an off-mirror row keeps the reader", async () => {
    const { openTargetFor } = await import("../app/shell/AppShell");
    const hit = {
      id: "m1", mailboxId: "mb1", folder: "Projects/Acme",
      from: { name: null, address: "a@x.example" },
    } as never;
    const noScreenerRow = () => null;
    // The callback owns the HOLDS question: null means "the view cannot show it" — the exact
    // archive-only case (GET /search reaching past this device's mirror window).
    const offMirror = openTargetFor(hit, false, noScreenerRow, undefined, undefined, undefined, () => null);
    expect(offMirror).toEqual({ kind: "reader", id: "m1" });
    const held = openTargetFor(hit, false, noScreenerRow, undefined, undefined, undefined, () => "fd1");
    expect(held).toEqual({ kind: "folder", folderId: "fd1", id: "m1" });
  });

  it("the shell's callback asks the PRESENTED mirror — pinned at the source", () => {
    // The unit above proves the plumbing; this pins the one decision the shell makes inside
    // the callback (mutating the holds check away stayed green without it, watched):
    // the row must be held by the presented mirror UNDER that folder, or the answer is null.
    const src = stripComments(shellFrameOf("openMessage").source);
    expect(src).toMatch(/const held = presented\.get<EngineMessage>\("message", hit\.id\);/);
    expect(src).toMatch(/return held && held\.folder === folder \? f\.id : null;/);
  });
});

describe("the folder view is windowed — a large folder never mounts whole", () => {
  it("renders a slice with spacer height standing in for the rest", async () => {
    const { FolderView: Raw } = await import("../app/views/FolderView");
    /* FolderView declares the message verbs (`useMessageVerbs`), so it needs a keymap. In the
       product it is always inside `AppShell`, which provides one; a bare mount brings its own
       rather than the hook going quiet when there is none — a view whose keys silently do not
       exist is the defect that wiring was. */
    const FolderView = (props: React.ComponentProps<typeof Raw>) =>
      h(KeymapProvider, { children: h(WithListGone, { children: h(Raw, props) }) });
    const many = Array.from({ length: 1000 }, (_, i) => ({
      id: `m${i}`,
      accountId: "acct", mailboxId: "mb1", threadId: null, messageIdHeader: null,
      subject: `Subject ${i}`, from: { name: null, address: `s${i}@example.com` },
      to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "Projects",
      snippet: "…", unread: i < 3, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "Europe/Zurich",
          children: h(FolderView, { onMarkSeen: () => {},
            folder: { id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@x.example" },
            messages: many as never[],
            older: olderNone,
            tags: [],
            now: new Date("2026-08-04T12:00:00.000Z"),
            onOpen: () => {},
            hydrateBody: () => {},
            onAction: () => {},
            onAddTag: () => {},
            onScreen: () => {}, canDelete: () => true, canReplyAll: () => true,
          }),
        }),
      ),
    );
    const rows = host!.querySelectorAll(".row[data-id]");
    // The jsdom fallback viewport over-renders deliberately (list-window.ts), but a thousands-of-rows
    // folder must still mount a WINDOW, not the folder — History's measured freeze, prevented.
    // The fixture is over FULL_RANGE_MAX_ROWS on purpose: past both floors, the window runs
    // whether or not a list measures its rows.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    // The unrendered remainder stands in the spacer, so the scrollbar tells the truth.
    const spacers = [...host!.querySelectorAll('[aria-hidden]')].filter((n) => (n as HTMLElement).style.height);
    expect(spacers.length).toBeGreaterThan(0);
    // The first group label is on screen with its first row.
    expect(host!.textContent).toContain("New");
  });

  it("a deep locate target is REVEALED — the window scrolls to mount the row it names", async () => {
    const { FolderView: Raw } = await import("../app/views/FolderView");
    /* FolderView declares the message verbs (`useMessageVerbs`), so it needs a keymap. In the
       product it is always inside `AppShell`, which provides one; a bare mount brings its own
       rather than the hook going quiet when there is none — a view whose keys silently do not
       exist is the defect that wiring was. */
    const FolderView = (props: React.ComponentProps<typeof Raw>) =>
      h(KeymapProvider, { children: h(WithListGone, { children: h(Raw, props) }) });
    const many = Array.from({ length: 1000 }, (_, i) => ({
      id: `m${i}`,
      accountId: "acct", mailboxId: "mb1", threadId: null, messageIdHeader: null,
      subject: `Subject ${i}`, from: { name: null, address: `s${i}@example.com` },
      to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "Projects",
      snippet: "…", unread: false, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "Europe/Zurich",
          children: h(FolderView, { onMarkSeen: () => {},
            folder: { id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@x.example" },
            messages: many as never[],
            locateId: "m400",
            older: olderNone,
            tags: [],
            now: new Date("2026-08-04T12:00:00.000Z"),
            onOpen: () => {},
            hydrateBody: () => {},
            onAction: () => {},
            onAddTag: () => {},
            onScreen: () => {}, canDelete: () => true, canReplyAll: () => true,
          }),
        }),
      ),
    );
    // The row is deep below the initial slice, so the reveal effect must have SCROLLED —
    // that write is the whole mechanism: the slice derives from scrollTop.
    const scroller = host!.querySelector(".scroller") as HTMLElement;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    // jsdom fires no scroll event for a programmatic scrollTop write; dispatching it is the
    // browser half the DOM cannot do — after it, the window has re-derived and the row exists.
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
      // The hook batches its re-derivation behind requestAnimationFrame; give the frame a beat.
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(host!.querySelector('[data-id="m400"]')).not.toBeNull();
    // …and the reading column shows the hit, not the first row.
    expect(host!.textContent).toContain("Subject 400");

    // CLOSING THE READER clears the URL tail — the target must have become the SELECTION, so
    // the column keeps the hit instead of snapping back to the first row.
    await act(() =>
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "Europe/Zurich",
          children: h(FolderView, { onMarkSeen: () => {},
            folder: { id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@x.example" },
            messages: many as never[],
            locateId: null,
            older: olderNone,
            tags: [],
            now: new Date("2026-08-04T12:00:00.000Z"),
            onOpen: () => {},
            hydrateBody: () => {},
            onAction: () => {},
            onAddTag: () => {},
            onScreen: () => {}, canDelete: () => true, canReplyAll: () => true,
          }),
        }),
      ),
    );
    expect(host!.textContent).toContain("Subject 400");
  });

  it("a target that arrives LATE — after the folder entity — is still revealed", async () => {
    const { FolderView: Raw } = await import("../app/views/FolderView");
    /* FolderView declares the message verbs (`useMessageVerbs`), so it needs a keymap. In the
       product it is always inside `AppShell`, which provides one; a bare mount brings its own
       rather than the hook going quiet when there is none — a view whose keys silently do not
       exist is the defect that wiring was. */
    const FolderView = (props: React.ComponentProps<typeof Raw>) =>
      h(KeymapProvider, { children: h(WithListGone, { children: h(Raw, props) }) });
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      accountId: "acct", mailboxId: "mb1", threadId: null, messageIdHeader: null,
      subject: `Subject ${i}`, from: { name: null, address: `s${i}@example.com` },
      to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "Projects",
      snippet: "…", unread: false, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    }));
    const props = (msgs: unknown[], locateId: string | null) => ({
      onMarkSeen: () => {},
      folder: { id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@x.example" },
      messages: msgs as never[],
      locateId,
      older: olderNone,
      tags: [],
      now: new Date("2026-08-04T12:00:00.000Z"),
      onOpen: () => {},
      hydrateBody: () => {},
      onAction: () => {},
      onAddTag: () => {},
      onScreen: () => {}, canDelete: () => true, canReplyAll: () => true,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // A cold restore: the URL names m400 but the mirror's later pages have not arrived — only
    // 50 rows exist and the target is not among them.
    await act(() =>
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "Europe/Zurich",
        children: h(FolderView, props(mk(50), "m400")),
      })),
    );
    const scroller = host!.querySelector(".scroller") as HTMLElement;
    expect(scroller.scrollTop).toBe(0);
    // The page carrying the target drains in. The reveal must fire NOW, on arrival —
    // a target-only dependency never ran again (the review's cold-restore finding).
    await act(() =>
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "Europe/Zurich",
        children: h(FolderView, props(mk(1000), "m400")),
      })),
    );
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(host!.textContent).toContain("Subject 400");
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

type Verbs = NonNullable<Parameters<typeof FoldersRailGroup>[0]["verbs"]>;

function spyVerbs(over: Partial<Verbs> = {}): { verbs: Verbs; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    verbs: {
      create: async (mb, name) => { calls.push(`create:${mb}:${name}`); },
      rename: async (id, name) => { calls.push(`rename:${id}:${name}`); },
      remove: async (id) => { calls.push(`remove:${id}`); },
      dismiss: (id) => { calls.push(`dismiss:${id}`); },
      summary: async (id) => { calls.push(`summary:${id}`); return { folders: 2, messages: 5 }; },
      ...over,
    },
  };
}

async function mountVerbs(
  folders: FolderEntity[],
  opts: {
    verbs: Verbs;
    accountMailboxes?: Array<{ id: string; label: string }>;
  },
): Promise<{ el: HTMLElement }> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() =>
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "Europe/Zurich",
        children: h(FoldersRailGroup, {
          folders,
          unread: new Map<string, number>(),
          onNavigate: () => {},
          verbs: opts.verbs,
          accountMailboxes: opts.accountMailboxes,
        }),
      }),
    ),
  );
  return { el: host };
}

const type = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async (input: HTMLElement, key: string) => {
  await act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

describe("stage 2 — the read-only render stays the foundation's", () => {
  it("without verbs there is no … affordance and no create row anywhere", async () => {
    const { el } = await mount([folder("Projects"), folder("Invoices")]);
    expect(el.querySelector(".fmore")).toBeNull();
    expect(el.textContent).not.toContain("New folder");
  });
});

describe("stage 2 — create", () => {
  it("the section's own affordance names the mailbox; Enter dispatches the FULL canonical path", async () => {
    const { verbs, calls } = spyVerbs();
    const { el } = await mountVerbs([folder("Projects")], { verbs });
    await click(el.querySelector('[data-testid="folder-new-mb1"]'));
    const input = el.querySelector<HTMLInputElement>(".ritem-new-input")!;
    await type(input, "Steuern 2026");
    await press(input, "Enter");
    expect(calls).toEqual(["create:mb1:Steuern 2026"]);
  });

  it("a mailbox with ZERO folders still offers the create — the account list makes the section", async () => {
    const { verbs } = spyVerbs();
    const { el } = await mountVerbs([], {
      verbs,
      accountMailboxes: [{ id: "mb9", label: "empty@x.example" }],
    });
    expect(el.querySelector('[data-testid="folder-new-mb9"]')).not.toBeNull();
  });

  it("a reserved name is refused BEFORE the wire, with the sentence — nothing dispatches", async () => {
    const { verbs, calls } = spyVerbs();
    const { el } = await mountVerbs([folder("Projects")], { verbs });
    await click(el.querySelector('[data-testid="folder-new-mb1"]'));
    const input = el.querySelector<HTMLInputElement>(".ritem-new-input")!;
    await type(input, "Spam");
    await press(input, "Enter");
    expect(calls).toEqual([]);
    expect(el.querySelector(".fproblem")?.textContent).toContain("reserved");
  });

  it("a taken name is refused BEFORE the wire — the collision the server would 409", async () => {
    const { verbs, calls } = spyVerbs();
    const { el } = await mountVerbs([folder("Projects")], { verbs });
    await click(el.querySelector('[data-testid="folder-new-mb1"]'));
    const input = el.querySelector<HTMLInputElement>(".ritem-new-input")!;
    await type(input, "Projects");
    await press(input, "Enter");
    expect(calls).toEqual([]);
    expect(el.querySelector(".fproblem")?.textContent).toContain("already exists");
  });
});

describe("stage 2 — the … menu", () => {
  it("carries exactly Rename / New subfolder / Delete…, and only on settled rows", async () => {
    const pending: FolderEntity = { ...folder("Busy"), op: { kind: "create" } };
    const { verbs } = spyVerbs();
    const { el } = await mountVerbs([folder("Projects"), pending], { verbs });
    // The pending row has no … at all — a second command on one folder has no defined order.
    const rows = [...el.querySelectorAll(".frow")];
    const busyRow = rows.find((r) => r.textContent?.includes("Busy"))!;
    expect(busyRow.querySelector(".fmore")).toBeNull();

    const projRow = rows.find((r) => r.textContent?.includes("Projects"))!;
    await click(projRow.querySelector(".fmore"));
    const items = [...el.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent);
    expect(items).toEqual(["Rename", "New subfolder", "Delete…"]);
  });

  it("New subfolder dispatches parent/leaf and the input sits under the parent", async () => {
    const { verbs, calls } = spyVerbs();
    const { el } = await mountVerbs([folder("Projects")], { verbs });
    await click(el.querySelector(".fmore"));
    const sub = [...el.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent === "New subfolder");
    await click(sub!);
    const input = el.querySelector<HTMLInputElement>(".ritem-new-input")!;
    await type(input, "Acme");
    await press(input, "Enter");
    expect(calls).toEqual(["create:mb1:Projects/Acme"]);
  });

  it("Rename swaps the row for an input seeded with the LEAF and dispatches the new full path", async () => {
    const { verbs, calls } = spyVerbs();
    const { el } = await mountVerbs([folder("Projects"), folder("Projects/Acme")], { verbs });
    // open the branch, then rename the child
    await click(el.querySelector("button.ftw"));
    const rows = [...el.querySelectorAll(".frow")];
    const child = rows.find((r) => r.textContent?.includes("Acme"))!;
    await click(child.querySelector(".fmore"));
    const rename = [...el.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent === "Rename");
    await click(rename!);
    const input = el.querySelector<HTMLInputElement>(".ritem-new-input")!;
    expect(input.value).toBe("Acme");
    await type(input, "Acme 2026");
    await press(input, "Enter");
    expect(calls).toEqual(["rename:f-mb1-Projects/Acme:Projects/Acme 2026"]);
  });
});

describe("stage 2 — the delete ceremony asks FIRST, with the server's numbers", () => {
  it("Delete… fetches the summary, states it, and only 'Delete folder' dispatches", async () => {
    const { verbs, calls } = spyVerbs();
    const { el } = await mountVerbs([folder("Projects")], { verbs });
    await click(el.querySelector(".fmore"));
    const del = [...el.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent === "Delete…");
    await click(del!);
    // One tick for the summary promise.
    await act(async () => {});
    expect(calls).toEqual(["summary:f-mb1-Projects"]);
    const confirm = el.querySelector(".fconfirm")!;
    expect(confirm.textContent).toContain("5 messages");
    expect(confirm.textContent).toContain("2 folders");
    expect(confirm.textContent).toContain("Trash");

    const go = [...el.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent === "Delete folder");
    await click(go!);
    expect(calls).toEqual(["summary:f-mb1-Projects", "remove:f-mb1-Projects"]);
  });

  it("Cancel dispatches nothing; a failed count still asks, without numbers", async () => {
    const { verbs, calls } = spyVerbs({ summary: async (id) => { calls.push(`summary:${id}`); return null; } });
    const { el } = await mountVerbs([folder("Projects")], { verbs });
    await click(el.querySelector(".fmore"));
    const del = [...el.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent === "Delete…");
    await click(del!);
    await act(async () => {});
    expect(el.querySelector(".fconfirm")!.textContent).toContain("Trash");
    expect(el.querySelector(".fconfirm")!.textContent).not.toMatch(/\d/);
    const cancel = [...el.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent === "Cancel");
    await click(cancel!);
    expect(calls).toEqual(["summary:f-mb1-Projects"]);
    expect(el.querySelector(".fconfirm")).toBeNull();
  });
});

describe("stage 2 — the honest middle: pending and failed rows", () => {
  it("a pending create dims with the sentence in its title; a pending rename wears the TARGET leaf", async () => {
    const creating: FolderEntity = { ...folder("Neu"), op: { kind: "create" } };
    const renaming: FolderEntity = { ...folder("Alt"), id: "f-r", op: { kind: "rename", to: "Danach" } };
    const { verbs } = spyVerbs();
    const { el } = await mountVerbs([creating, renaming], { verbs });
    const rows = [...el.querySelectorAll(".frow .ritem")];
    const neu = rows.find((r) => r.getAttribute("title")?.includes("created"))!;
    expect(neu.className).toContain("fpend");
    const ren = rows.find((r) => r.getAttribute("title")?.includes("renamed"))!;
    expect(ren.textContent).toContain("Danach");
    expect(ren.textContent).not.toContain("Alt");
  });

  it("a failed command carries its sentence and OK dispatches the dismiss", async () => {
    const failed: FolderEntity = { ...folder("Kaputt"), op: { kind: "rename", to: "X", error: "exists" } };
    const { verbs, calls } = spyVerbs();
    const { el } = await mountVerbs([failed], { verbs });
    const problem = el.querySelector(".fproblem")!;
    expect(problem.textContent).toContain("already exists");
    await click(problem.querySelector(".fdismiss"));
    expect(calls).toEqual(["dismiss:f-mb1-Kaputt"]);
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
    const { el } = await mount([failed]);

    expect(rowLabels(el)).toEqual(["Proj"]);            // the folder is still there
    const strip = el.querySelector(".fproblem[role='alert']");
    expect(strip?.textContent ?? "").toContain(messages.rail.folderErrGotMail);
    expect(messages.rail.folderErrGotMail).toContain("it was not deleted");
    // NOT the catch-all. A refusal that reads "your mail server refused this change" tells the
    // person nothing about the mail that arrived, and nothing about pressing Delete again.
    expect(strip?.textContent ?? "").not.toContain(messages.rail.folderErrRefused);
  });
});
