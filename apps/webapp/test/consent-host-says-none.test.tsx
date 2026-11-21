/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerStoreWith, answerSyncWith, installShellEnv, mailbox,
  mountShell as mountWithBrowserProviders, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { getByRole, queryAllByRole, within } from "@testing-library/react";
import { NONE, type HostContract } from "@ohmail/app/host";
import { screeningSettings } from "../app/api-client";
import { WEB_MAIL_PARTS } from "../app/(product)/mailbox/mail-parts";
import { MailFrame, useBrowserMail } from "../app/shell/browser-mail";
import { EngineProvider, useEngine } from "../app/shell/engine";
import { hostFromTodaysInputs } from "./_mail-shell";
import messages from "../messages/en.json";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";

/**
 * WHAT A HOST DID NOT OFFER IS NOT TAKEN FROM THE PAGE. The frame mounted by a host that says `none` for its
 * consent wire, on a page whose own client is configured and whose server holds an account row that lets pictures
 * load: no consent request leaves, Settings draws none of the row's controls, and a letter's pictures wait for its
 * press. And the review of who you write to stands where the host's own wire for it stands, and nowhere else.
 */

/** Whether this page has the browser's own client. One case below is a page that has none. */
const page = vi.hoisted(() => ({ hasClient: true }));
vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return { ...actual, apiConfigured: () => page.hasClient };
});

const LETTER = "m-none-1";
const SENDER_HOST = "pictures.newsletter.example";
const PICTURE = `https://${SENDER_HOST}/hero.png`;
/* A declared canvas, so the letter is drawn in a frame whose document names what the browser would fetch. */
const HTML = `<table width="600"><tr><td><p>hello</p><img src="${PICTURE}" width="600" height="200"></td></tr></table>`;

const letter = {
  id: LETTER, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "A picture", from: { name: "Lena", address: "lena@example.invalid" },
  to: [], cc: [], date: ISO, folder: "INBOX", snippet: "hello", unread: true,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
};
const lenaRule = {
  id: "rule_lena", kind: "sender", match: "lena@example.invalid", destination: "INBOX", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
};

/** Every request this page sent. */
let asked: string[] = [];
const askedFor = (part: string): string[] => asked.filter((url) => url.includes(part));

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  page.hasClient = true;
  asked = [];
  answerSyncWith(() => new Response(JSON.stringify({
    changes: {
      creates: [
        { type: "rule", op: "create", id: lenaRule.id, seq: 1, updatedAt: ISO, entity: lenaRule },
        { type: "message", op: "create", id: LETTER, seq: 2, updatedAt: ISO, entity: letter },
      ],
      updates: [], moves: [], deletes: [],
    },
    cursor: "c2", hasMore: false, serverTime: ISO,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  answerStoreWith([], { [LETTER]: { text: "hello", html: HTML } });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(input));
    if (String(input).includes("/consent/seed")) {
      return new Response(JSON.stringify({
        candidates: [{ address: "lena@example.invalid", name: "Lena", messages: 3, lastWrittenAt: ISO, alreadyDecided: false }],
        excluded: [], scannedMessages: 3, truncated: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    /* The Screener pane's own read, which is no part of the consent row: answered so the pane draws. */
    if (String(input).includes("/account/screening")) {
      return new Response(JSON.stringify({ ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "Mail from people." }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
});
afterEach(async () => {
  await teardownShellEnv();
});

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(1_000);
};
const named = (role: string, name: string): HTMLElement[] => queryAllByRole(document.body, role, { name });
const settingsNav = () => within(getByRole(document.body, "navigation", { name: messages.settings.navAria }));

const ACCOUNT = letter.accountId;
const facts = [mailbox({ lastSyncAt: ISO, id: "mb_1" })];
const screening: HostContract["wires"]["screening"] = {
  read: () => screeningSettings.get(),
  change: (change) => screeningSettings.set(change),
};

function ConsentFrame({ transport }: { transport: ConsentTransport | typeof NONE | undefined }) {
  const engine = useEngine();
  const frame = useBrowserMail(NONE, WEB_MAIL_PARTS);
  const host = hostFromTodaysInputs({
    ...(transport === undefined ? {} : { consentTransport: transport }),
    mailboxFacts: async () => facts,
    scope: ACCOUNT,
    screeningSection: null,
  }, engine, frame, NONE);
  return <MailFrame host={{
    ...host,
    session: { ...host.session, account: ACCOUNT },
    wires: { ...host.wires, screening },
  }} />;
}

async function mountShell(transport?: ConsentTransport | typeof NONE) {
  await mountWithBrowserProviders(facts, {
    wrap: () => <EngineProvider demo={false} resolveOwner={async () => ({ kind: "owner", accountId: ACCOUNT })}>
      <ConsentFrame transport={transport} />
    </EngineProvider>,
  });
}

/** Open the letter as a person does and hand back what its frame names. */
async function openTheLetter(): Promise<string> {
  await goHash("#/ohbox");
  const row = getByRole(document.body, "option", { name: /A picture/ });
  await act(async () => { row.click(); });
  await tick(3_000);
  const frames = [...document.querySelectorAll("iframe")].map((frame) => frame.getAttribute("srcdoc") ?? "");
  expect(frames.join(""), "the letter's body never drew").toContain("hello");
  return frames.join("\n");
}

/** The account's stored row as this page's own server answers it: pictures load, and every control could be drawn. */
const storedRow = { blockRemoteImagesAt: null, loadTrackingPixelsAt: null, foldersEnabledAt: null, signatures: {} };

describe("a host that says none for its consent wire, on a page whose own client is configured", () => {
  it("CONTROL: with the web's own wire the row is read, its controls are drawn and pictures load by themselves", async () => {
    answerConsentWith(storedRow);
    await mountShell();
    await tick(5_000);
    expect(askedFor("/consent").length, "the walk cannot show a refusal: the row was never read").toBeGreaterThan(0);

    const frame = await openTheLetter();
    expect(frame, "the walk cannot show a refusal: no picture was fetched through the proxy").toContain("/api/img?");

    await goHash("#/settings/general");
    expect(named("switch", messages.settings.images.title)).toHaveLength(1);
    await goHash("#/settings/screener");
    expect(named("group", messages.settings.dormancy.ariaLabel)).toHaveLength(1);
    for (const name of [messages.settings.folders.nav, messages.settings.signatures.nav]) {
      expect(settingsNav().getByRole("button", { name })).toBeTruthy();
    }
  }, 60_000);

  it("no consent request leaves, Settings draws none of the row's controls, and a letter's pictures wait for its press", async () => {
    answerConsentWith(storedRow);
    await mountShell(NONE);
    await tick(5_000);
    expect(askedFor("/consent"), "the row was read from the page's own session").toEqual([]);

    const frame = await openTheLetter();
    expect(frame, "a picture was fetched by a row the host never offered").not.toContain("/api/img?");
    expect(frame, "the reader's browser was pointed at the sender").not.toContain(`src="${PICTURE}"`);
    expect(askedFor("/img")).toEqual([]);
    expect(named("button", messages.mailBody.show), "the letter does not offer its press").toHaveLength(1);

    await goHash("#/settings/general");
    expect(named("switch", messages.settings.images.title), "a picture switch over no row").toEqual([]);
    await goHash("#/settings/screener");
    expect(named("group", messages.settings.dormancy.ariaLabel), "a window dial over no row").toEqual([]);
    const nav = settingsNav();
    expect(nav.getByRole("button", { name: messages.settings.screener })).toBeTruthy();
    expect(nav.queryByRole("button", { name: messages.settings.folders.nav })).toBeNull();
    expect(nav.queryByRole("button", { name: messages.settings.signatures.nav })).toBeNull();
    expect(askedFor("/consent")).toEqual([]);
  }, 60_000);
});

describe("the review of who you write to is offered by the host's word", () => {
  const reviewOnStage = (): boolean => named("button", messages.seed.later).length > 0;
  const doorInSettings = (): boolean => named("button", messages.seed.reopenAction).length > 0;

  it("on a page with its own client it takes the stage when it is owed, and Settings has its door", async () => {
    answerConsentWith({ seedConfirmedAt: null });
    await mountShell();
    await tick(5_000);
    expect(reviewOnStage(), "the review is owed and was not offered").toBe(true);

    await act(async () => { named("button", messages.seed.later)[0]!.click(); });
    await tick(1_000);
    await goHash("#/settings/screener");
    expect(doorInSettings()).toBe(true);
  }, 60_000);

  it("on a page with no client neither stands, though a host's own wire says the review is owed", async () => {
    page.hasClient = false;
    /* The desktop's hosted door in small: a wire of the host's own that answers, and no client to run the review. */
    const owed = {
      foldersStorable: false,
      state: async () => ({ seedConfirmedAt: null, dormancyDays: 60 }),
    } as unknown as ConsentTransport;
    await mountShell(owed);
    await tick(5_000);
    expect(askedFor("/consent/seed")).toEqual([]);
    expect(reviewOnStage(), "the review took the stage where no host offered it").toBe(false);

    await goHash("#/settings/screener");
    expect(settingsNav().getByRole("button", { name: messages.settings.screener })).toBeTruthy();
    expect(doorInSettings(), "Settings offers a review no host can run").toBe(false);
  }, 60_000);
});
