/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { MemoryMirrorStore, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";

/**
 * THE THREAD'S ⋯ MENU DOES WHAT IT SAYS — Reply answers the panel it is pressed on, and
 * Forward happens INSIDE the reading surface.
 *
 * Both halves were reported from real use:
 *
 *   · every panel's ⋯ menu dispatched its OWN id (`MessageHeader`, by design), and the shell
 *     faithfully set `replyTo` to it — but the editor dock mounted only when the id was the
 *     FOCUSED message's (the shared Reader), so Reply on any other panel of a conversation set
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
/*
 * SORTED BY THE OLDER TESTS' CHECKLIST (share write-1), EXPECTATIONS UNTOUCHED: today's `AppShell`, `MessagePane` and
 * its chrome are mounted by no host. Every case mounts the shell there is (the frame over the mail ground,
 * `_mail-shell.tsx`) and reads it by role and name: the open letter is the region "Open message", each letter of it
 * an `article` with its own menu (the button "Message", its items `menuitem`), the panel the toolbar "Actions";
 * Write's reply stands in the open letter as the sheet "Reply to <name>", its forward as the sheet "Forward" (its
 * lines the comboboxes "To", "Cc", "Bcc", a person the press "Remove <address>", its note the textbox "Forward
 * body", its sentence of what is added the status there). While a reply or forward stands its verbs (Send, Discard)
 * stand in the panel in place of the letter's (Write's ruled panel), so a case that pressed the bar's Forward over an
 * open reply presses the letter's own menu's Forward. The sibling's half mounts a two-letter conversation over an
 * engine of its own (the fixture world still holds none). What the app says is read by role, wherever it is said.
 * The drafter's half left with today's pane: Write's forward draws no drafter (`write/reply.test.tsx`, "a forward
 * offers no draft").
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom has no matchMedia; the shell asks it for the split pane. */
function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
  // The frame's report leaves through `animate`; jsdom has none. Nothing here asks where a scroll lands.
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  Element.prototype.scrollIntoView ??= () => {};
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
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);

const waitUntil = async (cond: () => boolean): Promise<boolean> => {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (cond()) return true;
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  }
  return cond();
};

const settleClosed = async (): Promise<void> => {
  await settle();
  const { SENT_BEAT_MS } = await import("@ohmail/app-logic/writing/mail-send");
  await act(async () => { await new Promise((r) => { setTimeout(r, SENT_BEAT_MS + 80); }); });
  await settle();
};

const OPEN = '[role="region"][aria-label="Open message"]';
/** The reply or forward standing in the open letter: Write's sheet, by its name. */
const sheet = (): HTMLElement | null =>
  host!.querySelector<HTMLElement>(`${OPEN} section[aria-label="Forward"], ${OPEN} section[aria-label^="Reply to "]`);
/** The forward, by its name. */
const forwardSheet = (): HTMLElement | null => host!.querySelector<HTMLElement>(`${OPEN} section[aria-label="Forward"]`);
/** The letter the standing reply or forward answers: the open conversation's last letter (the sheet stands after it). */
const dockFor = (): string | undefined =>
  sheet() === null ? undefined
    : [...host!.querySelectorAll<HTMLElement>(`${OPEN} [data-conv-id]`)].at(-1)?.getAttribute("data-conv-id") ?? undefined;
/** A verb of the open letter's panel, by its name. */
const panelVerb = (name: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>(`${OPEN} [role="toolbar"][aria-label="Actions"] button`)]
    .find((b) => b.getAttribute("aria-label") === name || buttonLabel(b) === name);
/** What the app says, wherever it says it (today's toast among them): every status and alert. */
const said = (): string =>
  [...document.querySelectorAll('[role="status"], [role="alert"]')].map((n) => n.textContent ?? "").join(" | ");

/** A letter's own menu (today's ⋯): its button "Message", then the item by its words. */
async function pressMenuItem(panel: HTMLElement, label: string): Promise<void> {
  const more = panel.querySelector<HTMLElement>('button[aria-label="Message"]');
  expect(more, "the panel's ⋯ trigger").toBeTruthy();
  await act(async () => { more!.click(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((b) => b.textContent?.trim() === label);
  expect(item, `a ⋯ item reading "${label}"`).toBeTruthy();
  await act(async () => { item!.click(); });
  await settle();
  await settleEditor();
}

/** A person typed into a line of the forward (a comma ends a person, as the browser's own typing does). */
async function typeTo(s: HTMLElement, text: string): Promise<void> {
  const toInput = s.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(toInput, text);
    toInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
});

/* ══ HALF ONE: the sibling's Reply mounts the dock — a two-letter conversation ══════════════ */

interface Seed { id: string; date: string }
function seedMsg(s: Seed): Record<string, unknown> {
  return {
    id: s.id, accountId: "a", mailboxId: "mb1", threadId: "T", messageIdHeader: null,
    subject: `subj-${s.id}`, from: { name: `Sender ${s.id}`, address: `${s.id}@example.invalid` },
    to: [], cc: [], date: s.date, folder: "INBOX", snippet: `snippet-${s.id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: s.date,
  };
}

/** The open conversation's letter `id`: its own `article`, inside its wrapper (`data-conv-id`, the reader's name). */
const letterPanel = (id: string): HTMLElement | null =>
  host!.querySelector<HTMLElement>(`${OPEN} [data-conv-id="${id}"] article`);

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
    await mountEngineShell({ messages: [older, newer] as never, open: "t-new" });

    const sibling = letterPanel("t-old");
    expect(sibling, "the older message's panel").toBeTruthy();
    await pressMenuItem(sibling!, "Reply");

    // The reply answers the sibling: Write's sheet is named for whom it answers.
    const dock = sheet();
    expect(dock, "the editor, mounted — Reply on a sibling used to set state nothing rendered").toBeTruthy();
    expect(dock!.getAttribute("aria-label"), "…bound to the SIBLING the menu was pressed on").toBe("Reply to Sender t-old");

    const send = panelVerb("Send");
    expect(send).toBeTruthy();
  });

  it("the focused panel's Reply still docks its own editor — the retarget did not steal it", async () => {
    const older = seedMsg({ id: "t-old", date: "2026-08-01T09:00:00.000Z" });
    const newer = seedMsg({ id: "t-new", date: "2026-08-02T08:00:00.000Z" });
    await mountEngineShell({ messages: [older, newer] as never, open: "t-new" });

    const focused = letterPanel("t-new")!;
    await pressMenuItem(focused, "Reply");
    expect(sheet()?.getAttribute("aria-label")).toBe("Reply to Sender t-new");
  });
});

/* ══ HALF TWO: forward is the reply's sibling, inside the reading surface — whole shell ═══ */

async function mountShell(): Promise<void> {
  await unmount();
  setViewport();
  window.location.hash = "#/ohbox";
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
        }),
      }),
    );
  });
  expect(await waitUntil(() => host!.querySelector('section[aria-label="Messages"] [role=option][data-id]') !== null), "the Ohbox's rows").toBe(true);
  // `j` opens the newest letter, the product's own act (the resting column says so).
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(await waitUntil(() => host!.querySelector(`${OPEN} article`) !== null), "the letter j opens").toBe(true);
}

/** The open message's panel in the split column — single message or conversation focus alike: its last letter. */
const openPanel = (): HTMLElement => {
  const p = [...host!.querySelectorAll<HTMLElement>(`${OPEN} article`)].at(-1) ?? null;
  expect(p, "an open message in the reading column").toBeTruthy();
  return p!;
};
/** The open letter, as the address and the column name it. */
const openLetter = (): string | undefined =>
  [...host!.querySelectorAll<HTMLElement>(`${OPEN} [data-conv-id]`)].at(-1)?.getAttribute("data-conv-id") ?? undefined;

describe("forward is the reply's sibling, inside the reading surface", () => {
  it("⋯ → Forward opens the inline dock in forward mode — no navigation, recipients open and empty, Send locked", async () => {
    await mountShell();
    await pressMenuItem(openPanel(), "Forward");

    // THE HEADLINE: the route never changed — forwarding no longer leaves the message.
    expect(window.location.hash, 'Forward used to go("compose")').not.toBe("#/compose");

    const dock = forwardSheet();
    expect(dock, "the inline dock, in forward mode").toBeTruthy();

    expect(dock!.querySelector('[role="textbox"][aria-label="Forward body"]')).not.toBeNull();
    expect(dock!.textContent).not.toContain("The original message is added when you send.");

    // Recipients are the user's to pick: the rows are OPEN at once — no derived audience.
    const toInput = dock!.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]');
    expect(toInput, "the To row, open at once").toBeTruthy();
    expect(toInput!.value).toBe("");
    expect([...dock!.querySelectorAll("button")].filter((b) => (b.getAttribute("aria-label") ?? "").startsWith("Remove ")).length,
      "…and EMPTY: no prefilled chips").toBe(0);

    // Cc/Bcc are OPEN AT ONCE (2026-08-27): the forward's recipients stack is the same
    // "change recipients" surface the reply opens, so a blind copy is one click away from the
    // start — no fold, no second affordance.
    expect([...dock!.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === "Cc Bcc") ?? null,
      "a Cc/Bcc toggle reappeared in the forward stack — the rows must open at once").toBeNull();
    const rowLabels = [...dock!.querySelectorAll('[role="group"]')].map((l) => l.getAttribute("aria-label"));
    expect(rowLabels, "the Cc row, open and empty").toContain("Cc");
    expect(rowLabels, "the Bcc row, open and empty").toContain("Bcc");

    // And Send is LOCKED until a recipient parses.
    const send = panelVerb("Send");
    expect(send, "the Send control").toBeTruthy();
    expect(send!.disabled, "Send must wait for a recipient — a forward derives none").toBe(true);
  });

  it("a recipient and a note unlock Send; the confirmed send closes the dock and never navigates", async () => {
    await mountShell();
    const before = openLetter();
    await pressMenuItem(openPanel(), "Forward");

    const dock = forwardSheet()!;
    await typeTo(dock, "colleague@example.net, ");
    expect(await waitUntil(() => dock.querySelector('[role="textbox"][aria-label="Forward body"]') !== null), "the dock's editor").toBe(true);
    const surface = dock.querySelector<HTMLElement>('[role="textbox"][aria-label="Forward body"]')!;
    await act(async () => { typeInto(surface as never, "please see below"); });
    await settle();

    const send = panelVerb("Send")!;
    expect(send.disabled, "a parsed recipient and a note are all a forward waits for").toBe(false);

    await act(async () => { send.click(); });
    await settleClosed();

    expect(sheet()).toBeNull();
    expect(window.location.hash).not.toBe("#/compose");
    const toast = said();
    expect(toast).toContain("Forwarded");
    expect(toast).not.toContain("Reply");
    const after = openLetter();
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

    const dock = forwardSheet()!;
    await typeTo(dock, "colleague@example.net, ");
    await settle();

    expect(
      (dock.querySelector<HTMLElement>('[role="textbox"][aria-label="Forward body"]')?.textContent ?? "").trim(),
      "the note field is not empty — this case is not testing what it claims",
    ).toBe("");

    const send = panelVerb("Send")!;
    expect(
      send.disabled,
      "Send is locked on a note-less forward — the forwarded message IS the message",
    ).toBe(false);

    await act(async () => { send.click(); });
    await settleClosed();
    expect(sheet()).toBeNull();
    expect(said()).toContain("Forwarded");
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
    const bar = host!.querySelector<HTMLElement>(`${OPEN} [role="toolbar"][aria-label="Actions"]`);
    expect(bar, "no action pill in the reading column").toBeTruthy();
    const fwd = [...bar!.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => (b.getAttribute("aria-label") ?? buttonLabel(b)).startsWith("Forward"));
    expect(fwd, "the pill carries no Forward — the ⋯ menu is its only door again").toBeTruthy();

    await act(async () => { fwd!.click(); });
    await settle();
    await settleEditor();

    expect(window.location.hash, "the pill's Forward navigated away").not.toBe("#/compose");
    const dock = sheet();
    expect(dock, "the pill's Forward opened no dock").toBeTruthy();
    expect(dock).toBe(forwardSheet());
  });

  /* ONE RESOLVER: the bar's Forward docks on the very message the bar's Reply docks on — both
     dispatch the pane's one `onAction`, bound to the OPENED message. One mount per row, so a slow
     host costs one case its time and never strands a shell under the next. (While the reply stands its verbs hold
     the panel, Write's ruled panel: Forward is the open letter's own menu's then.) */
  it.each([0, 1, 2, 3])("ONE RESOLVER, demo row %i: Forward docks where Reply docks", async (row) => {
    await mountShell();
    for (let k = 0; k < row; k++) {
      await act(async () => {
        (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
      });
      await settle();
    }
    const bar = () => host!.querySelector<HTMLElement>(`${OPEN} [role="toolbar"][aria-label="Actions"]`);
    expect(await waitUntil(() => bar() !== null), `row ${row}: no bar`).toBe(true);
    await act(async () => { panelVerb("Reply")!.click(); });
    await settleEditor();
    expect(await waitUntil(() => dockFor() !== undefined), `row ${row}: the bar's Reply opened no dock`).toBe(true);
    const replied = dockFor();
    await pressMenuItem(openPanel(), "Forward");
    expect(await waitUntil(() => forwardSheet() !== null)).toBe(true);
    expect(dockFor(), `row ${row}: Forward and Reply act on different messages`).toBe(replied);
  });

  it("Reply pressed over the forward dock SWITCHES to the reply — the mode is the editor's identity", async () => {
    // A review finding: `toggleReply`'s identity check ignored the mode, so `r` over the
    // forward dock closed it instead of replacing it with the reply it asked for.
    await mountShell();
    await pressMenuItem(openPanel(), "Forward");
    expect(forwardSheet(), "forward mode up").not.toBeNull();

    const reading = host!.querySelector<HTMLElement>(`${OPEN} [data-reading-scroll]`)!;
    expect(reading).toBeTruthy();
    await act(async () => {
      reading.focus();
      expect(document.activeElement).toBe(reading);
      reading.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
    });
    await settle();
    await settleEditor();
    const dock = sheet();
    expect(dock, "the dock survived the switch").toBeTruthy();
    expect(forwardSheet()).toBeNull();
  });

  it("a LATE forward confirmation never closes the reply opened after it", async () => {
    // A review finding: the fwd: settle closed whatever editor held the same message id,
    // mode-blind — a delayed confirmation took down an unrelated reply.
    const { FixturesAdapter } = await import("@ohmail/testing/adapter");
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
    const dock = forwardSheet()!;
    await typeTo(dock, "colleague@example.net, ");
    expect(await waitUntil(() => dock.querySelector('[role="textbox"][aria-label="Forward body"]') !== null), "the dock's editor").toBe(true);
    await act(async () => { typeInto(dock.querySelector<HTMLElement>('[role="textbox"][aria-label="Forward body"]') as never, "note"); });
    await settle();
    const send = panelVerb("Send")!;
    await act(async () => { send.click(); });
    await settle();
    expect(release, "the forward is in flight").toBeTruthy();

    // The user changes their mind mid-flight: close the forward, open a REPLY on the message.
    // (Today's Cancel is the forward's leave key in its text, Write's verbs being held while it goes.)
    const text = dock.querySelector<HTMLElement>('[role="textbox"][aria-label="Forward body"]');
    if (text) await act(async () => { text.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    await pressMenuItem(openPanel(), "Reply");
    expect(sheet(), "the reply is up").toBeTruthy();
    expect(forwardSheet()).toBeNull();

    // The forward's confirmation lands LATE — the reply must stand.
    await act(async () => { release!(undefined); });
    await settle();
    const after = sheet();
    expect(after, "a late forward settlement closed an unrelated reply").toBeTruthy();
    expect(forwardSheet()).toBeNull();
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
  // The fixture made whole for the reader that draws it now (its tags and its kind, which today's pane did not read).
  labels: [], snippet: "Plans", messageIdHeader: null, triage: null, remoteContent: "none",
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
} as unknown as EngineMessage;

type Part = { id: string; filename: string | null; contentType: string; sizeBytes: number; inline: boolean };
/** The parts the forward's case listed, by the name each tile carries. */
let fwdParts: Part[] = [];

/**
 * THE SHELL OVER AN ENGINE OF ITS OWN: these letters (or the forward's `m1`), an attachment list, a server that says
 * whether it honours a forward's kept list. The letter is opened at the Ohbox (History, where today's case opened it,
 * is not mounted; the claim is the forward's), by its row. `open` names the row (a conversation's newest letter).
 */
async function mountEngineShell(o: {
  messages?: EngineMessage[]; open?: string; supported?: boolean | null; parts?: Part[];
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
  const letters = o.messages ?? [fwdMsg];
  for (const m of letters) {
    await s.applyChanges([
      { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
      { type: "rule", op: "create", id: `r-${m.id}`, seq: ++seq, updatedAt: m.updatedAt, entity: {
        id: `r-${m.id}`, kind: "sender", match: m.from.address, destination: "INBOX", enabled: true,
        createdAt: "2026-09-01T00:00:00.000Z",
      } },
    ] as SyncChange[]);
  }
  const parts = o.parts ?? [
    { id: PART_A, filename: "plan.pdf", contentType: "application/pdf", sizeBytes: 1000, inline: false },
    { id: PART_B, filename: "logo.png", contentType: "image/png", sizeBytes: 200, inline: true },
    { id: PART_C, filename: "budget.xlsx", contentType: "application/octet-stream", sizeBytes: 3000, inline: false },
  ];
  fwdParts = parts;
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
      forwardPartsAnnounced: async () => o.supported ?? null,
    },
  } as never);
  const { MailShell: AppShell } = await import("./_mail-shell.js");
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
  const open = o.open ?? "m1";
  const rowOf = (): HTMLElement | null =>
    host!.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id="${open}"]`);
  expect(await waitUntil(() => rowOf() !== null), `${open} in the Ohbox`).toBe(true);
  const row = rowOf()!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
  expect(await waitUntil(() => host!.querySelector(`${OPEN} article`) !== null), `${open} opened`).toBe(true);
}

async function mountForwardShell(o: { supported: boolean | null; parts?: Part[] }): Promise<void> {
  await mountEngineShell(o);
  await pressMenuItem(openPanel(), "Forward");
  await typeTo(fwdDock(), "colleague@example.net, ");
  await settle();
}

const fwdDock = (): HTMLElement => forwardSheet()!;
/**
 * The forwarded files the forward lists, as their ids: each tile's name (the kit draws a file tile with no role; its
 * title is the name Write gives it: the filename, "<filename> (embedded)" for an inline part) read back to its part.
 */
const listedParts = (): string[] =>
  [...fwdDock().querySelectorAll<HTMLElement>(".oh-file .oh-file-title")]
    .map((b) => (b.textContent ?? "").trim())
    .map((name) => fwdParts.find((p) => (p.inline ? `${p.filename} (embedded)` : (p.filename ?? "")) === name)?.id ?? `?${name}`);
/** Each listed file's way off, in the list's order: its press "Remove <filename>". */
const removeButtons = (): HTMLButtonElement[] =>
  [...fwdDock().querySelectorAll<HTMLButtonElement>("button")]
    .filter((b) => fwdParts.some((p) => p.filename !== null && b.getAttribute("aria-label") === `Remove ${p.filename}`));
/** Why a press was refused over the forwarded files (today's `.forward-files-refusal`): the forward's other status line. */
const refusalLine = (): string =>
  [...fwdDock().querySelectorAll<HTMLElement>('[role="status"]')].map((n) => (n.textContent ?? "").trim())
    .find((text) => text !== "") ?? "";
const fwdSend = async (): Promise<Extract<EngineMutation, { kind: "mail_send" }> | undefined> => {
  const send = panelVerb("Send")!;
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
    expect(fwdDock().textContent).not.toContain("All of them go with it.");
    const sent = await fwdSend();
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("forwardParts");
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
    expect(refusalLine()).toMatch(/^The forwarded files are over .+\. Remove some to send it\.$/);
  });

  it("files over what the mailbox takes are refused in words, and nothing is sent", async () => {
    await mountForwardShell({ supported: true, parts: [
      { id: PART_A, filename: "big.mov", contentType: "video/quicktime", sizeBytes: 19 * 1024 * 1024, inline: false },
    ] });
    expect(await waitUntil(() => listedParts().length === 1)).toBe(true);
    expect(await fwdSend()).toBeUndefined();
    expect(refusalLine()).toMatch(/your mail server takes\. Remove some files to send it\.$/);
  });
});
