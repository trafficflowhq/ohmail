/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NONE } from "@ohmail/app/host";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { composeSessionId, readComposeDraft, writeComposeDraft } from "@ohmail/app-logic/writing/compose";
import { SUPPORT_ADDRESS } from "@trafficflow/core/diagnostics";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeMail } from "../../../packages/app/test/reader/support/fake-mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { WEB_MAIL_PARTS } from "../app/(product)/mailbox/mail-parts";
import { MailFrame, useBrowserMail } from "../app/shell/browser-mail";
import de from "../messages/de.json";
import en from "../messages/en.json";
import { mailbox } from "./fixtures/live-walk-shell";

const ACCOUNT = "3f2a9c1e-0b7d-4e55-9a10-2c3d4e5f6a7b";
const VERSION = "0.30.3";
const BUILD = "0123456789abcdef0123456789abcdef01234567";
const MAILBOX = mailbox({
  id: "mb-1",
  address: ["ana", "gmail.com"].join("@"),
  status: "error",
  errorCode: "timeout",
  errorDetail: "imap.gmail.com:993",
  authKind: "password",
});

type HelpHost = {
  readonly mail: ReturnType<typeof fakeMail>;
  readonly mailboxes: readonly MailboxFacts[];
  readonly composer: boolean;
};

function WebSettings({ mail, mailboxes, composer }: HelpHost) {
  const frame = useBrowserMail(NONE, WEB_MAIL_PARTS);
  const { host } = fakeHost({
    engine: mail.engine,
    service: "managed",
    scope: ACCOUNT,
    account: ACCOUNT,
    places: { ...frame.places, write: composer ? frame.places.write : NONE },
    above: frame.above,
    features: {
      about: { name: "about", render: () => null },
      help: { name: "help", render: () => null },
    },
    mailboxes: async () => [...mailboxes],
  });
  return (
    <MailFrame host={{
      ...host,
      device: {
        ...host.device,
        address: frame.address,
        build: { ...host.device.build, version: VERSION, commit: BUILD, mailtoLeaves: true },
      },
    }} />
  );
}

function mount({
  mailboxes = [MAILBOX],
  composer = true,
  locale = "en",
  pane = "help",
}: {
  mailboxes?: readonly MailboxFacts[];
  composer?: boolean;
  locale?: "en" | "de";
  pane?: "help" | "general" | "compose";
} = {}) {
  window.history.replaceState(null, "", pane === "compose" ? "#/compose" : `#/settings/${pane}`);
  const mail = fakeMail([]);
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de} timeZone="UTC">
      <ThemeProvider>
        <ToastHost>
          <WebSettings mail={mail} mailboxes={mailboxes} composer={composer} />
        </ToastHost>
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
  return mail;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected browser request from Help test"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

const menu = (messages: typeof en | typeof de) =>
  within(screen.getByRole("navigation", { name: messages.settings.navAria }));
const names = (messages: typeof en | typeof de) =>
  menu(messages).getAllByRole("button").map((button) => button.getAttribute("aria-label"));

function addressedMailto(link: HTMLElement): { target: string; subject: string | null; body: string | null } {
  const href = link.getAttribute("href");
  expect(href).toMatch(/^mailto:/);
  const url = new URL(href!);
  return { target: url.pathname, subject: url.searchParams.get("subject"), body: url.searchParams.get("body") };
}

describe("the Help & contact pane", () => {
  it("is a Settings pane right after About, and opens", async () => {
    const mail = mount({ pane: "general" });
    await screen.findByRole("navigation", { name: en.settings.navAria });
    expect(names(en).slice(-2)).toEqual(["About ohmail", "Help & contact"]);
    fireEvent.click(menu(en).getByRole("button", { name: "Help & contact" }));
    expect(await screen.findByRole("button", { name: "Write to us" })).toBeDefined();
    expect(window.location.hash).toBe("#/settings/help");
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Mailbox" }).textContent).toMatch(/gmail/i);
    expect(screen.getByRole("group", { name: "Last sync error" }).textContent).toContain("Timed out");
    expect(screen.getByRole("group", { name: "App" }).textContent).toContain("ohmail web");
    expect(screen.getByRole("group", { name: "Account" }).textContent).toContain(ACCOUNT);
    const actions = within(screen.getByRole("toolbar", { name: "Help & contact" }));
    expect(actions.getByRole("button", { name: "Write to us" })).toBeDefined();
    const reading = screen.getByRole("region", { name: "Help & contact" }).closest<HTMLElement>('[data-kind="reading"]')!;
    expect(within(reading).queryByText(MAILBOX.address)).toBeNull();
    expect(mail.mutations.filter((change) => change.kind === "mail_send")).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("is named in German", async () => {
    mount({ locale: "de", pane: "general" });
    await screen.findByRole("navigation", { name: de.settings.navAria });
    expect(names(de).slice(-2)).toEqual(["Über ohmail", "Hilfe & Kontakt"]);
  });

  it("renders Write to us and the version", async () => {
    mount();
    expect(await screen.findByRole("button", { name: "Write to us" })).toBeDefined();
    expect(within(screen.getByRole("group", { name: "Version" })).getByText("0.30.3 · build 012345678")).toBeDefined();
  });

  it("Write to us opens the composer: To support, the subject, and the block in the body", async () => {
    const mail = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Write to us" }));
    const letter = within(await screen.findByRole("region", { name: "New message" }));
    expect(letter.getByText(SUPPORT_ADDRESS)).toBeDefined();
    expect((letter.getByRole<HTMLInputElement>("textbox", { name: "Subject" })).value).toBe("Help with ohmail");
    const editor = letter.getByRole("textbox", { name: "Message" });
    const diagnostic = editor.textContent ?? "";
    const saved = readComposeDraft(ACCOUNT);
    const block = saved.body.trimStart();
    expect(saved.body).toBe(`\n\n${block}`);
    expect(block).toContain("Mailbox: gmail · Last sync error: timeout");
    expect(diagnostic).toContain("App: ohmail web 0.30.3 · build 012345678");
    expect(diagnostic).toContain(`Account: ${ACCOUNT}`);
    expect(diagnostic).toContain("Mailbox: gmail · Last sync error: timeout");
    for (const leak of ["ana@", "gmail.com", "imap.", "993"]) expect(diagnostic).not.toContain(leak);
    expect(mail.mutations.filter((change) => change.kind === "mail_send")).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("with no mailbox to send from, Write to us is a mailto: with the same subject and block", async () => {
    mount({ mailboxes: [] });
    expect(screen.queryByRole("button", { name: "Write to us" })).toBeNull();
    const fallback = addressedMailto(await screen.findByRole("link", { name: "Write to us" }));
    expect(fallback.target).toBe(SUPPORT_ADDRESS);
    expect(fallback.subject).toBe("Help with ohmail");
    expect(fallback.body).toContain("Mailbox: none");
    expect(fallback.body).toContain("Account: 3f2a9c1e");
  });

  it("where the door cannot send, the same mailto stands", async () => {
    mount({ composer: false });
    const fallback = addressedMailto(await screen.findByRole("link", { name: "Write to us" }));
    expect(fallback.target).toBe(SUPPORT_ADDRESS);
  });

  it("speaks German", async () => {
    mount({ locale: "de" });
    fireEvent.click(await screen.findByRole("button", { name: "Schreib uns" }));
    const letter = within(await screen.findByRole("region", { name: "Neue Nachricht" }));
    expect((letter.getByRole<HTMLInputElement>("textbox", { name: "Betreff" })).value).toBe("Hilfe zu ohmail");
    const diagnostic = letter.getByRole("textbox", { name: "Nachricht" }).textContent;
    expect(diagnostic).toContain("Postfach: gmail · Letzter Sync-Fehler: timeout");
    expect(diagnostic).toContain("0.30.3 · Build 012345678");
  });
});


async function openSupport(locale: "en" | "de" = "en") {
  mount({ locale });
  const messages = locale === "en" ? en : de;
  fireEvent.click(await screen.findByRole("button", { name: messages.help.write }));
  await screen.findByRole("region", { name: messages.write.letter });
  return readComposeDraft(ACCOUNT);
}

async function supportWithText(format = false) {
  const draft = await openSupport();
  const block = draft.diag!;
  expect(block).toContain(en.help.diag);
  cleanup();
  const html = format ? `<p><strong>It</strong> stopped.</p><p>${block.replace(/\n/g, "<br>")}</p>` : "";
  writeComposeDraft({ ...draft, body: `It stopped.\n\n${block}`, html }, ACCOUNT);
  const mail = mount({ pane: "compose" });
  const letter = within(await screen.findByRole("region", { name: en.write.letter }));
  return { block, mail, letter, session: composeSessionId(ACCOUNT) };
}

describe("the diagnostics block in the composer", () => {
  it("says what it holds, and Remove takes the block out of both halves in one press", async () => {
    const { letter, mail, session } = await supportWithText(true);
    const control = within(letter.getByRole("group", { name: en.help.diag }));
    expect(control.getByText(/It never holds addresses, hosts/)).toBeDefined();
    fireEvent.click(control.getByRole("button", { name: "Remove" }));

    const draft = readComposeDraft(ACCOUNT);
    expect({ text: draft.body, html: draft.html }).toEqual({
      text: "It stopped.",
      html: "<p><strong>It</strong> stopped.</p>",
    });
    expect(letter.getByRole("textbox", { name: en.write.text }).textContent).toBe("It stopped.");
    expect(composeSessionId(ACCOUNT)).toBe(session);
    expect(mail.mutations.filter((change) => change.kind === "mail_send")).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("once removed it offers Add back, which puts the block at the end again", async () => {
    const { block, letter, mail, session } = await supportWithText();
    const control = within(letter.getByRole("group", { name: en.help.diag }));
    fireEvent.click(control.getByRole("button", { name: "Remove" }));
    expect(control.getByText("Diagnostics removed.")).toBeDefined();
    fireEvent.click(control.getByRole("button", { name: "Add back" }));

    const draft = readComposeDraft(ACCOUNT);
    expect({ text: draft.body, html: draft.html }).toEqual({ text: `It stopped.\n\n${block}`, html: "" });
    expect(letter.getByRole("textbox", { name: en.write.text }).textContent).toContain(en.help.diag);
    expect(composeSessionId(ACCOUNT)).toBe(session);
    expect(mail.mutations.filter((change) => change.kind === "mail_send")).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("speaks German", async () => {
    await openSupport("de");
    const control = within(screen.getByRole("group", { name: de.help.diag }));
    expect(control.getByRole("button", { name: "Entfernen" })).toBeDefined();
    expect(control.getByText(/Er enthält nie Adressen/)).toBeDefined();
  });
});
