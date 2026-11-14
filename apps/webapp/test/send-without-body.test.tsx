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
 * A MESSAGE WITH AN ATTACHMENT SENDS WITHOUT TEXT; ONE WITH NEITHER SAYS WHAT IT NEEDS.
 * Reported from real use: sending just a screenshot required typing something first. The lock is
 * now "empty body AND no attachments" (`sendNeedsContent`) and the refusal is TOLD. Pinned on
 * both surfaces through the real shell: an attachment alone sends and the wire carries the file;
 * neither is refused IN WORDS on the press with nothing on the wire; the sentence leaves when
 * content arrives; the reply's judged mutation carries the wire's files (the half that used to
 * disagree). Mutation: restore `sendNeedsContent` to the body-only rule and the two
 * attachment-only cases go red; drop the press branch and the sentence case loses its words.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SENTENCE = "Write something or attach a file.";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(): Promise<void> {
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

async function mountCompose(): Promise<void> {
  await mountShell();
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  // ComposeView is a lazy chunk: microtask rounds alone left the file's FIRST compose mount on the
  // Suspense fallback (red alone, green inside a run that had transformed it). Cross the seam.
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
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

/** The foot's Send — by its own class, never by a label another button could share. */
const sendButton = (): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>(".compose-foot button")]
    .find((b) => (b.textContent ?? "").trim().startsWith("Send"))!;

/** A non-image pick, so the conversion completes on its own in jsdom — no held mock here. */
async function pickFile(input: HTMLInputElement, name: string, type = "text/plain"): Promise<void> {
  const file = new File([new Uint8Array(2048)], name, { type });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await drain(12);
}

const sends = () => sent.filter((m): m is Extract<EngineMutation, { kind: "mail_send" }> => m.kind === "mail_send");

beforeEach(() => {
  window.location.hash = "";
  sent = [];
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

describe("a message with an attachment sends without text", () => {
  it("compose: an attachment alone unlocks Send, and the wire carries the file with no body", async () => {
    await mountCompose();
    await typeTo("sam@example.com");

    // Nothing written, nothing attached — the reason is ON the button, not a silent lock.
    const before = sendButton();
    expect(before.disabled, "the empty compose's Send should be pressable, refused in words").toBe(false);
    expect(before.getAttribute("aria-disabled")).toBe("true");
    expect(before.title).toBe(SENTENCE);

    const input = q<HTMLInputElement>('.compose-attach input[type="file"]')!;
    await pickFile(input, "screenshot-notes.txt");

    const after = sendButton();
    expect(after.getAttribute("aria-disabled"), "the reason outlived the attachment").toBeNull();
    expect(after.disabled, "an attachment alone did not unlock Send").toBe(false);

    await act(async () => { after.click(); });
    await drain(10);
    const out = sends();
    expect(out, "the attachment-only press put no send on the wire").toHaveLength(1);
    expect((out[0]!.attachments ?? []).map((a) => a.filename)).toEqual(["screenshot-notes.txt"]);
    expect((out[0]!.body ?? "").trim()).toBe("");
  }, 20000);

  it("compose: neither text nor a file is refused IN WORDS on the press, and nothing leaves", async () => {
    await mountCompose();
    await typeTo("sam@example.com");

    await act(async () => { sendButton().click(); });
    await drain(4);
    expect(sends(), "an empty press reached the wire").toEqual([]);
    const note = [...host!.querySelectorAll<HTMLElement>('.send-row [role="status"]')]
      .find((n) => (n.textContent ?? "").includes(SENTENCE));
    expect(note, "the refused press earned no sentence").toBeTruthy();

    // The sentence leaves the moment content arrives.
    const input = q<HTMLInputElement>('.compose-attach input[type="file"]')!;
    await pickFile(input, "notes.txt");
    expect(host!.textContent, "the sentence outlived the attachment").not.toContain(SENTENCE);
  }, 20000);

  it("reply: an attachment and no words sends — the judged mutation carries the wire's files", async () => {
    await mountShell();
    // The product's own keys: land on a message, open its reply editor.
    await pressKey("j");
    await pressKey("r");
    await drain(6);
    // The demo's letter has a reply draft on the account, which Reply opens: emptied here.
    await act(async () => { typeInto(q<HTMLElement>(".read-col .msg .rte-surface")!, ""); });

    // Nothing typed: the reply's Send wears the reason, pressable, and the press says the sentence.
    const before = [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")][0]!;
    expect(before.getAttribute("aria-disabled"), "the wordless reply's Send carried no reason").toBe("true");
    expect(before.title).toBe(SENTENCE);
    await act(async () => { before.click(); });
    await drain(4);
    expect(sends(), "an empty reply press reached the wire").toEqual([]);
    expect(host!.textContent).toContain(SENTENCE);

    const input = q<HTMLInputElement>('.reply input[type="file"]')
      ?? q<HTMLInputElement>('.compose-attach input[type="file"]');
    expect(input, "the reply editor drew no attach control").not.toBeNull();
    await pickFile(input!, "receipt.pdf", "application/pdf");

    const send = [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")][0]!;
    expect(send.getAttribute("aria-disabled"), "the reason outlived the attachment").toBeNull();
    expect(send.disabled, "an attachment alone did not unlock the reply's Send").toBe(false);

    await act(async () => { send.click(); });
    await drain(10);
    const out = sends();
    expect(out, "the attachment-only reply put no send on the wire").toHaveLength(1);
    expect(out[0]!.inReplyTo, "the send lost the message it answers").not.toBeNull();
    expect((out[0]!.attachments ?? []).map((a) => a.filename)).toEqual(["receipt.pdf"]);
    expect((out[0]!.body ?? "").trim()).toBe("");
  }, 20000);
});
