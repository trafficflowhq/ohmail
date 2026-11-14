/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";

import { setRenderedLinksBatchSink, setRenderedLinksSink } from "../../../packages/letter-body/src/rendered-links";
import { enableExternalLinks, interceptLinkClicks } from "@ohmail/app-logic/session/open-external";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { createFeed } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { linkSlot } from "../src/link-in.js";
import { ISO, installShellEnv, teardownShellEnv, tick } from "../../webapp/test/fixtures/live-walk-shell";
import messages from "../../webapp/messages/en.json";
import { reportRenderedLinksToShell } from "../src/native.js";

/** The desktop's own frame reports exactly the links held in its visible message. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/** Every command the window sent the shell, in order. */
const sent: Array<{ command: string; payload?: Record<string, unknown> }> = [];
const LINKS = "rendered_links_batch";
const reports = (): Array<{ surface: string; urls: string[] }> =>
  sent
    .filter((s) => s.command === LINKS)
    .map((s) => s.payload as { surfaces: string[]; urls: string[][] })
    .flatMap((b) => b.surfaces.map((surface, i) => ({ surface, urls: b.urls[i]! })));

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
let dispose: (() => void) | null = null;


async function mount(element: React.ReactElement): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => { root!.render(element); });
  await tick(50);
  return mountPoint;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  // The removal rides the next batch, a frame later at most (`rendered-links.ts`).
  await tick(25);
  root = null;
  mountPoint?.remove();
  mountPoint = null;
}

beforeEach(() => {
  installShellEnv();
  localStorage.clear();
  sent.length = 0;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      sent.push({ command, payload });
      return null;
    },
  };
  vi.spyOn(window, "open").mockImplementation(() => null);
  // What `main.tsx` arms before the first render: the interceptor, and the sink to the shell.
  enableExternalLinks();
  dispose = interceptLinkClicks(document, { trustSameOrigin: true });
  setRenderedLinksBatchSink(reportRenderedLinksToShell);
});

afterEach(async () => {
  await unmount();
  dispose?.();
  dispose = null;
  setRenderedLinksSink(null);
  delete host.__TAURI_INTERNALS__;
  await teardownShellEnv();
});

const SCOPE = "acct_live_1";
const noop = () => undefined;

async function screenedLetter(url: string): Promise<HTMLElement> {
  const letter: EngineMessage = {
    id: "weekly", accountId: SCOPE, mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Weekly list", from: { name: "Weekly lists", address: "editor@example.test" }, to: [], cc: [],
    date: ISO, updatedAt: ISO, folder: "ohmail/Screened", snippet: "This week", unread: false,
    hasAttachments: false, attachmentCount: 0, triage: null, labels: [], remoteContent: "none",
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  };
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    { type: "message", op: "create", id: letter.id, seq: 1, updatedAt: ISO, entity: letter },
    {
      type: "message_body", op: "create", id: letter.id, seq: 2, updatedAt: ISO,
      entity: {
        messageId: letter.id, state: "ready", text: "This week", html: null, loadedRemoteContent: false,
        unsubscribe: "not_one_click", unsubscribeUrl: url, withheld: null,
      },
    },
  ]);
  const engine = new OhmailEngine({
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
  const desktop: DesktopFrameProps = {
    engine, status: { state: "serving", mode: "local" }, session: "live",
    sessionRefused: false, sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null,
    storage: null, mayLinkOut: false, manageOffered: false, withdrawManage: noop, rereadAccess: noop,
    reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: noop,
    onStatus: noop, openOverlay: noop, takeOver: noop, firstRunOpen: false, firstRun: undefined,
    takesMailLinks: false, scope: SCOPE, onUnread: noop, liveBody: async () => ({ kind: "refused", reason: "failed" }),
    links: linkSlot(), connection: createFeed(null),
  };
  window.location.hash = "#/screener/screened";
  const mounted = await mount(h(IntlProvider, {
    locale: "en", messages, timeZone: "UTC",
    children: h(TextProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { children: h(ToastHost, { children: h(DesktopFrame, desktop) }) }),
    }),
  }));
  const row = within(mounted).getByRole("option", { name: /Weekly list/ });
  await act(async () => { row.click(); });
  await tick(50);
  return within(mounted).getByRole("region", { name: "Reading" });
}

describe("a message's links are on the shell's list while it is on screen", () => {
  it("the Screener's unsubscribe link is reported while it is drawn", async () => {
    const url = "https://lists.example.test/unsubscribe?id=7";
    const el = await screenedLetter(url);
    expect(within(el).getByRole("heading", { name: "Weekly list" })).toBeTruthy();
    expect(within(el).getByText("This week", { exact: true })).toBeTruthy();
    const link = within(el).queryAllByRole("link").find((candidate) => candidate.getAttribute("href") === url);
    expect.soft(link?.getAttribute("href")).toBe(url);
    expect.soft(reports().flatMap((r) => r.urls)).toEqual([url]);
    await unmount();
    expect(reports().at(-1)?.urls).toEqual([]);
  });
});
