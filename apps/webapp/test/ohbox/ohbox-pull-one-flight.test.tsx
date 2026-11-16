/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
import { ToastHost } from "@ohmail/ui";
import messages from "../../messages/en.json";

/**
 * PULL NEW MAIL IS ONE FLIGHT, BY FINGER OR BY MENU. Under a finger the Ohbox pulled down at its top presses the same
 * binding the list's menu item presses: the shell's one `usePullNewMail`, whose latch lets one ring out at a time.
 * A pull and a press of the menu's item while it is under way put one `POST /sync/pull` on the wire, not two.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** A phone's browser: a coarse pointer, as the browser shell reads it. */
function phoneWindow(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }) as unknown as MediaQueryList;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let posts: number;
/** The ring's answer waits until the test lets it go: the flight stands while both triggers are pressed. */
let release: (() => void) | null;
const originalFetch = globalThis.fetch;

function letter(id: string): Record<string, unknown> {
  return {
    id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: id, from: { name: id, address: `${id}@ex.example` }, to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  posts = 0;
  release = null;
  phoneWindow();
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "POST" && u === "/api/sync/pull") {
      posts += 1;
      return new Promise<Response>((done) => {
        release = () =>
          done(json(202, { requested: 1, requestedAt: "2026-08-02T09:00:00.000Z", mailboxes: [] }));
      });
    }
    if (u.startsWith("/api/sync?"))
      return Promise.resolve(
        json(200, {
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: "AA",
          hasMore: false,
          serverTime: "2026-08-02T09:00:00.000Z",
        }),
      );
    return Promise.resolve(json(404, { error: { code: "not_found", message: u } }));
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  release?.();
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
});

async function mount(): Promise<void> {
  const OhboxView = await (await import("./_today.js")).prepareToday();
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const { EngineProvider } = await import("../../app/shell/engine");
  const { usePullNewMail } = await import("../../app/shell/PullNewMail");
  const { createSyncGate } = await import("@ohmail/app-logic/session/sync-scheduler");
  const engine = new OhmailEngine({ adapter: createSyncGate(null).guard(new HttpAdapter({ baseUrl: "/api" })) });

  /* The shell's one binding, handed to the Ohbox as the shell hands it. */
  function Shell(): React.ReactElement {
    const pull = usePullNewMail();
    return h(OhboxView as never, {
      owed: false, demo: false, settled: true, pull,
      newForYou: [letter("n1"), letter("n2")], previouslySeen: [],
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: null, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: () => {},
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ToastHost, {
          children: h(EngineProvider as never, {
            demo: false, engine,
            children: h(KeymapProvider as never, { children: h(Shell) } as never),
          } as never),
        }),
      }),
    );
  });
}

function touches(type: string, at: { x: number; y: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: at ? [{ clientX: at.x, clientY: at.y, identifier: 1 }] : [] });
  return event;
}

/** A finger pulls the list down 150 at its top and lets go. */
function pullDown(on: Element): void {
  on.dispatchEvent(touches("touchstart", { x: 100, y: 200 }));
  for (const dy of [30, 60, 90, 120, 150]) on.dispatchEvent(touches("touchmove", { x: 100, y: 200 + dy }));
  on.dispatchEvent(touches("touchend", null));
}

describe("Pull new mail on a phone's browser", () => {
  it("rings once for a pull and a press of the list's menu item in the same moment", async () => {
    await mount();
    const scroller = host!.querySelector(".ob-scroll")!;
    expect(scroller.hasAttribute("data-touch-list"), "the list is under a finger").toBe(true);
    const actions = [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === "Ohbox actions",
    );
    await act(async () => actions!.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) =>
      /Pull new mail/.test(m.textContent ?? ""),
    );
    expect(item, "the list's menu offers Pull new mail").toBeDefined();
    /* Both before the list is drawn again: neither trigger has seen the other's flight yet. */
    await act(async () => {
      pullDown(scroller.querySelector('[role="option"]')!);
      item!.click();
    });
    expect(posts, "the two triggers are two flights").toBe(1);
    await act(async () => pullDown(scroller.querySelector('[role="option"]')!));
    expect(posts, "a pull while the first is under way").toBe(1);
  });
});
