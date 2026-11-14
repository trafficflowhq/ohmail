/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { TrashLiveWire } from "@ohmail/app-logic/trash";
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  mutationEffects,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { replyDraftKey, replyMetaKey } from "@ohmail/app-logic/writing/mail-send";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";

/** Whose keys the shell keeps and this file reads: one account, named before the shell mounts. The cases under a
 *  storage owner of their own (below) name theirs. */
const LANES_OWNER = "acc-reply-lanes";

/**
 * ═══ A PERSON'S UNSENT WORDS SURVIVE THEIR PARENT'S DELETE ══════════════════════════════════
 *
 * Another mail client moved a message out of every watched folder, the worker tombstoned it, and
 * the half-written reply — `localStorage`, keyed on the parent's id — became unreachable in the
 * same instant. Nothing dropped it; nothing could read it either.
 */

/**
 * MEASURED HERE FIRST (2026-09-16, before the fix): the dock unmounted with its host, the lane key
 * still held the text, no draft row was ever asked for, and the pane rendered the same empty string
 * it renders when nothing is open — which is why there are two halves below, PROMOTE and SAY IT.
 *
 * HOW TO WATCH IT FAIL: replace the promote with a bare lane drop and the draft-row case goes red
 * while the lane-key case stays green — exactly the shape of the loss.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-16T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Every verb this shell put on the wire. */
let sent: EngineMutation[] = [];
let store: MirrorStore | null = null;
let engine: OhmailEngine | null = null;
/** What the next `/sync` answers with — the channel, as a cell. */
let pending: SyncChange[] = [];
/** The refusal arm: a server that will not take the promoted row. */
let refuseDraftSave = false;
/** The viewport the next mount runs at — 390px is where the reader is a SHEET. */
let mobile = false;
/** The original's parts a forward lists; `null`: the adapter has no attachment list. */
let originalParts: Array<{ id: string; filename: string; contentType: string; sizeBytes: number; inline: boolean }> | null = null;
/** The original's list never answers. */
let listHangs = false;
/** The draft read reaches no server: `draftOnServer` says "unknown". */
let draftReadFails = false;
/** A row the server still holds that this mirror has not been given. */
const serverOnlyRow = "row-held";
/** Rows the server deleted, whatever this mirror still holds: a write into one is a 404. */
const serverGone = new Set<string>();

beforeEach(() => {
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  setStorageOwner(LANES_OWNER);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: mobile && /max-width/.test(query), media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  // jsdom draws no animation: the frame's report leaves through `animate`.
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  sent = [];
  seq = 0;
  store = null;
  engine = null;
  pending = [];
  refuseDraftSave = false;
  mobile = false;
  originalParts = null;
  listHangs = false;
  draftReadFails = false;
  serverGone.clear();
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
  resetStorageOwnerForTest();
});

/* ── the account this shell is mounted over ─────────────────────────────────────────────── */

const SENDER = "colleague@example.invalid";
const THIRD = "third@example.invalid";

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: SENDER, name: "The colleague" },
  to: [{ address: "me@example.invalid", name: "Me" }],
  // A third person on the thread: what reply-all reaches and a plain reply does not.
  cc: [{ address: THIRD, name: "Third" }],
  date: "2026-09-16T08:29:00.000Z", unread: false,
  /* A letter's tags, as every mirror row carries them: the reader's head reads the list (made whole by the older
     tests' sorting, share write-1, as the door's own fixture carries it). */
  labels: [],
  updatedAt: "2026-09-16T08:29:00.000Z",
} as unknown as EngineMessage);

async function storeWith(ids: string[]): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  for (const id of ids) {
    const m = msg(id);
    await s.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
      {
        type: "rule", op: "create", id: `r-${id}`, seq: ++seq, updatedAt: m.updatedAt,
        entity: {
          id: `r-${id}`, kind: "sender", match: SENDER,
          destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z",
        },
      },
    ] as SyncChange[]);
  }
  return s;
}

function engineOver(s: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const page = pending;
        pending = [];
        return {
          changes: {
            creates: page.filter((c) => c.op !== "delete"),
            updates: [], moves: [],
            deletes: page.filter((c) => c.op === "delete"),
          },
          cursor: s.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        if (refuseDraftSave && m.kind === "draft_save") throw new Error("the server refused it");
        if (m.kind === "draft_save" && m.draftId != null && serverGone.has(m.draftId)) {
          throw new MutationRejectedError("draft not found", { code: "not_found", status: 404, retryable: false });
        }
        const changes = mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type,
            op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        await s.applyChanges(changes);
        /* The server's id for a create IS the row's — a test that minted its own would let the
           shell adopt an id the mirror has never heard of, which is the one thing `entityId`
           exists to prevent. */
        const created = m.kind === "draft_save" && m.draftId === null
          ? (changes.find((c) => c.type === "draft")?.id ?? null)
          : null;
        return {
          changes, seq: changes[changes.length - 1]?.seq ?? null,
          ...(created ? { entityId: created } : {}),
          ...(originalParts !== null && m.kind === "mail_send" ? { providerMessageId: "<fwd@example.invalid>" } : {}),
        };
      },
      ...(originalParts !== null ? {
        listAttachments: (id: string) => (listHangs ? new Promise(() => {})
          : Promise.resolve(id === "m2" ? originalParts!.map((p) => ({ ...p, messageId: id })) : [])),
        fetchAttachment: async () => new Blob(["x"]),
        forwardPartsAnnounced: async () => true,
      } : {}),
      fetchDraftBody: async (id: string) => {
        if (draftReadFails) throw new MutationRejectedError("unreachable", { code: "offline", status: null, retryable: true });
        const d = serverGone.has(id) ? undefined
          : s.get<{ body: string | null }>("draft", id) ?? (id === serverOnlyRow ? { body: "held at the server" } : undefined);
        if (!d) throw new MutationRejectedError("draft not found", { code: "not_found", status: 404, retryable: false });
        return d.body ?? "";
      },
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

const consentTransport = {
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z",
    screeningResetAt: null, dormancyDays: 90,
    foldersEnabledAt: "2026-09-01T00:00:00.000Z",
  }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

const ORGANIZER_ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

/*
 * THE NEW SHELL's PARTS, by role and name (re-pointed from today's classes by the older tests' sorting, share
 * write-1): the Ohbox's rows are the options of the list "Messages"; the open letter is the region "Open message",
 * the reply's words its textbox "Reply body"; keys go where the keys are (the focused row, the reply's text).
 */
const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>('section[aria-label="Messages"] [role=option][data-id]')].map((r) => r.dataset.id ?? "");

async function shell(
  ids: string[] = ["m1"],
  seed?: (s: MirrorStore) => Promise<void>,
  trashWire?: TrashLiveWire,
): Promise<HTMLElement> {
  const s = await storeWith(ids);
  if (seed) await seed(s);
  return shellOver(s, trashWire);
}

/** Mount the shell over `s` — a kept store is the desktop's persisted mirror across a relaunch. */
async function shellOver(s: MirrorStore, trashWire?: TrashLiveWire): Promise<HTMLElement> {
  const { MailShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  store = s;
  engine = engineOver(store);
  /* The window's width, as the new frame's plan reads it (made whole by the older tests' sorting, share write-1:
     today's shell read only the media query). */
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: mobile ? 390 : 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: mobile ? 844 : 768 });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        children: h(ToastHost, {
          children: h(MailShell as never, {
            demo: false, engine, consentTransport, trashWire,
            mailboxFacts: async () => ORGANIZER_ROSTER,
          } as never),
        }),
      }),
    }));
  });
  await waitFor(() => rowIds(container).length > 0, "rows in the Ohbox");
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  // A key can open an editor, and the editor is behind `RichEditorLazy` — one seam, one helper.
  await settleEditor();
};

/** Open a NAMED row — `j` stops at whatever the list orders first, which is not the subject. */
async function openRow(el: HTMLElement, id: string): Promise<void> {
  const row = el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  await act(async () => {
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settleEditor();
}

const editorSurface = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]')
    ?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"]') ?? null;

const laneBody = (): string | null => window.localStorage.getItem(replyDraftKey("m1", LANES_OWNER));
const laneMeta = (): string | null => window.localStorage.getItem(replyMetaKey("m1", LANES_OWNER));

/** Open the reader on m1, open the reply, and type `text` into it. */
async function replyInProgress(text: string): Promise<HTMLElement> {
  const container = await shell();
  // The letter opened by its row (re-pointed: today's `j` then Enter walked the list to it).
  await openRow(container, "m1");
  await key("r");
  const surface = editorSurface(container);
  expect(surface, "the reply editor never mounted").not.toBeNull();
  await act(async () => { typeInto(surface!, text); });
  await waitFor(() => (laneBody() ?? "").includes(text), "the reply lane holding the typed text");
  return container;
}

/** The parent leaves the mirror the way another client's move makes it leave: a tombstone. */
async function tombstoneParent(): Promise<void> {
  pending = [{
    type: "message", op: "delete", id: "m1", seq: ++seq,
    updatedAt: NOW.toISOString(), entity: null,
  } as unknown as SyncChange];
  await act(async () => { await engine!.syncOnce(); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

/* The reader's own words for a letter another client took away (`reader.goneShort`), where today's pane said "This
   message was moved or deleted elsewhere." (re-pointed by the older tests' sorting, share write-1, as the lists'
   builder read it: the claim, that the column SAYS the letter left, is untouched). */
const GONE = "Moved or deleted elsewhere";
const paneText = (el: ParentNode, sel: string): string => el.querySelector(sel)?.textContent ?? "";
/** The open letter, the phone's sheet or the column's letter: the region "Open message". */
const OPEN = '[role="region"][aria-label="Open message"]';
/** The reading column beside the Ohbox's list: the section "Reading" (a region by its name). */
const COLUMN = 'section[aria-label="Reading"]';
const draftSaves = (): Array<Extract<EngineMutation, { kind: "draft_save" }>> =>
  sent.filter((m): m is Extract<EngineMutation, { kind: "draft_save" }> => m.kind === "draft_save");

const composer = (container: HTMLElement): HTMLElement | null =>
  within(container).queryByRole("region", { name: "New message" });

function sendButton(container: HTMLElement): HTMLElement | null {
  const editor = composer(container);
  const toolbar = editor && within(editor).queryByRole("toolbar", { name: "Send or discard" });
  return toolbar && within(toolbar).queryByRole("button", { name: "Send" });
}

async function openFromDrafts(container: HTMLElement, subject: RegExp): Promise<void> {
  await act(async () => { window.location.hash = "#/drafts"; });
  const row = () => {
    const list = within(container).queryByRole("listbox", { name: messages.drafts.title });
    return list && within(list).queryByRole("option", { name: subject });
  };
  await waitFor(() => row() !== null, "the named row in Drafts");
  await act(async () => { row()!.click(); });
}

describe("a reply survives its parent's delete — PROMOTE, never drop", () => {
  it("the words land as a draft row, and only then do the lane keys clear", async () => {
    await replyInProgress("the half-written answer");
    expect(laneBody()).toContain("the half-written answer");

    await tombstoneParent();

    // (i) A ROW CARRIES THE TEXT — and carries the dead parent, which is legal: the FK is
    // nullable and the delete is soft.
    const saves = draftSaves();
    expect(saves, "nothing was promoted").toHaveLength(1);
    expect(saves[0].draftId, "an update, not a create").toBeNull();
    expect(saves[0].body).toContain("the half-written answer");
    expect(saves[0].inReplyToMessageId).toBe("m1");
    expect(saves[0].mailboxId).toBe("mb1");
    expect(saves[0].subject).toBe("Re: Subject m1");
    // The PLAIN reply's audience, made concrete — a draft row has no `enrich` to derive it.
    expect(saves[0].to.map((a) => a.address)).toEqual([SENDER]);

    // (ii) BOTH lane keys are gone.
    expect(laneBody(), "the body lane outlived the row").toBeNull();
    expect(laneMeta(), "the meta lane outlived the row").toBeNull();

    // …and the row is really in the mirror, under the id the shell adopted.
    const drafts = store!.list<{ id: string; body: string }>("draft");
    expect(drafts.map((d) => d.body).join("\n")).toContain("the half-written answer");
  });

  it("a reply the account already holds as a row with those words is not promoted twice", async () => {
    await replyInProgress("the half-written answer");
    // The inline reply's own pause writes it to the account first (tester round 24).
    await waitFor(() => draftSaves().length === 1, "the reply's own draft on the account", 6000);
    expect(draftSaves()[0]!.draftId).toBeNull();

    await tombstoneParent();

    expect(draftSaves(), "the promotion made a second row of the same words").toHaveLength(1);
    expect(store!.list<{ body: string }>("draft").map((d) => d.body)).toEqual(["the half-written answer"]);
    expect(laneBody(), "the lane outlived a reply the account holds").toBeNull();
  }, 20_000);

  it("the editor META travels onto the new row's lane — a struck signature is words too", async () => {
    await replyInProgress("the half-written answer");
    // What the editor writes when somebody retitles a reply and strikes the signature block.
    window.localStorage.setItem(
      replyMetaKey("m1", LANES_OWNER),
      JSON.stringify({ subject: "a title I chose", sig: { kind: "removed" } }),
    );

    await tombstoneParent();

    const rowId = draftSaves().length > 0 ? store!.list<{ id: string }>("draft")[0]?.id : undefined;
    expect(rowId, "no row to carry the meta onto").toBeDefined();
    expect(laneMeta(), "the old meta lane outlived the row").toBeNull();
    const carried = window.localStorage.getItem(replyMetaKey(`draft:${rowId}`, LANES_OWNER));
    expect(carried, "the block state was dropped with the lane").not.toBeNull();
    expect(JSON.parse(carried!)).toEqual({ subject: "a title I chose", sig: { kind: "removed" } });
    // …and the subject the person chose is what the row carries, not the derived `Re:`.
    expect(draftSaves()[0].subject).toBe("a title I chose");
  });

  it("the INLINE FORWARD's note is promoted too — a fix to one of a pair is half a fix", async () => {
    const container = await shell(["m1", "m2"]);
    await openRow(container, "m1");
    // The forward dock writes under `fwd:<id>`, the same door the reply's body goes through.
    window.localStorage.setItem(replyDraftKey("fwd:m1", LANES_OWNER), "passing this on because");

    await tombstoneParent();
    await waitFor(() => draftSaves().length > 0, "the forward note promoted");

    expect(draftSaves()[0].body).toContain("passing this on because");
    // A forward has no derived audience: the person picks it, and this lane never had one typed.
    expect(draftSaves()[0].to).toEqual([]);
    expect(draftSaves()[0].subject).toBe("Fwd: Subject m1");
    // …and it is saved as a FORWARD of the original, never as a reply to it.
    expect(draftSaves()[0].forwardOfMessageId, "the promoted forward names no original").toBe("m1");
    expect(draftSaves()[0].inReplyToMessageId ?? null, "the forward note was saved as a reply").toBeNull();
    expect(window.localStorage.getItem(replyDraftKey("fwd:m1", LANES_OWNER))).toBeNull();
  });

  it("A LANE WHOSE SEND IS ALREADY OUT IS NOT PROMOTED — the double-send bait", async () => {
    const { OUTBOX_TYPE } = await import("@ohmail/client-engine");
    const container = await shell(["m1", "m2"]);
    await openRow(container, "m1");
    window.localStorage.setItem(replyDraftKey("m1", LANES_OWNER), "the answer, already sent");
    // The durable outbox still holds this lane's `mail_send` — the send may already have been
    // delivered, so a row created for it now is a second copy of a message that went.
    await store!.putLocal(OUTBOX_TYPE, "o1", {
      id: "o1", mutation: { kind: "mail_send", inReplyTo: "m1", body: "x" },
    });

    await tombstoneParent();

    expect(draftSaves(), "a row was written for a message already on its way").toHaveLength(0);
    // LEFT, not dropped: `settle` still clears this lane when the send lands.
    expect(laneBody()).toBe("the answer, already sent");
  });

  it("(iii) it opens in the compose form — the path a dead parent already takes", async () => {
    const container = await replyInProgress("the half-written answer");
    await tombstoneParent();
    expect(draftSaves()).toHaveLength(1);

    // Drafts, then the row. `openDraftWithBody` reads the parent, gets `undefined` for a
    // tombstone, skips the inline arm and seeds the compose form.
    await openFromDrafts(container, /Subject m1/);
    await waitFor(() => composer(container) !== null, "the compose form open on the promoted draft");
    expect(composer(container)!.textContent).toContain("the half-written answer");
  });

  it("A REFUSED SAVE LEAVES THE WORDS EXACTLY WHERE THEY WERE — the order is the invariant", async () => {
    await replyInProgress("the half-written answer");
    refuseDraftSave = true;

    await tombstoneParent();

    expect(draftSaves().length, "the save was never attempted").toBeGreaterThan(0);
    // Unreachable, as it is today — but not gone, which is the whole difference.
    expect(laneBody(), "the lane was cleared over a refusal").toContain("the half-written answer");
  });

  it("a lane with NO envelope (written before it) whose parent died while CLOSED is promoted on mount", async () => {
    // The lane is on disk and the mirror already holds the tombstone — a second tab, or
    // tomorrow's reload. Nothing in this session ever saw the delete change.
    window.localStorage.setItem(replyDraftKey("m1", LANES_OWNER), "yesterday's unsent answer");
    await shell(["m1", "m2"], async (s) => {
      await s.applyChanges([{
        type: "message", op: "delete", id: "m1", seq: 9000,
        updatedAt: NOW.toISOString(), entity: null,
      } as unknown as SyncChange]);
    });
    // The scan runs on the first publish after hydration; a drain is one.
    await act(async () => { await engine!.syncOnce(); });
    await waitFor(() => draftSaves().length > 0, "the orphaned lane promoted on mount");

    expect(draftSaves()[0].body).toContain("yesterday's unsent answer");
    expect(laneBody()).toBeNull();
    // NO PARENT TO READ AND NO ENVELOPE: the row carries the words and nothing it cannot name.
    expect(draftSaves()[0].to).toEqual([]);
    expect(draftSaves()[0].subject).toBe("");
  });

  it("a lane typed here and closed inside the pause keeps its subject and audience when promoted on mount", async () => {
    await replyInProgress("typed and left");
    for (const root of roots) await act(() => { root.unmount(); });
    roots = [];
    document.body.innerHTML = "";
    expect(draftSaves(), "the closed editor created a row, so the lane has one to fall back on").toHaveLength(0);
    await shell(["m1", "m2"], async (s) => {
      await s.applyChanges([{
        type: "message", op: "delete", id: "m1", seq: 9000,
        updatedAt: NOW.toISOString(), entity: null,
      } as unknown as SyncChange]);
    });
    await act(async () => { await engine!.syncOnce(); });
    await waitFor(() => draftSaves().length > 0, "the orphaned lane promoted on mount");
    expect(draftSaves()[0].body).toContain("typed and left");
    expect(draftSaves()[0].subject, "the promoted reply lost the subject it was written under").toBe("Re: Subject m1");
    expect(draftSaves()[0].to.map((a) => a.address), "the promoted reply lost its audience").toEqual([SENDER]);
    expect(draftSaves()[0].mailboxId).toBe("mb1");
  }, 20_000);

  it("a reply-all promoted while open keeps the reply-all audience", async () => {
    const container = await shell();
    await openRow(container, "m1");
    await key("R", { shiftKey: true });
    const surface = editorSurface(container);
    expect(surface, "the reply editor never mounted").not.toBeNull();
    await act(async () => { typeInto(surface!, "to all of you"); });
    await waitFor(() => (laneBody() ?? "").includes("to all of you"), "the lane holding the text");

    await tombstoneParent();
    await waitFor(() => draftSaves().length > 0, "the lane promoted");
    const save = draftSaves()[0];
    const all = [...save.to, ...save.cc].map((a) => a.address).sort();
    expect(all, "the promoted reply-all narrowed to the sender").toEqual([SENDER, THIRD].sort());
  }, 20_000);

  it("a lane whose row this browser wrote is promoted INTO that row, never beside it", async () => {
    const container = await replyInProgress("the first half");
    await waitFor(() => draftSaves().length === 1, "the reply's own draft on the account", 6000);
    const rowId = store!.list<{ id: string }>("draft")[0]!.id;
    // More words, typed inside the next pause: the row has not had them yet.
    await act(async () => { typeInto(editorSurface(container)!, " and the second"); });
    await waitFor(() => (laneBody() ?? "").includes("the second"), "the lane holding the newer text");

    await tombstoneParent();
    await waitFor(() => laneBody() === null, "the lane promoted");
    // The promotion, and the closing editor's own write, both go to the row this browser holds.
    const later = draftSaves().slice(1);
    expect(later.length, "nothing was promoted").toBeGreaterThan(0);
    expect(later.map((d) => d.draftId), "the promotion made a second row beside the one this browser wrote")
      .toEqual(later.map(() => rowId));
    expect(store!.list<{ body: string }>("draft").map((d) => d.body)).toEqual([expect.stringContaining("the second")]);
  }, 20_000);

  it("a lane whose parent is merely OUTSIDE the window is left alone", async () => {
    // The negative arm of the scan, and the reason it asks for a tombstone: `prune` deletes
    // rather than tombstones, so an absent record is ordinary mail this device does not hold.
    window.localStorage.setItem(replyDraftKey("never-mirrored", LANES_OWNER), "an answer to older mail");
    await shell(["m1"]);
    await act(async () => { await engine!.syncOnce(); });

    expect(draftSaves(), "absence was read as a delete").toHaveLength(0);
    expect(window.localStorage.getItem(replyDraftKey("never-mirrored", LANES_OWNER)))
      .toBe("an answer to older mail");
  });

  /* UNDER A STORAGE OWNER the lanes are `<prefix><owner>:<lane>`, so a one-account wipe can take them. A lane
     written before that moves into that partition at mount when this mirror names its parent. */
  describe("under a storage owner", () => {
    const OWNER = "mailbox-a";
    const old = (lane: string): [string, string] => [`ohmail.ui.reply:${lane}`, `ohmail.ui.replymeta:${lane}`];
    const owned = (lane: string): [string, string] => [`ohmail.ui.reply.${OWNER}:${lane}`, `ohmail.ui.replymeta.${OWNER}:${lane}`];
    const held = (keys: string[]): Array<string | null> => keys.map((k) => window.localStorage.getItem(k));
    const draftRow = (id: string): SyncChange => ({
      type: "draft", op: "create", id, seq: 8000, updatedAt: NOW.toISOString(),
      entity: {
        id, mailboxId: "mb1", threadId: null, inReplyToMessageId: null, forwardOfMessageId: null,
        subject: "a draft", body: "", to: [], cc: [], bcc: [], rationale: null, status: "draft",
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
    } as unknown as SyncChange);
    beforeEach(async () => (await import("@ohmail/app-logic/storage/storage-owner")).setStorageOwner(OWNER));
    afterEach(async () => (await import("@ohmail/app-logic/storage/storage-owner")).resetStorageOwnerForTest());

    it("an old lane on a message or draft in the mirror moves at mount; one it cannot name stays exactly as it is", async () => {
      for (const lane of ["m1", "fwd:m1", "draft:d1", "never-mirrored", "draft:d-elsewhere"]) {
        window.localStorage.setItem(old(lane)[0], `words of ${lane}`);
        window.localStorage.setItem(old(lane)[1], JSON.stringify({ subject: `title of ${lane}` }));
      }
      await shell(["m1"], async (s) => { await s.applyChanges([draftRow("d1")]); });
      await act(async () => { await engine!.syncOnce(); });

      for (const lane of ["m1", "fwd:m1", "draft:d1"]) {
        expect(held([...old(lane), ...owned(lane)]), `${lane} did not move into its account's partition`)
          .toEqual([null, null, `words of ${lane}`, JSON.stringify({ subject: `title of ${lane}` })]);
      }
      for (const lane of ["never-mirrored", "draft:d-elsewhere"]) {
        expect(held([...old(lane), ...owned(lane)]), `${lane} was moved by a mirror that cannot name it`)
          .toEqual([`words of ${lane}`, JSON.stringify({ subject: `title of ${lane}` }), null, null]);
      }
      expect(draftSaves(), "a lane was promoted").toHaveLength(0);
    });

    it("an old lane whose parent died while closed is promoted at mount, and no copy of it is left", async () => {
      window.localStorage.setItem(old("m1")[0], "yesterday's unsent answer");
      await shell(["m1", "m2"], async (s) => {
        await s.applyChanges([{
          type: "message", op: "delete", id: "m1", seq: 9000,
          updatedAt: NOW.toISOString(), entity: null,
        } as unknown as SyncChange]);
      });
      await act(async () => { await engine!.syncOnce(); });
      await waitFor(() => draftSaves().length > 0, "the orphaned lane promoted on mount");
      expect(draftSaves()[0].body).toContain("yesterday's unsent answer");
      expect(held([...old("m1"), ...owned("m1")]), "a promoted lane left a copy").toEqual([null, null, null, null]);
    });
  });
});

/* A REPLY DRAFT THE PERSON DISCARDED stays discarded: Cancel keeps the dock's words, and when the row
   they were saved to was deleted elsewhere, the parent's delete must not save them as a new draft. */
describe("a reply whose draft was deleted elsewhere is not saved again when its parent goes", () => {
  /** Today's Cancel of the dock is the reply's leave key in its text over Write (Escape: `closeReply`, which keeps
   *  the words), pressed where the keys are. */
  const leaveDock = async (el: HTMLElement): Promise<void> => {
    const text = editorSurface(el);
    expect(text, "no reply open to leave").not.toBeNull();
    await act(async () => {
      text!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settleEditor();
  };
  const draftGone = (id: string): SyncChange => {
    serverGone.add(id);
    return { type: "draft", op: "delete", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange;
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };
  const sig = async (text: string): Promise<string> => (await import("@ohmail/app-logic/writing/compose-autosave")).sigOf(text);
  /** A lane left by an earlier session: its words, and the row it last wrote. */
  const laneLeft = (words: string, row: Record<string, unknown>): void => {
    window.localStorage.setItem(replyDraftKey("m1", LANES_OWNER), words);
    window.localStorage.setItem(replyMetaKey("m1", LANES_OWNER), JSON.stringify({ row: { at: NOW.toISOString(), ...row } }));
  };

  async function typedSavedCancelled(text: string): Promise<{ container: HTMLElement; rowId: string }> {
    const container = await replyInProgress(text);
    await waitFor(() => draftSaves().length === 1, "the reply's own draft on the account", 6000);
    const rowId = store!.list<{ id: string }>("draft")[0]!.id;
    await leaveDock(container);
    await waitFor(() => editorSurface(container) === null, "the dock closed");
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    return { container, rowId };
  }

  it("Cancel, the draft deleted elsewhere, then the parent deleted: nothing is created and the lane clears", async () => {
    const { rowId } = await typedSavedCancelled("the cancelled answer");
    expect(laneBody(), "Cancel keeps the words").toContain("the cancelled answer");
    expect(JSON.parse(laneMeta() ?? "{}").row?.id).toBe(rowId);
    pending = [draftGone(rowId)];
    await act(async () => { await engine!.syncOnce(); });
    expect(store!.list("draft"), "the discard reached the mirror").toHaveLength(0);
    await tombstoneParent();
    await settle();
    expect(draftSaves().slice(1), "a deleted draft was created again").toEqual([]);
    expect(store!.list("draft")).toHaveLength(0);
    expect([laneBody(), laneMeta()]).toEqual([null, null]);
  }, 20_000);

  it("the same across a relaunch: the row deleted while closed, the parent's delete arriving after mount", async () => {
    await typedSavedCancelled("the cancelled answer");
    for (const root of roots) await act(() => { root.unmount(); });
    roots = [];
    document.body.innerHTML = "";
    sent = [];
    await shell(["m1", "m2"]);
    await act(async () => { await engine!.syncOnce(); });
    await tombstoneParent();
    await settle();
    expect(draftSaves(), "the relaunch created the deleted draft again").toEqual([]);
    expect([laneBody(), laneMeta()]).toEqual([null, null]);
  }, 20_000);

  it("relaunched over the kept mirror, the row edited elsewhere: its delete and the parent's in one page create nothing", async () => {
    const { rowId } = await typedSavedCancelled("the cancelled answer");
    const was = store!.get<Record<string, unknown>>("draft", rowId)!;
    const at = new Date(NOW.getTime() + 60_000).toISOString();
    pending = [{ type: "draft", op: "update", id: rowId, seq: ++seq, updatedAt: at,
      entity: { ...was, body: "edited on the web", html: null, updatedAt: at } } as unknown as SyncChange];
    await act(async () => { await engine!.syncOnce(); });
    const kept = store!;
    for (const root of roots) await act(() => { root.unmount(); });
    roots = [];
    document.body.innerHTML = "";
    sent = [];
    await shellOver(kept);
    pending = [draftGone(rowId), { type: "message", op: "delete", id: "m1", seq: ++seq,
      updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange];
    await act(async () => { await engine!.syncOnce(); });
    await settle();
    expect(draftSaves().filter((d) => d.draftId === null), "the deleted draft was created again").toEqual([]);
    expect([laneBody(), laneMeta()]).toEqual([null, null]);
  }, 20_000);

  it("words the deleted row never held are still kept as a new draft", async () => {
    laneLeft("newer words never saved", { id: "row-gone", holds: await sig("older words"), made: true });
    await shell(["m1", "m2"]);
    await act(async () => { await engine!.syncOnce(); });
    await tombstoneParent();
    await waitFor(() => draftSaves().length > 0, "the unsaved words promoted");
    expect(draftSaves()[0]!.draftId).toBeNull();
    expect(draftSaves()[0]!.body).toContain("newer words never saved");
  }, 20_000);

  it("the row sent elsewhere with these words: no draft, and the lane clears", async () => {
    laneLeft("the answer that went", { id: "d-sent", holds: await sig("the answer that went"), made: true });
    await shell(["m1", "m2"], async (s) => {
      await s.applyChanges([{
        type: "draft", op: "create", id: "d-sent", seq: 8000, updatedAt: NOW.toISOString(),
        entity: {
          id: "d-sent", mailboxId: "mb1", threadId: null, inReplyToMessageId: "m1", forwardOfMessageId: null,
          subject: "Re: Subject m1", body: "the answer that went", to: [], cc: [], bcc: [], rationale: null,
          status: "sent", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        },
      } as unknown as SyncChange]);
    });
    await act(async () => { await engine!.syncOnce(); });
    await tombstoneParent();
    await settle();
    expect(draftSaves(), "a sent reply came back as a draft").toHaveLength(0);
    expect([laneBody(), laneMeta()]).toEqual([null, null]);
  }, 20_000);

  it.each([
    ["the server cannot be asked", "row-gone", "the answer", "the answer", undefined, true],
    ["a save of these words waited unseen", "row-gone", "the queued words", "older", "the queued words", false],
    ["the row is held at the server, not mirrored yet", serverOnlyRow, "the answer", "the answer", undefined, false],
  ] as const)("%s: nothing is created and the lane is kept", async (_, id, words, holds, waiting, unreachable) => {
    laneLeft(words, { id, holds: await sig(holds), made: true, ...(waiting ? { pending: await sig(waiting) } : {}) });
    draftReadFails = unreachable;
    await shell(["m1", "m2"]);
    await act(async () => { await engine!.syncOnce(); });
    await tombstoneParent();
    await settle();
    expect(draftSaves()).toHaveLength(0);
    expect(laneBody()).toBe(words);
  }, 20_000);
});

describe("a forward kept as a draft is still a forward", () => {
  it("reopened from Drafts it opens as a forward, and its send carries the original", async () => {
    const container = await shell(["m1", "m2"], async (s) => {
      await s.applyChanges([{
        type: "draft", op: "create", id: "d-fwd", seq: 8000, updatedAt: NOW.toISOString(),
        entity: {
          id: "d-fwd", mailboxId: "mb1", threadId: null, inReplyToMessageId: null, forwardOfMessageId: "m2",
          subject: "Fwd: Subject m2", body: "see below", to: [{ address: "peer@example.invalid", name: null }],
          cc: [], bcc: [], rationale: null, status: "draft",
          createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        },
      } as unknown as SyncChange]);
    });
    await openFromDrafts(container, /Fwd: Subject m2/);
    await waitFor(() => sendButton(container) !== null, "the compose form");
    await act(async () => { sendButton(container)!.click(); });
    await waitFor(() => sent.some((m) => m.kind === "mail_send"), "the send reaching the wire");
    const send = sent.find((m) => m.kind === "mail_send") as Extract<EngineMutation, { kind: "mail_send" }>;
    expect(send.forwardOf, "the reopened forward left as a plain mail").toBe("m2");
    expect(send.draftId, "the send made a row of its own instead of sending the draft").toBe("d-fwd");
  }, 20_000);

  it("a row trimmed on another device opens listing only the kept files, and sends only those", async () => {
    const [A, B, C] = ["a0000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002", "c0000000-0000-4000-8000-000000000003"];
    originalParts = [A, B, C].map((id, i) => ({ id, filename: `f${i}.pdf`, contentType: "application/pdf", sizeBytes: 100, inline: false }));
    const container = await shell(["m1", "m2"], async (s) => {
      await s.applyChanges([{
        type: "draft", op: "create", id: "d-fwd", seq: 8000, updatedAt: NOW.toISOString(),
        entity: {
          id: "d-fwd", mailboxId: "mb1", threadId: null, inReplyToMessageId: null, forwardOfMessageId: "m2", forwardParts: [A, C],
          subject: "Fwd: Subject m2", body: "see below", to: [{ address: "peer@example.invalid", name: null }],
          cc: [], bcc: [], rationale: null, status: "draft",
          createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        },
      } as unknown as SyncChange]);
    });
    await openFromDrafts(container, /Fwd: Subject m2/);
    await waitFor(() => listedIn(container).length > 0, "the forward's files listed");
    expect(listedIn(container), "the files removed elsewhere came back").toEqual(["f0.pdf", "f2.pdf"]);
    await act(async () => { sendButton(container)!.click(); });
    await waitFor(() => sent.some((m) => m.kind === "mail_send"), "the send reaching the wire");
    const send = sent.find((m) => m.kind === "mail_send") as Extract<EngineMutation, { kind: "mail_send" }>;
    expect(send.forwardParts, "a phone-trimmed draft sent every file").toEqual([A, C]);
    const copy = engine!.read().list<EngineMessage>("message").find((x) => x.id !== "m1" && x.id !== "m2");
    expect(copy, "no Sent copy").toBeDefined();
    await engine!.loadAttachments(copy!.id);
    const held = engine!.attachmentsOf(copy!.id);
    expect(held.state === "ready" ? held.items.map((i) => i.id) : held.state).toEqual([A, C]);
  }, 20_000);

  const P = ["a0000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002", "c0000000-0000-4000-8000-000000000003"];
  const listedIn = (container: HTMLElement): string[] => {
    const editor = composer(container);
    return editor
      ? within(editor).queryAllByText(/^f[0-9]+\.pdf$/).map((file) => file.textContent ?? "")
      : [];
  };
  async function openForwardDraft(rowParts: string[] | null): Promise<HTMLElement> {
    originalParts = P.map((id, i) => ({ id, filename: `f${i}.pdf`, contentType: "application/pdf", sizeBytes: 100, inline: false }));
    const container = await shell(["m1", "m2"], async (s) => {
      await s.applyChanges([{
        type: "draft", op: "create", id: "d-fwd", seq: 8000, updatedAt: NOW.toISOString(),
        entity: {
          id: "d-fwd", mailboxId: "mb1", threadId: null, inReplyToMessageId: null, forwardOfMessageId: "m2", forwardParts: rowParts,
          subject: "Fwd: Subject m2", body: "see below", to: [{ address: "peer@example.invalid", name: null }],
          cc: [], bcc: [], rationale: null, status: "draft",
          createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        },
      } as unknown as SyncChange]);
    });
    await openFromDrafts(container, /Fwd: Subject m2/);
    await waitFor(() => sendButton(container) !== null, "the compose form");
    return container;
  }
  const sendOf = (): Extract<EngineMutation, { kind: "mail_send" }> | undefined =>
    sent.find((m) => m.kind === "mail_send") as Extract<EngineMutation, { kind: "mail_send" }> | undefined;

  it.each([
    ["nothing removed", null, 3],
    ["a kept list", [P[0], P[2]], 2],
  ] as const)("%s: the reader releasing the original's list leaves the forward sendable", async (_, rowParts, shown) => {
    const container = await openForwardDraft(rowParts === null ? null : [...rowParts]);
    await waitFor(() => listedIn(container).length === shown, "the forward's files listed");
    // Read the original, then move on: the reader releases the original's list.
    await act(async () => { window.location.hash = "#/ohbox"; });
    await waitFor(() => rowIds(container).includes("m2"), "the Ohbox rows");
    await openRow(container, "m2");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    await openRow(container, "m1");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    await act(async () => { window.location.hash = "#/compose"; });
    await waitFor(() => listedIn(container).length === shown, "the forward's files listed again");
    await act(async () => { sendButton(container)!.click(); });
    await waitFor(() => sendOf() !== undefined, "the send reaching the wire");
    if (rowParts === null) expect(sendOf()!, "a forward with nothing removed named its parts").not.toHaveProperty("forwardParts");
    else expect(sendOf()!.forwardParts).toEqual([P[0], P[2]]);
  }, 20_000);

  it("while the original's list is still read, a forward with nothing removed sends every file", async () => {
    listHangs = true;
    const container = await openForwardDraft(null);
    await act(async () => { sendButton(container)!.click(); });
    await waitFor(() => sendOf() !== undefined, "the send reaching the wire");
    expect(sendOf()!).not.toHaveProperty("forwardParts");
    expect(sendOf()!.forwardOf).toBe("m2");
  }, 20_000);

  it("a kept list is not sent before the original's list is read", async () => {
    listHangs = true;
    const container = await openForwardDraft([P[0], P[2]]);
    await act(async () => { sendButton(container)!.click(); });
    await waitFor(() => {
      const editor = composer(container);
      return editor !== null && within(editor).queryAllByRole("status")
        .some((line) => line.textContent?.includes(messages.write.forwarded.reading));
    }, "the refusal said");
    expect(sendOf(), "a kept list went unread").toBeUndefined();
  }, 20_000);
});

describe("a message another mail client took away SAYS SO", () => {
  it("the reader sheet says it, and offers the live Trash window", async () => {
    mobile = true;
    const list = vi.fn<TrashLiveWire["list"]>().mockResolvedValue({ mailboxes: [], items: [], nextCursor: null });
    const container = await shell(["m1", "m2"], undefined, {
      list,
      body: async () => { throw new Error("no listed letter to read"); },
    });
    await openRow(container, "m1");
    expect(container.querySelector(OPEN), "no reader sheet at 390px").not.toBeNull();

    await tombstoneParent();

    expect(paneText(container, OPEN)).toContain(GONE);
    const sheet = within(container).getByRole("region", { name: "Open message" });
    const link = within(sheet).getByRole("button", { name: "Look in Trash" });
    expect(list).not.toHaveBeenCalled();
    await act(async () => { link.click(); });
    expect(window.location.hash).toBe("#/trash");
    await waitFor(() => list.mock.calls.length > 0, "the live Trash window asked for its page");
  });

  it("NEGATIVE ARM: nothing open still renders nothing open", async () => {
    mobile = true;
    const container = await shell(["m1", "m2"]);
    await tombstoneParent();
    expect(paneText(container, OPEN)).not.toContain(GONE);
    expect(paneText(document.body, "body")).not.toContain(GONE);
  });

  it("the OHBOX READING COLUMN says it — the surface at desktop width", async () => {
    const container = await shell(["m1", "m2"]);
    await openRow(container, "m1");
    expect(container.querySelector(`${COLUMN} ${OPEN}`), "no message in the column").not.toBeNull();

    await tombstoneParent();

    expect(paneText(container, COLUMN)).toContain(GONE);
  });

  it("NEGATIVE ARM: a column nobody opened anything in keeps its resting panel", async () => {
    const container = await shell(["m1", "m2"]);
    await tombstoneParent();
    expect(paneText(container, COLUMN)).not.toContain(GONE);
    // The resting panel is what stands there instead — the state this notice must not replace.
    /* RULING-JOIN J-3 (PARITY L19, declared): the resting column says the studio's blank, how many wait ("All read":
       every letter left here is read), where today's said "Nothing open."; the column still rests, which is the claim. */
    expect(paneText(container, COLUMN)).toContain("All read");
  });
});
