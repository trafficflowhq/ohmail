/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MAX_RAW_MESSAGE_BYTES } from "@trafficflow/core/mail";
import messages from "../messages/en.json";
import { settleEditor } from "./_first-paint.js";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * THE CONVERSATION IN THE READER — ONE FULL-BODY PANEL PER MESSAGE.
 *
 * Threading shipped and nothing rendered it; that gap is closed. The thread rendered as
 * collapsible peek rows for a while; the viewer redesign (owner GO, 2026-08-11) replaced the
 * fold with the stronger form of the same invariant: every message on the thread is a full
 * panel with its body on screen, oldest first, and NOTHING stands in for a message — no peek
 * row, no "N messages" count, no "show earlier" control. The anti-placeholder guard below
 * holds that line.
 *
 * `MessagePane` is driven through `MessageChromeProvider`, which is the seam the shell uses —
 * the pane holds no engine hook of its own on purpose (see `message-chrome.tsx`), so the
 * conversation arriving through the chrome IS the production path, not a stub of it.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T12:00:00.000Z");

interface Addr {
  name: string | null;
  address: string;
}

interface Seed {
  id: string;
  subject: string;
  threadId: string | null;
  date: string;
  snippet?: string;
  protectedBlock?: boolean;
  /**
   * THE LIVE-ACCOUNT SHAPE OF THE SAME FACT, and it is a SEPARATE seed on purpose.
   *
   * `protectedBlock` writes the `protected` display extra, which only `FixturesAdapter` ever
   * emits — the demo. On a live account the signal is `sensitivity.sensitive` and there is no
   * `protected` key at all, which is precisely why the surfaces' `m.protected != null` test had
   * never once run against a real message. A fixture that sets both cannot tell the two
   * predicates apart; this one sets only what the wire sets.
   */
  liveSensitive?: boolean;
  /**
   * The wire `folder`. Defaults to INBOX; a message the USER wrote carries the server's own
   * Sent path, which is deliberately outside the frozen `Folder` union — clients
   * must tolerate it (contract §8) rather than know it.
   */
  folder?: string;
  /** REAL recipients, so the header's recipients line is exercised rather than only its empty branch. */
  to?: Addr[];
  cc?: Addr[];
}

function msg(s: Seed): Record<string, unknown> {
  return {
    id: s.id,
    accountId: "a",
    mailboxId: "mb",
    threadId: s.threadId,
    messageIdHeader: null,
    subject: s.subject,
    from: { name: `Sender ${s.id}`, address: `${s.id}@example.invalid` },
    to: s.to ?? [],
    cc: s.cc ?? [],
    date: s.date,
    folder: s.folder ?? "INBOX",
    snippet: s.snippet ?? `snippet-${s.id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: s.liveSensitive
      ? { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: true }
      : { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: s.date,
    ...(s.protectedBlock
      ? {
          protected: {
            kind: "otp",
            label: "Verification code",
            redactedNote: "······",
            policy: "Protected — never sent to AI.",
          },
        }
      : {}),
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Mutation point: what the chrome hands the pane as the conversation. */
let conversation: Array<Record<string, unknown>> = [];
let replyTo: string | null = null;
/** Mutation point: the reader's own addresses, so a recipient that IS the reader folds to "me". */
let ownAddresses: string[] = [];
/** Mutation point: the account's name for its own address — what a "me" chip wears. */
let ownName: string | null = null;
/** Mutation point: the hydration state the chrome reports for the open message. */
let bodyState: "full" | "snippet" | "loading" | "failed" | "withheld" | null = null;
/** Mutation point: WHICH policy withheld the body — the marker the per-reason copy switches on. */
let bodyWithheld: "storage_cap" | "junk_filed" | "expunged" | "too_large" | null = null;
/**
 * Mutation point: the html part the chrome reports for a hydrated body. `null` — the default —
 * is a plain-text mail, which is what every assertion written before the siblings were
 * hydrated assumes, so those are unaffected by its existence.
 */
let bodyHtml: string | null = null;
/**
 * Ids handed to `hydrateBody`. Two things ride on this: the Retry control's only observable
 * effect, and — for the loaded-bodies guard — that rendering the thread's panels does NOT
 * fetch per panel, because every body was already asked for on open.
 */
let retried: string[] = [];
/**
 * Every id LIST handed to `hydrateThread` — one entry per call, so the shape of the ask is
 * observable and not only its contents. The siblings are hydrated in ONE batch call on open.
 */
let threadAsks: string[][] = [];
/** The reply and subject-rule seams: which message ids the pane asked to reply-to, forward, or open a subject rule for. */
let repliedTo: string[] = [];
let forwarded: string[] = [];
let subjectRuled: string[] = [];
/**
 * Whether the chrome offers the reply/forward verbs at all. `false` is the desktop shell and
 * every provider-less mount — the case the ⋯ menu must answer with NO trigger, not a dead one.
 */
let headerVerbs = true;
/** Which message id the bar's Screening verb asked the chrome to open the sender menu for. */
let screened: string[] = [];
/**
 * Mutation point: the attachments chrome a shell would wire, or null — the provider-less mount
 * (the demo, a client with no attachment service), which must render NO strip anywhere.
 */
let attachmentsChrome: Record<string, unknown> | null = null;
/** Every `itemsOf` ask — which panel's id, and with which inline-pictures answer. */
let itemsAsked: Array<{ id: string; inline: boolean }> = [];
/** `message.id:attachmentId` per preview press, so the dispatch is panel-addressed observably. */
let previewed: string[] = [];
/** Every panel's hold on its own list: the ask that makes the list exist at all. */
let held: string[] = [];
/**
 * Mutation point: the thread-read wiring the Ohbox hands the pane (`reader-seen.ts`), or null —
 * every other surface, where the rule, the tint, the squares and Mark unread are absent.
 */
let threadRead: Record<string, unknown> | null = null;

/**
 * A ready attachments chrome over fixed per-message lists — the strip's own wire, stubbed at
 * the chrome seam exactly where `AppShell` wires `useMessageAttachments`. `itemsOf` answers
 * `ready` with `[]` for a message the table does not name, which is the true idle shape (a
 * loaded list holding nothing) rather than an error the strip would draw.
 */
function readyAttachments(byId: Record<string, Array<Record<string, unknown>>>): Record<string, unknown> {
  return {
    itemsOf: (id: string, opts?: { includeInlineParts?: boolean }) => {
      itemsAsked.push({ id, inline: opts?.includeInlineParts === true });
      return { state: "ready", items: byId[id] ?? [] };
    },
    open: () => {},
    ensure: () => {},
    blobOf: () => undefined,
    downloadAll: () => {},
    downloadingAll: () => false,
    cidImagesOf: () => new Map<string, string>(),
    needCidImages: () => {},
    eventsOf: () => [],
    hold: (id: string) => {
      held.push(id);
      return () => {};
    },
  };
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** Render the SAME tree again — hooks keep their state, the chrome's mutation points are re-read. */
let rerender: (() => Promise<void>) | null = null;

async function mountPane(open: Record<string, unknown>, prepare?: (host: HTMLDivElement) => void): Promise<void> {
  await unmount();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");

  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  prepare?.(host);
  root = createRoot(host);
  rerender = async () => { await act(async () => { root!.render(tree()); }); };
  const tree = () => (
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(MessageChromeProvider as never, {
          value: {
            ownAddresses,
            ...(ownName !== null ? { ownNameOf: () => ownName } : {}),
            replyTo,
            // Both halves — the editor is rich now, and a bare string here reaches `canSend`
            // as `undefined.trim()` while React reports it as a render crash rather than as a
            // type error, because this object is cast through `never` at the call below.
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: (id: string) => { screened.push(id); },
            conversationOf: () => conversation,
            /**
             * The pane's body, through the chrome. `bodyState` is the mutation
             * point for the hydration assertions; the default is the pre-hydration expression, so
             * a wire message with no `body` renders its snippet.
             */
            bodyOf: (m: Record<string, unknown>) => ({
              text: (m.body as string | undefined) ?? (m.snippet as string),
              state: bodyState ?? (m.body !== undefined ? "full" : "snippet"),
              withheld: bodyWithheld,
              html: bodyHtml,
              loadedRemoteContent: false,
              unsubscribe: "no_header",
              unsubscribeUrl: null,
            }),
            hydrateBody: (id: string) => { retried.push(id); },
            hydrateThread: (ids: string[]) => { threadAsks.push([...ids]); },
            // The reply and subject-rule seams — the same optional chrome methods the shell wires to `openReply`,
            // the forward model, and the subject-rule sheet. Present (unless `headerVerbs` says
            // this mount is a shell with no reply machine) so the header's ⋯ menu and the
            // pressable subject render and their dispatch can be watched. The reply record keeps
            // the `all` flag visible: `openReply(id, true)` lands as `id+all`.
            ...(headerVerbs
              ? {
                  openReply: (id: string, all?: boolean) => { repliedTo.push(all ? `${id}+all` : id); },
                  forward: (id: string) => { forwarded.push(id); },
                }
              : {}),
            openSubjectRule: (id: string) => { subjectRuled.push(id); },
            // The attachments chrome, exactly where `AppShell` wires `useMessageAttachments` —
            // absent by default, so every assertion written before the sibling strip existed
            // exercises the provider-less branch it always did.
            ...(attachmentsChrome ? { attachments: attachmentsChrome } : {}),
            openAttachmentPreview: (id: string, attachmentId: string) => {
              previewed.push(`${id}:${attachmentId}`);
            },
          },
          children: h(MessagePane as never, {
            message: open,
            tags: [],
            now: NOW,
            onAction: () => {},
            onAddTag: () => {},
            onAttachment: () => {},
            ...(threadRead ? { threadRead } : {}),
          } as never),
        } as never),
      })
  );
  await act(async () => { root!.render(tree()); });
  // A pane with a reply open renders its editor behind `RichEditorLazy` — one seam, one helper.
  await settleEditor();
}

/** What the journey counts, asked of the same DOM. */
const panes = (): number => host!.querySelectorAll("article.msg, article.pm").length;
const convIds = (): (string | null)[] =>
  [...host!.querySelectorAll<HTMLElement>(".conv [data-conv-id]")].map((e) => e.getAttribute("data-conv-id"));
const text = (): string => host!.textContent ?? "";
/** A conversation panel by id. */
const card = (id: string): HTMLElement | null =>
  host!.querySelector<HTMLElement>(`.conv [data-conv-id="${id}"]`);
/** Does this panel carry a mail body on screen — the sibling's slot or the focused prose? */
const hasBody = (id: string): boolean => !!card(id)?.querySelector(".pm-body, .msg-body");

beforeEach(() => {
  vi.useFakeTimers();
  /* The stamp and its hover title render in the READER'S zone, so pin one — otherwise these
     assertions are about the machine running the suite. `reader-zone.test.ts` is where the zone
     itself is under test. */
  setActiveFormatZone("UTC");
  conversation = [];
  replyTo = null;
  ownAddresses = [];
  ownName = null;
  bodyState = null;
  bodyWithheld = null;
  bodyHtml = null;
  retried = [];
  threadAsks = [];
  repliedTo = [];
  forwarded = [];
  subjectRuled = [];
  screened = [];
  headerVerbs = true;
  attachmentsChrome = null;
  itemsAsked = [];
  previewed = [];
  held = [];
  threadRead = null;
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  vi.useRealTimers();
});

const A = msg({ id: "a", subject: "Quote for the north elevation", threadId: "t1", date: "2026-07-30T09:00:00.000Z" });
const B = msg({ id: "b", subject: "Re: Quote for the north elevation", threadId: "t1", date: "2026-07-31T09:00:00.000Z" });
const C = msg({ id: "c", subject: "Re: Quote for the north elevation", threadId: "t1", date: "2026-08-01T09:00:00.000Z" });
/** The half of the conversation a later change added: a message the user wrote, read back out of Sent. */
const MINE = msg({
  id: "mine", subject: "Re: Quote for the north elevation", threadId: "t1",
  date: "2026-07-31T09:00:00.000Z", folder: "Sent",
});

describe("an open message shows the rest of its conversation", () => {
  it("renders all THREE messages of a three-deep thread as distinct panels, oldest first", async () => {
    // THE GUARD. Make `conversationOf` return `[]` (i.e. break the sibling query the way
    // production was broken) and this drops to one pane and no ids — which is verbatim what
    // A report against the live site read: "the reading pane rendered 1 message body".
    conversation = [A, B, C];
    await mountPane(B);

    expect(panes()).toBe(3);
    expect(convIds()).toEqual(["a", "b", "c"]);
  });

  /**
   * ══ THE ANTI-PLACEHOLDER GUARD — INVARIANT #6, IN ITS LETTER ═══════════════════════════════
   *
   * The redesign made the guard STRONGER. Every message on the thread is a full-body panel:
   * the default render is exactly one distinct, addressable panel per message, each with its
   * body on screen. A build that folded messages back into peek rows, hid the older ones
   * behind a single "N earlier" row, or restated the thread as a count would go red here.
   * Mutations: render a `.hm-peekrow` for an older sibling — red at the peek-row line; render
   * one summary row for the older half — red at the distinct-panel count; put the
   * "N messages on this conversation" head back — red at the count line.
   */
  it("renders exactly conversation-length FULL-BODY panels — no peek row, no count standing in", async () => {
    conversation = [A, B, C];
    await mountPane(C);

    const ids = convIds();
    expect(ids).toEqual(["a", "b", "c"]);
    expect(new Set(ids).size).toBe(conversation.length);
    // Every panel carries its body ON SCREEN — nothing is one press away, nothing is withheld.
    for (const id of ["a", "b", "c"]) expect(hasBody(id), `panel ${id} has no body on screen`).toBe(true);
    // The placeholder vocabulary is gone in every form: no fold, no aggregate, no count.
    expect(host!.querySelector(".hm-peekrow"), "a peek row stands in for a message").toBeNull();
    expect(host!.querySelector(".hm-collapsed")).toBeNull();
    expect(host!.querySelector(".conv-head"), "a count line restates the thread").toBeNull();
    expect(text()).not.toContain("on this conversation");
    expect(card("c")!.getAttribute("aria-current")).toBe("true");
  });

  it("puts the OPENED message in its chronological place, not at the top", async () => {
    conversation = [A, B, C];
    await mountPane(A);
    expect(convIds()).toEqual(["a", "b", "c"]);
  });

  it("marks the opened message as the current one, and only it", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    const current = [...host!.querySelectorAll<HTMLElement>('.conv [aria-current="true"]')];
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute("data-conv-id")).toBe("b");
    // …and it keeps the full message anatomy — `.msg-body` is the focused prose, and it is a
    // panel like its siblings rather than the old inset `.hmail` card.
    expect(current[0]!.querySelector(".msg-body")).toBeTruthy();
    expect(current[0]!.classList.contains("hmail")).toBe(false);
    expect(current[0]!.classList.contains("pm")).toBe(true);
  });

  it("renders the user's OWN reply, and no longer claims it cannot", async () => {
    // Until that change the pane carried a `ConversationLimit` note reading "ohmail does not watch
    // your Sent folder yet". The worker watches it now, so that sentence is gone. What is
    // asserted is the ENTRY: a message whose `folder` is the server's Sent path renders in the
    // conversation exactly like any other (contract §8 — "Sent" is not a `Folder` member).
    conversation = [A, MINE, C];
    await mountPane(C);

    expect(convIds()).toEqual(["a", "mine", "c"]);
    expect(hasBody("mine")).toBe(true);
    expect(text()).toContain("snippet-mine");
    expect(text()).not.toContain("does not watch your Sent folder");
    expect(text()).not.toContain("shows the other side only");
  });

  /**
   * ══ SUBJECT-D: EVERY PANEL PRINTS ITS OWN TRUE SUBJECT ═════════════════════════════════════
   *
   * This guard used to assert the OPPOSITE — zero per-panel headings, because the thread's one
   * 24px lede already said the subject and a panel's own line was suppressed whenever its
   * normalized key (`Re:`/`AW:` stripped) matched it. The viewer redesign deletes the lede, the
   * large heading and the suppression together: each panel wears a quiet `.msg-subject` line
   * under its sender showing the RAW `m.subject`, prefixes included — a reply that arrived as
   * "AW: …" says so on screen. Mutations, each watched red: normalize the printed subject
   * through a prefix-stripping key — red at the AW:/Re: lines; suppress a same-subject panel's
   * line (the old `showSubject` comparison) — red at the per-panel equality; put the lede or
   * the single-message `<h2>` back — red at the no-heading assertions.
   */
  it("prints each panel's RAW subject — AW:/Re: included, renamed branches included", async () => {
    const AW = msg({ id: "aw", subject: "AW: Quote for the north elevation", threadId: "t1", date: "2026-08-01T10:00:00.000Z" });
    const renamed = msg({ id: "d", subject: "Re: Revised scope — south elevation too", threadId: "t1", date: "2026-08-02T09:00:00.000Z" });
    conversation = [A, B, AW, renamed];
    await mountPane(B);
    const lines = [...host!.querySelectorAll<HTMLElement>(".conv .pm .msg-subject")]
      .map((e) => (e.textContent ?? "").trim());
    expect(lines).toEqual([
      "Quote for the north elevation",
      "Re: Quote for the north elevation",
      "AW: Quote for the north elevation",
      "Re: Revised scope — south elevation too",
    ]);
  });

  it("no large heading anywhere on a thread — the lede and the panel h3 are gone", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    expect(host!.querySelector(".conv-lede"), "the one-time thread lede is deleted").toBeNull();
    expect(host!.querySelector("h2"), "no 24px heading survives the redesign").toBeNull();
    expect(host!.querySelector(".conv .pm h3"), "the diverging-subject h3 is deleted").toBeNull();
  });

  it("a single message wears the same quiet subject line — the big heading went with the rest", async () => {
    await mountPane(msg({ id: "solo", subject: "Just this", threadId: null, date: "2026-08-01T09:00:00.000Z" }));
    const line = host!.querySelector(".msg-subject");
    expect(line, "the single message lost its subject entirely").not.toBeNull();
    expect((line!.textContent ?? "").trim()).toBe("Just this");
    expect(host!.querySelector("h2")).toBeNull();
  });

  it("a sensitive sibling is not withheld — its body is on screen like any other", async () => {
    // Body withholding is removed: a sibling flagged sensitive shows its body like any other.
    // The redaction branches that stood over this — in `MessagePane` and the Screener's preview —
    // are gone with it, so the mutation is now the pair: restore `isProtectedMessage`'s
    // `sensitivity.sensitive` branch AND a body arm that reads it.
    const otp = msg({ id: "otp", subject: "Your code", threadId: "t1", date: "2026-07-29T09:00:00.000Z", snippet: "code is 449 201", liveSensitive: true });
    conversation = [otp, B];
    await mountPane(B);
    expect(card("otp")!.textContent).toContain("449 201");
    expect(text()).not.toContain("(redacted)");
  });
});

/**
 * ══ ONE ACTION BAR, AT THE FOOT OF THE THREAD, BOUND TO THE OPENED MESSAGE ══════════════════
 *
 * The floating pill is mounted ONCE per surface, outside every panel, and its verbs act on the
 * message that was OPENED — the focus is never remapped to the newest panel. Mutations: mount a
 * bar per panel — red at the count; rebind the bar to the newest sibling — red at the id.
 */
describe("the thread's one action bar", () => {
  it("mounts exactly ONE `.abar`, outside the panels", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    const bars = host!.querySelectorAll(".abar");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.closest("[data-conv-id]"), "the bar was mounted inside a panel").toBeNull();
  });

  it("dispatches with the OPENED id even when a newer sibling is on the thread", async () => {
    conversation = [A, B, C];
    await mountPane(B); // C is newer; the bar must still act on B
    const screening = [...host!.querySelectorAll<HTMLButtonElement>(".abar button")]
      .find((b) => (b.textContent ?? "").includes("Screening"));
    expect(screening, "the bar's Screening verb is missing").toBeTruthy();
    await act(async () => { screening!.click(); });
    expect(screened).toEqual(["b"]);
  });
});

/**
 * THE READER OPENS AT THE OPENED PANEL — the one the bar acts on, not the newest. jsdom lays nothing
 * out, so the column and the panels carry stubbed geometry (`stream-hold-window.test.tsx`'s shape):
 * B's and C's tops differ by far more than the 14px inset, so the two readings cannot coincide. The
 * resize tick is a sibling body landing above B. `scrollTop` is read before any key: a keydown hands
 * the scroller to the reader. Mutation: the position source back to the last panel — red at C's offset.
 */
describe("the reader's anchor", () => {
  it("opens scrolled to the OPENED panel, and keeps it there when a sibling grows above it", async () => {
    conversation = [A, B, C];
    let scrollTop = 50;
    let scrollHeight = 1500;
    const tops: Record<string, number> = { a: 0, b: 500, c: 1000 };
    const rect = (top: number, height: number): DOMRect =>
      ({ top, height, bottom: top + height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];
    const realRO = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      private readonly entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) { this.entry = { cb, targets: [] }; observers.push(this.entry); }
      observe(el: Element): void { this.entry.targets.push(el); }
      unobserve(): void {}
      disconnect(): void { this.entry.targets = []; }
    };
    const rects = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === host) return rect(0, 600);
      const id = this.getAttribute("data-conv-id");
      if (id !== null && id in tops) return rect(tops[id]! - scrollTop, 400);
      if (this.classList.contains("conv")) return rect(-scrollTop, scrollHeight);
      return rect(0, 0);
    });
    try {
      await mountPane(B, (col) => {
        col.style.overflowY = "auto";
        Object.defineProperty(col, "clientHeight", { configurable: true, get: () => 600 });
        Object.defineProperty(col, "scrollHeight", { configurable: true, get: () => scrollHeight });
        Object.defineProperty(col, "scrollTop", {
          configurable: true,
          get: () => scrollTop,
          set: (v: number) => { scrollTop = Math.min(Math.max(0, v), scrollHeight - 600); },
        });
      });
      expect(card("b")?.getAttribute("aria-current"), "the premise: b is the opened panel").toBe("true");
      expect(scrollTop, "the reader opened at the newest panel, not the opened one").not.toBe(Math.min(tops.c! - 14, 900));
      expect(scrollTop).toBe(tops.b! - 14);

      tops.b = 700;
      tops.c = 1200;
      scrollHeight = 1700;
      const onConv = observers.filter((o) => o.targets.some((t) => t.classList.contains("conv")));
      expect(onConv.length, "the anchor observes the conversation").toBeGreaterThan(0);
      await act(async () => { for (const o of onConv) o.cb([], {} as ResizeObserver); });
      expect(scrollTop, "a resize did not re-anchor to the opened panel").toBe(tops.b! - 14);
    } finally {
      rects.mockRestore();
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
    }
  });
});

/**
 * ── THE PER-MESSAGE ⋯ MENU — Reply / Reply all / Forward, in every panel's header ──────────
 *
 * The sibling footer's two text verbs (`.hm-foot`) are deleted; the same dispatches live in a
 * disclosure menu in each panel's header, LEFT of the stamp, on the focused panel and the
 * siblings alike — one grammar. Reply retargets the editor to THIS panel's id, Reply all only
 * where `replyAllRecipients` says "all" is more people than "reply", Forward hands THIS id to
 * the forward model. Items degrade by OMISSION where the chrome offers no verb (the desktop
 * shell) — a menu of dead controls is the shape this whole file refuses.
 */
describe("the per-message actions menu", () => {
  const trigger = (id: string): HTMLButtonElement | null =>
    card(id)?.querySelector<HTMLButtonElement>(".msg-more") ?? null;
  /** The open menu's item — one menu is open at a time, so a host-wide query is exact. */
  const item = (itemId: string): HTMLButtonElement | null =>
    host!.querySelector<HTMLButtonElement>(`.msg-menu [role="menuitem"][data-item="${itemId}"]`);
  /** The items of a panel's ⋯, in order, read with it open and closed again. */
  const itemsOf = async (id: string): Promise<string[]> => {
    await act(async () => { trigger(id)!.click(); });
    const ids = [...host!.querySelectorAll<HTMLElement>('.msg-menu [role="menuitem"]')].map((e) => e.dataset.item!);
    await act(async () => { trigger(id)!.click(); });
    return ids;
  };
  /** The Ohbox's wiring, its Mark unread recorded by panel id. */
  const wire = async (): Promise<string[]> => {
    const { createThreadRead } = await import("@ohmail/client-engine");
    const marked: string[] = [];
    threadRead = { record: createThreadRead(), onRead: () => {}, onEnter: () => {}, onMarkUnread: (id: string) => marked.push(id) };
    return marked;
  };

  it("MARK UNREAD, where the Ohbox wires it: appended after Reply and Forward, naming THAT panel", async () => {
    const marked = await wire();
    conversation = [A, B, C];
    await mountPane(B);
    expect(await itemsOf("a"), "the production items first, then Mark unread").toEqual(["reply", "forward", "mark_unread"]);
    expect(await itemsOf("b"), "the opened panel's own ⋯ too").toEqual(["reply", "forward", "mark_unread"]);
    await act(async () => { trigger("a")!.click(); });
    expect(item("mark_unread")?.textContent).toBe("Mark unread");
    await act(async () => { item("mark_unread")!.click(); });
    expect(marked, "the press names the panel it was on").toEqual(["a"]);
  });

  it("MARK UNREAD is not offered on an unread message, nor on the account's own", async () => {
    await wire();
    conversation = [A, MINE, { ...C, unread: true }];
    await mountPane(A);
    expect(await itemsOf("c"), "unread already").not.toContain("mark_unread");
    expect(await itemsOf("mine"), "your own").not.toContain("mark_unread");
    expect(await itemsOf("a")).toContain("mark_unread");
  });

  it("CONTROL: no wiring (every surface but the Ohbox), no Mark unread, and the items unchanged", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    expect(await itemsOf("a")).toEqual(["reply", "forward"]);
  });

  it("⋯ on an OLDER panel dispatches THAT panel's id — never the focused one's", async () => {
    // Mutation: hardcode the focused id into the menu's dispatch and both records read "b" — red.
    conversation = [A, B, C];
    await mountPane(B); // b focused; a is an older sibling panel
    await act(async () => { trigger("a")!.click(); });
    await act(async () => { item("reply")!.click(); });
    expect(repliedTo).toEqual(["a"]);
    await act(async () => { trigger("a")!.click(); });
    await act(async () => { item("forward")!.click(); });
    expect(forwarded).toEqual(["a"]);
  });

  it("is a real disclosure: aria-haspopup='menu' with LIVE aria-expanded", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    const t = trigger("c")!;
    expect(t.getAttribute("aria-haspopup")).toBe("menu");
    expect(t.getAttribute("aria-expanded"), "closed must say closed").toBe("false");
    await act(async () => { t.click(); });
    expect(t.getAttribute("aria-expanded"), "open must say open — a literal false is the defect the pill already fixed").toBe("true");
    expect(card("c")!.querySelector('[role="menu"]')).toBeTruthy();
  });

  it("sits LEFT of the stamp — menu first, date on the right", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    const t = card("c")!.querySelector(".msg-from .t")!;
    const kids = [...t.children];
    const menuAt = kids.findIndex((el) => el.classList.contains("msg-menu"));
    const stampAt = kids.findIndex((el) => el.classList.contains("stamp-toggle"));
    expect(menuAt, "no menu in the header's right cluster").toBeGreaterThanOrEqual(0);
    expect(stampAt, "no stamp beside it").toBeGreaterThanOrEqual(0);
    expect(stampAt).toBeGreaterThan(menuAt);
  });

  it("offers NO Reply-all on a 1:1 panel, and dispatches (id, all) where the audience earns it", async () => {
    // The default fixtures carry no To/Cc — a 1:1 — so no panel offers Reply all.
    conversation = [A, B, C];
    await mountPane(B);
    await act(async () => { trigger("a")!.click(); });
    expect(item("reply")).toBeTruthy();
    expect(item("reply_all"), "Reply all on a 1:1 is noise, not an option").toBeNull();
    await act(async () => { trigger("a")!.click(); }); // toggle it shut again

    // Two listed recipients prove somebody besides the reader is on the thread — the same
    // `replyAllRecipients` predicate the pill resolves, per panel, reader unknown here.
    const wide = msg({
      id: "wide", subject: "Re: Quote for the north elevation", threadId: "t1",
      date: "2026-07-30T18:00:00.000Z",
      to: [{ name: "Anna Roth", address: "anna@x.invalid" }, { name: "Bo", address: "bo@x.invalid" }],
    });
    conversation = [wide, B];
    await mountPane(B);
    await act(async () => { trigger("wide")!.click(); });
    const all = item("reply_all");
    expect(all, "a widened audience must offer Reply all").toBeTruthy();
    await act(async () => { all!.click(); });
    expect(repliedTo, "Reply all must carry the flag AND the panel's own id").toEqual(["wide+all"]);
  });

  it("offers Forward on a `no_forward` panel — the SAME predicate the pill reads (`forwardOffered`)", async () => {
    // FORWARD IS ALWAYS OFFERED (owner, 2026-09-25): the panel menu, the pill and `⇧F` read one
    // predicate, so the verb cannot stand on one door and vanish from another. The press hands
    // the panel's own id to the shell, whose `openForward` asks once before a `no_forward` forward.
    const otp = msg({ id: "otp", subject: "Your code", date: "2026-07-30T19:00:00.000Z", threadId: "t1", liveSensitive: true });
    conversation = [otp, B];
    await mountPane(B);
    await act(async () => { trigger("otp")!.click(); });
    expect(item("reply"), "the panel's other verbs are unaffected").toBeTruthy();
    const fwd = item("forward");
    expect(fwd, "a no_forward panel lost its Forward").toBeTruthy();
    await act(async () => { fwd!.click(); });
    expect(forwarded).toEqual(["otp"]);
  });

  it("the footer verbs are GONE — and no second ActionBar took their place", async () => {
    // Mutations: restore the `.hm-foot` Reply/Forward footer in `MessageCard` — red at the
    // first two lines; mount an `ActionBar` per panel instead — red at the third.
    conversation = [A, B, C];
    await mountPane(A);
    expect(host!.querySelector(".hm-foot")).toBeNull();
    expect(host!.querySelector(".hm-verb")).toBeNull();
    expect(card("c")!.querySelector(".abar"), "a full action bar was mounted in a sibling").toBeNull();
  });

  it("degrades by OMISSION: a chrome with no reply machine renders no trigger at all", async () => {
    headerVerbs = false;
    conversation = [A, B, C];
    await mountPane(B);
    expect(host!.querySelector(".msg-more"), "a dead ⋯ over an inert chrome").toBeNull();
  });
});

/**
 * ── SEAM: THE SUBJECT LINE OPENS THE SUBJECT-RULE SHEET, PER PANEL ──────────────────────
 *
 * The pressable title moved with the subject: each panel's quiet `.msg-subject` line is the
 * button where the shell provides `openSubjectRule`, and it dispatches THAT panel's id — the
 * sheet behind it is a later slice. Where the shell offers no sheet the line is plain text,
 * never a dead control.
 */
describe("the subject line as a subject-rule entry", () => {
  it("a press on a panel's subject dispatches openSubjectRule for THAT message", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    const older = card("a")!.querySelector<HTMLButtonElement>(".msg-subject .subj-rule");
    expect(older, "the subject is not a pressable control").not.toBeNull();
    await act(async () => { older!.click(); });
    expect(subjectRuled).toEqual(["a"]);
    const focused = card("b")!.querySelector<HTMLButtonElement>(".msg-subject .subj-rule")!;
    await act(async () => { focused.click(); });
    expect(subjectRuled).toEqual(["a", "b"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE MESSAGE HEADER — WHO IT IS FROM, AND WHO ELSE IT WENT TO
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("the header", () => {
  it("renders exactly one from-line per message — never a doubled header", async () => {
    // The anatomy migration moved the from-line out of `ReadingPane` and into `MessageHeader`.
    // If `ReadingPane` still drew its own while the pane composed one too, the focused message
    // would carry two. Single path: exactly one. Thread: the focused panel carries exactly one.
    await mountPane(msg({ id: "solo", subject: "Just this", threadId: null, date: "2026-08-01T09:00:00.000Z" }));
    expect(host!.querySelectorAll(".msg-from")).toHaveLength(1);

    conversation = [A, B, C];
    await mountPane(B);
    expect(host!.querySelectorAll(".conv-focus .msg-from")).toHaveLength(1);
  });

  it("renders NO recipients block when there is no To and no Cc", async () => {
    // The empty branch: a message addressed to nobody visible must not print a dangling "To".
    await mountPane(msg({ id: "solo", subject: "Just this", threadId: null, date: "2026-08-01T09:00:00.000Z" }));
    expect(host!.querySelector(".msg-rcpts")).toBeNull();
  });

  it("a recipient who IS the reader wears the ACCOUNT'S identity — and never a stranger's chip", async () => {
    // the "me" fold no longer prints a translated "me" — the chip wears the account's real
    // name and address (`chrome.ownNameOf`, from GET /mailboxes). `contact-chips.test.tsx`
    // holds the fallback ladder; this holds the fold's two sides on the thread surface.
    const withMe = msg({
      id: "r", subject: "Hi", threadId: null, date: "2026-08-01T09:00:00.000Z",
      to: [{ name: null, address: "owner@example.invalid" }, { name: "Anna Roth", address: "anna@x.invalid" }],
    });

    // Known own address, named mailbox → the account's identity on the chip.
    ownAddresses = ["owner@example.invalid"];
    ownName = "Own Er";
    await mountPane(withMe);
    const faces = () => [...host!.querySelectorAll(".rcpt-chip")].map((c) => c.textContent);
    expect(faces()).toEqual(["Own Er – owner@example.invalid", "Anna Roth – anna@x.invalid"]);

    // NOT known → the bare address, never the account's name. The explicit degradation branch.
    ownAddresses = [];
    await mountPane(withMe);
    expect(faces()).toEqual(["owner@example.invalid", "Anna Roth – anna@x.invalid"]);
  });

  it("writes every Cc out as chips — `details` keeps only the exact date and the folder", async () => {
    const many = msg({
      id: "r", subject: "Hi", threadId: null, date: "2026-08-01T09:00:00.000Z",
      to: [{ name: "Anna Roth", address: "anna@x.invalid" }],
      cc: [
        { name: "Bo", address: "bo@x.invalid" },
        { name: "Cy", address: "cy@x.invalid" },
      ],
    });
    await mountPane(many);
    // nobody is behind a press any more — every Cc person is ON screen, a chip each.
    const block = host!.querySelector(".msg-rcpts")!;
    expect(block.textContent).toContain("bo@x.invalid");
    expect(block.textContent).toContain("cy@x.invalid");
    expect(block.textContent).not.toContain("cc 2");
    // What remains behind `details` is what the chips do not say: the exact instant.
    expect(host!.querySelector(".msg-rcpt-full")).toBeNull();
    const more = host!.querySelector<HTMLButtonElement>(".msg-rcpt-more")!;
    await act(async () => { more.click(); });
    const full = host!.querySelector(".msg-rcpt-full")!;
    expect(full.textContent).toContain("Sat 1 Aug 2026, 09:00");
    // …and no second copy of the recipient list grows back there.
    expect(full.textContent).not.toContain("bo@x.invalid");
  });

  it("puts the relative stamp on screen with the absolute date on hover", async () => {
    const dated = msg({ id: "solo", subject: "Just this", threadId: null, date: "2026-08-05T14:32:00.000Z" });
    await mountPane(dated);
    const stamp = host!.querySelector<HTMLElement>(".msg-from .t time")!;
    expect(stamp.getAttribute("title")).toBe("Wed 5 Aug 2026, 14:32");
    expect(stamp.getAttribute("datetime")).toBe("2026-08-05T14:32:00.000Z");
  });

  it("names-first: the bold name with the small address beside it — once each", async () => {
    const named = {
      ...msg({ id: "n", subject: "Hi", threadId: null, date: "2026-08-01T09:00:00.000Z" }),
      from: { name: "Anna Roth", address: "anna@x.invalid" },
    };
    await mountPane(named);
    const sender = host!.querySelector(".msg-sender")!;
    expect(sender.querySelector("b")!.textContent).toBe("Anna Roth");
    expect(sender.querySelector("small")!.textContent).toBe("anna@x.invalid");
  });

  it("a no-name sender prints the bare address ONCE, never twice", async () => {
    // The `senderName`/`rowAddress` split (`format.ts`): the name slot falls back to the
    // address and the small slot then prints nothing. Mutation: pass the address to the small
    // slot unconditionally — the occurrence count reads 2, red.
    const bare = {
      ...msg({ id: "n", subject: "Hi", threadId: null, date: "2026-08-01T09:00:00.000Z" }),
      from: { name: null, address: "verify@atlas-identity.invalid" },
    };
    await mountPane(bare);
    const sender = host!.querySelector(".msg-sender")!;
    expect(occurrences(sender.textContent ?? "", "verify@atlas-identity.invalid")).toBe(1);
    expect(sender.querySelector("small"), "the address must not print beside itself").toBeNull();
  });
});

/**
 * THE FORWARD ROW. The account's own forward threads with the message it forwarded (its headers
 * say so), so it stands inside that conversation as its own panel, BELOW the original, and its
 * face says where it went rather than repeating the account's name: "Forwarded to <recipient>",
 * in the reader's language. The account's own REPLY in the same thread keeps the sender face —
 * the predicate reads the leading subject prefix on an own-sent row and nothing else. Mutations
 * watched red: face every own-sent row — the reply case prints the sentence; drop the recipients
 * join — the sentence ends in nothing.
 */
describe("the forward row inside the original's conversation", () => {
  const FWD = msg({
    id: "fwd", subject: "Fwd: Quote for the north elevation", threadId: "t1",
    date: "2026-08-01T10:00:00.000Z", folder: "Sent",
    to: [{ name: "Sam Example", address: "sam@colleague.example" }, { name: null, address: "kim@colleague.example" }],
  });

  it("faces the account's own forward 'Forwarded to <recipients>', the original above it", async () => {
    conversation = [A, FWD];
    await mountPane(A);

    expect(convIds()).toEqual(["a", "fwd"]);
    const row = card("fwd")!;
    const face = row.querySelector(".msg-sender b")!.textContent;
    expect(face).toBe("Forwarded to Sam Example, kim@colleague.example");
    // The subject line still prints the true subject — the face is the sender slot, not the subject.
    expect(row.querySelector(".msg-subject")!.textContent).toBe("Fwd: Quote for the north elevation");
    // The original keeps its sender face.
    expect(card("a")!.querySelector(".msg-sender b")!.textContent).not.toContain("Forwarded to");
  });

  it("the account's own REPLY keeps its sender face — only a forward wears the sentence", async () => {
    // The reply CARRIES recipients: a face computed for every own-sent row would have somebody to
    // name here, which is what makes this the control for the predicate rather than for the join.
    const mineTo = msg({
      id: "mine", subject: "Re: Quote for the north elevation", threadId: "t1",
      date: "2026-07-31T09:00:00.000Z", folder: "Sent",
      to: [{ name: "Sam Example", address: "sam@colleague.example" }],
    });
    conversation = [A, mineTo, C];
    await mountPane(C);
    expect(card("mine")!.querySelector(".msg-sender b")!.textContent).not.toContain("Forwarded to");
    expect(text()).not.toContain("Forwarded to");
  });

  it("a RECEIVED 'Fwd:' is somebody else's forward and keeps its sender's name", async () => {
    const theirs = msg({
      id: "theirs", subject: "Fwd: Quote for the north elevation", threadId: "t1",
      date: "2026-08-01T11:00:00.000Z", folder: "INBOX",
      to: [{ name: "Sam Example", address: "sam@colleague.example" }],
    });
    conversation = [A, theirs];
    await mountPane(A);
    expect(card("theirs")!.querySelector(".msg-sender b")!.textContent).not.toContain("Forwarded to");
  });

  it("the German catalogue carries the same face", () => {
    const de = JSON.parse(readFileSync(resolve(__dirname, "../messages/de.json"), "utf8")) as { message: Record<string, string> };
    expect(de.message.forwardedTo).toBe("Weitergeleitet an {name}");
    expect((messages as { message: Record<string, string> }).message.forwardedTo).toBe("Forwarded to {name}");
  });
});

describe("a message with no conversation gets no conversation chrome", () => {
  it("renders no count, no note and no second pane", async () => {
    conversation = [];
    await mountPane(msg({ id: "solo", subject: "Just this", threadId: null, date: "2026-08-01T09:00:00.000Z" }));

    expect(panes()).toBe(1);
    expect(host!.querySelector(".conv")).toBeNull();
    expect(text()).not.toContain("on this conversation");
    expect(text()).not.toContain("Sent folder");
    // The body is still the body — the singleton path is byte-identical to pre-P6b.
    expect(host!.querySelector(".msg-body")!.textContent).toBe("snippet-solo");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SLICE · THE CONVERSATION IS ON SCREEN EXACTLY ONCE
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("the conversation is on screen exactly once", () => {
  const allEntries = (): (string | null)[] =>
    [...host!.querySelectorAll<HTMLElement>("[data-conv-id]")].map((e) =>
      e.getAttribute("data-conv-id"),
    );

  it("stays in the PANE while the editor is open — one copy, and the editor below it", async () => {
    conversation = [A, B, C];
    replyTo = "b";
    await mountPane(B);

    const editor = host!.querySelector<HTMLElement>(".reply .reply-editor .rte-surface");
    expect(editor, "no reply editor mounted, so `exactly once` proves nothing here").toBeTruthy();

    expect(host!.querySelector(".conv")).toBeTruthy();
    expect(host!.querySelector(".reply-context")).toBeNull();
    expect(allEntries()).toEqual(["a", "b", "c"]);
    expect(new Set(allEntries()).size).toBe(allEntries().length);

    // ONE copy of the body the reader came for: the focused entry's prose, not a second
    // `.msg-body` and not a quote of it.
    expect(host!.querySelectorAll(".msg-body")).toHaveLength(1);
    expect(occurrences(text(), "snippet-b")).toBe(1);

    const conv = host!.querySelector(".conv")!;
    expect(conv.compareDocumentPosition(editor!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("…and it is the same one copy when the editor is closed", async () => {
    conversation = [A, B, C];
    replyTo = null;
    await mountPane(B);

    expect(allEntries()).toEqual(["a", "b", "c"]);
    expect(host!.querySelectorAll(".msg-body")).toHaveLength(1);
    expect(occurrences(text(), "snippet-b")).toBe(1);
    expect(host!.querySelector(".reply")).toBeNull();
  });

  it("a message with NO conversation is not repeated by the editor either", async () => {
    conversation = [];
    replyTo = "solo";
    await mountPane(msg({ id: "solo", subject: "Just this", threadId: null, date: "2026-08-01T09:00:00.000Z" }));

    expect(host!.querySelector(".reply-editor")).toBeTruthy();
    expect(host!.querySelector(".reply-context")).toBeNull();
    expect(host!.querySelectorAll(".msg-body")).toHaveLength(1);
    expect(occurrences(text(), "snippet-solo")).toBe(1);
    expect(text()).not.toContain("the only message ohmail has on this conversation");
  });

  it("a SENSITIVE message being answered renders its body in full (no withholding)", async () => {
    const FULL = "Your verification code is 449 201";
    replyTo = "otp";
    bodyState = "full";
    await mountPane({
      ...msg({ id: "otp", subject: "Your code", threadId: null, date: "2026-08-01T09:00:00.000Z", liveSensitive: true }),
      body: FULL,
    });

    expect(host!.querySelector(".reply-editor")).toBeTruthy();
    expect(host!.querySelector(".protected")).toBeNull();
    expect(host!.querySelector(".msg-body")).toBeTruthy();
    expect(text()).toContain("449 201");
  });
});

/** How many times `needle` occurs in `hay` — non-overlapping, plain string search. */
function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SLICE · THE READING PANE SAYS WHAT ITS TEXT IS
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("the pane distinguishes 'this is the whole message' from the three things that are not", () => {
  const SOLO = msg({ id: "solo", subject: "Just this", threadId: null, date: "2026-08-01T09:00:00.000Z" });

  it("a FULL body says nothing at all — the Blanc pane, unchanged", async () => {
    bodyState = "full";
    await mountPane(SOLO);
    expect(host!.querySelector(".msg-body")!.textContent).toBe("snippet-solo");
    expect(host!.querySelector(".msg-body-state")).toBeNull();
  });

  it("a SNIPPET says the message is still coming — it is NOT a sub-frame state", async () => {
    bodyState = "snippet";
    await mountPane(SOLO);
    const note = host!.querySelector(".msg-body-state");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Loading the full message");
    expect(host!.querySelector(".msg-body")!.textContent).toBe("snippet-solo");
  });

  it("LOADING says so, beside the body and not inside it", async () => {
    bodyState = "loading";
    await mountPane(SOLO);
    expect(host!.querySelector(".msg-body")!.textContent).toBe("snippet-solo");
    const note = host!.querySelector(".msg-body-state")!;
    expect(note.textContent).toContain("Loading the full message");
    expect(note.classList.contains("warn")).toBe(false);
  });

  it("FAILED says so DIFFERENTLY, and carries a way out (Risk 2)", async () => {
    bodyState = "failed";
    await mountPane(SOLO);

    const note = host!.querySelector(".msg-body-state")!;
    expect(note.textContent).toContain("Couldn't load the full message");
    expect(note.classList.contains("warn")).toBe(true);
    expect(note.textContent).not.toContain("Loading the full message");

    const retry = [...host!.querySelectorAll<HTMLButtonElement>(".msg-body-state button")]
      .find((b) => b.textContent?.includes("Retry"));
    expect(retry, "a failed body with no control is a dead end").toBeTruthy();
    await act(async () => { retry!.click(); });
    expect(retried).toEqual(["solo"]);
  });

  it("a sensitive message renders its body in full — no withholding at the surface", async () => {
    const FULL = "Your verification code is 449 201";
    const otp = {
      ...msg({ id: "otp", subject: "Your code", threadId: null, date: "2026-08-01T09:00:00.000Z", liveSensitive: true }),
      body: FULL,
    };
    bodyState = "full";
    await mountPane(otp);

    expect(host!.querySelector(".protected")).toBeNull();
    expect(text()).not.toContain("······");
    expect(host!.querySelector(".msg-body")).toBeTruthy();
    expect(text()).toContain("449 201");
  });

  it("a LIVE sensitive message renders its body — the engine fetches it like any other", async () => {
    const otp = {
      ...msg({
        id: "otp", subject: "Your code", threadId: null, date: "2026-08-01T09:00:00.000Z",
        snippet: "Ich finde deine Idee mit dem Rollen-Guard gut", liveSensitive: true,
      }),
      body: "Ich finde deine Idee mit dem Rollen-Guard gut",
    };
    bodyState = "full";
    await mountPane(otp);

    expect(host!.querySelector(".protected"), "no message is withheld from its reader now").toBeNull();
    expect(host!.querySelector(".msg-body")).toBeTruthy();
    expect(text()).toContain("Rollen-Guard");
  });

  it("a body that never arrives becomes a failure with Retry, not a permanent spinner", async () => {
    vi.useFakeTimers();
    try {
      bodyState = "loading";
      await mountPane(A);
      expect(host!.querySelector(".msg-body-state")!.textContent).toContain("Loading the full message");

      const { BODY_STALL_MS } = await import("../app/shell/message-chrome.js");
      await act(async () => { vi.advanceTimersByTime(BODY_STALL_MS + 1); });

      const note = host!.querySelector(".msg-body-state")!;
      expect(note.textContent, "the spinner outlived the engine's own deadline").toContain("Retry");
      expect(note.textContent).not.toContain("Loading the full message");
      expect(note.className).toContain("warn");

      retried = [];
      await act(async () => { note.querySelector("button")!.click(); });
      expect(retried).toContain(A.id as string);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the spinner stands for as long as a request could still be in the air", async () => {
    vi.useFakeTimers();
    try {
      bodyState = "loading";
      await mountPane(A);
      const { BODY_STALL_MS } = await import("../app/shell/message-chrome.js");
      await act(async () => { vi.advanceTimersByTime(BODY_STALL_MS - 100); });

      const note = host!.querySelector(".msg-body-state")!;
      expect(note.textContent, "the failure was declared before the deadline").toContain(
        "Loading the full message",
      );
      expect(note.textContent).not.toContain("Retry");
      expect(note.className).not.toContain("warn");
    } finally {
      vi.useRealTimers();
    }
  });

  it("…and a sensitive message is treated like any other — a failed fetch shows the note", async () => {
    bodyState = "failed";
    await mountPane(msg({ id: "otp2", subject: "Your code", threadId: null, date: "2026-08-01T09:00:00.000Z", liveSensitive: true }));
    expect(host!.querySelector(".protected")).toBeNull();
    expect(host!.querySelector(".msg-body-state")).toBeTruthy();
  });

  it("the state line survives the CONVERSATION path, which composes the middle section itself", async () => {
    conversation = [A, B, C];
    bodyState = "loading";
    await mountPane(B);
    expect(host!.querySelector(".conv")).toBeTruthy();
    expect(host!.querySelector(".conv-focus .msg-body-state")!.textContent).toContain("Loading the full message");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SIBLINGS ARE THE MAIL, NOT ONE LINE OF IT — AND NOTHING FETCHES PER PANEL
   ══════════════════════════════════════════════════════════════════════════════════════════

   The reported defect (before hydration): two German business letters cut off mid-word. Bodies
   are loaded on open in ONE batch, and every panel renders through the SAME viewer the focused
   message uses. */
describe("a conversation's siblings are loaded on open and rendered like mail", () => {
  const frames = (): HTMLIFrameElement[] =>
    [...host!.querySelectorAll<HTMLIFrameElement>(".conv .pm .pm-body iframe")];

  it("asks for every SIBLING's body when the thread opens — as ONE list, not one call each", async () => {
    conversation = [A, B, C];
    await mountPane(B);
    for (const ask of threadAsks) expect(ask.sort()).toEqual(["a", "c"]);
    expect(threadAsks.length).toBeGreaterThan(0);

    threadAsks = [];
    await mountPane(A);
    for (const ask of threadAsks) expect(ask.sort()).toEqual(["b", "c"]);
    expect(threadAsks.length).toBeGreaterThan(0);
  });

  /**
   * THE LOADED-BODIES GUARANTEE. A panel renders a body that is already in the mirror — so the
   * render fires NO `hydrateBody` and adds NO `hydrateThread` call beyond the one batch ask.
   * Mutate `MessageCard` to fetch per panel (a `hydrateBody` in the render path) and `retried`
   * fills, going red.
   */
  it("renders every body with NO per-panel fetch", async () => {
    bodyState = "full";
    conversation = [A, B, C];
    await mountPane(C);

    for (const id of ["a", "b"]) {
      expect(card(id)!.querySelector(".pm-body"), `sibling ${id} has no body slot`).toBeTruthy();
    }
    expect(retried, "rendering panels must not fetch per message").toEqual([]);
    expect(threadAsks.length, "one batch ask per open, nothing per panel").toBeGreaterThan(0);
  });

  it("a sibling panel renders through the SAME viewer the focused message uses", async () => {
    bodyState = "full";
    bodyHtml =
      '<table width="600"><tr><td>' +
      '<p>Auch kann man Euch nicht erreichen, wenn die Durchwahl besetzt ist.</p>' +
      '</td></tr></table>';
    conversation = [A, B, C];
    await mountPane(B);

    expect(frames()).toHaveLength(2);
    for (const f of frames()) {
      expect(f.getAttribute("srcdoc")).toContain("wenn die Durchwahl besetzt ist");
      expect(f.getAttribute("sandbox")).toContain("allow-same-origin");
      expect(f.getAttribute("sandbox")).not.toContain("allow-scripts");
      expect(f.getAttribute("srcdoc")).toContain("default-src 'none'");
    }
    expect(host!.querySelectorAll(".conv .pm .pm-body")).toHaveLength(2);
  });

  it("a sibling still WAITING says so, and its snippet is not offered as the message", async () => {
    bodyState = "loading";
    conversation = [A, B, C];
    await mountPane(B);

    const notes = [...host!.querySelectorAll(".conv .pm .hm-state")];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain("Loading the full message");
      expect(n.classList.contains("warn")).toBe(false);
    }
  });

  it("a sibling that FAILED says so differently and carries the way out", async () => {
    bodyState = "failed";
    conversation = [A, B, C];
    await mountPane(B);

    const note = card("a")!.querySelector(".hm-state")!;
    expect(note.textContent).toContain("Couldn't load the full message");
    expect(note.classList.contains("warn")).toBe(true);
    expect(note.textContent).not.toContain("Loading the full message");

    retried = [];
    const retry = [...card("a")!.querySelectorAll<HTMLButtonElement>(".hm-state button")]
      .find((b) => b.textContent?.includes("Retry"));
    expect(retry, "a failed sibling with no control is a dead end").toBeTruthy();
    await act(async () => { retry!.click(); });
    expect(retried).toContain("a");
  });

  /**
   * A WITHHELD SIBLING MUST SAY SO — the defect this holds shut was a SILENT one.
   *
   * `MessageCard` enumerated `loading`/`snippet` and `failed`; the storage-cap slice added a
   * terminal `withheld` state that matched NEITHER arm, so a sibling whose body the server never
   * stored rendered `bodyOf`'s snippet through `MessageBody` with no note at all — the preview
   * presented as the message, in the one place the reader has no way to tell. The focused pane
   * was honest the whole time, which is exactly what made it invisible.
   *
   * Retry is asserted ABSENT, not merely unused: withheld is an ANSWER, and a control that
   * cannot change the answer is the dead end the failed arm's own control exists to avoid.
   */
  it("a WITHHELD sibling says the stored copy gave way within the storage space, and offers no Retry", async () => {
    bodyState = "withheld";
    conversation = [A, B, C];
    await mountPane(B);

    const notes = [...host!.querySelectorAll(".conv .pm .hm-state")];
    expect(notes, "every sibling at the cap must carry the note").toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain("older stored copies give way to newer mail");
      expect(n.textContent).not.toContain("Loading the full message");
      expect(n.textContent).not.toContain("Couldn't load the full message");
    }

    const retry = [...host!.querySelectorAll<HTMLButtonElement>(".conv .pm .hm-state button")]
      .find((b) => b.textContent?.includes("Retry"));
    expect(retry, "withheld is answered, not failed — a Retry here cannot succeed").toBeUndefined();
  });

  /**
   * EACH WITHHELD MARKER GETS ITS OWN SENTENCE — `withheldCopyKey` (FOLDERS-SPEC.md/mail 0065
   * widened the set). One sentence for three different facts was the residual defect: a body
   * husked by the reader's own spam verdict, and one whose every copy is gone from the server,
   * both claimed "older stored copies give way to newer mail" — a storage-cap explanation for
   * states that have nothing to do with storage. Each case asserts its own load-bearing phrase
   * AND the absence of the storage one, so a resolver collapsed back to one key goes red twice.
   */
  it("a JUNK-FILED body IN THE SPAM PILE names the verdict and the provider's Junk folder — not the storage cap", async () => {
    bodyState = "withheld";
    bodyWithheld = "junk_filed";
    const inSpam = (m: Record<string, unknown>) => ({ ...m, folder: "ohmail/Quarantine" });
    conversation = [A, B, C].map(inSpam);
    await mountPane(inSpam(B));
    const notes = [...host!.querySelectorAll(".conv .pm .hm-state")];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain("your spam verdict filed this message to the Junk folder");
      expect(n.textContent).not.toContain("older stored copies give way");
    }
  });

  /**
   * MOVED OUT OF JUNK, THE VERDICT'S SENTENCE IS FALSE (owner defect, 2026-09-23): the person moved
   * the message to the Ohbox and the reader went on saying the verdict filed it. A `junk_filed`
   * husk outside the spam pile is text on its way back — "loading", on every reader surface —
   * and past the bound the reader says it could not be read, never the verdict.
   */
  it("a JUNK-FILED husk moved OUT of the spam pile reads loading, then the bounded failure — never the verdict", async () => {
    bodyState = "withheld";
    bodyWithheld = "junk_filed";
    conversation = [A, B, C];
    await mountPane(B);
    const said = () => host!.textContent ?? "";
    expect(said()).toContain("Loading this message from your mail server");
    expect(said()).not.toContain("your spam verdict filed this message");
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(said()).not.toContain("Loading this message from your mail server");
    expect(said()).toContain("Couldn't load the full message");
    expect(said()).not.toContain("your spam verdict filed this message");
  });

  it("the husk shed by the refill's own change is asked for again, where it is being read", async () => {
    bodyState = "withheld";
    bodyWithheld = "junk_filed";
    conversation = [A, B, C];
    await mountPane(B);
    retried = [];
    // The mirror sheds a restorable husk on the message's next change: the body is waiting again.
    bodyState = "snippet";
    bodyWithheld = null;
    await rerender!();
    expect(retried).toContain(B.id);
  });

  it("an EXPUNGED body says the copies are gone — it does NOT promise the mail is safe in the mailbox", async () => {
    bodyState = "withheld";
    bodyWithheld = "expunged";
    conversation = [A, B, C];
    await mountPane(B);
    const notes = [...host!.querySelectorAll(".conv .pm .hm-state")];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain("every copy of this message is gone");
      // The storage sentence's reassurance is FALSE here — that is why the marker exists.
      expect(n.textContent).not.toContain("safe in your mailbox");
      expect(n.textContent).not.toContain("older stored copies give way");
    }
  });

  /* A message over the download ceiling (OVERSIZE-MESSAGE-IS-STORED-NOWHERE): its reader names the
     ceiling and where to read it, not a storage or loading state it is not in. */
  it("a TOO-LARGE body names the download ceiling and the mail provider — no storage sentence, no Retry", async () => {
    bodyState = "withheld";
    bodyWithheld = "too_large";
    conversation = [A, B, C];
    await mountPane(B);
    const notes = [...host!.querySelectorAll(".conv .pm .hm-state")];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain(`larger than ${MAX_RAW_MESSAGE_BYTES / (1024 * 1024)} MB`);
      expect(n.textContent).toContain("Open it in your mail provider");
      expect(n.textContent).not.toContain("older stored copies give way");
    }
    expect([...host!.querySelectorAll("button")].find((x) => x.textContent?.includes("Retry"))).toBeUndefined();
  });

  it("the storage-cap marker keeps the storage sentence, upgrade path included", async () => {
    bodyState = "withheld";
    bodyWithheld = "storage_cap";
    conversation = [A, B, C];
    await mountPane(B);
    const notes = [...host!.querySelectorAll(".conv .pm .hm-state")];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.textContent).toContain("older stored copies give way to newer mail");
      expect(n.textContent).toContain("A bigger plan adds storage space");
    }
  });

  it("a LIVE sensitive sibling renders its body like any other sibling", async () => {
    const otp = {
      ...msg({
        id: "otp", subject: "Your code", threadId: "t1", date: "2026-07-29T09:00:00.000Z",
        snippet: "Ich finde deine Idee mit dem Rollen-Guard gut", liveSensitive: true,
      }),
      body: "Ich finde deine Idee mit dem Rollen-Guard gut",
    };
    bodyState = "full";
    bodyHtml = null;
    conversation = [otp, B, C];
    await mountPane(B);

    const article = card("otp")!;
    expect(article).toBeTruthy();
    expect(article.textContent).toContain("Rollen-Guard");
    expect(article.textContent).not.toContain("(redacted)");
  });

  it("a sensitive sibling renders its content, frame and all — like every other sibling", async () => {
    const otp = msg({
      id: "otp", subject: "Your code", threadId: "t1", date: "2026-07-29T09:00:00.000Z",
      snippet: "code is 449 201", liveSensitive: true,
    });
    bodyState = "full";
    bodyHtml =
      '<table width="600"><tr><td><p>Your verification code is 449 201</p></td></tr></table>';
    conversation = [otp, B, C];
    await mountPane(B);

    const article = card("otp")!;
    expect(article).toBeTruthy();
    expect(article.textContent).not.toContain("(redacted)");
    const frame = article.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("srcdoc") ?? "").toContain("449 201");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE FOCUSED MESSAGE NEEDS NO COLOUR-ONLY CUE
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("which message is focused", () => {
  it("is shown by position and aria, not by a side rule or a border", () => {
    // GUARD, carried through the panel redesign. The focused message used to carry a
    // terracotta inset side line (`box-shadow: inset 2px 0 0 var(--accent)`) and the indent
    // that made room for it. That was ruled out; in the panel world every message wears the
    // SAME panel treatment and the focused one is marked by `aria-current`, never by an accent
    // rule. Parsed from the shipped `app.css` so a re-added side rule or border is a red test.
    // jsdom applies no stylesheet, so the file's own text is the fact. Mutation: put a
    // `box-shadow: inset …` in the `.conv > .conv-focus` block — red.
    const REL = "app/app.css";
    const sheet = [
      resolve(process.cwd(), REL),
      resolve(process.cwd(), "apps/webapp", REL),
    ].find(existsSync);
    expect(sheet, `could not find ${REL} from ${process.cwd()}`).toBeTruthy();
    const css = readFileSync(sheet!, "utf8");
    const rule = /\.conv\s*>\s*\.conv-focus\s*\{([^}]*)\}/.exec(css);
    expect(rule, ".conv > .conv-focus must exist").toBeTruthy();
    expect(rule![1], "the focused message must carry no side rule").not.toMatch(/box-shadow/);
    expect(rule![1], "the focused message must carry no border").not.toMatch(/border/);
    expect(rule![1], "the focused message must carry no inset accent line").not.toMatch(/inset/);
  });
});

describe("a sibling panel shows its message's files", () => {
  /**
   * ══ THE SENT-REPLY-IN-A-THREAD DEFECT, PINNED IN ITS EXACT SHAPE ═══════════════════════════
   *
   * Found on a live account: the reader's own sent reply — ingested by the worker from the Sent
   * folder, its two files extracted, stamped and rowed server-side — rendered inside the open
   * thread as a conversation SIBLING (the thread was opened at the newest inbound message), and
   * the panel composed header and body and nothing else. The files existed everywhere but on
   * screen. The strip lived only on the focused panel; a sibling never asked.
   *
   * The guard: a SENT sibling whose chrome holds a ready two-file list renders the strip, inside
   * ITS OWN panel, through the same `itemsOf` read the focused pane uses. Mutation: remove the
   * `AttachmentStrip` block from `MessageCard` — red.
   */
  const SENT_FILES = [
    { id: "att-1", filename: "banner-v02x2.png", mimeType: "image/png", sizeBytes: 1_153_017, state: "idle" },
    { id: "att-2", filename: "banner-v02.png", mimeType: "image/png", sizeBytes: 317_030, state: "idle" },
  ];
  /** The found case's row: the user's own reply, read back out of Sent, files stamped. */
  const MINE_WITH_FILES = { ...MINE, hasAttachments: true, attachmentCount: 2 };

  it("renders the attachment strip on a SENT sibling that carries files, not only on the focused panel", async () => {
    conversation = [A, MINE_WITH_FILES, C];
    attachmentsChrome = readyAttachments({ mine: SENT_FILES });
    await mountPane(C);

    const strip = card("mine")?.querySelector(".att-strip");
    expect(strip, "the sent sibling's panel must carry its attachment strip").toBeTruthy();
    // Both files, by name, inside the sibling's own panel — never counted into some other panel.
    expect(strip!.textContent).toContain("banner-v02x2");
    expect(strip!.textContent).toContain("banner-v02");
    // The ask went through the SHARED chrome read, addressed by this panel's id. A second read
    // path for siblings is exactly what this slice refused to add.
    expect(itemsAsked.some((a) => a.id === "mine")).toBe(true);
    // …and the sibling's panel HELD its own list: a strip over a list nobody asked for is silent.
    expect(held, "a panel drew a strip without asking for its list").toContain("mine");
    expect(held, "the focused panel drew a strip without asking for its list").toContain("c");
  });

  it("carries the focused pane's list discipline: every part, on every ask", async () => {
    // The `includeInlineParts` wire, end to end on a SIBLING. The list is no longer coupled to
    // which rendering is on screen (the 2026-09-19 ruling): every ask carries the flag, so a `cid:`
    // photo in an older reply is reachable from the first paint — there is no files-only frame
    // between mount and a prose signal for a picture to be missing in.
    conversation = [A, MINE_WITH_FILES, C];
    attachmentsChrome = readyAttachments({ mine: SENT_FILES });
    await mountPane(C);

    const asks = itemsAsked.filter((a) => a.id === "mine");
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((a) => a.inline), "one narrow ask would hide an embedded photo's tile").toBe(true);
  });

  it("renders NO strip where the shell wires no attachments chrome — absent, not broken", async () => {
    // The demo and any host without the capability: `chrome.attachments` is undefined, and the
    // sibling must answer the way the focused pane does — no strip, no dead controls, no crash.
    conversation = [A, MINE_WITH_FILES, C];
    attachmentsChrome = null;
    await mountPane(C);

    expect(card("mine")?.querySelector(".att-strip")).toBeNull();
  });

  it("a sibling with NOTHING to show renders no strip — ready-empty is silence, not a notice", async () => {
    conversation = [A, MINE_WITH_FILES, C];
    attachmentsChrome = readyAttachments({ mine: SENT_FILES });
    await mountPane(C);

    // "a"'s list answered ready-with-nothing; its panel must not grow attachment chrome for it.
    expect(card("a")?.querySelector(".att-strip")).toBeNull();
  });
});

describe("a sibling tile's eye dispatches the preview for the SIBLING's message", () => {
  it("pressing the eye on a sibling's previewable file records the sibling id, not the focused one", async () => {
    // The other half of the sibling-preview finding: the card must dispatch
    // `openAttachmentPreview` with ITS OWN message id (the shell's derive-close now accepts
    // conversation members — `attachments-wired.test.ts` holds that half). Dispatching the
    // focused id here would open the wrong message's file, or nothing.
    conversation = [A, MINE, C];
    attachmentsChrome = readyAttachments({
      mine: [{ id: "att-9", filename: "look.png", mimeType: "image/png", sizeBytes: 9, state: "idle" }],
    });
    await mountPane(C);

    const eye = card("mine")?.querySelector<HTMLButtonElement>(".att-strip .att-tile");
    expect(eye, "the sibling's previewable tile did not render").toBeTruthy();
    await act(async () => { eye!.click(); });
    expect(previewed).toContain("mine:att-9");
  });
});
