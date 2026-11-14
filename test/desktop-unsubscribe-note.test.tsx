/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, OhmailEngine, type SyncChange } from "@ohmail/client-engine";
import { Frame } from "@ohmail/app/frame";
import { createFeed, NONE } from "@ohmail/app/host";
import { NO_PANE_PARTS, useMailSupplies, type MailHostParts } from "@ohmail/app/mail";
import { TextProvider } from "@ohmail/app/text";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { DOORS, plantShell, type Pipe } from "../apps/desktop/test/_doors-harness.js";
import { DesktopFrame, type DesktopFrameProps } from "../apps/desktop/src/DesktopFrame.js";
import { linkSlot } from "../apps/desktop/src/link-in.js";
import { WebScreenerPane } from "../apps/webapp/app/(product)/mailbox/WebScreenerPane";
import en from "../apps/webapp/messages/en.json";
import de from "../apps/webapp/messages/de.json";
import { hostFromTodaysInputs } from "../apps/webapp/test/_mail-shell";
import { ISO, act, installShellEnv, mailbox, teardownShellEnv, tick } from "../apps/webapp/test/fixtures/live-walk-shell";
import { ROOT } from "./support/public-root.mjs";

/**
 * WHERE A SCREEN-OUT'S UNSUBSCRIBE LEAVES FROM, SAID WHERE THE PERSON AGREES TO IT. The two notes
 * a person reads before the request goes out are the Settings switch's note and the fine print of
 * the sender sheet's confirm. On Cloud the hosted worker sends the request, and both say it goes
 * from our servers, so the sender's log never holds the person's address. On the desktop the
 * engine on the person's own computer sends it (the local engine, or the paired host's), so the
 * list's endpoint sees that computer's network address: there the notes name the computer and that
 * address, in both languages, the way the picture rows already do. `test/desktop-egress-disclosed`
 * holds the published accounts of the same egress; this holds the app's own.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const CATALOGUES = { en, de } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = ["en", "de"] as const;

/** What only a server can say: the request goes from ours. */
const SERVERS = /our servers|ohmail[’']s servers|unseren Servern|Servern von ohmail/i;
/** …and what a computer of the person's own must say instead: which machine, and what it shows. */
const COMPUTER: Record<Locale, RegExp> = { en: /\bcomputer\b/i, de: /\bComputer\b/ };
const ADDRESS: Record<Locale, RegExp> = { en: /network address/i, de: /Netzwerkadresse/ };

let root: Root | null = null;
let host: HTMLElement | null = null;
let desktopPipe: Pipe | null = null;

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  desktopPipe?.unplant();
  desktopPipe = null;
  await teardownShellEnv();
});

async function mount(locale: Locale, route: string, node: React.ReactElement): Promise<HTMLElement> {
  window.location.hash = route;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const messages = CATALOGUES[locale];
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages, timeZone: "UTC",
      children: h(TextProvider, {
        locale, messages, timeZone: "UTC",
        children: h(ThemeProvider, { children: h(ToastHost, { children: node }) }),
      }),
    }));
  });
  await tick(50);
  return host;
}

const SCOPE = "acct_live_1";
const PARTS: MailHostParts = {
  reader: NONE,
  stageParts: { firstRun: { factor: NONE, pair: NONE, aiProvider: NONE, calendar: NONE } },
  paneParts: { ...NO_PANE_PARTS, screener: WebScreenerPane },
};

const consentTransport: ConsentTransport = {
  foldersStorable: false,
  state: async () => ({
    seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60, blockAutoUnsubscribeAt: null,
  }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: null }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

function EgressFrame({ engine, fromComputer }: { engine: OhmailEngine; fromComputer: boolean }) {
  const frame = useMailSupplies(window, { face: "paper", scheme: "light" }, NONE, PARTS);
  const supplied = hostFromTodaysInputs({
    scope: SCOPE, imagesFromComputer: fromComputer, junkWire: NONE, suggestWire: NONE,
    screeningSection: h(WebScreenerPane), consentTransport,
    mailboxFacts: async () => [mailbox({ id: "mb", lastSyncAt: ISO, organizerRole: "organizer", providerConfirms: true })],
  }, engine, frame, NONE);
  return h(Frame, { host: { ...supplied, session: { ...supplied.session, account: SCOPE } } });
}

const noop = () => undefined;

function desktopFrame(engine: OhmailEngine): React.ReactElement {
  const status = DOORS["D-l"]({ id: "mb", address: "mailbox@example.invalid" });
  desktopPipe = plantShell(status, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ signedIn: true });
    if (path === "/consent") return Response.json(await consentTransport.state());
    if (path === "/mailboxes") return Response.json({ items: [mailbox({ id: "mb", lastSyncAt: ISO, organizerRole: "organizer" })] });
    return new Response(null, { status: 404 });
  }, "fixture");
  const props: DesktopFrameProps = {
    engine, status, session: "live",
    sessionRefused: false, sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null,
    storage: null, mayLinkOut: false, manageOffered: false, withdrawManage: noop, rereadAccess: noop,
    reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: noop,
    onStatus: noop, openOverlay: noop, takeOver: noop, firstRunOpen: false, firstRun: undefined,
    takesMailLinks: false, scope: SCOPE, onUnread: noop, liveBody: async () => ({ kind: "refused", reason: "failed" }),
    links: linkSlot(), connection: createFeed(null),
  };
  return h(DesktopFrame, props);
}

async function switchNote(locale: Locale, fromComputer: boolean): Promise<string> {
  const engine = await engineWith([]);
  const node = fromComputer ? desktopFrame(engine) : h(EgressFrame, { engine, fromComputer });
  const el = await mount(locale, "#/settings/screener", node);
  const title = CATALOGUES[locale].settings.autoUnsub.title;
  await tick(100);
  expect(within(el).getByRole("switch", { name: title })).toBeTruthy();
  if (fromComputer) expect(desktopPipe?.asked).toContain("GET /consent");
  return departureNote(el, locale);
}

const HELD: EngineMessage = {
  id: "a", accountId: SCOPE, mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Weekly offers", from: { name: null, address: "news@shop.example" }, to: [], cc: [],
  date: "2026-08-01T09:00:00.000Z", folder: "ohmail/Screener", snippet: "s", unread: false,
  hasAttachments: false, attachmentCount: 0,
  authVerdict: "pass",
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
};

async function engineWith(changes: SyncChange[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(changes);
  return new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: ISO,
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" }),
      fetchBody: async () => null,
    },
  });
}

/** The confirm's fine print after a screen-out press on a held one-click letter. */
async function confirmNote(locale: Locale, fromComputer: boolean): Promise<string> {
  const engine = await engineWith([
    { type: "message", op: "create", id: HELD.id, seq: 1, updatedAt: HELD.updatedAt, entity: HELD },
    {
      type: "message_body", op: "create", id: HELD.id, seq: 2, updatedAt: HELD.updatedAt,
      entity: {
        messageId: HELD.id, state: "ready", text: "Weekly offers", html: null, loadedRemoteContent: false,
        unsubscribe: "one_click", unsubscribeUrl: null, withheld: null,
      },
    },
  ]);
  const el = await mount(locale, "#/screener", h(EgressFrame, { engine, fromComputer }));
  const copy = CATALOGUES[locale].screener;
  const sender = within(el).getByRole("option");
  await act(async () => { sender.click(); });
  await tick(0);
  const actions = within(el).getByRole("toolbar", { name: copy.place.panel });
  const screenOut = within(actions).getByRole("button", { name: copy.pileScreenOut });
  await act(async () => { screenOut.click(); });
  await tick(0);
  const confirm = within(document.body).getByRole("dialog", { name: copy.place.unsub.screened });
  return departureNote(confirm, locale);
}

function departureNote(area: HTMLElement, locale: Locale): string {
  return within(area).getByText((text) => (
    SERVERS.test(text) || (COMPUTER[locale].test(text) && ADDRESS[locale].test(text))
  )).textContent ?? "";
}

describe("a computer of the person's own says the unsubscribe leaves from it", () => {
  for (const locale of LOCALES) {
    it(`the Settings switch's note, in ${locale}`, async () => {
      const note = await switchNote(locale, true);
      expect(note, `${locale}: the desktop's note says the request goes from our servers`).not.toMatch(SERVERS);
      expect(note, `${locale}: the desktop's note does not name the computer`).toMatch(COMPUTER[locale]);
      expect(note, `${locale}: the desktop's note does not say what the sender sees`).toMatch(ADDRESS[locale]);
    });

    it(`the sender sheet's confirm, in ${locale}`, async () => {
      const note = await confirmNote(locale, true);
      expect(note, `${locale}: the desktop's confirm says the request goes from our servers`).not.toMatch(SERVERS);
      expect(note, `${locale}: the desktop's confirm does not name the computer`).toMatch(COMPUTER[locale]);
      expect(note, `${locale}: the desktop's confirm does not say what the sender sees`).toMatch(ADDRESS[locale]);
    });
  }
});

describe("CONTROL: the Cloud face keeps the server sentence, which is true there", () => {
  for (const locale of LOCALES) {
    it(`the Settings switch's note, in ${locale}`, async () => {
      const note = await switchNote(locale, false);
      expect(note).toBe(CATALOGUES[locale].settings.autoUnsub.microcopy);
      expect(note).toMatch(SERVERS);
    });

    it(`the sender sheet's confirm, in ${locale}`, async () => {
      const note = await confirmNote(locale, false);
      expect(note).toBe(CATALOGUES[locale].screener.place.unsub.service);
      expect(note).toMatch(SERVERS);
    });
  }
});

describe("the shell hands both notes the door's own fact", () => {
  it("the switch and the sheet read the same fact the picture rows read", () => {
    const source = (path: string) => readFileSync(join(ROOT, path), "utf8");
    const desktop = source("apps/desktop/src/host-contract.ts");
    expect(desktop).toContain('const fromComputer = imagesFromComputer(status)');
    expect(desktop).toContain('imagesFrom: fromComputer ? "computer" : "service"');
    expect(desktop).toContain('unsubscribeFrom: fromComputer ? "computer" : "service"');
    expect(source("packages/app/src/screener/asks/Unsubscribe.tsx")).toContain("const from = host.capabilities.unsubscribeFrom");
    expect(source("packages/app/src/settings/screener/model.ts")).toContain("capabilities.unsubscribeFrom");
    expect(source("apps/webapp/app/(product)/mailbox/WebScreenerPane.tsx")).toContain("const unsubscribe = useUnsubscribeSetting()");
    expect(source("packages/app/src/settings/browser/ScreenerSettings.tsx")).toContain("const from = screenerOffers(host).unsubscribe");
    expect(source("packages/app/src/settings/browser/GeneralSettings.tsx")).toContain('const fromComputer = host.capabilities.imagesFrom === "computer"');
  });
});
