/** @vitest-environment jsdom */
/**
 * MOVED FROM `conversation.test.ts` (share reader-1, the older tests sorted once): the four cases of a letter answered
 * IN ITS READING STREAM (News, Receipts). The stream's place is not mounted by the new shell yet (`mount-streams`), so
 * these cases stand as they stood, over today's `MessagePane` in its stream form, their rows WAITS:news or
 * GAP:mount-streams; the stream's mount re-points them. They stand in a file of their own so that the conversation's
 * other cases, re-pointed onto the new reader, import nothing that leaves with today's shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleEditor } from "./_first-paint.js";
import { setActiveFormatZone } from "../app/shell/locale";
import { createThreadWalkChannel } from "@ohmail/app-logic/reading/thread-walk-channel";

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
/** Mutation point: the status `GET /mailboxes` gives the messages' mailbox (`mb`) — the chrome's `mailboxStatusOf`. */
let mailboxStatus: string | null = null;
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
/** Mutation point: the reading stream's form (`stream-in-place.tsx`), or null — every other surface. */
let streamForm: { arriving: boolean } | null = null;

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
            mailboxStatusOf: (id: string) => (id === "mb" ? mailboxStatus : null),
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
            ...(streamForm
              ? { stream: { walk: createThreadWalkChannel(), arriving: streamForm.arriving }, scroller: { current: host } }
              : {}),
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
  mailboxStatus = null;
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
  streamForm = null;
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
describe("a letter answered in its reading stream", () => {
  const SOLO = msg({ id: "solo", subject: "Issue 118", threadId: null, date: "2026-08-01T09:00:00.000Z" });
  /** A scrolling host whose every `scrollTop` write is recorded. */
  const scrolling = (writes: number[]) => (col: HTMLDivElement): void => {
    col.style.overflowY = "auto";
    Object.defineProperty(col, "scrollTop", {
      configurable: true,
      get: () => 50,
      set: (v: number) => { writes.push(v); },
    });
    col.scrollTo = ((o: ScrollToOptions) => { writes.push(o.top ?? -1); }) as typeof col.scrollTo;
  };

  it("a lone letter is one panel of a conversation, so the paper keeps its place when a reply joins", async () => {
    streamForm = { arriving: true };
    replyTo = "solo";
    await mountPane(SOLO);
    expect(host!.querySelector("article.msg"), "the single-message article").toBeNull();
    expect(host!.querySelector(".conv[data-stream] > article.pm[data-conv-id='solo']")).not.toBeNull();
    expect(host!.querySelector(".conv[data-stream] > .reply-dock .reply[data-reply-for]")).not.toBeNull();
    expect(host!.querySelector(".conv[data-thread-read]"), "no thread-read rule in a stream").toBeNull();
    expect(host!.querySelector(".thread-marks"), "one message draws no squares").toBeNull();
  });

  it("two messages draw the squares, without the read rule", async () => {
    streamForm = { arriving: false };
    conversation = [A, MINE];
    await mountPane(A);
    const squares = [...host!.querySelectorAll<HTMLElement>(".conv[data-stream] > .thread-marks .tm-mb")];
    expect(squares.map((b) => b.dataset.for)).toEqual(["a", "mine"]);
    expect(squares[1]!.querySelector(".tm-sq.mine")).not.toBeNull();
    expect(host!.querySelector("[data-thread-read]")).toBeNull();
  });

  it("mounting scrolls nothing — the stream is the host's to move", async () => {
    const control: number[] = [];
    await mountPane(SOLO, scrolling(control));
    expect(control, "control: outside a stream a lone letter opens at its top").toContain(0);

    for (const [conv, open] of [[[], SOLO], [[A, B, C], B]] as const) {
      const writes: number[] = [];
      streamForm = { arriving: true };
      conversation = [...conv];
      replyTo = open.id as string;
      await mountPane(open, scrolling(writes));
      expect(writes, `the pane scrolled the stream (${conv.length} panels)`).toEqual([]);
    }
  });

  it("the editor takes focus on its arrival only", async () => {
    // The editor focuses itself a frame after it stands: run that frame at once.
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; });
    const focused = (): boolean => !!host!.querySelector(".reply-editor")?.contains(document.activeElement);
    try {
      streamForm = { arriving: true };
      replyTo = "solo";
      await mountPane(SOLO);
      expect(host!.querySelector(".reply-editor .ProseMirror"), "the editor stands").not.toBeNull();
      expect(focused(), "control: an arrival focuses").toBe(true);

      streamForm = { arriving: false };
      await mountPane(SOLO);
      expect(host!.querySelector(".reply-editor .ProseMirror"), "the editor stands").not.toBeNull();
      expect(focused()).toBe(false);
    } finally {
      frame.mockRestore();
    }
  });
});
