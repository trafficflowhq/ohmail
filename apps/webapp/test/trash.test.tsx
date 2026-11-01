/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { KeymapProvider as KeymapProviderRaw } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import {
  createDeleteUndo,
  replayDeleteIntents,
  restoreDispatch,
  UNDO_MS,
} from "../app/shell/delete-undo";
import { armDeleteIntent, deleteIntentsKey, takeDeleteIntents } from "../app/shell/delete-intents";
import { shellFrameOf, shellFramePaths } from "./source-anchor.js";
import { TrashView } from "../app/views/TrashView";
import type { TrashPage } from "../app/shell/trash-page";
import en from "../messages/en.json";
import de from "../messages/de.json";

/** Every view mount here sits under the keymap; the list surface's shell half rides with it. */
const KeymapProvider = ({ children }: { children?: React.ReactNode }) =>
  React.createElement(KeymapProviderRaw, { children: React.createElement(WithListGone, { children }) });

/**
 * TRASH — THE HELD RESTORE, THE JOURNAL'S VERB, THE RAIL'S PARITY AND THE TWO CHORDS.
 *
 * Every case here is a product property the spec names, and each one is watched failing by a
 * mutation recorded in the lane's report. The three that carry the most weight:
 *
 *  · a `{kind:"restore"}` row replayed with NO restore dispatch must be DROPPED and must NOT be
 *    sent to `mutate` — which would DELETE the message somebody asked to put back. That is the
 *    one outcome in this whole feature worse than losing the request;
 *  · the rail outside Trash is byte-identical, asserted at the SOURCE, because the property is
 *    structural: no `.rgroup` may exist to be styled differently;
 *  · the place sentence is raised by the window's DISPATCH and not at the press — a second
 *    `restoreFromTrash` call at the press would issue the request immediately and cancel the
 *    undo window with every other guard still green.
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

// ── the held restore ────────────────────────────────────────────────────────────────────────

/** A restore window over injected timers, so the commit is stepped rather than waited for. */
function restoreWindow(opts: { rollback?: boolean; unavailable?: boolean } = {}) {
  const sent: string[] = [];
  const said: string[] = [];
  const places: string[] = [];
  /** Which intent each request named — the restore's `Idempotency-Key` is built from it. */
  const intents: string[] = [];
  let actions: Array<() => void> = [];
  let fire: Array<() => void> = [];
  const queue = createDeleteUndo({
    verb: "restore",
    mutate: restoreDispatch(
      async (id, o) => {
        sent.push(id);
        intents.push(o.intentId);
        if (opts.unavailable) return { state: "unavailable" };
        if (opts.rollback) return { state: "rolled_back" };
        return { state: "restored", restoreTo: "ohmail/News" };
      },
      (restoreTo) => places.push(restoreTo),
    ),
    toast: (msg, o) => {
      said.push(msg);
      if (o?.onAction) actions.push(o.onAction);
    },
    copy: {
      deleted: en.trash.restoring,
      undo: en.screener.toastUndo,
      undone: en.trash.toastRestoreUndone,
      failed: en.trash.toastRestoreFailed,
      noUndo: en.session.noUndoHere,
    },
    onHeld: () => {},
    refusal: () => null,
    setTimer: (fn) => { fire.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => { fire = []; },
    now: () => 1_000_000,
    pressId: () => "press-1",
  });
  return {
    queue, sent, said, places, intents,
    undo: () => { const a = actions; actions = []; a.forEach((f) => f()); },
    close: () => { const f = fire; fire = []; f.forEach((fn) => fn()); },
  };
}

describe("the held restore", () => {
  it("hides the row, says Restoring…, and sends NOTHING until the window closes", () => {
    const w = restoreWindow();
    expect(w.queue.remove({ id: "m1", mailboxId: "mb1" })).toBe(true);
    expect(w.said[0]).toBe(en.trash.restoring);
    expect([...w.queue.held()]).toEqual(["m1"]);
    /* THE WHOLE POINT OF THE WINDOW. Mutation watched: raising the place toast at the press —
       a second `restoreFromTrash(id)` call in the `restore` arm — makes this assertion read
       `[ "m1" ]`, i.e. the request went out with the Undo still on screen. */
    expect(w.sent, "nothing on the wire yet").toEqual([]);
    expect(w.places, "and no place claimed yet").toEqual([]);
  });

  it("commits when the window closes, and the place is named by the SERVER's answer", async () => {
    const w = restoreWindow();
    w.queue.remove({ id: "m1", mailboxId: "mb1" });
    w.close();
    expect(w.sent).toEqual(["m1"]);
    /* The place arrives with the response, so the assertion is after the microtasks. That the
       two are separate MOMENTS is the property: the toast said "Restoring…" at the press and
       cannot have named a place then, because the server had not answered. */
    await Promise.resolve();
    await Promise.resolve();
    expect(w.places, "the destination the server resolved, not the row's").toEqual(["ohmail/News"]);
    /* AND THE REQUEST NAMES THE PRESS. The journal row for this window carries the same id, so
       the replay after a killed tab arrives under the same `Idempotency-Key` and the server
       answers it as applied rather than 409 `not_in_trash`. Mutation watched: dispatching
       without the press id makes this `[undefined]`. */
    expect(w.intents, "the press's own id, the one the journal holds").toEqual(["press-1"]);
  });

  it("Undo inside the window cancels a restore that never happened", () => {
    const w = restoreWindow();
    w.queue.remove({ id: "m1", mailboxId: "mb1" });
    w.undo();
    expect(w.said).toContain(en.trash.toastRestoreUndone);
    expect(w.sent, "the request was never made").toEqual([]);
    expect([...w.queue.held()], "and the row is back").toEqual([]);
  });

  it("a refusal puts the row back and says the mail is still in Trash", async () => {
    const w = restoreWindow({ rollback: true });
    w.queue.remove({ id: "m1", mailboxId: "mb1" });
    w.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(w.said).toContain(en.trash.toastRestoreFailed);
    expect(w.places, "no place is claimed for a press that did not take effect").toEqual([]);
  });

  it("a transport that VANISHED mid-flight reads as a refusal, never as a success", async () => {
    /* `unavailable` is the literal answer and `rolled_back` is the honest one: the surface only
       wires this when `trashAvailable()` is true, so reaching it means the capability went away
       after the press. Mapping it to a success would leave the row missing from the list with
       the message still in Trash. */
    const w = restoreWindow({ unavailable: true });
    w.queue.remove({ id: "m1", mailboxId: "mb1" });
    w.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(w.said).toContain(en.trash.toastRestoreFailed);
  });

  it("a reader's press is refused WHOLE — nothing held, nothing hidden, nothing sent", () => {
    const sent: string[] = [];
    const said: string[] = [];
    const queue = createDeleteUndo({
      verb: "restore",
      mutate: async (id) => { sent.push(id); return { status: "applied" }; },
      toast: (m) => said.push(m),
      copy: { deleted: en.trash.restoring, undo: en.screener.toastUndo, undone: en.trash.toastRestoreUndone, failed: en.trash.toastRestoreFailed, noUndo: en.session.noUndoHere },
      onHeld: () => {},
      refusal: () => "another install organizes this mailbox",
    });
    expect(queue.remove({ id: "m1", mailboxId: "mb1" }), "answers false so the caller runs no side effects").toBe(false);
    expect(said).toEqual(["another install organizes this mailbox"]);
    expect(sent).toEqual([]);
    expect([...queue.held()]).toEqual([]);
  });

  it("the window duration is UNDO_MS — one number for the toast and the timer", () => {
    let ms = -1;
    const queue = createDeleteUndo({
      verb: "restore",
      mutate: async () => ({ status: "applied" }),
      toast: () => {},
      copy: { deleted: "d", undo: "u", undone: "un", failed: "f", noUndo: "nu" },
      onHeld: () => {},
      refusal: () => null,
      setTimer: (_fn, at) => { ms = at; return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    queue.remove({ id: "m1" });
    expect(ms).toBe(UNDO_MS);
  });
});

// ── the sentence the place is named in ──────────────────────────────────────────────────────

describe("the restore's place sentence states the state it is in", () => {
  /* The server's answer to a restore is a QUEUED intent: it writes the desired folder and the
     mail server performs the move on the organizer's next turn. The sentence said on that answer
     used to be "Restored to {place}." — a completed restore claimed seconds before anything had
     moved, so an outage left the person told their mail was back while it sat in Trash. */
  it("both catalogues say it is in progress, and neither claims it is done", () => {
    for (const [name, cat] of [["en", en], ["de", de]] as const) {
      const said = (cat.trash as Record<string, string>).toastRestoringTo;
      expect(said, `${name} carries the sentence`).toBeTruthy();
      expect(said, `${name} names the place the server resolved`).toContain("{place}");
      // The catalogue's own mark for an unfinished action — `trash.restoring` carries it too.
      expect(said, `${name} reads as unfinished`).toContain("…");
      expect(
        (cat.trash as Record<string, string>).toastRestored,
        `${name} no longer carries a completed-restore sentence`,
      ).toBeUndefined();
    }
  });

  it("the dispatch's callback raises that sentence and no other", () => {
    /* ASKED OF EVERY SHELL FRAME. The restore window's dispatch left `AppShell.tsx` with the
       dispatch spine (`shell-dispatch.ts`), and the negative half has to cover both frames or a
       completed-restore claim could simply move to the one nobody reads. */
    const shell = shellFramePaths(process.cwd())
      .map((at) => stripComments(readFileSync(at, "utf8"))).join("\n");
    expect(shell).toContain('toast(t("trash.toastRestoringTo", { place: placeLabel(restoreTo) }))');
    expect(shell, "nothing in the shell claims a completed restore").not.toContain("trash.toastRestored\"");
  });
});

// ── the journal's verb ──────────────────────────────────────────────────────────────────────

describe("the intents journal carries which verb it holds", () => {
  it("a restore press writes kind:restore; a delete press writes kind:delete", () => {
    const w = restoreWindow();
    w.queue.remove({ id: "m1", mailboxId: "mb1" });
    const rows = takeDeleteIntents(1_000_001);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("restore");
    expect(rows[0]!.messageIds).toEqual(["m1"]);
  });

  it("a row a PREVIOUS build wrote — no kind at all — reads as a delete", () => {
    window.localStorage.setItem(
      deleteIntentsKey(),
      JSON.stringify([{ id: "old", messageIds: ["m9"], at: 1_000_000 }]),
    );
    const rows = takeDeleteIntents(1_000_001);
    expect(rows[0]!.kind, "the legacy shape, not dropped").toBe("delete");
  });

  it("a row naming a verb this build does not know is DROPPED, never approximated", () => {
    window.localStorage.setItem(
      deleteIntentsKey(),
      JSON.stringify([{ id: "future", messageIds: ["m9"], at: 1_000_000, kind: "shred" }]),
    );
    expect(takeDeleteIntents(1_000_001), "replaying it as a delete would delete on a guess").toEqual([]);
  });

  it("a stranded RESTORE with no restore dispatch is DROPPED and is NEVER sent to mutate", () => {
    /* THE ONE OUTCOME WORSE THAN LOSING THE REQUEST. A surface with the delete key and no
       restore transport (the demo, an older server) must not fall through: `mutate` is the
       DELETE, and sending a held restore there would delete the message somebody asked to put
       back. Mutation watched: with the `fn === undefined` arm removed, `mutate` is called with
       "m9". */
    armDeleteIntent({ id: "p1", messageIds: ["m9"], at: 1_000_000, kind: "restore" });
    const mutate = vi.fn(async (_id: string) => ({ status: "applied" }));
    const count = replayDeleteIntents(mutate, 1_000_001);
    expect(count).toBe(1);
    expect(mutate, "the delete dispatch was not called").not.toHaveBeenCalled();
    expect(takeDeleteIntents(1_000_002), "and the row is gone rather than retried for ever").toEqual([]);
  });

  it("a stranded RESTORE with a restore dispatch is replayed AS A RESTORE", () => {
    armDeleteIntent({ id: "p1", messageIds: ["m9"], at: 1_000_000, kind: "restore" });
    armDeleteIntent({ id: "p2", messageIds: ["m8"], at: 1_000_000, kind: "delete" });
    /* TYPED spies. `vi.fn(async () => …)` has no parameters, so `calls[n][0]` is an element of
       an empty tuple and the file does not compile — which the webapp's typecheck catches and
       almost nothing else in this repository would. */
    const mutate = vi.fn(async (_id: string, _p: string) => ({ status: "applied" }));
    const restore = vi.fn(async (_id: string, _p: string) => ({ status: "applied" }));
    replayDeleteIntents(mutate, 1_000_001, restore);
    expect(restore.mock.calls.map((c) => c[0])).toEqual(["m9"]);
    expect(mutate.mock.calls.map((c) => c[0])).toEqual(["m8"]);
    /* AND UNDER THE PRESS'S OWN ID. The restore route is `idempotent`-marked, and this replay is
       exactly the request whose first response was lost: it has to arrive under the key that
       first attempt used, or the server measures the state it already wrote and answers 409
       `not_in_trash` — which the surface says as "Couldn't restore". The journalled press id is
       what makes the two tellable apart, so it travels with the dispatch. */
    expect(restore.mock.calls.map((c) => c[1]), "the journalled press id, not a fresh one").toEqual(["p1"]);
    expect(mutate.mock.calls.map((c) => c[1])).toEqual(["p2"]);
  });
});

// ── the rail, the palette and the chords: source-level structure ────────────────────────────

describe("the transient rail entry and the two chords", () => {
  /* THE FRAME THAT DECLARES THEM: the rail's groups, the global chords and the palette list left
     `AppShell.tsx` for `shell-keys.tsx` (ARCH-022 L6). Anchored on `noCursor` — the key map's own
     disabled reason — because the resolver matches `const <name> =` and every list in this frame
     (`railGroups`, `globalKeys`, `commands`) carries a type annotation instead. */
  const shell = stripComments(shellFrameOf("noCursor").source);

  it("the Trash group is SPREAD AWAY off-route — no empty .rgroup may exist to differ by", () => {
    /* The parity mechanism, and the reason it is asserted at the source: "byte-identical"
       cannot be measured by rendering one rail, and a hidden node would satisfy any DOM
       assertion that only looked for the label. `folders-rail.test.tsx` pins the Folders
       group's identical shape for the identical reason. */
    expect(shell).toContain('...(route.view === "trash"');
    expect(shell).toContain("        : []),");
    // And the group contributes NOTHING to the number keys.
    const at = shell.indexOf('...(route.view === "trash"');
    expect(at).toBeGreaterThan(0);
    expect(shell.slice(at, at + 200)).toContain("items: [],");
  });

  it("the entry is placed AFTER the Folders group and BEFORE the dock", () => {
    const folders = shell.indexOf("consent.foldersEnabled");
    const trash = shell.indexOf('...(route.view === "trash"');
    /* "Before the dock" is now "before the memo that consumes the list": `railDock` is JSX and
       stayed in `AppShell.tsx`, so the order that can still be READ is the one inside the rail's
       own frame — Folders, then Trash, then `railGroupsWithHints`, which is the last thing
       between `railGroups` and the rail. */
    const railRender = shell.indexOf("const railGroupsWithHints");
    expect(folders).toBeGreaterThan(0);
    expect(trash).toBeGreaterThan(folders);
    expect(railRender).toBeGreaterThan(trash);
  });

  it("`g t` and the palette row read ONE message — the destination-row rule", () => {
    /* Two lists of the same instruction. When each had its own key they drifted ("Go to Ohbox"
       against "Go to the Ohbox"), reported as the palette and the sheet disagreeing. */
    expect(shell).toContain('chord: "g t"');
    expect(shell).toContain('id: "go-trash"');
    const chord = shell.indexOf('chord: "g t"');
    const row = shell.indexOf('id: "go-trash"');
    expect(shell.slice(chord, chord + 200)).toContain('t("shortcuts.goTrash")');
    expect(shell.slice(row, row + 260)).toContain('t("shortcuts.goTrash")');
  });

  it("both are DISABLED where the client has no Trash transport, and the reason is the copy", () => {
    expect(shell).toContain("disabled: !engine.trashAvailable()");
    /* A TOKEN, not a sentence — `keymap.tsx#DisabledReason`. The shell says WHICH reason and the
       `?` sheet owns the words, so the two lists of this instruction cannot drift by a word. */
    expect(shell).toContain('disabledReason: "trash_unavailable"');
  });

  it("the delete keys are DISABLED in Trash and carry the no-erase sentence", () => {
    expect(shell).toContain('&& route.view !== "trash"');
    expect(shell).toContain('disabledReason: "no_erase"');
  });

  it("`⇧⌫` restores, and only in Trash", () => {
    expect(shell).toContain('chord: "shift+Backspace"');
    const at = shell.indexOf('chord: "shift+Backspace"');
    expect(shell.slice(at, at + 320)).toContain('t("trash.restoreKey")');
    expect(shell.slice(at, at + 320)).toContain('route.view !== "trash"');
    // A held key is one press; a question on screen owns the key — `deleteKeyBindings`' pair.
    expect(shell.slice(at, at + 460)).toContain("!e.repeat && !isModalOpen(");
  });

  it("the `?` sheet prints the reason on an INERT row and nowhere else", () => {
    const sheet = stripComments(read("../app/shell/ShortcutSheet.tsx"));
    /* One sentence per token, and the row carries a reason only while it is inert: the fold
       reads `b.disabled === true ? b.disabledReason : undefined`, so an active binding's
       explanation never reaches a row. */
    expect(sheet).toContain("const reason = b.disabled === true ? b.disabledReason : undefined;");
    expect(sheet).toContain("{...(row.reason ? { title: REASON_TEXT[row.reason] } : {})}");
    expect(sheet).toContain("no_erase: tRoot(\"trash.noErase\")");
    expect(sheet).toContain("trash_unavailable: tRoot(\"trash.unavailable\")");
  });

  it("the entry's motion is ENTER ONLY, and none under reduced motion", () => {
    const css = read("../../../packages/ui/src/composites/rail.css");
    expect(css).toContain(".trash-rail{animation:trash-in .22s var(--swift) both}");
    expect(css).toContain("@keyframes trash-in{from{opacity:0;translate:0 4px}to{opacity:1;translate:none}}");
    expect(css).toContain("@media (prefers-reduced-motion:reduce){.trash-rail{animation:none}}");
    // A LEAVE animation would hold the rail non-identical for its own duration.
    expect(css).not.toContain("trash-out");
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

async function mount(
  p: TrashPage, catalogue: typeof en = en, locale = "en",
  onAction: (a: string, m: { id: string }) => void = () => {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() =>
    root!.render(
      /* `children` IN the props object — the shape `folders-rail.test.tsx` uses, and the one
         that typechecks: the variadic form leaves `children` missing from the props type when
         `messages` is widened. */
      h(NextIntlClientProvider, {
        locale,
        messages: catalogue as typeof en,
        timeZone: "UTC",
        children: h(KeymapProvider, {
          children: h(TrashView, {
            page: p, tags: [], now: new Date("2026-09-09T11:00:00.000Z"),
            onOpen: () => {}, hydrateBody: () => {}, onAction, onAddTag: () => {},
          } as never),
        }),
      }),
    ),
  );
  return host!;
}

describe("the Trash view", () => {
  it("says TRASH IS NOT AVAILABLE HERE rather than showing an empty bin", async () => {
    const el = await mount(page({ available: false }));
    expect(el.textContent).toContain(en.trash.unavailable);
    /* An empty list would read as "you have deleted nothing", which is a claim about a mailbox
       this client does not have. */
    expect(el.textContent).not.toContain(en.trash.empty);
  });

  it("says nothing about emptiness until the server has answered", async () => {
    const el = await mount(page({ exhausted: false, loading: true }));
    expect(el.textContent).not.toContain(en.trash.empty);
  });

  it("says the bin is empty once the walk is exhausted", async () => {
    const el = await mount(page({ exhausted: true }));
    expect(el.textContent).toContain(en.trash.empty);
  });

  it("carries the SCOPE sentence whether or not there are rows", async () => {
    const empty = await mount(page({ exhausted: true }));
    expect(empty.textContent).toContain(en.trash.foot);
    if (root) await act(() => root!.unmount());
    root = null; host?.remove(); host = null;
    const full = await mount(page({ items: [row("m1")] as never }));
    expect(full.textContent).toContain(en.trash.foot);
  });

  it("the row's stamp says WHEN IT WAS DELETED, not when the message was sent", async () => {
    const el = await mount(page({ items: [row("m1")] as never }));
    /* `.row .t.num` — SCOPED. `MessageRow` renders no stamp span at all when `time` is absent,
       so an unscoped query falls through to the reading pane's own stamp (`MessageCard`) and
       the negative case below would read the message's date from the WRONG element. Measured:
       unscoped, that case reported "1 Jan" and looked like a product defect. */
    const stamp = el.querySelector(".row .t.num");
    /* 09:00 deleted against an 11:00 clock — two hours. The message's own date is 2026-01-01,
       so a stamp built from it could not read "2 hours ago" by accident. */
    expect(stamp?.textContent).toContain("2 hours ago");
    expect(stamp?.textContent).not.toContain("Jan");
  });

  it("a row with NO trashedAt shows no stamp rather than the message's own date", async () => {
    const el = await mount(page({ items: [row("m1", { trashedAt: undefined })] as never }));
    /* A date in the deletion slot would be READ as a deletion time, which is a false statement;
       an empty slot is merely quiet. */
    expect(el.querySelector(".row .t.num"), "no stamp element at all in the row").toBeNull();
  });

  it("glosses where a restore would put it, in the reader's own words", async () => {
    const el = await mount(page({ items: [row("m1")] as never }));
    const gloss = el.querySelector(".trash-to");
    expect(gloss?.textContent, "the view label for one of the six").toBe("← News");
  });

  it("glosses a USER folder by its leaf, and an absent restoreTo as the inbox", async () => {
    const el = await mount(page({
      items: [row("m1", { restoreTo: "Archive/2026/Q1" }), row("m2", { restoreTo: undefined })] as never,
    }));
    const glosses = [...el.querySelectorAll(".trash-to")].map((n) => n.textContent);
    expect(glosses).toEqual(["← Q1", "← Ohbox"]);
  });

  it("renders in GERMAN from the same keys", async () => {
    const el = await mount(page({ exhausted: true }), de as unknown as typeof en, "de");
    expect(el.textContent).toContain(de.trash.empty);
    expect(el.textContent).toContain(de.trash.foot);
  });

  it("⇧⌫ restores the row the column shows — what the Restore button beside it does", async () => {
    const acted: Array<[string, string]> = [];
    await mount(page({ items: [row("m1"), row("m2")] as never }), en, "en", (a, m) => acted.push([a, m.id]));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(acted).toEqual([["restore", "m1"]]);
  });

  it("the heading is the RAIL'S OWN WORD, so the sidebar and the pane cannot differ by one", async () => {
    const el = await mount(page({ exhausted: true }));
    expect(el.querySelector(".lp-head")?.textContent ?? el.textContent).toContain(en.rail.trash);
  });
});

describe("a letter listed late never takes the cursor or the reader", () => {
  /* jsdom has no `CSS`; the ↓ step scrolls its row into view with `CSS.escape`. */
  const hadCss = typeof (globalThis as { CSS?: unknown }).CSS !== "undefined";
  beforeEach(() => {
    if (!hadCss) (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
  });
  afterEach(() => {
    if (!hadCss) (globalThis as { CSS?: unknown }).CSS = undefined;
  });
  it("the delete that lands after its Undo window lists on top; the letter shown stays shown and ⇧⌫ restores it", async () => {
    const { useTrashPage } = await import("../app/shell/trash-page");
    const listTrash = vi.fn()
      .mockResolvedValueOnce({ state: "ready", items: [row("m1"), row("m2")], nextCursor: null })
      .mockResolvedValue({ state: "ready", items: [row("u8"), row("m1"), row("m2")], nextCursor: null });
    const engine = { trashAvailable: () => true, listTrash } as never;
    const acted: Array<[string, string]> = [];
    function Bin({ landed }: { landed: number }) {
      return h(TrashView, {
        page: useTrashPage(engine, true, new Set(), landed), tags: [], now: new Date("2026-09-09T11:00:00.000Z"),
        onOpen: () => {}, hydrateBody: () => {}, onAction: (a: string, m: { id: string }) => acted.push([a, m.id]), onAddTag: () => {},
      } as never);
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const draw = (landed: number) => act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", children: h(KeymapProvider, { children: h(Bin, { landed }) }),
      }));
    });
    const cursor = () => host!.querySelector('.view-trash .row[aria-selected="true"]')?.getAttribute("data-id");
    const reader = () => host!.querySelector(".view-trash .read-col")?.textContent ?? "";
    await draw(0);
    expect(cursor()).toBe("m1");
    expect(reader()).toContain("Subject m1");
    await draw(1);
    expect(host.querySelector(".view-trash .row")?.getAttribute("data-id"), "u8 listed on top").toBe("u8");
    expect(cursor(), "the cursor stays on the letter the person was on").toBe("m1");
    expect(reader()).toContain("Subject m1");
    expect(reader()).not.toContain("Subject u8");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(acted).toEqual([["restore", "m1"]]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(cursor(), "↓ steps from the letter shown").toBe("m2");
  });
});

describe("useTrashPage — a delete that lands while Trash is open", () => {
  it("is read in at the top without leaving the view; nothing is read while away", async () => {
    const { useTrashPage } = await import("../app/shell/trash-page");
    const listTrash = vi.fn()
      .mockResolvedValueOnce({ state: "ready", items: [row("m1")], nextCursor: null })
      .mockResolvedValue({ state: "ready", items: [row("m2"), row("m1")], nextCursor: null });
    const engine = { trashAvailable: () => true, listTrash } as never;
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

describe("a restored letter leaves Trash for good", () => {
  const hadCss = typeof (globalThis as { CSS?: unknown }).CSS !== "undefined";
  beforeEach(() => {
    if (!hadCss) (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (!hadCss) (globalThis as { CSS?: unknown }).CSS = undefined;
  });

  /** The shell's wiring in small: the held restore window, the Trash page and the view. */
  async function bin(answer: (id: string) => Promise<unknown>) {
    const { useTrashPage } = await import("../app/shell/trash-page");
    const { useDeleteUndo } = await import("../app/shell/delete-undo");
    const listTrash = vi.fn().mockResolvedValue({ state: "ready", items: [row("m1"), row("m2")], nextCursor: null });
    const engine = { trashAvailable: () => true, listTrash } as never;
    const said: string[] = [];
    function Bin() {
      const restoring = useDeleteUndo({
        verb: "restore",
        mutate: restoreDispatch(answer as never, () => said.push("place"), () => said.push(en.trash.toastRestoreGone)),
        toast: (m) => { said.push(m); },
        copy: {
          deleted: en.trash.restoring, undo: en.screener.toastUndo, undone: en.trash.toastRestoreUndone,
          failed: en.trash.toastRestoreFailed, noUndo: en.session.noUndoHere,
        },
        refusal: () => null,
      });
      return h(TrashView, {
        page: useTrashPage(engine, true, restoring.held, 0, restoring.landedIds), tags: [],
        now: new Date("2026-09-09T11:00:00.000Z"), onOpen: () => {}, hydrateBody: () => {},
        onAction: (_a: string, m: { id: string; mailboxId: string }) => restoring.remove({ id: m.id, mailboxId: m.mailboxId }),
        onAddTag: () => {},
      } as never);
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", children: h(KeymapProvider, { children: h(Bin) }),
      }));
    });
    const el = host;
    return {
      said,
      listed: () => [...el.querySelectorAll(".view-trash .row")].map((r) => r.getAttribute("data-id")),
      cursor: () => el.querySelector('.view-trash .row[aria-selected="true"]')?.getAttribute("data-id"),
      reader: () => el.querySelector(".view-trash .read-col")?.textContent ?? "",
      restoreShown: () => act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", shiftKey: true, bubbles: true, cancelable: true }));
      }),
      wait: (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); }),
    };
  }

  it("past its Undo window the restored letter stays out of the list, the cursor and the reader", async () => {
    const b = await bin(async () => ({ state: "restored", restoreTo: "INBOX", pending: true }));
    expect(b.cursor()).toBe("m1");
    await b.restoreShown();
    expect(b.listed()).toEqual(["m2"]);
    await b.wait(UNDO_MS + 1_000);
    expect(b.listed(), "the server holds it in the inbox now").toEqual(["m2"]);
    expect(b.cursor()).toBe("m2");
    expect(b.reader()).not.toContain("Subject m1");
    expect(b.said).not.toContain(en.trash.toastRestoreFailed);
  });

  it("stays hidden while the server answers, and a refusal brings it back with the refusal", async () => {
    let refuse: (v: unknown) => void = () => {};
    const b = await bin(() => new Promise((r) => { refuse = r; }));
    await b.restoreShown();
    await b.wait(UNDO_MS + 1_000);
    expect(b.listed(), "not listed again before the server answered").toEqual(["m2"]);
    await act(async () => { refuse({ state: "rolled_back", error: "x", code: "provider_unreachable" }); });
    expect(b.listed()).toEqual(["m1", "m2"]);
    expect(b.said).toContain(en.trash.toastRestoreFailed);
  });

  it("a letter already out of Trash leaves the list and is said to be out, never 'still in Trash'", async () => {
    const b = await bin(async () => ({ state: "rolled_back", error: "this message is not in Trash", code: "not_in_trash" }));
    await b.restoreShown();
    await b.wait(UNDO_MS + 1_000);
    expect(b.listed()).toEqual(["m2"]);
    expect(b.said).toContain(en.trash.toastRestoreGone);
    expect(b.said).not.toContain(en.trash.toastRestoreFailed);
  });
});
