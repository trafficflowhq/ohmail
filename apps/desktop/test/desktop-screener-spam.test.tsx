/** @vitest-environment jsdom */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntlProvider } from "use-intl";
import { act } from "react";
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import { SCREENER_ACKNOWLEDGEMENTS, type ScreenerAcknowledgement } from "@trafficflow/core/screener-acknowledgements";
import { createFeed } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { linkSlot } from "../src/link-in.js";
import { en as messages } from "../../../test/support/web-catalogues.js";

const ISO = "2026-08-04T09:00:00.000Z";
const noop = () => undefined;
const tick = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  localStorage.clear();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media, matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop,
  }));
  vi.stubGlobal("IntersectionObserver", class {
    observe = noop;
    unobserve = noop;
    disconnect = noop;
  });
  Element.prototype.scrollIntoView ??= noop;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  vi.stubGlobal("fetch", async () => { throw new Error("the Desktop fixture only uses its bridge"); });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function desktopProps(engine: OhmailEngine, scope: string, accountId: string): DesktopFrameProps {
  return {
    engine, status: { state: "serving", mode: "local", mailboxId: scope, accountId }, session: "live",
    sessionRefused: false, sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null,
    storage: null, mayLinkOut: false, manageOffered: false, withdrawManage: noop, rereadAccess: noop,
    reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: noop,
    onStatus: noop, openOverlay: noop, takeOver: noop, firstRunOpen: false, firstRun: undefined,
    takesMailLinks: false, scope, onUnread: noop, liveBody: async () => ({ kind: "refused", reason: "failed" }),
    links: linkSlot(), connection: createFeed(null),
  };
}

function desktopFrame(props: DesktopFrameProps) {
  return (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <TextProvider locale="en" messages={messages} timeZone="UTC">
        <ThemeProvider><ToastHost><DesktopFrame key={props.scope} {...props} /></ToastHost></ThemeProvider>
      </TextProvider>
    </IntlProvider>
  );
}

it("Desktop Spam files the inspected mail under its account and sends nothing after switching accounts", async () => {
  const account = "mail-account";
  const scope = "mailbox-scope";
  const otherAccount = "other-account";
  const otherScope = "other-mailbox";
  const writes: EngineMutation[] = [];
  let waitForFiling = Promise.resolve();
  const engineOver = async (rows: EngineMessage[]) => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(rows.map((entity, index) => ({
      type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
    })));
    return new OhmailEngine({
      store,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: ISO,
        }),
        mutate: async (m) => {
          writes.push(m);
          await waitForFiling;
          return { changes: [], seq: null };
        },
        withdrawSend: async () => ({ outcome: "unsupported" }),
        fetchBody: async () => null,
      },
    });
  };
  const letter = (id: string, folder: EngineMessage["folder"], name: string, over?: Partial<EngineMessage>): EngineMessage => ({
    id, accountId: account, mailboxId: scope, threadId: null, messageIdHeader: null,
    subject: id, from: { name, address: `${name.toLowerCase()}@lists.example.invalid` }, to: [], cc: [],
    date: ISO, updatedAt: ISO, folder, snippet: id, unread: true,
    hasAttachments: false, attachmentCount: 0, triage: null, labels: [], remoteContent: "none",
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    ...over,
  });
  const engine = await engineOver([
    letter("Held letter", "ohmail/Screener", "Weekly"),
    letter("Inbox sibling", "INBOX", "Weekly", { date: "2026-08-04T08:00:00.000Z" }),
    letter("Other held letter", "ohmail/Screener", "Weekly", { date: "2026-08-04T07:00:00.000Z", accountId: otherAccount, mailboxId: otherScope }),
    letter("Other Inbox sibling", "INBOX", "Weekly", { date: "2026-08-04T06:00:00.000Z", accountId: otherAccount, mailboxId: otherScope }),
    letter("In-flight decision", "ohmail/Screener", "Daily"),
    letter("In-flight sibling", "INBOX", "Daily", { date: "2026-08-04T08:00:00.000Z" }),
    letter("Later decision", "ohmail/Screener", "Monthly"),
  ]);
  let mailboxId = scope;
  let accountNow = account;
  let providerConfirms = false;
  /* The server keeps a confirmation per account, as its settings row does: a yes counts for every mailbox of it. */
  const acknowledged = new Map<string, number>();
  vi.stubGlobal("__TAURI_INTERNALS__", {
    transformCallback: () => 1,
    invoke: async (_command: string, payload?: { url?: string; method?: string; body?: number[] }) => {
      const pathname = String(payload?.url).split("?")[0];
      if (pathname === "/consent/settings" && payload?.method === "PATCH") {
        const asked = JSON.parse(new TextDecoder().decode(new Uint8Array(payload.body ?? []))) as {
          acknowledgeScreener?: ScreenerAcknowledgement;
        };
        if (asked.acknowledgeScreener) {
          acknowledged.set(accountNow, (acknowledged.get(accountNow) ?? 0) | SCREENER_ACKNOWLEDGEMENTS[asked.acknowledgeScreener]);
        }
      }
      const answer = pathname === "/mailboxes"
        ? { items: [{ id: mailboxId, address: "mailbox@example.invalid", status: "connected", lastSyncAt: ISO,
          organizerRole: "organizer", organizeConsentedAt: ISO, providerConfirms }] }
        : pathname === "/consent" ? { seedConfirmedAt: ISO, dormancyDays: 60, autoUnsubscribe: false, counts: {},
          screenerAcknowledgements: acknowledged.get(accountNow) ?? 0 }
        : pathname === "/consent/settings" ? { screenerAcknowledgements: acknowledged.get(accountNow) ?? 0 } : {};
      const encode = new TextEncoder();
      const header = encode.encode(JSON.stringify({ status: 200, statusText: "OK", h: [] }));
      const body = encode.encode(JSON.stringify(answer));
      const frame = new Uint8Array(4 + header.length + body.length);
      new DataView(frame.buffer).setUint32(0, header.length, false);
      frame.set(header, 4);
      frame.set(body, 4 + header.length);
      return frame;
    },
  });
  window.history.replaceState(null, "", "/#/screener");
  const mounted = render(desktopFrame(desktopProps(engine, scope, account)));
  await act(async () => { await vi.dynamicImportSettled(); });
  await tick(3000);
  const ui = within(mounted.container);
  const pressSpam = async (subject: RegExp, shownSibling?: string) => {
    const row = ui.getByRole("option", { name: subject });
    await act(async () => { row.click(); });
    await tick(50);
    if (shownSibling) {
      const reading = within(ui.getByRole("region", { name: "Reading" }));
      expect(reading.getAllByText(shownSibling, { exact: true }).length).toBeGreaterThan(0);
    }
    const panel = within(ui.getByRole("toolbar", { name: messages.screener.place.panel }));
    const spam = panel.getByRole("button", { name: /^Spam\b/ });
    expect(spam).toHaveProperty("disabled", false);
    await act(async () => { spam.click(); });
  };
  const filing = () => writes.filter((w) => w.kind === "screener_decide" || w.kind === "move" || w.kind === "rule_create");
  await pressSpam(/Held letter/, "Inbox sibling");
  await tick(COMMIT_MS + 300);
  expect.soft(filing()).toEqual([
    { kind: "screener_decide", senderId: "Held letter", confirmedIds: ["Held letter"],
      decision: "no", dest: "spam", scope: "sender", applyRetro: false },
    { kind: "move", messageId: "Inbox sibling", folder: "ohmail/Quarantine", from: "INBOX", pressRule: true },
  ]);

  writes.length = 0;
  let finishFiling: () => void = noop;
  waitForFiling = new Promise<void>((resolve) => { finishFiling = resolve; });
  await pressSpam(/In-flight decision/, "In-flight sibling");
  await tick(COMMIT_MS + 300);
  expect(filing()).toMatchObject([{ kind: "screener_decide", senderId: "In-flight decision" }]);
  const beforeSwitch = filing();

  await pressSpam(/Later decision/);
  expect(filing()).toEqual(beforeSwitch);
  mailboxId = otherScope;
  accountNow = otherAccount;
  const otherEngine = await engineOver([letter("New account letter", "ohmail/Screener", "Daily", {
    accountId: otherAccount, mailboxId: otherScope,
  })]);
  window.history.replaceState(null, "", "/#/screener");
  await act(async () => { mounted.rerender(desktopFrame(desktopProps(otherEngine, otherScope, otherAccount))); });
  await act(async () => { finishFiling(); });
  await tick(COMMIT_MS + 300);
  expect(ui.getByRole("option", { name: /New account letter/ })).toBeTruthy();
  expect(filing()).toEqual(beforeSwitch);

  providerConfirms = true;
  async function pressSpamOn(scope: string, accountId: string, subject: string) {
    mailboxId = scope;
    accountNow = accountId;
    const engine = await engineOver([letter(subject, "ohmail/Screener", "Letters", { accountId, mailboxId: scope })]);
    window.history.replaceState(null, "", "/#/screener");
    await act(async () => { mounted.rerender(desktopFrame(desktopProps(engine, scope, accountId))); });
    await act(async () => { await vi.dynamicImportSettled(); });
    await tick(3000);
    await pressSpam(new RegExp(subject));
  }
  const confirmation = () => within(document.body).getByRole("dialog", { name: messages.screener.place.unsub.spam });

  await pressSpamOn("original-mailbox", "shared-account", "First confirmation");
  const first = within(confirmation());
  expect(first.getByText(/goes from your computer/)).toBeTruthy();
  await act(async () => { first.getByRole("button", { name: messages.screening.unsubCommitMaybe }).click(); });
  /* Asked once for this account: Spam on another of its mailboxes files at once, and the note does not show again. */
  writes.length = 0;
  await pressSpamOn("replacement-mailbox", "shared-account", "Second confirmation");
  expect(within(document.body).queryByRole("dialog")).toBeNull();
  expect(within(document.body).queryByText(/goes from your computer/)).toBeNull();
  await tick(COMMIT_MS + 300);
  expect(filing()).toContainEqual(expect.objectContaining({
    kind: "screener_decide", senderId: "Second confirmation", decision: "no", dest: "spam",
  }));

  await pressSpamOn("third-mailbox", "third-account", "Third confirmation");
  expect(within(confirmation()).getByText(/goes from your computer/)).toBeTruthy();
});
