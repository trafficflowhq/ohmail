/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { MemoryMirrorStore, OhmailEngine, mutationEffects, type EngineMessage, type EngineMutation, type SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";

/**
 * THE THREAD'S ⋯ MENU DOES WHAT IT SAYS — Reply answers the panel it is pressed on, and
 * Forward happens INSIDE the reading surface.
 *
 * Both halves were reported from real use:
 *
 *   · every panel's ⋯ menu dispatched its OWN id (`MessageHeader`, by design), and the shell
 *     faithfully set `replyTo` to it — but the editor dock mounted only when the id was the
 *     FOCUSED message's (`MessagePane`), so Reply on any other panel of a conversation set
 *     state that nothing anywhere rendered. A menu that presses and produces nothing is a
 *     dead menu. Pinned here over a fabricated conversation (the chrome-stubbed mount the
 *     conversation suite uses), because the fixture world holds no multi-message thread.
 *   · Forward navigated to the compose screen (`go("compose")`), taking the reader away from
 *     the message being forwarded. It is the reply editor's sibling now: the same dock, in
 *     forward mode — recipients the user's to pick (rows open at once, empty), the user's
 *     note as the body, the server still building the quote and streaming the original's
 *     attachments (`mail_send.forwardOf`, unchanged semantics). Pinned through the WHOLE
 *     shell on the fixture world, because the defect lived in the shell's wiring.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom has no matchMedia; the shell asks it whether it is in the split pane. */
function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  window.location.hash = "";
}

/**
 * Let the send's promise chain settle across the TASK boundary a press now crosses — see the
 * same helper in `inline-reply.test.ts`. Without it the deferred `engine.mutate` never runs.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  }
};

/* THE SHELL'S MODULES LOAD ONCE, HERE, under their own bound — no case pays the cold import inside
   its 5 s timeout, where a timed-out mount strands and reddens the cases after it (REVIEW-026 L2,
   the compose-focus file's own fix). */
beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("../app/shell/MessagePane.js");
  await import("../app/shell/message-chrome.js");
  await import("@ohmail/ui");
}, 120_000);

/** Wait for a condition by TIME (3 s), never by a tick count a loaded host can exhaust. */
const waitUntil = async (cond: () => boolean): Promise<boolean> => {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (cond()) return true;
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  }
  return cond();
};

/** …and run out the closing beat, for the cases that assert the dock is gone. */
const settleClosed = async (): Promise<void> => {
  await settle();
  const { SENT_BEAT_MS } = await import("../app/shell/mail-send.js");
  await act(async () => { await new Promise((r) => { setTimeout(r, SENT_BEAT_MS + 80); }); });
  await settle();
};

/** Press one item of a panel's ⋯ menu, by its rendered label. */
async function pressMenuItem(panel: HTMLElement, label: string): Promise<void> {
  const more = panel.querySelector<HTMLElement>(".msg-more");
  expect(more, "the panel's ⋯ trigger").toBeTruthy();
  await act(async () => { more!.click(); });
  const item = [...panel.querySelectorAll<HTMLElement>(".mmenu button")]
    .find((b) => b.textContent?.trim() === label);
  expect(item, `a ⋯ item reading "${label}"`).toBeTruthy();
  await act(async () => { item!.click(); });
  await settle();
}

afterEach(async () => {
  await unmount();
  repliedTo = [];
  sentFor = [];
  stubReplyTo = null;
  stubReplyMode = "reply";
  stubDraftReply = undefined;
  vi.restoreAllMocks();
});

/* ══ HALF ONE: the sibling's Reply mounts the dock — chrome-stubbed conversation ══════════ */

interface Seed { id: string; date: string }
function seedMsg(s: Seed): Record<string, unknown> {
  return {
    id: s.id, accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null,
    subject: `subj-${s.id}`, from: { name: `Sender ${s.id}`, address: `${s.id}@example.invalid` },
    to: [], cc: [], date: s.date, folder: "INBOX", snippet: `snippet-${s.id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: s.date,
  };
}

/** What the stubbed shell recorded, and the live `replyTo` the re-render reads. */
let repliedTo: string[] = [];
let sentFor: string[] = [];
let stubReplyTo: string | null = null;
let stubReplyMode: "reply" | "forward" = "reply";
let stubDraftReply: unknown = undefined;

async function mountStubbedPane(conversation: Record<string, unknown>[], focused: Record<string, unknown>): Promise<void> {
  await unmount();
  setViewport();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  const render = async (): Promise<void> => {
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(MessageChromeProvider as never, {
            value: {
              ownAddresses: [],
              replyTo: stubReplyTo,
              replyMode: stubReplyMode,
              ...(stubDraftReply !== undefined ? { draftReply: stubDraftReply } : {}),
              replyBody: { text: "", html: "" },
              onReplyBody: () => {},
              closeReply: () => {},
              sendReply: (id: string) => { sentFor.push(id); },
              replySendState: () => ({ phase: "idle" }),
              openSenderMenu: () => {},
              conversationOf: () => conversation,
              bodyOf: (m: Record<string, unknown>) => ({
                text: m.snippet as string, state: "full", html: null,
                loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
              }),
              hydrateBody: () => {},
              hydrateThread: () => {},
              // The shell's wiring shape: Reply RECORDS and RETARGETS — exactly what
              // `AppShell.openReply` does — and the re-render hands the new `replyTo` down.
              openReply: (id: string) => { repliedTo.push(id); stubReplyTo = id; void render(); },
              forward: () => {},
            },
            children: h(MessagePane as never, {
              message: focused,
              tags: [],
              now: new Date("2026-08-02T09:00:00.000Z"),
              onAction: () => {},
              onAddTag: () => {},
            } as never),
          } as never),
        }),
      );
    });
  };
  await render();
  await settle();
}

/** The verb's LABEL, without the keycap the button also wears (`<Key chord>` / the send
 * chord's cap print the registry's key into the button, so textContent grew a suffix). */
const buttonLabel = (b: HTMLElement): string => {
  const kbd = b.querySelector("kbd")?.textContent ?? "";
  return (b.textContent ?? "").replace(kbd, "").trim();
};

describe("reply from a sibling panel mounts the editor — the menu is never a dead dispatch", () => {
  it("⋯ → Reply on a SIBLING docks the editor bound to that sibling", async () => {
    const older = seedMsg({ id: "t-old", date: "2026-08-01T09:00:00.000Z" });
    const newer = seedMsg({ id: "t-new", date: "2026-08-02T08:00:00.000Z" });
    await mountStubbedPane([older, newer], newer);

    const sibling = host!.querySelector<HTMLElement>('article.pm[data-conv-id="t-old"]');
    expect(sibling, "the older message's panel").toBeTruthy();
    await pressMenuItem(sibling!, "Reply");

    expect(repliedTo).toEqual(["t-old"]);
    const dock = host!.querySelector<HTMLElement>(".reply-dock .reply[data-reply-for]");
    expect(dock, "the editor, mounted — Reply on a sibling used to set state nothing rendered").toBeTruthy();
    expect(dock!.dataset.replyFor, "…bound to the SIBLING the menu was pressed on").toBe("t-old");

    // And the send it offers is the SIBLING's: the whole lane follows the target.
    const send = [...dock!.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => buttonLabel(b) === "Send")!;
    expect(send).toBeTruthy();
  });

  it("the focused panel's Reply still docks its own editor — the retarget did not steal it", async () => {
    const older = seedMsg({ id: "t-old", date: "2026-08-01T09:00:00.000Z" });
    const newer = seedMsg({ id: "t-new", date: "2026-08-02T08:00:00.000Z" });
    await mountStubbedPane([older, newer], newer);

    const focused = host!.querySelector<HTMLElement>('article.pm[data-conv-id="t-new"]')!;
    await pressMenuItem(focused, "Reply");
    expect(host!.querySelector<HTMLElement>(".reply-dock .reply[data-reply-for]")?.dataset.replyFor).toBe("t-new");
  });
});

/* ══ HALF TWO: forward is the reply's sibling, inside the reading surface — whole shell ═══ */

async function mountShell(): Promise<void> {
  await unmount();
  setViewport();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  // Open a message: `j` puts the cursor on the first row, a second act opens the column's pane.
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
  });
  await settle();
}

/** The open message's panel in the split column — single message or conversation focus alike. */
const openPanel = (): HTMLElement => {
  const p = host!.querySelector<HTMLElement>(".read-col .conv-focus")
    ?? host!.querySelector<HTMLElement>(".read-col .msg");
  expect(p, "an open message in the reading column").toBeTruthy();
  return p!;
};

describe("forward is the reply's sibling, inside the reading surface", () => {
  it("⋯ → Forward opens the inline dock in forward mode — no navigation, recipients open and empty, Send locked", async () => {
    await mountShell();
    await pressMenuItem(openPanel(), "Forward");

    // THE HEADLINE: the route never changed — forwarding no longer leaves the message.
    expect(window.location.hash, 'Forward used to go("compose")').not.toBe("#/compose");

    const dock = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]");
    expect(dock, "the inline dock, in forward mode").toBeTruthy();

    // The honesty line: the note is the body; the quote and the original's attachments are
    // the server's — the compose surface's own sentence, reused.
    expect(dock!.querySelector(".reply-forwarding")?.textContent ?? "").not.toBe("");

    // Recipients are the user's to pick: the rows are OPEN at once — no derived audience.
    const toInput = dock!.querySelector<HTMLInputElement>(".rcp-input");
    expect(toInput, "the To row, open at once").toBeTruthy();
    expect(toInput!.value).toBe("");
    expect(dock!.querySelectorAll(".rcp-chip").length, "…and EMPTY: no prefilled chips").toBe(0);

    // Cc/Bcc are OPEN AT ONCE (2026-08-27): the forward's recipients stack is the same
    // "change recipients" surface the reply opens, so a blind copy is one click away from the
    // start — no fold, no second affordance.
    expect(dock!.querySelector(".c-ccbcc-toggle"),
      "a Cc/Bcc toggle reappeared in the forward stack — the rows must open at once").toBeNull();
    const rowLabels = [...dock!.querySelectorAll(".c-field label")].map((l) => l.textContent);
    expect(rowLabels, "the Cc row, open and empty").toContain("Cc");
    expect(rowLabels, "the Bcc row, open and empty").toContain("Bcc");

    // And Send is LOCKED until a recipient parses.
    const send = [...dock!.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => buttonLabel(b) === "Send");
    expect(send, "the Send control").toBeTruthy();
    expect(send!.disabled, "Send must wait for a recipient — a forward derives none").toBe(true);
  });

  it("a recipient and a note unlock Send; the confirmed send closes the dock and never navigates", async () => {
    await mountShell();
    const before = openPanel().dataset.convId ?? host!.querySelector<HTMLElement>(".read-col .msg-subject")?.textContent;
    await pressMenuItem(openPanel(), "Forward");

    const dock = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]")!;
    const toInput = dock.querySelector<HTMLInputElement>(".rcp-input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(toInput, "colleague@example.net, ");
      toInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const surface = dock.querySelector<HTMLElement>(".rte-surface")!;
    await act(async () => { typeInto(surface as never, "please see below"); });
    await settle();

    const send = [...dock.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => buttonLabel(b) === "Send")!;
    expect(send.disabled, "a parsed recipient and a note are all a forward waits for").toBe(false);

    await act(async () => { send.click(); });
    await settleClosed();

    // The editor closes on the confirmed send (the fixtures engine confirms synchronously),
    // and the reader is STILL on the message — the surface never navigated. The toast says
    // what actually happened: a FORWARD went out, not a reply ("Reply sent." over a forward
    // was measured live — claims are contracts).
    expect(host!.querySelector(".read-col .reply[data-reply-for]")).toBeNull();
    expect(window.location.hash).not.toBe("#/compose");
    const toast = document.querySelector(".toast")?.textContent ?? "";
    expect(toast).toContain("Forwarded");
    expect(toast).not.toContain("Reply");
    const after = openPanel().dataset.convId ?? host!.querySelector<HTMLElement>(".read-col .msg-subject")?.textContent;
    expect(after).toBe(before);
  });

  /**
   * ── A FORWARD SENDS WITH NO NOTE OF ITS OWN ──────────────────────────────────────────────
   *
   * Reported from real use: *"forwarding a mail enforces a message, a fwd mail must also be able to
   * be sent without a message."* `canSend`'s empty-body refusal was written for a reply, where an
   * empty body means the send carries nothing; a forward's content is the FORWARDED MESSAGE, and
   * the note above it is the optional part. Pass this along, no comment, was the one case the lock
   * made unreachable — and the editor already says so on screen (`.reply-forwarding`: "The
   * original message and its attachments are added when you send").
   *
   * Driven through the shipped dock rather than through `canSend` alone (`forward-send.test.ts`
   * owns the predicate) because the claim being made is about the BUTTON: a recipient, no
   * keystrokes in the editor, Send live.
   */
  it("a recipient ALONE unlocks Send — the forwarded message is the message", async () => {
    await mountShell();
    await pressMenuItem(openPanel(), "Forward");

    const dock = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]")!;
    const toInput = dock.querySelector<HTMLInputElement>(".rcp-input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(toInput, "colleague@example.net, ");
      toInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    // NOTHING typed into the editor. The surface is untouched from the open.
    expect(
      (dock.querySelector<HTMLElement>(".rte-surface")?.textContent ?? "").trim(),
      "the note field is not empty — this case is not testing what it claims",
    ).toBe("");

    const send = [...dock.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => buttonLabel(b) === "Send")!;
    expect(
      send.disabled,
      "Send is locked on a note-less forward — the forwarded message IS the message",
    ).toBe(false);

    // …and it really goes out: the dock closes on the confirmed send and the toast says forward.
    await act(async () => { send.click(); });
    await settleClosed();
    expect(host!.querySelector(".read-col .reply[data-reply-for]")).toBeNull();
    expect(document.querySelector(".toast")?.textContent ?? "").toContain("Forwarded");
  });

  /**
   * ── AND THE PILL IS A DOOR TO IT ─────────────────────────────────────────────────────────
   *
   * *"fwd message / Forward in general should be within our main pill-shaped UI besides Reply
   * etc."* The ⋯ menu every other test here drives is the OLD door and it stays (it is how a
   * sibling on a thread is forwarded without first focusing it). This asserts the new one, on the
   * real shell: the bar's own Forward button opens the same dock, in forward mode, without
   * navigating — one seam, two doors, not two implementations.
   */
  it("the action pill's own Forward button opens the same dock", async () => {
    await mountShell();
    const bar = host!.querySelector<HTMLElement>(".read-col .msg-actions .abar");
    expect(bar, "no action pill in the reading column").toBeTruthy();
    const fwd = [...bar!.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => (buttonLabel(b) ?? "").startsWith("Forward"));
    expect(fwd, "the pill carries no Forward — the ⋯ menu is its only door again").toBeTruthy();

    await act(async () => { fwd!.click(); });
    await settle();

    expect(window.location.hash, "the pill's Forward navigated away").not.toBe("#/compose");
    const dock = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]");
    expect(dock, "the pill's Forward opened no dock").toBeTruthy();
    expect(dock!.querySelector(".reply-forwarding"), "…and it is in FORWARD mode").toBeTruthy();
  });

  /* ONE RESOLVER: the bar's Forward docks on the very message the bar's Reply docks on — both
     dispatch the pane's one `onAction`, bound to the OPENED message. One mount per row, so a slow
     host costs one case its time and never strands a shell under the next. */
  it.each([0, 1, 2, 3])("ONE RESOLVER, demo row %i: Forward docks where Reply docks", async (row) => {
    await mountShell();
    for (let k = 0; k < row; k++) {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
      });
      await settle();
    }
    const bar = () => host!.querySelector<HTMLElement>(".read-col .msg-actions .abar");
    expect(await waitUntil(() => bar() !== null), `row ${row}: no bar`).toBe(true);
    const verb = (label: string) => [...bar()!.querySelectorAll<HTMLButtonElement>(".abar-row:not(.abar-measure) button")]
      .find((b) => b.getAttribute("aria-label") === label || buttonLabel(b) === label);
    const dockFor = () => host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]")?.dataset.replyFor;
    await act(async () => { verb("Reply")!.click(); });
    expect(await waitUntil(() => dockFor() !== undefined), `row ${row}: the bar's Reply opened no dock`).toBe(true);
    const replied = dockFor();
    await act(async () => { verb("Forward")!.click(); });
    await waitUntil(() => host!.querySelector(".read-col .reply .reply-forwarding") !== null);
    expect(dockFor(), `row ${row}: Forward and Reply act on different messages`).toBe(replied);
  });

  it("Reply pressed over the forward dock SWITCHES to the reply — the mode is the editor's identity", async () => {
    // A review finding: `toggleReply`'s identity check ignored the mode, so `r` over the
    // forward dock closed it instead of replacing it with the reply it asked for.
    await mountShell();
    await pressMenuItem(openPanel(), "Forward");
    expect(host!.querySelector(".read-col .reply .reply-forwarding"), "forward mode up").toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
    });
    await settle();
    const dock = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]");
    expect(dock, "the dock survived the switch").toBeTruthy();
    expect(dock!.querySelector(".reply-forwarding"), "…as a REPLY now").toBeNull();
  });

  it("a LATE forward confirmation never closes the reply opened after it", async () => {
    // A review finding: the fwd: settle closed whatever editor held the same message id,
    // mode-blind — a delayed confirmation took down an unrelated reply.
    const { FixturesAdapter } = await import("@ohmail/client-engine");
    const real = FixturesAdapter.prototype.mutate;
    let release: ((v: unknown) => void) | null = null;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown, m: unknown, opts: unknown,
    ) {
      const mm = m as { kind?: string; forwardOf?: string | null };
      if (mm.kind === "mail_send" && mm.forwardOf) {
        // Hold the forward's confirmation until the test releases it.
        return new Promise((res) => {
          release = () =>
            void (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>)
              .call(this, m, opts)
              .then(res);
        });
      }
      return (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>).call(this, m, opts);
    } as never);

    await mountShell();
    await pressMenuItem(openPanel(), "Forward");
    const dock = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]")!;
    const toInput = dock.querySelector<HTMLInputElement>(".rcp-input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(toInput, "colleague@example.net, ");
      toInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { typeInto(dock.querySelector<HTMLElement>(".rte-surface") as never, "note"); });
    await settle();
    const send = [...dock.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => buttonLabel(b) === "Send")!;
    await act(async () => { send.click(); });
    await settle();
    expect(release, "the forward is in flight").toBeTruthy();

    // The user changes their mind mid-flight: close the forward, open a REPLY on the message.
    const cancel = [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")]
      .find((b) => b.textContent?.trim() === "Cancel");
    if (cancel) await act(async () => { cancel.click(); });
    await pressMenuItem(openPanel(), "Reply");
    expect(host!.querySelector(".read-col .reply[data-reply-for]"), "the reply is up").toBeTruthy();
    expect(host!.querySelector(".read-col .reply .reply-forwarding")).toBeNull();

    // The forward's confirmation lands LATE — the reply must stand.
    await act(async () => { release!(undefined); });
    await settle();
    const after = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]");
    expect(after, "a late forward settlement closed an unrelated reply").toBeTruthy();
    expect(after!.querySelector(".reply-forwarding")).toBeNull();
  });
});

describe("the drafter never writes into a forward", () => {
  it("the draft card renders in reply mode and NOT in forward mode — same message, same chrome", async () => {
    // A review finding: with a drafted-reply offer active, entering forward mode rendered
    // the card in the forward dock and placed generated reply text into the forward's note.
    const older = seedMsg({ id: "t-old", date: "2026-08-01T09:00:00.000Z" });
    const newer = seedMsg({ id: "t-new", date: "2026-08-02T08:00:00.000Z" });
    const pendingDraft = { draft: { text: "drafted words", html: "" }, messageId: "t-new" };

    stubReplyTo = "t-new";
    stubReplyMode = "reply";
    stubDraftReply = { control: { phase: "closed", messageId: null }, pending: pendingDraft, resolve: () => {} };
    await mountStubbedPane([older, newer], newer);
    expect(host!.querySelector(".reply-dock .dr-card"), "the card, in reply mode").toBeTruthy();

    stubReplyMode = "forward";
    await mountStubbedPane([older, newer], newer);
    expect(host!.querySelector(".reply-dock .reply"), "the dock is up in forward mode").toBeTruthy();
    expect(host!.querySelector(".reply-dock .dr-card"), "…with no drafter card in it").toBeNull();
  });
});

/* ══ THE ORIGINAL'S FILES, LISTED IN THE FORWARD DOCK — over an engine with an attachment list ══ */

const PART_A = "a0000000-0000-4000-8000-000000000001";
const PART_B = "b0000000-0000-4000-8000-000000000002";
const PART_C = "c0000000-0000-4000-8000-000000000003";
const FNOW = new Date("2026-09-16T09:00:00.000Z");
let fwdSent: EngineMutation[] = [];
let fwdEngine: OhmailEngine | null = null;

const fwdMsg = {
  id: "m1", accountId: "a1", mailboxId: "mb1", threadId: "t-m1", folder: "INBOX", subject: "Plans",
  from: { address: "colleague@example.invalid", name: "The colleague" }, to: [{ address: "me@example.invalid", name: "Me" }],
  cc: [], date: "2026-09-16T08:29:00.000Z", unread: false, hasAttachments: true, attachmentCount: 3,
  updatedAt: "2026-09-16T08:29:00.000Z",
} as unknown as EngineMessage;

async function mountForwardShell(o: {
  supported: boolean | null; parts?: Array<{ id: string; filename: string | null; contentType: string; sizeBytes: number; inline: boolean }>;
}): Promise<void> {
  await unmount();
  setViewport();
  window.location.hash = "#/ohbox";
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): [] { return []; }
  };
  fwdSent = [];
  let seq = 0;
  const s = new MemoryMirrorStore();
  await s.load();
  await s.applyChanges([
    { type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: fwdMsg.updatedAt, entity: fwdMsg },
    { type: "rule", op: "create", id: "r1", seq: ++seq, updatedAt: fwdMsg.updatedAt, entity: {
      id: "r1", kind: "sender", match: "colleague@example.invalid", destination: "INBOX", enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
    } },
  ] as SyncChange[]);
  const parts = o.parts ?? [
    { id: PART_A, filename: "plan.pdf", contentType: "application/pdf", sizeBytes: 1000, inline: false },
    { id: PART_B, filename: "logo.png", contentType: "image/png", sizeBytes: 200, inline: true },
    { id: PART_C, filename: "budget.xlsx", contentType: "application/octet-stream", sizeBytes: 3000, inline: false },
  ];
  fwdEngine = new OhmailEngine({
    store: s, now: () => FNOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: s.getCursor(), hasMore: false, serverTime: FNOW.toISOString(),
      }),
      mutate: async (m: EngineMutation) => {
        fwdSent.push(m);
        const changes = mutationEffects(s, m, { now: () => FNOW, uuid: () => `id-${++seq}` })
          .map((e) => ({ type: e.type, op: e.entity === null ? "delete" : "update", id: e.id, seq: ++seq, updatedAt: FNOW.toISOString(), entity: e.entity })) as SyncChange[];
        await s.applyChanges(changes);
        return { changes, seq: null, ...(m.kind === "mail_send" ? { providerMessageId: "<fwd@example.invalid>" } : {}) };
      },
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      listAttachments: async (id: string) => (id === "m1" ? parts.map((p) => ({ ...p, messageId: "m1" })) : []),
      fetchAttachment: async () => new Blob(["x"]),
      forwardPartsAnnounced: async () => o.supported,
    },
  } as never);
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: FNOW,
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(AppShell as never, {
        demo: false, engine: fwdEngine,
        consentTransport: {
          foldersStorable: true,
          state: async () => ({ seedConfirmedAt: "2026-09-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90, foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
        },
        mailboxFacts: async () => [{
          id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null, disabledReason: null,
          syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
          organizerRole: "organizer", organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
        }],
      } as never) }) }),
    }));
  });
  expect(await waitUntil(() => host!.querySelector('.view-ohbox .row[data-id="m1"]') !== null), "m1 in the Ohbox").toBe(true);
  const row = host!.querySelector<HTMLElement>('.view-ohbox .row[data-id="m1"]')!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
  await pressMenuItem(openPanel(), "Forward");
  const dock = host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]")!;
  const toInput = dock.querySelector<HTMLInputElement>(".rcp-input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(toInput, "colleague@example.net, ");
    toInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

const fwdDock = (): HTMLElement => host!.querySelector<HTMLElement>(".read-col .reply[data-reply-for]")!;
const listedParts = (): string[] => [...fwdDock().querySelectorAll<HTMLElement>("[data-forward-part]")].map((r) => r.dataset.forwardPart!);
const removeButtons = (): HTMLButtonElement[] => [...fwdDock().querySelectorAll<HTMLButtonElement>("[data-forward-part] .compose-attach-remove")];
const fwdSend = async (): Promise<Extract<EngineMutation, { kind: "mail_send" }> | undefined> => {
  const send = [...fwdDock().querySelectorAll<HTMLButtonElement>("button")].find((b) => buttonLabel(b) === "Send")!;
  await act(async () => { send.click(); });
  await settle();
  return fwdSent.find((m): m is Extract<EngineMutation, { kind: "mail_send" }> => m.kind === "mail_send");
};

describe("the forward dock lists the original's files", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).IntersectionObserver;
    delete (globalThis as Record<string, unknown>).CSS;
  });

  it("lists all three; removing one sends the two kept ids, and the Sent copy lists two", async () => {
    await mountForwardShell({ supported: true });
    expect(await waitUntil(() => listedParts().length === 3), "the three parts listed").toBe(true);
    expect(fwdDock().textContent).toContain("embedded");
    await act(async () => { removeButtons()[2]!.click(); });
    expect(listedParts()).toEqual([PART_A, PART_B]);
    const m = await fwdSend();
    expect(m?.forwardParts, "the send did not name the kept files").toEqual([PART_A, PART_B]);
    const copy = fwdEngine!.read().list<EngineMessage>("message").find((x) => x.id !== "m1");
    expect(copy, "no Sent copy").toBeDefined();
    await fwdEngine!.loadAttachments(copy!.id);
    const held = fwdEngine!.attachmentsOf(copy!.id, { includeInlineParts: true });
    expect(held.state === "ready" ? held.items.map((i) => i.id) : held.state).toEqual([PART_A, PART_B]);
  });

  it("nothing removed sends no forwardParts key", async () => {
    await mountForwardShell({ supported: true });
    expect(await waitUntil(() => listedParts().length === 3)).toBe(true);
    const m = await fwdSend();
    expect(m).toBeDefined();
    expect(m!).not.toHaveProperty("forwardParts");
  });

  it("a server that cannot honour it offers no Remove, and the line says every file goes", async () => {
    await mountForwardShell({ supported: false });
    expect(await waitUntil(() => listedParts().length === 3)).toBe(true);
    expect(removeButtons()).toHaveLength(0);
    expect(fwdDock().textContent).toContain("All of them go with it.");
  });

  it("a calendar body stays in the kept list when another file is removed", async () => {
    await mountForwardShell({ supported: true, parts: [
      { id: PART_A, filename: "plan.pdf", contentType: "application/pdf", sizeBytes: 1000, inline: false },
      { id: PART_B, filename: null, contentType: "text/calendar", sizeBytes: 400, inline: false },
      { id: PART_C, filename: "budget.xlsx", contentType: "application/octet-stream", sizeBytes: 3000, inline: false },
    ] });
    expect(await waitUntil(() => listedParts().length === 3), "the calendar body is listed").toBe(true);
    await act(async () => { removeButtons()[0]!.click(); });
    expect((await fwdSend())?.forwardParts).toEqual([PART_B, PART_C]);
  });

  it("files over the forwarded ceiling are refused in words, and nothing is sent", async () => {
    await mountForwardShell({ supported: true, parts: [
      { id: PART_A, filename: "huge.mov", contentType: "video/quicktime", sizeBytes: 21 * 1024 * 1024, inline: false },
    ] });
    expect(await waitUntil(() => listedParts().length === 1)).toBe(true);
    expect(await fwdSend()).toBeUndefined();
    expect(fwdDock().querySelector(".forward-files-refusal")?.textContent ?? "").toMatch(/^The forwarded files are over .+\. Remove some to send it\.$/);
  });

  it("files over what the mailbox takes are refused in words, and nothing is sent", async () => {
    await mountForwardShell({ supported: true, parts: [
      { id: PART_A, filename: "big.mov", contentType: "video/quicktime", sizeBytes: 19 * 1024 * 1024, inline: false },
    ] });
    expect(await waitUntil(() => listedParts().length === 1)).toBe(true);
    expect(await fwdSend()).toBeUndefined();
    expect(fwdDock().querySelector(".forward-files-refusal")?.textContent ?? "").toMatch(/your mail server takes\. Remove some files to send it\.$/);
  });
});
