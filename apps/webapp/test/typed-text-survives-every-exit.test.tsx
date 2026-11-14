/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import {
  COMPOSER_KEY, EMPTY_COMPOSE, composeSessionId, resetComposerForTest, writeComposeDraft,
  writeComposeRow,
} from "../app/shell/compose";
import { typeInto as typeIntoEditor } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";

/**
 * TEXT A PERSON TYPED REACHES A SERVER DRAFT OR A NAMED LOCAL UNIT ON EVERY EXIT, and no exit
 * drops it without a sentence. One case per exit, each driven through the shipped shell over a
 * real engine: a tab closing, a tab dying, a duplicated tab, the body ceiling, and a reply whose
 * send was under way when the message it answers was deleted elsewhere. The transport is the one
 * thing stubbed. Two pages are two mounts in turn; a closed page's adapter never answers again.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-27T09:00:00.000Z");
const SENDER = "colleague@example.invalid";
let roots: Root[] = [];
let seq = 0;
let sent: EngineMutation[] = [];
let pending: SyncChange[] = [];
let store: MirrorStore | null = null;
let engine: OhmailEngine | null = null;
let container: HTMLElement;
/** While true every `mail_send` waits for the test to answer it — a send under way. */
let holdSends = false;
/** `lose`: the answer never arrives, so the send stays queued; `refuse`: refused for good. */
let sendMode: "normal" | "lose" | "refuse" = "normal";
let heldSend: { resolve: () => void; reject: (err: Error) => void } | null = null;

/** One page of the app: once it is closed its adapter never answers again. */
interface Page { alive: boolean; root: Root }
const never = <T,>(): Promise<T> => new Promise<T>(() => {});

/* ── a lock manager the pages share, as a browser's is shared by its tabs ─────────────── */

interface FakeLocks {
  held: Map<string, string>;
  /** Another page letting go — the next waiter for the name is granted. */
  release: (name: string) => void;
  request: (...a: unknown[]) => Promise<unknown>;
  query: () => Promise<{ held: Array<{ name: string }>; pending: [] }>;
}
function installLocks(): FakeLocks {
  const held = new Map<string, string>();
  const waiters = new Map<string, Array<() => void>>();
  const release = (name: string): void => {
    held.delete(name);
    waiters.get(name)?.shift()?.();
  };
  const grant = async (name: string, fn: (l: unknown) => unknown): Promise<unknown> => {
    held.set(name, "this-page");
    // Released when the callback's promise settles; a page-long hold never settles.
    try { return await fn({ name, mode: "exclusive" }); } finally { release(name); }
  };
  const locks: FakeLocks = {
    held,
    release,
    request: async (name: unknown, opts: unknown, cb?: unknown) => {
      const n = name as string;
      const fn = (typeof opts === "function" ? opts : cb) as (l: unknown) => unknown;
      const o = (typeof opts === "function" ? {} : opts) as { ifAvailable?: boolean; signal?: AbortSignal };
      if (!held.has(n)) return grant(n, fn);
      if (o.ifAvailable) return fn(null);
      return new Promise((resolve, reject) => {
        const go = (): void => { resolve(grant(n, fn)); };
        const queue = waiters.get(n) ?? [];
        queue.push(go);
        waiters.set(n, queue);
        o.signal?.addEventListener("abort", () => {
          const i = queue.indexOf(go);
          if (i >= 0) queue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
    query: async () => ({ held: [...held.keys()].map((name) => ({ name })), pending: [] }),
  };
  Object.defineProperty(window.navigator, "locks", { configurable: true, value: locks });
  return locks;
}

/* ── the account ──────────────────────────────────────────────────────────────────────── */

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-27T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

const consentTransport = {
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
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

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: SENDER, name: "The colleague" },
  to: [{ address: "me@example.invalid", name: "Me" }],
  date: "2026-09-27T08:29:00.000Z", unread: false, updatedAt: "2026-09-27T08:29:00.000Z",
} as unknown as EngineMessage);

async function storeWith(ids: string[], rows: string[]): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  for (const id of ids) {
    const m = msg(id);
    await s.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
      {
        type: "rule", op: "create", id: `r-${id}`, seq: ++seq, updatedAt: m.updatedAt,
        entity: {
          id: `r-${id}`, kind: "sender", match: SENDER, destination: "INBOX", enabled: true,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      },
    ] as SyncChange[]);
  }
  // A draft row the account already holds, under a name a test chose — the one a tab wrote.
  for (const row of rows) {
    const effects = mutationEffects(s, {
      kind: "draft_save", draftId: null, mailboxId: "mb1", subject: "on the account", body: "older",
      to: [], cc: [], bcc: [],
    } as EngineMutation, { now: () => NOW, uuid: () => row });
    await s.applyChanges(effects.map((e) => ({
      type: e.type, op: "create", id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
    })) as SyncChange[]);
  }
  return s;
}

function engineOver(s: MirrorStore, page: Page): OhmailEngine {
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    adapter: {
      sync: async () => {
        if (!page.alive) return never();
        const pageOf = pending;
        pending = [];
        return {
          changes: {
            creates: pageOf.filter((c) => c.op !== "delete"), updates: [], moves: [],
            deletes: pageOf.filter((c) => c.op === "delete"),
          },
          cursor: s.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        if (!page.alive) return never();
        sent.push(m);
        if (m.kind === "mail_send" && sendMode === "lose") {
          throw new MutationRejectedError("connection reset", { code: "network", retryable: true });
        }
        if (m.kind === "mail_send" && sendMode === "refuse") {
          throw new MutationRejectedError("the mail server refused it", {
            status: 409, code: "mailbox_disabled", retryable: false,
          });
        }
        if (m.kind === "mail_send" && holdSends) {
          await new Promise<void>((resolve, reject) => { heldSend = { resolve, reject }; });
        }
        const changes = mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        await s.applyChanges(changes);
        const created = m.kind === "draft_save" && m.draftId === null
          ? changes.find((c) => c.type === "draft")?.id ?? null
          : null;
        return {
          changes, seq: changes[changes.length - 1]?.seq ?? null,
          ...(created ? { entityId: created } : {}),
        };
      },
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

async function mountShell(opts: {
  hash: string; messages?: string[]; rows?: string[]; store?: MirrorStore;
}): Promise<Page> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  // The route the page OPENS on, before anything renders: a page does not arrive by navigating.
  window.location.hash = opts.hash;
  store = opts.store ?? await storeWith(opts.messages ?? [], opts.rows ?? []);
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const page: Page = { alive: true, root };
  engine = engineOver(store, page);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, {
          children: h(AppShell as never, {
            demo: false, engine, consentTransport, mailboxFacts: async () => ROSTER,
          } as never),
        }),
      }),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  await goHash(opts.hash);
  if (opts.hash === "#/compose") {
    await waitFor(() => container.querySelector(".view-compose") !== null, "the compose view");
  }
  return page;
}

/** A tab closing: `pagehide`, then nothing that page does reaches anything again. */
async function closeTab(page: Page): Promise<void> {
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  page.alive = false;
  await act(async () => { page.root.unmount(); });
  roots = roots.filter((r) => r !== page.root);
  document.body.innerHTML = "";
}

/** A tab that dies: no event at all. */
async function killTab(page: Page): Promise<void> {
  page.alive = false;
  await act(async () => { page.root.unmount(); });
  roots = roots.filter((r) => r !== page.root);
  document.body.innerHTML = "";
}

/** A fresh tab: its own `sessionStorage`, nothing this page has adopted yet. */
function newTab(): void {
  window.sessionStorage.clear();
  resetComposerForTest();
}

/** A tab whose `sessionStorage` names this composer — the state a Duplicate tab starts in. */
function tabNamed(id: string): void {
  resetComposerForTest();
  window.sessionStorage.setItem(COMPOSER_KEY, id);
}

async function goHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

const q = <T extends Element>(sel: string): T | null => container.querySelector<T>(sel);

async function typeInto(sel: string, value: string): Promise<void> {
  const input = q<HTMLInputElement>(sel)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
};

async function waitFor(p: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (p()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

const pause = async (ms = 80): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
};

type DraftSave = Extract<EngineMutation, { kind: "draft_save" }>;
const drafts = (): DraftSave[] => sent.filter((m): m is DraftSave => m.kind === "draft_save");
const subjects = (): string[] => drafts().map((m) => m.subject);
const subjectShown = (): string => q<HTMLInputElement>("#compose-subject")?.value ?? "";
const notes = (): string[] => [...container.querySelectorAll(".send-note")].map((n) => n.textContent ?? "");

beforeEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetComposerForTest();
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sent = [];
  pending = [];
  seq = 0;
  holdSends = false;
  heldSend = null;
  sendMode = "normal";
});

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (window.navigator as unknown as Record<string, unknown>).locks;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

const message = (subject: string, body = `${subject} words`) =>
  ({ ...EMPTY_COMPOSE, to: "ana@example.invalid", subject, body });

describe("a tab that closes inside the autosave window", () => {
  /**
   * COMPOSER-CLOSE-DOES-NOT-REACH-A-CLOSING-TAB. The last keystroke is in the local unit when
   * `pagehide` has run — synchronously, nothing awaited — and the next open writes it to the
   * account, wherever that open lands.
   */
  it("leaves the last keystroke in the local unit, and the next open writes it to the account", async () => {
    newTab();
    const first = await mountShell({ hash: "#/compose" });
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "Friday");
    expect(drafts(), "the debounce did not hold — this case measures nothing").toHaveLength(0);

    await closeTab(first);
    const slot = JSON.parse(window.localStorage.getItem("ohmail.ui.compose.local") ?? "{}") as { subject?: string };
    expect(slot.subject, "the closing tab's last keystroke is not in the local unit").toBe("Friday");
    expect(drafts(), "the closed page reached the account after all").toHaveLength(0);

    newTab();
    await mountShell({ hash: "#/ohbox" });
    await waitFor(
      () => subjects().includes("Friday"), "the next open writing the message to the account",
      AUTOSAVE_DELAY_MS + 3000,
    );
    expect(drafts()[0]!.draftId, "a create, for a message the account never held").toBeNull();
  });

  it("CONTROL: an empty composer closing writes nothing at the next open", async () => {
    newTab();
    const first = await mountShell({ hash: "#/compose" });
    await closeTab(first);
    newTab();
    await mountShell({ hash: "#/ohbox" });
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect(drafts(), "an untouched composer became a draft").toHaveLength(0);
  });
});

describe("a duplicated tab", () => {
  /**
   * COMPOSE-DUPLICATED-TAB-SHARES-ITS-COMPOSER. "Duplicate tab" copies `sessionStorage`, so the
   * copy starts under the original's composer id. It takes its own: it neither opens the other
   * tab's message nor writes into that tab's draft row or local unit.
   */
  it("gets its own composer while the original is still open", async () => {
    const locks = installLocks();
    tabNamed("dup-x");
    writeComposeDraft(message("A's message"));
    composeSessionId();
    writeComposeRow("row-a");
    locks.held.set(`${COMPOSER_KEY}.dup-x`, "the original tab");
    tabNamed("dup-x");

    await mountShell({ hash: "#/compose", rows: ["row-a"] });
    await pause();
    expect(subjectShown(), "the duplicate opened the other tab's message").toBe("");

    await typeInto("#compose-to", "bo@example.invalid");
    await typeInto("#compose-subject", "B's own");
    await waitFor(() => drafts().length > 0, "the duplicate's own save", AUTOSAVE_DELAY_MS + 2000);
    expect(drafts()[0]!.draftId, "the duplicate wrote into the other tab's draft").toBeNull();
    const aUnit = JSON.parse(window.localStorage.getItem("ohmail.ui.compose.local.dup-x") ?? "{}") as { subject?: string };
    expect(aUnit.subject, "the duplicate wrote over the other tab's local unit").toBe("A's message");
    expect(window.localStorage.getItem("ohmail.compose.row.local.dup-x")).toBe("row-a");
    expect(window.sessionStorage.getItem(COMPOSER_KEY)).not.toBe("dup-x");
  });

  it("puts a closed tab's waiting message in its own composer, never in the original's keys", async () => {
    const locks = installLocks();
    window.localStorage.setItem("ohmail.ui.compose.local", JSON.stringify(message("left by a closed tab")));
    locks.held.set(`${COMPOSER_KEY}.dup-z`, "the original tab, composing nothing");
    tabNamed("dup-z");

    await mountShell({ hash: "#/compose" });
    await waitFor(() => subjectShown() === "left by a closed tab", "the waiting message in the duplicate");
    expect(window.localStorage.getItem("ohmail.ui.compose.local.dup-z"), "it landed in the original tab's keys")
      .toBeNull();
  });

  it("CONTROL: a reload whose old page still holds the lock for a moment keeps its composer", async () => {
    const locks = installLocks();
    tabNamed("reload-y");
    const old = await mountShell({ hash: "#/compose" });
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "mine across the reload");
    // A reload: `pagehide`, and the old page's lock outlives it by a moment.
    await closeTab(old);
    resetComposerForTest();
    setTimeout(() => locks.release(`${COMPOSER_KEY}.reload-y`), 100);

    await mountShell({ hash: "#/compose" });
    await waitFor(() => subjectShown() === "mine across the reload", "the reload restoring its own message");
    expect(window.sessionStorage.getItem(COMPOSER_KEY), "a reload was taken for a duplicate").toBe("reload-y");
  });

  it("CONTROL: a lock manager that never answers holds nothing up — the message is restored", async () => {
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: { request: () => never(), query: () => never() },
    });
    tabNamed("silent-x");
    writeComposeDraft(message("restored all the same"));
    tabNamed("silent-x");

    await mountShell({ hash: "#/compose" });
    await waitFor(() => subjectShown() === "restored all the same", "the restore past a silent lock manager", 8000);
  });

  it("CONTROL: a reload of the same tab keeps its composer and its message", async () => {
    installLocks();
    tabNamed("reload-x");
    writeComposeDraft(message("still mine"));
    tabNamed("reload-x");

    await mountShell({ hash: "#/compose" });
    await waitFor(() => subjectShown() === "still mine", "the reload restoring its own message");
    expect(window.sessionStorage.getItem(COMPOSER_KEY)).toBe("reload-x");
  });
});

describe("a tab that dies without pagehide", () => {
  /**
   * COMPOSE-TAB-THAT-DIES-KEEPS-ITS-MESSAGE-TO-ITSELF. A crashed tab's unit sits under its own
   * composer key and no composer adopted it. The next open takes it, says so, and keeps its row.
   */
  it("is offered back at the next open, with a sentence and its own row", async () => {
    installLocks();
    newTab();
    const dead = await mountShell({ hash: "#/compose", rows: ["row-x"] });
    const deadId = window.sessionStorage.getItem(COMPOSER_KEY)!;
    writeComposeDraft(message("lost in a crash"));
    writeComposeRow("row-x");
    await killTab(dead);
    window.navigator.locks && (window.navigator.locks as unknown as FakeLocks).held.clear();

    newTab();
    await mountShell({ hash: "#/ohbox", rows: ["row-x"] });
    await pause(200);
    await goHash("#/compose");
    await waitFor(() => container.querySelector(".view-compose") !== null, "the compose view");
    expect(subjectShown(), "the dead tab's message was not offered back").toBe("lost in a crash");
    expect(document.body.textContent ?? "", "the message came back without a word")
      .toContain(messages.compose.recoveredFromClosedTab);
    expect(window.localStorage.getItem(`ohmail.ui.compose.local.${deadId}`), "the dead tab's unit outlived the adoption")
      .toBeNull();
    await waitFor(() => drafts().length > 0, "the recovered message reaching the account", AUTOSAVE_DELAY_MS + 2000);
    expect(drafts()[0]!.draftId, "a second row for a message that already had one").toBe("row-x");
  });

  /** A unit as a tab of this bundle leaves it: written while that tab held its composer. */
  const unitOf = (id: string, subject: string, locked: boolean): void => {
    window.localStorage.setItem(`ohmail.ui.compose.local.${id}`, JSON.stringify({
      ...message(subject), attachments: undefined, ...(locked ? { locked: true } : {}),
    }));
  };

  it("CONTROL: a unit whose tab is still open is left where it is", async () => {
    const locks = installLocks();
    unitOf("alive-x", "the other tab is writing this", true);
    locks.held.set(`${COMPOSER_KEY}.alive-x`, "the other tab");

    newTab();
    await mountShell({ hash: "#/compose" });
    await pause(200);
    expect(subjectShown(), "an open tab's message was taken from it").toBe("");
    expect(window.localStorage.getItem("ohmail.ui.compose.local.alive-x")).not.toBeNull();
  });

  it("CONTROL: a unit no lock ever covered (a tab of an older build, maybe still open) is left", async () => {
    installLocks();
    unitOf("older-x", "written by an older build", false);

    newTab();
    await mountShell({ hash: "#/compose" });
    await pause(200);
    expect(subjectShown(), "an unmarked unit was taken from a tab that may still be open").toBe("");
    expect(window.localStorage.getItem("ohmail.ui.compose.local.older-x")).not.toBeNull();
  });

  it("CONTROL: a recovery answered after the restore has run moves nothing", async () => {
    const locks = installLocks();
    const ask = locks.request;
    // The cross-tab recovery lock answers only after the restore gave up waiting for it.
    locks.request = async (name: unknown, opts: unknown, cb?: unknown) => {
      if (name !== `${COMPOSER_KEY}:recover`) return ask(name, opts, cb);
      await new Promise((r) => setTimeout(r, 3_500));
      return ask(name, opts, cb);
    };
    unitOf("dead-late", "left by a dead tab", true);
    newTab();

    await mountShell({ hash: "#/compose" });
    await pause(4_500);
    expect(subjectShown()).toBe("");
    expect(window.localStorage.getItem("ohmail.ui.compose.local.dead-late"), "moved under a composer that was not told")
      .not.toBeNull();
  });

  it("CONTROL: the same dead unit is offered to a composer only while it holds no message", async () => {
    installLocks();
    unitOf("dead-y", "left by a dead tab", true);
    newTab();
    writeComposeDraft(message("already writing"));

    await mountShell({ hash: "#/compose" });
    await pause(200);
    expect(subjectShown(), "the dead tab's unit replaced a message in progress").toBe("already writing");
    expect(window.localStorage.getItem("ohmail.ui.compose.local.dead-y"), "it waits for the next composer")
      .not.toBeNull();
  });
});

describe("the body ceiling", () => {
  /**
   * COMPOSER-CLOSES-OVER-A-DRAFT-THE-CEILING-REFUSES. The account refuses a body past
   * `DRAFT_BODY_MAX_BYTES`, so closing over one is closing over a message nothing holds: the
   * composer stays with the refusal, and Discard is still the way to let it go.
   */
  it("keeps the composer open over a message too long to save, and Discard still lets it go", async () => {
    newTab();
    writeComposeDraft({ ...message("Long"), body: "x".repeat(DRAFT_BODY_MAX_BYTES + 16) });
    await mountShell({ hash: "#/compose" });
    await waitFor(() => subjectShown() === "Long", "the long message restored");

    await key("Escape");
    await pause();
    expect(window.location.hash, "the composer closed over a message the account refused for size")
      .toBe("#/compose");
    expect(notes().some((n) => n.includes("couldn't be saved")), `no refusal sentence: ${JSON.stringify(notes())}`)
      .toBe(true);
    expect(notes().some((n) => n.includes("Too long to save")), "the way to shorten it is not said").toBe(true);

    await act(async () => { q<HTMLButtonElement>(".compose-foot .compose-cancel")!.click(); });
    const confirm = [...container.querySelectorAll<HTMLButtonElement>(".compose-confirm button")]
      .find((b) => b.textContent === "Discard message");
    expect(confirm, "there is no way to discard it").toBeTruthy();
    await act(async () => { confirm!.click(); });
    await pause();
    expect(window.location.hash).toBe("#/ohbox");
  });
});

describe("a reply whose send was under way when its parent was deleted elsewhere", () => {
  const laneBody = (): string | null => window.localStorage.getItem("ohmail.ui.reply:m1");

  async function replySentThenParentGone(text: string): Promise<void> {
    newTab();
    holdSends = true;
    await mountShell({ hash: "#/ohbox", messages: ["m1", "m2"] });
    await waitFor(() => container.querySelector('.view-ohbox .row[data-id="m1"]') !== null, "m1 in the Ohbox");
    const row = container.querySelector<HTMLElement>('.view-ohbox .row[data-id="m1"]')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await key("r");
    const surface = container.querySelector<HTMLElement>(".read-col .msg .rte-surface, .reader .msg .rte-surface");
    expect(surface, "the reply editor never mounted").not.toBeNull();
    await act(async () => { typeIntoEditor(surface!, text); });
    await waitFor(() => (laneBody() ?? "").includes(text), "the reply lane holding the text");
    await act(async () => { q<HTMLButtonElement>(".reply-actions .btn.primary")!.click(); });
    await waitFor(() => heldSend !== null, "the send on the wire");

    pending = [{ type: "message", op: "delete", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange];
    await act(async () => { await engine!.syncOnce(); });
    for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
    expect(drafts(), "a row was written for a reply whose send was still under way").toHaveLength(0);
    expect(laneBody()).toContain(text);
  }

  /**
   * PROMOTED-LANE-WITH-A-SEND-UNDER-WAY-IS-LEFT-UNREACHABLE. The lane is skipped while its send
   * is out; when the send is refused for good, the lane is handed back as a draft.
   */
  it("is saved as a draft once its send is refused for good", async () => {
    await replySentThenParentGone("the answer that did not go");
    await act(async () => {
      heldSend!.reject(new MutationRejectedError("the mail server refused it", {
        status: 422, code: "send_failed", retryable: false,
      }));
    });
    await waitFor(() => drafts().length > 0, "the lane handed back once its send gave up");
    expect(drafts()[0]!.body).toContain("the answer that did not go");
    expect(drafts()[0]!.inReplyToMessageId).toBe("m1");
    await waitFor(() => laneBody() === null, "the lane cleared after the row");
  });

  /** The same, across a reload: the send is replayed at the next open and refused there. */
  it("is saved as a draft when the send restored at the next open is refused for good", async () => {
    newTab();
    sendMode = "lose";
    const first = await mountShell({ hash: "#/ohbox", messages: ["m1", "m2"] });
    const kept = store!;
    const row = container.querySelector<HTMLElement>('.view-ohbox .row[data-id="m1"]')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await key("r");
    const surface = container.querySelector<HTMLElement>(".read-col .msg .rte-surface, .reader .msg .rte-surface");
    await act(async () => { typeIntoEditor(surface!, "the answer from yesterday"); });
    await waitFor(() => (laneBody() ?? "").includes("the answer from yesterday"), "the reply lane");
    await act(async () => { q<HTMLButtonElement>(".reply-actions .btn.primary")!.click(); });
    await waitFor(() => sent.some((m) => m.kind === "mail_send"), "the send reaching the wire");
    await pause(100);
    await killTab(first);

    // Another mail app deleted the message it answers while this app was closed.
    await kept.applyChanges([{
      type: "message", op: "delete", id: "m1", seq: 9000, updatedAt: NOW.toISOString(), entity: null,
    } as unknown as SyncChange]);
    sendMode = "refuse";
    sent = [];
    newTab();
    await mountShell({ hash: "#/ohbox", store: kept });
    await waitFor(() => sent.some((m) => m.kind === "mail_send"), "the restored send replayed", 6000);
    await waitFor(() => drafts().length > 0, "the lane handed back after its restored send was refused", 6000);
    expect(drafts()[0]!.body).toContain("the answer from yesterday");
  });

  it("CONTROL: a send refused as a copy of one already sent is not handed back", async () => {
    await replySentThenParentGone("the answer that went once already");
    await act(async () => {
      heldSend!.reject(new MutationRejectedError("you already sent this", {
        status: 409, code: "duplicate_send", retryable: false,
      }));
    });
    await pause(200);
    expect(drafts(), "a copy of a delivered message became a draft").toHaveLength(0);
  });

  it("CONTROL: a send nobody can confirm keeps its hold and is not handed back", async () => {
    await replySentThenParentGone("the answer that may have gone");
    await act(async () => {
      heldSend!.reject(new MutationRejectedError("We could not confirm this send.", {
        status: 502, code: "send_unverified", retryable: false,
      }));
    });
    await pause(200);
    expect(drafts(), "a message that may have been delivered became a draft").toHaveLength(0);
  });

  it("CONTROL: a send that is delivered after the parent died leaves no draft behind", async () => {
    await replySentThenParentGone("the answer that went");
    await act(async () => { heldSend!.resolve(); });
    await pause(200);
    expect(drafts(), "a delivered reply became a draft as well").toHaveLength(0);
  });
});
