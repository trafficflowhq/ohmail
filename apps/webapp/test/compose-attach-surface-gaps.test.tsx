/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { setActiveCatalog } from "../app/shell/locale";
import { resetUpdateStoreForTests } from "@ohmail/app-logic/doors/app-update";
import { settleFirstPaint } from "./_first-paint.js";

/*
 * MOVED AS THEY STOOD (share write-1 of the older tests' sorting, 18 November): the cases of
 * `compose-attach-surface.test.tsx` that Write does not hold yet, each a GAP owned by the switch's Write step
 * (`tools/old-tests.tsv`): an attached picture shows itself on its tile and opens the preview, in the letter and in the
 * reply; Escape closes only the preview and gives the cursor back; the send chord pressed under it sends nothing. Write's
 * tiles (the kit's FileTile) offer no look at a file, so nothing here can be re-pointed to a part that does it. Word for
 * word as they stood, with their file's helpers, over the shell's test door (`_mail-shell.tsx`, the door the old name
 * `_todays-shell` already re-exported): red until Write builds the preview, when each is re-pointed here and its row
 * turns KEPT.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const MIB = 1024 * 1024;

/** One connected mailbox, as `GET /mailboxes` would report it, with `SIZE` variable per case. */
function facts(smtpMaxSizeBytes: number | null): MailboxFacts[] {
  return [
    {
      // The fixture world's own mailbox id, so a reply's inherited mailbox resolves without a
      // substitution notice — the ceiling under test is the resolved sender's either way.
      id: "lichtgrat",
      address: "mila@lichtgrat.example",
      status: "connected",
      errorCode: null,
      disabledReason: null,
      syncBlockedReason: null,
      syncBlockedSince: null,
      lastSyncAt: "2026-08-10T09:00:00.000Z",
      initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
      createdAt: "2026-08-01T08:00:00.000Z",
      smtpMaxSizeBytes,
    },
  ];
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false,
      media: query, onchange: null,
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
}

/**
 * The whole client on the fixture world, with the two host declarations under test.
 *
 * `sendSurfaceMaxTotalBytes` is passed with the desktop's own spread shape: ABSENT for the
 * hosted case rather than `undefined`, because absent is what a browser tab actually passes.
 */
async function mountShell(opts: {
  size: number | null;
  surface?: number | null;
  locale?: "en" | "de";
}): Promise<void> {
  await unmount();
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const probe = async (): Promise<MailboxFacts[]> => facts(opts.size);
  // The register and the provider are built together, which is `LocaleShell`'s own contract: the
  // SENTENCE comes from the provider and the NUMBER in it from `activeFormatLocale()`.
  setActiveCatalog(opts.locale ?? "en", (opts.locale === "de" ? de : messages) as never);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: opts.locale ?? "en",
        messages: (opts.locale === "de" ? de : messages) as never,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, {
            children: h(MailShell as never, {
              demo: true,
              mailboxFacts: probe,
              ...("surface" in opts ? { sendSurfaceMaxTotalBytes: opts.surface } : {}),
            } as never),
          }),
        }),
      }),
    );
  });
  // The fixtures engine hydrates synchronously but still through a promise chain, and the
  // facts probe resolves one microtask later.
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

async function goCompose(): Promise<void> {
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

/** Open the newest Ohbox message, then its reply editor — the product's own keys. */
async function openReply(): Promise<void> {
  const key = async (k: string): Promise<void> => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
  };
  await key("j");
  await key("r");
}

beforeEach(() => {
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
});

afterEach(async () => {
  await unmount();
  setActiveCatalog("en", null);
  resetUpdateStoreForTests();
  vi.restoreAllMocks();
});

/**
 * ═══ AN ATTACHED FILE SHOWS ITSELF AND OPENS IN THE PREVIEW, IN BOTH PLACES IT CAN BE ATTACHED ══
 *
 * The preview stands over the whole app (a portal on the body), so Escape closes it and nothing
 * else, and the send chord pressed under it sends nothing.
 */
describe("an attached picture shows itself and opens in the preview", () => {
  beforeEach(() => {
    let n = 0;
    (URL as unknown as Record<string, unknown>).createObjectURL = () => `blob:http://localhost/look-${++n}`;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
  });
  afterEach(() => {
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  const attachPng = async (scope: string): Promise<void> => {
    const input = host!.querySelector<HTMLInputElement>(`${scope} .compose-attach input[type="file"]`)!;
    const file = new File([new Uint8Array(512)], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"][aria-label="Attachment preview"]');
  /** A key pressed where focus is, as a person presses it. */
  const press = async (k: string, mods: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
    });
  };

  for (const [where, scope, open] of [
    ["the compose", ".view-compose", goCompose],
    ["a reply", ".reply", openReply],
  ] as const) {
    it(`in ${where}: the row shows the picture, opens the preview, and Escape closes only the preview`, async () => {
      await mountShell({ size: 25 * MIB });
      await open();
      await attachPng(scope);
      const look = host!.querySelector<HTMLButtonElement>(`${scope} .compose-attach-look`)!;
      expect(look.querySelector("img.att-thumb")?.getAttribute("src")).toMatch(/^blob:/);
      await act(async () => { look.click(); });
      expect(dialog(), "pressing the row opened no preview").not.toBeNull();
      expect(dialog()!.querySelector("img.ap-img")?.getAttribute("src")).toMatch(/^blob:/);
      await press("Escape");
      expect(dialog()).toBeNull();
      expect(host!.querySelector(scope), "Escape closed the editor with the preview").not.toBeNull();
      expect(host!.querySelector(`${scope} .compose-attach-item`)).not.toBeNull();
    });
  }

  it("the send chord pressed under the preview sends nothing", async () => {
    await mountShell({ size: 25 * MIB });
    await openReply();
    await attachPng(".reply");
    await act(async () => { host!.querySelector<HTMLButtonElement>(".reply .compose-attach-look")!.click(); });
    expect(dialog()).not.toBeNull();
    await press("Enter", { metaKey: true });
    await press("Enter", { ctrlKey: true });
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host!.textContent).not.toContain("Sent to Giulia Ferrari");
    expect(host!.querySelector(".reply .compose-attach-item"), "the reply went while its file was being looked at").not.toBeNull();
    // The control: with the preview closed the same chord, pressed in the editor, does send.
    await press("Escape");
    await act(async () => { host!.querySelector<HTMLElement>(".reply .rte-surface")!.focus(); });
    await press("Enter", { metaKey: true });
    await press("Enter", { ctrlKey: true });
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host!.textContent).toContain("Sent to Giulia Ferrari");
    expect(host!.querySelector(".reply")).toBeNull();
  });

  describe("a preview opened by the mouse gives the cursor back to the editor", () => {
    // jsdom has no isContentEditable; a browser does, and the keymap reads it to tell typing apart.
    let had: PropertyDescriptor | undefined;
    beforeEach(() => {
      had = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable");
      Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
        configurable: true,
        get(this: HTMLElement) { return this.closest('[contenteditable="true"],[contenteditable=""]') !== null; },
      });
    });
    afterEach(() => {
      if (had) Object.defineProperty(HTMLElement.prototype, "isContentEditable", had);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).isContentEditable;
    });
    /** A mouse press as Chrome does it: mousedown focuses the button unless prevented, then click. */
    const mousePress = async (el: HTMLElement): Promise<void> => {
      await act(async () => {
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        if (el.dispatchEvent(down)) el.focus();
        el.click();
      });
    };

    it("in a reply: thumbnail, Escape, then a typed 'e' parks nothing and keeps the file", async () => {
      await mountShell({ size: 25 * MIB });
      await openReply();
      await attachPng(".reply");
      for (let i = 0; i < 400 && !host!.querySelector(".reply .rte-surface"); i += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      }
      const editor = host!.querySelector<HTMLElement>(".reply .rte-surface")!;
      await act(async () => { editor.focus(); });
      await press("e");
      expect(host!.querySelector(".reply"), "the control: 'e' typed in the editor closed the reply").not.toBeNull();
      await mousePress(host!.querySelector<HTMLElement>(".reply .compose-attach-look")!);
      expect(dialog()).not.toBeNull();
      await press("Escape");
      expect(dialog()).toBeNull();
      expect(document.activeElement, "the cursor did not come back to the editor").toBe(editor);
      await press("e");
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(host!.querySelector(".reply"), "'e' parked the message being answered").not.toBeNull();
      expect(host!.querySelector(".reply .compose-attach-item"), "the attached file was thrown away").not.toBeNull();
      const toasts = [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? "").join(" ");
      expect(toasts, "a parked toast came up").not.toContain("Parked");
    });

    it("in a reply whose subject is being edited: thumbnail, Escape, then a typed 'e' goes into the reply", async () => {
      await mountShell({ size: 25 * MIB });
      await openReply();
      await attachPng(".reply");
      for (let i = 0; i < 400 && !host!.querySelector(".reply .rte-surface"); i += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      }
      const editor = host!.querySelector<HTMLElement>(".reply .rte-surface")!;
      // The reply opens with the cursor in its text: the editor focuses itself a frame after it mounts.
      for (let i = 0; i < 100 && document.activeElement !== editor; i += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      }
      await act(async () => { host!.querySelector<HTMLButtonElement>(".reply .reply-subject")!.click(); });
      const subject = host!.querySelector<HTMLInputElement>(".reply .reply-subject-input")!;
      expect(document.activeElement, "the subject did not open for editing").toBe(subject);
      await mousePress(host!.querySelector<HTMLElement>(".reply .compose-attach-look")!);
      expect(dialog()).not.toBeNull();
      // The subject closes once focus has left it, a check made a tick after the blur.
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(subject.isConnected, "the case: the subject stayed open under the preview").toBe(false);
      await press("Escape");
      expect(dialog()).toBeNull();
      await press("e");
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(host!.querySelector(".reply"), "'e' parked the message being answered").not.toBeNull();
      expect(host!.querySelector(".reply .compose-attach-item"), "the attached file was thrown away").not.toBeNull();
      const toasts = [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? "").join(" ");
      expect(toasts, "a parked toast came up").not.toContain("Parked");
      expect(document.activeElement, "the 'e' did not go into the reply's text").toBe(editor);
    });

    it("a preview opened from the keyboard still returns focus to the row", async () => {
      await mountShell({ size: 25 * MIB });
      await openReply();
      await attachPng(".reply");
      const look = host!.querySelector<HTMLButtonElement>(".reply .compose-attach-look")!;
      await act(async () => { look.focus(); look.click(); });
      expect(dialog()).not.toBeNull();
      await press("Escape");
      expect(document.activeElement).toBe(look);
    });
  });
});
