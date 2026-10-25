/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";

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

beforeEach(() => {
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
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
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
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

const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")].map((r) => r.dataset.id ?? "");

async function shell(ids: string[] = ["m1"], seed?: (s: MirrorStore) => Promise<void>): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  store = await storeWith(ids);
  if (seed) await seed(store);
  engine = engineOver(store);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        children: h(ToastHost, {
          children: h(AppShell as never, {
            demo: false, engine, consentTransport,
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
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  // A key can open an editor, and the editor is behind `RichEditorLazy` — one seam, one helper.
  await settleEditor();
};

/** Open a NAMED row — `j` stops at whatever the list orders first, which is not the subject. */
async function openRow(el: HTMLElement, id: string): Promise<void> {
  const row = el.querySelector<HTMLElement>(`.view-ohbox .row[data-id="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  await act(async () => {
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const editorSurface = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(".read-col .msg .rte-surface, .reader .msg .rte-surface");

const laneBody = (): string | null => window.localStorage.getItem("ohmail.ui.reply:m1");
const laneMeta = (): string | null => window.localStorage.getItem("ohmail.ui.replymeta:m1");

/** Open the reader on m1, open the reply, and type `text` into it. */
async function replyInProgress(text: string): Promise<HTMLElement> {
  const container = await shell();
  await key("j");
  await key("Enter");
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

const GONE = "This message was moved or deleted elsewhere.";
const paneText = (el: HTMLElement, sel: string): string => el.querySelector(sel)?.textContent ?? "";
const draftSaves = (): Array<Extract<EngineMutation, { kind: "draft_save" }>> =>
  sent.filter((m): m is Extract<EngineMutation, { kind: "draft_save" }> => m.kind === "draft_save");

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
      "ohmail.ui.replymeta:m1",
      JSON.stringify({ subject: "a title I chose", sig: { kind: "removed" } }),
    );

    await tombstoneParent();

    const rowId = draftSaves().length > 0 ? store!.list<{ id: string }>("draft")[0]?.id : undefined;
    expect(rowId, "no row to carry the meta onto").toBeDefined();
    expect(laneMeta(), "the old meta lane outlived the row").toBeNull();
    const carried = window.localStorage.getItem(`ohmail.ui.replymeta:draft:${rowId}`);
    expect(carried, "the block state was dropped with the lane").not.toBeNull();
    expect(JSON.parse(carried!)).toEqual({ subject: "a title I chose", sig: { kind: "removed" } });
    // …and the subject the person chose is what the row carries, not the derived `Re:`.
    expect(draftSaves()[0].subject).toBe("a title I chose");
  });

  it("the INLINE FORWARD's note is promoted too — a fix to one of a pair is half a fix", async () => {
    const container = await shell(["m1", "m2"]);
    await openRow(container, "m1");
    // The forward dock writes under `fwd:<id>`, the same door the reply's body goes through.
    window.localStorage.setItem("ohmail.ui.reply:fwd:m1", "passing this on because");

    await tombstoneParent();
    await waitFor(() => draftSaves().length > 0, "the forward note promoted");

    expect(draftSaves()[0].body).toContain("passing this on because");
    // A forward has no derived audience: the person picks it, and this lane never had one typed.
    expect(draftSaves()[0].to).toEqual([]);
    expect(draftSaves()[0].subject).toBe("Fwd: Subject m1");
    // …and it is saved as a FORWARD of the original, never as a reply to it.
    expect(draftSaves()[0].forwardOfMessageId, "the promoted forward names no original").toBe("m1");
    expect(draftSaves()[0].inReplyToMessageId ?? null, "the forward note was saved as a reply").toBeNull();
    expect(window.localStorage.getItem("ohmail.ui.reply:fwd:m1")).toBeNull();
  });

  it("A LANE WHOSE SEND IS ALREADY OUT IS NOT PROMOTED — the double-send bait", async () => {
    const { OUTBOX_TYPE } = await import("@ohmail/client-engine");
    const container = await shell(["m1", "m2"]);
    await openRow(container, "m1");
    window.localStorage.setItem("ohmail.ui.reply:m1", "the answer, already sent");
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
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(
      () => container.querySelector(".draft-row .draft-open") !== null,
      "the promoted row in Drafts",
    );
    const row = container.querySelector<HTMLElement>(".draft-row .draft-open");
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(
      () => container.querySelector(".view-compose") !== null,
      "the compose form open on the promoted draft",
    );
    expect(paneText(container, ".view-compose")).toContain("the half-written answer");
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
    window.localStorage.setItem("ohmail.ui.reply:m1", "yesterday's unsent answer");
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
    await key("j");
    await key("Enter");
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
    window.localStorage.setItem("ohmail.ui.reply:never-mirrored", "an answer to older mail");
    await shell(["m1"]);
    await act(async () => { await engine!.syncOnce(); });

    expect(draftSaves(), "absence was read as a delete").toHaveLength(0);
    expect(window.localStorage.getItem("ohmail.ui.reply:never-mirrored"))
      .toBe("an answer to older mail");
  });
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
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => container.querySelector(".draft-row .draft-open") !== null, "the forward in Drafts");
    const row = container.querySelector<HTMLElement>(".draft-row .draft-open");
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => container.querySelector(".view-compose .btn.primary") !== null, "the compose form");
    await act(async () => { container.querySelector<HTMLButtonElement>(".view-compose .btn.primary")!.click(); });
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
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => container.querySelector(".draft-row .draft-open") !== null, "the forward in Drafts");
    const row = container.querySelector<HTMLElement>(".draft-row .draft-open")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const listed = (): string[] => [...container.querySelectorAll<HTMLElement>(".view-compose [data-forward-part]")].map((r) => r.dataset.forwardPart!);
    await waitFor(() => listed().length > 0, "the forward's files listed");
    expect(listed(), "the files removed elsewhere came back").toEqual([A, C]);
    await act(async () => { container.querySelector<HTMLButtonElement>(".view-compose .btn.primary")!.click(); });
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
  const listedIn = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>(".view-compose [data-forward-part]")].map((r) => r.dataset.forwardPart!);
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
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => container.querySelector(".draft-row .draft-open") !== null, "the forward in Drafts");
    const row = container.querySelector<HTMLElement>(".draft-row .draft-open")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => container.querySelector(".view-compose .btn.primary") !== null, "the compose form");
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
    await act(async () => { container.querySelector<HTMLButtonElement>(".view-compose .btn.primary")!.click(); });
    await waitFor(() => sendOf() !== undefined, "the send reaching the wire");
    if (rowParts === null) expect(sendOf()!, "a forward with nothing removed named its parts").not.toHaveProperty("forwardParts");
    else expect(sendOf()!.forwardParts).toEqual([P[0], P[2]]);
  }, 20_000);

  it("while the original's list is still read, a forward with nothing removed sends every file", async () => {
    listHangs = true;
    const container = await openForwardDraft(null);
    await act(async () => { container.querySelector<HTMLButtonElement>(".view-compose .btn.primary")!.click(); });
    await waitFor(() => sendOf() !== undefined, "the send reaching the wire");
    expect(sendOf()!).not.toHaveProperty("forwardParts");
    expect(sendOf()!.forwardOf).toBe("m2");
  }, 20_000);

  it("a kept list is not sent before the original's list is read", async () => {
    listHangs = true;
    const container = await openForwardDraft([P[0], P[2]]);
    await act(async () => { container.querySelector<HTMLButtonElement>(".view-compose .btn.primary")!.click(); });
    await waitFor(() => container.querySelector(".forward-files-refusal") !== null, "the refusal said");
    expect(sendOf(), "a kept list went unread").toBeUndefined();
  }, 20_000);
});

describe("a message another mail client took away SAYS SO", () => {
  it("the reader sheet says it, and offers the live Trash window", async () => {
    mobile = true;
    const container = await shell(["m1", "m2"]);
    await openRow(container, "m1");
    expect(container.querySelector(".reader"), "no reader sheet at 390px").not.toBeNull();

    await tombstoneParent();

    expect(paneText(container, ".reader")).toContain(GONE);
    const link = [...container.querySelectorAll<HTMLElement>(".reader button")]
      .find((b) => (b.textContent ?? "").includes("Look in Trash"));
    expect(link, "no way to follow the message").toBeDefined();
    await act(async () => { link!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(window.location.hash).toBe("#/trash");
  });

  it("NEGATIVE ARM: nothing open still renders nothing open", async () => {
    mobile = true;
    const container = await shell(["m1", "m2"]);
    await tombstoneParent();
    expect(paneText(container, ".reader")).not.toContain(GONE);
    expect(paneText(document.body, "body")).not.toContain(GONE);
  });

  it("the OHBOX READING COLUMN says it — the surface at desktop width", async () => {
    const container = await shell(["m1", "m2"]);
    await openRow(container, "m1");
    expect(container.querySelector(".read-col .msg"), "no message in the column").not.toBeNull();

    await tombstoneParent();

    expect(paneText(container, ".read-col")).toContain(GONE);
  });

  it("NEGATIVE ARM: a column nobody opened anything in keeps its resting panel", async () => {
    const container = await shell(["m1", "m2"]);
    await tombstoneParent();
    expect(paneText(container, ".read-col")).not.toContain(GONE);
    // The resting panel is what stands there instead — the state this notice must not replace.
    expect(paneText(container, ".read-col")).toContain("Nothing open.");
  });
});
