/** @vitest-environment jsdom */
/**
 * SETTINGS › HELP & CONTACT — the pane, the prefilled mail and its diagnostics block. Write to us
 * opens the person's own composer addressed to support with a subject and the block; with no
 * mailbox to send from it is a mailto: carrying the same two. The block names classes and an
 * opaque id, never an address or a host, and comes out of the message in one press.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { SettingsView } from "../app/views/SettingsView";
import { HelpContactPane, type SupportSeed } from "../app/shell/HelpContactPane";
import { SupportDiagnostics } from "../app/shell/SupportDiagnostics";
import { enableExternalLinks, interceptLinkClicks, setMailtoSink } from "../app/shell/open-external";
import type { MailboxFacts } from "../app/shell/mail-state";
import type { RichValue } from "../app/shell/rich-text";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = { surface: "web" as const, version: "0.30.3", commit: "0123456789abcdef0123456789abcdef01234567", accountId: "3f2a9c1e-0b7d-4e55-9a10-2c3d4e5f6a7b" };
// Assembled at run time: a provider-domain address is what the block must classify and never write.
const MAILBOX = {
  id: "mb-1", address: ["ana", "gmail.com"].join("@"), status: "error", errorCode: "timeout", errorDetail: "imap.gmail.com:993",
  createdAt: "2026-10-01T00:00:00.000Z", authKind: "password",
} as unknown as MailboxFacts;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(node: ReturnType<typeof h>, messages: AbstractIntlMessages = en, locale = "en"): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale, messages, timeZone: "UTC", children: node }));
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const button = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === label);

describe("the Help & contact pane", () => {
  const settings = (pane?: "help") => h(ThemeProvider, null, h(ToastHost, null, h(SettingsView, {
    notifications: null, tags: [], tagCounts: {},
    rules: { items: [], onRevoke: async () => ({ status: "confirmed" as const }), onRetarget: async () => ({ status: "confirmed" as const }), pastMail: () => null },
    aboutSection: h("p", null, "about"),
    helpSection: h("p", { className: "help-pane" }, "help"),
    ...(pane ? { initialPane: pane } : {}),
  })));
  const nav = (el: HTMLElement) => [...el.querySelectorAll(".set-nav button")].map((b) => b.textContent?.trim());

  it("is a Settings pane right after About, and opens", async () => {
    const el = await mount(settings("help"));
    expect(nav(el).slice(-2)).toEqual(["About ohmail", "Help & contact"]);
    expect(el.querySelector(".help-pane")).not.toBeNull();
  });

  it("is named in German", async () => {
    const el = await mount(settings(), de, "de");
    expect(nav(el).slice(-2)).toEqual(["Über ohmail", "Hilfe & Kontakt"]);
  });

  it("renders Write to us and the version", async () => {
    const el = await mount(h(HelpContactPane, { host: HOST, mailboxes: [MAILBOX], onWrite: () => {} }));
    expect(button(el, "Write to us")).toBeDefined();
    expect(el.textContent).toContain("0.30.3 · build 012345678");
  });

  it("Write to us opens the composer: To support, the subject, and the block in the body", async () => {
    const seen: SupportSeed[] = [];
    const el = await mount(h(HelpContactPane, { host: HOST, mailboxes: [MAILBOX], onWrite: (s: SupportSeed) => seen.push(s) }));
    await act(async () => { button(el, "Write to us")!.click(); });
    expect(seen).toHaveLength(1);
    const { to, subject, body, diag } = seen[0]!;
    expect(to).toBe("support@ohmail.app");
    expect(subject).toBe("Help with ohmail");
    expect(body).toBe(`\n\n${diag}`);
    expect(diag).toContain("App: ohmail web 0.30.3 · build 012345678");
    expect(diag).toContain(`Account: ${HOST.accountId}`);
    expect(diag).toContain("Mailbox: gmail · Last sync error: timeout");
    // The fixture account's address and host never reach the block.
    for (const leak of ["ana@", "gmail.com", "imap.", "993"]) expect(diag).not.toContain(leak);
  });

  it("with no mailbox to send from, Write to us is a mailto: with the same subject and block", async () => {
    const el = await mount(h(HelpContactPane, { host: HOST, mailboxes: [], onWrite: () => { throw new Error("no composer here"); } }));
    expect(button(el, "Write to us")).toBeUndefined();
    const link = [...el.querySelectorAll("a")].find((a) => a.textContent === "Write to us")!;
    const href = link.getAttribute("href")!;
    expect(href.startsWith("mailto:support@ohmail.app?subject=Help%20with%20ohmail&body=")).toBe(true);
    const body = decodeURIComponent(href.split("&body=")[1]!);
    expect(body).toContain("Mailbox: none");
    expect(body).toContain("Account: 3f2a9c1e");
  });

  it("where the door cannot send, the same mailto stands", async () => {
    const el = await mount(h(HelpContactPane, { host: HOST, mailboxes: [MAILBOX], onWrite: null }));
    expect([...el.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("mailto:support@ohmail.app"))).toBe(true);
  });

  it("on the desktop, with no mailbox to send from, nothing reaches the window's mailto seam: the address and block are copied", async () => {
    enableExternalLinks();
    const off = interceptLinkClicks(document, { trustSameOrigin: true });
    const sunk: string[] = [];
    setMailtoSink((raw) => sunk.push(raw));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      const desk = { ...HOST, surface: "desktop" as const, accountId: null, mailtoLeaves: false };
      const el = await mount(h(HelpContactPane, { host: desk, mailboxes: [], onWrite: () => { throw new Error("no sender"); } }));
      expect(el.querySelector('a[href^="mailto:"]')).toBeNull();
      expect(el.textContent).not.toContain("opens in your mail app");
      expect(el.textContent).toContain("support@ohmail.app");
      await act(async () => { for (const c of el.querySelectorAll("a, button")) (c as HTMLElement).click(); });
      expect(sunk).toEqual([]);
      expect(writeText).toHaveBeenCalledWith("support@ohmail.app");
      const block = writeText.mock.calls.map((c) => (c as unknown[])[0] as string).find((x) => x.includes("Mailbox: none"))!;
      expect(block).toContain("App: ohmail desktop 0.30.3");
      expect(button(el, "Copied")).toBeDefined();
    } finally {
      off();
      setMailtoSink(null);
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  // The strip's Write to us under a stuck copy lands here; the door is offline, so a send from here would wait.
  const DESK = { ...HOST, surface: "desktop" as const, mailtoLeaves: false };
  it("on the desktop, while this computer's copy refuses its own pull, the address and block are copied, never sent from here", async () => {
    const stuck = { ...MAILBOX, errorCode: "storage", errorDetail: "MIRROR_STORE_REFUSED" } as MailboxFacts;
    const el = await mount(h(HelpContactPane, { host: DESK, mailboxes: [stuck], onWrite: () => { throw new Error("waits offline"); } }));
    expect(button(el, "Write to us")).toBeUndefined();
    expect(button(el, "Copy address")).toBeDefined();
    expect(button(el, "Copy diagnostics")).toBeDefined();
    expect(el.textContent).toContain(en.help.writeWhyCopy);
  });

  it("CONTROL: a paired host's own store refusal leaves the composer", async () => {
    const host = { ...MAILBOX, errorCode: "storage", errorDetail: "MAILBOX_STORE_REFUSED" } as MailboxFacts;
    const el = await mount(h(HelpContactPane, { host: DESK, mailboxes: [host], onWrite: () => {} }));
    expect(button(el, "Write to us")).toBeDefined();
  });

  it("speaks German", async () => {
    const seen: SupportSeed[] = [];
    const el = await mount(h(HelpContactPane, { host: HOST, mailboxes: [MAILBOX], onWrite: (s: SupportSeed) => seen.push(s) }), de, "de");
    await act(async () => { button(el, "Schreib uns")!.click(); });
    expect(seen[0]!.subject).toBe("Hilfe zu ohmail");
    expect(seen[0]!.diag).toContain("Postfach: gmail · Letzter Sync-Fehler: timeout");
    expect(seen[0]!.diag).toContain("0.30.3 · Build 012345678");
  });
});

describe("the diagnostics block in the composer", () => {
  const BLOCK = "— Diagnostics (ohmail) —\nApp: ohmail web 0.30.3\nMailbox: gmail · Last sync error: none";

  it("says what it holds, and Remove takes the block out of both halves in one press", async () => {
    const seen: RichValue[] = [];
    const value = { text: `It stopped.\n\n${BLOCK}`, html: `<p><strong>It</strong> stopped.</p><p>${BLOCK.replace(/\n/g, "<br>")}</p>` };
    const el = await mount(h(SupportDiagnostics, { block: BLOCK, value, disabled: false, onChange: (v: RichValue) => seen.push(v) }));
    expect(el.textContent).toContain("It never holds addresses, hosts");
    await act(async () => { button(el, "Remove")!.click(); });
    expect(seen).toEqual([{ text: "It stopped.", html: "<p><strong>It</strong> stopped.</p>" }]);
  });

  it("once removed it offers Add back, which puts the block at the end again", async () => {
    const seen: RichValue[] = [];
    const el = await mount(h(SupportDiagnostics, { block: BLOCK, value: { text: "It stopped.", html: "" }, disabled: false, onChange: (v: RichValue) => seen.push(v) }));
    expect(el.textContent).toContain("Diagnostics removed.");
    await act(async () => { button(el, "Add back")!.click(); });
    expect(seen).toEqual([{ text: `It stopped.\n\n${BLOCK}`, html: "" }]);
  });

  it("speaks German", async () => {
    const el = await mount(h(SupportDiagnostics, { block: BLOCK, value: { text: BLOCK, html: "" }, disabled: false, onChange: () => {} }), de, "de");
    expect(button(el, "Entfernen")).toBeDefined();
    expect(el.textContent).toContain("Er enthält nie Adressen");
  });
});
