/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_REPLY_COST_CREDITS } from "../app/shell/draft-reply";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, type EngineMutation, type FetchLike, type MutationResult,
} from "@ohmail/client-engine";
import { FIXED_NOW, makeDeps, seedMailbox, seedSession } from "../../../packages/api/test/helpers.js";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { editorOf, typeInto } from "./fixtures/rich-editor-driver";
import { withNodeBlobs } from "./fixtures/node-blobs";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE EDITOR, WIRED — what reaches the wire, and what a bought draft is allowed to touch.
 *
 * The rich editor, the two scratch-buffer halves, the server sanitizer and the drafting route
 * all shipped separately and NONE of them was connected to a surface. So every assertion here
 * is about a seam that has never carried traffic, and the two that matter most are about
 * things NOT happening:
 *
 *  · a message nobody formatted must go out exactly as it did before this editor existed —
 *    `body`, no `html`, no `multipart/alternative`. Otherwise "we added formatting" quietly
 *    means "we changed how all of your mail is encoded";
 *  · a DRAFTED reply is not a sent reply. It dispatches no mutation at all, so it cannot
 *    discharge a Reply Run's debt — that discharge is `settle`'s, keyed on a send settling.
 *    Asserted by counting mutations rather than by reading the code, because the code that
 *    would break it is code somebody adds later.
 *
 * Driven through the whole shell on the demo world, because every one of these lives in the
 * WIRING and not in a component: what the editor emits, what the form does with it, what the
 * plan puts on the mutation, and who is allowed to write `triage_set`. The byte-shape guard alone
 * runs over the real API, because what it protects is the request.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every `api()` call the drafting control makes — the route, and the headers it carried. */
const apiCalls: Array<{ path: string; init?: { method?: string; headers?: Record<string, string> } }> = [];
let apiImpl: (path: string, init?: unknown) => Promise<unknown> = async () => ({});
/** What `apiConfigured()` answers: on for the demo world, off over the real API (`wireShell`). */
let cloudClient = true;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    // The demo world has no API, and `useDraftReply` correctly refuses to spend there. The
    // point of this file is the path a REAL account takes, so the one predicate that decides
    // it is overridden and everything above it stays the shipped code.
    apiConfigured: () => cloudClient,
    api: (path: string, init?: unknown) => {
      apiCalls.push({ path, init: init as never });
      return apiImpl(path, init);
    },
  };
});

let roots: Root[] = [];
let dispatched: EngineMutation[] = [];
const REAL_MUTATE = OhmailEngine.prototype.mutate;

beforeEach(() => {
  window.location.hash = "";
  dispatched = [];
  apiCalls.length = 0;
  apiImpl = async () => ({});
  cloudClient = true;
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
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
  vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(async function patched(
    this: OhmailEngine, m: EngineMutation,
  ): Promise<MutationResult> {
    dispatched.push(m);
    return REAL_MUTATE.call(this, m);
  });
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  /**
   * …AND THEN OPEN A MESSAGE.
   *
   * `r`, the action bar's More disclosure and every `.read-col` selector below all need a
   * message in the reading column. The shell used to put one there by itself — its Ohbox
   * selection resolved through `?? allOhbox[0]`, so arriving at the route opened the newest
   * unread message with nobody having asked. That is gone; the Ohbox rests until a row is
   * picked, so this presses the key that picks one.
   */
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
  });
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

const clickText = async (el: HTMLElement, label: string): Promise<void> => {
  // The label WITHOUT the keycap the button may wear (Send prints its ⌘↵ cap now).
  const bare = (x: HTMLElement): string => {
    const kbd = x.querySelector("kbd")?.textContent ?? "";
    return (x.textContent ?? "").replace(kbd, "").trim();
  };
  const b = [...el.querySelectorAll<HTMLButtonElement>("button")]
    .find((x) => bare(x) === label);
  if (!b) throw new Error(`no button reading ${JSON.stringify(label)} on screen`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
};

const replySurface = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(".read-col .reply-editor .rte-surface");
const composeSurface = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>(".compose-editor .rte-surface")!;
const openReplyId = (el: HTMLElement): string =>
  el.querySelector<HTMLElement>(".read-col .reply[data-reply-for]")?.dataset.replyFor ?? "";

const sends = (): Array<Record<string, unknown>> =>
  dispatched.filter((m) => m.kind === "mail_send") as never;

async function goCompose(): Promise<void> {
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  await drain();
}

async function waitFor(p: () => boolean, what: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (p()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

/** A request the engine's HttpAdapter sent, as the API received it. */
interface WireRequest { method: string; path: string; body: Record<string, unknown> | null }

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

/**
 * THE SAME SHELL OVER THE REAL API, for the byte-shape guard. The engine's HttpAdapter reaches
 * `createApp(apiRoutes)` through a fetch that records every request, and the server's send adapter
 * records what it delivers; the spy above still runs REAL_MUTATE. The shell's own Cloud client is
 * off, as in `compose-formatting-cleared-sends.test.tsx`: the wire under test is the engine's.
 */
async function wireShell(): Promise<{ el: HTMLElement; wire: WireRequest[]; delivered: OutboundMessage[] }> {
  cloudClient = false;
  const delivered: OutboundMessage[] = [];
  const sendAdapter: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
    async messageInSent() { return false; },
    async close() { /* nothing */ },
  });
  const { db, deps } = await withNodeBlobs(() => makeDeps(FIXED_NOW, {}, { sendAdapter }));
  const s = await seedSession(db, { now: FIXED_NOW });
  const address = "me@lichtgrat.example";
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address });
  const app = createApp(apiRoutes);
  const wire: WireRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : null;
    wire.push({
      method: (init?.method ?? "GET").toUpperCase(), path: new URL(String(url)).pathname,
      body: raw === null ? null : JSON.parse(raw) as Record<string, unknown>,
    });
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...(deps as ApiDeps), session: null, idempotency: null });
  };
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch }), store });
  const roster = [{
    id: mailboxId, address, status: "connected", errorCode: null, disabledReason: null,
    syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: "2026-09-09T08:59:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z", organizerRole: "organizer" as const, organizedBy: null,
    organizeConsentedAt: "2026-09-01T00:00:00.000Z",
  } as MailboxFacts];
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, {
        children: h(AppShell as never, { demo: false, engine, consentTransport, mailboxFacts: async () => roster } as never),
      }) }),
    }));
  });
  await drain();
  return { el: container, wire, delivered };
}

/* ══ 1. WHAT REACHES THE WIRE ═══════════════════════════════════════════════════════════ */

describe("a message with no formatting in it leaves exactly as it always did", () => {
  it("carries `body` and NO `html` key at all", async () => {
    /**
     * THE BYTE-SHAPE GUARD, and the reason it is the first test in the file.
     *
     * `editor.getHTML()` answers `<p>hi</p>` for a document nobody formatted. Emitting that as
     * the markup half would put `html` on every send, and the http adapter sends `html`
     * INSTEAD of `body` — so every plain note in the product would silently become a
     * `multipart/alternative` whose plain part is the server's re-rendering of markup nobody
     * wrote. `RichEditor.emit` decides this by round-tripping the document through
     * `richToHtml`; delete that comparison and this goes red on the mutation and on the wire.
     *
     * READ ON THE WIRE, because the request is what this protects. The shell may say `html: null`
     * (the editor holds no formatting); `Engine.enrich` keeps that only for a row the mirror holds
     * as formatted, so a plain note's requests stay what they always were. Two notes, so every
     * request that writes one is read: sent after the pause saved it (`POST /drafts`, then Send's
     * own `PUT /drafts/:id`), and sent at once (Send's own `POST /drafts`).
     */
    const wire: WireRequest[] = [];
    const delivered: OutboundMessage[] = [];
    for (const [text, afterThePause] of [["Donnerstag passt.\n\nBis dann.", true], ["Kurz und gut.", false]] as const) {
      for (const root of roots) await act(() => { root.unmount(); });
      roots = [];
      document.body.innerHTML = "";
      const w = await wireShell();
      await goCompose();
      await waitFor(() => w.el.querySelector(".compose-editor .rte-surface") !== null, "the compose editor");
      const to = w.el.querySelector<HTMLInputElement>("#compose-to")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
          .set!.call(to, "someone@example.test");
        to.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { typeInto(composeSurface(w.el), text); });
      if (afterThePause) {
        await waitFor(() => w.wire.some((r) => r.method === "POST" && r.path === "/drafts"), "the autosave", AUTOSAVE_DELAY_MS + 6000);
      }
      await clickText(w.el, "Send");
      await waitFor(() => w.delivered.length === 1, "the delivery");
      wire.push(...w.wire);
      delivered.push(...w.delivered);
    }

    // The shell: no markup on any mutation that writes the message (`html: null` or no key).
    expect(sends().map((m) => m.body), "pressing Send dispatched no mail_send")
      .toEqual(["Donnerstag passt.\n\nBis dann.", "Kurz und gut."]);
    const written = dispatched.filter((m) => m.kind === "draft_save" || m.kind === "mail_send");
    expect(written.filter((m) => "html" in m && m.html != null), "a plain message reached the mutation as markup")
      .toEqual([]);
    // The wire: every save carries `body`, and no request carries an `html` key.
    const saves = wire.filter((r) => (r.method === "POST" || r.method === "PUT") && /^\/drafts(\/[^/]+)?$/.test(r.path));
    expect(saves.map((r) => `${r.method} ${r.path === "/drafts" ? r.path : "/drafts/:id"}`))
      .toEqual(expect.arrayContaining(["POST /drafts", "PUT /drafts/:id"]));
    for (const r of saves) expect(Object.keys(r.body ?? {}), `${r.method} ${r.path} carries no body`).toContain("body");
    expect(
      wire.filter((r) => r.body !== null && "html" in r.body).map((r) => `${r.method} ${r.path}`),
      "a plain message grew an `html` field, so it now leaves as multipart",
    ).toEqual([]);
    // And what left is text alone.
    expect(delivered.map((m) => [m.text, m.html ?? null])).toEqual([
      ["Donnerstag passt.\n\nBis dann.", null], ["Kurz und gut.", null],
    ]);
  }, 60_000);

  it("reports every change in a burst, including the one that empties the editor", async () => {
    /**
     * FOUND ON THE LIVE BUILD, not here — which is why it is written down at this length.
     *
     * The editor refuses to report a value the caller already has, because TipTap emits
     * `update` for things that are not edits and one of those deleted a real compose draft.
     * The first version of that guard compared against the `value` PROP, which looks
     * equivalent and is not: a prop refreshes on render, so two transactions inside one tick
     * are both measured against the state before the first of them.
     *
     * Driven in production against `app.ohmail.app`: `setContent` → `toggleBold` →
     * `clearContent` in one block wrote the text, wrote the formatted envelope, and then
     * SILENTLY DROPPED THE CLEAR — the editor was empty on screen and the buffer still held
     * the reply, so reopening it resurrected text the person had deleted. A human cannot
     * produce that sequence (React flushes between discrete events), but the drafter's own
     * `placeDraft` and any paste handler can, which is what makes it worth a guard rather
     * than a note.
     *
     * Revert `told.current = { text, html }` inside `emit` and this fails on the third read
     * with the envelope still in the key.
     */
    const el = await shell();
    await key("r");
    const surface = replySurface(el)!;
    const id = openReplyId(el);
    const bufferKey = `ohmail.ui.reply:${id}`;
    const seen: Array<string | null> = [];

    // ONE act(), so React commits nothing between the three transactions — that is the
    // condition under test, not an incidental detail of how the test is written.
    await act(async () => {
      const ed = editorOf(surface);
      ed.commands.setContent("<p>Donnerstag passt.</p>");
      seen.push(window.localStorage.getItem(bufferKey));
      ed.commands.selectAll();
      ed.commands.toggleBold();
      seen.push(window.localStorage.getItem(bufferKey));
      ed.chain().selectAll().deleteSelection().run();
      seen.push(window.localStorage.getItem(bufferKey));
    });

    expect(seen[0], "the plain text was not stored").toBe("Donnerstag passt.");
    expect(seen[1], "the formatting was not stored").toContain("<strong>");
    expect(seen[2], "emptying the editor left the old reply in the buffer").toBeNull();
  });

  it("keeps the scratch buffer a BARE STRING, which is what an older bundle can read", async () => {
    // `serializeRichValue`'s bare-string branch exists so a plain reply survives a rollback to
    // the bundle before this editor. If the editor reported markup for every document, that
    // branch would be unreachable and nothing would say so.
    const el = await shell();
    await key("r");
    await act(async () => { typeInto(replySurface(el)!, "Kurz und gut."); });
    expect(window.localStorage.getItem(`ohmail.ui.reply:${openReplyId(el)}`))
      .toBe("Kurz und gut.");
  });
});

describe("a message somebody formatted carries both halves, and they say different things", () => {
  it("puts the markup in `html` and the editor's plain rendering in `body`", async () => {
    const el = await shell();
    await key("r");
    const surface = replySurface(el)!;
    await act(async () => { typeInto(surface, "yes"); });
    await act(async () => { editorOf(surface).commands.selectAll(); });
    await act(async () => { editorOf(surface).commands.toggleBold(); });
    await clickText(el, "Send");
    await drain();

    const m = sends()[0]!;
    expect(m.html, "the markup never reached the mutation").toContain("<strong>");
    // `body` stays the LOCAL plain rendering — the optimistic row shows it and `canSend`
    // judges it. It is NOT what a plaintext recipient reads: the server derives that from the
    // sanitized markup, so the two halves of the multipart cannot be made to disagree here.
    expect(m.body).toBe("yes");
  });
});

/* ══ 2. WHAT COMES BACK OUT OF THE BUFFER ═══════════════════════════════════════════════ */

describe("a reply begun before this editor existed is not reinterpreted", () => {
  it("restores a bare string containing angle brackets as literal text, not as formatting", async () => {
    /**
     * The legacy key holds a BARE STRING for anybody who was mid-reply when this shipped, and
     * `setContent` parses what it is given as HTML. So somebody who typed `<b>` into the old
     * textarea would have had it become bold on restore — and the next keystroke would have
     * persisted that as markup they never wrote. Both doors escape now (`richToHtml`); the
     * initial-content one did not, and its guard was green because the sync effect corrected
     * the document one frame later.
     */
    const el = await shell();
    // Open once to learn the id the buffer is keyed by, then seed it and reopen.
    await key("r");
    const id = openReplyId(el);
    await key("Escape");
    window.localStorage.setItem(`ohmail.ui.reply:${id}`, "a <b>literal</b> tag");
    await key("r");
    await drain();

    const surface = replySurface(el)!;
    expect(surface.textContent).toContain("a <b>literal</b> tag");
    expect(surface.innerHTML, "the stored text was parsed as markup").not.toContain("<b>");
  });

  it("restores a stored ENVELOPE as formatting, and not as its own JSON", async () => {
    /**
     * THE OTHER DIRECTION, and it was unguarded — a mutation that replaced `parseRichValue`
     * with a raw `getItem` left every other suite green, because every other suite writes
     * plain replies and a plain reply is stored as a bare string. So the envelope branch had
     * no witness at all: somebody would have found it by reopening a formatted reply and
     * being shown `{"text":"yes","html":…}` in the editor.
     */
    const el = await shell();
    await key("r");
    const id = openReplyId(el);
    await key("Escape");
    window.localStorage.setItem(
      `ohmail.ui.reply:${id}`,
      JSON.stringify({ text: "yes", html: "<p><strong>yes</strong></p>" }),
    );
    await key("r");
    await drain();

    const surface = replySurface(el)!;
    expect(surface.querySelectorAll("strong"), "the markup half was dropped").toHaveLength(1);
    expect(surface.textContent, "the envelope was shown to the user as text")
      .not.toContain('{"text"');
  });
});

/* ══ 3. THE DRAFTER — THE COST, AND THE DEBT IT MUST NOT SETTLE ═════════════════════════ */

/** Press "Draft reply", which lives in the action bar's More disclosure. */
async function openDrafter(el: HTMLElement): Promise<void> {
  const more = el.querySelector<HTMLButtonElement>(".read-col .abar-more")!;
  await act(async () => { more.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await clickText(el, "Draft reply");
  await drain();
}

describe("buying a drafted reply", () => {
  it("states the cost and spends NOTHING until it is confirmed", async () => {
    const el = await shell();
    await openDrafter(el);

    const card = el.querySelector<HTMLElement>(".read-col .dr-card")!;
    expect(card, "the offer did not render where the draft will land").toBeTruthy();
    // The COST IS NAMED, and it is the REAL price. This asserted "one unit of your AI budget"
    // while a draft cost one flat credit; the 2026-08-21 weighted schedule prices a draft at
    // DRAFT_REPLY_COST_CREDITS, and the offer copy moved with it — so the pin derives the figure
    // from the same constant the root anti-drift test compares against the gate's weight,
    // rather than freezing a number the ledger has stopped charging. The property is unchanged:
    // the price, on screen, before anything is bought.
    expect(card.textContent).toContain(`${DRAFT_REPLY_COST_CREDITS} credits of your AI budget`);
    // No API cost without revenue behind it: the figure is on screen BEFORE anything is
    // requested. Not one call yet.
    expect(apiCalls, "opening the offer already spent an AI action").toHaveLength(0);
    // And the editor is open underneath it, which is the whole reason the card is here rather
    // than in a dialog: what is being bought is text for that box.
    expect(replySurface(el), "the reply editor did not open with the offer").toBeTruthy();
  });

  it("puts the draft in the editor and dispatches NO mutation — a draft is not a reply", async () => {
    /**
     * The "No silent AI actions" invariant, structurally. A generated draft must not discharge a Reply Run's debt, and the
     * only way to be sure is to count: if `onDraft` ever dispatched anything — a `mail_send`,
     * a `triage_set`, a `draft_accept` — this goes red. Wire `onDraft` to `mailSend.send` and
     * it fails on `expected [ 'mail_send' ] to have a length of 0`.
     */
    const el = await shell();
    apiImpl = async (path) =>
      path.endsWith("/draft")
        ? { draftId: "d1" }
        : { body: "Thursday works for me.", html: null };

    await openDrafter(el);
    // The demo's letter has a reply draft on the account, which Reply opens: emptied here.
    await act(async () => { typeInto(replySurface(el)!, ""); });
    const before = dispatched.length;
    await clickText(el, "Draft it");
    await drain();

    expect(apiCalls.map((c) => c.path)).toEqual([
      expect.stringContaining("/draft"),
      expect.stringContaining("/drafts/d1"),
    ]);
    expect(apiCalls[0]!.init?.headers?.["Idempotency-Key"], "the purchase carried no key")
      .toBeTruthy();

    expect(replySurface(el)!.textContent).toContain("Thursday works for me.");
    expect(
      dispatched.slice(before).map((m) => m.kind),
      "a bought draft dispatched a mutation, so it can discharge a debt it did not pay",
    ).toEqual([]);
    // The offer is gone — the purchase is over and nothing is left to press.
    expect(el.querySelector(".read-col .dr-card")).toBeNull();
  });

  it("asks before it overwrites something already written, and adding below escapes it", async () => {
    const el = await shell();
    // A draft that is PLAIN TEXT and contains a tag. Both halves matter: the drafting route
    // returns text, and the editor below already holds markup — so the append has to join a
    // markup half to a plain one, which is the only case where the escaping is load-bearing.
    apiImpl = async (path) =>
      path.endsWith("/draft") ? { draftId: "d1" } : { body: "and <b>this</b> too", html: null };

    await key("r");
    const surface0 = replySurface(el)!;
    await act(async () => { typeInto(surface0, "Already typed."); });
    // FORMATTED, deliberately. With both halves plain, `appendRich` never enters its html
    // branch and an assertion about escaping would be vacuous — which is exactly what the
    // first version of this test was, and a mutation to raw concatenation passed it.
    await act(async () => { editorOf(surface0).commands.selectAll(); });
    await act(async () => { editorOf(surface0).commands.toggleBold(); });
    await openDrafter(el);
    await clickText(el, "Draft it");
    await drain();

    // NOT clobbered. The text is still there and the question is on screen.
    expect(replySurface(el)!.textContent).toContain("Already typed.");
    const card = el.querySelector<HTMLElement>(".read-col .dr-card")!;
    expect(card.textContent).toContain("You have already written something");

    await clickText(el, "Add below");
    await drain();

    const surface = replySurface(el)!;
    expect(surface.textContent).toContain("Already typed.");
    // The draft's tag stayed a TAG THE READER CAN SEE rather than becoming formatting. Join
    // the two strings raw and `<b>this</b>` is parsed as markup on the way in — text the
    // person never wrote, in a message they are about to send.
    expect(surface.textContent).toContain("and <b>this</b> too");
    expect(surface.querySelectorAll("strong")).toHaveLength(1);
  });

  it("renders the server's own refusal and does not retry it", async () => {
    const { ApiError } = await import("../app/api-client");
    const el = await shell();
    apiImpl = async () => {
      throw new ApiError(402, "no_credits", "no AI credits remain on this account");
    };

    await openDrafter(el);
    await clickText(el, "Draft it");
    await drain();

    const card = el.querySelector<HTMLElement>(".read-col .dr-card")!;
    // Verbatim. A local taxonomy here is how somebody with an empty balance is told the model
    // is down — the two are different, actionable facts and neither is inferable from a code.
    expect(card.textContent).toContain("no AI credits remain on this account");
    // ONE request. A 402 retried in a loop is a person being asked again to buy what they
    // have just been told they cannot afford.
    expect(apiCalls).toHaveLength(1);
    // And the offer is still standing, so a second press is a deliberate act.
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toContain("Draft it");
  });
});
