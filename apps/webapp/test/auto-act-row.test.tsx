/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const capabilities = vi.hoisted(() => ({ rulesMarked: true }));
vi.mock("../app/(product)/mailbox/host", async (importOriginal) => {
  const real = await importOriginal<typeof import("../app/(product)/mailbox/host")>();
  return {
    ...real,
    webHost(...args: Parameters<typeof real.webHost>) {
      const host = real.webHost(...args);
      return { ...host, capabilities: { ...host.capabilities, rulesMarked: capabilities.rulesMarked } };
    },
  };
});

const TITLE = "Act on confident suggestions for me";
const DESCRIPTION = "When a suggestion about a waiting sender is at least 90% sure that it is spam or one "
  + "to screen out, ohmail files that sender to Spam or Screened and writes the rule for you. It never lets "
  + "a sender in: a suggestion for the Ohbox, News or Receipts waits for you. Each such rule is marked as "
  + "ohmail's and you can undo it in Settings → Rules. Senders you have written to, and sensitive mail, are "
  + "never filed this way. If that suggestion is about a message whose sender was not confirmed — by your "
  + "mail provider, or by the signature the sender's own domain put on the message — or rests only on the "
  + "same subject from other first-time senders, ohmail files only that message, writes no rule, and lists "
  + "it under Filed automatically, where you can put it back. Off by default.";
/** Where the Rules pane reads a copy without the mark (the desktop's hosted door). */
const UNMARKED = DESCRIPTION.replace(
  "is marked as ohmail's and you can undo it in Settings → Rules.",
  "is listed in Settings → Rules, where you can undo it.",
);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(warmCloudShell);
beforeEach(() => {
  capabilities.rulesMarked = true;
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});
afterEach(teardownConfirmEnv);

async function mount({
  on = false, suggestOn = true, reader = false, refuse = false, locale = "en",
}: { on?: boolean; suggestOn?: boolean; reader?: boolean; refuse?: boolean; locale?: "en" | "de" } = {}) {
  const calls: unknown[] = [];
  let autoActAt = on ? ISO : null;
  const wire = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/consent") {
      return json({
        seedConfirmedAt: ISO, onboardingCompletedAt: ISO, dormancyDays: 60, screeningResetAt: null,
        autoSuggestAt: suggestOn ? ISO : null, autoActAt,
      });
    }
    if (path === "/api/consent/settings" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { autoAct: boolean };
      calls.push(body);
      if (refuse) return json({ error: { code: "forbidden", message: "The setting did not save." } }, 403);
      autoActAt = body.autoAct ? ISO : null;
      return json({ autoActAt });
    }
    if (path === "/api/account/screening") {
      return json({ ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "Mail from people" });
    }
    if (path === "/api/mailboxes") {
      return json({ items: [{
        id: "mb", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: reader ? "reader" : "organizer",
        organizedBy: reader ? { kind: "cloud", name: "Other installation", since: ISO } : null,
        initialImportCompletedAt: ISO, organizeConsentedAt: reader ? null : ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    return wire(input, init);
  };

  window.location.hash = "#/settings/screener";
  const messages = locale === "de" ? de : en;
  const host = await mountCloudShell((shell) => (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">{shell}</NextIntlClientProvider>
  ));
  await tick(3000);
  const pane = within(host).getByRole("region", { name: messages.settings.screener });
  const sw = () => within(pane).getByRole<HTMLButtonElement>("switch", { name: messages.screener.suggest.actTitle });
  return { pane, sw, calls };
}

async function press(button: HTMLElement): Promise<void> {
  await act(async () => { button.click(); });
  await tick(250);
}

describe("the act on suggestions' switch", () => {
  it("says what it agrees to, word for word, and writes on a press when suggestions are on", async () => {
    const { pane, sw, calls } = await mount();
    expect(pane.textContent).toContain(TITLE);
    expect(pane.textContent).toContain(DESCRIPTION);
    expect(en.screener.suggest.actDescription).toBe(DESCRIPTION);
    expect(pane.textContent, "no-AI wording within reach of the act").not.toMatch(/no AI/i);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().disabled).toBe(false);
    expect(within(pane).queryByText(en.screener.suggest.actNeedsSuggest)).toBeNull();
    expect(within(pane).queryByText(en.screener.suggest.actReader)).toBeNull();
    await press(sw());
    expect(calls).toEqual([{ autoAct: true }]);
  });

  it("claims the mark only where the Rules pane shows it", async () => {
    capabilities.rulesMarked = false;
    const { pane } = await mount();
    expect(pane.textContent).toContain(UNMARKED);
    expect(pane.textContent).not.toContain("marked as ohmail's");
    expect(en.screener.suggest.actDescriptionUnmarked).toBe(UNMARKED);
  });

  it("shows the stored ON and writes OFF", async () => {
    const { sw, calls } = await mount({ on: true });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    await press(sw());
    expect(calls).toEqual([{ autoAct: false }]);
  });

  it("is disabled with 'Needs automatic suggestions' while those are off", async () => {
    const { pane, sw, calls } = await mount({ suggestOn: false });
    expect(sw().disabled).toBe(true);
    expect(within(pane).getByText("Needs automatic suggestions")).toBeTruthy();
    await press(sw());
    expect(calls).toEqual([]);
  });

  it("on a reader install it is disabled and sends the person to the organizer", async () => {
    const { pane, sw, calls } = await mount({ reader: true });
    expect(sw().disabled).toBe(true);
    expect(within(pane).getByText("Set this on the install that organizes your mail.")).toBeTruthy();
    await press(sw());
    expect(calls).toEqual([]);
  });

  it("a refused write says so and leaves the stored value", async () => {
    const { pane, sw, calls } = await mount({ refuse: true });
    await press(sw());
    expect(calls).toEqual([{ autoAct: true }]);
    expect(pane.textContent).toContain("That setting did not save. It is unchanged.");
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("renders in German from the German catalogue", async () => {
    const { pane } = await mount({ suggestOn: false, locale: "de" });
    expect(pane.textContent).toContain(de.screener.suggest.actTitle);
    expect(pane.textContent).toContain(de.screener.suggest.actDescription);
    expect(within(pane).getByText(de.screener.suggest.actNeedsSuggest)).toBeTruthy();
    expect(de.screener.suggest.actTitle).not.toBe(TITLE);
  });
});
