/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * ═══ SEND NEVER SNAPSHOTS A MESSAGE WITH AN ATTACHMENT PENDING ══════════════════════════════
 *
 * ── THE DEFECT (WV-R7-01) ───────────────────────────────────────────────────────────────────
 *
 * A pick decodes the file, re-encodes it at the chosen quality and commits the whole batch in ONE
 * `onChange` at the end. That conversion took no part in the compose's send lock, so between the
 * press that chose a file and the commit that admits it the form held a message WITHOUT the
 * attachment — and Send sent exactly that. The person watched a file appear a moment later on a
 * mail that had already gone without it.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 *  1. While a pick is converting, Send refuses and the form says which file it is waiting for.
 *  2. Nothing reaches the wire in that window — the snapshot is not taken at all, rather than
 *     taken without the file.
 *  3. The press after the conversion lands carries the attachment.
 *  4. An ordinary send — no attachment anywhere — is unchanged (the positive control).
 *  5. THE SURFACE BESIDE IT: the inline reply mounts the same control and holds the same lock. A
 *    fix that reached only the compose form would be half-applied by construction.
 *
 * No clock and no new timeout: the pick's own end releases the lock, so there is no deadline to
 * invent and no window in which the file could be dropped in silence.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Drop `|| attaching.length > 0` from `ComposeView`'s `sendBlocked` — which is the shape this
 * surface shipped with — and cases 1 and 2 go red: the press lands and `mail_send` reaches the
 * adapter carrying no attachments.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The conversion this test holds open — one release per pick. */
let releaseConversion: (() => void) | null = null;

vi.mock("../app/components/image-quality", async () => {
  const actual = await vi.importActual<typeof import("../app/components/image-quality")>(
    "../app/components/image-quality",
  );
  return {
    ...actual,
    /* HELD, not slow: the case is about the window between the pick and the commit, and a timer
       would make it a race. The shape of the answer is the real one — `compressImage` on a
       non-image answers the original file — so only its TIMING is the double's. */
    compressImage: async (file: Blob) => {
      await new Promise<void>((resolve) => { releaseConversion = resolve; });
      return actual.compressImage(file, "original");
    },
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountCompose(): Promise<void> {
  await unmount();
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
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

/** The same client, left in the Ohbox — the reply editor opens over a message there. */
async function mountShellOnly(): Promise<void> {
  await unmount();
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
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);

const pressKey = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

async function drain(n = 8): Promise<void> {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function typeTo(value: string): Promise<void> {
  const input = q<HTMLInputElement>("#compose-to")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The compose body — through the real editor handle, or the shell holds an empty document. */
async function typeBody(text: string): Promise<void> {
  const surface = await waitForSurface();
  await act(async () => { typeInto(surface, text); });
  await drain(4);
}

/** The reply editor's own surface, once ProseMirror has attached its handle. */
async function waitForReplySurface(): Promise<HTMLElement> {
  for (let i = 0; i < 40; i += 1) {
    const el = [...host!.querySelectorAll<HTMLElement>(".reply .rte-surface, .reply [contenteditable=true]")]
      .find((n) => (n as unknown as { editor?: unknown }).editor);
    if (el) return el;
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  throw new Error("the reply editor never mounted a ProseMirror handle");
}

async function waitForSurface(): Promise<HTMLElement> {
  for (let i = 0; i < 40; i += 1) {
    const el = q<HTMLElement>(".compose-editor .rte-surface")
      ?? q<HTMLElement>(".compose-editor [contenteditable=true]");
    if (el && (el as unknown as { editor?: unknown }).editor) return el;
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  throw new Error("the compose editor never mounted a ProseMirror handle");
}

/** The foot's Send — by its own class, never by a label another button could share. */
const sendButton = (): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>(".compose-foot button")]
    .find((b) => (b.textContent ?? "").trim().startsWith("Send"))!;

async function pickFile(name = "notes.txt"): Promise<void> {
  const input = q<HTMLInputElement>('.compose-attach input[type="file"]')!;
  const file = new File([new Uint8Array(2048)], name, { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await drain(4);
}

async function finishConversion(): Promise<void> {
  expect(releaseConversion, "nothing was converting").not.toBeNull();
  const release = releaseConversion!;
  releaseConversion = null;
  await act(async () => { release(); });
  await drain(10);
}

const sends = () => sent.filter((m): m is Extract<EngineMutation, { kind: "mail_send" }> => m.kind === "mail_send");

beforeEach(() => {
  window.location.hash = "";
  sent = [];
  releaseConversion = null;
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
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  vi.restoreAllMocks();
});

describe("a pending attachment holds the send", () => {
  it("refuses the press, names the file, and puts nothing on the wire", async () => {
    await mountCompose();
    await typeTo("sam@example.com");
    await typeBody("Notes are attached.");
    await pickFile("notes.txt");

    // THE PRESS FIRST, because the loss is the mail: with the join dropped this press puts a
    // `mail_send` on the wire carrying no attachments at all.
    await act(async () => { sendButton().click(); });
    await drain(4);
    expect(
      sends().map((m) => (m.attachments ?? []).length),
      "a message was sent while the file chosen for it was still converting",
    ).toEqual([]);

    // …and the conversion is still open, which the form says by name rather than by a dead button.
    expect(host!.textContent, "the form did not say which file it is waiting for")
      .toContain("Still attaching notes.txt.");
    expect(sendButton().disabled, "Send was offered over a message with a file still converting")
      .toBe(true);
  }, 20000);

  it("the press after it lands carries the attachment", async () => {
    await mountCompose();
    await typeTo("sam@example.com");
    await typeBody("Notes are attached.");
    await pickFile("notes.txt");
    await finishConversion();

    expect(host!.textContent).not.toContain("Still attaching");
    expect(sendButton().disabled, "Send stayed refused after the attachment landed").toBe(false);

    await act(async () => { sendButton().click(); });
    await drain(10);
    const out = sends();
    expect(out, "the press put no send on the wire").toHaveLength(1);
    expect(
      (out[0]!.attachments ?? []).map((a) => a.filename),
      "the sent message did not carry the file that was chosen for it",
    ).toEqual(["notes.txt"]);
  }, 20000);

  it("the reply surface holds the same lock — the path beside it", async () => {
    await mountShellOnly();
    // The product's own keys: land on a message, open its reply editor.
    await pressKey("j");
    await pressKey("r");
    await drain(6);

    /* A BODY FIRST, and Send asserted OPEN before the file is picked. Without this the reply is
       unsendable anyway (an empty body refuses it) and the case would pass over a lock that was
       never armed — a guard whose contrary state is unreachable measures nothing. */
    const surface = await waitForReplySurface();
    await act(async () => { typeInto(surface, "Receipt attached."); });
    await drain(4);
    const sendBefore = [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")][0];
    expect(sendBefore!.disabled, "the reply refused Send before any file was picked").toBe(false);

    const input = q<HTMLInputElement>('.reply input[type="file"]')
      ?? q<HTMLInputElement>('.compose-attach input[type="file"]');
    expect(input, "the reply editor drew no attach control").not.toBeNull();
    const file = new File([new Uint8Array(1024)], "receipt.pdf", { type: "application/pdf" });
    Object.defineProperty(input!, "files", { value: [file], configurable: true });
    await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
    await drain(4);

    expect(host!.textContent, "the reply did not say which file it is waiting for")
      .toContain("Still attaching receipt.pdf.");
    const send = [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")][0];
    expect(send, "the reply editor drew no Send").toBeTruthy();
    expect(send!.disabled, "the reply offered Send over a file still converting").toBe(true);
  }, 20000);

  it("an ordinary send with no attachment is unchanged (the positive control)", async () => {
    await mountCompose();
    await typeTo("sam@example.com");
    await typeBody("Nothing attached here.");
    expect(host!.textContent).not.toContain("Still attaching");
    expect(sendButton().disabled).toBe(false);
    await act(async () => { sendButton().click(); });
    await drain(10);
    expect(sends(), "an ordinary send was blocked").toHaveLength(1);
  }, 20000);
});
