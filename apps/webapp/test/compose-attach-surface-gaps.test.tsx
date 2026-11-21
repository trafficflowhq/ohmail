/** @vitest-environment jsdom */
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/react";
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
    const input = host!.querySelector<HTMLInputElement>(`${scope} input[type="file"]`)!;
    const file = new File([new Uint8Array(512)], "shot.png", { type: "image/png" });
    Object.defineProperty(input!, "files", { value: [file], configurable: true });
    await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
    await screen.findByText("shot.png");
  };
  const previewButton = (): HTMLButtonElement => {
    const preview = screen.queryByRole<HTMLButtonElement>("button", { name: /preview.*shot\.png|^shot\.png$/i });
    expect(preview, "the attached picture has no preview control").not.toBeNull();
    return preview!;
  };
  const editorIn = () => host!.querySelector<HTMLElement>('.oh-composer [contenteditable="true"], .oh-composer textarea')!;
  const fileButton = () => within(host!).queryByRole("button", { name: "Preview shot.png" });
  const hasFile = () => within(host!).queryByRole("button", { name: "Remove shot.png" });
  const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"][aria-label="Attachment preview"]');
  /** A key pressed where focus is, as a person presses it. */
  const press = async (k: string, mods: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
    });
  };

  for (const [where, scope, open] of [
    ["the compose", ".oh-composer", goCompose],
    ["a reply", ".oh-composer", openReply],
  ] as const) {
    it(`in ${where}: the row shows the picture, opens the preview, and Escape closes only the preview`, async () => {
      await mountShell({ size: 25 * MIB });
      await open();
      await attachPng(scope);
      const look = fileButton()!;
      expect(look?.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
      await act(async () => { look.click(); });
      expect(dialog(), "pressing the row opened no preview").not.toBeNull();
      expect(within(dialog()!).getByRole("img", { name: "shot.png" })?.getAttribute("src")).toMatch(/^blob:/);
      await press("Escape");
      expect(dialog()).toBeNull();
      expect(host!.querySelector(scope), "Escape closed the editor with the preview").not.toBeNull();
      expect(hasFile()).not.toBeNull();
    });
  }

  it("the send chord pressed under the preview sends nothing", async () => {
    const chord = async (target: Element, mod: "metaKey" | "ctrlKey") => {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, [mod]: true }));
      });
    };
    const flushSend = async () => {
      for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    for (const where of ["reply", "compose"] as const) {
      await mountShell({ size: 25 * MIB });
      if (where === "reply") {
        await openReply();
      } else {
        await goCompose();
        const to = within(host!).getByRole("combobox", { name: "To" });
        await act(async () => {
          fireEvent.change(to, { target: { value: "reader@example.invalid" } });
          fireEvent.keyDown(to, { key: "Enter" });
        });
      }
      await attachPng(".oh-composer");
      const editor = editorIn();
      expect(editor, where).toBeTruthy();
      await act(async () => { editor.focus(); fileButton()!.click(); });
      expect(dialog(), where).not.toBeNull();
      await press("Enter", { metaKey: true });
      await press("Enter", { ctrlKey: true });
      await act(async () => { editor.focus(); });
      await chord(editor, "metaKey");
      await chord(editor, "ctrlKey");
      await flushSend();
      expect(host!.textContent, where).not.toMatch(/Sent to /);
      expect(dialog(), where).not.toBeNull();
      expect(hasFile(), where).not.toBeNull();
      expect(editor.closest("[inert]"), where).not.toBeNull();
      // An inert element can still receive synthetic events in this harness.
      await act(async () => {
        dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(dialog(), where).toBeNull();
      expect(editor.closest("[inert]"), where).toBeNull();
      expect(document.activeElement, where).toBe(editor);
      await chord(editor, "metaKey");
      await chord(editor, "ctrlKey");
      await flushSend();
      expect(host!.textContent, where).toContain(where === "reply" ? "Sent to Giulia Ferrari" : "Sent to ");
      expect(host!.querySelector(".oh-composer"), where).toBeNull();
    }
  });

  it("in a compose letter: the chord pressed in its text under the preview sends nothing, and sends once after it closes", async () => {
    const chord = async (target: Element, mod: "metaKey" | "ctrlKey") => {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, [mod]: true }));
      });
    };
    const flushSend = async () => {
      for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    const sentCount = () => (host!.textContent.match(/Sent to /g) ?? []).length;
    await mountShell({ size: 25 * MIB });
    await goCompose();
    const to = within(host!).getByRole("combobox", { name: "To" });
    await act(async () => {
      fireEvent.change(to, { target: { value: "reader@example.invalid" } });
      fireEvent.keyDown(to, { key: "Enter" });
    });
    const compose = within(host!);
    const letter = compose.getByRole("region", { name: "New message" });
    const editor = within(letter).getByRole("textbox", { name: "Message" });
    const attach = within(letter).getByRole("button", { name: /^Attach · .+ a message$/ });
    const file = new File([new Uint8Array(512)], "shot.png", { type: "image/png" });
    await act(async () => {
      fireEvent.drop(attach, { dataTransfer: { types: ["Files"], files: [file] } });
    });
    const preview = await within(letter).findByRole("button", { name: "Preview shot.png" });
    const previewDialog = () => screen.queryByRole("dialog", { name: "Attachment preview" });
    await act(async () => { editor.focus(); preview.click(); });
    expect(previewDialog(), "the attachment row opened no preview").not.toBeNull();
    await chord(editor, "metaKey");
    await chord(editor, "ctrlKey");
    await flushSend();
    expect(sentCount(), "the chord sent while the preview stood over the letter").toBe(0);
    expect(previewDialog(), "the preview closed on its own").not.toBeNull();
    expect(hasFile(), "the attached file was thrown away").not.toBeNull();
    expect(letter.hasAttribute("inert"), "the letter was not inert under the preview").toBe(true);
    // An inert element can still receive synthetic events in this harness.
    await act(async () => {
      previewDialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(previewDialog(), "Escape did not close the preview").toBeNull();
    expect(letter.hasAttribute("inert"), "the letter stayed inert after the preview closed").toBe(false);
    await chord(editor, "metaKey");
    await chord(editor, "ctrlKey");
    await flushSend();
    expect(sentCount(), "the chord did not send once the preview had closed").toBe(1);
    expect(compose.queryByRole("region", { name: "New message" }), "the letter stayed open after sending").toBeNull();
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
      await attachPng(".oh-composer");
      for (let i = 0; i < 400 && !editorIn(); i += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      }
      const editor = editorIn();
      await act(async () => { editor.focus(); });
      await press("e");
      expect(host!.querySelector(".oh-composer"), "the control: 'e' typed in the editor closed the reply").not.toBeNull();
      await mousePress(fileButton()!);
      expect(dialog()).not.toBeNull();
      await press("Escape");
      expect(dialog()).toBeNull();
      expect(document.activeElement, "the cursor did not come back to the editor").toBe(editor);
      await press("e");
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(host!.querySelector(".oh-composer"), "'e' parked the message being answered").not.toBeNull();
      expect(hasFile(), "the attached file was thrown away").not.toBeNull();
      const toasts = [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? "").join(" ");
      expect(toasts, "a parked toast came up").not.toContain("Parked");
    });

    it("in a reply whose subject is being edited: thumbnail, Escape, then a typed 'e' goes into the reply", async () => {
      await mountShell({ size: 25 * MIB });
      await openReply();
      await attachPng(".oh-composer");
      for (let i = 0; i < 400 && !editorIn(); i += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      }
      const editor = editorIn();
      // The reply opens with the cursor in its text: the editor focuses itself a frame after it mounts.
      for (let i = 0; i < 100 && document.activeElement !== editor; i += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      }
      const subject = within(host!).getByRole("textbox", { name: "Subject" });
      await act(async () => { subject.focus(); });
      expect(document.activeElement, "the subject did not open for editing").toBe(subject);
      await mousePress(fileButton()!);
      expect(dialog()).not.toBeNull();
      // The subject closes once focus has left it, a check made a tick after the blur.
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(document.activeElement, "the subject kept focus under the preview").not.toBe(subject);
      await press("Escape");
      expect(dialog()).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(editor));
      await press("e");
      for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(host!.querySelector(".oh-composer"), "'e' parked the message being answered").not.toBeNull();
      expect(hasFile(), "the attached file was thrown away").not.toBeNull();
      const toasts = [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? "").join(" ");
      expect(toasts, "a parked toast came up").not.toContain("Parked");
      expect(document.activeElement, "the 'e' did not go into the reply's text").toBe(editor);
    });

    it("a preview opened from the keyboard still returns focus to the row", async () => {
      await mountShell({ size: 25 * MIB });
      await openReply();
      await attachPng(".oh-composer");
      const look = fileButton()!;
      await act(async () => { look.focus(); look.click(); });
      expect(dialog()).not.toBeNull();
      await press("Escape");
      expect(document.activeElement).toBe(look);
      await act(async () => { look.click(); });
      await press(" ");
      expect(dialog(), "Space must close Quick Look from its initial focus").toBeNull();
      expect(document.activeElement).toBe(look);
    });
  });
});
