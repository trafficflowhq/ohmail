/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import messages from "../messages/en.json";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { MailboxFacts } from "../app/shell/mail-state";

// The first mount pays the shell's cold import.
vi.setConfig({ testTimeout: 30_000 });

/**
 * THE EMPTY OHBOX WITH NO MAILBOX SAYS WHAT TO DO. "Nothing in your Ohbox." over an account that has
 * no mailbox is true and useless; the pane is a "Connect your mailbox" card instead, and its one verb
 * goes where this door connects one: the setup page on the web, Settings → Mailboxes in the desktop
 * window.
 */

const t = messages.ohbox;

const webDoor: FirstRunHost = {
  door: "cloud",
  ai: "on",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb-new" }),
  organize: async () => "stored",
  complete: async () => {},
  probeReason: () => null,
  probeMessage: () => null,
  setupHref: "/join",
  resume: () => {},
  oauthPending: () => false,
};

async function ohbox(facts: MailboxFacts[], firstRun?: FirstRunHost): Promise<HTMLElement> {
  const c = await mountShell(facts, firstRun ? { firstRun } : {});
  await tick(100);
  return c.querySelector<HTMLElement>(".view-ohbox") ?? c;
}

const card = (pane: HTMLElement) =>
  [...pane.querySelectorAll<HTMLElement>(".empty")].find((e) => (e.textContent ?? "").includes(t.connectTitle)) ?? null;

beforeEach(() => {
  installShellEnv();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(async () => { await teardownShellEnv(); });

describe("an Ohbox with no mailbox", () => {
  it("on the web, the card's verb opens the setup page", async () => {
    const pane = await ohbox([], webDoor);
    const c = card(pane);
    expect(c, "no connect card on an account with no mailbox").not.toBeNull();
    const go = c!.querySelector<HTMLAnchorElement>("a");
    expect(go?.getAttribute("href")).toBe("/join");
    expect(go?.textContent).toBe(t.connectAction);
    expect(pane.textContent).not.toContain(t.emptyPlain);
  });

  it("in the desktop window, the same verb opens Settings → Mailboxes", async () => {
    const pane = await ohbox([]);
    expect(card(pane)?.querySelector("a")?.getAttribute("href")).toBe("#/settings/mailboxes");
  });

  it("an account with a mailbox keeps the plain empty sentence", async () => {
    const pane = await ohbox([mailbox()], webDoor);
    expect(card(pane)).toBeNull();
    expect(pane.textContent).toContain(t.emptyPlain);
  });
});
