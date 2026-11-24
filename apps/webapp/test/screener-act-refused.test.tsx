/** @vitest-environment jsdom */
import type { EngineMessage, ScreenerSuggestionEntity, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const REFUSED = "refused@example.invalid";
const PLAIN = "plain@example.invalid";
function held(id: string, from: string, hour: number): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}
function suggestion(id: string, messageId: string, sender: string, refused: boolean): ScreenerSuggestionEntity {
  return {
    id, messageId, senderKey: sender, decision: "no", destination: "ohmail/Quarantine", spam: true,
    confidence: 0.95, boughtAt: "2026-08-02T10:00:00.000Z", updatedAt: "2026-08-02T11:00:00.000Z",
    actRefusal: refused ? "store_fault" : null, actRefusedAt: refused ? "2026-08-02T11:00:00.000Z" : null,
  };
}


let host: HTMLElement;
beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
});
afterEach(teardownConfirmEnv);

async function mount(locale: "en" | "de" = "en") {
  const mail = [held("m0", REFUSED, 9), held("m1", PLAIN, 10)];
  const advice = [suggestion("sg-0", "m0", REFUSED, true), suggestion("sg-1", "m1", PLAIN, false)];
  const creates: SyncResponse["changes"]["creates"] = [
    ...mail.map((entity, i) => ({
      type: "message" as const, op: "create" as const, id: entity.id, seq: i + 1, updatedAt: ISO, entity,
    })),
    ...advice.map((entity, i) => ({
      type: "screener_suggestion" as const, op: "create" as const, id: entity.id,
      seq: mail.length + i + 1, updatedAt: ISO, entity,
    })),
  ];
  scriptSync(() => Response.json({
    changes: { creates, updates: [], moves: [], deletes: [] },
    cursor: String(creates.length), hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb_1", address: "mailbox@example.invalid", status: "connected", organizerRole: "organizer",
        initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (url.pathname.endsWith("/body")) return new Response(null, { status: 503 });
    return fixture(input, init);
  };
  window.location.hash = "#/screener";
  host = await mountCloudShell((shell) => (
    <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en} timeZone="UTC" now={new Date(ISO)}>
      {shell}
    </NextIntlClientProvider>
  ));
  await tick(3000);
}

async function open(address: string) {
  const row = within(host).getByRole("option", { name: (name) => name.includes(address) });
  await act(async () => { row.click(); });
  await tick(100);
}

const reading = () => within(within(host).getByRole("region", { name: /^(Reading|Lesen)$/ }));
function action() {
  const panel = within(reading().getByRole("toolbar"));
  expect(panel.getByRole("button", { name: "Spam" })).toBeTruthy();
  return "Spam";
}

describe("a refused act on the Screener row", () => {
  it("says ohmail tried and could not, and names the row's own Accept", async () => {
    await mount();
    await open(REFUSED);
    const name = action();
    expect(reading().getByText(`ohmail tried to file this sender for you and could not. ${name} files it now.`)).toBeTruthy();
  });

  it("CONTROL: a suggestion the act never tried says nothing of the kind", async () => {
    await mount();
    await open(PLAIN);
    expect(action()).toBe("Spam");
    expect(reading().queryByText(/^ohmail tried to file this sender/)).toBeNull();
  });

  it("says it in German with the German button's name", async () => {
    await mount("de");
    await open(REFUSED);
    const name = action();
    expect(reading().getByText(`ohmail wollte diesen Absender für dich ablegen und konnte es nicht. ${name} legt ihn jetzt ab.`)).toBeTruthy();
  });
});
